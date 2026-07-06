import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Search, RefreshCw, X, Wallet, ArrowDownLeft, ArrowUpRight, Banknote, PiggyBank } from "lucide-react";
import { get, post } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

interface Txn {
  id: number; companyId: number | null; account: string | null; valueDate: string; bookingDate: string | null;
  direction: "in" | "out"; amount: number; currency: string;
  counterparty: string | null; counterpartyAccount: string | null; title: string | null; txType: string | null;
  statementNo: string | null; bankRef: string | null; fileName: string | null; entityFolder: string | null;
}
interface Meta { companies: { id: number; name: string }[]; years: string[] }
interface Summary {
  year: string; month: string | null; opening: number; closing: number;
  income: number; expenses: number; cash: number; cashdep: number;
  owner_roman: number; owner_tetiana: number; owner_yuriy: number;
  counts: Record<string, number>;
}
interface ExpenseCats { categories: { key: string; total: number; n: number }[] }
interface ListResp { rows: Txn[]; total: number; limit: number; offset: number }

const zl = (n: number) => `${Math.round(n ?? 0).toLocaleString("uk-UA")} zł`;
const zl2 = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const MONTHS_UK = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
type Bucket = string; // "income" | "expenses" | ... | "cat:<category>"

const CAT_LABELS: Record<string, string> = {
  zus: "ZUS", vat: "Податки (VAT, US)", seizure: "Зайняття (komornik)", salary: "Зарплати", zaliczki: "Аванси (zaliczki)",
  fees: "Комісії банку (перекази, вплати, зняття)", fuel: "Паливо", housing: "Житло / готелі",
  car_repair: "Ремонт авто", office_rent: "Оренда офісу", clothing: "Одяг", multisport: "Мультиспорт (Benefit)",
  trainer: "Тренер (Palusiński)", leasing: "Лізинг / авто",
  credit: "Кредит", services: "Послуги (бух., юристи)", marketing: "Маркетинг", permits: "Дозволи / уряд",
  b2b: "Підрядники B2B", taxi: "Таксі (Bolt, Uber)", travel: "Подорожі / відрядження", shops: "Магазини (продукти)",
  tech: "Техніка / електроніка", household: "Госптовари / буд", card: "Інші карткові", other: "Інше",
};
// categories that drill down per firm before showing the transaction list
const FIRM_DRILL = new Set(["salary", "zaliczki"]);

// Show just the company/person name — strip the address that banks append to counterparties.
function cleanName(cp: string | null, title: string | null, txType: string | null): string {
  // some banks glue the counterparty IBAN in front of the name — drop it
  const s = (cp || "").replace(/^[A-Z]{0,2}\d{20,28}\s*/, "").replace(/\s+/g, " ").trim();
  if (!s) return title || txType || "—";
  const cut = (prefix: string, form: string) => `${prefix.replace(/\s+/g, " ").trim()} ${form}`;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(.*?)\s+SP[ÓO]?[ŁL]KA\s+Z\s+O/i))) return cut(m[1]!, "Sp. z o.o.");
  if ((m = s.match(/^(.*?)\s+SP\.?\s?Z\s?O\.?\s?O/i))) return cut(m[1]!, "Sp. z o.o.");
  if ((m = s.match(/^(.*?)\s+SP[ÓO]?[ŁL]KA\s+AKCYJNA/i))) return cut(m[1]!, "S.A.");
  if ((m = s.match(/^(.*?)\s+S\.\s?A\.(?:\s|$)/i))) return cut(m[1]!, "S.A.");
  return s.split(/\s+(?:UL\.|AL\.|OS\.|PL\.\s|\d{2}-\d{3})/i)[0]!.trim();
}

// Human-readable operation kind from the raw MT940 type/title codes.
function humanType(r: { txType: string | null; title: string | null; counterparty: string | null }): string {
  const x = `${r.txType ?? ""} ${r.title ?? ""} ${r.counterparty ?? ""}`.toUpperCase();
  if (/WYNAGRODZ|PENSJ/.test(x)) return "Зарплата";
  if (/PRZEKS/.test(x)) return "Перекнигування VAT";
  if (/WP.ATOMA|ITCARD/.test(x)) return "Внесення готівки";
  if (/BANKOMAT/.test(x) || (/GOT.WK/.test(x) && !/BEZGOT/.test(x))) return "Зняття готівки";
  if (/BEZGOT|KART. DEBET|KARTĄ/.test(x)) return "Оплата карткою";
  if (/PROWIZJA|PROW-PRZEL|OP.ATA ZA|C38/.test(x)) return "Комісія банку";
  if (/SP.ATA KREDYT|SP.ATA KAPITA|SP.ATA ODSET/.test(x)) return "Кредит / відсотки";
  if (/\bZUS\b|ZAK.AD UB/.test(x)) return "ZUS";
  if (/SKARBOW|\/SFP\/|VAT-7|PIT-/.test(x)) return "Податки (US)";
  if (/\/VAT\/.*\/INV\//.test(x)) return "Split payment (за фактуру)";
  if (/ELIXIR|EKSPRES/.test(x)) return "Миттєвий переказ";
  if (/PRZELEW W.ASN/.test(x)) return "Власний переказ";
  if (/PRZELEW|TRF|TRANSFER/.test(x)) return "Переказ";
  return r.txType?.slice(0, 30) ?? "Операція";
}

export default function BankStatements() {
  const t = useT();
  const qc = useQueryClient();
  const thisYear = String(new Date().getFullYear());
  const [year, setYear] = useState(thisYear);
  const [monthNum, setMonthNum] = useState(""); // "" = весь рік, else "01".."12"
  const [companyId, setCompanyId] = useState("");
  const [detail, setDetail] = useState<Bucket | null>(null);
  const [detail2, setDetail2] = useState<string | null>(null); // selected expense category
  const [detail3, setDetail3] = useState<number | null>(null); // selected firm inside a firm-drill category
  const [syncing, setSyncing] = useState(false);

  const meta = useQuery<Meta>({ queryKey: ["bank-meta"], queryFn: () => get("/bank/meta") });
  const cq = companyId ? `&companyId=${companyId}` : "";
  const mq = monthNum ? `&month=${monthNum}` : "";
  const summary = useQuery<Summary>({ queryKey: ["bank-summary", year, monthNum, companyId], queryFn: () => get(`/bank/summary?year=${year}${mq}${cq}`) });
  const s = summary.data;
  const periodLabel = monthNum ? `${MONTHS_UK[Number(monthNum) - 1]} ${year}` : year;

  return (
    <>
      <PageHeader title={t("Витяги")} subtitle={t("Рух коштів з банківських витягів (ES · ESO · Klinex)")} />

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Рік")}</div>
          <Select value={year} onChange={e => setYear(e.target.value)} className="w-24">
            {(meta.data?.years?.length ? meta.data.years : [thisYear]).map(y => <option key={y} value={y}>{y}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Період")}</div>
          <Select value={monthNum} onChange={e => setMonthNum(e.target.value)} className="w-36">
            <option value="">{t("Весь рік")}</option>
            {MONTHS_UK.map((m, i) => <option key={i} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Фірма")}</div>
          <Select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-40">
            <option value="">{t("Усі 3 фірми")}</option>
            {meta.data?.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <Button variant="secondary" loading={syncing} onClick={async () => {
          setSyncing(true);
          try { await post("/bank/sync"); qc.invalidateQueries({ queryKey: ["bank-summary"] }); qc.invalidateQueries({ queryKey: ["bank-txns"] }); }
          finally { setSyncing(false); }
        }}><RefreshCw className="mr-1 h-4 w-4" />{t("Синхронізувати")}</Button>
      </div>

      {summary.isFetching && !s ? <Spinner /> : !s ? <Empty>{t("Немає даних")}</Empty> : (
        <>
          <div className="mb-2 text-sm font-medium text-slate-500">{periodLabel}</div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Metric icon={<PiggyBank className="h-5 w-5 text-slate-400" />} label={t("Стан на початок")} value={s.opening} tone="slate" active={detail === "balances"} onClick={() => setDetail(detail === "balances" ? null : "balances")} />
            <Metric icon={<Wallet className="h-5 w-5 text-slate-400" />} label={t("Стан на кінець")} value={s.closing} tone="slate" sub={t("зміна {d}", { d: zl(s.closing - s.opening) })} active={detail === "balances"} onClick={() => setDetail(detail === "balances" ? null : "balances")} />
            <Metric icon={<ArrowDownLeft className="h-5 w-5 text-emerald-500" />} label={t("Приходи на карту")} value={s.income} tone="emerald" count={s.counts.income} active={detail === "income"} onClick={() => setDetail(detail === "income" ? null : "income")} />
            <Metric icon={<ArrowUpRight className="h-5 w-5 text-rose-500" />} label={t("Витрати (разом із ЗП)")} value={s.expenses} tone="rose" count={s.counts.expenses} active={detail === "expenses"} onClick={() => { setDetail(detail === "expenses" ? null : "expenses"); setDetail2(null); }} />
            <Metric icon={<Banknote className="h-5 w-5 text-amber-500" />} label={t("Готівковий рух (нетто знято)")} value={s.cash - s.cashdep} tone="amber"
              count={(s.counts.cash ?? 0) + (s.counts.cashdep ?? 0)}
              sub={t("знято {a} · внесено {b}", { a: zl(s.cash), b: zl(s.cashdep) })}
              active={detail === "cashmove"} onClick={() => setDetail(detail === "cashmove" ? null : "cashmove")} />
          </div>

          <div className="mt-4 mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{t("Виплати власникам (разом із їх зарплатою)")}</div>
          <div className="grid grid-cols-3 gap-3 lg:w-2/3">
            <MiniMetric label={t("Сидорчук Роман")} value={s.owner_roman} count={s.counts.owner_roman} active={detail === "owner_roman"} onClick={() => { setDetail(detail === "owner_roman" ? null : "owner_roman"); setDetail2(null); }} />
            <MiniMetric label={t("Сидорчук Тетяна")} value={s.owner_tetiana} count={s.counts.owner_tetiana} active={detail === "owner_tetiana"} onClick={() => { setDetail(detail === "owner_tetiana" ? null : "owner_tetiana"); setDetail2(null); }} />
            <MiniMetric label={t("Сидорчук Юрій")} value={s.owner_yuriy} count={s.counts.owner_yuriy} active={detail === "owner_yuriy"} onClick={() => { setDetail(detail === "owner_yuriy" ? null : "owner_yuriy"); setDetail2(null); }} />
          </div>

          <Reconciliation year={year} monthNum={monthNum} companyId={companyId} />

          {detail === "balances" && <BalancesPanel year={year} monthNum={monthNum} onClose={() => setDetail(null)} />}

          {detail === "expenses" && (
            <ExpenseBreakdown year={year} monthNum={monthNum} companyId={companyId}
              selected={detail2} onSelect={k => { setDetail2(detail2 === k ? null : k); setDetail3(null); }} />
          )}

          {detail && detail !== "expenses" && detail !== "balances" && <DetailPanel bucket={detail} year={year} monthNum={monthNum} companyId={companyId} companies={meta.data?.companies ?? []} onClose={() => setDetail(null)} />}

          {/* firm-drill categories (salary, zaliczki): firms first, then the list for the chosen firm */}
          {detail === "expenses" && detail2 && FIRM_DRILL.has(detail2) && !companyId && (
            <FirmBreakdown bucket={`cat:${detail2}`} title={t(CAT_LABELS[detail2] ?? detail2)} year={year} monthNum={monthNum}
              selected={detail3} onSelect={id => setDetail3(detail3 === id ? null : id)} />
          )}
          {detail === "expenses" && detail2 && (!FIRM_DRILL.has(detail2) || companyId || detail3 != null) && (
            <DetailPanel bucket={`cat:${detail2}`} year={year} monthNum={monthNum}
              companyId={companyId || (detail3 != null ? String(detail3) : "")}
              companies={meta.data?.companies ?? []}
              onClose={() => { if (FIRM_DRILL.has(detail2) && !companyId) setDetail3(null); else setDetail2(null); }} />
          )}
        </>
      )}

      <p className="mt-4 text-xs text-slate-400">{t("Приходи — без повернень ВАТ і внутрішніх переказів. Натисни на показник, щоб побачити деталі.")}</p>
    </>
  );
}

function Metric({ icon, label, value, tone, count, sub, active, onClick }: { icon: React.ReactNode; label: string; value: number; tone: "emerald" | "rose" | "amber" | "slate" | "violet"; count?: number; sub?: string; active?: boolean; onClick?: () => void }) {
  const t = useT();
  const color = { emerald: "text-emerald-700", rose: "text-rose-600", amber: "text-amber-600", slate: "text-slate-800", violet: "text-violet-600" }[tone];
  const ring = active ? "ring-2 ring-red-400" : onClick ? "hover:ring-2 hover:ring-slate-200" : "";
  return (
    <Card className={`p-5 transition ${onClick ? "cursor-pointer" : ""} ${ring}`}>
      <div onClick={onClick}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-slate-500">{label}</div>{icon}
        </div>
        <div className={`mt-2 text-2xl font-bold ${color}`}>{zl(value)}</div>
        {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
        {count != null && <div className="mt-1 text-xs text-slate-400">{t("{n} операцій", { n: count })}{onClick && " · " + t("деталі")}</div>}
      </div>
    </Card>
  );
}

// Per-firm opening/closing balances (opens from the balance cards).
function BalancesPanel({ year, monthNum, onClose }: { year: string; monthNum: string; onClose: () => void }) {
  const t = useT();
  const params = new URLSearchParams({ year });
  if (monthNum) params.set("month", monthNum);
  const data = useQuery<{ firms: { companyId: number; name: string; opening: number; closing: number }[] }>({
    queryKey: ["bank-balances", params.toString()], queryFn: () => get(`/bank/balances?${params}`),
  });
  const firms = data.data?.firms ?? [];
  const tot = firms.reduce((a, f) => ({ o: a.o + f.opening, c: a.c + f.closing }), { o: 0, c: 0 });
  return (
    <Card className="mt-4 p-0">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="text-sm font-semibold text-slate-700">{t("Стан рахунків по фірмах")}</div>
        <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-4 w-4" /></button>
      </div>
      {data.isFetching && !data.data ? <div className="p-5"><Spinner /></div> : (
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
            <th className="px-4 py-2 text-left">{t("Фірма")}</th>
            <th className="px-4 py-2 text-right">{t("На початок")}</th>
            <th className="px-4 py-2 text-right">{t("На кінець")}</th>
            <th className="px-4 py-2 text-right">{t("Зміна")}</th>
          </tr></thead>
          <tbody>
            {firms.map(f => {
              const d = f.closing - f.opening;
              return (
                <tr key={f.companyId} className="border-b border-slate-100">
                  <td className="px-4 py-2 font-medium text-slate-700">{f.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600">{zl(f.opening)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-800">{zl(f.closing)}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${d >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{d >= 0 ? "+" : ""}{zl(d)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
            <td className="px-4 py-2 text-slate-700">{t("Разом")}</td>
            <td className="px-4 py-2 text-right tabular-nums">{zl(tot.o)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{zl(tot.c)}</td>
            <td className={`px-4 py-2 text-right tabular-nums ${tot.c - tot.o >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{tot.c - tot.o >= 0 ? "+" : ""}{zl(tot.c - tot.o)}</td>
          </tr></tfoot>
        </table>
      )}
    </Card>
  );
}

// Per-firm totals for a category (salaries, zaliczki) — firm click opens its list.
function FirmBreakdown({ bucket, title, year, monthNum, selected, onSelect }: { bucket: string; title: string; year: string; monthNum: string; selected: number | null; onSelect: (id: number) => void }) {
  const t = useT();
  const params = new URLSearchParams({ year, bucket });
  if (monthNum) params.set("month", monthNum);
  const data = useQuery<{ firms: { companyId: number; name: string; total: number; n: number }[] }>({
    queryKey: ["bank-breakdown", params.toString()], queryFn: () => get(`/bank/breakdown?${params}`),
  });
  const firms = data.data?.firms ?? [];
  const total = firms.reduce((s, f) => s + f.total, 0);
  return (
    <Card className="mt-4 p-0">
      <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
        {title} — {t("по фірмах")} <span className="ml-2 font-normal text-slate-400">{zl(total)}</span>
      </div>
      {data.isFetching && !data.data ? <div className="p-5"><Spinner /></div> : (
        <div>
          {firms.map(f => (
            <button key={f.companyId} onClick={() => onSelect(f.companyId)}
              className={`flex w-full items-center justify-between border-b border-slate-100 px-4 py-2.5 text-left text-sm transition last:border-0 ${selected === f.companyId ? "bg-red-50" : "hover:bg-slate-50"}`}>
              <span className={selected === f.companyId ? "font-semibold text-red-700" : "font-medium text-slate-700"}>{f.name}</span>
              <span className="flex items-center gap-4">
                <span className="text-xs text-slate-400">{t("{n} виплат", { n: f.n })}</span>
                <span className="font-semibold tabular-nums text-slate-800">{zl(f.total)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

interface ReconcileResp {
  opening: number; closingStatement: number; computedClosing: number; residual: number; netFlow: number;
  parts: { income: number; expenses: number; cashmove: number; owners: number; vat_refund: number; vat_moves: number; internal: number };
}

// Collapsible cash-equation: why opening ± flows lands on (or off) the statement closing.
function Reconciliation({ year, monthNum, companyId }: { year: string; monthNum: string; companyId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams({ year });
  if (monthNum) params.set("month", monthNum);
  if (companyId) params.set("companyId", companyId);
  const data = useQuery<ReconcileResp>({ queryKey: ["bank-reconcile", params.toString()], queryFn: () => get(`/bank/reconcile?${params}`), enabled: open });
  const r = data.data;
  const Row = ({ label, v, sign, strong }: { label: string; v: number; sign?: boolean; strong?: boolean }) => (
    <div className={`flex justify-between border-b border-slate-100 px-4 py-1.5 text-sm last:border-0 ${strong ? "bg-slate-50 font-semibold" : ""}`}>
      <span className="text-slate-600">{label}</span>
      <span className={`tabular-nums ${sign && v > 0 ? "text-emerald-600" : sign && v < 0 ? "text-rose-600" : "text-slate-800"}`}>{sign && v > 0 ? "+" : ""}{zl2(v)}</span>
    </div>
  );
  return (
    <Card className="mt-4 p-0">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50">
        {t("Звірка: від початку до кінця періоду")}
        <span className="text-xs font-normal text-slate-400">{open ? t("згорнути") : t("показати")}</span>
      </button>
      {open && (data.isFetching && !r ? <div className="p-5"><Spinner /></div> : r && (
        <div>
          <Row label={t("Стан на початок")} v={r.opening} strong />
          <Row label={t("Приходи на карту")} v={r.parts.income} sign />
          <Row label={t("Витрати (разом із ЗП)")} v={r.parts.expenses} sign />
          <Row label={t("Готівковий рух (нетто)")} v={r.parts.cashmove} sign />
          <Row label={t("Виплати власникам")} v={r.parts.owners} sign />
          <Row label={t("Повернення VAT (з US)")} v={r.parts.vat_refund} sign />
          <Row label={t("Рухи VAT-рахунку (split payment)")} v={r.parts.vat_moves} sign />
          <Row label={t("Внутрішні перекази (нетто)")} v={r.parts.internal} sign />
          <Row label={t("= Розрахунковий стан на кінець")} v={r.computedClosing} strong />
          <Row label={t("Стан на кінець за витягами")} v={r.closingStatement} strong />
          {Math.abs(r.residual) > 1 && (
            <div className="px-4 py-2 text-xs text-amber-600">
              {t("Розбіжність {v} — по частині рахунків у файлах витягів немає записів залишку (банк не завжди додає :62F:), тому стан по них не враховано.", { v: zl2(r.residual) })}
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

// Expense categories — readable list with share bars; appears when «Витрати» is
// clicked, a row click opens that category's transaction list.
function ExpenseBreakdown({ year, monthNum, companyId, selected, onSelect }: { year: string; monthNum: string; companyId: string; selected: string | null; onSelect: (k: string) => void }) {
  const t = useT();
  const params = new URLSearchParams({ year });
  if (monthNum) params.set("month", monthNum);
  if (companyId) params.set("companyId", companyId);
  const data = useQuery<ExpenseCats>({ queryKey: ["bank-expcats", params.toString()], queryFn: () => get(`/bank/expense-categories?${params}`) });
  const cats = data.data?.categories ?? [];
  const total = cats.reduce((s, c) => s + c.total, 0);
  return (
    <Card className="mt-4 p-0">
      <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
        {t("Витрати за категоріями")} <span className="ml-2 font-normal text-slate-400">{zl(total)}</span>
      </div>
      {data.isFetching && !data.data ? <div className="p-6"><Spinner /></div> : (
        <div>
          {cats.map(c => {
            const share = total > 0 ? (c.total / total) * 100 : 0;
            const active = selected === c.key;
            return (
              <button key={c.key} onClick={() => onSelect(c.key)}
                className={`flex w-full items-center gap-3 border-b border-slate-100 px-4 py-2 text-left text-sm transition last:border-0 ${active ? "bg-red-50" : "hover:bg-slate-50"}`}>
                <div className={`w-64 shrink-0 truncate ${active ? "font-semibold text-red-700" : "font-medium text-slate-700"}`}>{t(CAT_LABELS[c.key] ?? c.key)}</div>
                <div className="hidden flex-1 sm:block">
                  <div className="h-2 rounded-full bg-slate-100">
                    <div className={`h-2 rounded-full ${active ? "bg-red-400" : "bg-slate-300"}`} style={{ width: `${Math.max(share, 0.5)}%` }} />
                  </div>
                </div>
                <div className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-400">{share >= 0.1 ? `${share.toFixed(1)}%` : "<0.1%"}</div>
                <div className="w-20 shrink-0 text-right text-xs tabular-nums text-slate-400">{t("{n} оп.", { n: c.n })}</div>
                <div className="w-28 shrink-0 text-right font-semibold tabular-nums text-slate-800">{c.total < 5000 ? zl2(c.total) : zl(c.total)}</div>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// smaller card for the expense-breakdown row; `exact` shows grosze (fees are tiny)
function MiniMetric({ label, value, count, exact, active, onClick }: { label: string; value: number; count?: number; exact?: boolean; active?: boolean; onClick?: () => void }) {
  const t = useT();
  return (
    <Card className={`cursor-pointer p-3.5 transition ${active ? "ring-2 ring-red-400" : "hover:ring-2 hover:ring-slate-200"}`}>
      <div onClick={onClick}>
        <div className="text-xs font-medium text-slate-500">{label}</div>
        <div className="mt-1 text-lg font-bold text-slate-700">{exact ? zl2(value) : zl(value)}</div>
        {count != null && <div className="mt-0.5 text-[11px] text-slate-400">{t("{n} операцій", { n: count })}</div>}
      </div>
    </Card>
  );
}

function DetailPanel({ bucket, year, monthNum, companyId, companies, onClose }: { bucket: Bucket; year: string; monthNum: string; companyId: string; companies: { id: number; name: string }[]; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"date" | "amount" | "counterparty">("date");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Txn | null>(null);
  const limit = 100;

  const params = new URLSearchParams({ bucket, sort, order, limit: String(limit), offset: String(offset) });
  if (monthNum) params.set("month", `${year}-${monthNum}`); else params.set("year", year);
  if (companyId) params.set("companyId", companyId);
  if (q) params.set("q", q);
  const data = useQuery<ListResp>({ queryKey: ["bank-txns", params.toString()], queryFn: () => get(`/bank/transactions?${params}`) });
  const rows = data.data?.rows ?? [];
  const total = data.data?.total ?? 0;
  const coName = (id: number | null) => companies.find(c => c.id === id)?.name ?? "—";
  const shortAcct = (a: string | null) => a ? "…" + a.replace(/\s/g, "").slice(-6) : "—";
  const setSortCol = (col: typeof sort) => { if (sort === col) setOrder(o => o === "asc" ? "desc" : "asc"); else { setSort(col); setOrder("desc"); } setOffset(0); };
  const title = bucket.startsWith("cat:")
    ? t(CAT_LABELS[bucket.slice(4)] ?? bucket.slice(4))
    : ({
        income: t("Приходи — від кого і коли"), expenses: t("Витрати"),
        cashmove: t("Готівковий рух — зняття та внесення"),
        owner_roman: t("Виплати — Сидорчук Роман"), owner_tetiana: t("Виплати — Сидорчук Тетяна"), owner_yuriy: t("Виплати — Сидорчук Юрій"),
      }[bucket] ?? bucket);
  const isCashMove = bucket === "cashmove";
  const whoLabel = isCashMove ? t("Рахунок") : t("Від кого / призначення");

  const SortH = ({ col, label, right }: { col: typeof sort; label: string; right?: boolean }) => (
    <th className={`px-3 py-2.5 ${right ? "text-right" : "text-left"} cursor-pointer select-none hover:text-slate-700`} onClick={() => setSortCol(col)}>
      <span className={`inline-flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}>{label}{sort === col && (order === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</span>
    </th>
  );

  return (
    <Card className="mt-5 p-0">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="font-semibold text-slate-700">{title}</div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} placeholder={t("пошук…")} className="w-48 pl-8" />
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {data.isFetching && !data.data ? <div className="p-6"><Spinner /></div> : rows.length === 0 ? <div className="p-6"><Empty>{t("Немає операцій")}</Empty></div> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <SortH col="date" label={t("Дата")} />
                {!companyId && <th className="px-3 py-2.5 text-left">{t("Фірма")}</th>}
                {isCashMove ? <th className="px-3 py-2.5 text-left">{whoLabel}</th> : <SortH col="counterparty" label={whoLabel} />}
                <th className="px-3 py-2.5 text-left">{t("Тип операції")}</th>
                <SortH col="amount" label={t("Сума")} right />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50/60" onClick={() => setSelected(r)}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">{r.valueDate}</td>
                  {!companyId && <td className="px-3 py-2 text-slate-600">{coName(r.companyId)}</td>}
                  <td className="px-3 py-2 text-slate-700">
                    {isCashMove
                      ? <span className="tabular-nums text-slate-500">{shortAcct(r.account)}</span>
                      : (
                        <>
                          <div className="max-w-[420px] truncate font-medium">{cleanName(r.counterparty, r.title, r.txType)}</div>
                          {r.counterparty && r.title && <div className="max-w-[420px] truncate text-xs text-slate-400">{r.title}</div>}
                        </>
                      )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{isCashMove ? (r.direction === "out" ? t("Зняття") : t("Внесення")) : t(humanType(r))}</td>
                  <td className={`whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums ${isCashMove ? (r.direction === "out" ? "text-amber-600" : "text-emerald-600") : r.direction === "in" ? "text-emerald-600" : "text-slate-700"}`}>
                    {isCashMove ? (r.direction === "out" ? "−" : "+") : ""}{zl(r.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > limit && (
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
          <span>{t("Показано {a}–{b} з {n}", { a: offset + 1, b: Math.min(offset + limit, total), n: total })}</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - limit))}>{t("Назад")}</Button>
            <Button variant="secondary" disabled={offset + limit >= total} onClick={() => setOffset(o => o + limit)}>{t("Далі")}</Button>
          </div>
        </div>
      )}
      {selected && <TxnModal txn={selected} companies={companies} onClose={() => setSelected(null)} />}
    </Card>
  );
}

// Full details of a single transaction — everything the statement carries.
function TxnModal({ txn: r, companies, onClose }: { txn: Txn; companies: { id: number; name: string }[]; onClose: () => void }) {
  const t = useT();
  const coName = companies.find(c => c.id === r.companyId)?.name ?? "—";
  const Row = ({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) => (
    value == null || value === "" ? null : (
      <div className="flex gap-3 border-b border-slate-100 py-2 text-sm last:border-0">
        <div className="w-44 shrink-0 text-slate-400">{label}</div>
        <div className={`min-w-0 break-words text-slate-700 ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
      </div>
    )
  );
  return (
    <Modal open title={t("Деталі операції")} onClose={onClose} size="lg">
      <div className="mb-4 flex items-baseline justify-between">
        <div className={`text-2xl font-bold ${r.direction === "in" ? "text-emerald-600" : "text-rose-600"}`}>
          {r.direction === "in" ? "+" : "−"}{zl(r.amount)} <span className="text-sm font-normal text-slate-400">{r.currency}</span>
        </div>
        <div className="text-sm text-slate-500">{t(humanType(r))}</div>
      </div>
      <Row label={t("Дата (валютування)")} value={r.valueDate} />
      <Row label={t("Дата операції")} value={r.bookingDate} />
      <Row label={t("Фірма")} value={coName} />
      <Row label={t("Наш рахунок")} value={r.account} mono />
      <Row label={t("Контрагент")} value={r.counterparty} />
      <Row label={t("Рахунок контрагента")} value={r.counterpartyAccount} mono />
      <Row label={t("Призначення платежу")} value={r.title} />
      <Row label={t("Тип (код банку)")} value={r.txType} mono />
      <Row label={t("Референс банку")} value={r.bankRef} mono />
      <Row label={t("№ витягу")} value={r.statementNo} mono />
      <Row label={t("Файл витягу")} value={r.fileName} mono />
      <Row label={t("Папка")} value={r.entityFolder} />
    </Modal>
  );
}

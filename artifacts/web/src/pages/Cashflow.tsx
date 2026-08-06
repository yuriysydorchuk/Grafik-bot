import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Wallet, TrendingUp, TrendingDown, ArrowDownLeft, Search, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import { get, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { useCats, useCashCats } from "../lib/financeCats";
import { AckNoteModal, type AckTarget } from "../components/AckNoteModal";

interface CatRow { key: string; bank: number; cash: number; total: number }
interface Data {
  year: string; month: string | null; from: string; to: string;
  opening: { banks: number; cash: number; total: number };
  closing: { banks: number; cash: number; total: number };
  delta: number;
  inflows: { income: number; vatRefund: number; total: number };
  expenses: CatRow[]; expensesTotal: number;
  owners: CatRow[]; ownersTotal: number;
  internal: {
    bankWithdrawn: number; kasaIn: number; cashGap: number;
    bankDeposits: number; kasaDeposits: number; depositGap: number;
    vatMovesNet: number; internalNet: number;
  };
  asOf: string;
  obligations: { receivable: number; payable: number; unpaidInvoices: number };
  netPosition: number;
  reconcile: { computedClosing: number; residual: number };
}

const zl = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const MONTHS_UK = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const OWNER_LABELS: Record<string, string> = { owner_roman: "Сидорчук Роман", owner_tetiana: "Сидорчук Тетяна (вкл. Даніель)", owner_yuriy: "Сидорчук Юрій" };

export default function Cashflow() {
  const t = useT();
  const { label: bankLabel } = useCats();
  const { labels: cashLabels } = useCashCats(); // касові розбивки (зарплати по містах тощо), яких немає в банку
  const catLabel = (k: string) => bankLabel(k) !== k ? bankLabel(k) : (cashLabels[k] ?? k);
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [monthNum, setMonthNum] = useState(String(now.getMonth() + 1).padStart(2, "0"));
  const [showRec, setShowRec] = useState(false);
  const [drill, setDrill] = useState<string | null>(null); // category key of the open movements list
  const [searchQ, setSearchQ] = useState("");               // top-bar search across all movements

  const params = new URLSearchParams({ year });
  if (monthNum) params.set("month", monthNum);
  const q = useQuery<Data>({ queryKey: ["cashflow", params.toString()], queryFn: () => get(`/cashflow?${params}`) });
  const d = q.data;
  const maxTotal = Math.max(1, ...(d?.expenses.map(e => e.total) ?? [1]));

  return (
    <>
      <PageHeader title={t("Кешфлоу")} subtitle={t("Усі гроші фірми: банки + готівка (каса й сейфи), рухи за період")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Рік")}</div>
          <Select value={year} onChange={e => setYear(e.target.value)} className="w-24">
            {[String(now.getFullYear()), String(now.getFullYear() - 1)].map(y => <option key={y} value={y}>{y}</option>)}
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
          <div className="mb-1 text-xs text-slate-500">{t("Пошук")}</div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder={t("контрагент, опис…")} className="w-56 pl-8" />
          </div>
        </div>
      </div>

      {searchQ.trim().length >= 2 && (
        <EntriesPanel year={year} monthNum={monthNum} initialCat="" query={searchQ} onClose={() => setSearchQ("")} />
      )}

      {q.isFetching && !d ? <Spinner /> : !d ? <Empty>{t("Немає даних")}</Empty> : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <PositionCard label={t("На початок")} icon={<Wallet className="h-5 w-5 text-slate-400" />} total={d.opening.total} banks={d.opening.banks} cash={d.opening.cash} t={t} />
            <PositionCard label={t("На кінець")} icon={<Wallet className="h-5 w-5 text-slate-400" />} total={d.closing.total} banks={d.closing.banks} cash={d.closing.cash} t={t} />
            <Card className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-500">{t("Зміна за період")}</div>
                {d.delta >= 0 ? <TrendingUp className="h-5 w-5 text-emerald-500" /> : <TrendingDown className="h-5 w-5 text-rose-500" />}
              </div>
              <div className={`mt-2 text-2xl font-bold ${d.delta >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{d.delta >= 0 ? "+" : ""}{zl(d.delta)}</div>
            </Card>
            <Card className={`cursor-pointer p-5 transition ${drill === "income" || drill === "vat_refund" ? "ring-2 ring-red-400" : "hover:ring-2 hover:ring-slate-200"}`}>
              <div onClick={() => setDrill(drill === "income" ? null : "income")}>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-500">{t("Надходження")}</div>
                  <ArrowDownLeft className="h-5 w-5 text-emerald-500" />
                </div>
                <div className="mt-2 text-2xl font-bold text-emerald-700">{zl(d.inflows.total)}</div>
                <div className="mt-1 text-xs text-slate-400">{t("клієнти {a} · повернення VAT {b}", { a: zl(d.inflows.income), b: zl(d.inflows.vatRefund) })} · {t("деталі")}</div>
              </div>
            </Card>
          </div>

          <CashAlertsBlock year={year} monthNum={monthNum} />

          {/* expenses merged bank + cash */}
          <Card className="mt-5 p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="font-semibold text-slate-700">{t("Витрати по категоріях (банк + готівка)")}</div>
              <div className="text-sm font-semibold text-rose-600">{zl(d.expensesTotal)}</div>
            </div>
            <div className="max-h-[480px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                  <th className="px-4 py-2 text-left">{t("Категорія")}</th>
                  <th className="px-3 py-2 text-right">{t("Банк")}</th>
                  <th className="px-3 py-2 text-right">{t("Готівка")}</th>
                  <th className="px-4 py-2 text-right">{t("Разом")}</th>
                  <th className="w-1/4 px-3 py-2"></th>
                </tr></thead>
                <tbody>
                  {d.expenses.filter(e => e.total > 0).map(e => (
                    <tr key={e.key} onClick={() => setDrill(drill === e.key ? null : e.key)}
                      className={`cursor-pointer border-b border-slate-100 ${drill === e.key ? "bg-red-50" : "hover:bg-slate-50"}`}>
                      <td className={`px-4 py-1.5 font-medium ${drill === e.key ? "text-red-700" : "text-slate-700"}`}>{t(catLabel(e.key))}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{e.bank ? zl(e.bank) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{e.cash ? zl(e.cash) : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-1.5 text-right font-semibold tabular-nums text-slate-800">{zl(e.total)}</td>
                      <td className="px-3 py-1.5">
                        <div className="h-2 rounded bg-slate-100"><div className="h-2 rounded bg-rose-400" style={{ width: `${Math.max(2, (e.total / maxTotal) * 100)}%` }} /></div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                  <td className="px-4 py-2 text-slate-700">{t("Разом")}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{zl(d.expenses.reduce((s, e) => s + e.bank, 0))}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{zl(d.expenses.reduce((s, e) => s + e.cash, 0))}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-slate-800">{zl(d.expensesTotal)}</td>
                  <td />
                </tr></tfoot>
              </table>
            </div>
          </Card>

          {/* owner draws — personal, not company expenses */}
          <Card className="mt-4 p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="font-semibold text-slate-700">{t("Виплати власникам (особисте)")}</div>
              <div className="text-sm font-semibold text-slate-700">{zl(d.ownersTotal)}</div>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {d.owners.map(o => (
                  <tr key={o.key} onClick={() => setDrill(drill === o.key ? null : o.key)}
                    className={`cursor-pointer border-b border-slate-100 last:border-0 ${drill === o.key ? "bg-red-50" : "hover:bg-slate-50"}`}>
                    <td className={`px-4 py-2 font-medium ${drill === o.key ? "text-red-700" : "text-slate-700"}`}>{t(OWNER_LABELS[o.key] ?? o.key)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{t("банк")} {zl(o.bank)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{t("готівка")} {zl(o.cash)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums text-slate-800">{zl(o.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <td className="px-4 py-2 text-slate-700">{t("Разом")}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{t("банк")} {zl(d.owners.reduce((s, o) => s + o.bank, 0))}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{t("готівка")} {zl(d.owners.reduce((s, o) => s + o.cash, 0))}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-slate-800">{zl(d.ownersTotal)}</td>
              </tr></tfoot>
            </table>
          </Card>

          {drill != null && (
            <EntriesPanel key={drill} year={year} monthNum={monthNum} initialCat={drill} onClose={() => setDrill(null)} />
          )}

          {/* reconciliation */}
          <Card className="mt-4 p-0">
            <button className="flex w-full items-center gap-2 px-4 py-3 text-left font-semibold text-slate-700" onClick={() => setShowRec(v => !v)}>
              {showRec ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {t("Звірка")}
              <span className={`ml-auto text-sm font-medium ${Math.abs(d.reconcile.residual) < 5 ? "text-emerald-600" : "text-amber-600"}`}>
                {Math.abs(d.reconcile.residual) < 5 ? t("сходиться") : t("залишок {v}", { v: zl(d.reconcile.residual) })}
              </span>
            </button>
            {showRec && (
              <div className="border-t border-slate-200 px-4 py-3 text-sm">
                <table className="w-full max-w-xl">
                  <tbody className="[&_td]:py-1">
                    <tr><td className="text-slate-500">{t("На початок (банки + готівка)")}</td><td className="text-right tabular-nums">{zl(d.opening.total)}</td></tr>
                    <tr><td className="text-slate-500">+ {t("надходження від клієнтів")}</td><td className="text-right tabular-nums text-emerald-700">{zl(d.inflows.income)}</td></tr>
                    <tr><td className="text-slate-500">+ {t("повернення VAT")}</td><td className="text-right tabular-nums text-emerald-700">{zl(d.inflows.vatRefund)}</td></tr>
                    <tr><td className="text-slate-500">− {t("витрати (банк + готівка)")}</td><td className="text-right tabular-nums text-rose-600">{zl(d.expensesTotal)}</td></tr>
                    <tr><td className="text-slate-500">− {t("виплати власникам")}</td><td className="text-right tabular-nums text-rose-600">{zl(d.ownersTotal)}</td></tr>
                    <tr><td className="text-slate-500">± {t("готівка: вписано в касу {a} − знято з банку {b}", { a: zl(d.internal.kasaIn), b: zl(d.internal.bankWithdrawn) })}</td><td className="text-right tabular-nums">{zl(d.internal.cashGap)}</td></tr>
                    <tr><td className="text-slate-500">± {t("вплати: на рахунок {a} − записано в касі {b}", { a: zl(d.internal.bankDeposits), b: zl(d.internal.kasaDeposits) })}</td><td className="text-right tabular-nums">{zl(d.internal.depositGap)}</td></tr>
                    <tr><td className="text-slate-500">± {t("рухи VAT-рахунків (нетто)")}</td><td className="text-right tabular-nums">{zl(d.internal.vatMovesNet)}</td></tr>
                    <tr><td className="text-slate-500">± {t("перекази між своїми рахунками (нетто)")}</td><td className="text-right tabular-nums">{zl(d.internal.internalNet)}</td></tr>
                    <tr className="border-t border-slate-200 font-semibold"><td>{t("Розрахований кінець")}</td><td className="text-right tabular-nums">{zl(d.reconcile.computedClosing)}</td></tr>
                    <tr className="font-semibold"><td>{t("Фактичний кінець (виписки + каса)")}</td><td className="text-right tabular-nums">{zl(d.closing.total)}</td></tr>
                    <tr className={Math.abs(d.reconcile.residual) < 5 ? "text-emerald-600" : "text-amber-600"}><td>{t("Незвірений залишок")}</td><td className="text-right tabular-nums">{zl(d.reconcile.residual)}</td></tr>
                  </tbody>
                </table>
                <div className="mt-2 text-xs text-slate-400">{t("«Готівка» та «вплати» з різницею ≠ 0 — це розбіжності між банком і записами каси (див. сторінки Витяги/Каса). Незвірений залишок ≠ 0 — зазвичай відсутні виписки за період.")}</div>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

interface CfEntry {
  id: string; source: "bank" | "cash"; date: string; firm: string | null;
  direction: "in" | "out"; amount: number;
  who: string | null; title: string | null; txType: string | null; account: string | null;
  box: string | null; manualCategory: string | null;
}
interface CfEntriesResp { rows: CfEntry[]; total: number; limit: number; offset: number; sums: { in: number; out: number; bank: number; cash: number } }

// Movements list for a category (bank + cash merged), with search and filters.
// Opens from a click on any cashflow category / owner / the inflows card.
function EntriesPanel({ year, monthNum, initialCat, query, onClose }: { year: string; monthNum: string; initialCat: string; query?: string; onClose: () => void }) {
  const t = useT();
  const [cat, setCat] = useState(initialCat);
  const [qLocal, setQLocal] = useState("");
  const q = query ?? qLocal; // controlled by the page-level search when opened from it
  const [source, setSource] = useState<"" | "bank" | "cash">("");
  const [companyId, setCompanyId] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 100;
  useEffect(() => { setOffset(0); }, [q, cat, source, companyId]);

  const meta = useQuery<{ companies: { id: number; name: string }[] }>({ queryKey: ["bank-meta"], queryFn: () => get("/bank/meta") });
  const params = new URLSearchParams({ year, limit: String(limit), offset: String(offset) });
  if (monthNum) params.set("month", monthNum);
  if (cat) params.set("cat", cat);
  if (q.trim()) params.set("q", q.trim());
  if (source) params.set("source", source);
  if (companyId) params.set("companyId", companyId);
  const data = useQuery<CfEntriesResp>({ queryKey: ["cashflow-entries", params.toString()], queryFn: () => get(`/cashflow/entries?${params}`) });
  const d = data.data;
  const rows = d?.rows ?? [];

  const { label: dbLabel, cats } = useCats();
  const { labels: cashLabels, outCats: cashOutCats } = useCashCats();
  const catLabel = (k: string) =>
    k === "" ? t("Всі рухи") :
    k === "income" ? t("Надходження від клієнтів") :
    k === "vat_refund" ? t("Повернення VAT") :
    k.startsWith("owner_") ? t(OWNER_LABELS[k] ?? k) : t(dbLabel(k) !== k ? dbLabel(k) : (cashLabels[k] ?? k));
  // + касові категорії, яких немає в банку (зарплатні розбивки, повернення, …)
  const cashOnlyKeys = cashOutCats.map(c => c.key).filter(k => k !== "deposit" && !cats.some(b => b.key === k) && k !== "other" && !k.startsWith("owner_"));
  const catOptions = ["", "income", "vat_refund", ...cats.map(c => c.key), ...cashOnlyKeys, "other", "owner_roman", "owner_tetiana", "owner_yuriy"];

  return (
    <Card className="mt-4 p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="font-semibold text-slate-700">
          {query != null ? t("Пошук по всіх рухах") : t("Операції")}: {catLabel(cat)}
          {d && (
            <span className="ml-2 text-sm font-normal text-slate-400">
              {d.sums.in > 0 && <span className="text-emerald-600">+{zl(d.sums.in)}</span>}
              {d.sums.in > 0 && d.sums.out > 0 && " · "}
              {d.sums.out > 0 && <span className="text-rose-600">−{zl(d.sums.out)}</span>}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={cat} onChange={e => setCat(e.target.value)} className="w-52">
            {catOptions.map(k => <option key={k} value={k}>{catLabel(k)}</option>)}
          </Select>
          <Select value={source} onChange={e => setSource(e.target.value as any)} className="w-32">
            <option value="">{t("Банк + готівка")}</option>
            <option value="bank">{t("Лише банк")}</option>
            <option value="cash">{t("Лише готівка")}</option>
          </Select>
          <Select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-32">
            <option value="">{t("Усі фірми")}</option>
            {meta.data?.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {query == null && (
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <Input value={q} onChange={e => setQLocal(e.target.value)} placeholder={t("пошук…")} className="w-44 pl-8" />
            </div>
          )}
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {data.isFetching && !d ? <div className="p-6"><Spinner /></div> : rows.length === 0 ? <div className="p-6"><Empty>{t("Немає операцій")}</Empty></div> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <th className="px-3 py-2.5 text-left">{t("Дата")}</th>
                <th className="px-3 py-2.5 text-left">{t("Джерело")}</th>
                <th className="px-3 py-2.5 text-left">{t("Фірма")}</th>
                <th className="px-3 py-2.5 text-left">{t("Контрагент / опис")}</th>
                <th className="px-3 py-2.5 text-right">{t("Сума")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">{r.date}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${r.source === "bank" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"}`}>
                      {r.source === "bank" ? t("банк") : t("готівка")}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">{r.firm ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-700">
                    <div className="max-w-[420px] truncate font-medium">{r.who || r.title || r.txType || "—"}</div>
                    {r.who && r.title && <div className="max-w-[420px] truncate text-xs text-slate-400">{r.title}</div>}
                    {r.manualCategory && <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-700" title={t(dbLabel(r.manualCategory))}>✎</span>}
                  </td>
                  <td className={`whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums ${r.direction === "in" ? "text-emerald-600" : "text-slate-700"}`}>
                    {r.direction === "in" ? "+" : "−"}{zl(r.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            {d && (
              <tfoot><tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <td colSpan={2} className="px-3 py-2 text-slate-700">{t("Разом ({n} операцій)", { n: d.total })}</td>
                <td colSpan={2} className="whitespace-nowrap px-3 py-2 text-slate-500">{t("банк")} {zl(d.sums.bank)} · {t("готівка")} {zl(d.sums.cash)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                  {d.sums.in > 0 && <span className="text-emerald-600">+{zl(d.sums.in)}</span>}
                  {d.sums.in > 0 && d.sums.out > 0 && <span className="text-slate-400"> / </span>}
                  {d.sums.out > 0 && <span className="text-slate-700">−{zl(d.sums.out)}</span>}
                  {d.sums.in === 0 && d.sums.out === 0 && "—"}
                </td>
              </tr></tfoot>
            )}
          </table>
        </div>
      )}
      {d && d.total > limit && (
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
          <span>{t("Показано {a}–{b} з {n}", { a: offset + 1, b: Math.min(offset + limit, d.total), n: d.total })}</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - limit))}>{t("Назад")}</Button>
            <Button variant="secondary" disabled={offset + limit >= d.total} onClick={() => setOffset(o => o + limit)}>{t("Далі")}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function PositionCard({ label, icon, total, banks, cash, t }: { label: string; icon: React.ReactNode; total: number; banks: number; cash: number; t: (s: string, v?: any) => string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between"><div className="text-sm font-medium text-slate-500">{label}</div>{icon}</div>
      <div className="mt-2 text-2xl font-bold text-slate-800">{zl(total)}</div>
      <div className="mt-1 text-xs text-slate-400">{t("банки {a} · готівка {b}", { a: zl(banks), b: zl(cash) })}</div>
    </Card>
  );
}

// ── Каса: рапорт розбіжностей (межі місяців, банк↔каса, ЗП↔сводна) ────────────
// Ті самі звірки, що на /cash, у компактному вигляді для фінаналізу; фіксація
// («передивилися, причина відома») доступна і звідси.
interface CfAck { id: number; note: string | null }
interface CfDiscrepancy { box: string; companyId: number | null; month: string; entered: number; expected: number; diff: number; ref: string; ack: CfAck | null }
interface CfRecItem { id: number; date: string; amount: number; ack: CfAck | null }
interface CfCashSummary { discrepancies: CfDiscrepancy[]; ackedDiscrepancies: CfDiscrepancy[] }
interface CfCashRec { unmatchedBank: CfRecItem[]; unmatchedBankTotal: number; unmatchedCash: CfRecItem[]; unmatchedCashTotal: number; ackedBank: CfRecItem[]; ackedCash: CfRecItem[] }
interface CfPayrollGroup { key: string; label: string; payroll: string | null; kasa: number; svodni: number | null; unsplit: number; diff: number | null; ref: string; ack: CfAck | null }
interface CfPayrollRec { svodniMonth: string; groups: CfPayrollGroup[]; kasaTotal: number; svodniTotal: number; diffTotal: number }

function CashAlertsBlock({ year, monthNum }: { year: string; monthNum: string }) {
  const t = useT();
  const qc = useQueryClient();
  const params = new URLSearchParams({ year });
  if (monthNum) params.set("month", monthNum);
  const summary = useQuery<CfCashSummary>({ queryKey: ["cf-cash-summary", params.toString()], queryFn: () => get(`/cash/summary?${params}`) });
  const rec = useQuery<CfCashRec>({ queryKey: ["cf-cash-rec", params.toString()], queryFn: () => get(`/cash/reconcile?${params}`) });
  const payroll = useQuery<CfPayrollRec>({
    queryKey: ["cf-cash-payroll", year, monthNum],
    queryFn: () => get(`/cash/payroll-reconcile?month=${year}-${monthNum}`),
    enabled: !!monthNum,
  });
  const meta = useQuery<{ companies: { id: number; name: string }[] }>({ queryKey: ["cash-meta"], queryFn: () => get("/cash/meta") });
  const coName = (id: number | null) => meta.data?.companies.find(c => c.id === id)?.name ?? "—";
  const BOXES_UA: Record<string, string> = { office: "Каса офісу", yuriy: "Сейф Юрія", tetiana: "Сейф Тетяни", hostel: "Каса хостелів" };

  const invalidate = () => ["cf-cash-summary", "cf-cash-rec", "cf-cash-payroll"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  const [ackTarget, setAckTarget] = useState<AckTarget | null>(null);
  const ackIt = (side: string, ref: string) => setAckTarget({ side, ref });
  const unack = async (id: number) => { await del(`/cash/recon-ack/${id}`); invalidate(); };

  const s = summary.data, r = rec.data, p = payroll.data;
  if (!s || !r) return null;
  // сводна ще без готівкових сум = «ще не заповнена», а не «не сходиться»;
  // поки місяць виплат триває, розбіжність — лише перевидача понад сводну
  const svodniReady = (p?.svodniTotal ?? 0) > 0 || (p?.groups ?? []).some(g => (g.svodni ?? 0) > 0 || g.unsplit > 0);
  const now = new Date();
  const payoutsOngoing = !monthNum || `${year}-${monthNum}` >= `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  // перевидача — проти max(сводна, 0): технічно відʼємна/незаповнена сводна не алярмить
  const payrollIssues = svodniReady
    ? (p?.groups ?? []).filter(g => g.svodni != null && !g.ack
        && (g.kasa > Math.max(g.svodni, 0) + 1 || (!payoutsOngoing && Math.abs(g.diff ?? 0) > 1)))
    : [];
  const ackedCount = s.ackedDiscrepancies.length + r.ackedBank.length + r.ackedCash.length + (p?.groups ?? []).filter(g => g.ack).length;
  const hasIssues = s.discrepancies.length > 0 || r.unmatchedBank.length > 0 || r.unmatchedCash.length > 0 || payrollIssues.length > 0;

  if (!hasIssues) {
    return (
      <div className="mt-4 flex items-center gap-2 text-sm text-emerald-700">
        <CheckCircle2 className="h-4 w-4" />
        {t("Каса: звірки сходяться (межі місяців, банк, зарплати зі сводною)")}
        {ackedCount > 0 && <span className="text-slate-400">· {t("зафіксованих розбіжностей: {n}", { n: ackedCount })}</span>}
      </div>
    );
  }
  return (
    <>
    <Card className="mt-4 border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <div className="mb-1 flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />{t("Каса: розбіжності (деталі — на сторінці Каса)")}</div>
      <ul className="ml-6 list-disc space-y-1">
        {s.discrepancies.map(d => (
          <li key={d.ref} className="flex flex-wrap items-center gap-2">
            <span>{t("межа місяців")} · {d.box === "office" ? coName(d.companyId) : t(BOXES_UA[d.box] ?? d.box)} · {d.month}: {t("вписаний початок {a}, а кінець попереднього місяця {b} (різниця {c})", { a: zl(d.entered), b: zl(d.expected), c: zl(d.diff) })}</span>
            <button className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-medium hover:bg-amber-100" onClick={() => ackIt("month", d.ref)}>{t("Зафіксувати")}</button>
          </li>
        ))}
        {r.unmatchedBank.length > 0 && (
          <li>{t("банк ↔ каса: зняття без пари в касі — {n} на {v}", { n: r.unmatchedBank.length, v: zl(r.unmatchedBankTotal) })}</li>
        )}
        {r.unmatchedCash.length > 0 && (
          <li>{t("банк ↔ каса: приходи в касі без пари в банку — {n} на {v}", { n: r.unmatchedCash.length, v: zl(r.unmatchedCashTotal) })}</li>
        )}
        {payrollIssues.map(g => (
          <li key={g.key} className="flex flex-wrap items-center gap-2">
            <span>{t("ЗП ↔ сводна {m}", { m: p!.svodniMonth })} · {g.payroll === "legacy" ? t("Зарплати (без розбивки, історія)") : g.label}: {t("каса {a}, сводна {b} (різниця {c})", { a: zl(g.kasa), b: zl(g.svodni ?? 0), c: zl(g.diff!) })}</span>
            <button className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-medium hover:bg-amber-100" onClick={() => ackIt("payroll", g.ref)}>{t("Зафіксувати")}</button>
          </li>
        ))}
      </ul>
      {ackedCount > 0 && (
        <details className="mt-2 text-xs text-amber-700/80">
          <summary className="cursor-pointer">{t("Зафіксовані розбіжності: {n}", { n: ackedCount })}</summary>
          <ul className="mt-1 space-y-0.5">
            {s.ackedDiscrepancies.map(d => (
              <li key={d.ref}>{t("межа місяців")} · {d.month}: {zl(d.diff)} — <i>{d.ack?.note || "—"}</i> <button className="underline decoration-dotted" onClick={() => unack(d.ack!.id)}>{t("скасувати")}</button></li>
            ))}
            {r.ackedBank.map(b => (
              <li key={`b${b.id}`}>{t("зняття з банку")} {b.date} · {zl(b.amount)} — <i>{b.ack?.note || "—"}</i> <button className="underline decoration-dotted" onClick={() => unack(b.ack!.id)}>{t("скасувати")}</button></li>
            ))}
            {r.ackedCash.map(c => (
              <li key={`c${c.id}`}>{t("прихід каси")} {c.date} · {zl(c.amount)} — <i>{c.ack?.note || "—"}</i> <button className="underline decoration-dotted" onClick={() => unack(c.ack!.id)}>{t("скасувати")}</button></li>
            ))}
            {(p?.groups ?? []).filter(g => g.ack).map(g => (
              <li key={`p${g.key}`}>{t("ЗП ↔ сводна")} · {g.label}: {zl(g.diff ?? 0)} — <i>{g.ack?.note || "—"}</i> <button className="underline decoration-dotted" onClick={() => unack(g.ack!.id)}>{t("скасувати")}</button></li>
            ))}
          </ul>
        </details>
      )}
    </Card>
    <AckNoteModal target={ackTarget} onClose={() => setAckTarget(null)} onDone={() => { setAckTarget(null); invalidate(); }} />
    </>
  );
}

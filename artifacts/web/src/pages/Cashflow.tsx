import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Wallet, TrendingUp, TrendingDown, ArrowDownLeft, Search, X } from "lucide-react";
import { get } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { useCats } from "../lib/financeCats";

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
  const { label: catLabel } = useCats();
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
  const catLabel = (k: string) =>
    k === "" ? t("Всі рухи") :
    k === "income" ? t("Надходження від клієнтів") :
    k === "vat_refund" ? t("Повернення VAT") :
    k.startsWith("owner_") ? t(OWNER_LABELS[k] ?? k) : t(dbLabel(k));
  const catOptions = ["", "income", "vat_refund", ...cats.map(c => c.key), "other", "owner_roman", "owner_tetiana", "owner_yuriy"];

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

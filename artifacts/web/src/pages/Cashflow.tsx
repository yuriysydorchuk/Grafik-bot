import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Wallet, TrendingUp, TrendingDown, ArrowDownLeft } from "lucide-react";
import { get } from "../lib/api";
import { Card, Spinner, Select, Empty } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { recatLabel } from "../lib/financeCats";

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
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [monthNum, setMonthNum] = useState(String(now.getMonth() + 1).padStart(2, "0"));
  const [showRec, setShowRec] = useState(false);

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
      </div>

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
            <Card className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-500">{t("Надходження")}</div>
                <ArrowDownLeft className="h-5 w-5 text-emerald-500" />
              </div>
              <div className="mt-2 text-2xl font-bold text-emerald-700">{zl(d.inflows.total)}</div>
              <div className="mt-1 text-xs text-slate-400">{t("клієнти {a} · повернення VAT {b}", { a: zl(d.inflows.income), b: zl(d.inflows.vatRefund) })}</div>
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
                    <tr key={e.key} className="border-b border-slate-100">
                      <td className="px-4 py-1.5 font-medium text-slate-700">{t(recatLabel(e.key))}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{e.bank ? zl(e.bank) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{e.cash ? zl(e.cash) : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-1.5 text-right font-semibold tabular-nums text-slate-800">{zl(e.total)}</td>
                      <td className="px-3 py-1.5">
                        <div className="h-2 rounded bg-slate-100"><div className="h-2 rounded bg-rose-400" style={{ width: `${Math.max(2, (e.total / maxTotal) * 100)}%` }} /></div>
                      </td>
                    </tr>
                  ))}
                </tbody>
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
                  <tr key={o.key} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 font-medium text-slate-700">{t(OWNER_LABELS[o.key] ?? o.key)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{t("банк")} {zl(o.bank)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{t("готівка")} {zl(o.cash)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums text-slate-800">{zl(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

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

function PositionCard({ label, icon, total, banks, cash, t }: { label: string; icon: React.ReactNode; total: number; banks: number; cash: number; t: (s: string, v?: any) => string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between"><div className="text-sm font-medium text-slate-500">{label}</div>{icon}</div>
      <div className="mt-2 text-2xl font-bold text-slate-800">{zl(total)}</div>
      <div className="mt-1 text-xs text-slate-400">{t("банки {a} · готівка {b}", { a: zl(banks), b: zl(cash) })}</div>
    </Card>
  );
}

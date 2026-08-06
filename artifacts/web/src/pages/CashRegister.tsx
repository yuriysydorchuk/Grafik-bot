import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, AlertTriangle, PiggyBank, Wallet, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, Tags, Check, Undo2 } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { useCashCats, type CashCat } from "../lib/financeCats";
import { AckNoteModal, type AckTarget } from "../components/AckNoteModal";

interface Meta { companies: { id: number; name: string }[]; years: string[]; boxes: string[] }
interface Ack { id: number; note: string | null }
interface Discrepancy { box: string; companyId: number | null; month: string; expected: number; entered: number; diff: number; ref: string; ack: Ack | null }
interface Summary {
  opening: number; inflow: number; outflow: number; closing: number;
  boxTotals: Record<string, { opening: number; inflow: number; outflow: number; closing: number }>;
  discrepancies: Discrepancy[]; ackedDiscrepancies: Discrepancy[];
}
interface Entry {
  id: number; box: string; companyId: number | null; periodMonth: string; entryDate: string | null;
  kind: string; amount: number; description: string | null; note: string | null; tabName: string; editable: boolean;
  transferGroup: string | null; manualCategory: string | null; category: string | null;
}
interface RecItem { id: number; date: string; amount: number; ack: Ack | null }
interface Reconcile {
  bankTotal: number; cashTotal: number;
  unmatchedBank: RecItem[]; ackedBank: RecItem[]; unmatchedBankIds: number[]; unmatchedBankTotal: number;
  unmatchedCash: RecItem[]; ackedCash: RecItem[]; unmatchedCashIds: number[]; unmatchedCashTotal: number;
}
interface PayrollGroup { key: string; label: string; city: string | null; payroll: string | null; kasa: number; svodni: number | null; unsplit: number; diff: number | null; ref: string; ack: Ack | null }
interface PayrollRec { kasaMonth: string; svodniMonth: string; groups: PayrollGroup[]; kasaTotal: number; svodniTotal: number; diffTotal: number }

const zl = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const MONTHS_UK = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const BOX_LABELS: Record<string, string> = { office: "Каса офісу", yuriy: "Сейф Юрія", tetiana: "Сейф Тетяни", hostel: "Каса хостелів" };
// фолбеки класифікації і службові ключі — не видаляються (дзеркало PROTECTED_CASH_KEYS)
const PROTECTED_KEYS = new Set(["other", "other_income", "card", "deposit"]);

export default function CashRegister() {
  const t = useT();
  const qc = useQueryClient();
  const { outCats, inCats, label: catLabel, byKey } = useCashCats();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [monthNum, setMonthNum] = useState(String(now.getMonth() + 1).padStart(2, "0"));
  const [companyId, setCompanyId] = useState("");
  const [box, setBox] = useState("office"); // office | yuriy | tetiana | hostel | "" (всі)
  const [editing, setEditing] = useState<Entry | null>(null);
  const [adding, setAdding] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [managingCats, setManagingCats] = useState(false);
  const [ackTarget, setAckTarget] = useState<AckTarget | null>(null);

  const meta = useQuery<Meta>({ queryKey: ["cash-meta"], queryFn: () => get("/cash/meta") });
  const params = new URLSearchParams({ year });
  if (monthNum) params.set("month", monthNum);
  if (box) params.set("box", box);
  if (box === "office" && companyId) params.set("companyId", companyId);
  const summary = useQuery<Summary>({ queryKey: ["cash-summary", params.toString()], queryFn: () => get(`/cash/summary?${params}`) });
  const entries = useQuery<{ rows: Entry[] }>({ queryKey: ["cash-entries", params.toString()], queryFn: () => get(`/cash/entries?${params}`) });
  const rec = useQuery<Reconcile>({ queryKey: ["cash-reconcile", params.toString()], queryFn: () => get(`/cash/reconcile?${params}`), enabled: box === "office" });
  const payrollRec = useQuery<PayrollRec>({
    queryKey: ["cash-payroll-rec", year, monthNum],
    queryFn: () => get(`/cash/payroll-reconcile?month=${year}-${monthNum}`),
    enabled: !!monthNum,
  });

  const coName = (id: number | null) => meta.data?.companies.find(c => c.id === id)?.name ?? "—";
  const boxLabel = (b: string) => t(BOX_LABELS[b] ?? b);
  const isOffice = box === "office";
  const showFirmCol = !box || (isOffice && !companyId);
  const invalidate = () => ["cash-summary", "cash-entries", "cash-reconcile", "cash-payroll-rec"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  const s = summary.data;
  const unmatchedCash = new Set(rec.data?.unmatchedCashIds ?? []);
  const ackedCashById = new Map((rec.data?.ackedCash ?? []).map(i => [i.id, i.ack!]));

  // «Зафіксувати» = записати пояснення розбіжності; вона зникає з алертів, лишається в журналі
  const ackIt = (side: string, ref: string) => setAckTarget({ side, ref });
  const unack = async (id: number) => { await del(`/cash/recon-ack/${id}`); invalidate(); };

  const netDiffLine = (bankTotal: number, cashTotal: number) => {
    const net = bankTotal - cashTotal;
    const base = t("підсумок за період: знято з банку {a}, вписано в касу {b}", { a: zl(bankTotal), b: zl(cashTotal) });
    return net > 0.005 ? `${base} — ${t("в касі не вистачає {v}", { v: zl(net) })}`
      : net < -0.005 ? `${base} — ${t("в касу вписано на {v} більше", { v: zl(-net) })}`
      : `${base} — ${t("сходиться; непарні записи нижче — лише розбіжності дат/сум")}`;
  };

  const payrollGroups = (payrollRec.data?.groups ?? []).filter(g => g.kasa !== 0 || (g.svodni ?? 0) !== 0 || g.unsplit !== 0);
  // сводна попереднього місяця ще без готівкових сум → різниць немає ЩЕ, а не «не сходиться»
  const svodniReady = (payrollRec.data?.svodniTotal ?? 0) > 0 || (payrollRec.data?.groups ?? []).some(g => (g.svodni ?? 0) > 0 || g.unsplit > 0);
  // місяць виплат ще триває → недоплата не є розбіжністю (зарплати видаються поступово);
  // жовте посеред місяця — лише перевидача понад сводну
  const kasaMonthStr = `${year}-${monthNum}`;
  const nowMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const payoutsOngoing = kasaMonthStr >= nowMonthStr;

  return (
    <>
      <PageHeader title={t("Каса")} subtitle={t("Готівка фірми: каса офісу та резервні сейфи, звірка з банком і сводними")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Ящик")}</div>
          <div className="flex overflow-hidden rounded-lg border border-slate-200">
            {["office", "yuriy", "tetiana", "hostel", ""].map(b => (
              <button key={b} onClick={() => setBox(b)}
                className={`px-3 py-2 text-sm ${box === b ? "bg-slate-800 font-medium text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                {b ? boxLabel(b) : t("Всі разом")}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Рік")}</div>
          <Select value={year} onChange={e => setYear(e.target.value)} className="w-24">
            {(meta.data?.years?.length ? meta.data.years : [year]).map(y => <option key={y} value={y}>{y}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Період")}</div>
          <Select value={monthNum} onChange={e => setMonthNum(e.target.value)} className="w-36">
            <option value="">{t("Весь рік")}</option>
            {MONTHS_UK.map((m, i) => <option key={i} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
          </Select>
        </div>
        {isOffice && (
          <div>
            <div className="mb-1 text-xs text-slate-500">{t("Фірма")}</div>
            <Select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-40">
              <option value="">{t("Усі")}</option>
              {meta.data?.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        )}
        <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />{t("Запис")}</Button>
        <Button variant="ghost" onClick={() => setTransferring(true)}><ArrowLeftRight className="mr-1 h-4 w-4" />{t("Переміщення")}</Button>
        <Button variant="ghost" onClick={() => setManagingCats(true)}><Tags className="mr-1 h-4 w-4" />{t("Категорії")}</Button>
      </div>

      {summary.isFetching && !s ? <Spinner /> : s && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Metric icon={<PiggyBank className="h-5 w-5 text-slate-400" />} label={t("На початок")} value={s.opening} />
            <Metric icon={<ArrowDownLeft className="h-5 w-5 text-emerald-500" />} label={t("Покладено")} value={s.inflow} tone="text-emerald-700" />
            <Metric icon={<ArrowUpRight className="h-5 w-5 text-rose-500" />} label={t("Видано")} value={s.outflow} tone="text-rose-600" />
            <Metric icon={<Wallet className="h-5 w-5 text-slate-400" />} label={t("На кінець")} value={s.closing} />
          </div>
          {!box && s.boxTotals && Object.keys(s.boxTotals).length > 1 && (
            <div className="mt-2 text-sm text-slate-500">
              {Object.entries(s.boxTotals).map(([b, v]) => `${boxLabel(b)}: ${zl(v.closing)}`).join(" · ")}
            </div>
          )}
        </>
      )}

      {/* межа місяців: вписане відкриття ≠ закриттю попереднього */}
      {s && (s.discrepancies.length > 0 || s.ackedDiscrepancies.length > 0) && (
        <Card className="mt-4 border-amber-200 bg-amber-50 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-800"><AlertTriangle className="h-4 w-4" />{t("Каса не сходиться між місяцями")}</div>
          <ul className="space-y-1 text-sm text-amber-700">
            {s.discrepancies.map(d => (
              <li key={d.ref} className="flex flex-wrap items-center gap-2">
                <span>{d.box === "office" ? coName(d.companyId) : boxLabel(d.box)} · {d.month}: {t("вписаний початок {a}, а кінець попереднього місяця {b} (різниця {c})", { a: zl(d.entered), b: zl(d.expected), c: zl(d.diff) })}</span>
                <button className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-medium hover:bg-amber-100" onClick={() => ackIt("month", d.ref)}>{t("Зафіксувати")}</button>
              </li>
            ))}
          </ul>
          {s.ackedDiscrepancies.length > 0 && (
            <details className="mt-2 text-xs text-amber-700/80">
              <summary className="cursor-pointer">{t("Зафіксовані розбіжності: {n}", { n: s.ackedDiscrepancies.length })}</summary>
              <ul className="mt-1 space-y-0.5">
                {s.ackedDiscrepancies.map(d => (
                  <li key={d.ref} className="flex flex-wrap items-center gap-2">
                    <span>{d.box === "office" ? coName(d.companyId) : boxLabel(d.box)} · {d.month}: {zl(d.diff)} — <i>{d.ack?.note || t("без пояснення")}</i></span>
                    <button className="text-amber-600 underline decoration-dotted" onClick={() => unack(d.ack!.id)}><Undo2 className="inline h-3 w-3" /> {t("скасувати")}</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      )}

      {/* звірка з банком: зняття ↔ вписане в касу («знято з карти») */}
      {rec.data && (rec.data.unmatchedBank.length > 0 || rec.data.unmatchedCash.length > 0 || rec.data.ackedBank.length > 0) && (
        <Card className="mt-3 border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="mb-1 flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />{t("Звірка з банком не сходиться")}</div>
          <ul className="ml-6 list-disc space-y-0.5">
            {rec.data.unmatchedBank.length > 0 && (
              <li>
                {t("зняття без пари в касі: {n} на {v}", { n: rec.data.unmatchedBank.length, v: zl(rec.data.unmatchedBankTotal) })}
                <ul className="mt-0.5 space-y-0.5 text-[13px]">
                  {rec.data.unmatchedBank.slice(0, 12).map(b => (
                    <li key={b.id} className="flex flex-wrap items-center gap-2">
                      <span className="tabular-nums">{b.date} · {zl(b.amount)}</span>
                      <button className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-medium hover:bg-amber-100" onClick={() => ackIt("bank", String(b.id))}>{t("Зафіксувати")}</button>
                    </li>
                  ))}
                  {rec.data.unmatchedBank.length > 12 && <li className="text-amber-700/70">{t("+ ще {n}", { n: rec.data.unmatchedBank.length - 12 })}</li>}
                </ul>
              </li>
            )}
            {rec.data.unmatchedCash.length > 0 && (
              <li>{t("приходи в касі без пари в банку: {n} на {v} (позначені в списку нижче)", { n: rec.data.unmatchedCash.length, v: zl(rec.data.unmatchedCashTotal) })}</li>
            )}
            <li className="font-medium">{netDiffLine(rec.data.bankTotal, rec.data.cashTotal)}</li>
          </ul>
          {rec.data.ackedBank.length > 0 && (
            <details className="mt-2 text-xs text-amber-700/80">
              <summary className="cursor-pointer">{t("Зафіксовані розбіжності: {n}", { n: rec.data.ackedBank.length })}</summary>
              <ul className="mt-1 space-y-0.5">
                {rec.data.ackedBank.map(b => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums">{b.date} · {zl(b.amount)}</span> — <i>{b.ack?.note || t("без пояснення")}</i>
                    <button className="text-amber-600 underline decoration-dotted" onClick={() => unack(b.ack!.id)}><Undo2 className="inline h-3 w-3" /> {t("скасувати")}</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      )}

      {/* звірка готівкових ЗП зі сводною попереднього місяця */}
      {monthNum && payrollRec.data && payrollGroups.length > 0 && !svodniReady && (
        <div className="mt-3 text-sm text-slate-500">
          {t("Зарплат готівкою за {a}: {v}. Сводна {b} ще без готівкових сум — звірка увімкнеться, щойно сводна буде заповнена.", { a: `${year}-${monthNum}`, v: zl(payrollRec.data.kasaTotal), b: payrollRec.data.svodniMonth })}
        </div>
      )}
      {monthNum && payrollRec.data && payrollGroups.length > 0 && svodniReady && (
        <Card className="mt-3 p-0">
          <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
            {t("Зарплати готівкою за {b} — видаються в {a}", { a: kasaMonthStr, b: payrollRec.data.svodniMonth })}
          </div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
              <th className="px-4 py-2 text-left">{t("Категорія")}</th>
              <th className="px-3 py-2 text-right">{t("Видано")}</th>
              <th className="px-3 py-2 text-right">{t("За сводною (готівка)")}</th>
              <th className="px-3 py-2 text-right">{t("Залишилось видати")}</th>
              <th className="px-2 py-2"></th>
            </tr></thead>
            <tbody>
              {payrollGroups.map(g => {
                const remaining = g.svodni != null ? Math.round((g.svodni - g.kasa) * 100) / 100 : null;
                const overpaid = remaining != null && remaining < -1;
                // недоплата — розбіжність лише після завершення місяця виплат
                const bad = !g.ack && remaining != null && (overpaid || (!payoutsOngoing && remaining > 1));
                return (
                  <tr key={g.key} className={`border-b border-slate-100 ${bad ? "bg-amber-50" : ""}`}>
                    <td className="px-4 py-1.5 text-slate-700">
                      {g.payroll === "legacy" ? t("Зарплати (без розбивки, історія)") : g.label}
                      {g.unsplit > 0 && <div className="text-[11px] text-slate-400">{t("у сводній не розбито конто/готівка: {v}", { v: zl(g.unsplit) })}</div>}
                      {g.ack && <div className="text-[11px] text-slate-400">{t("зафіксовано")}: <i>{g.ack.note || "—"}</i> <button className="underline decoration-dotted" onClick={() => unack(g.ack!.id)}>{t("скасувати")}</button></div>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{zl(g.kasa)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{g.svodni != null ? zl(g.svodni) : "—"}</td>
                    <td className={`px-3 py-1.5 text-right font-medium tabular-nums ${remaining == null ? "text-slate-400" : overpaid ? "text-amber-700" : bad ? "text-amber-700" : Math.abs(remaining) <= 1 ? "text-emerald-600" : "text-slate-500"}`}>
                      {remaining == null ? "—" : overpaid ? t("перевидано на {v}", { v: zl(-remaining) }) : zl(remaining)}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {bad && <button className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100" onClick={() => ackIt("payroll", g.ref)}>{t("Зафіксувати")}</button>}
                    </td>
                  </tr>
                );
              })}
              {(() => {
                const withSv = payrollGroups.filter(g => g.svodni != null);
                const remTotal = Math.round(withSv.reduce((s, g) => s + (g.svodni! - g.kasa), 0) * 100) / 100;
                return (
                  <tr className="text-sm font-semibold text-slate-700">
                    <td className="px-4 py-2">{t("Разом")}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{zl(payrollRec.data.kasaTotal)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{zl(payrollRec.data.svodniTotal)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{zl(remTotal)}</td>
                    <td></td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
          {payoutsOngoing && (
            <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              {t("Виплати тривають — жовтим підсвічуються лише перевидачі понад сводну; недоплата стане розбіжністю після завершення {a}.", { a: kasaMonthStr })}
            </div>
          )}
        </Card>
      )}

      <Card className="mt-4 p-0">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">{t("Рухи каси")}</div>
        {entries.isFetching && !entries.data ? <div className="p-5"><Spinner /></div> : !(entries.data?.rows.length) ? <div className="p-5"><Empty>{t("Немає записів")}</Empty></div> : (
          <div className="max-h-[560px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <th className="px-3 py-2 text-left">{t("Дата")}</th>
                {!box && <th className="px-3 py-2 text-left">{t("Ящик")}</th>}
                {showFirmCol && <th className="px-3 py-2 text-left">{t("Фірма")}</th>}
                <th className="px-3 py-2 text-left">{t("Категорія")}</th>
                <th className="px-3 py-2 text-left">{t("Опис")}</th>
                <th className="px-3 py-2 text-right">{t("Сума")}</th>
                <th className="px-2 py-2"></th>
              </tr></thead>
              <tbody>
                {/* opening-рядки з таблиці (шапки вкладок) — шум; ручні перерахунки показуємо */}
                {entries.data!.rows.filter(e => e.kind !== "opening" || e.box !== "office" || e.tabName === "manual").map(e => {
                  const cashAck = ackedCashById.get(e.id);
                  const catOptions = e.kind === "out" ? outCats : inCats;
                  return (
                    <tr key={e.id} className={`border-b border-slate-100 ${unmatchedCash.has(e.id) ? "bg-amber-50" : ""}`}>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{e.entryDate ?? e.periodMonth}</td>
                      {!box && <td className="px-3 py-1.5 text-slate-600">{boxLabel(e.box)}</td>}
                      {showFirmCol && <td className="px-3 py-1.5 text-slate-600">{e.box === "office" ? coName(e.companyId) : "—"}</td>}
                      <td className="px-3 py-1.5">
                        {e.kind === "opening" ? (
                          <span className="text-xs text-slate-500">{t("Початковий залишок (перерахунок)")}</span>
                        ) : e.category && (e.category === "transfer" ? (
                          <span className="text-xs text-slate-400">{t("Переміщення")}</span>
                        ) : (
                          <select
                            value={e.category}
                            onChange={async ev => { await patch(`/cash/entries/${e.id}/category`, { category: ev.target.value }); invalidate(); }}
                            className={`max-w-[200px] cursor-pointer truncate rounded border-0 bg-transparent p-0 text-xs focus:ring-0 ${e.manualCategory ? "font-medium text-sky-700" : "text-slate-500"}`}
                            title={e.manualCategory ? t("категорію змінено вручну") : t("категорія авто — можна змінити")}
                          >
                            {!catOptions.some(c => c.key === e.category) && <option value={e.category}>{t(catLabel(e.category))}</option>}
                            {catOptions.map(c => <option key={c.key} value={c.key}>{t(c.label)}</option>)}
                          </select>
                        ))}
                      </td>
                      <td className="px-3 py-1.5 text-slate-700">
                        <div className="max-w-[340px] truncate">
                          {e.description || "—"}
                          {e.transferGroup && <span className="ml-1.5 rounded bg-sky-100 px-1 text-[10px] font-medium text-sky-700">{t("переміщення")}</span>}
                          {e.tabName !== "manual" && <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] text-slate-400">{t("з таблиці")}</span>}
                        </div>
                        {e.note && <div className="max-w-[340px] truncate text-xs text-slate-400">{e.note}</div>}
                        {unmatchedCash.has(e.id) && (
                          <div className="flex items-center gap-2 text-[11px] font-medium text-amber-600">
                            {t("не знайдено зняття в банку")}
                            <button className="underline decoration-dotted" onClick={() => ackIt("cash", String(e.id))}>{t("зафіксувати")}</button>
                          </div>
                        )}
                        {cashAck && (
                          <div className="text-[11px] text-slate-400">
                            {t("без пари в банку, зафіксовано")}: <i>{cashAck.note || "—"}</i>{" "}
                            <button className="underline decoration-dotted" onClick={() => unack(cashAck.id)}>{t("скасувати")}</button>
                          </div>
                        )}
                      </td>
                      <td className={`whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums ${e.kind === "in" ? "text-emerald-600" : e.kind === "out" ? "text-rose-600" : "text-slate-700"}`}>{e.kind === "in" ? "+" : e.kind === "out" ? "−" : "="}{zl(e.amount)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">
                        {e.editable && (
                          <>
                            {!e.transferGroup && <button className="p-1 text-slate-300 hover:text-slate-600" onClick={() => setEditing(e)}><Pencil className="h-4 w-4" /></button>}
                            <button className="p-1 text-slate-300 hover:text-rose-500" onClick={async () => { if (confirm(e.transferGroup ? t("Видалити переміщення (обидва записи)?") : t("Видалити запис?"))) { await del(`/cash/entries/${e.id}`); invalidate(); } }}><Trash2 className="h-4 w-4" /></button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {transferring && (
        <TransferModal
          companies={meta.data?.companies ?? []}
          defaultFrom={box && box !== "office" ? box : "office"}
          onClose={() => setTransferring(false)}
          onSaved={() => { setTransferring(false); invalidate(); }}
        />
      )}
      {(adding || editing) && (
        <EntryModal
          companies={meta.data?.companies ?? []}
          entry={editing}
          defaultCompany={companyId}
          defaultBox={editing ? editing.box : (box || "office")}
          boxLocked={!!editing || !!box}
          outCats={outCats}
          inCats={inCats}
          byKey={byKey}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); invalidate(); }}
        />
      )}
      {managingCats && <CatsModal onClose={() => { setManagingCats(false); invalidate(); }} />}
      <AckNoteModal target={ackTarget} onClose={() => setAckTarget(null)} onDone={() => { setAckTarget(null); invalidate(); }} />
    </>
  );
}

function Metric({ icon, label, value, tone = "text-slate-800" }: { icon: React.ReactNode; label: string; value: number; tone?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between"><div className="text-sm font-medium text-slate-500">{label}</div>{icon}</div>
      <div className={`mt-2 text-2xl font-bold ${tone}`}>{zl(value)}</div>
    </Card>
  );
}

function TransferModal({ companies, defaultFrom, onClose, onSaved }: {
  companies: { id: number; name: string }[]; defaultFrom: string; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const SIDES: Record<string, string> = { ...BOX_LABELS, bank: "Рахунок (банк)" };
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultFrom === "office" ? "yuriy" : "office");
  const [companyId, setCompanyId] = useState(String(companies[0]?.id ?? ""));
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const officeInvolved = from === "office" || to === "office";
  const valid = from !== to && !!amount && !!entryDate && (!officeInvolved || !!companyId) && !(from === "bank" && to === "bank");
  const save = async () => {
    setBusy(true);
    try {
      await post("/cash/transfer", { from, to, companyId: officeInvolved ? Number(companyId) : null, entryDate, amount, note });
      onSaved();
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={t("Переміщення готівки")} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Звідки")}</div>
            <Select value={from} onChange={e => setFrom(e.target.value)}>
              {Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            </Select></label>
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Куди")}</div>
            <Select value={to} onChange={e => setTo(e.target.value)}>
              {Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            </Select></label>
        </div>
        {from === to && <div className="text-xs text-rose-600">{t("«Звідки» і «Куди» мають різнитися")}</div>}
        {officeInvolved && (
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Фірма (для запису каси офісу)")}</div>
            <Select value={companyId} onChange={e => setCompanyId(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
        )}
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Дата")}</div>
          <Input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Сума")}</div>
          <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Нотатка")}</div>
          <Input value={note} onChange={e => setNote(e.target.value)} /></label>
        {(from === "bank" || to === "bank") && (
          <div className="text-xs text-slate-500">{t("Рух з/на рахунок створює лише запис у касі — банківська частина підтягнеться з витягу і звіриться автоматично")}</div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={busy} disabled={!valid} onClick={save}>{t("Перемістити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function EntryModal({ companies, entry, defaultCompany, defaultBox, boxLocked, outCats, inCats, byKey, onClose, onSaved }: {
  companies: { id: number; name: string }[]; entry: Entry | null; defaultCompany: string; defaultBox: string; boxLocked: boolean;
  outCats: CashCat[]; inCats: CashCat[]; byKey: (key: string) => CashCat | undefined;
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [box, setBox] = useState(defaultBox);
  const [companyId, setCompanyId] = useState(entry ? String(entry.companyId ?? "") : (defaultCompany || String(companies[0]?.id ?? "")));
  const [entryDate, setEntryDate] = useState(entry?.entryDate ?? new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState(entry?.kind ?? "out");
  const [amount, setAmount] = useState(entry ? String(entry.amount) : "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [note, setNote] = useState(entry?.note ?? "");
  // категорія: для видатку — зі списку; для приходу — «з карти» або додатковий прихід
  const entryCat = entry?.manualCategory ?? entry?.category ?? "";
  const [outCat, setOutCat] = useState(entry?.kind === "out" ? entryCat : "");
  const [inSource, setInSource] = useState(entry?.kind === "in" && entryCat && entryCat !== "card" ? "extra" : "card");
  const [inCat, setInCat] = useState(entry?.kind === "in" && entryCat !== "card" ? entryCat : "");
  const [busy, setBusy] = useState(false);
  const isOffice = box === "office";
  // deposit іде через «Переміщення», legacy salary для нових записів не пропонуємо
  const outOptions = outCats.filter(c => c.key !== "deposit" && c.payroll !== "legacy");
  const inOptions = inCats.filter(c => c.key !== "card");
  const category = kind === "out" ? outCat : kind === "in" ? (inSource === "card" ? "card" : inCat) : "";
  const needsDesc = !!category && !!byKey(category)?.requiresDesc;
  const valid = !!amount && !!entryDate && (!isOffice || !!companyId)
    && (kind === "opening" || !!category)
    && (!needsDesc || !!description.trim());
  const save = async () => {
    setBusy(true);
    try {
      const body = { box, companyId: isOffice ? Number(companyId) : null, entryDate, kind, amount, description, note, category: kind === "opening" ? null : category };
      if (entry) await patch(`/cash/entries/${entry.id}`, body);
      else await post("/cash/entries", body);
      onSaved();
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={entry ? t("Редагувати запис") : t("Новий запис каси")} onClose={onClose}>
      <div className="space-y-3">
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Ящик")}</div>
          <Select value={box} onChange={e => setBox(e.target.value)} disabled={boxLocked}>
            {Object.entries(BOX_LABELS).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
          </Select></label>
        {isOffice && (
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Фірма")}</div>
            <Select value={companyId} onChange={e => setCompanyId(e.target.value)} disabled={!!entry}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
        )}
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Тип")}</div>
          <Select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="in">{isOffice ? t("Покладено в касу") : t("Покладено в сейф")}</option>
            <option value="out">{isOffice ? t("Видано з каси") : t("Видано з сейфа")}</option>
            <option value="opening">{t("Початковий залишок (перерахунок)")}</option>
          </Select></label>
        {kind === "opening" && (
          <div className="text-xs text-slate-500">{t("Перерахунок каси на початок місяця. Якщо сума не збігається із закриттям попереднього місяця — розбіжність зʼявиться в рапорті.")}</div>
        )}
        {kind === "in" && (
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Джерело приходу")}</div>
            <Select value={inSource} onChange={e => setInSource(e.target.value)}>
              <option value="card">{t("Знято з карти (з банку)")}</option>
              <option value="extra">{t("Додатковий прихід")}</option>
            </Select></label>
        )}
        {kind === "in" && inSource === "extra" && (
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Категорія приходу")}</div>
            <Select value={inCat} onChange={e => setInCat(e.target.value)}>
              <option value="">{t("— оберіть категорію —")}</option>
              {inOptions.map(c => <option key={c.key} value={c.key}>{t(c.label)}</option>)}
            </Select></label>
        )}
        {kind === "out" && (
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Категорія")}</div>
            <Select value={outCat} onChange={e => setOutCat(e.target.value)}>
              <option value="">{t("— оберіть категорію —")}</option>
              {outOptions.map(c => <option key={c.key} value={c.key}>{t(c.label)}</option>)}
            </Select></label>
        )}
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Дата")}</div>
          <Input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Сума")}</div>
          <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></label>
        <label className="block">
          <div className="mb-1 text-xs font-medium text-slate-500">{t("Опис (кому / за що)")}{needsDesc && <span className="ml-1 text-rose-500">*</span>}</div>
          <Input value={description} onChange={e => setDescription(e.target.value)} />
          {needsDesc && !description.trim() && <div className="mt-1 text-xs text-rose-600">{t("Для цієї категорії опис обовʼязковий")}</div>}
        </label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Нотатка")}</div>
          <Input value={note} onChange={e => setNote(e.target.value)} /></label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={busy} disabled={!valid} onClick={save}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Управління категоріями (додати / перейменувати / видалити) ────────────────
// Вирівняна сітка: назва | тип ЗП | місто | опис обовʼязк. | 🗑 — колонки фіксовані,
// щоб контроли не стрибали під назву; кнопка ✓ живе всередині поля назви.
const CAT_GRID_OUT = "grid grid-cols-[minmax(0,1fr)_8.5rem_7rem_6.5rem_2rem] items-center gap-2";
const CAT_GRID_IN = "grid grid-cols-[minmax(0,1fr)_6.5rem_2rem] items-center gap-2";

function CatsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { outCats, inCats } = useCashCats();
  const refresh = () => qc.invalidateQueries({ queryKey: ["cash-cats"] });
  return (
    <Modal open title={t("Категорії каси")} onClose={onClose} size="xl">
      <div className="space-y-5">
        <CatSection flow="out" title={t("Видатки")} cats={outCats} onChanged={refresh} />
        <CatSection flow="in" title={t("Приходи")} cats={inCats} onChanged={refresh} />
        <div className="text-xs text-slate-400">{t("Зарплатні категорії (тип ЗП + місто) звіряються зі сводною відповідного міста. Системні категорії видалити не можна.")}</div>
      </div>
    </Modal>
  );
}

function CatSection({ flow, title, cats, onChanged }: { flow: "in" | "out"; title: string; cats: CashCat[]; onChanged: () => void }) {
  const t = useT();
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const isOut = flow === "out";
  const add = async () => {
    if (!newLabel.trim()) return;
    setBusy(true);
    try { await post("/cash/categories", { flow, label: newLabel.trim() }); setNewLabel(""); onChanged(); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="mb-2 text-sm font-semibold text-slate-700">{title}</div>
      <div className={`${isOut ? CAT_GRID_OUT : CAT_GRID_IN} px-2 pb-1 text-[11px] uppercase text-slate-400`}>
        <div>{t("Назва")}</div>
        {isOut && <div>{t("Тип ЗП")}</div>}
        {isOut && <div>{t("Місто")}</div>}
        <div>{t("опис обовʼязк.")}</div>
        <div />
      </div>
      <div className="space-y-1">
        {cats.map(c => <CatRow key={c.id} cat={c} onChanged={onChanged} />)}
      </div>
      <div className="mt-2 flex gap-2">
        <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder={t("Нова категорія…")} onKeyDown={e => e.key === "Enter" && add()} />
        <Button variant="ghost" loading={busy} disabled={!newLabel.trim()} onClick={add}><Plus className="mr-1 h-4 w-4" />{t("Додати")}</Button>
      </div>
    </div>
  );
}

function CatRow({ cat, onChanged }: { cat: CashCat; onChanged: () => void }) {
  const t = useT();
  const [label, setLabel] = useState(cat.label);
  const changed = label.trim() !== cat.label && !!label.trim();
  const save = async (patchBody: Record<string, unknown>) => { await patch(`/cash/categories/${cat.id}`, patchBody); onChanged(); };
  const remove = async () => {
    const suffix = cat.usedCount ? ` ${t("Ручних записів категорії: {n} — вони перейдуть в «Інше».", { n: cat.usedCount })}` : "";
    if (!confirm(`${t("Видалити категорію «{n}»?", { n: cat.label })}${suffix}`)) return;
    await del(`/cash/categories/${cat.id}`);
    onChanged();
  };
  const isOut = cat.flow === "out";
  const cityEditable = cat.payroll === "factory" || cat.payroll === "office";
  return (
    <div className={`${isOut ? CAT_GRID_OUT : CAT_GRID_IN} rounded-lg border border-slate-100 px-2 py-1.5`}>
      <div className="relative">
        <Input value={label} onChange={e => setLabel(e.target.value)} className="h-8 pr-8 text-sm" onKeyDown={e => e.key === "Enter" && changed && save({ label: label.trim() })} />
        {changed && (
          <button className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-emerald-500 hover:text-emerald-700" title={t("Зберегти")} onClick={() => save({ label: label.trim() })}>
            <Check className="h-4 w-4" />
          </button>
        )}
      </div>
      {isOut && (
        <Select value={cat.payroll ?? ""} onChange={e => save({ payroll: e.target.value || null })} className="h-8 w-full text-xs" title={t("Тип ЗП (для звірки зі сводною)")} disabled={cat.payroll === "legacy"}>
          <option value="">{t("не зарплатна")}</option>
          <option value="factory">{t("ЗП фабрики")}</option>
          <option value="office">{t("ЗП офісу")}</option>
          <option value="cleaning">{t("ЗП прибирання")}</option>
          {cat.payroll === "legacy" && <option value="legacy">{t("без розбивки")}</option>}
        </Select>
      )}
      {isOut && (cityEditable ? (
        <Select value={cat.city ?? ""} onChange={e => save({ city: e.target.value || null })} className="h-8 w-full text-xs" title={t("Місто")}>
          <option value="">{t("— місто —")}</option>
          {["Люблін", "Лодзь", "Познань"].map(c => <option key={c} value={c}>{c}</option>)}
        </Select>
      ) : <div />)}
      <label className="flex items-center justify-center gap-1 text-[11px] text-slate-500" title={t("Запис із цією категорією вимагає опис")}>
        <input type="checkbox" checked={cat.requiresDesc} onChange={e => save({ requiresDesc: e.target.checked })} />
      </label>
      {!PROTECTED_KEYS.has(cat.key) ? (
        <button className="p-1 text-slate-300 hover:text-rose-500" title={t("Видалити")} onClick={remove}><Trash2 className="h-4 w-4" /></button>
      ) : <div />}
    </div>
  );
}

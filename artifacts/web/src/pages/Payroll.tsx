// «Зарплати» (/payroll) — mirror of the monthly payroll summary workbooks:
// per-factory hours/pay with the declared-vs-cash split and a cost estimate
// (feeds P&L cogs), plus office payroll on a separate tab (linked to nothing).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, RefreshCw, Banknote, Clock, Users, Landmark, Wallet, X } from "lucide-react";
import { get, post, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

interface FactoryRow {
  id: number; factory: string; tabName: string | null; region: string; firm: string | null;
  hours: number | null; doZaplaty: number | null; zaliczki: number | null; hostel: number | null;
  dojazd: number | null; kary: number | null; workers: number | null; students: number | null;
  mainBrutto: number | null; blockBrutto: number | null; blockNetto: number | null;
  gotowka: number | null; blockHoursActual: number | null; blockHoursDeclared: number | null;
  cost: { netto: number; zaliczki: number; hostel: number; workerTax: number; employerZus: number; total: number };
}
interface CashRow { id: number; tabName: string; name: string; hoursActual: number | null; hoursDeclared: number | null; brutto: number | null; netto: number | null; gotowka: number | null }
interface OfficeRow { id: number; firm: string; section: string | null; name: string; status: string | null; hours: string | null; stawka: string | null; brutto: number | null; umowaOd: string | null; umowaDo: string | null; koniecStudiow: string | null; zaswiadczenie: string | null }
interface Source { id: number; periodMonth: string; region: string; spreadsheetId: string; title: string | null; lastSyncAt: string | null; lastError: string | null }
interface Folder { id: number; folderId: string; title: string | null; lastError: string | null }
interface ZusRow { firm: string; declaredBrutto: number; workerTax: number; employerZus: number; total: number }
interface Data {
  month: string; regions: string[]; firms: string[]; factories: FactoryRow[];
  totals: { hours: number; doZaplaty: number; gotowka: number; blockNetto: number; workers: number; students: number; cost: number; zaliczki: number; hostel: number; workerTax: number; employerZus: number };
  plannedZus: ZusRow[]; plannedZusByCity: ZusRow[];
  kasa: { month: string; salaryOut: number };
  cashRows: CashRow[]; office: OfficeRow[]; sources: Source[]; folders: Folder[];
}

const zl = (n: number | null | undefined) => n == null ? "—" : `${n.toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const h = (n: number | null | undefined) => n == null ? "—" : n.toLocaleString("uk-UA", { maximumFractionDigits: 1 });
const MONTHS_UK = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthLabel = (m: string) => { const [y, mm] = m.split("-"); return `${MONTHS_UK[Number(mm) - 1]} ${y}`; };

export default function Payroll() {
  const t = useT();
  const qc = useQueryClient();
  const months = useQuery<{ months: string[] }>({ queryKey: ["payroll-months"], queryFn: () => get("/payroll/months") });
  const [month, setMonth] = useState("");
  const [region, setRegion] = useState("");
  const [firm, setFirm] = useState("");
  const [tab, setTab] = useState<"factories" | "office" | "reconcile">("factories");
  const [drill, setDrill] = useState<FactoryRow | null>(null);
  const [addUrl, setAddUrl] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const active = month || months.data?.months[0] || "";
  const q = useQuery<Data>({
    queryKey: ["payroll", active, region, firm],
    queryFn: () => get(`/payroll?month=${active}${region ? `&region=${encodeURIComponent(region)}` : ""}${firm ? `&firm=${encodeURIComponent(firm)}` : ""}`),
    enabled: !!active,
  });
  const d = q.data;
  const invalidate = () => ["payroll", "payroll-months", "pnl", "pnl-months"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));

  const addSource = async () => {
    if (!addUrl.trim()) return;
    setBusy(true); setErr("");
    try {
      await post("/payroll/sources", { url: addUrl.trim() });
      setAddUrl(""); setAddOpen(false); invalidate();
    } catch (e: any) { setErr(e?.message || String(e)); }
    setBusy(false);
  };
  const syncAll = async () => { setBusy(true); try { await post("/payroll/sync", {}); invalidate(); } finally { setBusy(false); } };

  const drillRows = drill && d ? d.cashRows.filter(r => (drill.tabName ?? "").split(" + ").includes(r.tabName)) : [];

  // office grouped by firm
  const firms = d ? [...new Set(d.office.map(o => o.firm))] : [];

  return (
    <>
      <PageHeader title={t("Зарплати")} subtitle={t("Зведені зарплат по фабриках за місяць: години, виплати, розбивка офіційно/готівка, оцінка собівартості")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Місяць")}</div>
          <Select value={active} onChange={e => setMonth(e.target.value)} className="w-44">
            {(months.data?.months ?? []).map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </Select>
        </div>
        {(d?.regions.length ?? 0) > 1 && (
          <div>
            <div className="mb-1 text-xs text-slate-500">{t("Місто")}</div>
            <Select value={region} onChange={e => setRegion(e.target.value)} className="w-36">
              <option value="">{t("Всі")}</option>
              {d!.regions.map(r => <option key={r} value={r}>{r}</option>)}
            </Select>
          </div>
        )}
        {(d?.firms.length ?? 0) > 1 && (
          <div>
            <div className="mb-1 text-xs text-slate-500">{t("Фірма")}</div>
            <Select value={firm} onChange={e => setFirm(e.target.value)} className="w-32">
              <option value="">{t("Всі")}</option>
              {d!.firms.map(f => <option key={f} value={f}>{f}</option>)}
            </Select>
          </div>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={syncAll} disabled={busy}><RefreshCw className={`mr-1 h-4 w-4 ${busy ? "animate-spin" : ""}`} />{t("Оновити з таблиць")}</Button>
          <Button onClick={() => setAddOpen(true)}><Plus className="mr-1 h-4 w-4" />{t("Додати сводну")}</Button>
        </div>
      </div>

      <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium w-fit">
        {([["factories", t("Фабрики")], ["office", t("Офіс")], ["reconcile", t("Звірка ЗП")]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-md px-4 py-1.5 ${tab === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            {label}
          </button>
        ))}
      </div>

      {q.isFetching && !d ? <Spinner /> : !d || !d.sources.length && !d.factories.length ? (
        <Empty>{t("Немає даних — додай посилання на сводну кнопкою вище")}</Empty>
      ) : tab === "factories" ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Metric label={t("Години")} value={h(d.totals.hours)} icon={<Clock className="h-5 w-5 text-slate-400" />} />
            <Metric label={t("До виплати (netto)")} value={zl(d.totals.doZaplaty)} icon={<Wallet className="h-5 w-5 text-slate-400" />} />
            <Metric label={t("З них готівкою")} value={zl(d.totals.gotowka)} icon={<Banknote className="h-5 w-5 text-amber-500" />} />
            <Metric label={t("Собівартість (оцінка)")} value={zl(d.totals.cost)} icon={<Landmark className="h-5 w-5 text-slate-400" />}
              sub={`${t("податки")}: ${zl(Math.round((d.totals.workerTax + d.totals.employerZus) * 100) / 100)}`} />
            <Metric label={t("Працівників")} value={`${d.totals.workers}`} icon={<Users className="h-5 w-5 text-slate-400" />} sub={`${t("з них студентів")}: ${d.totals.students}`} />
          </div>

          {d.totals.gotowka > 0 && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              {t("Готівка")}: {t("за сводною поза ZUS")} <b>{zl(d.totals.gotowka)}</b> · {t("всього виплат зарплат з каси у")} {monthLabel(d.kasa.month)} <b>{zl(d.kasa.salaryOut)}</b>
              <span className="ml-1 text-xs text-slate-400">({t("каса покриває всі регіони й основну частину виплат, тому суми не мають збігатися")})</span>
            </div>
          )}

          {/* planned ZUS/PIT — totals for the current filter (use the filters above to slice) */}
          {d.plannedZus.length > 0 && (
            <Card className="mt-4 p-0">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div className="font-semibold text-slate-700">{t("Планований ZUS/PIT (оцінка)")}</div>
                <div className="text-sm font-semibold text-slate-700">{zl(Math.round((d.totals.workerTax + d.totals.employerZus) * 100) / 100)}</div>
              </div>
              <div className="grid grid-cols-1 gap-4 px-4 py-3 sm:grid-cols-2">
                <div>
                  <div className="text-xs text-slate-500">{t("Задекл. brutto (база)")}</div>
                  <div className="mt-0.5 font-semibold tabular-nums text-slate-800">{zl(Math.round(d.plannedZus.reduce((a, z) => a + z.declaredBrutto, 0) * 100) / 100)}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">{t("PIT/ZUS разом до сплати")}</div>
                  <div className="mt-0.5 font-semibold tabular-nums text-slate-800">{zl(Math.round((d.totals.workerTax + d.totals.employerZus) * 100) / 100)}</div>
                </div>
              </div>
              <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
                {t("Оцінка за сводними: утримання із задекл. brutto + внески роботодавця ~20,5% від оподаткованого brutto (студенти без ZUS). Розріз по місту чи фірмі — фільтрами вгорі.")}
              </div>
            </Card>
          )}

          <Card className="mt-4 p-0">
            <div className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-700">{t("По фабриках")}</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                  <th className="px-4 py-2 text-left">{t("Фабрика")}</th>
                  <th className="px-3 py-2 text-right">{t("Години")}</th>
                  <th className="px-3 py-2 text-right">{t("Людей (студ.)")}</th>
                  <th className="px-3 py-2 text-right">{t("До виплати")}</th>
                  <th className="px-3 py-2 text-right">{t("Готівкою")}</th>
                  <th className="px-3 py-2 text-right">{t("Аванси")}</th>
                  <th className="px-3 py-2 text-right">{t("Хостел")}</th>
                  <th className="px-3 py-2 text-right">{t("PIT/ZUS") + " ~"}</th>
                  <th className="px-4 py-2 text-right">{t("Собівартість")}</th>
                </tr></thead>
                <tbody>
                  {d.factories.map(f => (
                    <tr key={f.id} onClick={() => f.gotowka != null && setDrill(f)}
                      className={`border-b border-slate-100 ${f.gotowka != null ? "cursor-pointer hover:bg-slate-50" : ""}`}>
                      <td className="px-4 py-1.5 font-medium text-slate-700">
                        {f.factory}
                        {!region && (d.regions.length > 1) && <span className="ml-1.5 text-xs text-slate-400">{f.region}</span>}
                        {f.firm && !firm && <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] text-slate-500">{f.firm}</span>}
                        {!f.tabName && <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] text-slate-500" title={t("вкладку з деталями не знайдено — податки не оцінені")}>{t("без деталей")}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{h(f.hours)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{f.workers ?? "—"}{f.students ? ` (${f.students})` : ""}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(f.doZaplaty)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-amber-700">{f.gotowka ? zl(f.gotowka) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{f.cost.zaliczki ? zl(f.cost.zaliczki) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{f.cost.hostel ? zl(f.cost.hostel) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{f.cost.workerTax + f.cost.employerZus ? zl(Math.round((f.cost.workerTax + f.cost.employerZus) * 100) / 100) : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-1.5 text-right font-medium tabular-nums text-slate-800">{zl(f.cost.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
                  <td className="px-4 py-2">{t("Разом")}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{h(d.totals.hours)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{d.totals.workers} ({d.totals.students})</td>
                  <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.doZaplaty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-700">{zl(d.totals.gotowka)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.zaliczki)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.hostel)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{zl(Math.round((d.totals.workerTax + d.totals.employerZus) * 100) / 100)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{zl(d.totals.cost)}</td>
                </tr></tfoot>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              {t("Собівартість = netto до виплати + аванси + хостел (зняті з ЗП, але зароблені) + PIT/ZUS (утримання із задекларованої частини + ~20,5% роботодавця). Ці суми автоматично йдуть у P&L як собівартість по клієнтах.")}
            </div>
          </Card>

          {/* sources for this month */}
          <Card className="mt-4 p-0">
            <div className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-700">{t("Джерела (таблиці)")}</div>
            {d.folders.map(f => (
              <div key={`f${f.id}`} className="group flex items-center gap-3 border-b border-slate-100 px-4 py-2 text-sm">
                <a href={`https://drive.google.com/drive/folders/${f.folderId}`} target="_blank" rel="noreferrer" className="font-medium text-slate-700 hover:text-red-600 hover:underline">
                  📁 {f.title || f.folderId}
                </a>
                <span className="text-xs text-slate-400">{t("папка — нові місяці підхоплюються самі")}</span>
                {f.lastError && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-600" title={f.lastError}>{t("помилка синку")}</span>}
                <button onClick={async () => { if (confirm(t("Прибрати папку зі стеження? Імпортовані місяці залишаться."))) { await del(`/payroll/folders/${f.id}`); invalidate(); } }}
                  className="ml-auto hidden text-slate-400 hover:text-rose-600 group-hover:block"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            {!d.sources.length && !d.folders.length ? <div className="p-4"><Empty>{t("Немає джерел за цей місяць")}</Empty></div> : d.sources.map(s => (
              <div key={s.id} className="group flex items-center gap-3 border-b border-slate-100 px-4 py-2 text-sm last:border-0">
                <a href={`https://docs.google.com/spreadsheets/d/${s.spreadsheetId}`} target="_blank" rel="noreferrer" className="font-medium text-slate-700 hover:text-red-600 hover:underline">
                  {s.title || s.spreadsheetId}
                </a>
                <span className="text-xs text-slate-400">{s.region}</span>
                {s.lastError && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-600" title={s.lastError}>{t("помилка синку")}</span>}
                <button onClick={async () => { if (confirm(t("Видалити це джерело разом з даними місяця?"))) { await del(`/payroll/sources/${s.id}`); invalidate(); } }}
                  className="ml-auto hidden text-slate-400 hover:text-rose-600 group-hover:block"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </Card>
        </>
      ) : tab === "reconcile" ? (
        <ReconcileTab month={active} />
      ) : (
        /* office tab — raw mirror, deliberately not linked to anything */
        <>
          {!d.office.length ? <Empty>{t("В сводній цього місяця немає офісних вкладок")}</Empty> : firms.map(firm => {
            const rows = d.office.filter(o => o.firm === firm);
            const total = Math.round(rows.reduce((a, r) => a + (r.brutto ?? 0), 0) * 100) / 100;
            return (
              <Card key={firm} className="mb-4 p-0">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                  <div className="font-semibold text-slate-700">{t("Офіс")} {firm}</div>
                  <div className="text-sm font-semibold text-slate-700">{zl(total)}</div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                      <th className="px-4 py-2 text-left">{t("Імʼя")}</th>
                      <th className="px-3 py-2 text-left">{t("Статус")}</th>
                      <th className="px-3 py-2 text-right">{t("Години")}</th>
                      <th className="px-3 py-2 text-right">{t("Ставка")}</th>
                      <th className="px-3 py-2 text-right">Brutto</th>
                      <th className="px-3 py-2 text-left">{t("Умова")}</th>
                      <th className="px-4 py-2 text-left">Zaświadczenie</th>
                    </tr></thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.id} className="border-b border-slate-100 last:border-0">
                          <td className="px-4 py-1.5 font-medium text-slate-700">{r.name}</td>
                          <td className="px-3 py-1.5">{r.status && <span className={`rounded px-1.5 py-0.5 text-xs ${r.status === "STUD" ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600"}`}>{r.status}</span>}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{r.hours ?? "—"}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{r.stawka ?? "—"}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(r.brutto)}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                            {r.umowaOd || r.umowaDo ? `${r.umowaOd ?? "…"} — ${r.umowaDo ?? "…"}` : "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-1.5 text-slate-500">{r.zaswiadczenie ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
                      <td className="px-4 py-2">{t("Разом")} ({rows.length})</td>
                      <td className="px-3 py-2" /><td className="px-3 py-2" /><td className="px-3 py-2" />
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{zl(total)}</td>
                      <td className="px-3 py-2" /><td className="px-4 py-2" />
                    </tr></tfoot>
                  </table>
                </div>
              </Card>
            );
          })}
          <div className="text-xs text-slate-400">{t("Офісні зарплати поки що ніде не враховуються — це дзеркало вкладок OFFICE зі сводної.")}</div>
        </>
      )}

      {/* drill-down: declared vs cash per worker */}
      {drill && (
        <Modal open size="lg" onClose={() => setDrill(null)} title={`${drill.factory} — ${t("офіційно / готівка")}`}>
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <th className="py-2 pr-3 text-left">{t("Імʼя")}</th>
                <th className="px-2 py-2 text-right">{t("Год. факт")}</th>
                <th className="px-2 py-2 text-right">{t("Год. в ZUS")}</th>
                <th className="px-2 py-2 text-right">Brutto</th>
                <th className="px-2 py-2 text-right">Netto</th>
                <th className="py-2 pl-2 text-right">{t("Готівкою")}</th>
              </tr></thead>
              <tbody>
                {drillRows.map(r => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3 font-medium text-slate-700">{r.name}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{h(r.hoursActual)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{h(r.hoursDeclared)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{zl(r.brutto)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{zl(r.netto)}</td>
                    <td className="py-1.5 pl-2 text-right font-medium tabular-nums text-amber-700">{r.gotowka ? zl(r.gotowka) : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
                <td className="py-2 pr-3">{t("Разом")} ({drillRows.length})</td>
                <td className="px-2 py-2 text-right tabular-nums">{h(drillRows.reduce((a, r) => a + (r.hoursActual ?? 0), 0))}</td>
                <td className="px-2 py-2 text-right tabular-nums">{h(drillRows.reduce((a, r) => a + (r.hoursDeclared ?? 0), 0))}</td>
                <td className="px-2 py-2 text-right tabular-nums">{zl(Math.round(drillRows.reduce((a, r) => a + (r.brutto ?? 0), 0) * 100) / 100)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{zl(Math.round(drillRows.reduce((a, r) => a + (r.netto ?? 0), 0) * 100) / 100)}</td>
                <td className="py-2 pl-2 text-right tabular-nums text-amber-700">{zl(Math.round(drillRows.reduce((a, r) => a + (r.gotowka ?? 0), 0) * 100) / 100)}</td>
              </tr></tfoot>
            </table>
          </div>
        </Modal>
      )}

      {addOpen && (
        <Modal open onClose={() => setAddOpen(false)} title={t("Додати сводну")}>
          <div className="space-y-3">
            <div className="text-sm text-slate-500">{t("Встав посилання на Google-таблицю сводної або на папку Drive зі сводними (назви виду «05.2026 Люблін Сводна» — місяць і регіон зчитаються самі, нові файли в папці підхоплюватимуться щодня). Доступ на читання має бути в сервісного акаунта.")}</div>
            <Input value={addUrl} onChange={e => setAddUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" autoFocus />
            {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAddOpen(false)}><X className="mr-1 h-4 w-4" />{t("Скасувати")}</Button>
              <Button onClick={addSource} disabled={busy || !addUrl.trim()}>{busy ? t("Додаю…") : t("Додати й імпортувати")}</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

interface ReconcileFirm { firm: string; expected: number; noCash: number; noCashFactories: string[]; bank: number; bankWorkers: number; bankOffice: number; bankUnknown: number; bankCount: number; diff: number }
interface Suggest { counterparty: string; firm: string; amount: number }
interface ReconcilePerson { name: string; factories: string[]; firm: string | null; region: string; konto: number; gotowka: number; fullNetto: number; bank: number; bankN: number; bankFirm: string | null; diff: number; suggest: Suggest | null; matchKind: string | null; manualId: number | null }
interface ReconcileOffice { name: string; firm: string; region: string; brutto: number; bank: number; bankN: number; bankFirm: string | null; suggest: Suggest | null; matchKind: string | null; manualId: number | null }
interface ReconcileFactory { factory: string; region: string; firmSvod: string | null; byBankFirm: Record<string, number>; matched: number; total: number; suggested: string | null }
interface ReconcileData {
  month: string; payMonth: string; firms: ReconcileFirm[];
  totals: { expected: number; noCash: number; bank: number; bankWorkers: number; bankOffice: number; bankUnknown: number; diff: number };
  people: ReconcilePerson[]; office: ReconcileOffice[]; factories: ReconcileFactory[];
  bankOnly: { counterparty: string; firm: string; amount: number; n: number; suggest: string | null; suggestKind: string | null }[];
}

// «Звірка ЗП»: сводні (netto − готівка) за місяць M vs зарплатні перекази з банку в M+1
function ReconcileTab({ month }: { month: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"diff" | "all" | "nobank" | "bankonly">("diff");
  const [search, setSearch] = useState("");
  const q = useQuery<ReconcileData>({
    queryKey: ["payroll-reconcile", month],
    queryFn: () => get(`/payroll/reconcile?month=${month}`),
    enabled: !!month,
  });
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["payroll-reconcile"] });
  const confirmMatch = async (counterparty: string, personName: string, kind: string) => {
    await post("/payroll/name-match", { counterparty, personName, kind });
    refresh();
  };
  const unmatch = async (id: number) => { await del(`/payroll/name-match/${id}`); refresh(); };
  if (q.isFetching && !d) return <Spinner />;
  if (!d) return <Empty>{t("Немає даних")}</Empty>;
  const zl2 = (n: number) => `${n.toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
  const s = search.trim().toUpperCase();
  const shown = d.people.filter(p => {
    if (s && !p.name.toUpperCase().includes(s) && !p.factories.join(" ").toUpperCase().includes(s)) return false;
    if (mode === "diff") return p.bankN > 0 && Math.abs(p.diff) >= 5;
    if (mode === "nobank") return p.konto > 0 && p.bankN === 0;
    return mode === "all";
  });
  return (
    <>
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3">
        <span className="font-semibold text-slate-700">{t("Звірка ЗП на рахунок")}</span>
        <span className="ml-2 text-sm text-slate-400">{t("сводні за")} {monthLabel(d.month)} → {t("виплати з банку в")} {monthLabel(d.payMonth)}</span>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
          <th className="px-4 py-2 text-left">{t("Фірма")}</th>
          <th className="px-3 py-2 text-right">{t("Пішло з банку разом")}</th>
          <th className="px-3 py-2 text-right">{t("з них фабричним")}</th>
          <th className="px-3 py-2 text-right">{t("з них офісу")}</th>
          <th className="px-3 py-2 text-right">{t("нерозпізнано")}</th>
          <th className="px-3 py-2 text-right">{t("Мало піти фабричним (сводні)")}</th>
          <th className="px-4 py-2 text-right">{t("Різниця: фабричні − сводні")}</th>
        </tr></thead>
        <tbody>
          {d.firms.map(f => (
            <tr key={f.firm} className="border-b border-slate-100">
              <td className="px-4 py-1.5 font-medium text-slate-700">{f.firm}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums text-slate-800">
                {f.bankCount ? zl2(f.bank) : <span className="font-normal text-slate-400">{t("немає даних")}</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{f.bankCount ? zl2(f.bankWorkers) : "—"}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{f.bankCount ? zl2(f.bankOffice) : "—"}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{f.bankCount && f.bankUnknown ? zl2(f.bankUnknown) : "—"}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700"
                title={f.noCash ? `${t("у т.ч. фабрики без даних про готівку (пораховані як повністю на рахунок)")}: ${f.noCashFactories.join(", ")} — ${zl2(f.noCash)}` : undefined}>
                {zl2(f.expected)}{f.noCash ? <span className="ml-0.5 text-amber-500">*</span> : null}
              </td>
              <td className={`whitespace-nowrap px-4 py-1.5 text-right font-medium tabular-nums ${Math.abs(f.diff) < Math.max(2000, f.expected * 0.05) ? "text-emerald-700" : "text-amber-600"}`}>
                {f.bankCount ? zl2(f.diff) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
          <td className="px-4 py-2">{t("Разом")}</td>
          <td className="px-3 py-2 text-right tabular-nums">{zl2(d.totals.bank)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{zl2(d.totals.bankWorkers)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{zl2(d.totals.bankOffice)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{d.totals.bankUnknown ? zl2(d.totals.bankUnknown) : "—"}</td>
          <td className="px-3 py-2 text-right tabular-nums">{zl2(d.totals.expected)}</td>
          <td className={`px-4 py-2 text-right tabular-nums ${Math.abs(d.totals.diff) < Math.max(2000, d.totals.expected * 0.05) ? "text-emerald-700" : "text-amber-600"}`}>{zl2(d.totals.diff)}</td>
        </tr></tfoot>
      </table>
      <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
        {t("Читається так: скільки зарплат пішло з рахунку фірми разом = фабричним + офісу + нерозпізнане. Порівнюємо фабричну частину з тим, що за сводними мало піти на рахунки (netto мінус готівка). Виплати беруться за наступний місяць (травневі сводні ↔ червневі перекази). * — у сумі є фабрики, де сводна не каже, скільки готівкою: вони пораховані як повністю на рахунок (наведи мишкою — список).")}
      </div>
    </Card>

    {/* which firm's account actually paid each factory's people */}
    <Card className="mt-4 p-0">
      <div className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-700">{t("По фабриках: з якого рахунку реально платили")}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
            <th className="px-4 py-2 text-left">{t("Фабрика")}</th>
            <th className="px-3 py-2 text-left">{t("Фірма у сводній")}</th>
            <th className="px-3 py-2 text-left">{t("Платили з рахунків")}</th>
            <th className="px-3 py-2 text-right">{t("Людей знайдено в банку")}</th>
            <th className="px-4 py-2 text-left">{t("Висновок")}</th>
          </tr></thead>
          <tbody>
            {d.factories.map(f => (
              <tr key={f.factory + f.region} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-1.5 font-medium text-slate-700">{f.factory}<span className="ml-1.5 text-xs text-slate-400">{f.region}</span></td>
                <td className="px-3 py-1.5 text-slate-600">{f.firmSvod ?? "—"}</td>
                <td className="px-3 py-1.5 text-slate-600">
                  {Object.entries(f.byBankFirm).sort((a, b) => b[1] - a[1]).map(([firm, amt]) => `${firm} ${zl2(amt)}`).join(" · ") || "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{f.matched} / {f.total}</td>
                <td className="px-4 py-1.5">
                  {f.suggested && f.firmSvod && f.suggested !== f.firmSvod
                    ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">{t("насправді")} {f.suggested}</span>
                    : f.suggested ? <span className="text-xs text-emerald-700">✓ {f.suggested}</span> : <span className="text-xs text-slate-400">{t("нема переказів")}</span>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
            <td className="px-4 py-2">{t("Разом")}</td>
            <td className="px-3 py-2" />
            <td className="px-3 py-2 text-slate-700">
              {(() => {
                const sums = new Map<string, number>();
                d.factories.forEach(f => Object.entries(f.byBankFirm).forEach(([k, v]) => sums.set(k, (sums.get(k) ?? 0) + v)));
                return [...sums.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${zl2(Math.round(v * 100) / 100)}`).join(" · ") || "—";
              })()}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{d.factories.reduce((a, f) => a + f.matched, 0)} / {d.factories.reduce((a, f) => a + f.total, 0)}</td>
            <td className="px-4 py-2" />
          </tr></tfoot>
        </table>
      </div>
    </Card>

    {/* per-person reconciliation */}
    <Card className="mt-4 p-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
        <div className="font-semibold text-slate-700">{t("По людях")}</div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
          {([["diff", t("Розбіжності")], ["all", t("Всі")], ["nobank", t("Без переказу")], ["bankonly", t("Лише в банку")]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`rounded-md px-2.5 py-1 ${mode === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500"}`}>{label}</button>
          ))}
        </div>
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("Пошук імені чи фабрики…")} className="ml-auto h-8 w-56 text-sm" />
      </div>
      {mode === "bankonly" ? (
        <div className="max-h-[480px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
              <th className="px-4 py-2 text-left">{t("Отримувач (з банку)")}</th>
              <th className="px-3 py-2 text-left">{t("Фірма")}</th>
              <th className="px-3 py-2 text-right">{t("Переказів")}</th>
              <th className="px-3 py-2 text-right">{t("Сума")}</th>
              <th className="px-4 py-2 text-left">{t("Схоже, це")}</th>
            </tr></thead>
            <tbody>
              {d.bankOnly.filter(b => !s || b.counterparty.toUpperCase().includes(s)).map((b, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-1.5 text-slate-700">{b.counterparty}</td>
                  <td className="px-3 py-1.5 text-slate-600">{b.firm}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{b.n}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl2(b.amount)}</td>
                  <td className="px-4 py-1.5">
                    {b.suggest ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700">{b.suggest}{b.suggestKind === "office" ? ` (${t("офіс")})` : ""}?</span>
                        <button onClick={() => confirmMatch(b.counterparty, b.suggest!, b.suggestKind ?? "worker")}
                          className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100">{t("підтвердити")}</button>
                      </span>
                    ) : (
                      <button onClick={() => confirmMatch(b.counterparty, b.counterparty, "office")}
                        title={t("позначити як офісного працівника — зʼявиться в офісній звірці")}
                        className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-200">{t("це офіс")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
              <td className="px-4 py-2">{t("Разом")}</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2 text-right tabular-nums">{d.bankOnly.reduce((a, b) => a + b.n, 0)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{zl2(Math.round(d.bankOnly.reduce((a, b) => a + b.amount, 0) * 100) / 100)}</td>
              <td className="px-4 py-2" />
            </tr></tfoot>
          </table>
        </div>
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white"><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
              <th className="px-4 py-2 text-left">{t("Імʼя")}</th>
              <th className="px-3 py-2 text-left">{t("Фабрика")}</th>
              <th className="px-3 py-2 text-left">{t("Фірма свод / банк")}</th>
              <th className="px-3 py-2 text-right">{t("Очік. на рахунок")}</th>
              <th className="px-3 py-2 text-right">{t("Прийшло з банку")}</th>
              <th className="px-4 py-2 text-right">{t("Різниця")}</th>
            </tr></thead>
            <tbody>
              {shown.map((p, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-1.5 font-medium text-slate-700">{p.name}</td>
                  <td className="px-3 py-1.5 text-slate-500">{p.factories.join(", ")}<span className="ml-1 text-xs text-slate-400">{p.region}</span></td>
                  <td className="px-3 py-1.5">
                    <span className="text-slate-600">{p.firm ?? "—"}</span>
                    {p.bankFirm && (
                      p.bankFirm === p.firm
                        ? <span className="ml-1 text-xs text-emerald-600">= {p.bankFirm}</span>
                        : <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-xs font-medium text-amber-700">{p.bankFirm}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{zl2(p.konto)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">
                    {p.bankN ? (
                      <>
                        {zl2(p.bank)}
                        {p.matchKind === "fuzzy" && <span className="ml-1 rounded bg-sky-50 px-1 text-[10px] text-sky-700" title={t("авто-підтверджено 2-м етапом: імʼя схоже і сума сходиться")}>≈</span>}
                        {p.matchKind === "manual" && p.manualId && (
                          <button onClick={() => unmatch(p.manualId!)} title={t("підтверджено вручну — натисни, щоб розірвати")}
                            className="ml-1 rounded bg-violet-50 px-1 text-[10px] text-violet-700 hover:bg-rose-50 hover:text-rose-600">✓</button>
                        )}
                      </>
                    ) : p.suggest ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700" title={`${p.suggest.counterparty} · ${p.suggest.firm}`}>{t("схоже")}: {zl2(p.suggest.amount)}?</span>
                        <button onClick={() => confirmMatch(p.suggest!.counterparty, p.name, "worker")}
                          className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100">{t("так, це вона/він")}</button>
                      </span>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className={`whitespace-nowrap px-4 py-1.5 text-right font-medium tabular-nums ${!p.bankN ? "text-slate-400" : Math.abs(p.diff) < 5 ? "text-emerald-700" : "text-amber-600"}`}>{p.bankN ? zl2(p.diff) : "—"}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-slate-400">{t("Нічого не знайдено")}</td></tr>}
            </tbody>
            {shown.length > 0 && (
              <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
                <td className="px-4 py-2">{t("Разом")} ({shown.length})</td>
                <td className="px-3 py-2" /><td className="px-3 py-2" />
                <td className="px-3 py-2 text-right tabular-nums">{zl2(Math.round(shown.reduce((a, p) => a + p.konto, 0) * 100) / 100)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{zl2(Math.round(shown.reduce((a, p) => a + p.bank, 0) * 100) / 100)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{zl2(Math.round(shown.reduce((a, p) => a + (p.bankN ? p.diff : 0), 0) * 100) / 100)}</td>
              </tr></tfoot>
            )}
          </table>
        </div>
      )}
      <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
        {t("Матчинг по імені (у банку до імені додається адреса). «Фірма банк» — з якого рахунку людині реально платили: жовтим позначені розбіжності зі сводною. Блакитне «схоже» — пропозиція м'якшого матчингу (одруки в іменах), перевір око́м.")}
      </div>
    </Card>

    {/* office reconciliation — separate, presence + firm (bank pays netto, сводна has brutto) */}
    <Card className="mt-4 p-0">
      <div className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-700">{t("Офіс — окрема звірка")}</div>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white"><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
            <th className="px-4 py-2 text-left">{t("Імʼя")}</th>
            <th className="px-3 py-2 text-left">{t("Фірма (сводна)")}</th>
            <th className="px-3 py-2 text-right">{t("Brutto (сводна)")}</th>
            <th className="px-3 py-2 text-right">{t("Прийшло з банку")}</th>
            <th className="px-4 py-2 text-left">{t("Фірма банку")}</th>
          </tr></thead>
          <tbody>
            {d.office.map((o, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-1.5 font-medium text-slate-700">{o.name}<span className="ml-1.5 text-xs text-slate-400">{o.region}</span></td>
                <td className="px-3 py-1.5 text-slate-600">{o.firm}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{o.brutto ? zl2(o.brutto) : "—"}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">
                  {o.bankN ? (
                    <>
                      {zl2(o.bank)}
                      {o.matchKind === "manual" && o.manualId && (
                        <button onClick={() => unmatch(o.manualId!)} title={t("підтверджено вручну — натисни, щоб розірвати")}
                          className="ml-1 rounded bg-violet-50 px-1 text-[10px] text-violet-700 hover:bg-rose-50 hover:text-rose-600">✓</button>
                      )}
                    </>
                  ) : o.suggest ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700" title={o.suggest.counterparty}>{t("схоже")}: {zl2(o.suggest.amount)}?</span>
                      <button onClick={() => confirmMatch(o.suggest!.counterparty, o.name, "office")}
                        className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100">{t("підтвердити")}</button>
                    </span>
                  ) : <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-1.5 text-slate-600">{o.bankFirm ?? "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
            <td className="px-4 py-2">{t("Разом")} ({d.office.length})</td>
            <td className="px-3 py-2" />
            <td className="px-3 py-2 text-right tabular-nums">{zl2(Math.round(d.office.reduce((a, o) => a + o.brutto, 0) * 100) / 100)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{zl2(Math.round(d.office.reduce((a, o) => a + o.bank, 0) * 100) / 100)}</td>
            <td className="px-4 py-2" />
          </tr></tfoot>
        </table>
      </div>
      <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
        {t("Офіс звіряється окремо і ні з чим не звʼязується: банк платить netto, у сводній brutto — тому суми відрізняються; головне бачити, кому і з якої фірми платили.")}
      </div>
    </Card>
    </>
  );
}

function Metric({ label, value, icon, sub }: { label: string; value: string; icon: React.ReactNode; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">{label}</div>
        {icon}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-slate-800">{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </Card>
  );
}

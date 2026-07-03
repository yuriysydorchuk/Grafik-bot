import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Factory as FactoryIcon, AlertTriangle, BellRing, Download, Check, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { get, post } from "../lib/api";
import { monthOptions } from "../lib/dates";
import { Card, Spinner, Select, Empty, Badge, Button, Input } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { WorkerDaysModal } from "../components/DetailModals";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT, useLang } from "../lib/i18n";

interface Dispute { workerId: number; status: string }

interface HourRow {
  workerId: number; name: string; code: string | null; factoryId: number | null; factory: string | null;
  factoryShiftCount: number; byShift: Record<string, number>; shifts: number; hours: number;
  reportHours?: number | null; reportSubmitted?: boolean; reportLink?: string | null;
  rate?: number; gross?: number; net?: number; laborCost?: number; reportNet?: number | null; reportGross?: number | null; // owner only
}
interface Group { key: string; name: string; factoryId: number | null; n: number; rows: HourRow[]; shifts: number; hours: number; net: number }

export default function Hours() {
  const t = useT();
  const { lang } = useLang();
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const me = useMe();
  const isOwner = me?.role === "owner";
  const [month, setMonth] = useState(months[0]!.value);
  const [sel, setSel] = useState<{ id: number; name: string } | null>(null);
  const monthLabel = months.find(m => m.value === month)?.label ?? month;
  const { data, isFetching } = useQuery<{ month: string; workers: HourRow[]; totalHours: number; totalShifts: number; totalReportHours: number; totalNet?: number; totalReportNet?: number }>({
    queryKey: ["hours", month], queryFn: () => get(`/hours?month=${month}`),
  });
  const { data: disputes = [] } = useQuery<Dispute[]>({ queryKey: ["hours-reports"], queryFn: () => get("/hours-reports") });
  const openByWorker = useMemo(() => new Set(disputes.filter(d => d.status === "new").map(d => d.workerId)), [disputes]);
  const canEdit = can(me, "editData");
  const remind = useMutation({
    // Server picks the report month by the collection window (first days of a month → prev month)
    mutationFn: () => post<{ notified: number; total: number; month: string }>("/hours/report-remind", {}),
    onSuccess: (r) => toast.success(t("Нагадування про рапорт надіслано: {n} з {total}", { n: r.notified, total: r.total }), {
      description: months.find(m => m.value === r.month)?.label ?? r.month,
    }),
    onError: (e: any) => toast.error(e.message),
  });

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const r of data?.workers ?? []) {
      const key = r.factoryId != null ? `f${r.factoryId}` : "none";
      if (!map.has(key)) map.set(key, { key, name: r.factory ?? t("Без фабрики"), factoryId: r.factoryId, n: Math.max(1, r.factoryShiftCount || 1), rows: [], shifts: 0, hours: 0, net: 0 });
      const g = map.get(key)!;
      g.rows.push(r); g.shifts += r.shifts; g.hours += r.hours; g.net += r.net ?? 0;
    }
    return [...map.values()];
  }, [data]);

  const round = (n: number) => Math.round(n * 100) / 100;

  return (
    <>
      <PageHeader title={t("Облік годин")} subtitle={t("Відпрацьовані зміни й фактичні години за місяць (із затвердженого графіку)")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        {data && (
          <div className="flex gap-2">
            <Badge color="slate">{t("Усього змін:")} {data.totalShifts}</Badge>
            <Badge color="green">{t("Усього годин:")} {round(data.totalHours)}</Badge>
            {isOwner && data.totalNet != null && <Badge color="green">{t("ЗП нетто:")} {round(data.totalNet)} zł</Badge>}
            <Badge color="blue">{t("Годин з рапорту:")} {round(data.totalReportHours ?? 0)}</Badge>
            {isOwner && data.totalReportNet != null && <Badge color="blue">{t("ЗП по рапорту:")} {round(data.totalReportNet)} zł</Badge>}
          </div>
        )}
        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" loading={remind.isPending} onClick={() => remind.mutate()}><BellRing className="h-4 w-4" /> {t("Нагадати про рапорт")}</Button>
            <a href={`/api/hours/report-excel?month=${month}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" /> {t("Excel рапорту")}</a>
          </div>
        )}
      </div>

      {openByWorker.size > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-2.5 text-sm text-amber-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{openByWorker.size} {t(openByWorker.size === 1 ? "працівник має скаргу" : "працівників мають скарги")} {t("на години — позначені ⚠️. Клікніть на них, щоб переглянути й затвердити.")}</span>
        </div>
      )}

      {isFetching && !data ? <Spinner /> : !groups.length ? <Empty>{t("За цей місяць немає затверджених змін")}</Empty> : (
        <div className="space-y-6">
          {groups.map(g => {
            const cols = Array.from({ length: g.n }, (_, i) => String(i + 1));
            return (
              <div key={g.key}>
                <div className="mb-2 flex items-center gap-2">
                  <FactoryIcon className="h-4 w-4 text-slate-400" />
                  <h2 className="text-sm font-semibold text-slate-700">{g.name}</h2>
                  <Badge color="slate">{g.shifts} {t("змін")}</Badge>
                  <Badge color="green">{round(g.hours)} {t("год")}</Badge>
                  {isOwner && <Badge color="green">{round(g.net)} {t("zł нетто")}</Badge>}
                  {canEdit && g.factoryId != null && (
                    <a href={`/api/hours/report-excel?month=${month}&factoryId=${g.factoryId}`} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50" title={t("Excel рапорту по фабриці")}><Download className="h-3.5 w-3.5" /> {t("Excel рапорту")}</a>
                  )}
                </div>
                <Card className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                      <tr>
                        <th className="px-4 py-2.5">{t("Працівник")}</th><th className="px-4 py-2.5">{t("Код")}</th>
                        {cols.map(c => <th key={c} className="px-3 py-2.5 text-center">{c} {t("зм")}</th>)}
                        <th className="px-4 py-2.5 text-center">{t("Усього змін")}</th><th className="px-4 py-2.5 text-right">{t("Години")}</th>
                        <th className="px-4 py-2.5 text-right">{t("Години з рапорту")}</th>
                        {isOwner && <><th className="px-3 py-2.5 text-right">{t("Ставка")}</th><th className="px-4 py-2.5 text-right">{t("ЗП нетто")}</th><th className="px-4 py-2.5 text-right">{t("ЗП по рапорту")}</th></>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {g.rows.map(w => (
                        <tr key={`${w.workerId}-${w.factoryId ?? 0}`} onClick={() => setSel({ id: w.workerId, name: w.name })} className="cursor-pointer hover:bg-red-50/40">
                          <td className="px-4 py-2.5 font-medium text-red-700 underline-offset-2 hover:underline">
                            {openByWorker.has(w.workerId) && <span title={t("Є скарга на години")}><AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-amber-500" /></span>}
                            {w.name}
                          </td>
                          <td className="px-4 py-2.5 text-slate-400">{w.code ?? "—"}</td>
                          {cols.map(c => <td key={c} className="px-3 py-2.5 text-center text-slate-600">{w.byShift[c] || <span className="text-slate-300">0</span>}</td>)}
                          <td className="px-4 py-2.5 text-center font-medium text-slate-700">{w.shifts}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-emerald-700">{round(w.hours)} {t("год")}</td>
                          <td className="px-4 py-2.5 text-right" onClick={e => e.stopPropagation()}><ReportHoursCell w={w} month={month} canEdit={canEdit} /></td>
                          {isOwner && <><td className="px-3 py-2.5 text-right text-slate-400">{w.rate ?? "—"}</td><td className="px-4 py-2.5 text-right font-semibold text-slate-700">{round(w.net ?? 0)} zł</td><td className="px-4 py-2.5 text-right font-semibold text-blue-700">{w.reportNet != null ? `${round(w.reportNet)} zł` : "—"}</td></>}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-50 font-semibold text-slate-700">
                        <td className="px-4 py-2.5" colSpan={2 + cols.length}>{t("Разом по фабриці")}</td>
                        <td className="px-4 py-2.5 text-center">{g.shifts}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-700">{round(g.hours)} {t("год")}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{round(g.rows.reduce((s, w) => s + (w.reportHours ?? 0), 0))} {t("год")}</td>
                        {isOwner && <><td /><td className="px-4 py-2.5 text-right text-emerald-700">{round(g.net)} zł</td><td className="px-4 py-2.5 text-right text-blue-700">{round(g.rows.reduce((s, w) => s + (w.reportNet ?? 0), 0))} zł</td></>}
                      </tr>
                    </tfoot>
                  </table>
                </Card>
              </div>
            );
          })}
        </div>
      )}
      {sel && <WorkerDaysModal workerId={sel.id} name={sel.name} month={month} monthLabel={monthLabel} onClose={() => setSel(null)} />}
    </>
  );
}

// Report-hours cell: read-only for non-editors; click-to-edit inline for admins so they
// can fill hours manually (e.g. for workers who submitted before this feature existed).
function ReportHoursCell({ w, month, canEdit }: { w: HourRow; month: string; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const save = useMutation({
    mutationFn: (hours: string | null) => post("/hours/report", { workerId: w.workerId, month, hours, factoryId: w.factoryId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hours", month] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  // The hours value links to the submitted report file (Drive) when there is one.
  const linked = w.reportSubmitted
    ? (w.reportLink
        ? <a href={w.reportLink} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="font-semibold text-red-700 underline-offset-2 hover:underline" title={t("Відкрити рапорт")}>{w.reportHours} {t("год")}</a>
        : <span className="font-semibold text-slate-700">{w.reportHours} {t("год")}</span>)
    : <Badge color="amber">{t("не вислано")}</Badge>;
  if (!canEdit) return linked;
  if (editing) {
    const submit = () => save.mutate(val.replace(",", ".").trim() || null);
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <Input value={val} onChange={e => setVal(e.target.value)} inputMode="decimal" placeholder="1–400" className="w-20 text-right" autoFocus
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") setEditing(false); }} />
        <button onClick={submit} disabled={save.isPending} className="rounded-md p-1 text-emerald-600 hover:bg-emerald-50"><Check className="h-4 w-4" /></button>
        <button onClick={() => setEditing(false)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {linked}
      <button onClick={() => { setVal(w.reportHours != null ? String(w.reportHours) : ""); setEditing(true); }} className="rounded-md p-0.5 text-slate-300 hover:text-red-600" title={t("Вписати години")}><Pencil className="h-3.5 w-3.5" /></button>
    </span>
  );
}

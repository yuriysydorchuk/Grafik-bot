import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Factory as FactoryIcon, AlertTriangle } from "lucide-react";
import { get } from "../lib/api";
import { monthOptions } from "../lib/dates";
import { Card, Spinner, Select, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { WorkerDaysModal } from "../components/DetailModals";
import { useMe } from "../lib/hooks";
import { useT, useLang } from "../lib/i18n";

interface Dispute { workerId: number; status: string }

interface HourRow {
  workerId: number; name: string; code: string | null; factoryId: number | null; factory: string | null;
  factoryShiftCount: number; byShift: Record<string, number>; shifts: number; hours: number;
  rate?: number; gross?: number; net?: number; laborCost?: number; // owner only
}
interface Group { key: string; name: string; n: number; rows: HourRow[]; shifts: number; hours: number; net: number }

export default function Hours() {
  const t = useT();
  const { lang } = useLang();
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const me = useMe();
  const isOwner = me?.role === "owner";
  const [month, setMonth] = useState(months[0]!.value);
  const [sel, setSel] = useState<{ id: number; name: string } | null>(null);
  const monthLabel = months.find(m => m.value === month)?.label ?? month;
  const { data, isFetching } = useQuery<{ month: string; workers: HourRow[]; totalHours: number; totalShifts: number; totalNet?: number }>({
    queryKey: ["hours", month], queryFn: () => get(`/hours?month=${month}`),
  });
  const { data: disputes = [] } = useQuery<Dispute[]>({ queryKey: ["hours-reports"], queryFn: () => get("/hours-reports") });
  const openByWorker = useMemo(() => new Set(disputes.filter(d => d.status === "new").map(d => d.workerId)), [disputes]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const r of data?.workers ?? []) {
      const key = r.factoryId != null ? `f${r.factoryId}` : "none";
      if (!map.has(key)) map.set(key, { key, name: r.factory ?? t("Без фабрики"), n: Math.max(1, r.factoryShiftCount || 1), rows: [], shifts: 0, hours: 0, net: 0 });
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
                </div>
                <Card className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                      <tr>
                        <th className="px-4 py-2.5">{t("Працівник")}</th><th className="px-4 py-2.5">{t("Код")}</th>
                        {cols.map(c => <th key={c} className="px-3 py-2.5 text-center">{c} {t("зм")}</th>)}
                        <th className="px-4 py-2.5 text-center">{t("Усього змін")}</th><th className="px-4 py-2.5 text-right">{t("Години")}</th>
                        {isOwner && <><th className="px-3 py-2.5 text-right">{t("Ставка")}</th><th className="px-4 py-2.5 text-right">{t("ЗП нетто")}</th></>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {g.rows.map(w => (
                        <tr key={w.workerId} onClick={() => setSel({ id: w.workerId, name: w.name })} className="cursor-pointer hover:bg-red-50/40">
                          <td className="px-4 py-2.5 font-medium text-red-700 underline-offset-2 hover:underline">
                            {openByWorker.has(w.workerId) && <span title={t("Є скарга на години")}><AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-amber-500" /></span>}
                            {w.name}
                          </td>
                          <td className="px-4 py-2.5 text-slate-400">{w.code ?? "—"}</td>
                          {cols.map(c => <td key={c} className="px-3 py-2.5 text-center text-slate-600">{w.byShift[c] || <span className="text-slate-300">0</span>}</td>)}
                          <td className="px-4 py-2.5 text-center font-medium text-slate-700">{w.shifts}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-emerald-700">{round(w.hours)} {t("год")}</td>
                          {isOwner && <><td className="px-3 py-2.5 text-right text-slate-400">{w.rate ?? "—"}</td><td className="px-4 py-2.5 text-right font-semibold text-slate-700">{round(w.net ?? 0)} zł</td></>}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-50 font-semibold text-slate-700">
                        <td className="px-4 py-2.5" colSpan={2 + cols.length}>{t("Разом по фабриці")}</td>
                        <td className="px-4 py-2.5 text-center">{g.shifts}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-700">{round(g.hours)} {t("год")}</td>
                        {isOwner && <><td /><td className="px-4 py-2.5 text-right text-emerald-700">{round(g.net)} zł</td></>}
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

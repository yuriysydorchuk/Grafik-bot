import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { WorkerDaysModal } from "../components/DetailModals";
import { useT, useLang } from "../lib/i18n";
import { monthOptions } from "../lib/dates";

interface Row { workerId: number; name: string; code: string | null; factory: string | null; present: number; absent: number; cancelled: number; rate: number | null; hours: number }

const rateBadge = (r: number | null) =>
  r == null ? <Badge>—</Badge>
  : r >= 95 ? <Badge color="green">{r}%</Badge>
  : r >= 85 ? <Badge color="amber">{r}%</Badge>
  : <Badge color="rose">{r}%</Badge>;

export default function Reliability() {
  const t = useT();
  const { lang } = useLang();
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const [month, setMonth] = useState(months[0]!.value);
  const [sel, setSel] = useState<{ id: number; name: string } | null>(null);
  const monthLabel = months.find(m => m.value === month)?.label ?? month;
  const { data, isFetching } = useQuery<{ month: string; workers: Row[] }>({
    queryKey: ["reliability", month], queryFn: () => get(`/reliability?month=${month}`),
  });

  return (
    <>
      <PageHeader title={t("Надійність")} subtitle={t("Явка та пропуски працівників за місяць")} />
      <div className="mb-4"><Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">{months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></div>
      {isFetching && !data ? <Spinner /> : !data?.workers.length ? <Empty>{t("За цей місяць немає затверджених змін")}</Empty> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2.5">{t("Працівник")}</th><th className="px-4 py-2.5">{t("Фабрика")}</th>
                <th className="px-4 py-2.5 text-center">{t("Зміни")}</th><th className="px-4 py-2.5 text-center">{t("Години")}</th>
                <th className="px-4 py-2.5 text-center">{t("Пропуски")}</th><th className="px-4 py-2.5 text-center">{t("Скасовано")}</th>
                <th className="px-4 py-2.5 text-right">{t("Надійність")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.workers.map(w => (
                <tr key={w.workerId} onClick={() => setSel({ id: w.workerId, name: w.name })} className="cursor-pointer hover:bg-red-50/40">
                  <td className="px-4 py-2.5 font-medium text-red-700 underline-offset-2 hover:underline">{w.name}</td>
                  <td className="px-4 py-2.5 text-slate-500">{w.factory ?? "—"}</td>
                  <td className="px-4 py-2.5 text-center text-slate-600">{w.present}</td>
                  <td className="px-4 py-2.5 text-center text-slate-600">{w.hours}</td>
                  <td className="px-4 py-2.5 text-center">{w.absent > 0 ? <span className="font-medium text-rose-600">{w.absent}</span> : <span className="text-slate-300">0</span>}</td>
                  <td className="px-4 py-2.5 text-center">{w.cancelled > 0 ? <span className="text-amber-600">{w.cancelled}</span> : <span className="text-slate-300">0</span>}</td>
                  <td className="px-4 py-2.5 text-right">{rateBadge(w.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {sel && <WorkerDaysModal workerId={sel.id} name={sel.name} month={month} monthLabel={monthLabel} onClose={() => setSel(null)} />}
    </>
  );
}

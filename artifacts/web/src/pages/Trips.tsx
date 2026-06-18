import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { DriverDaysModal } from "../components/DetailModals";
import { useT, useLang } from "../lib/i18n";
import { monthOptions } from "../lib/dates";

interface Row { driverId: number; name: string; vehicle: string | null; total: number; latePickup: number; lateFactory: number }

export default function Trips() {
  const t = useT();
  const { lang } = useLang();
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const [month, setMonth] = useState(months[0]!.value);
  const [sel, setSel] = useState<{ id: number; name: string } | null>(null);
  const monthLabel = months.find(m => m.value === month)?.label ?? month;
  const { data, isFetching } = useQuery<{ month: string; drivers: Row[] }>({
    queryKey: ["trips", month], queryFn: () => get(`/trips?month=${month}`),
  });

  return (
    <>
      <PageHeader title={t("Поїздки водіїв")} subtitle={t("Кількість поїздок і запізнення за місяць")} />
      <div className="mb-4"><Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">{months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></div>
      {isFetching && !data ? <Spinner /> : !data?.drivers.length ? <Empty>{t("За цей місяць немає зафіксованих поїздок")}</Empty> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2.5">{t("Водій")}</th><th className="px-4 py-2.5">{t("Авто")}</th><th className="px-4 py-2.5 text-center">{t("Поїздок")}</th><th className="px-4 py-2.5 text-center">{t("Спізн. на збір")}</th><th className="px-4 py-2.5 text-center">{t("Спізн. на фабрику")}</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.drivers.map(d => (
                <tr key={d.driverId} onClick={() => setSel({ id: d.driverId, name: d.name })} className="cursor-pointer hover:bg-red-50/40">
                  <td className="px-4 py-2.5 font-medium text-red-700 underline-offset-2 hover:underline">{d.name}</td>
                  <td className="px-4 py-2.5 text-slate-500">{d.vehicle ?? "—"}</td>
                  <td className="px-4 py-2.5 text-center text-slate-600">{d.total}</td>
                  <td className="px-4 py-2.5 text-center">{d.latePickup > 0 ? <Badge color="amber">{d.latePickup}</Badge> : <span className="text-slate-300">0</span>}</td>
                  <td className="px-4 py-2.5 text-center">{d.lateFactory > 0 ? <Badge color="rose">{d.lateFactory}</Badge> : <span className="text-slate-300">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {sel && <DriverDaysModal driverId={sel.id} name={sel.name} month={month} monthLabel={monthLabel} onClose={() => setSel(null)} />}
    </>
  );
}

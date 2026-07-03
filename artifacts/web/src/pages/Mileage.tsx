import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, cn } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT, useLang } from "../lib/i18n";
import { monthOptions } from "../lib/dates";

interface Day { date: string; startedAt: string; endedAt: string | null; odoStart: number; odoEnd: number | null; km: number | null }
interface Row { driverId: number; name: string; vehicle: string | null; days: Day[]; totalKm: number; closedShifts: number; avgKm: number | null }

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDate = (d: string, locale: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", weekday: "short" });

export default function Mileage() {
  const t = useT();
  const { lang } = useLang();
  const locale = lang === "en" ? "en-GB" : "uk-UA";
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const [month, setMonth] = useState(months[0]!.value);
  const [driverId, setDriverId] = useState<number | null>(null);
  const { data, isFetching } = useQuery<{ month: string; drivers: Row[] }>({
    queryKey: ["mileage", month], queryFn: () => get(`/mileage?month=${month}`),
  });

  const drivers = data?.drivers ?? [];
  const active = drivers.find(d => d.driverId === driverId) ?? drivers[0];

  return (
    <>
      <PageHeader title={t("Звіт по пробігу")} subtitle={t("Пробіг авто по змінах водіїв (початок/кінець зміни)")} />
      <div className="mb-4"><Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">{months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></div>
      {isFetching && !data ? <Spinner /> : !drivers.length ? <Empty>{t("За цей місяць немає записів пробігу")}</Empty> : (
        <>
          {/* Driver tabs */}
          <div className="mb-4 flex flex-wrap gap-2">
            {drivers.map(d => (
              <button key={d.driverId} onClick={() => setDriverId(d.driverId)}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-sm font-medium transition",
                  active?.driverId === d.driverId
                    ? "border-red-300 bg-red-50 text-red-700"
                    : "border-slate-200 bg-white text-slate-500 hover:text-slate-700",
                )}>
                {d.name}
              </button>
            ))}
          </div>
          {active && (
            <>
              {/* Month summary */}
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Card className="p-4"><div className="text-xs uppercase text-slate-400">{t("Всього за місяць")}</div><div className="mt-1 text-2xl font-bold text-slate-800">{active.totalKm} {t("км")}</div></Card>
                <Card className="p-4"><div className="text-xs uppercase text-slate-400">{t("Змін")}</div><div className="mt-1 text-2xl font-bold text-slate-800">{active.closedShifts}</div></Card>
                <Card className="p-4"><div className="text-xs uppercase text-slate-400">{t("Середній пробіг / зміну")}</div><div className="mt-1 text-2xl font-bold text-slate-800">{active.avgKm ?? "—"} {active.avgKm != null ? t("км") : ""}</div></Card>
                <Card className="p-4"><div className="text-xs uppercase text-slate-400">{t("Авто")}</div><div className="mt-1 text-lg font-semibold text-slate-700">{active.vehicle ?? "—"}</div></Card>
              </div>
              <Card className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-2.5">{t("Дата")}</th>
                      <th className="px-4 py-2.5">{t("Виїзд")}</th>
                      <th className="px-4 py-2.5">{t("Повернення")}</th>
                      <th className="px-4 py-2.5 text-right">{t("Початковий пробіг")}</th>
                      <th className="px-4 py-2.5 text-right">{t("Кінцевий пробіг")}</th>
                      <th className="px-4 py-2.5 text-right">{t("Пробіг за зміну")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {active.days.map((d, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2.5 font-medium text-slate-700">{fmtDate(d.date, locale)}</td>
                        <td className="px-4 py-2.5 text-slate-500">{fmtTime(d.startedAt)}</td>
                        <td className="px-4 py-2.5 text-slate-500">{fmtTime(d.endedAt)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{d.odoStart}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{d.odoEnd ?? "—"}</td>
                        <td className="px-4 py-2.5 text-right">
                          {d.km != null
                            ? <span className="font-semibold tabular-nums text-slate-800">{d.km} {t("км")}</span>
                            : <Badge color="amber">{t("зміна відкрита")}</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}

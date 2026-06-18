import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Factory as FactoryIcon } from "lucide-react";
import { get, type AvailRow, DAYS, DAY_UK } from "../lib/api";
import { upcomingWeeks } from "../lib/dates";
import { WeekSelect } from "../components/WeekSelect";
import { Card, Spinner, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

const shiftColor = (s?: string) => s === "1" ? "blue" : s === "2" ? "amber" : s === "3" ? "red" : "slate";

type Group = { key: string; name: string; rows: AvailRow[] };

export default function Availability() {
  const t = useT();
  const [weekStart, setWeekStart] = useState(upcomingWeeks()[0]!.value);
  const { data, isFetching } = useQuery<AvailRow[]>({
    queryKey: ["availability", weekStart],
    queryFn: () => get(`/availability?weekStart=${weekStart}`),
  });

  const groups = useMemo<Group[]>(() => {
    if (!data) return [];
    const map = new Map<string, Group>();
    for (const r of data) {
      const key = r.factoryId != null ? `f${r.factoryId}` : "none";
      const name = r.factoryName ?? t("Без фабрики");
      if (!map.has(key)) map.set(key, { key, name, rows: [] });
      map.get(key)!.rows.push(r);
    }
    // factories first (alphabetical), "Без фабрики" last
    return [...map.values()].sort((a, b) =>
      a.key === "none" ? 1 : b.key === "none" ? -1 : a.name.localeCompare(b.name, "uk"));
  }, [data]);

  return (
    <>
      <PageHeader title={t("Доступність")} subtitle={t("Хто на які зміни заявився — по фабриках")} />
      <div className="mb-4">
        <WeekSelect value={weekStart} onChange={setWeekStart} />
      </div>
      {isFetching && !data ? <Spinner /> : !data?.length ? <Empty>{t("Ніхто ще не заповнив доступність на цей тиждень")}</Empty> : (
        <div className="space-y-6">
          {groups.map(g => (
            <div key={g.key}>
              <div className="mb-2 flex items-center gap-2">
                <FactoryIcon className="h-4 w-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-700">{g.name}</h2>
                <Badge color={g.key === "none" ? "amber" : "slate"}>{g.rows.length} {t("осіб")}</Badge>
              </div>
              <Card className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-2.5 text-left">{t("Працівник")}</th>
                      {DAYS.map(d => <th key={d} className="px-3 py-2.5">{DAY_UK[d]}</th>)}
                      <th className="px-3 py-2.5">{t("Джерело")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {g.rows.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-4 py-2 font-medium text-slate-700">{r.name}</td>
                        {DAYS.map(d => (
                          <td key={d} className="px-3 py-2 text-center">
                            {r.days[d]?.length
                              ? <span className="inline-flex flex-wrap justify-center gap-1">
                                  {r.days[d]!.map(s => <Badge key={s} color={shiftColor(s) as any}>{s} {t("зм")}</Badge>)}
                                </span>
                              : <span className="text-slate-300">—</span>}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-center text-xs text-slate-400">{r.source === "telegram" ? "Telegram" : "Sheets"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

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

// Per-day×shift breakdown where every person is counted once a day: those who reported a
// single shift land there; those who reported several are placed greedily into the least
// loaded of their shifts so the columns stay roughly balanced ("плюс-мінус рівна кількість").
type Summary = { shifts: string[]; byDay: Record<string, Record<string, number>>; byShift: Record<string, number>; total: number };

function buildSummary(rows: AvailRow[]): Summary {
  const shiftSet = new Set<string>();
  for (const r of rows) for (const d of DAYS) for (const s of r.days[d] ?? []) shiftSet.add(s);
  const shifts = [...shiftSet].sort();
  const byDay: Record<string, Record<string, number>> = {};
  const byShift: Record<string, number> = Object.fromEntries(shifts.map(s => [s, 0]));
  let total = 0;
  for (const d of DAYS) {
    const counts: Record<string, number> = Object.fromEntries(shifts.map(s => [s, 0]));
    const single: string[] = [];
    const multi: string[][] = [];
    for (const r of rows) {
      const av = r.days[d];
      if (!av?.length) continue;
      if (av.length === 1) single.push(av[0]!); else multi.push(av);
    }
    for (const s of single) counts[s]!++;
    // most-constrained first (fewest options) for a tighter balance
    multi.sort((a, b) => a.length - b.length);
    for (const cand of multi) {
      let best = cand[0]!;
      for (const s of cand) if (counts[s]! < counts[best]!) best = s;
      counts[best]!++;
    }
    byDay[d] = counts;
    for (const s of shifts) { byShift[s]! += counts[s]!; total += counts[s]!; }
  }
  return { shifts, byDay, byShift, total };
}

type Group = { key: string; name: string; rows: AvailRow[]; summary: Summary };

export default function Availability() {
  const t = useT();
  const [weekStart, setWeekStart] = useState(upcomingWeeks()[0]!.value);
  const { data, isFetching } = useQuery<AvailRow[]>({
    queryKey: ["availability", weekStart],
    queryFn: () => get(`/availability?weekStart=${weekStart}`),
  });

  const groups = useMemo<Group[]>(() => {
    if (!data) return [];
    const map = new Map<string, Omit<Group, "summary">>();
    for (const r of data) {
      const key = r.factoryId != null ? `f${r.factoryId}` : "none";
      const name = r.factoryName ?? t("Без фабрики");
      if (!map.has(key)) map.set(key, { key, name, rows: [] });
      map.get(key)!.rows.push(r);
    }
    // factories first (alphabetical), "Без фабрики" last
    return [...map.values()]
      .map(g => ({ ...g, summary: buildSummary(g.rows) }))
      .sort((a, b) => a.key === "none" ? 1 : b.key === "none" ? -1 : a.name.localeCompare(b.name, "uk"));
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
              {g.summary.shifts.length > 0 && (
                <Card className="mb-2 overflow-x-auto p-3">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">{t("Розподіл по змінах")}</div>
                  <table className="w-full text-xs">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">{t("День")}</th>
                        {g.summary.shifts.map(s => <th key={s} className="px-2 py-1 text-center font-medium">{s} {t("зм")}</th>)}
                        <th className="px-2 py-1 text-center font-medium">{t("Усього")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {DAYS.map(d => {
                        const row = g.summary.byDay[d] ?? {};
                        const dayTotal = g.summary.shifts.reduce((a, s) => a + (row[s] ?? 0), 0);
                        return (
                          <tr key={d} className="border-t border-slate-100">
                            <td className="px-2 py-1 font-medium text-slate-600">{DAY_UK[d]}</td>
                            {g.summary.shifts.map(s => (
                              <td key={s} className="px-2 py-1 text-center">
                                {row[s] ? <Badge color={shiftColor(s) as any}>{row[s]}</Badge> : <span className="text-slate-300">·</span>}
                              </td>
                            ))}
                            <td className="px-2 py-1 text-center font-semibold text-slate-600">{dayTotal || <span className="text-slate-300">·</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-200">
                        <td className="px-2 py-1 font-semibold text-slate-500">{t("Усього")}</td>
                        {g.summary.shifts.map(s => <td key={s} className="px-2 py-1 text-center font-semibold text-slate-600">{g.summary.byShift[s] || 0}</td>)}
                        <td className="px-2 py-1 text-center font-bold text-slate-700">{g.summary.total}</td>
                      </tr>
                    </tfoot>
                  </table>
                </Card>
              )}
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

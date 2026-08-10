import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Factory as FactoryIcon, Send } from "lucide-react";
import { toast } from "sonner";
import { get, post, type AvailRow, DAYS, DAY_UK } from "../lib/api";
import { upcomingWeeks } from "../lib/dates";
import { WeekSelect } from "../components/WeekSelect";
import { Card, Spinner, Empty, Badge, Button, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT } from "../lib/i18n";

interface MissingWorker { id: number; fullName: string; telegramId: string | null; factoryName: string | null }

const shiftColor = (s?: string) => s === "1" ? "blue" : s === "2" ? "amber" : s === "3" ? "red" : "slate";
const fmtAt = (iso: string) => new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

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
  const [hist, setHist] = useState<AvailRow | null>(null); // модалка історії заповнення
  const me = useMe();
  const canRemind = can(me, "editData");
  const confirm = useConfirm();
  const { data, isFetching } = useQuery<AvailRow[]>({
    queryKey: ["availability", weekStart],
    queryFn: () => get(`/availability?weekStart=${weekStart}`),
  });
  // Workers who still haven't filled availability for the selected week (for the reminder button)
  const { data: missing = [] } = useQuery<MissingWorker[]>({
    queryKey: ["avail-missing", weekStart], enabled: !!weekStart && canRemind,
    queryFn: () => get(`/availability/missing?weekStart=${weekStart}`),
  });
  const remind = useMutation({
    mutationFn: () => post("/availability/remind", { weekStart }),
    onSuccess: (r: any) => toast.success(t("Нагадування надіслано"), { description: `✅ ${r.notified}${r.skipped ? ` · ⚠️ ${t("без Telegram")}: ${r.skipped}` : ""}` }),
    onError: (e: any) => toast.error(e.message),
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
      {/* Кнопки тижнів + «Нагадати всім»: липнуть під топбаром, як на «Графіках»
          (md+ only). top-[52px] = висота топбара − 1px; -mx-8/px-8 розтягують
          непрозору смугу на всю колонку контенту. z-40 — вище за шапки фабрик
          нижче, щоб вони ховалися під бар, а не просвічували. */}
      <div className="mb-4 flex flex-wrap items-center gap-3 md:sticky md:top-[52px] md:z-40 md:-mx-8 md:bg-page md:px-8 md:pb-3 md:pt-2 md:shadow-[0_6px_10px_-8px_rgb(15_23_42/0.12)]">
        <WeekSelect value={weekStart} onChange={setWeekStart} />
        {canRemind && (
          <div className="flex items-center gap-2">
            <Badge color={missing.length ? "amber" : "green"}>{t("Не заповнили:")} {missing.length}</Badge>
            <Button variant="secondary" loading={remind.isPending} disabled={missing.length === 0}
              onClick={async () => {
                const n = missing.filter(w => w.telegramId).length;
                const msg = n > 0
                  ? t("{n} із {total} прац. мають Telegram і отримають нагадування заповнити доступність на наступний тиждень.", { n, total: missing.length })
                  : t("Жоден із {total} прац. не приєднаний до Telegram — нагадування нікому не надійде.", { total: missing.length });
                if (await confirm({ title: t("Надіслати нагадування?"), message: msg, confirmText: t("Надіслати") })) remind.mutate();
              }}>
              <Send className="h-3.5 w-3.5" /> {t("Нагадати всім")}
            </Button>
          </div>
        )}
      </div>
      {isFetching && !data ? <Spinner /> : !data?.length ? <Empty>{t("Ніхто ще не заповнив доступність на цей тиждень")}</Empty> : (
        <div className="space-y-6">
          {groups.map(g => (
            <div key={g.key}>
              {/* Шапка фабрики (md+): липне під закріпленим баром тижнів (52px топбар
                  + ~92px бар), поки скролиться її секція; фіксована висота h-10 — під
                  неї підігнаний top шапки таблиці нижче. Наступна фабрика природно
                  виштовхує попередню (sticky в межах секції). */}
              <div className="mb-2 flex items-center gap-2 md:sticky md:top-[144px] md:z-30 md:-mx-2 md:h-10 md:bg-page md:px-2">
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
              {/* md+: таблиця скролиться разом зі сторінкою, а рядок днів липне одразу
                  під шапкою фабрики (top = 52px топбар + ~92px бар тижнів + 40px шапка
                  фабрики = 184px). На мобільному sticky вимкнено — горизонтальний скрол. */}
              <Card className="overflow-x-auto md:overflow-visible">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-400">
                    <tr>
                      <th className="bg-slate-50 px-4 py-2.5 text-left md:sticky md:top-[184px] md:z-20 md:shadow-[0_1px_0_rgb(226_232_240)]">{t("Працівник")}</th>
                      {DAYS.map(d => <th key={d} className="bg-slate-50 px-3 py-2.5 md:sticky md:top-[184px] md:z-20 md:shadow-[0_1px_0_rgb(226_232_240)]">{DAY_UK[d]}</th>)}
                      <th className="bg-slate-50 px-3 py-2.5 md:sticky md:top-[184px] md:z-20 md:shadow-[0_1px_0_rgb(226_232_240)]">{t("Заповнено")}</th>
                      <th className="bg-slate-50 px-3 py-2.5 md:sticky md:top-[184px] md:z-20 md:shadow-[0_1px_0_rgb(226_232_240)]">{t("Джерело")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {g.rows.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-4 py-2 font-medium text-slate-700">{r.name}</td>
                        {DAYS.map(d => (
                          <td key={d} className="px-3 py-2 text-center">
                            {r.dayOff?.[d] && (
                              <span className="mr-1" title={r.dayOff[d] === "pending" ? t("Відпрошується (не підтверджено)") : t("Вихідний підтверджено")}>
                                {r.dayOff[d] === "pending" ? "⚠️" : "🏖"}
                              </span>
                            )}
                            {r.days[d]?.length
                              ? <span className="inline-flex flex-wrap justify-center gap-1">
                                  {r.days[d]!.map(s => <Badge key={s} color={shiftColor(s) as any}>{s} {t("зм")}</Badge>)}
                                </span>
                              : <span className="text-slate-300">—</span>}
                          </td>
                        ))}
                        <td className="whitespace-nowrap px-3 py-2 text-center text-xs text-slate-500">
                          {r.history?.length
                            ? <button onClick={() => setHist(r)} title={t("Переглянути історію заповнення")}
                                className="underline decoration-dotted underline-offset-2 hover:text-slate-700">
                                {fmtAt(r.filledAt ?? r.history[r.history.length - 1]!.at)}
                              </button>
                            : r.filledAt ? fmtAt(r.filledAt) : <span className="text-slate-300">—</span>}
                          {(r.history?.length ?? 0) > 1 && (
                            <button onClick={() => setHist(r)}
                              className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-200"
                              title={t("Заповнював(ла) кілька разів — переглянути історію")}>
                              ✎ ×{r.history!.length}
                            </button>
                          )}
                          {r.hasLate && (
                            <button onClick={() => setHist(r)}
                              className="ml-1.5 rounded bg-rose-100 px-1 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-200"
                              title={t("Додав(ла) диспозиційність уже ПІСЛЯ затвердження графіку — деталі в історії")}>
                              📝 {t("після затвердж.")}
                            </button>
                          )}
                        </td>
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
      {hist && (
        <Modal open onClose={() => setHist(null)} title={`${t("Історія заповнення")} — ${hist.name}`}>
          <div className="space-y-3">
            {(hist.history ?? []).map((b, i) => (
              <div key={b.at} className={`rounded-lg border p-3 ${b.late ? "border-rose-200 bg-rose-50/40" : "border-slate-200"}`}>
                <div className="mb-1.5 flex items-center gap-2 text-xs">
                  <Badge color={i === 0 ? "green" : "amber"}>{i === 0 ? t("Перше заповнення") : t("Додав(ла) пізніше")}</Badge>
                  {b.late && <Badge color="red">{t("після затвердження графіку")}</Badge>}
                  <span className="text-slate-400">{fmtAt(b.at)}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {b.pairs.map((p, j) => (
                    <span key={j} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {DAY_UK[p.day as keyof typeof DAY_UK] ?? p.day} <Badge color={shiftColor(p.shift) as any}>{p.shift} {t("зм")}</Badge>
                    </span>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-slate-400">{t("Історія подань доступності зберігається для показу ~2 тижні.")}</p>
          </div>
        </Modal>
      )}
    </>
  );
}

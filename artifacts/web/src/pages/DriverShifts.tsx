import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, CopyPlus, Truck, ChevronRight, Check, Clock } from "lucide-react";
import { toast } from "sonner";
import { get, post, put, DAYS, DAY_UK, type DayCode, type ShiftCode } from "../lib/api";
import { upcomingWeeks, dayDate, weekLabel, mondayOf } from "../lib/dates";
import { usePersisted } from "../lib/hooks";
import { WeekSelect } from "../components/WeekSelect";
import { Button, Card, Empty, Badge, Modal, Spinner } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";
import { isTelegramWebApp } from "../lib/telegram";

type PickupGap = { reason: "none" | "capacity"; people: number; seats: number | null } | null;
type Cell = { day: DayCode; shift: ShiftCode; start: string | null; end: string | null; headcount: number; drivers: { id: number; name: string | null }[]; pickupDrivers: { id: number; name: string | null }[]; pickupGap: PickupGap; cancelled?: boolean };
type FactoryBoard = { id: number; name: string; shiftCount: number; cells: Cell[] };
type DriverRow = { id: number; name: string; seats: number | null; isHeadDriver: boolean; telegramId: string | null };
type Board = { weekStart: string; hasWeek: boolean; factories: FactoryBoard[]; drivers: DriverRow[] };

// Local YYYY-MM-DD at weekStart + offset days (never UTC — see lib/dates.ts)
const ymdAt = (weekStart: string, offset: number) => {
  const d = new Date(weekStart + "T00:00:00"); d.setDate(d.getDate() + offset);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const prevWeek = (weekStart: string) => ymdAt(weekStart, -7);
const nextWeek = (weekStart: string) => ymdAt(weekStart, 7);
const dayIdx = (d: DayCode) => DAYS.indexOf(d);
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// A day already in the past can't receive new assignments — the bot reads today's
// runs from the week the day belongs to, so a "past" assignment never reaches drivers.
const isPastDay = (weekStart: string, d: DayCode) => ymdAt(weekStart, dayIdx(d)) < todayYmd();
const isWeekend = (d: DayCode) => d === "sat" || d === "sun";
const cellKey = (factoryId: number, day: DayCode, shift: ShiftCode) => `${factoryId}:${day}-${shift}`;
const initials = (name: string) => name.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const shiftsOf = (f: FactoryBoard) => [...new Set(f.cells.map(c => c.shift))].sort() as ShiftCode[];
const daysOf = (f: FactoryBoard) => DAYS.filter(d => f.cells.some(c => c.day === d));
const hoursOf = (f: FactoryBoard, s: ShiftCode) => { const c = f.cells.find(c => c.shift === s); return c?.start && c?.end ? `${c.start}–${c.end}` : ""; };
// Mobile layout shows one day at a time (chips row); default = today when it's inside the week
const dayToday = (weekStart: string): DayCode => {
  const i = DAYS.findIndex((_, idx) => ymdAt(weekStart, idx) === todayYmd());
  return i >= 0 ? DAYS[i]! : "mon";
};
const daysUnion = (factories: FactoryBoard[]) => DAYS.filter(d => factories.some(f => f.cells.some(c => c.day === d)));

// Horizontal day picker for phones (shared by the overview and the assign modal)
function DayChips({ weekStart, days, value, onChange }: { weekStart: string; days: DayCode[]; value: DayCode; onChange: (d: DayCode) => void }) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
      {days.map(d => {
        const past = isPastDay(weekStart, d);
        return (
          <button key={d} type="button" onClick={() => onChange(d)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              value === d ? "bg-red-600 text-white shadow-sm" : "bg-white text-slate-600 ring-1 ring-slate-200"} ${past ? "opacity-50" : ""}`}>
            {DAY_UK[d]} <span className={value === d ? "text-red-200" : "text-slate-400"}>{dayDate(weekStart, dayIdx(d))}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function DriverShifts() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [weekStart, setWeekStart] = usePersisted<string>("sel.dshift.week", upcomingWeeks()[0]!.value);
  const [editDriver, setEditDriver] = useState<DriverRow | null>(null);
  const [mobileDay, setMobileDay] = useState<DayCode>(() => dayToday(weekStart));
  useEffect(() => { setMobileDay(dayToday(weekStart)); }, [weekStart]);

  // The persisted selection must not resurrect a finished week: assigning into it
  // silently lands in the past (recurring head-driver trap on weekends).
  const currentMonday = mondayOf(new Date());
  useEffect(() => { if (weekStart < currentMonday) setWeekStart(currentMonday); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const dow = new Date().getDay(); // 0=Sun, 6=Sat
  const showNextWeekHint = weekStart === currentMonday && (dow === 6 || dow === 0);

  const { data, isFetching } = useQuery<Board>({
    queryKey: ["driver-board", weekStart], enabled: !!weekStart,
    queryFn: () => get(`/driver-board?weekStart=${weekStart}`),
  });
  const reload = () => qc.invalidateQueries({ queryKey: ["driver-board"] });

  const copyPrev = useMutation({
    mutationFn: () => post("/schedule/driver-assignments/copy-week", { fromWeekStart: prevWeek(weekStart), toWeekStart: weekStart }),
    onSuccess: (r: any) => { reload(); toast.success(t("Скопійовано з попереднього тижня"), { description: t("Призначень: {n}", { n: r?.count ?? 0 }) }); },
    onError: (e: any) => toast.error(e.message),
  });

  const factories = data?.factories ?? [];
  const drivers = data?.drivers ?? [];
  const driverLoad = useMemo(() => {
    const m = new Map<number, number>();
    for (const f of factories) for (const c of f.cells) for (const d of [...c.drivers, ...c.pickupDrivers]) m.set(d.id, (m.get(d.id) ?? 0) + 1);
    return m;
  }, [factories]);

  return (
    <>
      <PageHeader title={t("Призначення водіїв")} subtitle={t("Огляд усіх фабрик і змін — оберіть водія, щоб призначити")} />

      {/* Telegram Mini App: slim picker — this week + next, no archive */}
      <WeekSelect value={weekStart} onChange={setWeekStart} className="mb-4"
        limit={isTelegramWebApp ? 2 : undefined} showArchive={!isTelegramWebApp} />

      {showNextWeekHint && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          <span>💡 {t("Плануєте наступний тиждень? Зараз відкрито тиждень, що вже закінчується.")}</span>
          <button type="button" onClick={() => setWeekStart(nextWeek(currentMonday))}
            className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-700">
            {t("Перейти на {week}", { week: weekLabel(nextWeek(currentMonday)) })}
          </button>
        </div>
      )}
      {weekStart < currentMonday && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ⚠️ {t("Це минулий тиждень. Нові призначення тут бот водіям не покаже.")}
        </div>
      )}

      {isFetching && !data ? <Spinner /> : (
        <>
          {/* Drivers first — the main working list: pick a driver, then assign shifts */}
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700"><Truck className="h-4 w-4 text-red-600" /> {t("Водії")}</h3>
            {!isTelegramWebApp && (
              <Button variant="secondary" loading={copyPrev.isPending}
                onClick={async () => { if (await confirm({ title: t("Скопіювати призначення?"), message: t("Призначення водіїв з тижня {week} замінять поточні цього тижня.", { week: weekLabel(prevWeek(weekStart)) }), confirmText: t("Скопіювати") })) copyPrev.mutate(); }}>
                <CopyPlus className="h-4 w-4" /> {t("З попереднього тижня")}
              </Button>
            )}
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {!drivers.length ? <Empty>{t("Немає водіїв. Додайте їх на вкладці «Водії».")}</Empty> : drivers.map(d => {
              const load = driverLoad.get(d.id) ?? 0;
              return (
                <button key={d.id} onClick={() => setEditDriver(d)}
                  className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-left transition hover:border-red-300 hover:shadow-sm">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${load > 0 ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"}`}>
                    {initials(d.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-700">{d.isHeadDriver && "👑 "}{d.name}</span>
                    <span className="block text-xs">
                      {load > 0 ? <span className="text-emerald-600">{load} {t("змін цього тижня")}</span> : <span className="text-slate-400">{t("без змін")}</span>}
                      {!d.telegramId && <span className="text-amber-600"> · {t("не в Telegram")}</span>}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-red-400" />
                </button>
              );
            })}
          </div>

          {!factories.length ? (
            <div className="mt-6"><Empty>{data?.hasWeek ? t("Немає змін у графіку на цей тиждень") : t("Графік на цей тиждень ще не згенеровано")}</Empty></div>
          ) : (
            <div className="mt-6 space-y-4">
              <div className="sm:hidden"><DayChips weekStart={weekStart} days={daysUnion(factories)} value={mobileDay} onChange={setMobileDay} /></div>
              {factories.map(f => <FactoryCard key={f.id} f={f} weekStart={weekStart} mobileDay={mobileDay} />)}
            </div>
          )}
        </>
      )}

      {editDriver && <AssignModal driver={editDriver} factories={factories} weekStart={weekStart} onClose={() => setEditDriver(null)} onSaved={() => { reload(); setEditDriver(null); }} />}
    </>
  );
}

// Overview: columns = days (horizontal), rows = shifts (vertical); phones get a one-day list
function FactoryCard({ f, weekStart, mobileDay }: { f: FactoryBoard; weekStart: string; mobileDay: DayCode }) {
  const t = useT();
  const shifts = useMemo(() => shiftsOf(f), [f]);
  const days = useMemo(() => daysOf(f), [f]);
  const cellOf = (d: DayCode, s: ShiftCode) => f.cells.find(c => c.day === d && c.shift === s);
  const notifyWorkers = useMutation({
    mutationFn: () => post<{ notified: number; skipped: number }>("/schedule/notify-workers", { weekStart, factoryId: f.id }),
    onSuccess: (r) => toast.success(t("Сповіщено працівників: {n}", { n: r.notified }), { description: r.skipped ? t("{n} без Telegram — пропущено", { n: r.skipped }) : undefined }),
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
        <Truck className="h-4 w-4 text-slate-400" />
        <span className="text-sm font-semibold text-slate-700">{f.name}</span>
        <Badge color="slate">{shifts.length} {t(shifts.length === 1 ? "зміна" : "зміни")}</Badge>
        <button onClick={() => notifyWorkers.mutate()} disabled={notifyWorkers.isPending}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          title={t("Надіслати працівникам графік з водіями")}>
          <Send className="h-3.5 w-3.5" /> {t("Сповістити працівників")}
        </button>
      </div>
      {/* Phone: just the day picked in the chips row, stacked vertically */}
      <div className="sm:hidden">
        {(() => {
          const dayCells = f.cells.filter(c => c.day === mobileDay).sort((a, b) => a.shift.localeCompare(b.shift));
          if (!dayCells.length) return <div className="px-4 py-3 text-sm text-slate-300">—</div>;
          const past = isPastDay(weekStart, mobileDay);
          return (
            <div className={`divide-y divide-slate-100 ${past ? "opacity-50" : ""}`}>
              {dayCells.map(c => (
                <div key={c.shift} className="flex items-start gap-3 px-4 py-3">
                  <div className="w-20 shrink-0">
                    <div className="text-sm font-semibold text-slate-700">{c.shift} {t("зм")}</div>
                    {c.start && c.end && <div className="text-[11px] text-slate-400">{c.start}–{c.end}</div>}
                    <div className="mt-0.5 text-xs text-slate-500">{c.headcount} {t("ос.")}</div>
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    {c.cancelled && <div><Badge color="rose">❌ {t("скасовано")}</Badge></div>}
                    <div className="flex flex-wrap gap-1">
                      {c.drivers.length ? c.drivers.map(dr => (
                        <span key={dr.id} className="rounded-md bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">{dr.name}</span>
                      )) : <span className="text-xs text-slate-300">{t("без водія")}</span>}
                    </div>
                    {c.pickupDrivers.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {c.pickupDrivers.map(dr => (
                          <span key={dr.id} className="rounded-md bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700" title={t("Забрати зі зміни")}>🔙 {dr.name}</span>
                        ))}
                      </div>
                    )}
                    {c.pickupGap && <div><Badge color="amber">⚠️ {t("нема кому забрати")}</Badge></div>}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
      </div>
      {/* Desktop: full week table */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-xs text-slate-400">
              <th className="sticky left-0 z-10 bg-white px-4 py-2 text-left font-medium">{t("Зміна")}</th>
              {days.map(d => (
                <th key={d} title={isPastDay(weekStart, d) ? t("День уже минув") : undefined}
                  className={`min-w-24 px-3 py-2 text-center font-medium ${isWeekend(d) ? "bg-slate-50/70" : ""} ${isPastDay(weekStart, d) ? "opacity-50" : ""}`}>
                  <div className="text-slate-500">{DAY_UK[d]}</div>
                  <div className="font-normal text-slate-300">{dayDate(weekStart, dayIdx(d))}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shifts.map(s => (
              <tr key={s} className="align-top">
                <td className="sticky left-0 z-10 bg-white px-4 py-2.5 whitespace-nowrap">
                  <div className="font-medium text-slate-700">{s} {t("зміна")}</div>
                  {hoursOf(f, s) && <div className="flex items-center gap-1 text-xs text-slate-400"><Clock className="h-3 w-3" />{hoursOf(f, s)}</div>}
                </td>
                {days.map(d => {
                  const c = cellOf(d, s);
                  if (!c) return <td key={d} className={`px-3 py-2.5 text-center text-slate-200 ${isWeekend(d) ? "bg-slate-50/40" : ""}`}>—</td>;
                  return (
                    <td key={d} className={`px-3 py-2.5 text-center ${isWeekend(d) ? "bg-slate-50/40" : ""} ${isPastDay(weekStart, d) ? "opacity-50" : ""}`}>
                      {c.cancelled && <div className="mb-1"><Badge color="rose">❌ {t("скасовано")}</Badge></div>}
                      <div className="text-sm font-semibold text-slate-700">{c.headcount} <span className="font-normal text-slate-400">{t("ос.")}</span></div>
                      <div className="mt-1 flex flex-wrap justify-center gap-1">
                        {c.drivers.length ? c.drivers.map(dr => (
                          <span key={dr.id} className="rounded-md bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">{dr.name}</span>
                        )) : <span className="text-xs text-slate-300">—</span>}
                      </div>
                      {c.pickupDrivers.length > 0 && (
                        <div className="mt-1 flex flex-wrap justify-center gap-1">
                          {c.pickupDrivers.map(dr => (
                            <span key={dr.id} className="rounded-md bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700" title={t("Забрати зі зміни")}>🔙 {dr.name}</span>
                          ))}
                        </div>
                      )}
                      {c.pickupGap && (
                        <div className="mt-1" title={c.pickupGap.reason === "capacity"
                          ? t("Місць не вистачає: {people} ос., місць {seats}", { people: c.pickupGap.people, seats: c.pickupGap.seats ?? 0 })
                          : t("Ніхто не приїжджає на кінець цієї зміни")}>
                          <Badge color="amber">⚠️ {t("нема кому забрати")}</Badge>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// Per-driver assignment: click cells to toggle (rows = shifts, cols = days) + bulk toggles
function AssignModal({ driver, factories, weekStart, onClose, onSaved }: {
  driver: DriverRow; factories: FactoryBoard[]; weekStart: string; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const initial = useMemo(() => {
    const set = new Set<string>();
    for (const f of factories) for (const c of f.cells) {
      if (c.drivers.some(d => d.id === driver.id)) set.add(cellKey(f.id, c.day, c.shift));
      if (c.pickupDrivers.some(d => d.id === driver.id)) set.add(cellKey(f.id, c.day, c.shift) + "-p"); // «Забрати зі зміни»
    }
    return set;
  }, [factories, driver.id]);
  const [sel, setSel] = useState<Set<string>>(new Set(initial));
  const [notify, setNotify] = useState(!!driver.telegramId);
  const [mDay, setMDay] = useState<DayCode>(() => dayToday(weekStart));

  const toggle = (k: string) => setSel(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const setMany = (keys: string[], on: boolean) => setSel(prev => { const n = new Set(prev); for (const k of keys) on ? n.add(k) : n.delete(k); return n; });
  const allSel = (keys: string[]) => keys.length > 0 && keys.every(k => sel.has(k));

  const dirty = sel.size !== initial.size || [...sel].some(k => !initial.has(k));

  const save = useMutation({
    mutationFn: async () => {
      const slots: Record<string, string[]> = {};
      for (const k of sel) { const [fid, ds] = k.split(":"); (slots[fid!] ??= []).push(ds!); }
      await put("/schedule/driver-assignments/by-driver", { weekStart, driverId: driver.id, slots });
      if (notify) return post("/schedule/notify-driver", { weekStart, driverId: driver.id });
      return { notified: 0, skipped: 0 };
    },
    onSuccess: (r: any) => { toast.success(t("Збережено"), { description: notify ? (r?.notified ? t("Водія сповіщено в Telegram") : t("Водій без Telegram — не сповіщено")) : undefined }); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  // small pill-style bulk toggle
  const BulkChip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button type="button" onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${on ? "bg-red-600 text-white" : "bg-white text-slate-400 ring-1 ring-slate-200 hover:ring-red-300"}`}>
      {children}
    </button>
  );

  return (
    <Modal open onClose={onClose} title={`${t("Призначення")} — ${driver.isHeadDriver ? "👑 " : ""}${driver.name}`} size="xl">
      <div className="space-y-4">
        <p className="hidden text-xs text-slate-400 sm:block">{t("Натискайте клітинки, щоб призначити водія на зміну. Скористайтесь «вся фабрика» / «усі дні» / «весь день» для швидкого вибору.")}</p>
        <p className="text-xs text-slate-400 sm:hidden">{t("Оберіть день і натискайте зміни, щоб призначити водія. 🔙 — забрати людей зі зміни.")}</p>

        {/* Phone: one day at a time, big tap targets */}
        {factories.length > 0 && (
          <div className="space-y-3 sm:hidden">
            <DayChips weekStart={weekStart} days={daysUnion(factories)} value={mDay} onChange={setMDay} />
            {factories.map(f => {
              const cells = f.cells.filter(c => c.day === mDay).sort((a, b) => a.shift.localeCompare(b.shift));
              if (!cells.length) return null;
              const past = isPastDay(weekStart, mDay);
              const dayKeys = cells.filter(c => !c.cancelled && !past).map(c => cellKey(f.id, mDay, c.shift));
              return (
                <div key={f.id} className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-700"><Truck className="h-3.5 w-3.5 shrink-0 text-slate-400" /><span className="truncate">{f.name}</span></span>
                    {dayKeys.length > 0 && <BulkChip on={allSel(dayKeys)} onClick={() => setMany(dayKeys, !allSel(dayKeys))}>{t("весь день")}</BulkChip>}
                  </div>
                  <div className="divide-y divide-slate-100">
                    {cells.map(c => {
                      const k = cellKey(f.id, mDay, c.shift);
                      const kp = k + "-p";
                      const on = sel.has(k), onP = sel.has(kp);
                      const others = c.drivers.filter(x => x.id !== driver.id);
                      const othersP = c.pickupDrivers.filter(x => x.id !== driver.id);
                      if (c.cancelled) {
                        return (
                          <div key={c.shift} className="px-3 py-2.5">
                            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600">❌ {c.shift} {t("зм")} — {t("скасовано")}</div>
                          </div>
                        );
                      }
                      return (
                        <div key={c.shift} className={`px-3 py-2.5 ${past ? "opacity-50" : ""}`}>
                          <div className="flex items-stretch gap-2">
                            <button type="button" disabled={past} onClick={() => toggle(k)}
                              className={`flex flex-1 items-center justify-between rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                                on ? "border-red-600 bg-red-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-700 active:border-red-300"}`}>
                              <span>{c.shift} {t("зм")}{c.start && c.end ? <span className={`ml-1.5 text-xs font-normal ${on ? "text-red-200" : "text-slate-400"}`}>{c.start}–{c.end}</span> : null}</span>
                              <span className="flex items-center gap-1.5">
                                {on && <Check className="h-4 w-4" />}
                                <span className={`text-xs ${on ? "text-red-100" : "text-slate-500"}`}>{c.headcount} {t("ос.")}</span>
                              </span>
                            </button>
                            <button type="button" disabled={past} onClick={() => toggle(kp)} title={t("Забрати зі зміни")}
                              className={`shrink-0 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                                onP ? "border-sky-600 bg-sky-600 text-white" : c.pickupGap ? "border-amber-300 bg-amber-50 text-amber-700" : "border-slate-200 bg-white text-slate-400"}`}>
                              🔙{onP ? " ✓" : c.pickupGap ? " ⚠️" : ""}
                            </button>
                          </div>
                          {past && <div className="mt-1 text-[10px] text-slate-400">{t("минув")}</div>}
                          {(others.length > 0 || othersP.length > 0) && (
                            <div className="mt-1 text-[11px] text-slate-400">+{[...others.map(o => o.name), ...othersP.map(o => `🔙${o.name}`)].join(", ")}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!factories.length ? <Empty>{t("Немає змін для призначення")}</Empty> : <div className="hidden space-y-4 sm:block">{factories.map(f => {
          const shifts = shiftsOf(f), days = daysOf(f);
          // Bulk toggles must not touch cancelled cells nor days already in the past
          const selectable = f.cells.filter(c => !c.cancelled && !isPastDay(weekStart, c.day));
          const allKeys = selectable.map(c => cellKey(f.id, c.day, c.shift));
          const rowKeys = (s: ShiftCode) => selectable.filter(c => c.shift === s).map(c => cellKey(f.id, c.day, c.shift));
          const colKeys = (d: DayCode) => selectable.filter(c => c.day === d).map(c => cellKey(f.id, c.day, c.shift));
          return (
            <div key={f.id} className="overflow-hidden rounded-xl border border-slate-200">
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-700"><Truck className="h-3.5 w-3.5 text-slate-400" />{f.name}</span>
                <BulkChip on={allSel(allKeys)} onClick={() => setMany(allKeys, !allSel(allKeys))}>{t("вся фабрика")}</BulkChip>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400">
                      <th className="px-3 py-2 text-left font-medium">{t("Зміна")}</th>
                      {days.map(d => (
                        <th key={d} title={isPastDay(weekStart, d) ? t("День уже минув") : undefined}
                          className={`min-w-20 px-2 py-2 text-center font-medium ${isWeekend(d) ? "bg-slate-50/70" : ""} ${isPastDay(weekStart, d) ? "opacity-50" : ""}`}>
                          <div className="text-slate-500">{DAY_UK[d]}</div>
                          <div className="font-normal text-slate-300">{dayDate(weekStart, dayIdx(d))}</div>
                          {!isPastDay(weekStart, d) && (
                            <div className="mt-1"><BulkChip on={allSel(colKeys(d))} onClick={() => setMany(colKeys(d), !allSel(colKeys(d)))}>{t("весь день")}</BulkChip></div>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shifts.map(s => (
                      <tr key={s} className="align-top">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="font-medium text-slate-700">{s} {t("зм")}</div>
                          {hoursOf(f, s) && <div className="text-xs text-slate-400">{hoursOf(f, s)}</div>}
                          <div className="mt-1"><BulkChip on={allSel(rowKeys(s))} onClick={() => setMany(rowKeys(s), !allSel(rowKeys(s)))}>{t("усі дні")}</BulkChip></div>
                        </td>
                        {days.map(d => {
                          const c = f.cells.find(c => c.day === d && c.shift === s);
                          if (!c) return <td key={d} className={`px-2 py-2 text-center text-slate-200 ${isWeekend(d) ? "bg-slate-50/40" : ""}`}>—</td>;
                          const k = cellKey(f.id, d, s);
                          const kp = k + "-p"; // pickup («Забрати зі зміни»)
                          const on = sel.has(k);
                          const onP = sel.has(kp);
                          const others = c.drivers.filter(x => x.id !== driver.id);
                          const othersP = c.pickupDrivers.filter(x => x.id !== driver.id);
                          if (c.cancelled) {
                            return (
                              <td key={d} className={`px-2 py-2 text-center ${isWeekend(d) ? "bg-slate-50/40" : ""}`}>
                                <div className="rounded-lg border border-rose-200 bg-rose-50 px-2 py-2 text-[10px] font-medium text-rose-600">❌ {t("скасовано")}</div>
                              </td>
                            );
                          }
                          if (isPastDay(weekStart, d)) {
                            // Read-only: show what was assigned, but block new toggles — the day
                            // is over, drivers would never see an assignment made "into the past"
                            return (
                              <td key={d} className={`px-2 py-2 text-center ${isWeekend(d) ? "bg-slate-50/40" : ""}`}>
                                <div title={t("День уже минув")}
                                  className={`flex w-full flex-col items-center gap-0.5 rounded-lg border px-2 py-1.5 opacity-50 ${on ? "border-red-300 bg-red-100 text-red-700" : "border-slate-200 bg-slate-50 text-slate-400"}`}>
                                  {on ? <Check className="h-4 w-4" /> : <span className="text-sm font-bold">{c.headcount}</span>}
                                  <span className="text-[10px] font-medium">{t("минув")}</span>
                                </div>
                                {onP && (
                                  <div className="mt-1 w-full rounded-md border border-sky-200 bg-sky-50 px-1 py-0.5 text-[10px] font-medium text-sky-600 opacity-60">🔙 {t("забрати")}</div>
                                )}
                              </td>
                            );
                          }
                          return (
                            <td key={d} className={`px-2 py-2 text-center ${isWeekend(d) ? "bg-slate-50/40" : ""}`}>
                              <button type="button" onClick={() => toggle(k)}
                                className={`flex w-full flex-col items-center gap-0.5 rounded-lg border px-2 py-1.5 transition ${
                                  on ? "border-red-600 bg-red-600 text-white shadow-sm" : "border-slate-200 bg-white hover:border-red-300"}`}>
                                {on ? <Check className="h-4 w-4" /> : <span className="text-sm font-bold text-slate-700">{c.headcount}</span>}
                                <span className={`text-[10px] font-medium ${on ? "text-red-100" : "text-slate-500"}`}>{on ? `${c.headcount} ${t("ос.")}` : t("ос.")}</span>
                              </button>
                              <button type="button" onClick={() => toggle(kp)} title={t("Забрати зі зміни")}
                                className={`mt-1 w-full rounded-md border px-1 py-0.5 text-[10px] font-medium transition ${
                                  onP ? "border-sky-600 bg-sky-600 text-white" : c.pickupGap ? "border-amber-300 bg-amber-50 text-amber-700 hover:border-sky-400" : "border-slate-200 bg-white text-slate-400 hover:border-sky-300"}`}>
                                🔙 {t("забрати")}{c.pickupGap && !onP ? " ⚠️" : ""}
                              </button>
                              {(others.length > 0 || othersP.length > 0) && (
                                <div className="mt-0.5 truncate text-[10px] text-slate-400"
                                  title={[...others.map(o => o.name), ...othersP.map(o => `🔙 ${o.name}`)].join(", ")}>
                                  +{[...others.map(o => o.name), ...othersP.map(o => `🔙${o.name}`)].join(", ")}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}</div>}

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-3">
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} disabled={!driver.telegramId} />
            {t("Сповістити водія")} {!driver.telegramId && <span className="text-xs text-slate-400">{t("(немає Telegram)")}</span>}
          </label>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty && !save.isPending}>
              <Send className="h-4 w-4" /> {t("Зберегти")} ({sel.size})
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

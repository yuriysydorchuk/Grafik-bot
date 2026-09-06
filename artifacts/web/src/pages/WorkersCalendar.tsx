// «Календар працівників» (/workers-calendar, модуль «Задачі», батч 4): усі дати по людях в
// одному місці — строки документів, кінець умов, обовʼязки легалізації, відпрошування, дні
// народження, початок/кінець роботи на фабриці, відкриті задачі з привʼязкою.
// Три види: Місяць (сітка + панель дня), Таймлайн (люди × дні, 6 тижнів), Рік (теплокарта).
// Клік на подію → картка з переходами і «Створити задачу» з предзаповненням.
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, CalendarDays, Plus, ExternalLink, X } from "lucide-react";
import { get, type Factory } from "../lib/api";
import { type CalEvent, type CalKind, CAL_KINDS, CAL_KIND_LABEL, CAL_KIND_CLS, CAL_KIND_DOT, fmtD, fmtDShort, todayStr, addDays, weekdayIdx, DAY_SHORT, MONTHS_GEN } from "../lib/tasksApi";
import { NewTaskModal, useOpenTask } from "../components/TaskBits";
import { Button, Select, Input, Modal, cn } from "../components/ui";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";
import { canAccessPage } from "../lib/roles";

type View = "month" | "timeline" | "year";
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthStart = (d: string) => d.slice(0, 7) + "-01";
const addMonths = (d: string, n: number) => { const x = new Date(d.slice(0, 7) + "-01T00:00:00"); x.setMonth(x.getMonth() + n); return x.toLocaleDateString("sv-SE"); };
const daysInMonth = (d: string) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0).getDate();

function useEvents(from: string, to: string, factoryId: string, kinds: Set<CalKind>) {
  const kindsKey = CAL_KINDS.filter(k => kinds.has(k)).join(",");
  return useQuery<{ events: CalEvent[] }>({
    queryKey: ["workers-calendar", from, to, factoryId, kindsKey],
    queryFn: () => get(`/workers-calendar?from=${from}&to=${to}${factoryId ? `&factoryId=${factoryId}` : ""}${kindsKey && kinds.size < CAL_KINDS.length ? `&kinds=${kindsKey}` : ""}`),
    placeholderData: prev => prev,
  });
}

export default function WorkersCalendar() {
  const t = useT();
  const me = useMe();
  const [loc] = useLocation();
  const initialWorker = useMemo(() => { const m = (typeof window !== "undefined" ? window.location.search : "").match(/worker=(\d+)/); return m ? Number(m[1]) : null; }, [loc]);
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(todayStr());
  const [factoryId, setFactoryId] = useState("");
  const [kinds, setKinds] = useState<Set<CalKind>>(new Set(CAL_KINDS));
  const [q, setQ] = useState("");
  const [workerFilter, setWorkerFilter] = useState<number | null>(initialWorker);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [openEvent, setOpenEvent] = useState<CalEvent | null>(null);
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const today = todayStr();

  // діапазон запиту залежить від виду
  const range = useMemo(() => {
    if (view === "year") return { from: cursor.slice(0, 4) + "-01-01", to: cursor.slice(0, 4) + "-12-31" };
    if (view === "timeline") { const from = addDays(cursor, -weekdayIdx(cursor)); return { from, to: addDays(from, 41) }; }
    const ms = monthStart(cursor); const gridFrom = addDays(ms, -weekdayIdx(ms)); return { from: gridFrom, to: addDays(gridFrom, 41) };
  }, [view, cursor]);
  const { data, isFetching } = useEvents(range.from, range.to, factoryId, kinds);
  const events = useMemo(() => {
    let list = data?.events ?? [];
    if (workerFilter) list = list.filter(e => e.workerId === workerFilter);
    if (q.trim()) { const s = q.trim().toLowerCase(); list = list.filter(e => e.workerName.toLowerCase().includes(s) || e.title.toLowerCase().includes(s)); }
    return list;
  }, [data, q, workerFilter]);
  const byDay = useMemo(() => { const m = new Map<string, CalEvent[]>(); for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date)!.push(e); } return m; }, [events]);

  const shift = (n: number) => setCursor(view === "year" ? addMonths(cursor, 12 * n) : view === "timeline" ? addDays(cursor, 7 * n) : addMonths(cursor, n));
  const toggleKind = (k: CalKind) => setKinds(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const title = view === "year" ? cursor.slice(0, 4) : view === "timeline" ? `${fmtD(range.from)} – ${fmtD(range.to)}` : `${MONTHS[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(0, 4)}`;
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const e of events) c[e.kind] = (c[e.kind] ?? 0) + 1; return c; }, [events]);
  const workerName = workerFilter ? events.find(e => e.workerId === workerFilter)?.workerName ?? `#${workerFilter}` : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("Календар працівників")}</h1>
          <p className="text-sm text-slate-500">{t("строки документів, умови, обовʼязки, відпрошування, дні народження, задачі")} {isFetching && <span className="text-slate-300">…</span>}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {(["month", "timeline", "year"] as View[]).map(v => <button key={v} onClick={() => setView(v)} className={cn("rounded-md px-3 py-1.5", view === v ? "bg-white font-semibold text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>{t(v === "month" ? "Місяць" : v === "timeline" ? "Таймлайн" : "Рік")}</button>)}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button onClick={() => shift(-1)} className="rounded-lg border border-slate-200 bg-white p-2 hover:bg-slate-50"><ChevronLeft className="h-4 w-4" /></button>
          <Button variant="secondary" onClick={() => setCursor(today)}>{t("сьогодні")}</Button>
          <button onClick={() => shift(1)} className="rounded-lg border border-slate-200 bg-white p-2 hover:bg-slate-50"><ChevronRight className="h-4 w-4" /></button>
          <span className="ml-2 text-lg font-semibold text-slate-800">{title}</span>
        </div>
        <Select value={factoryId} onChange={e => setFactoryId(e.target.value)} className="w-52">
          <option value="">{t("Фабрика: усі")}</option>
          {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("пошук: працівник, подія")} className="w-56" />
        {workerName && <span className="flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">{workerName}<button onClick={() => setWorkerFilter(null)}><X className="h-3 w-3" /></button></span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CAL_KINDS.map(k => <button key={k} onClick={() => toggleKind(k)} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", kinds.has(k) ? "border-transparent " + CAL_KIND_CLS[k] : "border-slate-200 bg-white text-slate-400")}><span className={cn("h-2 w-2 rounded-full", kinds.has(k) ? CAL_KIND_DOT[k] : "bg-slate-300")} />{t(CAL_KIND_LABEL[k])}{counts[k] ? <span className="opacity-70">{counts[k]}</span> : null}</button>)}
      </div>

      {view === "month" && <MonthView cursor={cursor} gridFrom={range.from} byDay={byDay} today={today} selectedDay={selectedDay} onSelectDay={setSelectedDay} onOpen={setOpenEvent} onWorker={setWorkerFilter} />}
      {view === "timeline" && <TimelineView from={range.from} events={events} today={today} onOpen={setOpenEvent} />}
      {view === "year" && <YearView year={cursor.slice(0, 4)} byDay={byDay} today={today} onPick={(d) => { setCursor(d); setSelectedDay(d); setView("month"); }} />}

      {openEvent && <EventModal ev={openEvent} onClose={() => setOpenEvent(null)} canTasks={!!me && canAccessPage(me, "/tasks")} />}
    </div>
  );
}

function EventChip({ e, onClick, showWorker = true }: { e: CalEvent; onClick: () => void; showWorker?: boolean }) {
  return (
    <button onClick={onClick} title={`${e.workerName} · ${e.title}`} className={cn("block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] leading-4", CAL_KIND_CLS[e.kind], e.severity === "danger" && "ring-1 ring-rose-400")}>
      {showWorker ? <><span className="font-medium">{e.workerName.split(" ").slice(0, 2).join(" ")}</span> · {e.title}</> : e.title}
    </button>
  );
}

function MonthView({ cursor, gridFrom, byDay, today, selectedDay, onSelectDay, onOpen, onWorker }: { cursor: string; gridFrom: string; byDay: Map<string, CalEvent[]>; today: string; selectedDay: string | null; onSelectDay: (d: string | null) => void; onOpen: (e: CalEvent) => void; onWorker: (id: number) => void }) {
  const t = useT();
  const month = cursor.slice(0, 7);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridFrom, i));
  const sel = selectedDay ? byDay.get(selectedDay) ?? [] : [];
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{DAY_SHORT.map(d => <div key={d} className="px-2 py-1.5">{d}</div>)}</div>
        <div className="grid grid-cols-7">
          {days.map(d => {
            const list = byDay.get(d) ?? [];
            const inMonth = d.slice(0, 7) === month;
            return (
              <div key={d} onClick={() => onSelectDay(d === selectedDay ? null : d)} className={cn("min-h-[6.5rem] cursor-pointer border-b border-r border-slate-100 p-1", !inMonth && "bg-slate-50/60", d === selectedDay && "bg-red-50/40", d === today && "ring-2 ring-inset ring-red-500")}>
                <div className={cn("mb-0.5 px-1 text-xs", d === today ? "font-bold text-red-600" : inMonth ? "text-slate-600" : "text-slate-300")}>{Number(d.slice(8, 10))}{list.length > 0 && <span className="ml-1 text-[10px] text-slate-400">·{list.length}</span>}</div>
                <div className="space-y-0.5">
                  {list.slice(0, 4).map(e => <EventChip key={e.id} e={e} onClick={() => onOpen(e)} />)}
                  {list.length > 4 && <div className="px-1 text-[10px] text-slate-400">+{list.length - 4}</div>}
                </div>
              </div>);
          })}
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        {!selectedDay ? <div className="py-8 text-center text-sm text-slate-400">{t("Клікни на день, щоб побачити всі події")}</div> : (
          <>
            <div className="mb-2 flex items-center justify-between"><div className="font-semibold text-slate-800">{fmtD(selectedDay)} · {DAY_SHORT[weekdayIdx(selectedDay)]}</div><span className="text-xs text-slate-400">{sel.length}</span></div>
            {!sel.length && <div className="text-sm text-slate-400">{t("подій немає")}</div>}
            <ul className="space-y-2">{sel.map(e => (
              <li key={e.id} className="rounded-lg border border-slate-100 p-2 text-sm">
                <div className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", CAL_KIND_DOT[e.kind])} /><button onClick={() => onWorker(e.workerId)} className="font-medium hover:text-red-600">{e.workerName}</button><span className="ml-auto text-[10px] text-slate-400">{t(CAL_KIND_LABEL[e.kind])}</span></div>
                <button onClick={() => onOpen(e)} className={cn("mt-1 text-left hover:text-red-600", e.severity === "danger" && "text-rose-600")}>{e.title}</button>
                {e.factoryName && <div className="text-xs text-slate-400">{e.factoryName}</div>}
              </li>))}</ul>
          </>
        )}
      </div>
    </div>
  );
}

function TimelineView({ from, events, today, onOpen }: { from: string; events: CalEvent[]; today: string; onOpen: (e: CalEvent) => void }) {
  const t = useT();
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const rows = useMemo(() => {
    const m = new Map<number, { name: string; factory: string | null; first: string; items: Map<string, CalEvent[]> }>();
    for (const e of events) {
      if (!m.has(e.workerId)) m.set(e.workerId, { name: e.workerName, factory: e.factoryName, first: e.date, items: new Map() });
      const r = m.get(e.workerId)!; if (e.date < r.first) r.first = e.date;
      if (!r.items.has(e.date)) r.items.set(e.date, []); r.items.get(e.date)!.push(e);
    }
    return [...m.entries()].sort((a, b) => a[1].first.localeCompare(b[1].first) || a[1].name.localeCompare(b[1].name, "pl"));
  }, [events]);
  if (!rows.length) return <div className="rounded-xl border border-slate-200 bg-white py-12 text-center text-sm text-slate-400">{t("У цьому діапазоні подій немає")}</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="border-collapse text-xs">
        <thead>
          <tr className="bg-slate-50 text-[10px] text-slate-400">
            <th className="sticky left-0 z-10 min-w-[12rem] border-b border-r border-slate-100 bg-slate-50 px-2 py-1 text-left font-semibold">{t("Працівник")} · {rows.length}</th>
            {days.map(d => <th key={d} className={cn("min-w-[2rem] border-b border-slate-100 px-0 py-1 text-center font-normal", d === today && "bg-red-50 font-bold text-red-600", weekdayIdx(d) >= 5 && "bg-slate-100/60", d.slice(8, 10) === "01" && "border-l-2 border-l-slate-300")}>{d.slice(8, 10) === "01" || d === from ? <div className="text-[9px] uppercase text-slate-500">{MONTHS_GEN[Number(d.slice(5, 7)) - 1].slice(0, 3)}</div> : null}{Number(d.slice(8, 10))}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([wid, r]) => (
            <tr key={wid} className="hover:bg-slate-50/60">
              <td className="sticky left-0 z-10 border-b border-r border-slate-100 bg-white px-2 py-1"><Link href={`/workers/${wid}`} className="font-medium hover:text-red-600">{r.name}</Link>{r.factory && <div className="text-[10px] text-slate-400">{r.factory}</div>}</td>
              {days.map(d => { const list = r.items.get(d) ?? []; return (
                <td key={d} className={cn("border-b border-slate-100 p-0.5 text-center align-middle", d === today && "bg-red-50/50", weekdayIdx(d) >= 5 && "bg-slate-50/60", d.slice(8, 10) === "01" && "border-l-2 border-l-slate-300")}>
                  {list.length > 0 && <div className="flex flex-wrap justify-center gap-0.5">{list.map(e => <button key={e.id} onClick={() => onOpen(e)} title={`${fmtDShort(e.date)} · ${e.title}`} className={cn("h-3.5 w-3.5 rounded-sm", CAL_KIND_DOT[e.kind], e.severity === "danger" && "ring-2 ring-rose-300")} />)}</div>}
                </td>); })}
            </tr>))}
        </tbody>
      </table>
    </div>
  );
}

function YearView({ year, byDay, today, onPick }: { year: string; byDay: Map<string, CalEvent[]>; today: string; onPick: (d: string) => void }) {
  const t = useT();
  const total = [...byDay.values()].reduce((s, l) => s + l.length, 0);
  const shade = (n: number) => n === 0 ? "bg-slate-100" : n === 1 ? "bg-red-200" : n <= 3 ? "bg-red-300" : n <= 6 ? "bg-red-400" : "bg-red-600";
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-400">{t("подій за рік")}: {total} · {t("клік по дню відкриває місяць")}</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {MONTHS.map((name, mi) => {
          const ms = `${year}-${String(mi + 1).padStart(2, "0")}-01`;
          const n = daysInMonth(ms); const pad = weekdayIdx(ms);
          const monthTotal = Array.from({ length: n }, (_, i) => byDay.get(addDays(ms, i))?.length ?? 0).reduce((a, b) => a + b, 0);
          return (
            <div key={ms} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between text-sm"><span className="font-semibold text-slate-700">{name}</span><span className="text-xs text-slate-400">{monthTotal || ""}</span></div>
              <div className="grid grid-cols-7 gap-1">
                {DAY_SHORT.map(d => <div key={d} className="text-center text-[9px] text-slate-300">{d[0]}</div>)}
                {Array.from({ length: pad }, (_, i) => <div key={"p" + i} />)}
                {Array.from({ length: n }, (_, i) => { const d = addDays(ms, i); const c = byDay.get(d)?.length ?? 0; const danger = byDay.get(d)?.some(e => e.severity === "danger"); return <button key={d} onClick={() => onPick(d)} title={`${fmtD(d)} · ${c}`} className={cn("aspect-square rounded-sm", shade(c), d === today && "ring-2 ring-slate-800", danger && "ring-1 ring-rose-500")} />; })}
              </div>
            </div>);
        })}
      </div>
    </div>
  );
}

function EventModal({ ev, onClose, canTasks }: { ev: CalEvent; onClose: () => void; canTasks: boolean }) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const { setOpenId, drawer } = useOpenTask();
  const today = todayStr();
  const due = ev.date < today ? today : addDays(ev.date, -7) < today ? today : addDays(ev.date, -7);
  return (
    <Modal open onClose={onClose} title={t(CAL_KIND_LABEL[ev.kind])}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2"><span className={cn("h-2.5 w-2.5 rounded-full", CAL_KIND_DOT[ev.kind])} /><span className={cn("text-lg font-semibold", ev.severity === "danger" ? "text-rose-600" : "text-slate-900")}>{ev.title}</span></div>
        <div className="grid grid-cols-[7rem_1fr] gap-y-1 text-slate-600">
          <span className="text-slate-400">{t("Дата")}</span><span className="font-medium">{fmtD(ev.date)} · {DAY_SHORT[weekdayIdx(ev.date)]}{ev.date < today && <span className="ml-2 text-xs text-rose-600">{t("минуло")}</span>}</span>
          <span className="text-slate-400">{t("Працівник")}</span><Link href={`/workers/${ev.workerId}`} className="flex items-center gap-1 font-medium hover:text-red-600">{ev.workerName}<ExternalLink className="h-3 w-3" /></Link>
          {ev.factoryName && <><span className="text-slate-400">{t("Фабрика")}</span><span>{ev.factoryName}</span></>}
          {ev.detail && <><span className="text-slate-400">{t("Деталі")}</span><span>{ev.detail}</span></>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
          {(ev.kind === "doc" || ev.kind === "obligation" || ev.kind === "contract") && <Link href="/legalization" className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50">{t("Легалізація")}</Link>}
          {ev.taskId && canTasks && <Button variant="secondary" onClick={() => setOpenId(ev.taskId!)}>{t("Відкрити задачу")}</Button>}
          {!ev.taskId && canTasks && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {t("Створити задачу")}</Button>}
        </div>
      </div>
      {drawer}
      {creating && <NewTaskModal defaults={{ workerId: ev.workerId, factoryId: ev.factoryId ?? undefined, title: `${ev.title} — ${ev.workerName}`, dueAt: due }} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); onClose(); }} />}
    </Modal>
  );
}

export { CalendarDays as WorkersCalendarIcon };

// Сторінка «Задачі» (модуль 06.09.2026): Мій день · Дошка · Список · Календар · Контроль.
// Лише офіс. Деталі задачі — шухляда праворуч (TaskBits.TaskDrawer), створення — NewTaskModal.
import { useMemo, useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, ChevronLeft, ChevronRight, Sun, Columns3, List, CalendarDays, Gauge, CheckCircle2, Clock, Focus, Wand2, Users, Download } from "lucide-react";
import { get, post, patch, type Factory } from "../lib/api";
import {
  type TaskRow, type MyDay, type TaskAdmin, type TaskControlRow, type TaskStatus,
  STATUS_LABEL, STATUS_BADGE, PRIORITY_LABEL, PRIORITY_CLS, SOURCE_LABEL, fmtD, fmtDShort, todayStr, addDays, weekdayIdx, DAY_SHORT, MONTHS_NOM, MONTHS_GEN,
} from "../lib/tasksApi";
import { TaskCard, NewTaskModal, useOpenTask, invalidateTasks, dueLabel, Initials } from "../components/TaskBits";
import { Button, Badge, Card, Spinner, Input, Select, Modal, cn } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from "recharts";
import { useChartTheme } from "../lib/theme";
import { useT } from "../lib/i18n";
import { useMe, usePersisted } from "../lib/hooks";
import { can } from "../lib/roles";

type Tab = "myday" | "board" | "list" | "calendar" | "control";

export default function Tasks() {
  const t = useT();
  const me = useMe();
  const canManage = can(me, "tasksManage");
  const [tab, setTab] = usePersisted<Tab>("tasks.tab", "myday");
  const [adding, setAdding] = useState<null | Partial<{ kind: "task" | "group" | "meeting"; dueAt: string; dueTime: string; plannedFor: string }>>(null);
  const { setOpenId, drawer } = useOpenTask();
  // deep-link з бота: /tasks?task=<id> відкриває шухляду
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get("task")); if (id) setOpenId(id); }, []);
  const { data: counters } = useQuery<{ overdue: number; today: number; week: number; meetingsToday: number }>({ queryKey: ["task-counters"], queryFn: () => get("/tasks/counters"), refetchInterval: 60000 });
  // клавіші: N нова, T сьогодні (перемикає на Мій день)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName?.match(/INPUT|TEXTAREA|SELECT/) || e.metaKey || e.ctrlKey) return;
      if (e.key === "n" || e.key === "N") setAdding({});
      if (e.key === "t" || e.key === "T") setTab("myday");
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [setTab]);
  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "myday", label: t("Мій день"), icon: Sun }, { id: "board", label: t("Дошка"), icon: Columns3 }, { id: "list", label: t("Список"), icon: List },
    { id: "calendar", label: t("Календар"), icon: CalendarDays }, ...(canManage ? [{ id: "control" as Tab, label: t("Контроль"), icon: Gauge }] : []),
  ];
  return (
    <>
      <PageHeader title={t("Задачі")}
        subtitle={counters ? `${t("прострочено")} ${counters.overdue} · ${t("сьогодні")} ${counters.today} · ${t("тиждень")} ${counters.week}${counters.meetingsToday ? ` · 🗓 ${counters.meetingsToday}` : ""}` : undefined}
        action={<Button onClick={() => setAdding({})}><Plus className="h-4 w-4" /> {t("Нова задача")} <span className="ml-1 rounded bg-white/20 px-1 text-[10px]">N</span></Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
          {tabs.map(x => <button key={x.id} onClick={() => setTab(x.id)} className={cn("flex items-center gap-1 rounded-md px-3 py-1.5 transition", tab === x.id ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700")}><x.icon className="h-3.5 w-3.5" /> {x.label}</button>)}
        </div>
        {counters && counters.overdue > 0 && <Badge color="rose">{t("прострочено")} {counters.overdue}</Badge>}
      </div>
      {tab === "myday" && <MyDayView onOpen={setOpenId} onNew={d => setAdding(d)} />}
      {tab === "board" && <BoardView onOpen={setOpenId} />}
      {tab === "list" && <ListView onOpen={setOpenId} />}
      {tab === "calendar" && <CalendarView onOpen={setOpenId} onNew={d => setAdding(d)} />}
      {tab === "control" && canManage && <ControlView onPickAdmin={id => { localStorage.setItem("tasks.f.assignee", String(id)); localStorage.setItem("tasks.scope", "all"); setTab("list"); }} />}
      {drawer}
      {adding && <NewTaskModal defaults={adding} onClose={() => setAdding(null)} />}
    </>
  );
}

// ── фільтри (дошка + список) ────────────────────────────────────────────────
// Фільтри списку/дошки (макет: статус, пріоритет, джерело, місто, «лише прострочені»,
// групування). Виконавець запамʼятовується — з «Контролю» клік по адміну ставить його сюди.
export type GroupBy = "due" | "assignee" | "factory";
function useFilters() {
  const [scope, setScope] = usePersisted<"mine" | "all" | "created" | "watching">("tasks.scope", "mine");
  const [assignee, setAssignee] = usePersisted<string>("tasks.f.assignee", "");
  const [factoryId, setFactoryId] = useState("");
  const [city, setCity] = usePersisted<string>("tasks.f.city", "");
  const [source, setSource] = useState("");
  const [priority, setPriority] = useState("");
  const [q, setQ] = useState("");
  const [hideDone, setHideDone] = useState(true);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [groupBy, setGroupBy] = usePersisted<GroupBy>("tasks.f.group", "due");
  const qs = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams({ scope, status: hideDone ? "open" : "all", ...extra });
    if (assignee) p.set("assignee", assignee); if (factoryId) p.set("factoryId", factoryId); if (city) p.set("city", city); if (source) p.set("source", source); if (priority) p.set("priority", priority); if (q) p.set("q", q); if (overdueOnly) p.set("overdue", "1");
    return p.toString();
  };
  return { scope, setScope, assignee, setAssignee, factoryId, setFactoryId, city, setCity, source, setSource, priority, setPriority, q, setQ, hideDone, setHideDone, overdueOnly, setOverdueOnly, groupBy, setGroupBy, qs };
}
function FilterBar({ f, withGroup = false }: { f: ReturnType<typeof useFilters>; withGroup?: boolean }) {
  const t = useT();
  const { data: admins = [] } = useQuery<TaskAdmin[]>({ queryKey: ["task-admins"], queryFn: () => get("/tasks/admins") });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const cities = useMemo(() => [...new Set(factories.map(x => (x as any).city).filter(Boolean))].sort() as string[], [factories]);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      <div className="flex gap-1">
        {([["mine", t("Мої")], ["all", t("Усі")], ["created", t("Я автор")], ["watching", t("Спостерігаю")]] as const).map(([k, l]) => <button key={k} onClick={() => f.setScope(k)} className={cn("rounded-full border px-2.5 py-1 font-semibold", f.scope === k ? "border-red-600 bg-red-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}>{l}</button>)}
      </div>
      <Input value={f.q} onChange={e => f.setQ(e.target.value)} placeholder={t("пошук: назва, працівник")} className="h-8 w-48 py-1 text-xs" />
      <Select value={f.assignee} onChange={e => f.setAssignee(e.target.value)} className="h-8 w-auto py-1 text-xs"><option value="">{t("Виконавець: усі")}</option>{admins.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
      <Select value={f.factoryId} onChange={e => f.setFactoryId(e.target.value)} className="h-8 w-auto py-1 text-xs"><option value="">{t("Фабрика: усі")}</option>{factories.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
      <Select value={f.source} onChange={e => f.setSource(e.target.value)} className="h-8 w-auto py-1 text-xs"><option value="">{t("Джерело: усі")}</option><option value="manual">{t("ручні")}</option><option value="auto">{t("автозадачі")}</option>{Object.entries(SOURCE_LABEL).filter(([k]) => k.startsWith("auto:")).map(([k, l]) => <option key={k} value={k.slice(5)}>{t(l)}</option>)}</Select>
      <Select value={f.priority} onChange={e => f.setPriority(e.target.value)} className="h-8 w-auto py-1 text-xs"><option value="">{t("Пріоритет: усі")}</option>{(["urgent", "high", "normal", "low"] as const).map(p => <option key={p} value={p}>{t(PRIORITY_LABEL[p])}</option>)}</Select>
      {cities.length > 0 && <Select value={f.city} onChange={e => f.setCity(e.target.value)} className="h-8 w-auto py-1 text-xs"><option value="">{t("Місто: усі")}</option>{cities.map(c => <option key={c} value={c}>{c}</option>)}</Select>}
      <label className="flex items-center gap-1 text-slate-600"><input type="checkbox" checked={f.overdueOnly} onChange={e => f.setOverdueOnly(e.target.checked)} /> {t("лише прострочені")}</label>
      <label className="flex items-center gap-1 text-slate-600"><input type="checkbox" checked={f.hideDone} onChange={e => f.setHideDone(e.target.checked)} /> {t("ховати виконані")}</label>
      {withGroup && <Select value={f.groupBy} onChange={e => f.setGroupBy(e.target.value as GroupBy)} className="h-8 w-auto py-1 text-xs"><option value="due">{t("Групувати: за строком")}</option><option value="assignee">{t("Групувати: за виконавцем")}</option><option value="factory">{t("Групувати: за фабрикою")}</option></Select>}
    </div>
  );
}

// ── Дошка ───────────────────────────────────────────────────────────────────
const COLS: { key: "open" | "in_progress" | "review" | "done"; label: string; cls: string }[] = [
  { key: "open", label: "Нові", cls: "bg-slate-50" }, { key: "in_progress", label: "В роботі", cls: "bg-sky-50/60" }, { key: "review", label: "На перевірці", cls: "bg-amber-50/60" }, { key: "done", label: "Виконано · тиждень", cls: "bg-emerald-50/60" },
];
function BoardView({ onOpen }: { onOpen: (id: number) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const f = useFilters();
  const { data: rows = [], isLoading } = useQuery<TaskRow[]>({ queryKey: ["tasks", "board", f.qs({ status: "all" })], queryFn: () => get(`/tasks?${f.qs({ status: "all" })}`) });
  const [dragId, setDragId] = useState<number | null>(null);
  const move = useMutation({ mutationFn: (v: { id: number; status: string }) => post(`/tasks/${v.id}/status`, { status: v.status }), onSuccess: () => invalidateTasks(qc), onError: (e: any) => toast.error(e.message) });
  const weekAgo = addDays(todayStr(), -7);
  const byCol = useMemo(() => {
    const m: Record<string, TaskRow[]> = { open: [], in_progress: [], review: [], done: [] };
    for (const r of rows) {
      if (r.status === "done" || r.status === "auto_resolved") { if (!f.hideDone || (r.completedAt && r.completedAt.slice(0, 10) >= weekAgo)) m.done!.push(r); }
      else if (m[r.status]) m[r.status]!.push(r);
    }
    return m;
  }, [rows, f.hideDone, weekAgo]);
  const drop = (col: string) => { const id = dragId; setDragId(null); if (id == null) return; const r = rows.find(x => x.id === id); if (!r || r.status === col) return; if (col === "review") return; move.mutate({ id, status: col === "done" ? "done" : col }); };
  return (
    <>
      <FilterBar f={f} />
      {isLoading ? <Spinner /> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {COLS.map(c => (
            <div key={c.key} onDragOver={e => e.preventDefault()} onDrop={() => drop(c.key)} className={cn("min-h-[12rem] rounded-xl p-2", c.cls)}>
              <div className="mb-2 flex items-center justify-between px-1"><b className="text-[11px] uppercase tracking-wide text-slate-500">{t(c.label)}</b><span className="text-xs text-slate-400">{byCol[c.key]!.length}</span></div>
              <div className="space-y-2">{byCol[c.key]!.map(r => <TaskCard key={r.id} t={r} onOpen={onOpen} draggable onDragStart={() => setDragId(r.id)} />)}</div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-slate-400">{t("Перетягни картку в іншу колонку, щоб змінити статус. «На перевірці» ставиться сама, коли виконавець позначає «зроблено» в задачі з контролем автора.")}</p>
    </>
  );
}

// ── Список ──────────────────────────────────────────────────────────────────
function ListView({ onOpen }: { onOpen: (id: number) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const f = useFilters();
  const { data: rows = [], isLoading } = useQuery<TaskRow[]>({ queryKey: ["tasks", "list", f.qs()], queryFn: () => get(`/tasks?${f.qs()}`) });
  const { data: admins = [] } = useQuery<TaskAdmin[]>({ queryKey: ["task-admins"], queryFn: () => get("/tasks/admins") });
  const [sel, setSel] = useState<Set<number>>(new Set());
  const bulk = useMutation({ mutationFn: (v: Record<string, unknown>) => post("/tasks/bulk", { ids: [...sel], ...v }), onSuccess: () => { invalidateTasks(qc); setSel(new Set()); toast.success(t("Готово")); }, onError: (e: any) => toast.error(e.message) });
  const quick = useMutation({ mutationFn: (v: { id: number; action: "done" | "snooze" }) => v.action === "done" ? post(`/tasks/${v.id}/status`, { status: "done" }) : post(`/tasks/${v.id}/snooze`, { days: 1 }), onSuccess: () => invalidateTasks(qc), onError: (e: any) => toast.error(e.message) });
  const today = todayStr(), weekEnd = addDays(today, 6);
  const groups = useMemo(() => {
    if (f.groupBy !== "due") {
      const m = new Map<string, TaskRow[]>();
      for (const r of rows) { const k = f.groupBy === "assignee" ? (r.assigneeName ?? (r.assignees.length ? r.assignees.map(a => a.name).join(", ") : t("без виконавця"))) : (r.factoryName ?? t("без фабрики")); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "uk")).map(([k, list]) => ({ key: k, label: k, cls: "text-slate-600", rows: list.sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9")) }));
    }
    const g: { key: string; label: string; cls: string; rows: TaskRow[] }[] = [
      { key: "overdue", label: t("Прострочено"), cls: "text-rose-600", rows: [] }, { key: "today", label: t("Сьогодні"), cls: "text-amber-600", rows: [] },
      { key: "week", label: t("Цього тижня"), cls: "text-slate-500", rows: [] }, { key: "later", label: t("Пізніше"), cls: "text-slate-400", rows: [] }, { key: "nodue", label: t("Без строку"), cls: "text-slate-400", rows: [] }, { key: "closed", label: t("Закриті"), cls: "text-emerald-600", rows: [] },
    ];
    for (const r of rows) {
      const closed = !["open", "in_progress", "review"].includes(r.status);
      const k = closed ? "closed" : !r.dueAt ? "nodue" : r.dueAt < today ? "overdue" : r.dueAt === today ? "today" : r.dueAt <= weekEnd ? "week" : "later";
      g.find(x => x.key === k)!.rows.push(r);
    }
    return g.filter(x => x.rows.length);
  }, [rows, today, weekEnd, t, f.groupBy]);
  const toggle = (id: number) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1"><FilterBar f={f} withGroup /></div>
        <a href={`/api/tasks/export.xlsx?${f.qs()}`} className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"><Download className="mr-1 inline h-3.5 w-3.5" />{t("Експорт Excel")}</a>
      </div>
      {isLoading ? <Spinner /> : !rows.length ? <Card className="p-6 text-center text-sm text-slate-400">{t("Задач немає")}</Card> : (
        <Card className="overflow-x-auto">
          {groups.map(g => (
            <div key={g.key}>
              <div className={cn("bg-slate-50 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider", g.cls)}>{g.label} · {g.rows.length}</div>
              <table className="w-full text-sm">
                <tbody>
                  {g.rows.map(r => {
                    const due = dueLabel(r, t);
                    return (
                      <tr key={r.id} className={cn("border-b border-slate-50 hover:bg-slate-50", r.overdue && "bg-rose-50/30")}>
                        <td className="w-8 px-3 py-2"><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                        <td className="px-2 py-2"><button onClick={() => onOpen(r.id)} className="text-left font-semibold text-slate-800 hover:text-red-600">{r.kind === "meeting" ? "🗓 " : r.kind === "group" ? "👥 " : ""}{r.title}</button>{r.recurrence && <span className="ml-1 text-slate-400">🔁</span>}<span className={cn("ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", PRIORITY_CLS[r.priority])}>{t(PRIORITY_LABEL[r.priority])}</span></td>
                        <td className="px-2 py-2 text-xs text-slate-500">{r.worker?.fullName}{r.worker && r.factoryName ? " · " : ""}{r.factoryName}</td>
                        <td className="px-2 py-2"><span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-semibold", r.source === "manual" ? "bg-sky-50 text-sky-700" : "bg-violet-50 text-violet-700")}>{t(SOURCE_LABEL[r.source] ?? r.source)}</span></td>
                        <td className="px-2 py-2 text-xs">{r.kind === "task" ? r.assigneeName : <span className="flex -space-x-1">{r.assignees.slice(0, 4).map(a => <Initials key={a.adminId} name={a.name} />)}</span>}</td>
                        <td className={cn("px-2 py-2 text-xs tabular-nums", due.cls)}>{due.text}</td>
                        <td className="px-2 py-2"><Badge color={STATUS_BADGE[r.status]}>{t(STATUS_LABEL[r.status])}{r.checklistTotal ? ` · ${r.checklistDone}/${r.checklistTotal}` : ""}</Badge></td>
                        <td className="px-2 py-2 text-right text-slate-400">
                          {["open", "in_progress"].includes(r.status) && r.kind !== "meeting" && <>
                            <button onClick={() => quick.mutate({ id: r.id, action: "done" })} className="rounded p-1 hover:bg-emerald-50 hover:text-emerald-600" title={t("Виконано")}><CheckCircle2 className="h-4 w-4" /></button>
                            <button onClick={() => quick.mutate({ id: r.id, action: "snooze" })} className="rounded p-1 hover:bg-amber-50 hover:text-amber-600" title={t("Відкласти на завтра")}><Clock className="h-4 w-4" /></button>
                          </>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </Card>
      )}
      {sel.size > 0 && (
        <div className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-slate-800 px-3 py-2 text-xs text-white shadow-xl">
          <span className="font-semibold">{t("Вибрано")} {sel.size}</span>
          <select onChange={e => { if (e.target.value) bulk.mutate({ action: "assign", assigneeAdminId: Number(e.target.value) }); }} className="rounded bg-slate-700 px-2 py-1" defaultValue=""><option value="">{t("Призначити…")}</option>{admins.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <input type="date" onChange={e => { if (e.target.value) bulk.mutate({ action: "due", date: e.target.value }); }} className="rounded bg-slate-700 px-2 py-1" title={t("Перенести строк")} />
          <button onClick={() => bulk.mutate({ action: "plan_today" })} className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600">{t("У мій день")}</button>
          <button onClick={() => bulk.mutate({ action: "done" })} className="rounded bg-emerald-600 px-2 py-1 hover:bg-emerald-500">{t("Виконано")}</button>
          <button onClick={() => setSel(new Set())} className="px-1 text-slate-400">✕</button>
        </div>
      )}
    </>
  );
}

// ── Мій день ────────────────────────────────────────────────────────────────
const HOURS = Array.from({ length: 11 }, (_, i) => 8 + i); // 08:00–18:00
function MyDayView({ onOpen, onNew }: { onOpen: (id: number) => void; onNew: (d: { dueAt?: string; dueTime?: string; plannedFor?: string; kind?: "task" }) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayStr());
  const { data: d, isLoading } = useQuery<MyDay>({ queryKey: ["my-day", date], queryFn: () => get(`/tasks/my-day?date=${date}`), refetchInterval: 60000 });
  const stripFrom = addDays(date, -2);
  const { data: strip = [] } = useQuery<TaskRow[]>({ queryKey: ["tasks-calendar", "mine", stripFrom], queryFn: () => get(`/tasks/calendar?from=${stripFrom}&to=${addDays(stripFrom, 6)}`) });
  const plan = useMutation({ mutationFn: (v: { id: number; date: string | null; time?: string | null }) => post(`/tasks/${v.id}/plan`, { date: v.date, time: v.time ?? null }), onSuccess: () => invalidateTasks(qc), onError: (e: any) => toast.error(e.message) });
  const status = useMutation({ mutationFn: (v: { id: number; status: string }) => post(`/tasks/${v.id}/status`, { status: v.status }), onSuccess: () => invalidateTasks(qc), onError: (e: any) => toast.error(e.message) });
  const bulk = useMutation({ mutationFn: (v: { ids: number[]; action: string }) => post("/tasks/bulk", v), onSuccess: () => invalidateTasks(qc), onError: (e: any) => toast.error(e.message) });
  const [dragId, setDragId] = useState<number | null>(null);
  const [planning, setPlanning] = useState(false);
  const [focus, setFocus] = useState(false);
  const [showAllNew, setShowAllNew] = useState(false);
  const [quick, setQuick] = useState("");
  const isToday = date === todayStr();
  const leftToday = useMemo(() => [...(d?.overdue ?? []), ...(d?.today ?? [])].filter((x, i, a) => x.kind !== "meeting" && !["done", "cancelled", "auto_resolved"].includes(x.status) && a.findIndex(y => y.id === x.id) === i), [d]);
  const nextMonday = addDays(date, 7 - weekdayIdx(date));
  const bulkPlan = useMutation({ mutationFn: (v: { ids: number[]; action: string; date?: string }) => post("/tasks/bulk", v), onSuccess: () => { invalidateTasks(qc); toast.success(t("Перенесено")); }, onError: (e: any) => toast.error(e.message) });

  // швидке додавання: «завтра 10:00 подзвонити …» / «12.09 …» / «сьогодні …»
  const quickAdd = useMutation({
    mutationFn: () => {
      let s = quick.trim(); let dueAt = date; let dueTime: string | null = null;
      const m1 = s.match(/^(сьогодні|завтра|післязавтра)\s+/i); if (m1) { dueAt = m1[1]!.toLowerCase() === "завтра" ? addDays(todayStr(), 1) : m1[1]!.toLowerCase() === "післязавтра" ? addDays(todayStr(), 2) : todayStr(); s = s.slice(m1[0].length); }
      const m2 = s.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?\s+/); if (m2) { const y = m2[3] ?? todayStr().slice(0, 4); dueAt = `${y}-${m2[2]!.padStart(2, "0")}-${m2[1]!.padStart(2, "0")}`; s = s.slice(m2[0].length); }
      const m3 = s.match(/^(\d{1,2}):(\d{2})\s+/); if (m3) { dueTime = `${m3[1]!.padStart(2, "0")}:${m3[2]}`; s = s.slice(m3[0].length); }
      return post<TaskRow>("/tasks", { title: s || quick, dueAt, dueTime, plannedFor: dueAt === date ? date : null, notify: false });
    },
    onSuccess: () => { setQuick(""); invalidateTasks(qc); }, onError: (e: any) => toast.error(e.message),
  });
  const timelineItems = useMemo(() => {
    if (!d) return [];
    const items: { t: TaskRow; time: string; min: number }[] = [];
    for (const m of d.meetings) if (m.dueTime) items.push({ t: m, time: m.dueTime, min: m.durationMin ?? 30 });
    for (const p of d.planned) if (p.plannedTime && p.kind !== "meeting") items.push({ t: p, time: p.plannedTime, min: p.durationMin ?? 30 });
    return items.sort((a, b) => a.time.localeCompare(b.time));
  }, [d]);
  const busyHours = new Set(timelineItems.flatMap(i => { const h = Number(i.time.slice(0, 2)); const n = Math.max(1, Math.ceil(i.min / 60)); return Array.from({ length: n }, (_, k) => h + k); }));
  const nowH = new Date().getHours(), nowM = new Date().getMinutes();
  const dropOnHour = (h: number) => { const id = dragId; setDragId(null); if (id == null) return; plan.mutate({ id, date, time: `${String(h).padStart(2, "0")}:00` }); };
  // «Розкласти по годинах»: вибрані на сьогодні без часу — у вільні вікна за пріоритетом
  const autoPlace = () => {
    if (!d) return;
    const free = HOURS.filter(h => !busyHours.has(h) && h !== 12 && (!isToday || h > nowH));
    const order: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    const todo = [...d.overdue, ...d.today].filter(x => x.kind !== "meeting" && !x.plannedTime).sort((a, b) => order[a.priority]! - order[b.priority]! || (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
    let i = 0;
    for (const x of todo) { if (i >= free.length) break; plan.mutate({ id: x.id, date, time: `${String(free[i]).padStart(2, "0")}:00` }); i += Math.max(1, Math.ceil((x.durationMin ?? 30) / 60)); }
    if (!todo.length) toast(t("Нічого розкладати — усе вже на місці"));
  };
  const plannedMin = d ? d.stats.plannedMin : 0;
  const freeMin = Math.max(0, (HOURS.length - 1) * 60 - plannedMin);
  const ring = d && d.stats.total ? Math.round((d.stats.done / d.stats.total) * 100) : 0;
  const hdr = (x: TaskRow) => { const due = dueLabel(x, t); return <span className={cn("text-[11px]", due.cls)}>{due.text}</span>; };

  return (
    <div className="space-y-3">
      {/* стрічка днів */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        <button onClick={() => setDate(addDays(date, -7))} className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500"><ChevronLeft className="h-4 w-4" /></button>
        {Array.from({ length: 7 }, (_, i) => addDays(stripFrom, i)).map(day => {
          const items = strip.filter(x => x.dueAt === day || (x.plannedFor === day));
          const sel = day === date;
          return (
            <button key={day} onClick={() => setDate(day)} className={cn("min-w-[5.5rem] shrink-0 rounded-xl border px-3 py-1.5 text-center", sel ? "border-red-600 bg-red-50" : "border-slate-200 bg-white hover:bg-slate-50")}>
              <div className={cn("text-[10px]", day === todayStr() ? "font-semibold text-red-600" : "text-slate-400")}>{day === todayStr() ? t("Сьогодні") : DAY_SHORT[weekdayIdx(day)]}</div>
              <div className="text-sm font-bold text-slate-800">{Number(day.slice(8, 10))}</div>
              <div className="mt-0.5 flex justify-center gap-0.5">{items.slice(0, 6).map(x => <span key={x.id} className={cn("h-1.5 w-1.5 rounded-full", x.status === "done" ? "bg-emerald-400" : x.kind === "meeting" ? "bg-indigo-500" : x.overdue ? "bg-rose-500" : x.source === "manual" ? "bg-sky-500" : "bg-violet-500")} />)}</div>
            </button>
          );
        })}
        <button onClick={() => setDate(addDays(date, 7))} className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500"><ChevronRight className="h-4 w-4" /></button>
        {!isToday && <button onClick={() => setDate(todayStr())} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600">{t("сьогодні")} (T)</button>}
        <div className="ml-auto flex gap-1.5">
          <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setPlanning(true)}><Wand2 className="h-3.5 w-3.5" /> {t("Спланувати день")}</Button>
          <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={autoPlace}>{t("Розкласти по годинах")}</Button>
          <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setFocus(true)} disabled={!d || !d.today.length && !d.overdue.length}><Focus className="h-3.5 w-3.5" /> {t("Фокус")}</Button>
        </div>
      </div>
      <Input value={quick} onChange={e => setQuick(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && quick.trim()) quickAdd.mutate(); }} placeholder={`＋ ${t("Швидко: «завтра 10:00 подзвонити в urząd» · Enter")}`} />
      {isLoading || !d ? <Spinner /> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          {/* розклад дня */}
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs"><b>{t("Розклад дня")} · {fmtD(date)}</b><span className="text-slate-400">{t("перетягни задачу справа на вільну годину")}</span></div>
            <div className="grid" style={{ gridTemplateColumns: "3.5rem 1fr" }}>
              {HOURS.map(h => {
                const its = timelineItems.filter(i => Number(i.time.slice(0, 2)) === h);
                const now = isToday && h === nowH;
                return (
                  <div key={h} className="contents">
                    <div className={cn("border-b border-slate-50 py-1 pr-2 text-right text-[10px] text-slate-400", now && "border-red-400 font-semibold text-red-500")}>{String(h).padStart(2, "0")}:00</div>
                    <div onDragOver={e => e.preventDefault()} onDrop={() => dropOnHour(h)} onDoubleClick={() => onNew({ dueAt: date, dueTime: `${String(h).padStart(2, "0")}:00`, plannedFor: date })}
                      className={cn("relative min-h-9 border-b border-slate-50 px-1 py-0.5", now && "border-red-400", !its.length && h !== 12 && "bg-emerald-50/40")}>
                      {now && <div className="absolute left-0 right-0 border-t border-red-400" style={{ top: `${(nowM / 60) * 100}%` }} />}
                      {h === 12 && !its.length && <span className="text-[10px] text-slate-300">{t("обід")}</span>}
                      {!its.length && h !== 12 && <span className="text-[10px] text-emerald-500">{t("вільно")}</span>}
                      {its.map(i => (
                        <div key={i.t.id} onClick={() => onOpen(i.t.id)} draggable onDragStart={() => setDragId(i.t.id)}
                          className={cn("mb-0.5 cursor-pointer truncate rounded px-2 py-1 text-[11px] font-medium", i.t.kind === "meeting" ? "bg-indigo-100 text-indigo-800" : i.t.status === "done" ? "bg-emerald-100 text-emerald-800 line-through" : i.t.overdue ? "bg-rose-100 text-rose-800" : i.t.source === "manual" ? "bg-sky-100 text-sky-800" : "bg-violet-100 text-violet-800")}>
                          {i.t.kind === "meeting" ? "🗓 " : ""}{i.time} {i.t.title} · {i.min} {t("хв")}{i.t.kind !== "meeting" && i.t.status !== "done" && <button onClick={e => { e.stopPropagation(); status.mutate({ id: i.t.id, status: "done" }); }} className="ml-2 rounded bg-white/60 px-1">✓</button>}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
          {/* план */}
          <div className="space-y-3">
            {isToday && (d.stats.done > 0 || leftToday.length > 0) && (
              <Card className="border-amber-100 bg-amber-50/40 p-3">
                <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-amber-700"><span>🌇 {t("Підсумок дня")}</span><span className="font-normal normal-case text-slate-400">{t("як у боті о {time}", { time: "17:30" })}</span></div>
                <div className="text-sm">✅ {t("зроблено")} <b>{d.stats.done}</b> · {t("лишилось")} <b>{leftToday.length}</b></div>
                {leftToday.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" loading={bulkPlan.isPending} onClick={() => bulkPlan.mutate({ ids: leftToday.map(x => x.id), action: "plan_tomorrow" })}>→ {t("Усе на завтра")}</Button>
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" loading={bulkPlan.isPending} onClick={() => bulkPlan.mutate({ ids: leftToday.map(x => x.id), action: "plan_date", date: nextMonday })}>→ {t("На понеділок")}</Button>
                  </div>
                )}
              </Card>
            )}
            <Card className="p-3">
              <div className="flex items-center gap-3">
                <div className="relative h-14 w-14 shrink-0 rounded-full" style={{ background: `conic-gradient(#16a34a 0 ${ring}%, #e2e8f0 ${ring}% 100%)` }}><div className="absolute inset-1.5 flex items-center justify-center rounded-full bg-white text-xs font-bold">{d.stats.done}/{d.stats.total}</div></div>
                <div className="text-xs"><div className="text-sm font-semibold">{t("План на день")}</div><div className="text-slate-500">{t("заплановано")} {Math.floor(plannedMin / 60)} {t("год")} {plannedMin % 60} {t("хв")} · {t("вільно ще")} {Math.floor(freeMin / 60)} {t("год")}</div><div className={plannedMin > (HOURS.length - 1) * 60 ? "text-rose-600" : "text-emerald-600"}>{plannedMin > (HOURS.length - 1) * 60 ? `⚠ ${t("перевантажено")}` : `✓ ${t("реалістично")}`}</div></div>
              </div>
            </Card>
            {d.overdue.length > 0 && (
              <Card className="p-3">
                <div className="mb-1.5 flex justify-between text-[10px] font-semibold uppercase tracking-wider text-rose-600"><span>{t("Прострочено")} · {d.overdue.length}</span><button onClick={() => bulk.mutate({ ids: d.overdue.map(x => x.id), action: "plan_today" })} className="font-normal normal-case tracking-normal text-slate-400 hover:text-slate-600">{t("усі в мій день")}</button></div>
                <ul className="space-y-1.5 text-sm">{d.overdue.map(x => <PlanItem key={x.id} x={x} onOpen={onOpen} onDone={() => status.mutate({ id: x.id, status: "done" })} onDrag={() => setDragId(x.id)} sub={<>{hdr(x)}{x.rolloverCount ? <span className="ml-1 text-[11px] text-amber-600">· {t("перенесено {n} р.", { n: x.rolloverCount })}</span> : null}</>} />)}</ul>
              </Card>
            )}
            <Card className="p-3">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{t("Сьогодні")} · {d.today.length}</div>
              {!d.today.length && <div className="text-xs text-slate-400">{t("Нічого на цей день. Додай зі списку або «Спланувати день».")}</div>}
              <ul className="space-y-1.5 text-sm">
                {d.today.map(x => <PlanItem key={x.id} x={x} onOpen={onOpen} onDone={() => status.mutate({ id: x.id, status: "done" })} onDrag={() => setDragId(x.id)} sub={<span className="text-[11px] text-slate-400">{x.plannedTime ? `${x.plannedTime} · ` : ""}{x.durationMin ?? 30} {t("хв")}{x.checklistTotal ? ` · ☑ ${x.checklistDone}/${x.checklistTotal}` : ""}</span>} />)}
                {d.doneToday.map(x => <li key={x.id} className="flex items-start gap-2"><input type="checkbox" checked readOnly className="mt-1" /><button onClick={() => onOpen(x.id)} className="text-left text-slate-400 line-through">{x.title}</button></li>)}
              </ul>
            </Card>
            {d.meetings.length > 0 && (
              <Card className="p-3">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-600">{t("Зустрічі")} · {d.meetings.length}</div>
                <ul className="space-y-1 text-sm">{d.meetings.map(m => <li key={m.id}><button onClick={() => onOpen(m.id)} className="text-left hover:text-red-600">🗓 {m.dueTime} {m.title}</button> <span className="text-xs text-slate-400">· {m.assignees.filter(a => a.status === "accepted").length}/{m.assignees.length} {t("підтвердили")}</span></li>)}</ul>
              </Card>
            )}
            {d.newOvernight.length > 0 && (
              <Card className="border-violet-200 bg-violet-50/40 p-3">
                <div className="mb-1.5 flex justify-between text-[10px] font-semibold uppercase tracking-wider text-violet-700"><span>{t("Нове за ніч")} · {d.newOvernight.length}</span><button onClick={() => bulk.mutate({ ids: d.newOvernight.map(x => x.id), action: "plan_today" })} className="font-normal normal-case tracking-normal text-slate-400 hover:text-slate-600">{t("додати всі в день")}</button></div>
                <ul className="space-y-1 text-sm">{d.newOvernight.slice(0, showAllNew ? undefined : 8).map(x => <li key={x.id} className="flex items-center justify-between gap-2"><button onClick={() => onOpen(x.id)} className="truncate text-left hover:text-red-600">{x.title}{x.worker ? <span className="text-xs text-slate-400"> · {x.worker.fullName}</span> : null}</button><button onClick={() => plan.mutate({ id: x.id, date })} className="shrink-0 rounded-full border border-slate-200 bg-white px-2 text-[10px]">+ {t("в день")}</button></li>)}</ul>
                {d.newOvernight.length > 8 && <button onClick={() => setShowAllNew(v => !v)} className="mt-1 text-xs text-violet-700 hover:underline">{showAllNew ? t("згорнути") : t("показати всі {n}", { n: d.newOvernight.length })}</button>}
              </Card>
            )}
          </div>
        </div>
      )}
      {planning && d && <PlanDayModal d={d} date={date} onClose={() => setPlanning(false)} onPlan={(ids) => { bulk.mutate({ ids, action: date === todayStr() ? "plan_today" : "plan_tomorrow" }); setPlanning(false); setTimeout(autoPlace, 400); }} />}
      {focus && d && <FocusModal items={[...d.overdue, ...d.today].filter(x => x.kind !== "meeting")} onClose={() => setFocus(false)} onDone={id => status.mutate({ id, status: "done" })} onOpen={onOpen} />}
    </div>
  );
}
function PlanItem({ x, onOpen, onDone, onDrag, sub }: { x: TaskRow; onOpen: (id: number) => void; onDone: () => void; onDrag: () => void; sub: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2" draggable onDragStart={onDrag}>
      <input type="checkbox" checked={false} onChange={onDone} className="mt-1" />
      <div className="min-w-0"><button onClick={() => onOpen(x.id)} className="text-left hover:text-red-600">{x.title}{x.worker ? <span className="text-xs text-slate-400"> · {x.worker.fullName}</span> : null}</button><div>{sub}</div></div>
    </li>
  );
}
function PlanDayModal({ d, date, onClose, onPlan }: { d: MyDay; date: string; onClose: () => void; onPlan: (ids: number[]) => void }) {
  const t = useT();
  const cands = useMemo(() => [...d.overdue, ...d.today, ...d.newOvernight].filter((x, i, a) => x.kind !== "meeting" && a.findIndex(y => y.id === x.id) === i), [d]);
  const [sel, setSel] = useState<Set<number>>(new Set([...d.overdue, ...d.today].map(x => x.id)));
  const total = cands.filter(x => sel.has(x.id)).reduce((a, x) => a + (x.durationMin ?? 30), 0) + d.meetings.reduce((a, m) => a + (m.durationMin ?? 30), 0);
  const cap = (HOURS.length - 1) * 60;
  return (
    <Modal open onClose={onClose} title={`${t("Спланувати день")} · ${fmtD(date)}`}>
      <div className="space-y-2 text-sm">
        <div className="text-xs text-slate-500">{t("Що берете на цей день? Решта чекає у списку. Після вибору задачі розкладуться по вільних годинах.")}</div>
        {cands.map(x => <label key={x.id} className="flex items-center gap-2"><input type="checkbox" checked={sel.has(x.id)} onChange={() => setSel(s => { const n = new Set(s); n.has(x.id) ? n.delete(x.id) : n.add(x.id); return n; })} /><span className="flex-1 truncate">{x.title}</span><span className={cn("text-xs", x.overdue ? "text-rose-600" : "text-slate-400")}>{x.durationMin ?? 30} {t("хв")}</span></label>)}
        {!cands.length && <div className="text-xs text-slate-400">{t("Кандидатів немає")}</div>}
        <div className={cn("pt-1 text-xs", total > cap ? "text-rose-600" : "text-emerald-600")}>{t("Разом")} {Math.floor(total / 60)} {t("год")} {total % 60} {t("хв")} {t("з")} {cap / 60} {t("год")} {total > cap ? `⚠ ${t("перевантажено")}` : "✓"}</div>
        <div className="flex justify-end gap-2 pt-1"><Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button><Button onClick={() => onPlan([...sel])}>{t("Взяти в день і розкласти")}</Button></div>
      </div>
    </Modal>
  );
}
function FocusModal({ items, onClose, onDone, onOpen }: { items: TaskRow[]; onClose: () => void; onDone: (id: number) => void; onOpen: (id: number) => void }) {
  const t = useT();
  const [i, setI] = useState(0);
  const [sec, setSec] = useState(0);
  useEffect(() => { const id = setInterval(() => setSec(s => s + 1), 1000); return () => clearInterval(id); }, [i]);
  const x = items[i];
  if (!x) return <Modal open onClose={onClose} title={t("Фокус")}><div className="p-4 text-center text-sm text-emerald-600">✓ {t("Усе на сьогодні зроблено")}</div></Modal>;
  return (
    <Modal open onClose={onClose} title={`${t("Фокус")} · ${i + 1} ${t("з")} ${items.length}`}>
      <div className="space-y-3 text-center">
        <div className="text-lg font-bold">{x.title}</div>
        <div className="text-sm text-slate-500">{x.worker?.fullName}{x.worker && x.factoryName ? " · " : ""}{x.factoryName}{x.dueAt ? ` · ${t("до")} ${fmtD(x.dueAt)}` : ""}</div>
        <div className="font-mono text-3xl tabular-nums">{String(Math.floor(sec / 60)).padStart(2, "0")}:{String(sec % 60).padStart(2, "0")}</div>
        {x.checklist.length > 0 && <div className="mx-auto max-w-xs text-left text-sm">{x.checklist.map(c => <div key={c.id} className={cn(c.done && "text-slate-400 line-through")}>{c.done ? "☑" : "☐"} {c.text}</div>)}</div>}
        <div className="flex justify-center gap-2 text-xs"><Button variant="secondary" onClick={() => onOpen(x.id)}>{t("Відкрити")}</Button><Button variant="secondary" onClick={() => { setI(i + 1); setSec(0); }}>{t("Пропустити")}</Button><Button variant="success" onClick={() => { onDone(x.id); setI(i + 1); setSec(0); }}>✓ {t("Готово, наступна")}</Button></div>
      </div>
    </Modal>
  );
}

// ── Календар ────────────────────────────────────────────────────────────────
function CalendarView({ onOpen, onNew }: { onOpen: (id: number) => void; onNew: (d: { dueAt: string; dueTime?: string }) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [mode, setMode] = usePersisted<"month" | "week" | "day" | "agenda">("tasks.cal", "month");
  const [icalUrl, setIcalUrl] = useState<string | null>(null);
  const resizeRef = useRef<{ id: number; startY: number; base: number } | null>(null);
  const [scope, setScope] = usePersisted<"mine" | "team">("tasks.calscope", "mine");
  const [anchor, setAnchor] = useState(todayStr());
  const range = useMemo(() => {
    if (mode === "month") { const first = anchor.slice(0, 7) + "-01"; const start = addDays(first, -weekdayIdx(first)); return { from: start, to: addDays(start, 41) }; }
    if (mode === "week") { const start = addDays(anchor, -weekdayIdx(anchor)); return { from: start, to: addDays(start, 6) }; }
    if (mode === "day") return { from: anchor, to: anchor };
    return { from: anchor, to: addDays(anchor, 20) };
  }, [mode, anchor]);
  const { data: rows = [], isLoading } = useQuery<TaskRow[]>({ queryKey: ["tasks-calendar", scope, range.from, range.to], queryFn: () => get(`/tasks/calendar?from=${range.from}&to=${range.to}&scope=${scope}`) });
  const move = useMutation({ mutationFn: (v: { id: number; dueAt: string }) => patch(`/tasks/${v.id}`, { dueAt: v.dueAt }), onSuccess: () => invalidateTasks(qc), onError: (e: any) => toast.error(e.message) });
  const resize = useMutation({ mutationFn: (v: { id: number; durationMin: number }) => patch(`/tasks/${v.id}`, { durationMin: v.durationMin }), onSuccess: () => { invalidateTasks(qc); toast.success(t("Тривалість змінено")); }, onError: (e: any) => toast.error(e.message) });
  // стрілки ← → по періодах (не в полях вводу)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.target as HTMLElement)?.tagName?.match(/INPUT|TEXTAREA|SELECT/)) return; if (e.key === "ArrowLeft") step(-1); if (e.key === "ArrowRight") step(1); };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  });
  // розтягування зустрічі за нижній край (1 год = 2rem = 32px), крок 15 хв
  const onResizeMove = (e: React.MouseEvent) => { const r = resizeRef.current; if (!r) return; const el = document.getElementById(`cal-ev-${r.id}`); if (el) el.style.height = `${Math.max(16, (r.base + (e.clientY - r.startY) / 32 * 60) / 60 * 32)}px`; };
  const onResizeEnd = (e: React.MouseEvent) => { const r = resizeRef.current; if (!r) return; resizeRef.current = null; const mins = Math.max(15, Math.round((r.base + (e.clientY - r.startY) / 32 * 60) / 15) * 15); if (mins !== r.base) resize.mutate({ id: r.id, durationMin: mins }); };
  const days = mode === "day" ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(range.from, i));
  const [dragId, setDragId] = useState<number | null>(null);
  const byDay = useMemo(() => { const m = new Map<string, TaskRow[]>(); for (const r of rows) if (r.dueAt) (m.get(r.dueAt) ?? m.set(r.dueAt, []).get(r.dueAt)!).push(r); return m; }, [rows]);
  const step = (n: number) => setAnchor(mode === "month" ? (() => { const d = new Date(anchor.slice(0, 7) + "-15T00:00:00"); d.setMonth(d.getMonth() + n); return d.toLocaleDateString("sv-SE").slice(0, 8) + "01"; })() : addDays(anchor, n * (mode === "week" ? 7 : mode === "day" ? 1 : 14)));
  const title = mode === "month" ? `${MONTHS_NOM[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}` : mode === "day" ? `${DAY_SHORT[weekdayIdx(anchor)]} ${fmtD(anchor)}` : `${fmtDShort(range.from)} – ${fmtDShort(range.to)}`;
  const evCls = (r: TaskRow) => r.status === "done" || r.status === "auto_resolved" ? "bg-emerald-50 text-emerald-700 line-through" : r.kind === "meeting" ? "bg-indigo-50 text-indigo-700" : r.overdue ? "bg-rose-50 text-rose-700" : r.source === "manual" ? "bg-sky-50 text-sky-700" : "bg-violet-50 text-violet-700";
  const drop = (day: string) => { const id = dragId; setDragId(null); if (id == null) return; const r = rows.find(x => x.id === id); if (r && r.dueAt !== day) move.mutate({ id, dueAt: day }); };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => step(-1)} className="rounded-lg border border-slate-200 bg-white p-1.5"><ChevronLeft className="h-4 w-4" /></button>
        <button onClick={() => setAnchor(todayStr())} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">{t("сьогодні")} (T)</button>
        <button onClick={() => step(1)} className="rounded-lg border border-slate-200 bg-white p-1.5"><ChevronRight className="h-4 w-4" /></button>
        <b className="ml-1 text-sm">{title}</b>
        <div className="ml-auto flex gap-1">
          <button onClick={async () => { const r = await get<{ url: string }>("/tasks/ical-link"); setIcalUrl(r.url); }} className="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-600 hover:bg-slate-50" title={t("Підписка для Google / Apple Calendar")}>📅 {t("підписка")}</button>
          {(["month", "week", "day", "agenda"] as const).map(m => <button key={m} onClick={() => setMode(m)} className={cn("rounded-full border px-2.5 py-1 font-semibold", mode === m ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600")}>{m === "month" ? t("Місяць") : m === "week" ? t("Тиждень") : m === "day" ? t("День") : t("Розклад")}</button>)}
          <span className="mx-1 text-slate-300">|</span>
          {(["mine", "team"] as const).map(s => <button key={s} onClick={() => setScope(s)} className={cn("rounded-full border px-2.5 py-1 font-semibold", scope === s ? "border-red-600 bg-red-600 text-white" : "border-slate-200 bg-white text-slate-600")}>{s === "mine" ? t("мій") : t("команда")}</button>)}
        </div>
        <div className="flex w-full gap-3 text-[11px] text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-rose-500" />{t("прострочено")}</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-violet-500" />{t("автозадача")}</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-500" />{t("ручна")}</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-indigo-500" />{t("зустріч")}</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />{t("виконано")}</span></div>
      </div>
      {isLoading ? <Spinner /> : mode === "month" ? (
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200">
          {DAY_SHORT.map(dn => <div key={dn} className="bg-slate-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{dn}</div>)}
          {Array.from({ length: 42 }, (_, i) => addDays(range.from, i)).map(day => {
            const its = byDay.get(day) ?? []; const inMonth = day.slice(0, 7) === anchor.slice(0, 7); const isT = day === todayStr();
            return (
              <div key={day} onDragOver={e => e.preventDefault()} onDrop={() => drop(day)} onDoubleClick={() => onNew({ dueAt: day })}
                className={cn("min-h-[6rem] bg-white p-1 text-xs", !inMonth && "bg-slate-50/60 text-slate-300", isT && "outline outline-2 -outline-offset-2 outline-red-500")}>
                <div className={cn("mb-0.5 text-[11px]", isT ? "font-bold text-red-600" : "text-slate-400")}>{Number(day.slice(8, 10))}</div>
                {its.slice(0, 4).map(r => <div key={r.id} draggable onDragStart={() => setDragId(r.id)} onClick={() => onOpen(r.id)} className={cn("mb-0.5 cursor-pointer truncate rounded px-1 py-0.5 text-[10px] font-medium", evCls(r))}>{r.kind === "meeting" ? `🗓 ${r.dueTime ?? ""} ` : ""}{r.title}</div>)}
                {its.length > 4 && <div className="text-[10px] text-slate-400">+{its.length - 4}</div>}
              </div>
            );
          })}
        </div>
      ) : mode === "week" || mode === "day" ? (
        <Card className="overflow-x-auto"><div onMouseMove={onResizeMove} onMouseUp={onResizeEnd} onMouseLeave={onResizeEnd}>
          <div className={cn("grid", mode === "week" && "min-w-[52rem]")} style={{ gridTemplateColumns: `4rem repeat(${days.length}, 1fr)` }}>
            <div className="border-b border-slate-100 bg-slate-50" />
            {days.map(day => <div key={day} className={cn("border-b border-l border-slate-100 bg-slate-50 px-2 py-1 text-center text-[10px] font-semibold uppercase text-slate-400", day === todayStr() && "text-red-600")}>{DAY_SHORT[weekdayIdx(day)]} {Number(day.slice(8, 10))}</div>)}
            <div className="border-b border-slate-100 px-1 py-1 text-[10px] text-slate-400">{t("весь день")}</div>
            {days.map(day => <div key={day} onDragOver={e => e.preventDefault()} onDrop={() => drop(day)} className="min-h-10 border-b border-l border-slate-100 p-1">{(byDay.get(day) ?? []).filter(r => !r.dueTime).map(r => <div key={r.id} draggable onDragStart={() => setDragId(r.id)} onClick={() => onOpen(r.id)} className={cn("mb-0.5 cursor-pointer truncate rounded px-1 py-0.5 text-[10px] font-medium", evCls(r))}>{r.title}</div>)}</div>)}
            {HOURS.map(h => (
              <div key={h} className="contents">
                <div className="border-b border-slate-50 px-1 py-1 text-right text-[10px] text-slate-400">{String(h).padStart(2, "0")}:00</div>
                {days.map(day => <div key={day} onDoubleClick={() => onNew({ dueAt: day, dueTime: `${String(h).padStart(2, "0")}:00` })} className="relative min-h-8 border-b border-l border-slate-50 p-0.5">{(byDay.get(day) ?? []).filter(r => r.dueTime && Number(r.dueTime.slice(0, 2)) === h).map(r => <div key={r.id} id={`cal-ev-${r.id}`} onClick={() => onOpen(r.id)} style={r.kind === "meeting" && r.durationMin ? { height: `${Math.max(16, r.durationMin / 60 * 32)}px`, zIndex: 5 } : undefined} className={cn("relative mb-0.5 cursor-pointer overflow-hidden rounded px-1 py-0.5 text-[10px] font-medium", evCls(r), r.kind === "meeting" && "absolute left-0.5 right-0.5")}>{r.kind === "meeting" ? "🗓 " : ""}{r.dueTime} {r.title}{r.kind === "meeting" && r.durationMin ? ` · ${r.durationMin} ${t("хв")}` : ""}{r.kind === "meeting" && <div onMouseDown={e => { e.stopPropagation(); e.preventDefault(); resizeRef.current = { id: r.id, startY: e.clientY, base: r.durationMin ?? 45 }; }} onClick={e => e.stopPropagation()} className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize bg-indigo-300/60" title={t("потягни, щоб змінити тривалість")} />}</div>)}</div>)}
              </div>
            ))}
          </div>
        </div></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
          <MiniMonth anchor={anchor} onPick={setAnchor} marks={byDay} />
          <Card className="divide-y divide-slate-100">
            {Array.from({ length: 21 }, (_, i) => addDays(range.from, i)).filter(day => (byDay.get(day) ?? []).length).map(day => (
              <div key={day} className="flex gap-3 px-4 py-2 text-sm">
                <div className={cn("w-16 shrink-0 text-xs font-semibold", day === todayStr() ? "text-red-600" : "text-slate-600")}>{DAY_SHORT[weekdayIdx(day)]} {Number(day.slice(8, 10))}<br /><span className="font-normal text-slate-400">{day === todayStr() ? t("сьогодні") : MONTHS_GEN[Number(day.slice(5, 7)) - 1]}</span></div>
                <div className="flex-1 space-y-1">{(byDay.get(day) ?? []).map(r => <div key={r.id}><button onClick={() => onOpen(r.id)} className="text-left hover:text-red-600"><i className={cn("mr-1.5 inline-block h-2 w-2 rounded-full", r.status === "done" ? "bg-emerald-500" : r.kind === "meeting" ? "bg-indigo-500" : r.overdue ? "bg-rose-500" : r.source === "manual" ? "bg-sky-500" : "bg-violet-500")} />{r.kind === "meeting" ? `🗓 ${r.dueTime} ` : ""}{r.title}</button> <span className="text-xs text-slate-400">{r.assigneeName ?? ""}{r.worker ? ` · ${r.worker.fullName}` : ""}</span></div>)}</div>
              </div>
            ))}
            {!rows.length && <div className="p-6 text-center text-sm text-slate-400">{t("На ці три тижні нічого немає")}</div>}
          </Card>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-400">{t("Перетягни картку на інший день, щоб перенести строк. Подвійний клік по дню або годині створює задачу.")} {t("Стрілки ← → гортають період; нижній край зустрічі змінює тривалість.")}</p>
      {icalUrl && (
        <Modal open onClose={() => setIcalUrl(null)} title={t("Підписка на календар")}>
          <div className="space-y-2 text-sm">
            <p className="text-slate-600">{t("Додайте цей приватний лінк у Google Calendar («З URL») або Apple Calendar («Нова підписка»): зустрічі й строки ваших задач зʼявляться на телефоні. Лінк персональний, не пересилайте його.")}</p>
            <div className="flex gap-2"><Input readOnly value={icalUrl} onFocus={e => e.currentTarget.select()} /><Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(icalUrl); toast.success(t("Скопійовано")); }}>{t("Скопіювати")}</Button></div>
          </div>
        </Modal>
      )}
    </>
  );
}
function MiniMonth({ anchor, onPick, marks }: { anchor: string; onPick: (d: string) => void; marks: Map<string, TaskRow[]> }) {
  const first = anchor.slice(0, 7) + "-01"; const start = addDays(first, -weekdayIdx(first));
  return (
    <Card className="p-2">
      <div className="mb-1 text-center text-xs font-semibold">{MONTHS_NOM[Number(anchor.slice(5, 7)) - 1]} {anchor.slice(0, 4)}</div>
      <div className="grid grid-cols-7 gap-px text-center text-[10px]">
        {DAY_SHORT.map(d => <div key={d} className="text-slate-400">{d[0]}</div>)}
        {Array.from({ length: 42 }, (_, i) => addDays(start, i)).map(day => <button key={day} onClick={() => onPick(day)} className={cn("rounded py-0.5", day.slice(0, 7) !== anchor.slice(0, 7) && "text-slate-300", day === todayStr() && "bg-red-600 text-white", day === anchor && day !== todayStr() && "bg-slate-200")}>{Number(day.slice(8, 10))}{(marks.get(day) ?? []).length ? <span className="block h-1 w-1 mx-auto rounded-full bg-violet-500" /> : <span className="block h-1" />}</button>)}
      </div>
    </Card>
  );
}

// ── Контроль ────────────────────────────────────────────────────────────────
function ControlView({ onPickAdmin }: { onPickAdmin: (adminId: number) => void }) {
  const t = useT();
  const chart = useChartTheme();
  const [weeks, setWeeks] = useState(1);
  const { data, isLoading } = useQuery<{ from: string; to: string; admins: TaskControlRow[]; autoResolved: number; created: number; weekly: { weekStart: string; created: number; done: number }[] }>({ queryKey: ["tasks-control", weeks], queryFn: () => get(`/tasks/control?weeks=${weeks}`) });
  if (isLoading || !data) return <Spinner />;
  return (
    <Card className="overflow-x-auto">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2 text-xs"><Users className="h-4 w-4 text-slate-400" /><b>{t("Контроль")}</b><span className="text-slate-400">{fmtD(data.from)} – {fmtD(data.to)}</span>
        <select value={weeks} onChange={e => setWeeks(Number(e.target.value))} className="ml-auto rounded border border-slate-200 bg-white px-1 py-0.5">{[1, 2, 4, 8].map(w => <option key={w} value={w}>{w} {t("тижн.")}</option>)}</select></div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[10px] uppercase tracking-wide text-slate-400"><th className="px-4 py-2">{t("Адмін")}</th><th className="px-2 py-2">{t("Відкрито")}</th><th className="px-2 py-2">{t("Прострочено")}</th><th className="px-2 py-2">{t("Виконано")}</th><th className="px-2 py-2">{t("Сер. час")}</th><th className="px-2 py-2">{t("Авто / ручні")}</th></tr></thead>
        <tbody>{data.admins.map(a => <tr key={a.adminId} onClick={() => onPickAdmin(a.adminId)} title={t("Відкрити список цього адміна")} className="cursor-pointer border-t border-slate-50 hover:bg-slate-50"><td className="px-4 py-2 font-medium">{a.name} <span className="text-xs text-slate-400">{a.role}</span></td><td className="px-2 py-2">{a.open}</td><td className={cn("px-2 py-2", a.overdue && "font-semibold text-rose-600")}>{a.overdue}</td><td className="px-2 py-2">{a.done}</td><td className="px-2 py-2">{a.avgDays != null ? `${a.avgDays} ${t("дн.")}` : "—"}</td><td className="px-2 py-2 text-slate-500">{a.auto} / {a.manual}</td></tr>)}</tbody>
      </table>
      <div className="px-4 py-2 text-xs text-slate-400">{t("Авто закрилось само")}: {data.autoResolved} · {t("створено нових")}: {data.created} · {t("клік по рядку відкриває список адміна")}</div>
      {data.weekly?.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t("Створено / виконано за 8 тижнів")}</div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.weekly.map(w => ({ ...w, label: fmtDShort(w.weekStart) }))}>
                <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: chart.tick }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: chart.tick }} width={28} />
                <Tooltip contentStyle={chart.tooltip} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="created" name={t("створено")} fill="#94a3b8" radius={[3, 3, 0, 0]} />
                <Bar dataKey="done" name={t("виконано")} fill="#16a34a" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
}

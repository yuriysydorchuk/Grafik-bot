// Віджети модуля «Задачі»: плитка «Мої задачі» на Огляді, блок у профілі працівника.
import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ListTodo, Plus, CalendarDays } from "lucide-react";
import { get } from "../lib/api";
import { type MyDay, type TaskRow, type CalEvent, PRIORITY_CLS, PRIORITY_LABEL, STATUS_LABEL, STATUS_BADGE, CAL_KIND_DOT, fmtDShort, todayStr, addDays } from "../lib/tasksApi";
import { Card, Badge, Button, cn } from "./ui";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";
import { canAccessPage } from "../lib/roles";
import { NewTaskModal, useOpenTask, dueLabel } from "./TaskBits";

export function MyTasksTile() {
  const t = useT();
  const me = useMe();
  const enabled = !!me && canAccessPage(me, "/tasks");
  const { data } = useQuery<MyDay>({ queryKey: ["my-day", "tile"], queryFn: () => get("/tasks/my-day"), enabled, refetchInterval: 60000 });
  const { setOpenId, drawer } = useOpenTask();
  if (!enabled || !data) return null;
  const top = [...data.overdue, ...data.meetings, ...data.today].slice(0, 5);
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
        <ListTodo className="h-4 w-4 text-slate-400" /><h3 className="text-sm font-semibold text-slate-700">{t("Мої задачі")}</h3>
        <Link href="/tasks" className="ml-auto text-xs text-red-600 hover:underline">{t("Усі задачі")} →</Link>
      </div>
      <div className="grid gap-4 p-4 md:grid-cols-[18rem_1fr]">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-rose-50 p-2"><div className="text-xl font-bold text-rose-700">{data.counters.overdue}</div><div className="text-[9px] uppercase leading-tight tracking-wide text-rose-600">{t("прострочено")}</div></div>
          <div className="rounded-lg bg-amber-50 p-2"><div className="text-xl font-bold text-amber-700">{data.counters.today}</div><div className="text-[9px] uppercase leading-tight tracking-wide text-amber-600">{t("сьогодні")}</div></div>
          <div className="rounded-lg bg-slate-100 p-2"><div className="text-xl font-bold text-slate-700">{data.counters.week}</div><div className="text-[9px] uppercase leading-tight tracking-wide text-slate-500">{t("тиждень")}</div></div>
        </div>
        <ul className="space-y-1 text-sm">
          {!top.length && <li className="text-slate-400">{t("На сьогодні нічого — гарного дня")}</li>}
          {top.map(x => { const d = dueLabel(x, t); return <li key={x.id} className="flex items-center justify-between gap-2"><button onClick={() => setOpenId(x.id)} className="truncate text-left hover:text-red-600">{x.kind === "meeting" ? "🗓 " : ""}{x.title}{x.worker ? <span className="text-xs text-slate-400"> · {x.worker.fullName}</span> : null}</button><span className={cn("shrink-0 text-xs", d.cls)}>{d.text}</span></li>; })}
        </ul>
      </div>
      {drawer}
    </Card>
  );
}

// «Найближчі події» в профілі: строки документів/умов, обовʼязки, відпрошування, ДН — на 90 днів
// (джерело — GET /workers-calendar?workerId=). Клік на подію → нова задача з предзаповненням.
export function WorkerUpcomingEvents({ workerId, factoryId }: { workerId: number; factoryId: number | null }) {
  const t = useT();
  const me = useMe();
  const enabled = !!me && canAccessPage(me, "/workers-calendar");
  const from = todayStr(), to = addDays(from, 90);
  const { data } = useQuery<{ events: CalEvent[] }>({ queryKey: ["workers-calendar", "worker", workerId], queryFn: () => get(`/workers-calendar?from=${addDays(from, -30)}&to=${to}&workerId=${workerId}`), enabled });
  const [draft, setDraft] = useState<CalEvent | null>(null);
  const { setOpenId, drawer } = useOpenTask();
  if (!enabled) return null;
  const events = (data?.events ?? []).filter(e => e.kind !== "task" || e.date < from); // задачі показує окремий блок; лишаємо лише прострочені
  const canTasks = canAccessPage(me, "/tasks");
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-2.5">
        <CalendarDays className="h-4 w-4 text-slate-400" /><h3 className="text-sm font-semibold text-slate-700">{t("Найближчі події")}</h3>
        <span className="text-xs text-slate-400">· 90 {t("дн.")}</span>
        <Link href={`/workers-calendar?worker=${workerId}`} className="ml-auto text-xs text-slate-400 hover:text-red-600">{t("календар")} →</Link>
      </div>
      <div className="px-5 py-2 text-sm">
        {!events.length && <div className="py-1 text-slate-400">{t("Найближчі 90 днів без подій")}</div>}
        <ul className="space-y-1">{events.slice(0, 12).map(e => (
          <li key={e.id} className="flex items-center gap-2">
            <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", CAL_KIND_DOT[e.kind])} />
            <span className={cn("shrink-0 tabular-nums", e.severity === "danger" ? "font-semibold text-rose-600" : e.severity === "warn" ? "text-amber-600" : "text-slate-500")}>{fmtDShort(e.date)}</span>
            <span className="truncate">{e.title}{e.factoryName && !e.title.includes(e.factoryName) ? <span className="text-xs text-slate-400"> · {e.factoryName}</span> : null}</span>
            {canTasks && (e.taskId ? <button onClick={() => setOpenId(e.taskId!)} className="ml-auto shrink-0 text-xs text-slate-400 hover:text-red-600">{t("задача")}</button>
              : <button onClick={() => setDraft(e)} className="ml-auto shrink-0 rounded-full border border-slate-200 px-2 text-[10px] hover:border-red-300 hover:text-red-600">+ {t("задача")}</button>)}
          </li>))}</ul>
        {events.length > 12 && <div className="mt-1 text-xs text-slate-400">…{t("ще")} {events.length - 12}</div>}
      </div>
      {drawer}
      {draft && <NewTaskModal defaults={{ workerId, factoryId: draft.factoryId ?? factoryId ?? undefined, title: draft.title, dueAt: draft.date < from ? from : addDays(draft.date, -7) < from ? from : addDays(draft.date, -7) }} onClose={() => setDraft(null)} />}
    </Card>
  );
}

export function WorkerTasksBlock({ workerId, factoryId }: { workerId: number; factoryId: number | null }) {
  const t = useT();
  const me = useMe();
  const enabled = !!me && canAccessPage(me, "/tasks");
  const { data: rows = [] } = useQuery<TaskRow[]>({ queryKey: ["tasks", "worker", workerId], queryFn: () => get(`/tasks?scope=all&status=all&workerId=${workerId}`), enabled });
  const [adding, setAdding] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const { setOpenId, drawer } = useOpenTask();
  if (!enabled) return null;
  const open = rows.filter(r => ["open", "in_progress", "review"].includes(r.status));
  const closed = rows.filter(r => !["open", "in_progress", "review"].includes(r.status));
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-2.5">
        <ListTodo className="h-4 w-4 text-slate-400" /><h3 className="text-sm font-semibold text-slate-700">{t("Задачі")}</h3>
        {open.length > 0 && <Badge color="amber">{open.length}</Badge>}
        <Button variant="secondary" className="ml-auto px-2 py-1 text-xs" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> {t("задача")}</Button>
      </div>
      <div className="px-5 py-2 text-sm">
        {!open.length && <div className="py-1 text-slate-400">{t("Відкритих задач немає")}</div>}
        <ul className="space-y-1">{open.map(x => { const d = dueLabel(x, t); return <li key={x.id} className="flex items-center gap-2"><span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-semibold", PRIORITY_CLS[x.priority])}>{t(PRIORITY_LABEL[x.priority])}</span><button onClick={() => setOpenId(x.id)} className="truncate text-left hover:text-red-600">{x.title}</button><span className="ml-auto shrink-0 text-xs text-slate-400">{x.assigneeName} · <span className={d.cls}>{d.text}</span> · <Badge color={STATUS_BADGE[x.status]}>{t(STATUS_LABEL[x.status])}</Badge></span></li>; })}</ul>
        {closed.length > 0 && <div className="mt-1 text-xs text-slate-400">{t("закритих")}: {closed.length} · <button onClick={() => setShowClosed(v => !v)} className="hover:text-red-600">{showClosed ? t("сховати") : t("показати")}</button></div>}
        {showClosed && <ul className="mt-1 space-y-0.5 text-xs text-slate-500">{closed.slice(0, 20).map(x => <li key={x.id} className="flex items-center gap-2"><button onClick={() => setOpenId(x.id)} className="truncate text-left line-through hover:text-red-600">{x.title}</button><span className="ml-auto shrink-0">{x.completedAt ? new Date(x.completedAt).toLocaleDateString("uk-UA") : ""} · {t(STATUS_LABEL[x.status])}</span></li>)}</ul>}
      </div>
      {drawer}
      {adding && <NewTaskModal defaults={{ workerId, factoryId: factoryId ?? undefined }} onClose={() => setAdding(false)} />}
    </Card>
  );
}

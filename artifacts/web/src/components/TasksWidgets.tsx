// Віджети модуля «Задачі»: плитка «Мої задачі» на Огляді, блок у профілі працівника.
import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ListTodo, Plus } from "lucide-react";
import { get } from "../lib/api";
import { type MyDay, type TaskRow, PRIORITY_CLS, PRIORITY_LABEL, STATUS_LABEL, STATUS_BADGE } from "../lib/tasksApi";
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

export function WorkerTasksBlock({ workerId, factoryId }: { workerId: number; factoryId: number | null }) {
  const t = useT();
  const me = useMe();
  const enabled = !!me && canAccessPage(me, "/tasks");
  const { data: rows = [] } = useQuery<TaskRow[]>({ queryKey: ["tasks", "worker", workerId], queryFn: () => get(`/tasks?scope=all&status=all&workerId=${workerId}`), enabled });
  const [adding, setAdding] = useState(false);
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
        {closed.length > 0 && <div className="mt-1 text-xs text-slate-400">{t("закритих")}: {closed.length}</div>}
      </div>
      {drawer}
      {adding && <NewTaskModal defaults={{ workerId, factoryId: factoryId ?? undefined }} onClose={() => setAdding(false)} />}
    </Card>
  );
}

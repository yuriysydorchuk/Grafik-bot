// Спільні цеглинки модуля «Задачі»: картка, чипи, шухляда деталей, модалка створення.
// Використовуються сторінкою /tasks, дашбордом, профілем працівника.
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X, CheckCircle2, Clock, Play, RotateCcw, Ban, Users, CalendarClock, ExternalLink, Send, Repeat, MapPin, AlertTriangle, Wrench, FileText } from "lucide-react";
import { get, post, patch, upload, type Factory, type Worker } from "../lib/api";
import {
  type TaskRow, type TaskDetail, type TaskKind, type TaskPriority, type TaskAdmin, type TaskTemplate, type Recurrence, type TaskAction,
  STATUS_LABEL, STATUS_BADGE, PRIORITY_LABEL, PRIORITY_CLS, PRIORITY_BORDER, SOURCE_LABEL, KIND_LABEL, RULE_LABEL, fmtD, fmtDShort, todayStr, addDays,
} from "../lib/tasksApi";
import { ProfileChangeModal } from "./ProfileChangeModal";
import { LEGAL_LABEL, type LegalStatus } from "../lib/legalStatus";
import { reasonText } from "../lib/legality";
import { Button, Badge, Modal, Input, Select, Label, Textarea, Spinner, cn } from "./ui";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";

export const invalidateTasks = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ["tasks"] }); qc.invalidateQueries({ queryKey: ["task"] }); qc.invalidateQueries({ queryKey: ["my-day"] });
  qc.invalidateQueries({ queryKey: ["task-counters"] }); qc.invalidateQueries({ queryKey: ["tasks-calendar"] });
};

export function dueLabel(t: TaskRow, tr: (s: string, p?: any) => string): { text: string; cls: string } {
  if (!t.dueAt) return { text: tr("без строку"), cls: "text-slate-400" };
  const today = todayStr();
  if (t.status === "done" || t.status === "auto_resolved" || t.status === "cancelled") return { text: fmtDShort(t.dueAt), cls: "text-slate-400" };
  if (t.dueAt < today) { const d = Math.round((new Date(today).getTime() - new Date(t.dueAt).getTime()) / 86400000); return { text: `${fmtDShort(t.dueAt)} · −${d} ${tr("дн.")}`, cls: "text-rose-600 font-semibold" }; }
  if (t.dueAt === today) return { text: tr("сьогодні") + (t.dueTime ? ` ${t.dueTime}` : ""), cls: "text-amber-600 font-semibold" };
  if (t.dueAt === addDays(today, 1)) return { text: tr("завтра") + (t.dueTime ? ` ${t.dueTime}` : ""), cls: "text-amber-600" };
  return { text: fmtDShort(t.dueAt) + (t.dueTime ? ` ${t.dueTime}` : ""), cls: "text-slate-500" };
}

export function Initials({ name }: { name: string | null | undefined }) {
  const s = (name ?? "?").split(/\s+/).map(x => x[0]).join("").slice(0, 2).toUpperCase();
  return <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-100 px-1 text-[10px] font-semibold text-slate-600" title={name ?? ""}>{s}</span>;
}

export function TaskCard({ t, onOpen, draggable, onDragStart, compact }: { t: TaskRow; onOpen: (id: number) => void; draggable?: boolean; onDragStart?: () => void; compact?: boolean }) {
  const tr = useT();
  const due = dueLabel(t, tr);
  return (
    <div draggable={draggable} onDragStart={onDragStart} onClick={() => onOpen(t.id)}
      className={cn("cursor-pointer rounded-lg border border-slate-200 border-l-[3px] bg-white p-2.5 shadow-sm transition hover:shadow-md", PRIORITY_BORDER[t.priority], t.status === "done" && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <span className={cn("rounded-full px-1.5 py-0.5 font-semibold", PRIORITY_CLS[t.priority])}>{tr(PRIORITY_LABEL[t.priority])}</span>
        <span className={cn("rounded-full px-1.5 py-0.5 font-semibold", t.source === "manual" ? "bg-sky-50 text-sky-700" : "bg-violet-50 text-violet-700")}>{tr(SOURCE_LABEL[t.source] ?? t.source)}</span>
        {t.kind === "meeting" && <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 font-semibold text-indigo-700">🗓 {tr("зустріч")}</span>}
        {t.kind === "group" && <span className="rounded-full bg-teal-50 px-1.5 py-0.5 font-semibold text-teal-700">👥 {t.assignees.filter(a => a.status === "done").length}/{t.assignees.length}</span>}
        {t.recurrence && <Repeat className="h-3 w-3 text-slate-400" />}
      </div>
      <div className={cn("mt-1 text-sm font-semibold text-slate-800", t.status === "done" && "line-through decoration-slate-300")}>{t.title}</div>
      {!compact && (t.worker || t.factoryName) && (
        <div className="mt-0.5 truncate text-xs text-slate-500">{t.worker?.fullName}{t.worker && t.factoryName ? " · " : ""}{t.factoryName}</div>
      )}
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className={due.cls}>⏰ {due.text}{t.checklistTotal ? <span className="ml-2 text-slate-400">☑ {t.checklistDone}/{t.checklistTotal}</span> : null}</span>
        {t.kind === "task" ? <Initials name={t.assigneeName} /> : <span className="flex -space-x-1">{t.assignees.slice(0, 4).map(a => <Initials key={a.adminId} name={a.name} />)}</span>}
      </div>
    </div>
  );
}

// ── Шухляда деталей ─────────────────────────────────────────────────────────
export function TaskDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const tr = useT();
  const qc = useQueryClient();
  const me = useMe();
  const { data: t, isLoading } = useQuery<TaskDetail>({ queryKey: ["task", id], queryFn: () => get(`/tasks/${id}`) });
  const { data: admins = [] } = useQuery<TaskAdmin[]>({ queryKey: ["task-admins"], queryFn: () => get("/tasks/admins") });
  const [comment, setComment] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null);
  const [relatedOpen, setRelatedOpen] = useState<number | null>(null);
  const { data: related = [] } = useQuery<TaskRow[]>({ queryKey: ["tasks", "related", id], queryFn: () => get(`/tasks?scope=all&status=all&relatedTo=${id}`), enabled: !!t && t.kind === "meeting" });
  const [agendaTask, setAgendaTask] = useState<string | null>(null);
  const remindAll = useMutation({ mutationFn: () => post<{ reminded: number }>(`/tasks/${id}/remind`), onSuccess: r => { toast.success(tr("Нагадано: {n}", { n: r.reminded })); qc.invalidateQueries({ queryKey: ["task", id] }); }, onError: (e: any) => toast.error(e.message) });
  const [note, setNote] = useState("");
  const inv = () => invalidateTasks(qc);
  const status = useMutation({ mutationFn: (v: { status: string; note?: string }) => post(`/tasks/${id}/status`, v), onSuccess: () => { inv(); setNote(""); }, onError: (e: any) => toast.error(e.message) });
  const respond = useMutation({ mutationFn: (v: { status: string }) => post(`/tasks/${id}/respond`, v), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const snooze = useMutation({ mutationFn: (days: number) => post(`/tasks/${id}/snooze`, { days }), onSuccess: () => { inv(); toast.success(tr("Відкладено")); }, onError: (e: any) => toast.error(e.message) });
  const plan = useMutation({ mutationFn: (v: { date: string | null; time?: string | null }) => post(`/tasks/${id}/plan`, v), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const edit = useMutation({ mutationFn: (v: Record<string, unknown>) => patch(`/tasks/${id}`, v), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  // згадки: «@Імʼя» у тексті → id адмінів (перший збіг по імені без регістру)
  const mentionIds = () => admins.filter(a => new RegExp(`@${a.name.split(" ")[0]}`, "i").test(comment)).map(a => a.id);
  const mentionHint = (() => { const m = comment.match(/@([^\s@]*)$/); return m ? admins.filter(a => a.name.toLowerCase().includes(m[1]!.toLowerCase())).slice(0, 6) : []; })();
  const addComment = useMutation({
    mutationFn: async () => {
      if (files.length) { const fd = new FormData(); fd.append("body", comment); fd.append("mentions", JSON.stringify(mentionIds())); for (const f of files) fd.append("files", f); return upload(`/tasks/${id}/comments/upload`, fd); }
      return post(`/tasks/${id}/comments`, { body: comment, mentions: mentionIds() });
    },
    onSuccess: () => { setComment(""); setFiles([]); qc.invalidateQueries({ queryKey: ["task", id] }); }, onError: (e: any) => toast.error(e.message),
  });
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);

  const toggleCheck = (cid: string) => {
    if (!t) return;
    const next = t.checklist.map(c => c.id === cid ? { ...c, done: !c.done, doneBy: !c.done ? me?.id ?? null : null, doneAt: !c.done ? new Date().toISOString() : null } : c);
    edit.mutate({ checklist: next });
  };
  const open = !!t && ["open", "in_progress", "review"].includes(t.status);
  const myPart = t?.assignees.find(a => a.adminId === me?.id);
  const mine = !!t && (t.assigneeAdminId === me?.id || !!myPart);

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl animate-fade-in">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <span className="text-xs text-slate-400">#{id}</span>
        {t && <><Badge color={STATUS_BADGE[t.status]}>{tr(STATUS_LABEL[t.status])}</Badge><span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-semibold", PRIORITY_CLS[t.priority])}>{tr(PRIORITY_LABEL[t.priority])}</span><span className="text-[10px] text-slate-400">{tr(SOURCE_LABEL[t.source] ?? t.source)} · {tr(KIND_LABEL[t.kind])}</span></>}
        <button onClick={onClose} className="ml-auto rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-5 w-5" /></button>
      </div>
      {isLoading || !t ? <div className="p-6"><Spinner /></div> : (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-sm">
          <div>
            <div className="text-lg font-bold leading-snug text-slate-800">{t.title}</div>
            {t.description && <div className="mt-1 whitespace-pre-wrap text-slate-600">{t.description}</div>}
            {t.source !== "manual" && !t.resolution?.context.why && <div className="mt-1 text-xs text-slate-400">{tr("Створено системою")} · {tr("закриється сама, коли причина зникне")}</div>}
          </div>

          {/* дії */}
          {open && (
            <div className="flex flex-wrap gap-1.5">
              {t.kind === "task" && (mine || t.can.edit) && t.status !== "review" && (<>
                {t.status === "open" && <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => status.mutate({ status: "in_progress" })}><Play className="h-3.5 w-3.5" /> {tr("Беру в роботу")}</Button>}
                <Button variant="success" className="px-2.5 py-1 text-xs" onClick={() => status.mutate({ status: "done", note: note || undefined })}><CheckCircle2 className="h-3.5 w-3.5" /> {t.reviewRequired && t.creatorAdminId !== me?.id ? tr("Зроблено → на перевірку") : tr("Виконано")}</Button>
              </>)}
              {t.status === "review" && t.can.review && (<>
                <Button variant="success" className="px-2.5 py-1 text-xs" onClick={() => status.mutate({ status: "done" })}><CheckCircle2 className="h-3.5 w-3.5" /> {tr("Прийняти")}</Button>
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => status.mutate({ status: "in_progress", note: note || tr("повернуто автором") })}><RotateCcw className="h-3.5 w-3.5" /> {tr("Повернути")}</Button>
              </>)}
              {t.kind === "group" && myPart && myPart.status !== "done" && <Button variant="success" className="px-2.5 py-1 text-xs" onClick={() => respond.mutate({ status: "done" })}><CheckCircle2 className="h-3.5 w-3.5" /> {tr("Моя частина готова")}</Button>}
              {t.kind === "meeting" && myPart && (<>
                <Button variant={myPart.status === "accepted" ? "success" : "secondary"} className="px-2.5 py-1 text-xs" onClick={() => respond.mutate({ status: "accepted" })}>✅ {tr("Буду")}</Button>
                <Button variant={myPart.status === "declined" ? "danger" : "secondary"} className="px-2.5 py-1 text-xs" onClick={() => respond.mutate({ status: "declined" })}>❌ {tr("Не зможу")}</Button>
              </>)}
              {t.kind === "meeting" && t.can.edit && <Button variant="success" className="px-2.5 py-1 text-xs" onClick={() => status.mutate({ status: "done" })}>{tr("Провели")}</Button>}
              {(mine || t.can.edit) && t.kind !== "meeting" && (
                <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-1 text-xs">
                  <Clock className="h-3.5 w-3.5 text-slate-400" />
                  {[1, 3, 7].map(d => <button key={d} onClick={() => snooze.mutate(d)} className="rounded px-1.5 py-1 hover:bg-slate-100" title={tr("нагадати через {n} дн.", { n: d })}>+{d}</button>)}
                </span>
              )}
              {(mine || t.can.edit) && t.kind !== "meeting" && (t.plannedFor === todayStr()
                ? <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => plan.mutate({ date: null })}>{tr("Зняти з мого дня")}</Button>
                : <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => plan.mutate({ date: todayStr() })}><CalendarClock className="h-3.5 w-3.5" /> {tr("У мій день")}</Button>)}
              {t.can.edit && <Button variant="ghost" className="ml-auto px-2 py-1 text-xs text-rose-500" onClick={() => { if (confirm(tr("Скасувати задачу?"))) status.mutate({ status: "cancelled" }); }}><Ban className="h-3.5 w-3.5" /> {tr("Скасувати")}</Button>}
            </div>
          )}
          {open && t.reviewRequired && (mine || t.can.review) && <Input value={note} onChange={e => setNote(e.target.value)} placeholder={tr("Примітка до виконання / повернення (необов'язково)")} className="text-xs" />}
          {t.status === "done" && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">✓ {tr("Виконано")} {t.completedByName ? `· ${t.completedByName}` : ""} {t.completedAt ? `· ${new Date(t.completedAt).toLocaleString("uk-UA")}` : ""}{t.resolutionNote ? ` · ${t.resolutionNote}` : ""}{open ? "" : ""}{t.can.edit && <button className="ml-2 underline" onClick={() => status.mutate({ status: "open" })}>{tr("відкрити знову")}</button>}</div>}
          {t.status === "auto_resolved" && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">✓ {tr("Вирішено автоматично")} · {t.resolutionNote}</div>}

          {/* кого стосується */}
          {(t.worker || t.factoryName || t.autoParams) && (
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tr("Кого стосується")}</div>
              <div className="flex flex-wrap items-center gap-2">
                {t.worker && <Link href={`/workers/${t.worker.id}`} className="font-semibold text-slate-800 hover:text-red-600">{t.worker.fullName} <span className="font-mono text-xs text-slate-400">{t.worker.workerCode}</span></Link>}
                {t.factoryName && <Badge color="red">{t.factoryName}</Badge>}
                {t.documentTitle && <Badge color="amber">📄 {t.documentTitle}</Badge>}
                {t.contractLabel && <Badge color="blue">✍️ {t.contractLabel}</Badge>}
                {t.candidateName && <Link href="/recruitment" className="text-xs text-slate-600 hover:text-red-600">🧑‍💼 {t.candidateName}</Link>}
                {typeof t.autoParams?.expiresAt === "string" && <span className="text-xs text-slate-500">{tr("строк")}: <b>{fmtD(String(t.autoParams.expiresAt))}</b></span>}
                {Array.isArray(t.autoParams?.workerNames) && <span className="text-xs text-slate-500">{(t.autoParams.workerNames as string[]).slice(0, 8).join(", ")}{(t.autoParams.count as number) > 8 ? ` … (+${(t.autoParams.count as number) - 8})` : ""}</span>}
              </div>
              {!t.resolution?.actions.length && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {t.worker && <Link href={`/workers/${t.worker.id}`} className="rounded-md border border-slate-200 bg-white px-2 py-1 hover:bg-slate-50"><ExternalLink className="mr-1 inline h-3 w-3" />{tr("Профіль")}</Link>}
                  {t.candidateId && <Link href="/recruitment" className="rounded-md border border-slate-200 bg-white px-2 py-1 hover:bg-slate-50">{tr("Рекрутація")}</Link>}
                </div>
              )}
            </div>
          )}

          {/* як вирішити — контекст автозадачі і дії, що закривають причину */}
          {t.resolution && open && (t.resolution.actions.length > 0 || t.resolution.context.rule) && <ResolveBlock task={t} inv={inv} />}

          {/* зустріч / групова: учасники */}
          {t.kind !== "task" && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tr("Учасники")} · {t.assignees.filter(a => a.status === (t.kind === "meeting" ? "accepted" : "done")).length}/{t.assignees.length} {t.kind === "meeting" ? tr("підтвердили") : tr("виконали")}</div>
              <div className="flex flex-wrap gap-1.5">
                {t.assignees.map(a => <span key={a.adminId} className={cn("rounded-full px-2 py-0.5 text-xs", a.status === "done" || a.status === "accepted" ? "bg-emerald-50 text-emerald-700" : a.status === "declined" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-500")}>{a.status === "done" || a.status === "accepted" ? "✓ " : a.status === "declined" ? "✕ " : "? "}{a.name}{a.respondedAt && <span className="ml-1 opacity-60">{new Date(a.respondedAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}</span>)}
              </div>
              {t.kind === "meeting" && <div className="mt-2 text-xs text-slate-500">{fmtD(t.dueAt)} {t.dueTime}{t.durationMin ? ` · ${t.durationMin} ${tr("хв")}` : ""}{t.place ? <span> · <MapPin className="inline h-3 w-3" /> {t.place}</span> : null}</div>}
              {t.kind === "group" && open && t.can.reassign && t.assignees.some(a => a.status !== "done") && <Button variant="secondary" className="mt-2 px-2.5 py-1 text-xs" loading={remindAll.isPending} onClick={() => remindAll.mutate()}>🔔 {tr("Нагадати всім")}</Button>}
              {t.kind === "meeting" && t.agenda.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tr("Порядок денний")}</div>
                  <ol className="space-y-0.5 text-sm">{t.agenda.map((a, i) => <li key={i} className="flex items-start gap-2"><span className="w-5 shrink-0 text-right text-slate-400">{i + 1}.</span><span className="flex-1">{a}</span>{t.status === "done" && <button onClick={() => setAgendaTask(a)} className="shrink-0 rounded-full border border-slate-200 px-2 text-[10px] hover:border-red-300 hover:text-red-600">→ {tr("задача")}</button>}</li>)}</ol>
                </div>
              )}
              {t.kind === "meeting" && t.status === "done" && (
                <div className="mt-2">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tr("Підсумок зустрічі")}</div>
                  {summaryDraft == null ? (
                    <div className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-sm whitespace-pre-wrap">{t.summary || <span className="text-slate-400">{tr("Ще не записано")}</span>}{t.can.edit && <button onClick={() => setSummaryDraft(t.summary ?? "")} className="ml-2 text-xs text-slate-400 hover:text-red-600">{tr("редагувати")}</button>}</div>
                  ) : (
                    <div className="space-y-1"><textarea value={summaryDraft} onChange={e => setSummaryDraft(e.target.value)} rows={4} className="w-full rounded-lg border border-slate-200 px-2 py-1 text-sm" placeholder={tr("Що вирішили, хто що робить…")} />
                      <div className="flex gap-2"><Button className="px-2.5 py-1 text-xs" onClick={() => { edit.mutate({ summary: summaryDraft }); setSummaryDraft(null); }}>{tr("Зберегти")}</Button><Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setSummaryDraft(null)}>{tr("Скасувати")}</Button></div></div>
                  )}
                </div>
              )}
            </div>
          )}
          {relatedOpen != null && <TaskDrawer id={relatedOpen} onClose={() => setRelatedOpen(null)} />}
          {agendaTask && <NewTaskModal defaults={{ title: agendaTask, workerId: t.workerId ?? undefined, factoryId: t.factoryId ?? undefined, fromTaskId: t.id }} onClose={() => setAgendaTask(null)} onCreated={() => qc.invalidateQueries({ queryKey: ["tasks", "related", id] })} />}

          {/* чекліст */}
          {(t.checklist.length > 0 || t.can.edit) && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tr("Чекліст")} {t.checklistTotal ? `${t.checklistDone}/${t.checklistTotal}` : ""}</div>
              <div className="space-y-1">
                {t.checklist.map(c => (
                  <label key={c.id} className="flex items-start gap-2"><input type="checkbox" checked={c.done} onChange={() => toggleCheck(c.id)} className="mt-0.5" /><span className={cn(c.done && "text-slate-400 line-through")}>{c.text}</span>{c.done && c.auto && c.doneBy == null && <span className="ml-auto shrink-0 rounded-full bg-emerald-50 px-1.5 text-[10px] text-emerald-700" title={c.doneAt ? new Date(c.doneAt).toLocaleString("uk-UA") : ""}>{tr("система")}</span>}{!c.done && c.auto && <span className="ml-auto shrink-0 text-[10px] text-slate-300" title={tr("відмітиться сама за фактом")}>auto</span>}</label>
                ))}
                {t.can.edit && <AddStep onAdd={txt => edit.mutate({ checklist: [...t.checklist, { id: `c${Date.now()}`, text: txt, done: false }] })} />}
              </div>
            </div>
          )}

          {/* поля */}
          <div className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
            <span className="text-slate-400">{tr("Виконавець")}</span>
            <span>{t.kind === "task" ? (t.can.reassign ? (
              <select value={t.assigneeAdminId ?? ""} onChange={e => edit.mutate({ assigneeAdminId: e.target.value ? Number(e.target.value) : null })} className="rounded border border-transparent bg-transparent py-0.5 hover:border-slate-300">
                <option value="">—</option>{admins.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>) : t.assigneeName ?? "—") : `${t.assignees.length} ${tr("учасників")}`}</span>
            <span className="text-slate-400">{tr("Автор")}</span><span>{t.creatorName}</span>
            <span className="text-slate-400">{tr("Спостерігачі")}</span>
            <span className="flex flex-wrap items-center gap-1">{t.watchers.map(w => <span key={w.adminId} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5">👁 {w.name}{t.can.edit && <button onClick={() => edit.mutate({ watcherIds: t.watchers.filter(x => x.adminId !== w.adminId).map(x => x.adminId) })} className="text-slate-400">✕</button>}</span>)}
              {t.can.edit && <select value="" onChange={e => { if (e.target.value) edit.mutate({ watcherIds: [...t.watchers.map(x => x.adminId), Number(e.target.value)] }); }} className="rounded border border-dashed border-slate-300 bg-transparent px-1 py-0.5 text-[10px]"><option value="">+</option>{admins.filter(a => !t.watchers.some(w => w.adminId === a.id) && a.id !== t.assigneeAdminId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
              {!t.watchers.length && !t.can.edit && "—"}</span>
            <span className="text-slate-400">{tr("Строк")}</span>
            <span>{t.can.edit ? <input type="date" value={t.dueAt ?? ""} onChange={e => edit.mutate({ dueAt: e.target.value || null })} className="rounded border border-transparent bg-transparent py-0.5 hover:border-slate-300" /> : fmtD(t.dueAt) || "—"}{t.dueTime ? ` ${t.dueTime}` : ""}</span>
            {t.kind === "meeting" && <><span className="text-slate-400">{tr("Час")}</span><span>{t.can.edit ? <input type="time" value={t.dueTime ?? ""} onChange={e => edit.mutate({ dueTime: e.target.value || null })} className="rounded border border-transparent bg-transparent py-0.5 hover:border-slate-300" /> : t.dueTime ?? "—"}{t.durationMin ? ` · ${t.durationMin} ${tr("хв")}` : ""}</span>
              <span className="text-slate-400">{tr("Нагадати")}</span><span>{tr("за 1 день, за 1 год")}</span>
              <span className="text-slate-400">{tr("Повʼязані задачі")}</span><span className="flex flex-wrap gap-1">{related.length ? related.map(r => <button key={r.id} onClick={() => setRelatedOpen(r.id)} className={cn("rounded-full px-1.5 py-0.5 text-[11px] hover:text-red-600", r.status === "done" ? "bg-emerald-50 line-through" : "bg-slate-100")} title={r.title}>#{r.id} {r.title.slice(0, 28)}{r.title.length > 28 ? "…" : ""}</button>) : <span className="text-slate-400">—</span>}</span></>}
            <span className="text-slate-400">{tr("Пріоритет")}</span>
            <span>{t.can.edit ? <select value={t.priority} onChange={e => edit.mutate({ priority: e.target.value })} className="rounded border border-transparent bg-transparent py-0.5 hover:border-slate-300">{(["low", "normal", "high", "urgent"] as TaskPriority[]).map(p => <option key={p} value={p}>{tr(PRIORITY_LABEL[p])}</option>)}</select> : tr(PRIORITY_LABEL[t.priority])}</span>
            {t.durationMin && t.kind !== "meeting" && <><span className="text-slate-400">{tr("Оцінка часу")}</span><span>{t.durationMin} {tr("хв")}</span></>}
            {t.plannedFor && <><span className="text-slate-400">{tr("У плані дня")}</span><span>{fmtD(t.plannedFor)}{t.plannedTime ? ` ${t.plannedTime}` : ""}{t.rolloverCount ? <span className="ml-1 text-amber-600">· {tr("перенесено {n} р.", { n: t.rolloverCount })}</span> : null}</span></>}
            {t.snoozedUntil && t.snoozedUntil > todayStr() && <><span className="text-slate-400">{tr("Відкладено до")}</span><span>{fmtD(t.snoozedUntil)}</span></>}
            <span className="text-slate-400">{tr("Контроль автора")}</span><span>{t.reviewRequired ? tr("так") : tr("ні")}</span>
            {t.recurrence && <><span className="text-slate-400">{tr("Повторення")}</span><span>{t.recurrence.freq === "daily" ? tr("щодня") : t.recurrence.freq === "weekly" ? tr("щотижня") : tr("щомісяця")}</span></>}
            {t.source !== "manual" && <><span className="text-slate-400">{tr("Нагадування")}</span><span>{[60, 30, 14, 7, 0].map(s => <span key={s} className={cn("mr-1", t.remindersSent.includes(s) ? "font-semibold text-slate-700" : "text-slate-300")}>{s}</span>)}{tr("дн.")}</span></>}
          </div>

          {/* коментарі */}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tr("Коментарі")}</div>
            <div className="space-y-2">
              {t.comments.map(c => <div key={c.id} className="rounded-lg border border-slate-100 p-2"><div className="text-[10px] text-slate-400">{c.name} · {new Date(c.createdAt).toLocaleString("uk-UA")}</div><div className="whitespace-pre-wrap">{c.body}</div>{c.attachments && c.attachments.length > 0 && <div className="mt-1 flex flex-wrap gap-2">{c.attachments.map((a, i) => a.mime.startsWith("image/") ? <a key={i} href={`/api/tasks/${id}/attachments/${c.id}/${i}`} target="_blank" rel="noreferrer"><img src={`/api/tasks/${id}/attachments/${c.id}/${i}`} alt={a.name} className="h-20 rounded border border-slate-200 object-cover" /></a> : <a key={i} href={`/api/tasks/${id}/attachments/${c.id}/${i}`} target="_blank" rel="noreferrer" className="rounded border border-slate-200 px-2 py-0.5 text-xs text-blue-600 hover:underline">📎 {a.name}</a>)}</div>}</div>)}
              {mentionHint.length > 0 && <div className="flex flex-wrap gap-1">{mentionHint.map(a => <button key={a.id} onClick={() => setComment(c => c.replace(/@([^\s@]*)$/, `@${a.name.split(" ")[0]} `))} className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">@{a.name}</button>)}</div>}
              {files.length > 0 && <div className="flex flex-wrap gap-1 text-xs">{files.map((f, i) => <span key={i} className="rounded-full bg-slate-100 px-2 py-0.5">📎 {f.name}<button onClick={() => setFiles(l => l.filter((_, j) => j !== i))} className="ml-1 text-slate-400">✕</button></span>)}</div>}
              <div className="flex gap-2"><Input value={comment} onChange={e => setComment(e.target.value)} placeholder={tr("Коментар… (@імʼя — згадати)")} onKeyDown={e => { if (e.key === "Enter" && (comment.trim() || files.length)) addComment.mutate(); }} /><label className="cursor-pointer rounded-lg border border-slate-200 px-2 py-1.5 text-slate-500 hover:bg-slate-50" title={tr("Прикріпити фото або PDF")}><input type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={e => { setFiles(l => [...l, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />📎</label><Button variant="secondary" className="px-2.5" disabled={!comment.trim()} onClick={() => addComment.mutate()}><Send className="h-4 w-4" /></Button></div>
            </div>
          </div>

          {/* журнал */}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tr("Журнал")}</div>
            <ul className="space-y-0.5 text-[11px] text-slate-500">
              {t.events.map(e => <li key={e.id}>{new Date(e.createdAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} · {e.name ?? tr("Система")} · {eventText(e.kind, e.payload, tr)}</li>)}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function eventText(kind: string, p: Record<string, unknown> | null, tr: (s: string, o?: any) => string): string {
  switch (kind) {
    case "created": return tr("створено");
    case "status": return `${tr("статус")}: ${tr(STATUS_LABEL[(p?.from as TaskStatusKey) ?? "open"] ?? String(p?.from))} → ${tr(STATUS_LABEL[(p?.to as TaskStatusKey) ?? "open"] ?? String(p?.to))}${p?.note ? ` (${p.note})` : ""}`;
    case "priority": return `${tr("пріоритет")} → ${tr(PRIORITY_LABEL[(p?.to as TaskPriority) ?? "normal"])}`;
    case "reminder": return `${tr("нагадування")} (${(p?.steps as number[] | undefined)?.join("/") ?? ""} ${tr("дн.")})`;
    case "escalated": return tr("ескалація головному");
    case "auto_resolved": return tr("вирішено автоматично");
    case "reopened": return tr("знову актуально");
    case "snoozed": return `${tr("відкладено до")} ${fmtD(String(p?.until ?? ""))}`;
    case "planned": return p?.date ? `${tr("у плані")} ${fmtD(String(p.date))}${p.time ? ` ${p.time}` : ""}` : tr("знято з плану");
    case "rollover": return `${tr("перенесено на")} ${fmtD(String(p?.to ?? ""))}`;
    case "respond": return `${tr("відповідь")}: ${String(p?.status)}`;
    case "comment": return tr("коментар");
    case "edited": return tr("змінено") + (p?.assignee ? ` · ${tr("виконавець")}` : "") + (p?.dueAt ? ` · ${tr("строк")}` : "");
    case "recurred": return `${tr("наступний екземпляр")} ${fmtD(String(p?.nextDue ?? ""))}`;
    default: return kind;
  }
}
type TaskStatusKey = keyof typeof STATUS_LABEL;

function AddStep({ onAdd }: { onAdd: (t: string) => void }) {
  const tr = useT();
  const [v, setV] = useState("");
  return <input value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && v.trim()) { onAdd(v.trim()); setV(""); } }} placeholder={`+ ${tr("додати крок")}`} className="w-full bg-transparent py-0.5 text-xs text-slate-500 outline-none placeholder:text-slate-400" />;
}

// ── Створення ───────────────────────────────────────────────────────────────
export function NewTaskModal({ defaults, onClose, onCreated }: { defaults?: Partial<{ kind: TaskKind; workerId: number; factoryId: number; dueAt: string; dueTime: string; title: string; plannedFor: string; fromTaskId: number }>; onClose: () => void; onCreated?: (t: TaskRow) => void }) {
  const tr = useT();
  const qc = useQueryClient();
  const me = useMe();
  const canGroup = can(me, "tasksGroup");
  const { data: admins = [] } = useQuery<TaskAdmin[]>({ queryKey: ["task-admins"], queryFn: () => get("/tasks/admins") });
  const { data: templates = [] } = useQuery<TaskTemplate[]>({ queryKey: ["task-templates"], queryFn: () => get("/task-templates") });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const [kind, setKind] = useState<TaskKind>(defaults?.kind ?? "task");
  const [title, setTitle] = useState(defaults?.title ?? "");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState<string>(me ? String(me.id) : "");
  const [participants, setParticipants] = useState<number[]>([]);
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [dueAt, setDueAt] = useState(defaults?.dueAt ?? "");
  const [dueTime, setDueTime] = useState(defaults?.dueTime ?? "");
  const [durationMin, setDurationMin] = useState(kind === "meeting" ? "45" : "");
  const [place, setPlace] = useState("");
  const [factoryId, setFactoryId] = useState(defaults?.factoryId ? String(defaults.factoryId) : "");
  const [workerQ, setWorkerQ] = useState("");
  const [workerId, setWorkerId] = useState<number | null>(defaults?.workerId ?? null);
  const [checklist, setChecklist] = useState<string[]>([]);
  const [step, setStep] = useState("");
  const [reviewRequired, setReviewRequired] = useState(false);
  const [recur, setRecur] = useState<"" | "daily" | "weekly" | "monthly">("");
  const [templateId, setTemplateId] = useState("");
  const [notify, setNotify] = useState(true);
  const [watchers, setWatchers] = useState<number[]>([]);
  const [agenda, setAgenda] = useState<string[]>([]);
  const [agendaStep, setAgendaStep] = useState("");
  const [documentId, setDocumentId] = useState<string>("");
  const [contractId, setContractId] = useState<string>("");
  const [candidateId, setCandidateId] = useState<number | null>(null);
  const [candQ, setCandQ] = useState("");
  const { data: wDocs = [] } = useQuery<{ id: number; title: string; status: string; expiresAt: string | null }[]>({ queryKey: ["worker-docs", workerId], queryFn: () => get(`/workers/${workerId}/documents`), enabled: !!workerId });
  const { data: wContracts = [] } = useQuery<{ id: number; status: string; factoryName?: string | null }[]>({ queryKey: ["worker-contracts", workerId], queryFn: () => get(`/workers/${workerId}/contracts`), enabled: !!workerId });
  const { data: candidates = [] } = useQuery<{ id: number; fullName: string; factoryName?: string | null }[]>({ queryKey: ["candidates"], queryFn: () => get("/candidates").catch(() => []), enabled: kind === "task" && !workerId });
  const { data: allWorkers = [] } = useQuery<Worker[]>({ queryKey: ["workers"], queryFn: () => get("/workers") });
  const workers = useMemo(() => { const q = workerQ.trim().toLowerCase(); return q.length >= 2 ? allWorkers.filter(w => w.fullName.toLowerCase().includes(q) || (w.workerCode ?? "").includes(q)) : allWorkers.filter(w => w.id === workerId); }, [allWorkers, workerQ, workerId]);
  const roles = useMemo(() => [...new Set(admins.map(a => a.role))], [admins]);
  const addRole = (role: string) => setParticipants(p => [...new Set([...p, ...admins.filter(a => a.role === role).map(a => a.id)])]);
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const tpl = templates.find(x => x.id === Number(id)); if (!tpl) return;
    if (!title) setTitle(tpl.titleTemplate.replace("{worker}", "").trim());
    setChecklist(tpl.checklist); setReviewRequired(tpl.reviewRequired); if (tpl.description) setDescription(tpl.description);
    if (tpl.defaultAssigneeAdminId) setAssignee(String(tpl.defaultAssigneeAdminId));
    if (tpl.dueInDays != null && !dueAt) setDueAt(addDays(todayStr(), tpl.dueInDays));
    if (tpl.recurrence) setRecur(tpl.recurrence.freq);
  };
  const create = useMutation({
    mutationFn: () => post<TaskRow>("/tasks", {
      kind, title, description: description || null, priority, dueAt: dueAt || null, dueTime: dueTime || null, durationMin: durationMin ? Number(durationMin) : null, place: place || null,
      assigneeAdminId: kind === "task" ? (assignee ? Number(assignee) : null) : null, assigneeIds: kind === "task" ? [] : participants,
      reviewRequired, workerId, factoryId: factoryId ? Number(factoryId) : null, checklist,
      recurrence: recur ? { freq: recur, ...(recur === "weekly" && dueAt ? { weekday: ((new Date(dueAt + "T00:00:00").getDay() + 6) % 7) + 1 } : {}) } : null,
      templateId: templateId ? Number(templateId) : null, plannedFor: defaults?.plannedFor ?? null, notify,
      watcherIds: watchers, agenda: kind === "meeting" ? agenda : [], documentId: documentId ? Number(documentId) : null, contractId: contractId ? Number(contractId) : null, candidateId, fromTaskId: defaults?.fromTaskId ?? null,
    }),
    onSuccess: (t) => { invalidateTasks(qc); toast.success(kind === "meeting" ? tr("Зустріч скликано") : tr("Задачу створено")); onCreated?.(t); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const quick = (d: string) => setDueAt(d);
  const busy = useMemo(() => participants.filter(id => false && id), [participants]); void busy;
  return (
    <Modal open onClose={onClose} title={kind === "meeting" ? tr("Нова зустріч") : kind === "group" ? tr("Нова групова задача") : tr("Нова задача")} size="lg">
      <div className="space-y-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
          {(["task", "group", "meeting"] as TaskKind[]).map(k => (
            <button key={k} disabled={k !== "task" && !canGroup} onClick={() => { setKind(k); if (k === "meeting" && !durationMin) setDurationMin("45"); }} title={k !== "task" && !canGroup ? tr("Групові задачі та зустрічі — лише з правом «групові задачі та зустрічі»") : ""}
              className={cn("flex-1 rounded-md px-2.5 py-1.5 transition", kind === k ? "bg-white shadow-sm text-slate-800" : "text-slate-500 hover:text-slate-700", k !== "task" && !canGroup && "opacity-40 cursor-not-allowed")}>
              {k === "task" ? tr("Задача") : k === "group" ? `👥 ${tr("Групова")}` : `🗓 ${tr("Зустріч")}`}
            </button>
          ))}
        </div>
        <div><Label>{tr("Назва")}</Label><Input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder={kind === "meeting" ? tr("напр. Збори офісу Люблін") : tr("напр. Замовити спецодяг на NOWOPAK")} /></div>
        {kind === "task" ? (
          <div className="grid grid-cols-2 gap-2">
            <div><Label>{tr("Виконавець")}</Label><Select value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">—</option>{admins.map(a => <option key={a.id} value={a.id}>{a.name}{a.id === me?.id ? ` (${tr("я")})` : ""}</option>)}</Select></div>
            <div><Label>{tr("Пріоритет")}</Label><Select value={priority} onChange={e => setPriority(e.target.value as TaskPriority)}>{(["low", "normal", "high", "urgent"] as TaskPriority[]).map(p => <option key={p} value={p}>{tr(PRIORITY_LABEL[p])}</option>)}</Select></div>
          </div>
        ) : (
          <div>
            <Label>{tr("Учасники")}</Label>
            <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 p-2">
              {participants.map(id => <span key={id} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">{admins.find(a => a.id === id)?.name ?? id}<button onClick={() => setParticipants(p => p.filter(x => x !== id))}>✕</button></span>)}
              <select value="" onChange={e => { if (e.target.value.startsWith("role:")) addRole(e.target.value.slice(5)); else if (e.target.value) setParticipants(p => [...new Set([...p, Number(e.target.value)])]); }} className="rounded-full border border-dashed border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-500">
                <option value="">+ {tr("людина або роль")}</option>
                <optgroup label={tr("Роль (усі)")}>{roles.map(r => <option key={r} value={`role:${r}`}>{tr("усі")}: {r}</option>)}</optgroup>
                <optgroup label={tr("Люди")}>{admins.filter(a => !participants.includes(a.id)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>
              </select>
            </div>
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <div><Label>{kind === "meeting" ? tr("Дата") : tr("Строк")}</Label>
            <div className="flex gap-1">
              <Input type="date" value={dueAt} onChange={e => setDueAt(e.target.value)} className="w-40" />
              <button onClick={() => quick(todayStr())} className={cn("rounded-full border px-2 text-xs", dueAt === todayStr() ? "border-red-600 bg-red-600 text-white" : "border-slate-200")}>{tr("сьогодні")}</button>
              <button onClick={() => quick(addDays(todayStr(), 1))} className={cn("rounded-full border px-2 text-xs", dueAt === addDays(todayStr(), 1) ? "border-red-600 bg-red-600 text-white" : "border-slate-200")}>{tr("завтра")}</button>
              <button onClick={() => quick(addDays(todayStr(), 7))} className="rounded-full border border-slate-200 px-2 text-xs">+7</button>
            </div>
          </div>
          <div><Label>{tr("Час")}</Label><Input type="time" value={dueTime} onChange={e => setDueTime(e.target.value)} className="w-28" /></div>
          <div><Label>{kind === "meeting" ? tr("Тривалість, хв") : tr("Оцінка, хв")}</Label><Input value={durationMin} onChange={e => setDurationMin(e.target.value)} inputMode="numeric" className="w-24" placeholder="30" /></div>
        </div>
        {kind === "meeting" && <div><Label>{tr("Місце або лінк")}</Label><Input value={place} onChange={e => setPlace(e.target.value)} placeholder={tr("Офіс Люблін / Google Meet")} /></div>}
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{tr("Фабрика")}</Label><Select value={factoryId} onChange={e => setFactoryId(e.target.value)}><option value="">—</option>{factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></div>
          <div><Label>{tr("Працівник")}</Label>
            {workerId ? <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"><span className="truncate">{workers.find(w => w.id === workerId)?.fullName ?? `#${workerId}`}</span><button className="ml-auto text-slate-400" onClick={() => setWorkerId(null)}>✕</button></div>
              : <div className="relative"><Input value={workerQ} onChange={e => setWorkerQ(e.target.value)} placeholder={tr("пошук за іменем…")} />
                {workerQ.length >= 2 && workers.length > 0 && <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow">{workers.slice(0, 8).map(w => <button key={w.id} onClick={() => { setWorkerId(w.id); if (!factoryId && w.factoryId) setFactoryId(String(w.factoryId)); }} className="block w-full px-2 py-1 text-left text-sm hover:bg-slate-50">{w.fullName} <span className="text-xs text-slate-400">{w.factoryName}</span></button>)}</div>}
              </div>}
          </div>
        </div>
        {/* привʼязки: документ / умова працівника, кандидат (макет п.1 «Прив'язки») */}
        {workerId && (wDocs.length > 0 || wContracts.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {wDocs.length > 0 && <div><Label>{tr("Документ")}</Label><Select value={documentId} onChange={e => setDocumentId(e.target.value)}><option value="">—</option>{wDocs.map(d => <option key={d.id} value={d.id}>{d.title}{d.expiresAt ? ` · ${tr("до")} ${fmtD(d.expiresAt)}` : ""} · {d.status}</option>)}</Select></div>}
            {wContracts.length > 0 && <div><Label>{tr("Умова")}</Label><Select value={contractId} onChange={e => setContractId(e.target.value)}><option value="">—</option>{wContracts.map(c => <option key={c.id} value={c.id}>#{c.id}{c.factoryName ? ` · ${c.factoryName}` : ""} · {c.status}</option>)}</Select></div>}
          </div>
        )}
        {kind === "task" && !workerId && candidates.length > 0 && (
          <div><Label>{tr("Кандидат")}</Label>
            {candidateId ? <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"><span className="truncate">{candidates.find(c => c.id === candidateId)?.fullName ?? `#${candidateId}`}</span><button className="ml-auto text-slate-400" onClick={() => setCandidateId(null)}>✕</button></div>
              : <div className="relative"><Input value={candQ} onChange={e => setCandQ(e.target.value)} placeholder={tr("пошук кандидата…")} />
                {candQ.length >= 2 && <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow">{candidates.filter(c => c.fullName.toLowerCase().includes(candQ.toLowerCase())).slice(0, 8).map(c => <button key={c.id} onClick={() => { setCandidateId(c.id); setCandQ(""); }} className="block w-full px-2 py-1 text-left text-sm hover:bg-slate-50">{c.fullName}{c.factoryName ? <span className="text-xs text-slate-400"> · {c.factoryName}</span> : null}</button>)}</div>}
              </div>}
          </div>
        )}
        {/* спостерігачі: бачать хід, отримують сповіщення, не виконавці */}
        <div><Label>{tr("Спостерігачі")}</Label>
          <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 p-2">
            {watchers.map(id => <span key={id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">👁 {admins.find(a => a.id === id)?.name ?? id}<button onClick={() => setWatchers(p => p.filter(x => x !== id))}>✕</button></span>)}
            <select value="" onChange={e => { if (e.target.value) setWatchers(p => [...new Set([...p, Number(e.target.value)])]); }} className="rounded-full border border-dashed border-slate-300 bg-white px-2 py-0.5 text-xs">
              <option value="">+ {tr("спостерігач")}</option>
              {admins.filter(a => !watchers.includes(a.id) && a.id !== me?.id).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
        {kind === "meeting" ? (
          <div><Label>{tr("Порядок денний")}</Label>
            <div className="space-y-1 text-sm">
              {agenda.map((a, i) => <div key={i} className="flex items-center gap-2"><span className="w-5 text-right text-slate-400">{i + 1}.</span><span className="flex-1">{a}</span><button className="text-slate-400" onClick={() => setAgenda(l => l.filter((_, j) => j !== i))}>✕</button></div>)}
              <input value={agendaStep} onChange={e => setAgendaStep(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && agendaStep.trim()) { setAgenda(l => [...l, agendaStep.trim()]); setAgendaStep(""); } }} placeholder={`+ ${tr("пункт (Enter)")}`} className="w-full border-0 border-b border-dashed border-slate-200 bg-transparent px-1 py-1 text-sm outline-none" />
            </div>
          </div>
        ) : <div><Label>{tr("Опис")}</Label><Textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} /></div>}
        {kind !== "meeting" && (
          <div><Label>{tr("Чекліст")}</Label>
            <div className="space-y-1 text-sm">
              {checklist.map((c, i) => <div key={i} className="flex items-center gap-2">☐ <span className="flex-1">{c}</span><button className="text-slate-400" onClick={() => setChecklist(l => l.filter((_, j) => j !== i))}>✕</button></div>)}
              <input value={step} onChange={e => setStep(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && step.trim()) { setChecklist(l => [...l, step.trim()]); setStep(""); } }} placeholder={`+ ${tr("крок (Enter)")}`} className="w-full bg-transparent py-0.5 text-xs outline-none placeholder:text-slate-400" />
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
          {kind !== "meeting" && <label className="flex items-center gap-1"><input type="checkbox" checked={reviewRequired} onChange={e => setReviewRequired(e.target.checked)} /> {tr("перевірити перед закриттям")}</label>}
          <label className="flex items-center gap-1">{tr("повторювати")}: <select value={recur} onChange={e => setRecur(e.target.value as any)} className="rounded border border-slate-200 bg-white px-1 py-0.5"><option value="">{tr("ні")}</option><option value="daily">{tr("щодня")}</option><option value="weekly">{tr("щотижня")}</option><option value="monthly">{tr("щомісяця")}</option></select></label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} /> {tr("сповістити в бот")}</label>
          {kind !== "meeting" && templates.length > 0 && <label className="flex items-center gap-1">{tr("шаблон")}: <select value={templateId} onChange={e => applyTemplate(e.target.value)} className="rounded border border-slate-200 bg-white px-1 py-0.5"><option value="">—</option>{templates.filter(x => x.isActive).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
        </div>
        {kind === "meeting" && participants.length > 0 && dueAt && dueTime && <MeetingConflicts date={dueAt} time={dueTime} durationMin={Number(durationMin) || 45} participants={participants} admins={admins} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{tr("Скасувати")}</Button>
          <Button loading={create.isPending} disabled={!title.trim() || (kind !== "task" && !participants.length) || (kind === "meeting" && (!dueAt || !dueTime))} onClick={() => create.mutate()}>{kind === "meeting" ? tr("Скликати") : tr("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// накладки: зустрічі учасників того ж дня, що перетинаються за часом
function MeetingConflicts({ date, time, durationMin, participants, admins }: { date: string; time: string; durationMin: number; participants: number[]; admins: TaskAdmin[] }) {
  const tr = useT();
  const { data = [] } = useQuery<TaskRow[]>({ queryKey: ["tasks-calendar", "team", date], queryFn: () => get(`/tasks/calendar?from=${date}&to=${date}&scope=team`) });
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const s = toMin(time), e = s + durationMin;
  const clashes = data.filter(t => t.kind === "meeting" && t.dueTime && t.status !== "cancelled").flatMap(t => {
    const ts = toMin(t.dueTime!), te = ts + (t.durationMin ?? 30);
    if (te <= s || ts >= e) return [];
    return t.assignees.filter(a => participants.includes(a.adminId)).map(a => ({ who: admins.find(x => x.id === a.adminId)?.name ?? a.name, title: t.title, at: t.dueTime }));
  });
  if (!clashes.length) return null;
  return <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />{clashes.map((c, i) => <span key={i}>{c.who} {tr("має")} «{c.title}» {tr("о")} {c.at}{i < clashes.length - 1 ? "; " : ""}</span>)}</div>;
}

// ── «Як вирішити»: контекст автозадачі (документ / умова / файл / зміна виплат / пропуски /
// відсутні документи / причини движка) + дії, що закривають причину без переходів ──
const CONTRACT_ST: Record<string, string> = { draft: "чернетка", pending_approval: "на затвердженні", approved: "затверджено", sent: "надіслано на підпис", viewed: "переглянуто", worker_signed: "підписав працівник", signed: "підписано", declined: "відхилено", cancelled: "скасовано", superseded: "замінено", expired: "прострочено" };
const DOC_ST: Record<string, "slate" | "green" | "amber" | "rose"> = { present: "green", pending: "amber", missing: "rose", expired: "rose" };
function ResolveBlock({ task, inv }: { task: TaskDetail; inv: () => void }) {
  const tr = useT();
  const qc = useQueryClient();
  const { context: c, actions } = task.resolution!;
  const [noteFor, setNoteFor] = useState<TaskAction | null>(null);
  const [note, setNote] = useState("");
  const [applyChange, setApplyChange] = useState(false);
  const run = useMutation({
    mutationFn: (v: { code: string; note?: string }) => post<{ message: string }>(`/tasks/${task.id}/action/${v.code}`, { note: v.note }),
    onSuccess: (d) => { toast.success(d.message); inv(); qc.invalidateQueries({ queryKey: ["worker-docs"] }); qc.invalidateQueries({ queryKey: ["worker-legality"] }); setNoteFor(null); setNote(""); },
    onError: (e: any) => toast.error(e.message),
  });
  const fire = (a: TaskAction) => {
    if (a.kind === "modal") { if (a.code === "apply_change") setApplyChange(true); return; }
    if (a.needsNote) { setNoteFor(a); setNote(a.code === "message_worker" && a.notePlaceholder && task.resolution!.context.rule === "absence_unexplained" ? a.notePlaceholder : ""); return; }
    if (a.confirm && !confirm(tr(a.confirm))) return;
    run.mutate({ code: a.code });
  };
  const legal = (v: string | null) => v ? tr(LEGAL_LABEL[v as LegalStatus] ?? v) : tr("не зголошений");
  const btn = "rounded-md border px-2.5 py-1 text-xs";
  return (
    <div className="rounded-lg border border-violet-100 bg-violet-50/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-violet-700"><Wrench className="h-3.5 w-3.5" /> {tr("Як вирішити")}{c.rule && <span className="font-normal normal-case text-slate-400">· {tr(RULE_LABEL[c.rule] ?? c.rule)}</span>}</div>

      {c.document && (
        <div className="mb-2 rounded-md border border-slate-100 bg-white px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2"><FileText className="h-3.5 w-3.5 text-slate-400" /><span className="font-semibold text-slate-800">{c.document.typeName ?? c.document.title}</span>{c.document.typeName && c.document.title !== c.document.typeName && <span className="text-slate-500">{c.document.title}</span>}<Badge color={DOC_ST[c.document.status] ?? "slate"}>{tr(c.document.status)}</Badge></div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-slate-500">
            {c.document.number && <span>№ {c.document.number}</span>}
            {c.document.expiresAt && <span>{tr("до")} <b className={c.document.expiresAt < todayStr() ? "text-rose-600" : "text-slate-700"}>{fmtD(c.document.expiresAt)}</b></span>}
            {c.document.requestedAt && <span className="text-amber-700">{tr("запитано")} {fmtD(c.document.requestedAt.slice(0, 10))}</span>}
            {c.document.hasFile && c.document.fileUrl && <a href={c.document.fileUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{tr("Відкрити файл")} ↗</a>}
            {c.document.reviewNote && <span className="text-rose-600">{tr("відхилено")}: {c.document.reviewNote}</span>}
          </div>
          {c.document.hasFile && c.document.fileUrl && c.document.isImage && <a href={c.document.fileUrl} target="_blank" rel="noreferrer"><img src={c.document.fileUrl} alt="" className="mt-2 max-h-48 rounded-md border border-slate-200 object-contain" /></a>}
        </div>
      )}
      {c.uploads && c.uploads.length > 0 && (
        <div className="mb-2 space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">📎 {tr("Файли від працівника на перевірці")} · {c.uploads.length}</div>
          {c.uploads.map(u => (
            <div key={u.id} className="rounded-md border border-emerald-100 bg-white px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-slate-800">{u.typeName ?? u.title}</span>{u.uploadedAt && <span className="text-slate-400">{new Date(u.uploadedAt).toLocaleString("uk-UA")}</span>}<a href={u.fileUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{tr("Відкрити файл")} ↗</a></div>
              {u.isImage && <a href={u.fileUrl} target="_blank" rel="noreferrer"><img src={u.fileUrl} alt="" className="mt-2 max-h-56 rounded-md border border-slate-200 object-contain" /></a>}
            </div>
          ))}
        </div>
      )}
      {c.contract && (
        <div className="mb-2 rounded-md border border-slate-100 bg-white px-3 py-2 text-xs">
          <span className="font-semibold text-slate-800">{tr("Умова")}{c.contract.factoryName ? ` · ${c.contract.factoryName}` : ""}</span>
          <span className="ml-2 text-slate-500">{c.contract.status ? tr(CONTRACT_ST[c.contract.status] ?? c.contract.status) : tr("умови в системі немає")}{c.contract.dateTo ? ` · ${tr("до")} ${fmtD(c.contract.dateTo)}` : ""}</span>
        </div>
      )}
      {c.change && (
        <div className="mb-2 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {tr("Статус для виплат за документами")}: <b>{legal(c.change.oldValue)}</b> → <b>{legal(c.change.newValue)}</b>{c.change.effectiveDate ? ` ${tr("з")} ${fmtD(c.change.effectiveDate)}` : ""}. {tr("Вплине на сводну від цієї дати.")}
        </div>
      )}
      {c.missing && c.missing.length > 0 && <div className="mb-2 flex flex-wrap items-center gap-1 text-xs"><span className="text-slate-500">{tr("Бракує")}:</span>{c.missing.map(m => <span key={m.code} className="rounded-full bg-rose-50 px-2 py-0.5 text-rose-700">{m.name}</span>)}</div>}
      {c.absences && c.absences.length > 0 && <div className="mb-2 text-xs text-slate-600">{tr("Пропуски без пояснення")}: <b>{c.absences.map(fmtD).join(", ")}</b></div>}
      {c.reasons && c.reasons.length > 0 && <ul className="mb-2 space-y-0.5 text-xs text-slate-600">{c.reasons.map((r, i) => <li key={i}>• {reasonText(tr, r as any)}</li>)}</ul>}

      <div className="flex flex-wrap gap-1.5">
        {actions.map(a => a.kind === "link"
          ? <Link key={a.code} href={a.href ?? "#"} className={cn(btn, a.primary ? "border-violet-300 bg-white font-semibold text-violet-800 hover:bg-violet-50" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}>{tr(a.label)} →</Link>
          : <button key={a.code} disabled={run.isPending || !!a.done} onClick={() => fire(a)} title={a.done ?? undefined} className={cn(btn, a.done ? "border-slate-100 bg-slate-50 text-slate-400" : a.primary ? "border-violet-600 bg-violet-600 text-white hover:bg-violet-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}>{a.bot === false && a.kind === "api" && (a.code === "request_doc" || a.code === "request_docs" || a.code === "invite_scan" || a.code === "message_worker") ? "⚠ " : ""}{tr(a.label)}{a.done ? ` · ${a.done}` : ""}</button>)}
      </div>
      {actions.some(a => a.bot === false && (a.code === "request_doc" || a.code === "message_worker")) && <div className="mt-1 text-[11px] text-amber-700">⚠ {tr("Працівник не привʼязаний до бота — запит позначиться в профілі, лінк треба передати вручну")}</div>}
      {noteFor && (
        <div className="mt-2 flex gap-1.5">
          <Input value={note} onChange={e => setNote(e.target.value)} placeholder={noteFor.notePlaceholder ? tr(noteFor.notePlaceholder) : ""} className="text-xs" autoFocus />
          <Button className="px-2.5 py-1 text-xs" loading={run.isPending} disabled={!note.trim()} onClick={() => run.mutate({ code: noteFor.code, note })}>{tr("Надіслати")}</Button>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setNoteFor(null)}>✕</Button>
        </div>
      )}
      {(c.why || c.closesWhen) && <div className="mt-2 text-[11px] leading-snug text-slate-500">{c.why}{c.closesWhen && <> <span className="text-emerald-700">{tr("Закриється сама, коли")} {tr(c.closesWhen)}.</span></>}</div>}
      {applyChange && c.worker && c.change && (
        <ProfileChangeModal workerId={c.worker.id} changes={{ effectiveLegalStatus: c.change.newValue }} title={tr("статус для виплат (за документами)")} initialFrom={c.change.effectiveDate ?? undefined}
          onClose={() => { setApplyChange(false); inv(); qc.invalidateQueries({ queryKey: ["worker-legality"] }); }} />
      )}
    </div>
  );
}

export function useOpenTask() {
  const [openId, setOpenId] = useState<number | null>(null);
  const drawer = openId != null ? <TaskDrawer id={openId} onClose={() => setOpenId(null)} /> : null;
  return { openId, setOpenId, drawer };
}
export { Users };

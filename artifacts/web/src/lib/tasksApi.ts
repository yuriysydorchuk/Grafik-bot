// Типи модуля «Задачі» (routes/tasks.ts) — окремий файл, щоб не роздувати api.ts.
export type TaskKind = "task" | "group" | "meeting";
export type TaskStatus = "open" | "in_progress" | "review" | "done" | "cancelled" | "auto_resolved";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type ChecklistItem = { id: string; text: string; done: boolean; doneBy?: number | null; doneAt?: string | null; auto?: string };
export interface UploadInfo { id: number; title: string; typeName: string | null; fileUrl: string; isImage: boolean; uploadedAt: string | null; status: string }
export type Recurrence = { freq: "daily" | "weekly" | "monthly"; interval?: number; weekday?: number; monthday?: number; until?: string | null };

export interface TaskRow {
  id: number; kind: TaskKind; title: string; description: string | null; status: TaskStatus; priority: TaskPriority;
  dueAt: string | null; dueTime: string | null; durationMin: number | null; place: string | null;
  plannedFor: string | null; plannedTime: string | null; snoozedUntil: string | null; rolloverCount: number;
  creatorAdminId: number | null; assigneeAdminId: number | null; reviewRequired: boolean;
  workerId: number | null; factoryId: number | null; documentId: number | null; contractId: number | null; candidateId: number | null;
  source: string; sourceKey: string | null; autoParams: Record<string, unknown> | null;
  checklist: ChecklistItem[]; recurrence: Recurrence | null; remindersSent: number[];
  completedAt: string | null; completedById: number | null; resolutionNote: string | null; createdAt: string; updatedAt: string;
  assigneeName: string | null; creatorName: string | null; completedByName: string | null;
  worker: { id: number; fullName: string; workerCode: string | null } | null; factoryName: string | null;
  assignees: { adminId: number; name: string | null; status: "pending" | "accepted" | "declined" | "done" }[];
  overdue: boolean; checklistDone: number; checklistTotal: number;
}
export interface TaskComment { id: number; adminId: number | null; name: string | null; body: string; createdAt: string }
export interface TaskEvent { id: number; adminId: number | null; name: string | null; kind: string; payload: Record<string, unknown> | null; createdAt: string }
// «Як вирішити» — контекст автозадачі і дії (services/taskResolve.ts)
export interface TaskAction { code: string; label: string; kind: "api" | "link" | "modal"; href?: string; needsNote?: boolean; notePlaceholder?: string; confirm?: string; primary?: boolean; done?: string | null; bot?: boolean }
export interface TaskContext {
  rule: string | null; why: string; closesWhen: string | null;
  worker?: { id: number; fullName: string; telegram: boolean; nationality: string | null; language: string | null; factoryId: number | null } | null;
  document?: { id: number; title: string; typeName: string | null; typeCode: string | null; docTypeId: number | null; number: string | null; expiresAt: string | null; status: string; fileUrl: string | null; hasFile: boolean; isImage: boolean; requestedAt: string | null; reviewNote: string | null; updatedAt: string | null } | null;
  uploads?: UploadInfo[];
  contract?: { id: number | null; status: string | null; dateTo: string | null; factoryId: number | null; factoryName: string | null; code: string | null } | null;
  change?: { id: number; oldValue: string | null; newValue: string | null; effectiveDate: string | null } | null;
  missing?: { code: string; name: string; docTypeId: number | null }[];
  absences?: string[];
  reasons?: { code: string; axis?: string; severity?: string; params?: Record<string, unknown> }[];
}
export interface TaskResolution { context: TaskContext; actions: TaskAction[] }
export interface TaskDetail extends TaskRow { comments: TaskComment[]; events: TaskEvent[]; resolution?: TaskResolution; can: { edit: boolean; reassign: boolean; review: boolean; participant: boolean } }
export interface MyDay {
  date: string; overdue: TaskRow[]; today: TaskRow[]; meetings: TaskRow[]; planned: TaskRow[]; newOvernight: TaskRow[]; doneToday: TaskRow[];
  stats: { done: number; total: number; plannedMin: number }; counters: TaskCounters;
}
export interface TaskCounters { overdue: number; today: number; week: number; meetingsToday: number }
export interface TaskAdmin { id: number; name: string; role: string; isMain: boolean; hasTelegram: boolean }
export interface TaskControlRow { adminId: number; name: string; role: string; open: number; overdue: number; done: number; avgDays: number | null; auto: number; manual: number }
export interface TaskTemplate { id: number; name: string; kind: TaskKind; titleTemplate: string; description: string | null; checklist: string[]; defaultAssigneeAdminId: number | null; reviewRequired: boolean; dueInDays: number | null; recurrence: Recurrence | null; trigger: "manual" | "worker_created" | "worker_fired"; isActive: boolean }
export interface AutoRuleRow { code: string; label: string; description: string; enabled: boolean; leadDays: number | null; fallbackAdminId: number | null; scheduler?: boolean }
export interface TaskSettings { ladder: number[]; manualLadder: number[]; escalationDays: number; digestTime: string; eveningTime: string; skipWeekends: boolean; rollover: boolean; groupAbove?: number }

export const STATUS_LABEL: Record<TaskStatus, string> = { open: "нова", in_progress: "в роботі", review: "на перевірці", done: "виконано", cancelled: "скасовано", auto_resolved: "вирішено автоматично" };
export const STATUS_BADGE: Record<TaskStatus, "slate" | "blue" | "amber" | "green" | "rose"> = { open: "slate", in_progress: "blue", review: "amber", done: "green", cancelled: "slate", auto_resolved: "green" };
export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: "низький", normal: "звичайний", high: "високий", urgent: "терміново" };
export const PRIORITY_CLS: Record<TaskPriority, string> = { low: "bg-slate-100 text-slate-500", normal: "bg-slate-100 text-slate-600", high: "bg-amber-100 text-amber-700", urgent: "bg-rose-100 text-rose-700" };
export const PRIORITY_BORDER: Record<TaskPriority, string> = { low: "border-l-slate-200", normal: "border-l-slate-300", high: "border-l-amber-400", urgent: "border-l-rose-500" };
export const SOURCE_LABEL: Record<string, string> = {
  manual: "ручна", "auto:doc_expiring": "авто · документ", "auto:doc_expired": "авто · прострочений документ", "auto:contract": "авто · умова",
  "auto:obligation": "авто · обов'язок", "auto:required_missing": "авто · бракує підстави", "auto:pending_doc": "авто · перевірка файлу",
  "auto:payroll_change": "авто · виплати", "auto:review_required": "авто · перевірка", "auto:absence_unexplained": "авто · пропуск", "auto:candidate_stale": "авто · рекрутинг",
};
export const KIND_LABEL: Record<TaskKind, string> = { task: "задача", group: "групова", meeting: "зустріч" };
export const RULE_LABEL: Record<string, string> = {
  doc_expiring: "документ спливає", doc_expired: "документ прострочений", contract: "умова", obligation: "обовʼязок", required_missing: "бракує підстави",
  pending_doc: "перевірка файлу", payroll_change: "зміна виплат", review_required: "перевірка движка", absence_unexplained: "пропуск без пояснення", candidate_stale: "кандидат без руху",
};

// ── «Календар працівників» (GET /workers-calendar) ──
export type CalKind = "doc" | "contract" | "obligation" | "absence" | "birthday" | "start" | "end" | "task";
export interface CalEvent {
  id: string; kind: CalKind; date: string; title: string; detail?: string | null;
  workerId: number; workerName: string; factoryId: number | null; factoryName: string | null;
  severity: "info" | "warn" | "danger"; taskId?: number; docId?: number;
}
export const CAL_KINDS: CalKind[] = ["doc", "contract", "obligation", "absence", "birthday", "start", "end", "task"];
export const CAL_KIND_LABEL: Record<CalKind, string> = { doc: "документи", contract: "умови", obligation: "обовʼязки", absence: "відпрошування", birthday: "дні народження", start: "початок роботи", end: "кінець роботи", task: "задачі" };
// повні класи (Tailwind v4 сканує літерали); дарк — через CSS-змінні
export const CAL_KIND_CLS: Record<CalKind, string> = {
  doc: "bg-amber-100 text-amber-800", contract: "bg-violet-100 text-violet-800", obligation: "bg-rose-100 text-rose-800", absence: "bg-sky-100 text-sky-800",
  birthday: "bg-pink-100 text-pink-800", start: "bg-emerald-100 text-emerald-800", end: "bg-slate-200 text-slate-700", task: "bg-blue-100 text-blue-800",
};
export const CAL_KIND_DOT: Record<CalKind, string> = { doc: "bg-amber-500", contract: "bg-violet-500", obligation: "bg-rose-500", absence: "bg-sky-500", birthday: "bg-pink-500", start: "bg-emerald-500", end: "bg-slate-500", task: "bg-blue-500" };
export const fmtD = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");
export const fmtDShort = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "");
export const todayStr = () => new Date().toLocaleDateString("sv-SE");
export const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00"); x.setDate(x.getDate() + n); return x.toLocaleDateString("sv-SE"); };
export const weekdayIdx = (d: string) => (new Date(d + "T00:00:00").getDay() + 6) % 7; // 0=Пн
export const DAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
export const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
export const MONTHS_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];

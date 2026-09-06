// Чисті хелпери модуля «Задачі» (без БД і бота) — для юнітів і спільного коду.
import { addDaysStr } from "../lib/dates";

export type TaskKind = "task" | "group" | "meeting";
export type TaskStatus = "open" | "in_progress" | "review" | "done" | "cancelled" | "auto_resolved";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type Recurrence = { freq: "daily" | "weekly" | "monthly"; interval?: number; weekday?: number; monthday?: number; until?: string | null };
export type ChecklistItem = { id: string; text: string; done: boolean; doneBy?: number | null; doneAt?: string | null; auto?: string }; // auto — ключ авто-відмітки (taskResolve)

export const TASK_KINDS: TaskKind[] = ["task", "group", "meeting"];
export const TASK_STATUSES: TaskStatus[] = ["open", "in_progress", "review", "done", "cancelled", "auto_resolved"];
export const TASK_PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];
export const OPEN_STATUSES: TaskStatus[] = ["open", "in_progress", "review"];
export const CLOSED_STATUSES: TaskStatus[] = ["done", "cancelled", "auto_resolved"];
export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: "низький", normal: "звичайний", high: "високий", urgent: "терміново" };
export const DEFAULT_LADDER = [60, 30, 14, 7, 0];

export const warsawToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
export const fmtDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
export const dateStr = (v: unknown): string | null => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : v instanceof Date ? v.toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }) : String(v).slice(0, 10));
// різниця днів між двома YYYY-MM-DD (рядкова арифметика, без toISOString — CLAUDE.md)
export function diffDays(a: string, b: string): number {
  const p = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((p(a) - p(b)) / 86400000);
}
export const mdEsc = (s: string) => s.replace(/([_*[\]`])/g, "\\$1");

// Пріоритет автозадачі від днів до строку: ≤7 терміново, ≤14 високий, далі звичайний;
// прострочене — терміново.
export function priorityForDays(daysLeft: number | null): TaskPriority {
  if (daysLeft == null) return "normal";
  if (daysLeft <= 7) return "urgent";
  if (daysLeft <= 14) return "high";
  return "normal";
}

// Наступна дата повторюваної задачі (рядкова арифметика; monthly — той самий день
// місяця, коротший місяць → останній день).
export function nextOccurrence(from: string, r: Recurrence): string {
  const n = Math.max(1, r.interval ?? 1);
  if (r.freq === "daily") return addDaysStr(from, n);
  if (r.freq === "weekly") {
    if (r.weekday == null) return addDaysStr(from, 7 * n);
    for (let i = 1; i <= 7 * n + 7; i++) {
      const d = addDaysStr(from, i);
      const wd = ((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7) + 1; // 1=Пн … 7=Нд
      if (wd === r.weekday && i >= 7 * (n - 1) + 1) return d;
    }
    return addDaysStr(from, 7 * n);
  }
  const y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)), d = r.monthday ?? Number(from.slice(8, 10));
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function normalizeChecklist(items: (string | ChecklistItem)[] | undefined | null): ChecklistItem[] {
  return (items ?? []).map((c, i) => typeof c === "string" ? { id: `c${Date.now().toString(36)}${i}`, text: c, done: false } : { ...c, id: c.id || `c${Date.now().toString(36)}${i}` });
}

// Листування щодо пропуску (20.09.2026): офіс → працівник («Написати» на /absences, масове
// «Нагадати про невиправдані»), працівник → офіс (відповідь з бота, bot/handlers/absences.ts).
// Повідомлення офісу відкриває працівнику «вікно»: знову можна написати пояснення і додати
// файл — одноразовість початкового пояснення діє лише поки офіс не написав.
import {
  db, absenceMessagesTable, absenceAttachmentsTable, scheduleEntriesTable, scheduleWeeksTable, factoriesTable, workersTable, adminsTable,
  type Shift,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { entryDateStr, weekFromForMonth } from "../lib/dates";
import { logger } from "../lib/logger";

const fmtDate = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;

export interface AbsenceMessageRow { id: number; direction: "office" | "worker"; kind: string; text: string; adminName: string | null; createdAt: Date }

export async function absenceMessagesFor(entryIds: number[]): Promise<Map<number, AbsenceMessageRow[]>> {
  const map = new Map<number, AbsenceMessageRow[]>();
  if (!entryIds.length) return map;
  const rows = await db.select({ id: absenceMessagesTable.id, entryId: absenceMessagesTable.entryId, direction: absenceMessagesTable.direction, kind: absenceMessagesTable.kind, text: absenceMessagesTable.text, adminName: adminsTable.name, createdAt: absenceMessagesTable.createdAt })
    .from(absenceMessagesTable).leftJoin(adminsTable, eq(absenceMessagesTable.adminId, adminsTable.id))
    .where(inArray(absenceMessagesTable.entryId, entryIds)).orderBy(absenceMessagesTable.id);
  for (const r of rows) {
    const l = map.get(r.entryId) ?? []; l.push({ id: r.id, direction: r.direction as "office" | "worker", kind: r.kind, text: r.text, adminName: r.adminName ?? null, createdAt: r.createdAt }); map.set(r.entryId, l);
  }
  return map;
}

// «Вікно» працівника по пропуску: text — можна написати відповідь (є повідомлення офісу,
// новіше за останню відповідь працівника); file — можна додати файл (файлів ще нема, або є
// повідомлення офісу, новіше за останній файл).
export async function workerReplyWindow(entryId: number): Promise<{ text: boolean; file: boolean; lastOffice: AbsenceMessageRow | null }> {
  const msgs = (await absenceMessagesFor([entryId])).get(entryId) ?? [];
  const lastOffice = [...msgs].reverse().find(m => m.direction === "office") ?? null;
  const lastWorker = [...msgs].reverse().find(m => m.direction === "worker") ?? null;
  // перше пояснення (absence_reason, поставлене після нагадування) — теж відповідь працівника
  const [entry] = await db.select({ explainedAt: scheduleEntriesTable.absenceExplainedAt }).from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId));
  const lastWorkerAt = [lastWorker?.createdAt, entry?.explainedAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const [lastFile] = await db.select({ createdAt: absenceAttachmentsTable.createdAt }).from(absenceAttachmentsTable)
    .where(eq(absenceAttachmentsTable.entryId, entryId)).orderBy(desc(absenceAttachmentsTable.id)).limit(1);
  const text = !!lastOffice && (!lastWorkerAt || lastWorkerAt < lastOffice.createdAt);
  const file = !lastFile || (!!lastOffice && lastFile.createdAt < lastOffice.createdAt);
  return { text, file, lastOffice };
}

async function entryContext(entryId: number) {
  const [e] = await db.select({
    id: scheduleEntriesTable.id, workerId: scheduleEntriesTable.workerId, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift,
    status: scheduleEntriesTable.status, reason: scheduleEntriesTable.absenceReason, weekStart: scheduleWeeksTable.weekStart, factoryName: factoriesTable.name,
    telegramId: workersTable.telegramId, language: workersTable.language, name: workersTable.fullName,
  }).from(scheduleEntriesTable)
    .innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(eq(scheduleEntriesTable.id, entryId));
  if (!e || !e.workerId) return null;
  return { ...e, workerId: e.workerId, date: entryDateStr(String(e.weekStart), e.day) };
}

// Кнопки працівнику під повідомленням офісу: відповісти текстом / додати файл (bot/handlers/absences.ts)
async function workerKeyboard(lang: string, entryId: number) {
  const { t, asLang } = await import("../bot/i18n");
  const L = asLang(lang);
  return { inline_keyboard: [[{ text: t(L, "wabs.replyBtn"), callback_data: `wabs:re:${entryId}` }, { text: t(L, "wabs.attachBtn"), callback_data: `wabs:att:${entryId}` }]] };
}

// Офіс → працівник: зберегти й надіслати в бот мовою працівника. Повертає, чи дійшло в Telegram.
export async function sendAbsenceMessage(opts: { entryId: number; adminId: number | null; text: string; kind?: "message" | "reminder" }): Promise<{ sent: boolean; workerName: string | null }> {
  const e = await entryContext(opts.entryId);
  if (!e) throw new Error("Пропуск не знайдено");
  if (e.status !== "absent") throw new Error("Це не пропуск");
  const text = opts.text.trim();
  if (!text) throw new Error("Порожнє повідомлення");
  await db.insert(absenceMessagesTable).values({ entryId: e.id, workerId: e.workerId, direction: "office", kind: opts.kind ?? "message", text, adminId: opts.adminId });
  if (!e.telegramId) return { sent: false, workerName: e.name };
  try {
    const { bot } = await import("../bot/instance");
    const { t, asLang } = await import("../bot/i18n");
    const { mdSafe } = await import("../bot/display");
    const L = asLang(e.language);
    await bot.telegram.sendMessage(e.telegramId,
      t(L, "wabs.officeMsg", { date: fmtDate(e.date), shift: t(L, "hr.shiftN", { n: e.shift as Shift }), factory: mdSafe(e.factoryName ?? "—"), text: mdSafe(text) }),
      { parse_mode: "Markdown", reply_markup: await workerKeyboard(e.language ?? "uk", e.id) });
    return { sent: true, workerName: e.name };
  } catch (err: any) {
    logger.warn({ err: err?.message, entryId: e.id }, "absence message to worker failed");
    return { sent: false, workerName: e.name };
  }
}

// Масове нагадування про невиправдані пропуски місяця (рішення власника 20.09.2026): одне
// повідомлення на людину — інструкція + список пропусків без виправдання зі статусом
// (без пояснення / є пояснення без файлу / є файл) і кнопками «Пояснити» / «Відповісти» /
// «Додати файл». Кожному пропуску пишеться office-рядок kind=reminder — відкриває вікно
// повторного пояснення й файлу. justified (виправдано адміном) — не чіпаємо.
export async function remindUnexcusedAbsences(month: string, adminId: number | null, opts: { workerIds?: number[] } = {}): Promise<{ workers: number; absences: number; noTelegram: string[] }> {
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  const rows = await db.select({
    id: scheduleEntriesTable.id, workerId: scheduleEntriesTable.workerId, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift,
    reason: scheduleEntriesTable.absenceReason, excused: scheduleEntriesTable.absenceExcused, weekStart: scheduleWeeksTable.weekStart, factoryName: factoriesTable.name,
    telegramId: workersTable.telegramId, language: workersTable.language, name: workersTable.fullName, isActive: workersTable.isActive,
  }).from(scheduleEntriesTable)
    .innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(eq(scheduleEntriesTable.status, "absent"), eq(scheduleWeeksTable.status, "approved"),
      gte(scheduleWeeksTable.weekStart, weekFromForMonth(monthStart)), lt(scheduleWeeksTable.weekStart, monthEnd)));
  const items = rows
    .map(r => ({ ...r, date: entryDateStr(String(r.weekStart), r.day) }))
    .filter(r => r.workerId != null && r.isActive && !r.excused && r.date >= monthStart && r.date < monthEnd)
    .filter(r => !opts.workerIds || opts.workerIds.includes(r.workerId!))
    .sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));
  const byWorker = new Map<number, typeof items>();
  for (const it of items) { const l = byWorker.get(it.workerId!) ?? []; l.push(it); byWorker.set(it.workerId!, l); }
  if (!byWorker.size) return { workers: 0, absences: 0, noTelegram: [] };
  const files = await db.select({ entryId: absenceAttachmentsTable.entryId }).from(absenceAttachmentsTable).where(inArray(absenceAttachmentsTable.entryId, items.map(i => i.id)));
  const hasFile = new Set(files.map(f => f.entryId));
  const { bot } = await import("../bot/instance");
  const { t, asLang, DATE_LOCALE } = await import("../bot/i18n");
  const { mdSafe } = await import("../bot/display");
  const out = { workers: 0, absences: 0, noTelegram: [] as string[] };
  for (const [workerId, list] of byWorker) {
    const w = list[0]!;
    if (!w.telegramId) { out.noTelegram.push(w.name ?? `#${workerId}`); continue; }
    const L = asLang(w.language);
    const monthLabel = new Date(`${month}-01T00:00:00`).toLocaleDateString(DATE_LOCALE[L], { month: "long", year: "numeric" });
    const sh = (s: string) => t(L, "hr.shiftN", { n: s });
    const lines = list.map(i => t(L, "wabs.remindItem", {
      date: fmtDate(i.date), shift: sh(i.shift), factory: mdSafe(i.factoryName ?? "—"),
      status: t(L, !i.reason ? "wabs.stNoReason" : hasFile.has(i.id) ? "wabs.stFile" : "wabs.stReason"),
    })).join("");
    const kb: { text: string; callback_data: string }[][] = [];
    for (const i of list) {
      const row: { text: string; callback_data: string }[] = [];
      row.push(!i.reason
        ? { text: t(L, "wabs.explainBtn", { date: fmtDate(i.date), shift: sh(i.shift) }), callback_data: `wabs:ex:${i.id}` }
        : { text: t(L, "wabs.replyListBtn", { date: fmtDate(i.date), shift: sh(i.shift) }), callback_data: `wabs:re:${i.id}` });
      row.push({ text: t(L, "wabs.attachListBtn", { date: fmtDate(i.date), shift: sh(i.shift) }), callback_data: `wabs:att:${i.id}` });
      kb.push(row);
    }
    // office-рядок на кожен пропуск — відкриває вікно відповіді/файлу
    await db.insert(absenceMessagesTable).values(list.map(i => ({ entryId: i.id, workerId, direction: "office", kind: "reminder", text: `Нагадування про невиправдані пропуски за ${month}`, adminId })));
    try {
      await bot.telegram.sendMessage(w.telegramId, t(L, "wabs.remindTitle", { month: monthLabel }) + lines, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb.slice(0, 20) } });
      out.workers++; out.absences += list.length;
    } catch (err: any) {
      logger.warn({ err: err?.message, workerId }, "absence reminder failed");
      out.noTelegram.push(w.name ?? `#${workerId}`);
    }
  }
  return out;
}

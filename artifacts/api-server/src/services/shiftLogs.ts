// Відмітки зміни працівником на фабриці з тижневим обліком (factories.weekly_hours,
// 26.10.2026, рішення власника — «на такій же засаді, як контроль водія»): фабрика без
// довозу, тож на старті зміни працівник отримує пуш з кнопками «▶️ Приступив» /
// «🚫 Відсутній», після старту — повідомлення з кнопкою «⏹ Закінчив». Час — «зараз»
// або вибраний раніший (крок 15 хв). Кнопки діють 24 години; пуш, який не клікнули,
// також гасне, щойно приходить пуш наступної зміни. Відкрита зміна, не закрита за
// 24 години, зараховується як 1 година (status=auto) — офіс коригує в обліку.
//
// Рядок = запис графіку (unique entry_id); дата зміни = дата запису, тож нічна зміна,
// закрита після опівночі, лягає на свій день. Відкрита зміна шукається по
// ended_at IS NULL, а не по сьогоднішній даті. Закриття пише у запис графіку
// status=present + hours_override — колонка «їх години» обліку й сводна читають
// графік як раніше.
//
// Усі моменти — справжні Date (Drizzle мапить у настінний Europe/Warsaw сам);
// вибраний працівником настінний час → момент через fromWarsawWall.
import {
  db, workersTable, factoriesTable, scheduleEntriesTable, scheduleWeeksTable, workerShiftLogsTable,
  fromWarsawWall, toWarsawWall, type Shift, type DayOfWeek,
} from "@workspace/db";
import { and, eq, lt, ne, isNotNull, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { bot } from "../bot/instance";
import { t, asLang, dayShort, type Lang } from "../bot/i18n";
import { mdSafe } from "../bot/display";
import { factoryShifts, nowWarsaw, warsawDateStr } from "../bot/time";
import { loadDateShiftOverrides, shiftOverrideKey } from "./shiftOverrides";
import { resolveWeekRow } from "./weeks";
import { getCurrentMonday } from "./scheduleGenerator";
import { entryDateStr, DAYS } from "../lib/dates";
import { hoursBetween, ddmm, roundQuarter } from "../lib/weekMath";

export type ShiftLog = typeof workerShiftLogsTable.$inferSelect;

export const PROMPT_TTL_MS = 24 * 3_600_000;   // кнопки «приступив»/«закінчив» діють добу
const PROMPT_BEFORE_MIN = 10;                 // пуш за 10 хв до старту зміни…
const PROMPT_AFTER_MIN = 180;                 // …і не пізніше 3 год після (рестарт/простій крону)
export const AUTO_CLOSE_HOURS = 1;            // не закрив за добу → 1 год
export const PICK_STEP_MIN = 15;
const PICK_WINDOW_MS = 6 * 3_600_000;         // вибір часу «раніше» — до 6 год назад
const MAX_SHIFT_HOURS = 24;

const DOW_JS: Record<number, DayOfWeek> = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };

/** Настінний час «HH:MM» (Europe/Warsaw) для показу працівнику. */
export const wallHHMM = (d: Date) => toWarsawWall(d).slice(11, 16);
const wallDate = (d: Date) => toWarsawWall(d).slice(0, 10);

type FacRow = typeof factoriesTable.$inferSelect;

export async function weeklyFactories(): Promise<FacRow[]> {
  return db.select().from(factoriesTable).where(eq(factoriesTable.weeklyHours, true));
}

/** Час зміни на дату (разовий override має пріоритет над налаштуванням фабрики). */
export async function shiftTimeOn(fac: FacRow, date: string, shift: string): Promise<{ start: string; end: string } | null> {
  const ov = await loadDateShiftOverrides(date);
  return ov.get(shiftOverrideKey(fac.id, date, shift)) ?? factoryShifts(fac)[Number(shift) - 1] ?? null;
}

export const shiftLabel = (lang: Lang, shift: string, time?: { start: string; end: string } | null) =>
  `${t(lang, "hr.shiftN", { n: shift })}${time ? ` (${time.start}–${time.end})` : ""}`;

const dayLabel = (lang: Lang, date: string) => {
  const dow = new Date(date + "T00:00:00").getDay();
  return `${dayShort(lang, DOW_JS[dow]!)} ${ddmm(date)}`;
};

async function removeButtons(chatId: string | null, messageId: number | null) {
  if (!chatId || !messageId) return;
  try { await bot.telegram.editMessageReplyMarkup(chatId, messageId, undefined, undefined); } catch { /* повідомлення старе/видалене */ }
}

// ── Пуш на старті зміни (крон кожні 15 хв) ───────────────────────────────────
export async function promptShiftStarts(now: Date = new Date()): Promise<number> {
  const facs = await weeklyFactories();
  if (!facs.length) return 0;
  const todayStr = warsawDateStr();
  const { addDaysStr } = await import("../lib/dates");
  const { mondayOf } = await import("../lib/weekMath");
  let sent = 0;
  // сьогодні + вчора: зміна о 23:45, пропущена кроном, після опівночі ще в дозволеному вікні
  for (const dateStr of [todayStr, addDaysStr(todayStr, -1)]) {
  const dayName = DOW_JS[new Date(dateStr + "T00:00:00").getDay()]!;
  const weekRow = await resolveWeekRow(mondayOf(dateStr));
  if (!weekRow) continue;
  const dayOv = await loadDateShiftOverrides(dateStr);
  for (const fac of facs) {
    // лише розіслані (sent_at) записи: людина знає про зміну; відсутніх не питаємо
    const entries = await db.select({
      id: scheduleEntriesTable.id, workerId: scheduleEntriesTable.workerId, shift: scheduleEntriesTable.shift,
      status: scheduleEntriesTable.status, telegramId: workersTable.telegramId, language: workersTable.language,
    }).from(scheduleEntriesTable)
      .innerJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
      .where(and(
        eq(scheduleEntriesTable.weekId, weekRow.id), eq(scheduleEntriesTable.factoryId, fac.id),
        eq(scheduleEntriesTable.dayOfWeek, dayName), ne(scheduleEntriesTable.status, "absent"),
        isNotNull(scheduleEntriesTable.sentAt), isNotNull(workersTable.telegramId),
      ));
    if (!entries.length) continue;
    const existing = new Set((await db.select({ entryId: workerShiftLogsTable.entryId }).from(workerShiftLogsTable)
      .where(inArray(workerShiftLogsTable.entryId, entries.map(e => e.id)))).map(r => r.entryId));
    for (const e of entries) {
      if (existing.has(e.id)) continue;
      const st = dayOv.get(shiftOverrideKey(fac.id, dateStr, e.shift)) ?? factoryShifts(fac)[Number(e.shift) - 1];
      if (!st) continue;
      const startAt = fromWarsawWall(`${dateStr} ${st.start}:00`);
      const diffMin = (now.getTime() - startAt.getTime()) / 60_000;
      if (diffMin < -PROMPT_BEFORE_MIN || diffMin > PROMPT_AFTER_MIN) continue;
      // новий пуш гасить попередні, які людина так і не клікнула (рішення власника)
      await expireWorkerPending(e.workerId, e.id);
      const [log] = await db.insert(workerShiftLogsTable).values({
        workerId: e.workerId, factoryId: fac.id, entryId: e.id, workDate: dateStr, shift: e.shift,
        status: "pending", promptSentAt: now,
      }).onConflictDoNothing({ target: workerShiftLogsTable.entryId }).returning();
      if (!log) continue; // паралельний тік уже вставив
      const lang = asLang(e.language);
      try {
        const msg = await bot.telegram.sendMessage(e.telegramId!, t(lang, "wsl.prompt", {
          factory: mdSafe(fac.name), date: dayLabel(lang, dateStr), shift: shiftLabel(lang, e.shift, st),
        }), { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: t(lang, "wsl.btnStart"), callback_data: `wsl:start:${log.id}` }],
          [{ text: t(lang, "wsl.btnAbsent"), callback_data: `wsl:absent:${log.id}` }],
        ] } });
        await db.update(workerShiftLogsTable).set({ promptChatId: e.telegramId!, promptMessageId: msg.message_id, updatedAt: new Date() })
          .where(eq(workerShiftLogsTable.id, log.id));
        sent++;
      } catch (err) {
        // пуш не пішов (тимчасовий збій Telegram) — рядок прибираємо, наступний тік спробує знову
        logger.warn({ err, workerId: e.workerId }, "shift start prompt failed");
        await db.delete(workerShiftLogsTable).where(and(eq(workerShiftLogsTable.id, log.id), eq(workerShiftLogsTable.status, "pending")));
      }
      await new Promise(r => setTimeout(r, 40));
    }
  }
  }
  if (sent) logger.info({ sent }, "Shift start prompts sent");
  return sent;
}

/** Невідповіджені пуші працівника (крім поточного запису) → expired, кнопки зняти. */
async function expireWorkerPending(workerId: number, keepEntryId: number) {
  const rows = await db.select().from(workerShiftLogsTable)
    .where(and(eq(workerShiftLogsTable.workerId, workerId), eq(workerShiftLogsTable.status, "pending")));
  for (const r of rows) {
    if (r.entryId === keepEntryId) continue;
    const [u] = await db.update(workerShiftLogsTable).set({ status: "expired", updatedAt: new Date() })
      .where(and(eq(workerShiftLogsTable.id, r.id), eq(workerShiftLogsTable.status, "pending"))).returning({ id: workerShiftLogsTable.id });
    if (u) await removeButtons(r.promptChatId, r.promptMessageId);
  }
}

// ── Протухання (крон кожні 15 хв): pending > 24 год → expired; open > 24 год → auto (1 год) ──
export async function expireStaleLogs(now: Date = new Date()): Promise<{ expired: number; auto: number }> {
  const cutoff = new Date(now.getTime() - PROMPT_TTL_MS);
  let expired = 0, auto = 0;
  const stale = await db.select().from(workerShiftLogsTable)
    .where(and(eq(workerShiftLogsTable.status, "pending"), lt(workerShiftLogsTable.promptSentAt, cutoff)));
  for (const r of stale) {
    // умовний UPDATE: між select і update людина могла натиснути «приступив»
    const [u] = await db.update(workerShiftLogsTable).set({ status: "expired", updatedAt: now })
      .where(and(eq(workerShiftLogsTable.id, r.id), eq(workerShiftLogsTable.status, "pending"))).returning({ id: workerShiftLogsTable.id });
    if (!u) continue;
    await removeButtons(r.promptChatId, r.promptMessageId);
    expired++;
  }
  const open = await db.select().from(workerShiftLogsTable)
    .where(and(eq(workerShiftLogsTable.status, "open"), lt(workerShiftLogsTable.startedAt, cutoff)));
  for (const r of open) {
    if (await autoClose(r, now)) auto++;
  }
  if (expired || auto) logger.info({ expired, auto }, "Shift logs expired/auto-closed");
  return { expired, auto };
}

async function autoClose(log: ShiftLog, now: Date): Promise<boolean> {
  const endedAt = new Date(log.startedAt!.getTime() + AUTO_CLOSE_HOURS * 3_600_000);
  const [upd] = await db.update(workerShiftLogsTable).set({
    status: "auto", endedAt, endSource: "auto", hours: AUTO_CLOSE_HOURS, updatedAt: now,
  }).where(and(eq(workerShiftLogsTable.id, log.id), eq(workerShiftLogsTable.status, "open"))).returning();
  if (!upd) return false; // встиг закрити сам
  await removeButtons(log.endChatId, log.endMessageId);
  await applyToEntry(upd);
  const [w] = await db.select({ telegramId: workersTable.telegramId, language: workersTable.language })
    .from(workersTable).where(eq(workersTable.id, log.workerId));
  if (w?.telegramId) {
    const lang = asLang(w.language);
    try {
      await bot.telegram.sendMessage(w.telegramId, t(lang, "wsl.autoClosed", { date: dayLabel(lang, String(log.workDate)), hours: AUTO_CLOSE_HOURS }), { parse_mode: "Markdown" });
    } catch { /* ignore */ }
  }
  return true;
}

// ── Дії працівника ───────────────────────────────────────────────────────────
export async function getLog(id: number): Promise<ShiftLog | undefined> {
  const [r] = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.id, id));
  return r;
}

/** Межі вибору часу старту: від (старт зміни − 2 год) / (зараз − 6 год) до зараз. */
export async function startPickRange(log: ShiftLog, now: Date): Promise<{ from: Date; to: Date }> {
  const [fac] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, log.factoryId));
  const st = fac ? await shiftTimeOn(fac, String(log.workDate), log.shift) : null;
  const shiftStart = st ? fromWarsawWall(`${log.workDate} ${st.start}:00`) : null;
  const floor = new Date(now.getTime() - PICK_WINDOW_MS);
  const from = shiftStart ? new Date(Math.max(shiftStart.getTime() - 2 * 3_600_000, floor.getTime())) : floor;
  return { from, to: now };
}

/** Межі вибору часу кінця: від (старт + 15 хв) / (зараз − 6 год) до зараз. */
export function endPickRange(log: ShiftLog, now: Date): { from: Date; to: Date } {
  const started = log.startedAt!.getTime();
  const from = new Date(Math.max(started + PICK_STEP_MIN * 60_000, now.getTime() - PICK_WINDOW_MS));
  return { from, to: now };
}

/** Варіанти часу кроком 15 хв (настінні підписи), від пізнішого до ранішого. */
export function timeOptions(range: { from: Date; to: Date }): { label: string; epochMin: number }[] {
  const step = PICK_STEP_MIN * 60_000;
  const last = Math.floor(range.to.getTime() / step) * step;
  const out: { label: string; epochMin: number }[] = [];
  for (let ms = last; ms >= range.from.getTime() && out.length < 24; ms -= step) {
    const d = new Date(ms);
    out.push({ label: wallHHMM(d), epochMin: Math.round(ms / 60_000) });
  }
  return out;
}

export type StartResult = { ok: true; log: ShiftLog } | { ok: false; reason: "expired" | "state" | "future" | "early" };

export async function startLog(logId: number, at: Date, source: "now" | "manual", now: Date = new Date()): Promise<StartResult> {
  const log = await getLog(logId);
  if (!log) return { ok: false, reason: "expired" };
  if (log.status !== "pending") return { ok: false, reason: log.status === "expired" ? "expired" : "state" };
  if (log.promptSentAt && now.getTime() - log.promptSentAt.getTime() > PROMPT_TTL_MS) {
    await db.update(workerShiftLogsTable).set({ status: "expired", updatedAt: now }).where(eq(workerShiftLogsTable.id, log.id));
    return { ok: false, reason: "expired" };
  }
  if (at.getTime() > now.getTime() + 60_000) return { ok: false, reason: "future" };
  const range = await startPickRange(log, now);
  if (at.getTime() < range.from.getTime() - 60_000) return { ok: false, reason: "early" };
  const [upd] = await db.update(workerShiftLogsTable).set({
    status: "open", startedAt: at, startSource: source, updatedAt: now,
  }).where(and(eq(workerShiftLogsTable.id, log.id), eq(workerShiftLogsTable.status, "pending"))).returning();
  if (!upd) return { ok: false, reason: "state" }; // паралельний клік/крон уже змінив статус
  await removeButtons(log.promptChatId, log.promptMessageId);
  return { ok: true, log: upd };
}

/** Після старту: повідомлення з кнопкою «Закінчив» (діє 24 год від старту). */
export async function sendEndPrompt(log: ShiftLog, lang: Lang, chatId: string): Promise<void> {
  const [fac] = await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, log.factoryId));
  try {
    const msg = await bot.telegram.sendMessage(chatId, t(lang, "wsl.started", {
      time: wallHHMM(log.startedAt!), factory: mdSafe(fac?.name ?? ""), date: dayLabel(lang, String(log.workDate)),
    }), { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "wsl.btnEnd"), callback_data: `wsl:end:${log.id}` }]] } });
    await db.update(workerShiftLogsTable).set({ endChatId: chatId, endMessageId: msg.message_id, updatedAt: new Date() })
      .where(eq(workerShiftLogsTable.id, log.id));
  } catch (err) { logger.warn({ err, logId: log.id }, "end prompt failed"); }
}

export type EndResult = { ok: true; log: ShiftLog } | { ok: false; reason: "expired" | "state" | "future" | "early" | "long" };

export async function endLog(logId: number, at: Date, source: "now" | "manual", now: Date = new Date()): Promise<EndResult> {
  const log = await getLog(logId);
  if (!log || !log.startedAt) return { ok: false, reason: "expired" };
  if (log.status !== "open") return { ok: false, reason: log.status === "auto" ? "expired" : "state" };
  if (now.getTime() - log.startedAt.getTime() > PROMPT_TTL_MS) return { ok: false, reason: "expired" }; // крон закриє як auto
  if (at.getTime() > now.getTime() + 60_000) return { ok: false, reason: "future" };
  if (at.getTime() <= log.startedAt.getTime()) return { ok: false, reason: "early" };
  const hours = hoursBetween(log.startedAt, at);
  if (hours > MAX_SHIFT_HOURS) return { ok: false, reason: "long" };
  const [upd] = await db.update(workerShiftLogsTable).set({
    status: "closed", endedAt: at, endSource: source, hours: Math.max(0.25, hours), updatedAt: now,
  }).where(and(eq(workerShiftLogsTable.id, log.id), eq(workerShiftLogsTable.status, "open"))).returning();
  if (!upd) return { ok: false, reason: "state" };
  await removeButtons(log.endChatId, log.endMessageId);
  await applyToEntry(upd);
  return { ok: true, log: upd };
}

export async function markAbsent(logId: number, now: Date = new Date()): Promise<{ ok: true; log: ShiftLog } | { ok: false; reason: "expired" | "state" }> {
  const log = await getLog(logId);
  if (!log) return { ok: false, reason: "expired" };
  if (log.status !== "pending") return { ok: false, reason: log.status === "expired" ? "expired" : "state" };
  if (log.promptSentAt && now.getTime() - log.promptSentAt.getTime() > PROMPT_TTL_MS) {
    await db.update(workerShiftLogsTable).set({ status: "expired", updatedAt: now })
      .where(and(eq(workerShiftLogsTable.id, log.id), eq(workerShiftLogsTable.status, "pending")));
    return { ok: false, reason: "expired" };
  }
  const [upd] = await db.update(workerShiftLogsTable).set({ status: "absent", updatedAt: now })
    .where(and(eq(workerShiftLogsTable.id, log.id), eq(workerShiftLogsTable.status, "pending"))).returning();
  if (!upd) return { ok: false, reason: "state" };
  await removeButtons(log.promptChatId, log.promptMessageId);
  await applyToEntry(upd);
  return { ok: true, log: upd };
}

// ── Офіс: правка часу/годин (веб, вкладка тижня) ─────────────────────────────
export async function officeSetLog(
  id: number, patch: { startedAt?: string | null; endedAt?: string | null; hours?: number | null },
): Promise<ShiftLog | undefined> {
  const log = await getLog(id);
  if (!log) return undefined;
  const set: Partial<typeof workerShiftLogsTable.$inferInsert> = { updatedAt: new Date() };
  if (patch.startedAt !== undefined) { set.startedAt = patch.startedAt ? fromWarsawWall(patch.startedAt) : null; set.startSource = patch.startedAt ? "office" : null; }
  if (patch.endedAt !== undefined) { set.endedAt = patch.endedAt ? fromWarsawWall(patch.endedAt) : null; set.endSource = patch.endedAt ? "office" : null; }
  const started = set.startedAt !== undefined ? set.startedAt : log.startedAt;
  const ended = set.endedAt !== undefined ? set.endedAt : log.endedAt;
  if (patch.hours != null && Number.isFinite(patch.hours)) set.hours = roundQuarter(Math.max(0, Math.min(MAX_SHIFT_HOURS, patch.hours)));
  else if (started && ended) set.hours = Math.max(0.25, hoursBetween(started, ended));
  if (started && ended) set.status = "closed";
  else if (started) set.status = "open";
  const [upd] = await db.update(workerShiftLogsTable).set(set).where(eq(workerShiftLogsTable.id, id)).returning();
  if (upd && (upd.status === "closed" || upd.status === "auto")) await applyToEntry(upd);
  return upd;
}

/** Закриття/відсутність → запис графіку (present + hours_override / absent). */
async function applyToEntry(log: ShiftLog) {
  if (!log.entryId) return;
  if (log.status === "closed" || log.status === "auto") {
    await db.update(scheduleEntriesTable).set({ status: "present", hoursOverride: log.hours ?? null })
      .where(eq(scheduleEntriesTable.id, log.entryId));
  } else if (log.status === "absent") {
    await db.update(scheduleEntriesTable).set({ status: "absent", absenceReason: "Відмітив(ла) себе відсутнім у боті" })
      .where(and(eq(scheduleEntriesTable.id, log.entryId), ne(scheduleEntriesTable.status, "absent")));
  }
}

/** Логи працівників фабрики за дати (вкладка тижня / текст запиту рапорту). */
export async function logsForDates(factoryId: number, dates: string[]): Promise<ShiftLog[]> {
  if (!dates.length) return [];
  return db.select().from(workerShiftLogsTable)
    .where(and(eq(workerShiftLogsTable.factoryId, factoryId), inArray(workerShiftLogsTable.workDate, dates)));
}

/** Дата запису графіку (для ручних логів з офісу). */
export async function entryDate(entryId: number): Promise<string | null> {
  const [r] = await db.select({ day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart })
    .from(scheduleEntriesTable).innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(eq(scheduleEntriesTable.id, entryId));
  return r ? entryDateStr(String(r.weekStart), r.day) : null;
}

export { DAYS, wallDate };
export type { Shift };

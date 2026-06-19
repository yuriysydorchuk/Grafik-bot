import cron, { type ScheduledTask } from "node-cron";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, adminsTable, factoriesTable,
  scheduleWeeksTable, scheduleEntriesTable, driverShiftAssignmentsTable, notificationsTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and, lt, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sendAlert } from "../lib/alerts";
import { bot } from "../bot";
import { getWorkersWhoHaventSubmitted } from "./sheets";
import { getNextMonday, getCurrentMonday, formatWeekStart } from "./scheduleGenerator";
import { factoryShifts } from "../bot/time";
import { t, asLang } from "../bot/i18n";

// All cron times in Europe/Warsaw timezone
const TZ = "Europe/Warsaw";

const DAY_OF_WEEK_JS: Record<number, DayOfWeek> = {
  0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat",
};
const SHIFT_LABELS: Record<Shift, string> = {
  "1": "1 зміна", "2": "2 зміна", "3": "3 зміна", "4": "4 зміна", "5": "5 зміна", "6": "6 зміна",
};

// ─── Dedup tracker ────────────────────────────────────────────────────────────
// Key: `{factoryId}_{shift}_{YYYY-MM-DD}` — prevents double-sending on multiple cron ticks
const sentToday = new Set<string>();

// ─── Tasks ────────────────────────────────────────────────────────────────────

let weeklyReminderTask: ScheduledTask | null = null;
let preShiftTask: ScheduledTask | null = null;
let midnightResetTask: ScheduledTask | null = null;
let prunePruneTask: ScheduledTask | null = null;
let reminderHour = 18;

export function getReminderHour(): number { return reminderHour; }

export function startScheduler() {
  stopScheduler();

  // Weekly availability reminder — Sunday at `reminderHour`:00 Warsaw
  weeklyReminderTask = cron.schedule(
    `0 ${reminderHour} * * 0`,
    async () => {
      logger.info("⏰ Running weekly availability reminder");
      await sendWeeklyReminders();
    },
    { timezone: TZ },
  );

  // Pre-shift check every 15 minutes
  preShiftTask = cron.schedule(
    "*/15 * * * *",
    async () => { await checkPreShiftNotifications(); },
    { timezone: TZ },
  );

  // Reset dedup tracker at midnight Warsaw time
  midnightResetTask = cron.schedule(
    "0 0 * * *",
    () => { sentToday.clear(); logger.info("Pre-shift dedup tracker reset"); },
    { timezone: TZ },
  );

  // Daily housekeeping at 04:00 Warsaw: prune chat-tracking rows + old notifications
  prunePruneTask = cron.schedule(
    "0 4 * * *",
    async () => {
      try { const { pruneOldMessageRows } = await import("../bot/chat"); await pruneOldMessageRows(); } catch { /* ignore */ }
      await pruneNotifications();
    },
    { timezone: TZ },
  );

  pruneNotifications(); // run once on boot so the table is bounded immediately

  logger.info({ cron: `0 ${reminderHour} * * 0`, tz: TZ }, "Weekly reminder scheduler started");
  logger.info({ cron: "*/15 * * * * (Warsaw)", tz: TZ }, "Pre-shift notification checker started");
}

// Keep the notification center bounded: drop entries older than 30 days, and cap the
// table to the most recent 300 (per-admin read state lives in notifications.readBy).
async function pruneNotifications(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.delete(notificationsTable).where(lt(notificationsTable.createdAt, cutoff));
    const recent = await db.select({ id: notificationsTable.id }).from(notificationsTable).orderBy(desc(notificationsTable.id)).limit(300);
    if (recent.length === 300) {
      await db.delete(notificationsTable).where(lt(notificationsTable.id, recent[299]!.id));
    }
  } catch (e: any) {
    logger.error({ err: e }, "prune notifications failed");
    void sendAlert({ service: "cron", kind: e?.name, source: "pruneNotifications", message: e?.message ?? String(e) });
  }
}

export function stopScheduler() {
  weeklyReminderTask?.stop(); weeklyReminderTask = null;
  preShiftTask?.stop();       preShiftTask = null;
  midnightResetTask?.stop();  midnightResetTask = null;
  prunePruneTask?.stop();     prunePruneTask = null;
}

export function setReminderHour(hour: number) {
  reminderHour = hour;
  startScheduler();
  logger.info({ hour, tz: TZ }, "Reminder hour updated");
}

// ─── Pre-shift notifications ──────────────────────────────────────────────────

// Returns minutes until shift start in Warsaw time, handling midnight wrap.
function minutesUntilShift(nowWarsawMs: number, shiftTimeStr: string): number {
  const [hh, mm] = shiftTimeStr.split(":").map(Number);
  const now = new Date(nowWarsawMs);
  const shiftToday = new Date(nowWarsawMs);
  shiftToday.setHours(hh!, mm!, 0, 0);
  let diff = (shiftToday.getTime() - now.getTime()) / 60000;
  // Handle cross-midnight: if shift is "yesterday" relative to now (e.g., notify at 23:xx for 01:xx next day)
  if (diff < -120) diff += 24 * 60;
  return diff;
}

async function checkPreShiftNotifications() {
  try {
    // Current Warsaw time
    const nowWarsaw = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
    const nowMs = nowWarsaw.getTime();
    const todayStr = nowWarsaw.toISOString().split("T")[0]!;
    const dayName = DAY_OF_WEEK_JS[nowWarsaw.getDay()]!;
    const week = getCurrentMonday();

    const weeks = await db.select().from(scheduleWeeksTable)
      .where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
    if (weeks.length === 0) return;
    const weekId = weeks[0]!.id;

    const factories = await db.select().from(factoriesTable);

    for (const factory of factories) {
      // Use the jsonb `shifts` (falls back to legacy columns) so web-created factories
      // and shifts 4–6 are covered, not just legacy shift1/2/3Start.
      const shiftTimes: Array<{ shift: Shift; start: string | null }> = factoryShifts(factory)
        .slice(0, Math.min(6, Math.max(1, factory.shiftCount ?? 3)))
        .map((st, i) => ({ shift: String(i + 1) as Shift, start: st.start }));

      for (const { shift, start } of shiftTimes) {
        if (!start) continue; // no time configured for this shift at this factory

        const minsUntil = minutesUntilShift(nowMs, start);
        // Notify within a 14-minute window centred on 120 min before shift
        if (minsUntil < 106 || minsUntil > 134) continue;

        const key = `${factory.id}_${shift}_${todayStr}`;
        if (sentToday.has(key)) continue;
        sentToday.add(key);

        await sendFactoryShiftReminder(weekId, factory.id, factory.name, shift, dayName, start);
      }
    }
  } catch (e: any) {
    logger.error({ err: e }, "Error in pre-shift check");
    void sendAlert({ service: "cron", kind: e?.name, source: "preShiftCheck", message: e?.message ?? String(e) });
  }
}

async function sendFactoryShiftReminder(
  weekId: number,
  factoryId: number,
  factoryName: string,
  shift: Shift,
  day: DayOfWeek,
  shiftStart: string,
) {
  const [hh] = shiftStart.split(":");
  const notifyTime = `${String((parseInt(hh!) - 2 + 24) % 24).padStart(2, "0")}:00`;

  // Workers for this factory+shift today
  const workers = await db
    .select({ telegramId: workersTable.telegramId, name: workersTable.fullName, language: workersTable.language })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(
      eq(scheduleEntriesTable.weekId, weekId),
      eq(scheduleEntriesTable.factoryId, factoryId),
      eq(scheduleEntriesTable.dayOfWeek, day),
      eq(scheduleEntriesTable.shift, shift),
      eq(scheduleEntriesTable.status, "scheduled"),
    ));

  let notified = 0;
  for (const w of workers) {
    if (!w.telegramId) continue;
    const lang = asLang(w.language);
    try {
      await bot.telegram.sendMessage(
        w.telegramId,
        t(lang, "notif.reminder", { shift: t(lang, "hr.shiftN", { n: shift }), time: shiftStart, factory: factoryName }),
        { parse_mode: "Markdown" },
      );
      notified++;
      await new Promise(r => setTimeout(r, 50));
    } catch { /* ignore */ }
  }

  // Driver for this factory+shift today
  const drivers = await db
    .select({ telegramId: driversTable.telegramId, name: driversTable.name })
    .from(driverShiftAssignmentsTable)
    .leftJoin(driversTable, eq(driverShiftAssignmentsTable.driverId, driversTable.id))
    .where(and(
      eq(driverShiftAssignmentsTable.weekId, weekId),
      eq(driverShiftAssignmentsTable.factoryId, factoryId),
      eq(driverShiftAssignmentsTable.dayOfWeek, day),
      eq(driverShiftAssignmentsTable.shift, shift),
    ));

  for (const d of drivers) {
    if (!d.telegramId) continue;
    try {
      await bot.telegram.sendMessage(
        d.telegramId,
        `🔔 *Нагадування*\n\nЧерез 2 години: *${SHIFT_LABELS[shift]}* (${shiftStart})\n🏭 ${factoryName} — ${workers.length} осіб\n\nНе забудьте відмітити явку!`,
        { parse_mode: "Markdown" },
      );
    } catch { /* ignore */ }
  }

  logger.info({ factoryName, shift, shiftStart, day, notified, drivers: drivers.length }, "Pre-shift reminders sent");
}

// ─── Weekly availability reminder ────────────────────────────────────────────

// Send the availability reminder to a specific set of workers (used by the dashboard button)
export async function remindAvailability(
  weekStart: string,
  workers: { telegramId: string | null; fullName: string; language?: string | null }[],
): Promise<{ notified: number; skipped: number }> {
  let notified = 0, skipped = 0;
  for (const w of workers) {
    if (!w.telegramId) { skipped++; continue; }
    const lang = asLang(w.language);
    try {
      await bot.telegram.sendMessage(
        w.telegramId,
        t(lang, "notif.availReminder", { week: formatWeekStart(weekStart), btn: t(lang, "menu.availability") }),
        { parse_mode: "Markdown" },
      );
      notified++;
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      logger.error({ err: e, worker: w.fullName }, "Failed to remind worker");
      skipped++;
    }
  }
  return { notified, skipped };
}

export async function sendWeeklyReminders(): Promise<{ notified: number; skipped: number }> {
  const nextWeek = getNextMonday();
  let notified = 0, skipped = 0;

  try {
    const missing = await getWorkersWhoHaventSubmitted(nextWeek);
    if (missing.length === 0) {
      logger.info({ week: nextWeek }, "All workers submitted — no reminders needed");
      return { notified: 0, skipped: 0 };
    }

    for (const worker of missing) {
      if (!worker.telegramId) { skipped++; continue; }
      const lang = asLang((worker as any).language);
      try {
        await bot.telegram.sendMessage(
          worker.telegramId,
          t(lang, "notif.availReminder", { week: formatWeekStart(nextWeek), btn: t(lang, "menu.availability") }),
          { parse_mode: "Markdown" },
        );
        notified++;
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        logger.error({ err: e, worker: worker.fullName }, "Failed to notify worker");
        skipped++;
      }
    }

    const admins = await db.select().from(adminsTable);
    for (const admin of admins) {
      if (!admin.telegramId) continue;
      try {
        await bot.telegram.sendMessage(
          admin.telegramId,
          `🤖 *Авто-нагадування*\n\nТиждень: ${formatWeekStart(nextWeek)}\n✅ Надіслано: ${notified}\n⚠️ Без Telegram: ${skipped}\n📭 Не заповнили: ${missing.length}`,
          { parse_mode: "Markdown" },
        );
      } catch { /* ignore */ }
    }

    logger.info({ week: nextWeek, notified, skipped }, "Weekly reminders sent");
  } catch (e: any) {
    logger.error({ err: e }, "Error in weekly reminder job");
    void sendAlert({ service: "cron", kind: e?.name, source: "weeklyReminder", message: e?.message ?? String(e) });
  }

  return { notified, skipped };
}

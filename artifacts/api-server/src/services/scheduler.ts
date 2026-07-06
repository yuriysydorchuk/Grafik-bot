import cron, { type ScheduledTask } from "node-cron";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, adminsTable, factoriesTable,
  scheduleWeeksTable, scheduleEntriesTable, driverShiftAssignmentsTable, driverTripsTable, notificationsTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and, lt, desc, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sendAlert } from "../lib/alerts";
import { bot } from "../bot";
import { getWorkersWhoHaventSubmitted } from "./sheets";
import { getNextMonday, getCurrentMonday, formatWeekStart } from "./scheduleGenerator";
import { factoryShifts, factoryShiftStart, nowWarsaw, warsawDateStr } from "../bot/time";
import { t, asLang, tb, oLang } from "../bot/i18n";

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
let pickupGapTask: ScheduledTask | null = null;
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

  // Pre-shift check every 15 minutes (+ forgotten-arrival reminders for drivers)
  preShiftTask = cron.schedule(
    "*/15 * * * *",
    async () => { await checkPreShiftNotifications(); await checkForgottenArrivals(); },
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

  // Daily 19:00 Warsaw: check TOMORROW's pickup gaps («Забрати зі зміни») and
  // message the head driver with quick-assign buttons.
  pickupGapTask = cron.schedule(
    "0 19 * * *",
    async () => { await notifyHeadDriverPickupGaps(); },
    { timezone: TZ },
  );

  pruneNotifications(); // run once on boot so the table is bounded immediately

  logger.info({ cron: `0 ${reminderHour} * * 0`, tz: TZ }, "Weekly reminder scheduler started");
  logger.info({ cron: "*/15 * * * * (Warsaw)", tz: TZ }, "Pre-shift notification checker started");
  logger.info({ cron: "0 19 * * * (Warsaw)", tz: TZ }, "Pickup-gap checker started");
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
  pickupGapTask?.stop();      pickupGapTask = null;
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
      const shiftTimes: Array<{ shift: Shift; start: string | null; end: string | null }> = factoryShifts(factory)
        .slice(0, Math.min(6, Math.max(1, factory.shiftCount ?? 3)))
        .map((st, i) => ({ shift: String(i + 1) as Shift, start: st.start, end: st.end }));

      for (const { shift, start, end } of shiftTimes) {
        if (!start) continue; // no time configured for this shift at this factory

        const minsUntil = minutesUntilShift(nowMs, start);
        // Notify within a 14-minute window centred on 120 min before shift
        if (minsUntil >= 106 && minsUntil <= 134) {
          const key = `${factory.id}_${shift}_${todayStr}`;
          if (!sentToday.has(key)) {
            sentToday.add(key);
            await sendFactoryShiftReminder(weekId, factory.id, factory.name, shift, dayName, start);
          }
        }

        // Pickup («Забрати зі зміни») reminder ~60 min before the shift ENDS.
        // For an overnight shift the assignment row lives on the day the shift
        // STARTED — cross-midnight/week-boundary cases are handled inside.
        if (end) {
          const minsUntilEnd = minutesUntilShift(nowMs, end);
          if (minsUntilEnd >= 46 && minsUntilEnd <= 74) {
            const key = `${factory.id}_${shift}_p_${todayStr}`;
            if (!sentToday.has(key)) {
              sentToday.add(key);
              await sendPickupReminder(factory.id, factory.name, shift, dayName, start, end);
            }
          }
        }
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
    .select({ telegramId: workersTable.telegramId, name: workersTable.fullName, language: workersTable.language, selfTransport: workersTable.selfTransport })
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

  // Self-transport workers get to work on their own → not counted for the driver.
  const driverPickupCount = workers.filter(w => !w.selfTransport).length;

  // Delivery driver for this factory+shift today (pickups get their own reminder)
  const drivers = await db
    .select({ telegramId: driversTable.telegramId, name: driversTable.name })
    .from(driverShiftAssignmentsTable)
    .leftJoin(driversTable, eq(driverShiftAssignmentsTable.driverId, driversTable.id))
    .where(and(
      eq(driverShiftAssignmentsTable.weekId, weekId),
      eq(driverShiftAssignmentsTable.factoryId, factoryId),
      eq(driverShiftAssignmentsTable.dayOfWeek, day),
      eq(driverShiftAssignmentsTable.shift, shift),
      eq(driverShiftAssignmentsTable.kind, "delivery"),
    ));

  for (const d of drivers) {
    if (!d.telegramId) continue;
    try {
      await bot.telegram.sendMessage(
        d.telegramId,
        `🔔 *Нагадування*\n\nЧерез 2 години: *${SHIFT_LABELS[shift]}* (${shiftStart})\n🏭 ${factoryName} — ${driverPickupCount} осіб\n\nНе забудьте відмітити явку!`,
        { parse_mode: "Markdown" },
      );
    } catch { /* ignore */ }
  }

  logger.info({ factoryName, shift, shiftStart, day, notified, drivers: drivers.length }, "Pre-shift reminders sent");
}

// Remind pickup drivers («Забрати зі зміни») ~1h before the shift ends.
// The assignment row lives on the day the shift STARTED: for an overnight shift
// (end <= start) that is the previous calendar day — possibly the previous week.
// Driver started a run («Почати поїздку» / boarding) but never pressed
// «🏭 Прибув на фабрику»: remind once, an hour after the delivered shift began.
// Window 60–300 min keeps it to the current run (no nagging about stale trips).
async function checkForgottenArrivals() {
  try {
    const today = warsawDateStr();
    const now = nowWarsaw();
    const trips = await db.select().from(driverTripsTable)
      .where(and(eq(driverTripsTable.tripDate, today), isNull(driverTripsTable.arrivedFactoryAt)));
    const open = trips.filter(t => t.pickupStartedAt);
    if (open.length === 0) return;
    const facs = await db.select().from(factoriesTable);
    const facById = new Map(facs.map(f => [f.id, f]));
    for (const trip of open) {
      const key = `arrfrgt_${trip.id}`;
      if (sentToday.has(key)) continue;
      const fac = facById.get(trip.factoryId);
      const [hh, mm] = factoryShiftStart(fac, trip.shift as Shift).split(":").map(Number);
      const [y, m, d] = today.split("-").map(Number);
      const start = new Date(y!, m! - 1, d!, hh ?? 6, mm ?? 0, 0, 0);
      const minsSinceStart = (now.getTime() - start.getTime()) / 60000;
      if (minsSinceStart < 60 || minsSinceStart > 300) continue;
      const [drv] = await db.select().from(driversTable).where(eq(driversTable.id, trip.driverId));
      if (!drv?.telegramId) continue;
      sentToday.add(key);
      try {
        const dl = oLang(drv.language);
        await bot.telegram.sendMessage(
          drv.telegramId,
          tb(dl, "⚠️ Ви почали поїздку ({factory} · {shift} зміна), але не натиснули «🏭 Прибув на фабрику».\n\nЯкщо ви вже на фабриці — натисніть кнопку в меню, щоб зафіксувати час прибуття.", { factory: fac?.name ?? "—", shift: trip.shift }),
        );
        logger.info({ tripId: trip.id, driverId: trip.driverId, factory: fac?.name, shift: trip.shift }, "Forgotten-arrival reminder sent");
      } catch { /* driver blocked the bot etc. — ignore */ }
    }
  } catch (e: any) {
    logger.error({ err: e }, "checkForgottenArrivals failed");
    void sendAlert({ service: "cron", kind: e?.name, source: "checkForgottenArrivals", message: e?.message ?? String(e) });
  }
}

async function sendPickupReminder(
  factoryId: number,
  factoryName: string,
  shift: Shift,
  todayName: DayOfWeek,
  shiftStart: string | null,
  shiftEnd: string,
) {
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h! * 60 + m!; };
  const crossesMidnight = shiftStart != null && toMin(shiftEnd) <= toMin(shiftStart);
  const dayOrder: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const assignDay = crossesMidnight ? dayOrder[(dayOrder.indexOf(todayName) + 6) % 7]! : todayName;
  // The shift started yesterday: if today is Monday, its week is the previous one.
  let weekStart = getCurrentMonday();
  if (crossesMidnight && todayName === "mon") {
    const d = new Date(weekStart + "T00:00:00");
    d.setDate(d.getDate() - 7);
    weekStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const weeks = await db.select().from(scheduleWeeksTable)
    .where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return;

  const rows = await db
    .select({ telegramId: driversTable.telegramId })
    .from(driverShiftAssignmentsTable)
    .leftJoin(driversTable, eq(driverShiftAssignmentsTable.driverId, driversTable.id))
    .where(and(
      eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id),
      eq(driverShiftAssignmentsTable.factoryId, factoryId),
      eq(driverShiftAssignmentsTable.dayOfWeek, assignDay),
      eq(driverShiftAssignmentsTable.shift, shift),
      eq(driverShiftAssignmentsTable.kind, "pickup"),
    ));
  if (rows.length === 0) return;

  const people = await db.select({ id: scheduleEntriesTable.id }).from(scheduleEntriesTable)
    .where(and(
      eq(scheduleEntriesTable.weekId, weeks[0]!.id),
      eq(scheduleEntriesTable.factoryId, factoryId),
      eq(scheduleEntriesTable.dayOfWeek, assignDay),
      eq(scheduleEntriesTable.shift, shift),
    ));

  let notified = 0;
  for (const r of rows) {
    if (!r.telegramId) continue;
    try {
      await bot.telegram.sendMessage(
        r.telegramId,
        `🔔 *Нагадування — забрати зі зміни*\n\nЧерез годину кінець зміни: *${SHIFT_LABELS[shift]}* (до ${shiftEnd})\n🏭 ${factoryName} — 👷 ${people.length}\n\n🔙 Будьте на фабриці на ${shiftEnd}, щоб забрати людей.`,
        { parse_mode: "Markdown" },
      );
      notified++;
      await new Promise(res => setTimeout(res, 50));
    } catch { /* ignore */ }
  }
  logger.info({ factoryName, shift, shiftEnd, assignDay, notified }, "Pickup reminders sent");
}

// ─── Pickup gaps → head driver (daily 19:00, about tomorrow) ─────────────────
// Detects shifts with no one to take workers home tomorrow and asks the head
// driver to assign someone (inline quick-assign buttons handled in bot/index.ts).
export async function notifyHeadDriverPickupGaps() {
  try {
    const nowW = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
    const tomorrow = new Date(nowW); tomorrow.setDate(tomorrow.getDate() + 1);
    const day = DAY_OF_WEEK_JS[tomorrow.getDay()]!;
    // The week that contains tomorrow: next week's Monday when today is Sunday
    const weekStart = day === "mon" ? getNextMonday() : getCurrentMonday();
    const weeks = await db.select().from(scheduleWeeksTable)
      .where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "approved")));
    if (weeks.length === 0) return;

    const { detectPickupGaps } = await import("./pickupGaps");
    const gaps = await detectPickupGaps(weeks[0]!.id, day);
    if (gaps.length === 0) return;

    const heads = await db.select().from(driversTable)
      .where(and(eq(driversTable.isHeadDriver, true), eq(driversTable.isActive, true)));
    if (heads.length === 0) return;

    const dateStr = `${String(tomorrow.getDate()).padStart(2, "0")}.${String(tomorrow.getMonth() + 1).padStart(2, "0")}`;
    const lines = gaps.map(g =>
      `🏭 *${g.factoryName}* · ${SHIFT_LABELS[g.shift]} (до ${g.end ?? "—"}) — 👷 ${g.people}` +
      (g.reason === "capacity" ? `\n   ⚠️ місць лише ${g.seats} — потрібен додатковий водій` : `\n   ⚠️ ніхто не приїжджає на кінець зміни`),
    );
    // One quick-assign button per gap; callback carries week+day+factory+shift.
    const buttons = gaps.map(g => ([{
      text: `➕ ${g.factoryName} · зм.${g.shift}`,
      callback_data: `pkg:${weekStart}:${g.day}:${g.factoryId}:${g.shift}`,
    }]));
    const msg = `🔙 *Завтра (${dateStr}) нема кому забрати зі зміни:*\n\n${lines.join("\n")}\n\nНатисніть, щоб призначити водія:`;

    for (const h of heads) {
      if (!h.telegramId) continue;
      try { await bot.telegram.sendMessage(h.telegramId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }); }
      catch { /* ignore */ }
    }
    logger.info({ day, weekStart, gaps: gaps.length }, "Pickup-gap notification sent to head driver");
  } catch (e: any) {
    logger.error({ err: e }, "Error in pickup-gap check");
    void sendAlert({ service: "cron", kind: e?.name, source: "pickupGaps", message: e?.message ?? String(e) });
  }
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

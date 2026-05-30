import cron, { type ScheduledTask } from "node-cron";
import { db } from "@workspace/db";
import { workersTable, adminsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { bot } from "../bot";
import { getWorkersWhoHaventSubmitted } from "./sheets";
import { getNextMonday, formatWeekStart } from "./scheduleGenerator";

// Default reminder: Sunday at 18:00 Europe/Kyiv (UTC+3 EEST summer).
// 18:00 Kyiv EEST = 15:00 UTC
const DEFAULT_CRON = "0 15 * * 0"; // UTC 15:00 every Sunday

let schedulerTask: ScheduledTask | null = null;
let currentCron = DEFAULT_CRON;
let reminderHour = 18; // Kyiv local hour shown to admin

export function getReminderHour(): number {
  return reminderHour;
}

export function startScheduler() {
  stopScheduler();

  schedulerTask = cron.schedule(currentCron, async () => {
    logger.info("⏰ Running weekly reminder job");
    await sendWeeklyReminders();
  });

  logger.info({ cron: currentCron }, "Weekly reminder scheduler started");
}

export function stopScheduler() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
  }
}

export function setReminderHour(hour: number) {
  reminderHour = hour;
  // Convert Kyiv hour → UTC (assuming EEST = UTC+3)
  const utcHour = (hour - 3 + 24) % 24;
  currentCron = `0 ${utcHour} * * 0`;
  startScheduler();
  logger.info({ hour, utcHour, cron: currentCron }, "Reminder hour updated");
}

export async function sendWeeklyReminders(): Promise<{ notified: number; skipped: number }> {
  const nextWeek = getNextMonday();
  let notified = 0;
  let skipped = 0;

  try {
    const missing = await getWorkersWhoHaventSubmitted(nextWeek);

    if (missing.length === 0) {
      logger.info({ week: nextWeek }, "All workers submitted — no reminders needed");
      return { notified: 0, skipped: 0 };
    }

    for (const worker of missing) {
      if (!worker.telegramId) { skipped++; continue; }
      try {
        await bot.telegram.sendMessage(
          worker.telegramId,
          `📋 *Нагадування*\n\nБудь ласка, заповніть анкету доступності на тиждень *${formatWeekStart(nextWeek)}*!\n\nЯкщо ви вже заповнили — ігноруйте це повідомлення.`,
          { parse_mode: "Markdown" },
        );
        notified++;
      } catch (e) {
        logger.error({ err: e, worker: worker.fullName }, "Failed to notify worker");
        skipped++;
      }
    }

    // Notify admins about the reminder results
    const admins = await db.select().from(adminsTable);
    for (const admin of admins) {
      try {
        await bot.telegram.sendMessage(
          admin.telegramId,
          `🤖 *Авто-нагадування відправлено*\n\nТиждень: ${formatWeekStart(nextWeek)}\n✅ Надіслано: ${notified}\n⚠️ Пропущено (немає Telegram): ${skipped}\n📭 Не заповнили: ${missing.length}`,
          { parse_mode: "Markdown" },
        );
      } catch { /* ignore admin notify errors */ }
    }

    logger.info({ week: nextWeek, notified, skipped }, "Weekly reminders sent");
  } catch (e) {
    logger.error({ err: e }, "Error in weekly reminder job");
  }

  return { notified, skipped };
}

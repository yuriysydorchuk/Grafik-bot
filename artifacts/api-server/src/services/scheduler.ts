import cron, { type ScheduledTask } from "node-cron";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, adminsTable, factoriesTable,
  scheduleWeeksTable, scheduleEntriesTable, driverShiftAssignmentsTable, driverTripsTable, notificationsTable,
  settingsTable, shiftCancellationsTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and, lt, desc, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sendAlert } from "../lib/alerts";
import { bot } from "../bot";
import { getWorkersWhoHaventSubmitted } from "./sheets";
import { getNextMonday, getCurrentMonday, formatWeekStart } from "./scheduleGenerator";
import { resolveWeekRow, type WeekRow } from "./weeks";
import { factoryShifts, factoryShiftStart, nowWarsaw, warsawDateStr, minutesUntilShift, pickupAssignmentSlot } from "../bot/time";
import { loadDateShiftOverrides, shiftOverrideKey } from "./shiftOverrides";
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
// Key: `{factoryId}_{shift}_{YYYY-MM-DD}` — prevents double-sending on multiple cron
// ticks. Mirrored into the settings table so a pm2 restart mid-day (every deploy)
// doesn't re-send the same reminders.
const sentToday = new Set<string>();
const DEDUP_SETTINGS_KEY = "preshift_sent_today";

function markSent(key: string): void {
  sentToday.add(key);
  void persistSentToday();
}

async function persistSentToday(): Promise<void> {
  try {
    const value = JSON.stringify({ date: warsawDateStr(), keys: [...sentToday] });
    await db.insert(settingsTable).values({ key: DEDUP_SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
  } catch (e) {
    logger.error({ err: e }, "persist pre-shift dedup failed");
  }
}

async function loadSentToday(): Promise<void> {
  try {
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, DEDUP_SETTINGS_KEY));
    if (!row) return;
    const parsed = JSON.parse(row.value) as { date?: string; keys?: string[] };
    if (parsed.date !== warsawDateStr()) return; // stale — a fresh day starts empty
    for (const k of parsed.keys ?? []) sentToday.add(k);
    if (sentToday.size) logger.info({ keys: sentToday.size }, "Pre-shift dedup restored after restart");
  } catch (e) {
    logger.error({ err: e }, "load pre-shift dedup failed");
  }
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

let weeklyReminderTask: ScheduledTask | null = null;
let preShiftTask: ScheduledTask | null = null;
let midnightResetTask: ScheduledTask | null = null;
let prunePruneTask: ScheduledTask | null = null;
let pickupGapTask: ScheduledTask | null = null;
let bankImportTask: ScheduledTask | null = null;
let bankApiTask: ScheduledTask | null = null;
let cfoTask: ScheduledTask | null = null;
let fleetAlertTask: ScheduledTask | null = null;
let serverStatsSampleTask: ScheduledTask | null = null;
let serverStatsReportTask: ScheduledTask | null = null;
let reminderHour = 18;

// Фінансові алерти йдуть головному адміну (не в ALERT_TELEGRAM_CHAT_ID — то канал
// системних помилок). Best-effort: помилка відправки не має валити крон.
async function sendFinanceAlerts(lines: string[]): Promise<void> {
  if (!lines.length) return;
  const shown = lines.slice(0, 10);
  if (lines.length > shown.length) shown.push(`…і ще ${lines.length - shown.length} подій — деталі на сторінці Витяги`);
  try {
    const admins = await db.select().from(adminsTable).where(eq(adminsTable.isMain, true));
    for (const a of admins) {
      if (!a.telegramId) continue;
      try { await bot.telegram.sendMessage(a.telegramId, shown.join("\n\n")); }
      catch (e: any) { logger.warn({ err: e?.message }, "finance alert send failed"); }
    }
  } catch (e: any) { logger.warn({ err: e?.message }, "finance alerts failed"); }
}

export function getReminderHour(): number { return reminderHour; }

export function startScheduler() {
  stopScheduler();
  void loadSentToday(); // restore today's dedup keys after a restart

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
    () => { sentToday.clear(); void persistSentToday(); logger.info("Pre-shift dedup tracker reset"); },
    { timezone: TZ },
  );

  // Daily housekeeping at 04:00 Warsaw: prune chat-tracking rows + old notifications
  // + звірка «полів-двійників» (вік/студент/місто фабрики) — дрейф алертиться в бот.
  prunePruneTask = cron.schedule(
    "0 4 * * *",
    async () => {
      try { const { pruneOldMessageRows } = await import("../bot/chat"); await pruneOldMessageRows(); } catch { /* ignore */ }
      await pruneNotifications();
      try {
        const { findDataDrift, driftSummary } = await import("./dataDrift");
        const summary = driftSummary(await findDataDrift());
        if (summary) {
          const { sendAlert } = await import("../lib/alerts");
          await sendAlert({ service: "cron", kind: "data-drift", source: "dataDriftCheck", message: `Розсинхрон даних: ${summary}` });
        }
      } catch (e) { logger.error({ err: e }, "data drift check failed"); }
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

  // Daily 06:00 Warsaw: pull new bank statements (MT940) from Drive into
  // bank_transactions/bank_statements. Idempotent (dedup hash), so a daily poll
  // safely picks up the monthly uploads; categorization happens at query time.
  bankImportTask = cron.schedule(
    "0 6 * * *",
    async () => {
      try {
        const { syncBankTransactions } = await import("./bankStatements");
        const r = await syncBankTransactions();
        logger.info({ files: r.files, imported: r.imported, skipped: r.skipped }, "Daily bank statement import");
      } catch (e: any) { logger.warn({ err: e?.message }, "Daily bank import failed"); }
      // Каса більше не синкається зі STAN KASY (таблиця виведена з експлуатації
      // 08.2026): записи ведуться на /cash, історія таблиці лишилась read-only.
      try {
        const { syncInvoices } = await import("./invoices");
        const i = await syncInvoices();
        logger.info({ tabs: i.tabs, invoices: i.invoices, unpaid: i.unpaid }, "Daily invoices sync");
      } catch (e: any) { logger.warn({ err: e?.message }, "Daily invoices sync failed"); }
      try {
        const { syncPayrollSummaries } = await import("./payrollSummaries");
        const p = await syncPayrollSummaries();
        logger.info({ sources: p.sources, factories: p.factories, errors: p.errors.length }, "Daily payroll summaries sync");
      } catch (e: any) { logger.warn({ err: e?.message }, "Daily payroll summaries sync failed"); }
      try {
        const { syncKsef } = await import("./ksef");
        const k = await syncKsef();
        logger.info({ companies: k.companies, inserted: k.inserted, paidMatched: k.paidMatched, errors: k.errors.length }, "Daily KSeF sync");
      } catch (e: any) { logger.warn({ err: e?.message }, "Daily KSeF sync failed"); }
      try {
        const { consentExpiryWarnings } = await import("./bankApi");
        await sendFinanceAlerts(await consentExpiryWarnings());
      } catch (e: any) { logger.warn({ err: e?.message }, "Consent expiry check failed"); }
      try {
        const { syncCounterparties } = await import("./counterparties");
        const c = await syncCounterparties();
        logger.info(c, "Daily counterparties sync");
      } catch (e: any) { logger.warn({ err: e?.message }, "Daily counterparties sync failed"); }
      try {
        // аванси проти свіжого MT940-імпорту (API-шлях ловить свої в bankApiTask)
        const { autoMarkPaidAdvances } = await import("./advances");
        await sendFinanceAlerts(await autoMarkPaidAdvances());
      } catch (e: any) { logger.warn({ err: e?.message }, "Advance auto-paid (daily) failed"); }
    },
    { timezone: TZ },
  );

  // Оперативний банківський шар (Enable Banking): транзакції+баланси кожні 3 год
  // удень. Алерти (надходження, komornik, низький баланс) — головному адміну.
  // Свіжі рядки одразу конвертуються в статуси: KSeF «оплачено» (строгий матчинг
  // за номером у призначенні) і аванси «виплачено» (services/advances.ts).
  // 4 рази/день — PSD2-ліміт фонових звернень без участі клієнта (429 при частіших)
  bankApiTask = cron.schedule(
    "10 7,11,15,19 * * *",
    async () => {
      try {
        const { syncBankApi } = await import("./bankApi");
        const r = await syncBankApi();
        if (r.inserted || r.errors.length) logger.info({ inserted: r.inserted, accounts: r.accounts, errors: r.errors.length }, "Bank API sync");
        const alerts = [...r.alerts];
        if (r.inserted) {
          try {
            const { matchKsefPayments, recentlyPaidByApi } = await import("./ksef");
            if (await matchKsefPayments()) {
              for (const p of await recentlyPaidByApi(30)) {
                alerts.push(`✅ Фактура ${p.invoiceNumber} (${p.buyerName ?? "?"}) закрита переказом — ${p.gross.toLocaleString("pl-PL", { minimumFractionDigits: 2 })} zł`);
              }
            }
          } catch (e: any) { logger.warn({ err: e?.message }, "KSeF same-day match failed"); }
          try {
            const { autoMarkPaidAdvances } = await import("./advances");
            alerts.push(...await autoMarkPaidAdvances());
          } catch (e: any) { logger.warn({ err: e?.message }, "Advance auto-paid failed"); }
        }
        await sendFinanceAlerts(alerts);
      } catch (e: any) { logger.warn({ err: e?.message }, "Bank API sync failed"); }
    },
    { timezone: TZ },
  );

  // CFO-звірка за попередній місяць — 1-го числа о 09:00 Warsaw вибраним адресатам
  cfoTask = cron.schedule(
    "0 9 1 * *",
    async () => {
      try {
        const { sendMonthlyCfoReport } = await import("./cfo");
        await sendMonthlyCfoReport();
      } catch (e: any) { logger.warn({ err: e?.message }, "Monthly CFO report failed"); }
    },
    { timezone: TZ },
  );

  // Weekly Monday 08:00 Warsaw: insurance/inspection expiry digest for the fleet
  // (head driver + main admin in the bot). Раз на тиждень — без щоденного спаму.
  fleetAlertTask = cron.schedule(
    "0 8 * * 1",
    async () => {
      try {
        const { notifyFleetExpiry } = await import("./fleet");
        await notifyFleetExpiry();
      } catch (e: any) { logger.warn({ err: e?.message }, "Fleet expiry alert failed"); }
    },
    { timezone: TZ },
  );

  // Здоровʼя сервера: семпл CPU/RAM кожні 15 хв (ролінг 7 днів у settings; критичний
  // диск ≥90% алертиться одразу) + тижневий дайджест власнику пн 08:00 Warsaw
  serverStatsSampleTask = cron.schedule(
    "*/15 * * * *",
    async () => {
      try {
        const { sampleServerStats } = await import("./serverStats");
        await sampleServerStats();
      } catch (e: any) { logger.warn({ err: e?.message }, "Server stats sample failed"); }
    },
    { timezone: TZ },
  );
  serverStatsReportTask = cron.schedule(
    "0 8 * * 1",
    async () => {
      try {
        const { sendWeeklyServerReport } = await import("./serverStats");
        await sendWeeklyServerReport();
      } catch (e: any) { logger.warn({ err: e?.message }, "Weekly server stats report failed"); }
    },
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
  bankImportTask?.stop();     bankImportTask = null;
  bankApiTask?.stop();        bankApiTask = null;
  cfoTask?.stop();            cfoTask = null;
  fleetAlertTask?.stop();     fleetAlertTask = null;
  serverStatsSampleTask?.stop(); serverStatsSampleTask = null;
  serverStatsReportTask?.stop(); serverStatsReportTask = null;
}

export function setReminderHour(hour: number) {
  reminderHour = hour;
  startScheduler();
  logger.info({ hour, tz: TZ }, "Reminder hour updated");
}

// ─── Pre-shift notifications ──────────────────────────────────────────────────

// A cell cancelled by the scheduler gets no pre-shift/pickup reminders at all.
async function isCellCancelled(weekId: number, factoryId: number, day: DayOfWeek, shift: Shift): Promise<boolean> {
  const rows = await db.select({ id: shiftCancellationsTable.id }).from(shiftCancellationsTable)
    .where(and(
      eq(shiftCancellationsTable.weekId, weekId), eq(shiftCancellationsTable.factoryId, factoryId),
      eq(shiftCancellationsTable.dayOfWeek, day), eq(shiftCancellationsTable.shift, shift),
    )).limit(1);
  return rows.length > 0;
}

async function checkPreShiftNotifications() {
  try {
    // Current Warsaw time
    const nowWarsaw = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
    const nowMs = nowWarsaw.getTime();
    // Warsaw date as a string — NOT toISOString(), which converts back to UTC and
    // yields yesterday's date around midnight (server runs in Europe/Berlin).
    const todayStr = warsawDateStr();
    const dayName = DAY_OF_WEEK_JS[nowWarsaw.getDay()]!;
    const week = getCurrentMonday();

    // No status filter: the real process runs on draft weeks too (the week may
    // be approved days later than workers/drivers are already scheduled on it).
    const weekRow = await resolveWeekRow(week);
    if (!weekRow) return;
    const weekId = weekRow.id;

    const factories = await db.select().from(factoriesTable);

    // Shifts that actually have people today may sit OUTSIDE the factory's configured
    // shiftCount (one-off extra shifts, or entries kept after lowering the count) —
    // remind for those too. One-off shifts carry their own start/end (overrides).
    const dayOverrides = await loadDateShiftOverrides(todayStr);
    const entryShiftRows = await db.selectDistinct({ factoryId: scheduleEntriesTable.factoryId, shift: scheduleEntriesTable.shift })
      .from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.dayOfWeek, dayName)));

    for (const factory of factories) {
      // Use the jsonb `shifts` (falls back to legacy columns) so web-created factories
      // and shifts 4–6 are covered, not just legacy shift1/2/3Start.
      const fShifts = factoryShifts(factory);
      const shiftSet = new Set<Shift>();
      for (let i = 1; i <= Math.min(6, Math.max(1, factory.shiftCount ?? 3)); i++) shiftSet.add(String(i) as Shift);
      for (const r of entryShiftRows) if (r.factoryId === factory.id) shiftSet.add(r.shift as Shift);
      for (let i = 1; i <= 6; i++) if (dayOverrides.has(shiftOverrideKey(factory.id, todayStr, i))) shiftSet.add(String(i) as Shift);
      const shiftTimes: Array<{ shift: Shift; start: string | null; end: string | null }> = [...shiftSet]
        .sort((a, b) => Number(a) - Number(b))
        .map(shift => {
          const st = dayOverrides.get(shiftOverrideKey(factory.id, todayStr, shift)) ?? fShifts[Number(shift) - 1];
          return { shift, start: st?.start ?? null, end: st?.end ?? null };
        });

      for (const { shift, start, end } of shiftTimes) {
        if (!start) continue; // no time configured for this shift at this factory

        const minsUntil = minutesUntilShift(nowMs, start);
        // Notify within a 14-minute window centred on 120 min before shift
        if (minsUntil >= 106 && minsUntil <= 134) {
          const key = `${factory.id}_${shift}_${todayStr}`;
          if (!sentToday.has(key)) {
            markSent(key);
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
              markSent(key);
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
  if (await isCellCancelled(weekId, factoryId, day, shift)) return;
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
    const dayOv = await loadDateShiftOverrides(today);
    for (const trip of open) {
      const key = `arrfrgt_${trip.id}`;
      if (sentToday.has(key)) continue;
      const fac = facById.get(trip.factoryId);
      const startStr = dayOv.get(shiftOverrideKey(trip.factoryId, today, trip.shift))?.start
        ?? factoryShiftStart(fac, trip.shift as Shift);
      const [hh, mm] = startStr.split(":").map(Number);
      const [y, m, d] = today.split("-").map(Number);
      const start = new Date(y!, m! - 1, d!, hh ?? 6, mm ?? 0, 0, 0);
      const minsSinceStart = (now.getTime() - start.getTime()) / 60000;
      if (minsSinceStart < 60 || minsSinceStart > 300) continue;
      const [drv] = await db.select().from(driversTable).where(eq(driversTable.id, trip.driverId));
      if (!drv?.telegramId) continue;
      markSent(key);
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
  const { day: assignDay, weekStart } = pickupAssignmentSlot(todayName, getCurrentMonday(), shiftStart, shiftEnd);
  const weeks = [await resolveWeekRow(weekStart)].filter((w): w is WeekRow => w != null);
  if (weeks.length === 0) return;
  if (await isCellCancelled(weeks[0]!.id, factoryId, assignDay, shift)) return;

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
    const weeks = [await resolveWeekRow(weekStart)].filter((w): w is WeekRow => w != null);
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

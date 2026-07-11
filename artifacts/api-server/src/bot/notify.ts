import { bot } from "./instance";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, adminsTable,
  scheduleEntriesTable, factoriesTable, notificationsTable,
  scheduleWeeksTable, driverShiftAssignmentsTable, monthlyReportsTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and, count, desc, ne, gte, lt } from "drizzle-orm";
import { logger } from "../lib/logger";
import { setState } from "./state";
import { DAY_UK, SHIFT_SHORT, splitMessage, mdSafe } from "./display";
import { t, asLang, dayShort, DATE_LOCALE, type Lang } from "./i18n";
import { nowWarsaw } from "./time";
import { DAYS, DAY_NAMES_UK } from "../services/sheets";

// localized short labels for schedule lines
const DAY_KEY: Record<DayOfWeek, string> = { mon: "mon", tue: "tue", wed: "wed", thu: "thu", fri: "fri", sat: "sat", sun: "sun" };
const lDay = (lang: Lang, d: DayOfWeek) => dayShort(lang, DAY_KEY[d]);
const lShift = (lang: Lang, s: Shift) => t(lang, "hr.shiftN", { n: s });
import { formatWeekStart } from "../services/scheduleGenerator";
import { updateHoursTracking, updateDriverTripsExcel } from "../services/drive";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function sendLongMessage(
  chatId: string | number,
  text: string,
  options: Record<string, unknown> = {},
) {
  for (const chunk of splitMessage(text)) {
    await bot.telegram.sendMessage(chatId, chunk, options as any);
    await sleep(80);
  }
}

// ─── Report offers (fired / transferred workers) ─────────────────────────────
// Inline «repi:<month>:<factoryId>» buttons open the bot report flow for that
// month bypassing the calendar default; fired workers keep the entry for 30 days.

const reportMonthLbl = (lang: Lang, m: string) => new Date(`${m}-01`).toLocaleDateString(DATE_LOCALE[lang], { month: "long", year: "numeric" });
const monthStr2 = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// Which months a leaver may still owe a report for: always the current month;
// in the first 7 days also the previous one, unless it's already submitted.
export async function farewellReportMonths(workerId: number): Promise<string[]> {
  const now = nowWarsaw();
  const months = [monthStr2(now)];
  if (now.getDate() <= 7) {
    const prev = monthStr2(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const has = await db.select({ id: monthlyReportsTable.id }).from(monthlyReportsTable)
      .where(and(eq(monthlyReportsTable.workerId, workerId), eq(monthlyReportsTable.month, prev))).limit(1);
    if (has.length === 0) months.unshift(prev);
  }
  return months;
}

export async function sendReportOffer(
  workerId: number,
  opts: { months: string[]; factoryId?: number; textKey: "report.firedOffer" | "report.transferOffer"; params?: Record<string, string | number> },
): Promise<boolean> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w?.telegramId || opts.months.length === 0) return false;
  const lang = asLang(w.language);
  const buttons = opts.months.map(m => [{ text: `📄 ${reportMonthLbl(lang, m)}`, callback_data: `repi:${m}:${opts.factoryId ?? 0}` }]);
  try {
    await bot.telegram.sendMessage(w.telegramId, t(lang, opts.textKey, opts.params as any), {
      parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons },
    } as any);
    return true;
  } catch {
    return false; // worker blocked the bot etc.
  }
}

// Worker moved to another factory mid-month: offer a report for the OLD factory
// (only if they actually have approved shifts there this month).
export async function offerTransferReport(workerId: number, oldFactoryId: number): Promise<boolean> {
  const now = nowWarsaw();
  const month = monthStr2(now);
  const monthStart = `${month}-01`;
  const monthEnd = monthStr2(new Date(now.getFullYear(), now.getMonth() + 1, 1)) + "-01";
  const weekFrom = new Date(monthStart + "T00:00:00");
  weekFrom.setDate(weekFrom.getDate() - 6);
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const DAYS_ORDER: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const rows = await db
    .select({ day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart })
    .from(scheduleEntriesTable)
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(
      eq(scheduleEntriesTable.workerId, workerId),
      eq(scheduleEntriesTable.factoryId, oldFactoryId),
      eq(scheduleWeeksTable.status, "approved"),
      gte(scheduleWeeksTable.weekStart, ymd(weekFrom)),
      lt(scheduleWeeksTable.weekStart, monthEnd),
    ));
  const worked = rows.some(r => {
    if (!r.weekStart) return false;
    const d = new Date(String(r.weekStart) + "T00:00:00");
    d.setDate(d.getDate() + Math.max(0, DAYS_ORDER.indexOf(r.day)));
    const ds = ymd(d);
    return ds >= monthStart && ds < monthEnd;
  });
  if (!worked) return false;
  const [w] = await db.select({ language: workersTable.language }).from(workersTable).where(eq(workersTable.id, workerId));
  const [fac] = await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, oldFactoryId));
  const lang = asLang(w?.language);
  return sendReportOffer(workerId, {
    months: [month], factoryId: oldFactoryId, textKey: "report.transferOffer",
    params: { factory: fac?.name ?? "—", month: reportMonthLbl(lang, month) },
  });
}

export async function notifyAdmins(text: string, options: Record<string, unknown> = {}) {
  const admins = await db.select().from(adminsTable);
  for (const admin of admins) {
    if (!admin.telegramId) continue; // invited/pending admins have no Telegram yet
    if (admin.role === "driver") continue; // web-only driver role — not office staff
    try { await bot.telegram.sendMessage(admin.telegramId, text, options as any); }
    catch { /* individual failure should not stop others */ }
  }
}

// Role-targeted notification: stores an on-site notification (bell) AND sends Telegram
// to the matching web users (by role) + the head driver when "driver"/"both" is targeted.
export async function notifyRoles(
  audience: "scheduler" | "driver" | "both",
  msg: { type: "no_show" | "cancellation" | "hours_correction" | "advance" | "substitution"; title: string; body?: string },
) {
  // 1) on-site notification
  try {
    await db.insert(notificationsTable).values({ type: msg.type, title: msg.title, body: msg.body ?? null, audience });
  } catch (e) { logger.error({ err: e }, "notif insert"); }

  // 2) Telegram recipients
  const recipients = new Set<string>();
  const wantRoles = audience === "both" ? ["scheduler", "driver", "owner"] : [audience, "owner"];
  const admins = await db.select().from(adminsTable);
  for (const a of admins) if (wantRoles.includes(a.role ?? "owner") && a.telegramId) recipients.add(a.telegramId);
  if (audience === "driver" || audience === "both") {
    const heads = await db.select().from(driversTable).where(and(eq(driversTable.isHeadDriver, true), eq(driversTable.isActive, true)));
    for (const d of heads) if (d.telegramId) recipients.add(d.telegramId);
  }
  const text = `${msg.title}${msg.body ? `\n${msg.body}` : ""}`;
  for (const tid of recipients) {
    try { await bot.telegram.sendMessage(tid, text, { parse_mode: "Markdown" } as any); }
    catch { /* ignore individual */ }
  }
}

// Message each driver assigned to this week+factory with their shift list.
export async function notifyDriversOfWeek(weekStart: string, factoryId: number): Promise<{ notified: number; skipped: number }> {
  const candidates = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  const week = candidates.find(w => w.status === "approved") ?? candidates[0];
  if (!week) return { notified: 0, skipped: 0 };
  const factory = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
  const rows = await db
    .select({ day: driverShiftAssignmentsTable.dayOfWeek, shift: driverShiftAssignmentsTable.shift, kind: driverShiftAssignmentsTable.kind, driverId: driverShiftAssignmentsTable.driverId, telegramId: driversTable.telegramId, name: driversTable.name })
    .from(driverShiftAssignmentsTable)
    .leftJoin(driversTable, eq(driverShiftAssignmentsTable.driverId, driversTable.id))
    .where(and(eq(driverShiftAssignmentsTable.weekId, week.id), eq(driverShiftAssignmentsTable.factoryId, factoryId)));

  const byDriver = new Map<number, { telegramId: string | null; name: string | null; items: { day: DayOfWeek; shift: Shift; kind: string }[] }>();
  for (const r of rows) {
    if (!byDriver.has(r.driverId)) byDriver.set(r.driverId, { telegramId: r.telegramId, name: r.name, items: [] });
    byDriver.get(r.driverId)!.items.push({ day: r.day as DayOfWeek, shift: r.shift as Shift, kind: r.kind });
  }

  let notified = 0, skipped = 0;
  for (const d of byDriver.values()) {
    if (!d.telegramId) { skipped++; continue; }
    const lines = DAYS
      .filter(day => d.items.some(i => i.day === day))
      .map(day => {
        const shifts = d.items.filter(i => i.day === day)
          .map(i => i.kind === "pickup" ? `🔙 забрати ${SHIFT_SHORT[i.shift]}` : SHIFT_SHORT[i.shift]).join(", ");
        return `${DAY_UK[day]}: ${shifts}`;
      });
    const msg = `🚗 *Ваші зміни — ${factory?.name ?? "фабрика"}*\n📅 ${formatWeekStart(weekStart)}\n\n${lines.join("\n")}`;
    try { await bot.telegram.sendMessage(d.telegramId, msg, { parse_mode: "Markdown" }); notified++; await sleep(60); }
    catch { skipped++; }
  }
  return { notified, skipped };
}

// Send a one-time login code (2FA) to an admin's Telegram.
export async function sendLoginCode(telegramId: string, code: string): Promise<boolean> {
  try {
    await bot.telegram.sendMessage(
      telegramId,
      `🔐 *Код для входу в панель:* \`${code}\`\n\nДійсний 5 хвилин. Якщо це не ви — проігноруйте.`,
      { parse_mode: "Markdown" },
    );
    return true;
  } catch { return false; }
}

// Manual broadcast: send a plain text message to a list of Telegram ids.
export async function sendBroadcast(telegramIds: (string | null)[], text: string): Promise<{ notified: number; skipped: number }> {
  let notified = 0, skipped = 0;
  const seen = new Set<string>();
  for (const tid of telegramIds) {
    if (!tid) { skipped++; continue; }
    if (seen.has(tid)) continue;
    seen.add(tid);
    try { await bot.telegram.sendMessage(tid, text); notified++; await sleep(50); }
    catch { skipped++; }
  }
  return { notified, skipped };
}

// Referral: tell the referrer their invited friend is now an active worker.
export async function sendCandidateActive(telegramId: string, friendName: string, lang?: string | null): Promise<boolean> {
  try {
    await bot.telegram.sendMessage(
      telegramId,
      t(asLang(lang), "notif.candActive", { friend: friendName }),
      { parse_mode: "Markdown" },
    );
    return true;
  } catch { return false; }
}

// Referral: tell the referrer their bonus was paid out.
export async function sendBonusPaid(telegramId: string, friendName: string, amount: number | null, lang?: string | null): Promise<boolean> {
  try {
    await bot.telegram.sendMessage(
      telegramId,
      t(asLang(lang), "notif.bonusPaid", { friend: friendName, amount: amount != null ? ` — *${amount} zł*` : "" }),
      { parse_mode: "Markdown" },
    );
    return true;
  } catch { return false; }
}

// Salary advance: tell the worker their request's new status (approved / rejected / paid).
export async function notifyWorkerAdvance(workerId: number, status: string, amount: number, note?: string | null): Promise<boolean> {
  const [w] = await db.select({ tid: workersTable.telegramId, lang: workersTable.language }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w?.tid) return false;
  const key = status === "approved" ? "notif.advApproved" : status === "rejected" ? "notif.advRejected" : status === "paid" ? "notif.advPaid" : null;
  if (!key) return false;
  let msg = t(asLang(w.lang), key, { amount: String(amount) });
  // Include the admin's reason on rejection (free text — strip Markdown entities).
  if (status === "rejected" && note) msg += `\n📝 ${mdSafe(note)}`;
  try {
    await bot.telegram.sendMessage(w.tid, msg, { parse_mode: "Markdown" });
    return true;
  } catch { return false; }
}

// Notify each worker scheduled at a factory/week with their personal schedule and the
// assigned driver next to each shift (clickable @username link, else phone).
export async function notifyWorkersScheduleWithDrivers(weekStart: string, factoryId: number): Promise<{ notified: number; skipped: number }> {
  const cands = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  const week = cands.find(w => w.status === "approved") ?? cands[0];
  if (!week) return { notified: 0, skipped: 0 };
  const factory = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];

  // driver assigned per day+shift for this factory/week (delivery only — the
  // pickup driver at shift end is не the one who brings the worker in)
  const assigns = await db
    .select({ day: driverShiftAssignmentsTable.dayOfWeek, shift: driverShiftAssignmentsTable.shift, name: driversTable.name, username: driversTable.username, phone: driversTable.phone })
    .from(driverShiftAssignmentsTable)
    .leftJoin(driversTable, eq(driverShiftAssignmentsTable.driverId, driversTable.id))
    .where(and(eq(driverShiftAssignmentsTable.weekId, week.id), eq(driverShiftAssignmentsTable.factoryId, factoryId), eq(driverShiftAssignmentsTable.kind, "delivery")));
  const driverAt = new Map<string, { name: string | null; username: string | null; phone: string | null }>();
  for (const a of assigns) driverAt.set(`${a.day}-${a.shift}`, { name: a.name, username: a.username, phone: a.phone });

  // workers scheduled at this factory this week
  const entries = await db
    .select({ workerId: scheduleEntriesTable.workerId, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, tid: workersTable.telegramId, fullName: workersTable.fullName, language: workersTable.language })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.factoryId, factoryId)));

  const byWorker = new Map<number, { tid: string | null; name: string | null; lang: string | null; items: { day: DayOfWeek; shift: Shift }[] }>();
  for (const e of entries) {
    if (!byWorker.has(e.workerId)) byWorker.set(e.workerId, { tid: e.tid, name: e.fullName, lang: e.language, items: [] });
    byWorker.get(e.workerId)!.items.push({ day: e.day as DayOfWeek, shift: e.shift as Shift });
  }

  const driverLabel = (lang: Lang, d?: { name: string | null; username: string | null; phone: string | null }) => {
    if (!d || !d.name) return t(lang, "notif.drvNone");
    if (d.username) return `[${d.name}](https://t.me/${d.username})`;
    if (d.phone) return `${d.name} (${d.phone})`;
    return d.name;
  };

  let notified = 0, skipped = 0;
  for (const w of byWorker.values()) {
    if (!w.tid) { skipped++; continue; }
    const lang = asLang(w.lang);
    const lines: string[] = [];
    for (const day of DAYS) {
      const it = w.items.find(i => i.day === day);
      if (!it) continue;
      const drv = driverAt.get(`${day}-${it.shift}`);
      lines.push(`${lDay(lang, day)}: ${lShift(lang, it.shift)} — 🚗 ${driverLabel(lang, drv)}`);
    }
    const msg = t(lang, "notif.schedDrvHdr", { factory: factory?.name ?? "—", week: formatWeekStart(weekStart), lines: lines.join("\n") });
    try { await bot.telegram.sendMessage(w.tid, msg, { parse_mode: "Markdown" }); notified++; await sleep(60); }
    catch { skipped++; }
  }
  return { notified, skipped };
}

// Notify ONE driver of all their shifts (across every factory) for a week.
export async function notifyDriverOfWeek(weekStart: string, driverId: number): Promise<{ notified: number; skipped: number }> {
  const candidates = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  const week = candidates.find(w => w.status === "approved") ?? candidates[0];
  if (!week) return { notified: 0, skipped: 0 };
  const driver = (await db.select().from(driversTable).where(eq(driversTable.id, driverId)))[0];
  if (!driver) return { notified: 0, skipped: 0 };
  if (!driver.telegramId) return { notified: 0, skipped: 1 };

  const rows = await db
    .select({ day: driverShiftAssignmentsTable.dayOfWeek, shift: driverShiftAssignmentsTable.shift, kind: driverShiftAssignmentsTable.kind, factoryName: factoriesTable.name })
    .from(driverShiftAssignmentsTable)
    .leftJoin(factoriesTable, eq(driverShiftAssignmentsTable.factoryId, factoriesTable.id))
    .where(and(eq(driverShiftAssignmentsTable.weekId, week.id), eq(driverShiftAssignmentsTable.driverId, driverId)));

  if (!rows.length) {
    // driver was cleared from all shifts — let them know
    const msg = `🚗 *Ваші зміни — ${formatWeekStart(weekStart)}*\n\nНа цей тиждень змін немає.`;
    try { await bot.telegram.sendMessage(driver.telegramId, msg, { parse_mode: "Markdown" }); return { notified: 1, skipped: 0 }; }
    catch { return { notified: 0, skipped: 1 }; }
  }

  const lines = DAYS
    .filter(day => rows.some(r => r.day === day))
    .map(day => {
      const items = rows.filter(r => r.day === day)
        .map(r => `${r.factoryName ?? "фабрика"} — ${r.kind === "pickup" ? `🔙 забрати ${SHIFT_SHORT[r.shift as Shift]}` : SHIFT_SHORT[r.shift as Shift]}`)
        .join("; ");
      return `${DAY_UK[day]}: ${items}`;
    });
  const msg = `🚗 *Ваші зміни — ${formatWeekStart(weekStart)}*\n\n${lines.join("\n")}`;
  try { await bot.telegram.sendMessage(driver.telegramId, msg, { parse_mode: "Markdown" }); return { notified: 1, skipped: 0 }; }
  catch { return { notified: 0, skipped: 1 }; }
}

export async function sendScheduleToAllWorkers(weekId: number, weekStart: string) {
  const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
  let notified = 0, skipped = 0;

  for (const worker of workers) {
    if (!worker.telegramId) { skipped++; continue; }

    const entries = await db
      .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, factoryName: factoriesTable.name })
      .from(scheduleEntriesTable)
      .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
      .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.workerId, worker.id), ne(scheduleEntriesTable.status, "absent")));

    if (entries.length === 0) { skipped++; continue; }

    const lang = asLang(worker.language);
    const lines = DAYS.map(day => {
      const e = entries.find(x => x.day === day);
      return e
        ? `${lDay(lang, day)}: ${lShift(lang, e.shift as Shift)} — ${e.factoryName}`
        : `${lDay(lang, day)}: ${t(lang, "sched.dayOff")}`;
    });
    const msg = t(lang, "notif.schedWeekHdr", { week: formatWeekStart(weekStart), lines: lines.join("\n") });

    try {
      await bot.telegram.sendMessage(worker.telegramId, msg, { parse_mode: "Markdown" });
      notified++;
      await sleep(50);
    } catch { skipped++; }
  }

  return { notified, skipped };
}

export async function sendScheduleToHeadDriver(weekId: number, weekStart: string) {
  const headDrivers = await db.select().from(driversTable)
    .where(and(eq(driversTable.isHeadDriver, true), eq(driversTable.isActive, true)));
  if (headDrivers.length === 0) return "❌ Головний водій не призначений";
  const hd = headDrivers[0]!;
  if (!hd.telegramId) return "❌ Немає Telegram у головного водія";

  const entries = await db
    .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, workerName: workersTable.fullName, factoryName: factoriesTable.name })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, weekId), ne(scheduleEntriesTable.status, "absent")));

  let msg = `📋 *Повний графік — ${formatWeekStart(weekStart)}*\n*Призначте водіїв через "📋 Призначити водіїв"*\n\n`;
  for (const day of DAYS) {
    const dayEntries = entries.filter(e => e.day === day);
    if (dayEntries.length === 0) continue;
    msg += `*${DAY_NAMES_UK[day]}:*\n`;
    for (const shift of ["1", "2", "3", "4", "5", "6"] as Shift[]) {
      const shifted = dayEntries.filter(e => e.shift === shift);
      if (shifted.length > 0) {
        msg += `  ${SHIFT_SHORT[shift]} — ${shifted[0]!.factoryName} (${shifted.length} ос.):\n`;
        shifted.forEach(e => { msg += `    • ${e.workerName}\n`; });
      }
    }
  }

  try {
    await sendLongMessage(hd.telegramId, msg, { parse_mode: "Markdown" });
    return `✅ надіслано ${hd.name}`;
  } catch { return "❌ помилка надсилання"; }
}

export async function notifyDriverOfAssignment(
  driverTid: string, weekId: number, day: DayOfWeek, shift: Shift, weekStart: string, factoryId?: number,
) {
  const conds = [eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.dayOfWeek, day), eq(scheduleEntriesTable.shift, shift)];
  if (factoryId != null) conds.push(eq(scheduleEntriesTable.factoryId, factoryId));
  const rows = await db
    .select({ name: workersTable.fullName, factoryName: factoriesTable.name })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(...conds));

  const factoryName = rows[0]?.factoryName ?? "—";
  let msg = `🚗 *Нове призначення!*\n\n*${DAY_NAMES_UK[day]}* ${SHIFT_SHORT[shift]}\n🏭 ${factoryName}\nТиждень: ${formatWeekStart(weekStart)}\n\n*Список (${rows.length} ос.):*\n`;
  rows.forEach((w, i) => { msg += `${i + 1}. ${w.name}\n`; });

  try { await bot.telegram.sendMessage(driverTid, msg, { parse_mode: "Markdown" }); }
  catch (e) { logger.error({ err: e }, "Error notifying driver of assignment"); }
}

// Notify absent worker, capture reason, and check absence threshold
export async function notifyAbsentWorker(entryId: number, day: DayOfWeek) {
  const rows = await db
    .select({
      telegramId: workersTable.telegramId,
      workerId: workersTable.id,
      name: workersTable.fullName,
      language: workersTable.language,
      shift: scheduleEntriesTable.shift,
    })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(eq(scheduleEntriesTable.id, entryId));

  const row = rows[0];
  if (!row) return;

  // Notify worker to explain
  if (row.telegramId) {
    const lang = asLang(row.language);
    try {
      await bot.telegram.sendMessage(
        row.telegramId,
        t(lang, "notif.absentPrompt", { name: row.name ?? "", day: lDay(lang, day), shift: lShift(lang, row.shift as Shift) }),
        { parse_mode: "Markdown" },
      );
      setState(row.telegramId, "absent:explain_reason", { entryId, day, shift: row.shift, name: row.name });
    } catch (e) {
      logger.error({ err: e }, "Error notifying absent worker");
    }
  }

  // Count unexcused absences (no reason) for this worker this month
  if (row.workerId) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const { scheduleWeeksTable } = await import("@workspace/db");
    const absenceRows = await db
      .select({ id: scheduleEntriesTable.id })
      .from(scheduleEntriesTable)
      .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
      .where(and(
        eq(scheduleEntriesTable.workerId, row.workerId),
        eq(scheduleEntriesTable.status, "absent"),
      ));

    const totalAbsences = absenceRows.length;

    if (totalAbsences >= 2) {
      const emoji = totalAbsences >= 5 ? "🔴" : totalAbsences >= 3 ? "🟠" : "🟡";
      await notifyAdmins(
        `${emoji} *Попередження: пропуски*\n\n👷 *${row.name}*\nПропусків всього: *${totalAbsences}*\n\nПерейдіть до "📋 Список працівників" для деталей.`,
        { parse_mode: "Markdown" },
      );
    }
  }
}

// Refresh Excel reports after attendance changes (fire-and-forget, errors are logged)
export async function refreshExcelReports() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  try {
    const [hoursLink, tripsLink] = await Promise.all([
      updateHoursTracking(month),
      updateDriverTripsExcel(month),
    ]);
    logger.info({ month, hoursLink, tripsLink }, "Excel reports refreshed");
  } catch (e) {
    logger.error({ err: e }, "Failed to refresh Excel reports");
  }
}

// Send one factory's approved schedule to its workers (personal shifts) + head driver (full list)
export async function notifyFactorySchedule(weekId: number, weekStart: string, factoryId: number, day?: DayOfWeek) {
  const factory = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
  const factoryName = factory?.name ?? "—";

  const rows = await db
    .select({
      workerId: scheduleEntriesTable.workerId, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift,
      telegramId: workersTable.telegramId, name: workersTable.fullName, language: workersTable.language,
    })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(
      eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.factoryId, factoryId),
      ne(scheduleEntriesTable.status, "absent"),
      ...(day ? [eq(scheduleEntriesTable.dayOfWeek, day)] : []),
    ));

  // Per-worker personal schedule
  const byWorker = new Map<number, { name: string; telegramId: string | null; lang: string | null; items: { day: DayOfWeek; shift: Shift }[] }>();
  for (const r of rows) {
    if (!r.workerId) continue;
    if (!byWorker.has(r.workerId)) byWorker.set(r.workerId, { name: r.name ?? "—", telegramId: r.telegramId, lang: r.language, items: [] });
    byWorker.get(r.workerId)!.items.push({ day: r.day as DayOfWeek, shift: r.shift as Shift });
  }

  let workersNotified = 0, workersSkipped = 0;
  for (const w of byWorker.values()) {
    if (!w.telegramId) { workersSkipped++; continue; }
    const lang = asLang(w.lang);
    const lines = DAYS.filter(d => w.items.some(i => i.day === d))
      .map(d => `${lDay(lang, d)}: ${lShift(lang, w.items.find(i => i.day === d)!.shift)}`);
    const msg = t(lang, "notif.schedHdr", { factory: factoryName, week: formatWeekStart(weekStart), lines: lines.join("\n") });
    try { await bot.telegram.sendMessage(w.telegramId, msg, { parse_mode: "Markdown" }); workersNotified++; await sleep(50); }
    catch { workersSkipped++; }
  }

  // Head driver: full factory schedule
  const heads = await db.select().from(driversTable).where(and(eq(driversTable.isHeadDriver, true), eq(driversTable.isActive, true)));
  let driverNotified = false;
  const hd = heads[0];
  if (hd?.telegramId) {
    let msg = `🚐 *Графік водія — ${factoryName}*\nТиждень: ${formatWeekStart(weekStart)}\n\n`;
    for (const d of DAYS) {
      const dayRows = rows.filter(r => r.day === d);
      if (dayRows.length === 0) continue;
      msg += `*${DAY_NAMES_UK[d]}:*\n`;
      for (const s of ["1", "2", "3", "4", "5", "6"] as Shift[]) {
        const names = dayRows.filter(r => r.shift === s).map(r => r.name);
        if (names.length) msg += `  ${SHIFT_SHORT[s]} (${names.length}): ${names.join(", ")}\n`;
      }
    }
    try { await sendLongMessage(hd.telegramId, msg, { parse_mode: "Markdown" }); driverNotified = true; } catch { /* ignore */ }
  }

  return { factoryName, workersNotified, workersSkipped, driverNotified };
}

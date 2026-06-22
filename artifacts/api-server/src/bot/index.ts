import { Markup, type Context } from "telegraf";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, factoriesTable, factoryOrdersTable,
  scheduleWeeksTable, scheduleEntriesTable, driverShiftAssignmentsTable, adminsTable,
  absenceRequestsTable, driverTripsTable, unplannedWorkersTable, availabilityTable,
  candidatesTable, hoursDisputesTable, advanceRequestsTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and, desc, inArray, ne } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  readAvailabilityFromSheets, syncAvailabilityToDb, getWorkersWhoHaventSubmitted,
  DAY_NAMES_UK, DAYS,
} from "../services/sheets";
import {
  generateSchedule, formatWeekStart, getNextMonday, getCurrentMonday,
} from "../services/scheduleGenerator";
import {
  exportScheduleToDrive, getDriveFolderLink, ensureFolderStructure, uploadReportPhoto,
} from "../services/drive";
import { bot } from "./instance";
import { sendAlert } from "../lib/alerts";
import { setState, getState, clearState } from "./state";
import { nowWarsaw, warsawDateStr, warsawDayName, shiftAnchor, factoryShiftStart, factoryShifts, factoryShiftHours } from "./time";
import {
  getMenuDriverFactory, sendAvailabilityKeyboard,
  getAssignedWorkerIds, getAssignedEntries, getReserveForShift, renderShiftEditor, showReserveSummary,
  loadOrderMap, saveOrderDay, renderOrderBoard, renderAttendanceMenu, showWorkerSchedule,
  showHdSlots, showFullWeekSchedule, showFactoryWeekSchedule, showDriverShift, showDriverWeek,
  type OrderMap,
} from "./views";
import { adminMenu, workerMenu, headDriverMenu, driverMenu, managementMenu } from "./menus";
import { t, trAll, tb, bhears, LANGS, LANG_LABEL, OFFICE_LANGS, asLang, oLang, dayShort, stageLabel, type Lang } from "./i18n";

// Worker's chosen UI language (defaults to Ukrainian)
const wlang = (w?: { language?: string | null } | null): Lang => asLang(w?.language);
// Worker reply keyboard trimmed by the worker's factory settings (availability/hours
// buttons). Falls back to the full menu when the worker has no factory yet.
const workerMenuFor = async (worker?: { factoryId?: number | null } | null, lang: Lang = "uk") => {
  if (!worker?.factoryId) return workerMenu(lang);
  const [f] = await db
    .select({ availability: factoriesTable.usesAvailability, hours: factoriesTable.showWorkerHours })
    .from(factoriesTable).where(eq(factoriesTable.id, worker.factoryId));
  return workerMenu(lang, f ? { availability: f.availability, hours: f.hours } : {});
};
// Office/admin & driver chosen UI language (uk default; only uk/en offered)
const olang = (r?: { language?: string | null } | null): Lang => oLang(r?.language);
// Inline keyboard for choosing a language
const langPickKeyboard = () => Markup.inlineKeyboard(LANGS.map(l => [Markup.button.callback(LANG_LABEL[l], `setlang:${l}`)]));

// Central handler-error trap: keep the bot alive on per-update errors, log + alert.
// PII-safe — we report only the update TYPE and the error, never message text /
// user names / phones.
bot.catch((err: any, ctx) => {
  logger.error({ err, updateType: ctx?.updateType }, "Telegraf handler error");
  void sendAlert({ service: "bot", kind: err?.name, source: ctx?.updateType, message: err?.message ?? String(err) });
});

// Guard: is this Telegram id already linked to a *different* worker/driver?
// telegram_id is UNIQUE per table, so setting an already-taken id throws — these
// let callers show a friendly message instead of hitting the DB error.
async function tgTakenByWorker(tid: string, exceptId?: number): Promise<boolean> {
  const rows = await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.telegramId, tid));
  return rows.some(r => r.id !== exceptId);
}
async function tgTakenByDriver(tid: string, exceptId?: number): Promise<boolean> {
  const rows = await db.select({ id: driversTable.id }).from(driversTable).where(eq(driversTable.telegramId, tid));
  return rows.some(r => r.id !== exceptId);
}
// Office/driver picker — uk/en only (label kept simple)
const officeLangKeyboard = () => Markup.inlineKeyboard(
  OFFICE_LANGS.map(l => [Markup.button.callback(LANG_LABEL[l], `olang:${l}`)]),
);
import { DAY_UK, SHIFT_SHORT, splitMessage, escapeHtml, mdSafe } from "./display";
import { isAdmin, getAdmin, getWorker, getDriver } from "./roles";
import {
  sendLongMessage, notifyAdmins, sendScheduleToAllWorkers, sendScheduleToHeadDriver,
  notifyDriverOfAssignment, notifyAbsentWorker, refreshExcelReports, notifyRoles,
  notifyWorkerAdvance,
} from "./notify";

export { bot };

// ── Chat tracking + driver username capture ──────────────────────────
import { installChatTracking, recordBotMessage } from "./chat";
installChatTracking();

bot.use(async (ctx, next) => {
  try {
    // record the user's own incoming private message so a "clear chat" can remove it too
    if (ctx.chat?.type === "private" && (ctx.message as any)?.message_id) {
      recordBotMessage(String(ctx.chat.id), (ctx.message as any).message_id);
    }
    // keep driver @username fresh for t.me links (only writes if it actually changed)
    const uname = ctx.from?.username;
    if (uname) {
      const tid = String(ctx.from!.id);
      const d = (await db.select({ id: driversTable.id, username: driversTable.username }).from(driversTable).where(eq(driversTable.telegramId, tid)))[0];
      if (d && d.username !== uname) await db.update(driversTable).set({ username: uname }).where(eq(driversTable.id, d.id));
    }
  } catch { /* never block on bookkeeping */ }
  return next();
});

// Time/view helpers live in ./time and ./views.

// Pre-flight stats for the generate wizard: how much is ordered vs available
async function weekFactoryStats(factoryId: number | undefined, weekStart: string) {
  const orderConds = [eq(factoryOrdersTable.weekStart, weekStart)];
  if (factoryId != null) orderConds.push(eq(factoryOrdersTable.factoryId, factoryId));
  const orders = await db.select({ day: factoryOrdersTable.dayOfWeek, needed: factoryOrdersTable.workersNeeded })
    .from(factoryOrdersTable).where(and(...orderConds));
  const ordersTotal = orders.reduce((s, o) => s + (o.needed || 0), 0);
  const daysWithOrders = new Set(orders.filter(o => o.needed > 0).map(o => o.day)).size;

  const avail = await db.select({ workerId: availabilityTable.workerId, wFactory: workersTable.factoryId })
    .from(availabilityTable)
    .leftJoin(workersTable, eq(availabilityTable.workerId, workersTable.id))
    .where(eq(availabilityTable.weekStart, weekStart));
  const relevant = avail.filter(a => factoryId == null || !a.wFactory || a.wFactory === factoryId);
  const availWorkers = new Set(relevant.map(a => a.workerId).filter(Boolean)).size;
  return { ordersTotal, daysWithOrders, availWorkers, availSlots: relevant.length };
}

// Next sequential 5-digit worker code (mirrors the web panel's generator)
async function genWorkerCode(): Promise<string> {
  const all = await db.select({ code: workersTable.workerCode }).from(workersTable);
  const max = all.map(r => parseInt(r.code ?? "0", 10)).filter(n => !isNaN(n)).reduce((a, b) => Math.max(a, b), 0);
  return String(max + 1).padStart(5, "0");
}

// Generate a unique 5-digit invite code for a driver
async function genDriverCode(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const existing = await db.select().from(driversTable).where(eq(driversTable.inviteCode, code));
    if (existing.length === 0) return code;
  }
  return String(Date.now()).slice(-6); // fallback
}

// ─── /start ──────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const tid = String(ctx.from.id);
  const name = ctx.from.first_name;
  clearState(tid);

  const payload = (ctx as any).startPayload as string | undefined;

  if (payload && payload !== "") {
    const code = payload.trim();

    // Driver invite link: ?start=drv<code>
    if (code.toLowerCase().startsWith("drv")) {
      const driverCode = code.slice(3);
      const driverByCode = await db.select().from(driversTable).where(eq(driversTable.inviteCode, driverCode));
      if (driverByCode.length > 0) {
        const d = driverByCode[0]!;
        if (d.telegramId && d.telegramId !== tid) {
          return ctx.reply("❌ Це посилання вже використано іншим акаунтом. Зверніться до адміністратора.");
        }
        if (!d.telegramId) {
          if (await tgTakenByDriver(tid, d.id)) {
            return ctx.reply("❌ Цей Telegram уже прив'язаний до іншого водія. Зверніться до адміністратора.");
          }
          await db.update(driversTable).set({ telegramId: tid, username: ctx.from.username ?? null }).where(eq(driversTable.id, d.id));
        }
        const dl = olang(d);
        const menu = d.isHeadDriver ? headDriverMenu(dl) : driverMenu(dl);
        return ctx.reply(tb(dl, "✅ Привіт, *{name}*!\n\nВас прив'язано до бота як водія.", { name: mdSafe(d.name) }), { parse_mode: "Markdown", ...menu });
      }
      return ctx.reply("❌ Посилання недійсне або водія не знайдено. Зверніться до адміністратора.");
    }

    // Admin/user invite link: ?start=adm<code>
    if (code.toLowerCase().startsWith("adm")) {
      const admCode = code.slice(3);
      const byCode = await db.select().from(adminsTable).where(eq(adminsTable.inviteCode, admCode));
      if (byCode.length === 0) return ctx.reply("❌ Посилання недійсне. Зверніться до власника.");
      const a = byCode[0]!;
      if (a.telegramId && a.telegramId !== tid) return ctx.reply("❌ Це посилання вже використано іншим акаунтом.");
      if (!a.telegramId) {
        const dup = await db.select().from(adminsTable).where(eq(adminsTable.telegramId, tid));
        if (dup.length > 0) return ctx.reply("❌ Ваш акаунт вже зареєстрований у панелі.");
        await db.update(adminsTable).set({ telegramId: tid, inviteCode: null }).where(eq(adminsTable.id, a.id));
      }
      const ROLE_UK: Record<string, string> = { owner: "Власник", scheduler: "Графікова", driver: "Водій" };
      setState(tid, "web_login:username", {});
      return ctx.reply(
        `✅ Привіт, *${mdSafe(a.name)}*!\n\nВас додано до панелі (роль: *${ROLE_UK[a.role] ?? a.role}*).\n\nЗадамо веб-доступ. Введіть *логін* (3–32 символи, лат./цифри):`,
        { parse_mode: "Markdown", ...Markup.removeKeyboard() },
      );
    }

    // Referral link: ?start=ref<referrerWorkerId> — a worker invites a friend
    if (code.toLowerCase().startsWith("ref")) {
      const referrerId = Number(code.slice(3));
      const referrer = (await db.select().from(workersTable).where(eq(workersTable.id, referrerId)))[0];
      if (!referrer) return ctx.reply("❌ Посилання недійсне. Зверніться до того, хто його надіслав.");
      // already a worker?
      const asWorker = (await db.select().from(workersTable).where(eq(workersTable.telegramId, tid)))[0];
      if (asWorker) return ctx.reply(`✅ Ви вже працівник (*${mdSafe(asWorker.fullName)}*) — запрошення не потрібне.`, { parse_mode: "Markdown", ...(await workerMenuFor(asWorker, wlang(asWorker))) });
      // already a candidate?
      const asCand = (await db.select().from(candidatesTable).where(eq(candidatesTable.telegramId, tid)))[0];
      if (asCand) return ctx.reply("✅ Ви вже у списку кандидатів. Менеджер зв'яжеться з вами найближчим часом.");
      setState(tid, "candidate_signup:name", { referrerId, referrerName: referrer.fullName, factoryId: referrer.factoryId ?? null });
      return ctx.reply(
        `👋 Вітаємо! Вас запросив(ла) *${mdSafe(referrer.fullName)}* на роботу.\n\nЗалиште заявку — введіть ваше *ім'я та прізвище*:`,
        { parse_mode: "Markdown", ...Markup.removeKeyboard() },
      );
    }

    // Factory self-signup link: ?start=fac<factoryId> — person registers themselves
    if (code.toLowerCase().startsWith("fac")) {
      const factoryId = Number(code.slice(3));
      const fac = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
      if (!fac) return ctx.reply("❌ Посилання недійсне або фабрику не знайдено. Зверніться до адміністратора.");
      const existing = (await db.select().from(workersTable).where(eq(workersTable.telegramId, tid)))[0];
      if (existing) {
        return ctx.reply(`✅ Ви вже зареєстровані як *${mdSafe(existing.fullName)}*.`, { parse_mode: "Markdown", ...(await workerMenuFor(existing, wlang(existing))) });
      }
      setState(tid, "worker_signup", { factoryId, factoryName: fac.name });
      return ctx.reply(
        `👋 Вітаємо! Реєстрація на фабрику *${mdSafe(fac.name)}*.\n\nВведіть ваше *ім'я та прізвище*:`,
        { parse_mode: "Markdown", ...Markup.removeKeyboard() },
      );
    }

    const workerByCode = await db.select().from(workersTable).where(eq(workersTable.workerCode, code));
    if (workerByCode.length > 0) {
      const w = workerByCode[0]!;
      if (w.telegramId && w.telegramId !== tid) {
        return ctx.reply("❌ Цей код вже використано іншим акаунтом. Зверніться до адміністратора.", { parse_mode: "Markdown" });
      }
      if (!w.telegramId) {
        if (await tgTakenByWorker(tid, w.id)) {
          return ctx.reply("❌ Цей Telegram уже прив'язаний до іншого працівника. Зверніться до адміністратора.", { parse_mode: "Markdown" });
        }
        await db.update(workersTable).set({ telegramId: tid }).where(eq(workersTable.id, w.id));
      }
      return ctx.reply(
        `✅ Привіт, *${mdSafe(w.fullName)}*!\n\nВас прив'язано до бота.\nВаш код: \`${code}\``,
        { parse_mode: "Markdown", ...(await workerMenuFor(w, wlang(w))) },
      );
    }
    // Unknown code or invalid link
    return ctx.reply("❌ Посилання недійсне або код не знайдено. Зверніться до адміністратора.", { parse_mode: "Markdown" });
  }

  const admin = await getAdmin(tid);
  if (admin) { const al = olang(admin); return ctx.reply(tb(al, "👋 Привіт, *{name}*! Ви адміністратор.", { name }), { parse_mode: "Markdown", ...adminMenu(al) }); }
  const driver = await getDriver(tid);
  if (driver) {
    const dl = olang(driver);
    const menu = driver.isHeadDriver ? headDriverMenu(dl) : driverMenu(dl);
    const role = driver.isHeadDriver ? tb(dl, "Ви головний водій.") : tb(dl, "Ваше меню:");
    const icon = driver.isHeadDriver ? "🚐" : "🚗";
    return ctx.reply(`${icon} ${tb(dl, "Привіт, *{name}*!", { name: driver.name })} ${role}`, { parse_mode: "Markdown", ...menu });
  }
  const worker = await getWorker(tid);
  if (worker) {
    // First time (no language chosen) → ask language before anything
    if (!worker.language) return ctx.reply(t("uk", "lang.choose") + " / Choose your language:", langPickKeyboard());
    const lang = wlang(worker);
    return ctx.reply(t(lang, "start.greet", { name: worker.fullName }), { parse_mode: "Markdown", ...(await workerMenuFor(worker, lang)) });
  }

  // Brand-new unregistered user → let them pick a language first (stored for registration)
  return ctx.reply("Оберіть мову / Choose your language / Elige idioma:", langPickKeyboard());
});

// ─── /adminsetup ─────────────────────────────────────────────────────────────

bot.command("adminsetup", async (ctx) => {
  const tid = String(ctx.from.id);
  if (await isAdmin(tid)) return ctx.reply("✅ Ви вже адміністратор.");
  const all = await db.select().from(adminsTable);
  if (all.length > 0) return ctx.reply("❌ Адмін вже зареєстрований. Зверніться до нього.");
  // First admin on a fresh install becomes the immutable head admin (owner + is_main).
  await db.insert(adminsTable).values({ telegramId: tid, name: ctx.from.first_name, role: "owner", isMain: true });
  return ctx.reply("✅ Ви зареєстровані як головний адміністратор!", adminMenu("uk"));
});

bot.command("getid", async (ctx) => {
  await ctx.reply(`Ваш Telegram ID: \`${ctx.from.id}\`\n\nПередайте його адміністратору для прив'язки.`, { parse_mode: "Markdown" });
});

bot.command("invite", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const link = `https://t.me/${ctx.botInfo.username}?start=join`;
  return ctx.reply(
    `🔗 <b>Запрошення до бота</b>\n\nНатисніть на посилання щоб скопіювати:\n<code>${escapeHtml(link)}</code>`,
    { parse_mode: "HTML" },
  );
});

// ─── Navigation ───────────────────────────────────────────────────────────────

bot.hears(bhears("⬅️ Назад"), async (ctx) => {
  const tid = String(ctx.from.id);
  clearState(tid);
  const admin = await getAdmin(tid);
  if (admin) { const al = olang(admin); return ctx.reply(tb(al, "Головне меню:"), adminMenu(al)); }
  const driver = await getDriver(tid);
  if (driver) { const dl = olang(driver); return ctx.reply(tb(dl, "Головне меню:"), driver.isHeadDriver ? headDriverMenu(dl) : driverMenu(dl)); }
  const worker = await getWorker(tid);
  const wl = wlang(worker);
  return ctx.reply(t(wl, "menu.title"), await workerMenuFor(worker, wl));
});

// ─── Office/admin & driver language switch ───────────────────────────────────
bot.hears(bhears("🌐 Мова / Language"), async (ctx) => {
  const tid = String(ctx.from.id);
  if (!(await isAdmin(tid)) && !(await getDriver(tid))) return;
  return ctx.reply("Оберіть мову / Choose language:", officeLangKeyboard());
});

bot.action(/^olang:(uk|en)$/, async (ctx) => {
  const tid = String(ctx.from.id);
  const lang = oLang(ctx.match[1]);
  const admin = await getAdmin(tid);
  if (admin) {
    await db.update(adminsTable).set({ language: lang }).where(eq(adminsTable.id, admin.id));
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    return ctx.reply(tb(lang, "✅ Мову змінено."), adminMenu(lang));
  }
  const driver = await getDriver(tid);
  if (driver) {
    await db.update(driversTable).set({ language: lang }).where(eq(driversTable.id, driver.id));
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    return ctx.reply(tb(lang, "✅ Мову змінено."), driver.isHeadDriver ? headDriverMenu(lang) : driverMenu(lang));
  }
  return ctx.answerCbQuery();
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN — FACTORY ORDERS
// ═══════════════════════════════════════════════════════════════════

bot.hears(bhears("📋 Замовлення фабрик"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const factories = await db.select().from(factoriesTable);
  if (factories.length === 0) return ctx.reply(tb(al, "Спочатку додайте фабрику через 👥 Управління → 🏭 Фабрики."));
  setState(tid, "order:select_factory", {});
  return ctx.reply(tb(al, "Оберіть фабрику для замовлення:"), Markup.keyboard([...factories.map(f => [f.name]), [tb(al, "⬅️ Назад")]]).resize());
});

// ─── Admin: Read Sheets ───────────────────────────────────────────────────────

bot.hears(bhears("📊 Читати таблицю"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  await ctx.reply(tb(al, "⏳ Зчитую Google Sheets..."));
  try {
    const rows = await readAvailabilityFromSheets();
    const weeks = [...new Set(rows.map(r => r.weekStart))].sort();
    if (weeks.length === 0) return ctx.reply(tb(al, "📭 Таблиця порожня або немає нових відповідей."));
    setState(tid, "sheets:select_week", { weeks });
    return ctx.reply(tb(al, "Оберіть тиждень для синхронізації:"), Markup.keyboard([...weeks.map(w => [`📅 ${w} (${formatWeekStart(w)})`]), [tb(al, "⬅️ Назад")]]).resize());
  } catch (e) {
    logger.error({ err: e }, "Error reading sheets");
    return ctx.reply(tb(al, "❌ Помилка читання таблиці. Перевірте що таблиця поділена з сервісним акаунтом."));
  }
});

// ─── Admin: Generate Schedule ─────────────────────────────────────────────────

bot.hears(bhears("🗓 Генерувати графік"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const factories = await db.select().from(factoriesTable);
  if (factories.length === 0) return ctx.reply(tb(al, "Спочатку додайте фабрику."), adminMenu(al));
  setState(tid, "gen:select_factory", {});
  return ctx.reply(tb(al, "Для якої фабрики генерувати графік?"), Markup.keyboard([...factories.map(f => [f.name]), [tb(al, "⬅️ Назад")]]).resize());
});

// ─── Admin: View / Approve Schedules ─────────────────────────────────────────

bot.hears(bhears("✅ Перегляд графіків"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const factories = await db.select().from(factoriesTable);
  if (factories.length === 0) return ctx.reply(tb(al, "Спочатку додайте фабрику."));
  setState(tid, "view:select_factory", {});
  return ctx.reply(tb(al, "Графік якої фабрики переглянути?"), Markup.keyboard([...factories.map(f => [f.name]), [tb(al, "⬅️ Назад")]]).resize());
});

// ─── Admin: Management ────────────────────────────────────────────────────────

bot.hears(bhears("👥 Управління"), async (ctx) => {
  const admin = await getAdmin(String(ctx.from.id)); if (!admin) return; const al = olang(admin);
  return ctx.reply(tb(al, "Управління:"), managementMenu(al));
});

// ─── Admin: Notifications ─────────────────────────────────────────────────────

bot.hears(bhears("📢 Розсилки"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const { getReminderHour } = await import("../services/scheduler");
  return ctx.reply(
    `📢 *${tb(al, "Розсилки")}*\n\n⏰ ${tb(al, "Авто-нагадування: щонеділі о *{h}:00* (Київ)", { h: getReminderHour() })}`,
    {
      parse_mode: "Markdown",
      ...Markup.keyboard([
        [tb(al, "📨 Нагадати заповнити таблицю")],
        [tb(al, "📢 Розіслати затверджений графік")],
        [tb(al, "⏰ Змінити час нагадування"), tb(al, "🔔 Тест нагадування")],
        [tb(al, "⬅️ Назад")],
      ]).resize(),
    },
  );
});

bot.hears(bhears("📨 Нагадати заповнити таблицю"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "remind:select_week", {});
  return ctx.reply(tb(al, "Введіть тиждень для нагадування (РРРР-ММ-ДД):"), Markup.keyboard([[getNextMonday()], [tb(al, "⬅️ Назад")]]).resize());
});

bot.hears(bhears("⏰ Змінити час нагадування"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "set_reminder_hour", {});
  return ctx.reply(tb(al, "Введіть годину нагадування (0–23, за Києвом):"), { parse_mode: "Markdown", ...Markup.keyboard([["15", "17", "18", "19", "20"], [tb(al, "⬅️ Назад")]]).resize() });
});

bot.hears(bhears("🔔 Тест нагадування"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  await ctx.reply(tb(al, "⏳ Надсилаю тестові нагадування..."));
  const { sendWeeklyReminders } = await import("../services/scheduler");
  const { notified, skipped } = await sendWeeklyReminders();
  return ctx.reply(tb(al, "✅ Тест завершено!\n📨 Надіслано: {n}\n⚠️ Пропущено: {s}", { n: notified, s: skipped }), Markup.keyboard([[tb(al, "⬅️ Назад")]]).resize());
});

bot.hears(bhears("📢 Розіслати затверджений графік"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.status, "approved"));
  if (weeks.length === 0) return ctx.reply(tb(al, "Немає затверджених графіків."));
  setState(tid, "send_schedule:select_week", { weeks: weeks.map(w => ({ id: w.id, start: w.weekStart })) });
  return ctx.reply(tb(al, "Оберіть тиждень для розсилки:"), Markup.keyboard([...weeks.map(w => [`✅ ${w.weekStart} (${formatWeekStart(w.weekStart)})`]), [tb(al, "⬅️ Назад")]]).resize());
});

// ─── Management: Workers ──────────────────────────────────────────────────────

bot.hears(bhears("📥 Імпорт графіку (Excel)"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "schedule_import:awaiting_file", {});
  return ctx.reply(
    tb(al, `📥 *Імпорт графіку з Excel*\n\nНадішліть Excel файл у форматі який генерує бот.\n\n*Очікуваний формат:*\n• Аркуш "Загальний" з колонками: ПІБ, Код, потім дні (Пн зм1, Пн зм2...)\n• Або будь-який аркуш з колонками: ПІБ | Код | Зміна | День\n\nБот визначить тиждень з назви файлу (формат: \`Графік 2026.06.01.xlsx\`)`),
    { parse_mode: "Markdown", ...Markup.keyboard([[tb(al, "⬅️ Назад")]]).resize() },
  );
});

bot.hears(bhears("➕ Додати працівника"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "add_worker", {});
  return ctx.reply(tb(al, "Введіть повне ім'я працівника (Прізвище Ім'я):"), Markup.removeKeyboard());
});

// Helper: show add_worker step prompt
async function promptAddWorkerStep(ctx: Context, data: Record<string, any>, al: Lang = "uk") {
  if (!data.name) {
    return ctx.reply(tb(al, "Введіть повне ім'я працівника:"), Markup.removeKeyboard());
  }
  if (!("factoryId" in data)) {
    const factories = await db.select().from(factoriesTable);
    if (factories.length === 0) {
      // No factories yet — skip factory selection
      data.factoryId = null;
      return ctx.reply(tb(al, "Введіть Telegram ID (або /skip):"), Markup.keyboard([["/skip"], [tb(al, "⬅️ Назад")]]).resize());
    }
    return ctx.reply(
      tb(al, "Оберіть фабрику для *{name}*:", { name: data.name }),
      { parse_mode: "Markdown", ...Markup.keyboard([...factories.map(f => [f.name]), [tb(al, "/skip — без фабрики")], [tb(al, "⬅️ Назад")]]).resize() },
    );
  }
  if (!("telegramId" in data)) {
    return ctx.reply(tb(al, "Введіть Telegram ID (або /skip):"), Markup.keyboard([["/skip"], [tb(al, "⬅️ Назад")]]).resize());
  }
  if (!("workerCode" in data)) {
    return ctx.reply(
      tb(al, "Введіть код працівника (тільки цифри) або /skip — автоматично:"),
      Markup.keyboard([["/skip"], [tb(al, "⬅️ Назад")]]).resize(),
    );
  }
  return;
}

bot.hears(bhears("📋 Список працівників"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const factories = await db.select().from(factoriesTable);
  setState(tid, "workers_list:select_filter", {});
  return ctx.reply(
    tb(al, "Показати працівників:"),
    Markup.keyboard([
      [tb(al, "👥 Усі працівники")],
      ...factories.map(f => [`🏭 ${f.name}`]),
      [tb(al, "⬅️ Назад")],
    ]).resize(),
  );
});

bot.hears(bhears("📥 Імпорт працівників"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "import:awaiting_file", {});
  return ctx.reply(
    tb(al, "📥 *Масовий імпорт працівників*\n\nНадішліть CSV або Excel (.xlsx) файл.\n\n*Формат CSV:*\n```\nПрізвище Ім'я,telegram_id,код\nІванов Іван,123456789,0001\nПетров Петро,,\n```\nКолонки telegram_id та код — необов'язкові. Перший рядок — заголовок (пропускається)."),
    { parse_mode: "Markdown", ...Markup.keyboard([[tb(al, "⬅️ Назад")]]).resize() },
  );
});

bot.hears(bhears("🔗 Прив'язати Telegram"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "link:enter_name", { type: "worker" });
  return ctx.reply(tb(al, "Введіть ім'я працівника для прив'язки:"), Markup.removeKeyboard());
});

// ─── Management: Drivers ──────────────────────────────────────────────────────

bot.hears(bhears("🚗 Водії"), async (ctx) => {
  const admin = await getAdmin(String(ctx.from.id)); if (!admin) return; const al = olang(admin);
  return ctx.reply(tb(al, "Управління водіями:"), Markup.keyboard([
    [tb(al, "➕ Додати водія"), tb(al, "📋 Список водіїв")],
    [tb(al, "📨 Запросити водія"), tb(al, "👑 Призначити головним")],
    [tb(al, "🔗 Прив'язати вручну (ID)")],
    [tb(al, "⬅️ Назад")],
  ]).resize());
});

bot.hears(bhears("➕ Додати водія"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "add_driver", {});
  return ctx.reply(tb(al, "Введіть ім'я водія:"), Markup.removeKeyboard());
});

bot.hears(bhears("📋 Список водіїв"), async (ctx) => {
  const admin = await getAdmin(String(ctx.from.id)); if (!admin) return; const al = olang(admin);
  const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
  if (drivers.length === 0) return ctx.reply(tb(al, "Немає водіїв."), managementMenu(al));
  const list = drivers.map((d, i) =>
    `${i + 1}. ${d.isHeadDriver ? "👑 " : ""}*${d.name}*${d.vehicle ? ` (${d.vehicle})` : ""}${d.telegramId ? " ✅" : " ⚠️"}`
  ).join("\n");
  return ctx.reply(`🚗 *${tb(al, "Водії")}*:\n\n${list}`, { parse_mode: "Markdown", ...Markup.keyboard([[tb(al, "⬅️ Назад")]]).resize() });
});

bot.hears(bhears("🔗 Прив'язати вручну (ID)"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "link:enter_name", { type: "driver" });
  return ctx.reply(tb(al, "Введіть ім'я водія для прив'язки:"), Markup.removeKeyboard());
});

bot.hears(bhears("📨 Запросити водія"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
  if (drivers.length === 0) return ctx.reply(tb(al, "Немає водіїв. Спочатку додайте водія."), managementMenu(al));
  setState(tid, "invite_driver:select", {});
  return ctx.reply(tb(al, "Оберіть водія, щоб отримати посилання-запрошення:"), Markup.keyboard([
    ...drivers.map(d => [`${d.name}${d.telegramId ? " ✅" : " ⚠️"}`]),
    [tb(al, "⬅️ Назад")],
  ]).resize());
});

bot.hears(bhears("👑 Призначити головним"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
  if (drivers.length === 0) return ctx.reply(tb(al, "Немає водіїв."));
  setState(tid, "set_head_driver", {});
  return ctx.reply(tb(al, "Оберіть головного водія:"), Markup.keyboard([...drivers.map(d => [`${d.isHeadDriver ? "👑 " : ""}${d.name}`]), [tb(al, "⬅️ Назад")]]).resize());
});

// ─── Management: Factories ────────────────────────────────────────────────────

bot.hears(bhears("🏭 Фабрики"), async (ctx) => {
  const admin = await getAdmin(String(ctx.from.id)); if (!admin) return; const al = olang(admin);
  return ctx.reply(tb(al, "Управління фабриками:"), Markup.keyboard([
    [tb(al, "➕ Додати фабрику"), tb(al, "📋 Список фабрик")],
    [tb(al, "⏰ Часи змін фабрики"), tb(al, "📧 Email клієнта")],
    [tb(al, "⬅️ Назад")],
  ]).resize());
});

bot.hears(bhears("⏰ Часи змін фабрики"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const factories = await db.select().from(factoriesTable);
  if (factories.length === 0) return ctx.reply(tb(al, "Спочатку додайте фабрику."));
  setState(tid, "factory_times:select", {});
  return ctx.reply(tb(al, "Оберіть фабрику для налаштування часів змін:"), Markup.keyboard([...factories.map(f => [f.name]), [tb(al, "⬅️ Назад")]]).resize());
});

bot.hears(bhears("📧 Email клієнта"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const factories = await db.select().from(factoriesTable);
  if (factories.length === 0) return ctx.reply(tb(al, "Спочатку додайте фабрику."));
  setState(tid, "factory_email:select", {});
  return ctx.reply(tb(al, "Оберіть фабрику для налаштування email клієнта:"), Markup.keyboard([...factories.map(f => [f.name]), [tb(al, "⬅️ Назад")]]).resize());
});

bot.hears(bhears("➕ Додати фабрику"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "add_factory", {});
  return ctx.reply(tb(al, "Введіть назву фабрики:"), Markup.removeKeyboard());
});

bot.hears(bhears("📋 Список фабрик"), async (ctx) => {
  const admin = await getAdmin(String(ctx.from.id)); if (!admin) return; const al = olang(admin);
  const factories = await db.select().from(factoriesTable);
  if (factories.length === 0) return ctx.reply(tb(al, "Немає фабрик."));
  const list = factories.map((f, i) => `${i + 1}. *${f.name}*${f.address ? `\n   📍 ${f.address}` : ""}`).join("\n");
  return ctx.reply(`🏭 *${tb(al, "Фабрики")}*:\n\n${list}`, { parse_mode: "Markdown", ...Markup.keyboard([[tb(al, "⬅️ Назад")]]).resize() });
});

// ─── Management: Fire worker ──────────────────────────────────────────────────

bot.hears(bhears("🔥 Звільнити працівника"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const workers = await db.select().from(workersTable)
    .where(and(eq(workersTable.isActive, true), ne(workersTable.status, "fired")))
    .orderBy(workersTable.fullName);
  if (workers.length === 0) return ctx.reply(tb(al, "Немає активних працівників."), managementMenu(al));
  setState(tid, "fire_worker:select", { workers: workers.map(w => ({ id: w.id, name: w.fullName, code: w.workerCode })) });
  return ctx.reply(tb(al, "Оберіть працівника для звільнення:"), Markup.keyboard([...workers.map(w => [`${w.fullName} (${w.workerCode ?? "—"})`]), [tb(al, "⬅️ Назад")]]).resize());
});

// ─── Admin: Manage admins (main admin only) ───────────────────────────────────

async function isMainAdmin(tid: string): Promise<boolean> {
  const first = await db.select().from(adminsTable).orderBy(adminsTable.id).limit(1);
  return first[0]?.telegramId === tid;
}

bot.hears(bhears("👑 Адміни"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  const admins = await db.select().from(adminsTable).orderBy(adminsTable.id);
  const isMain = await isMainAdmin(tid);
  const list = admins.map((a, i) =>
    `${i + 1}. *${a.name}* \`${a.telegramId}\`${i === 0 ? " 👑" : ""}`
  ).join("\n");
  await ctx.reply(`👑 *${tb(al, "Адміни")} (${admins.length})*:\n\n${list}\n\n${tb(al, "👑 = Головний адмін")}`, { parse_mode: "Markdown" });
  const rows: string[][] = [[tb(al, "🔐 Мій веб-доступ")]];
  if (isMain) rows.unshift([tb(al, "➕ Додати адміна"), tb(al, "🗑 Видалити адміна")]);
  rows.push([tb(al, "⬅️ Назад")]);
  return ctx.reply(
    isMain ? tb(al, "Управління адмінами:") : tb(al, "Веб-панель — задайте собі логін/пароль:"),
    Markup.keyboard(rows).resize(),
  );
});

// Set / reset this admin's web-panel login
bot.hears(bhears("🔐 Мій веб-доступ"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  setState(tid, "web_login:username", {});
  return ctx.reply(
    tb(al, "🔐 *Веб-панель*\n\nВведіть бажаний *логін* (латиниця/цифри, без пробілів):"),
    { parse_mode: "Markdown", ...Markup.removeKeyboard() },
  );
});

bot.hears(bhears("➕ Додати адміна"), async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isMainAdmin(tid)) return;
  const al = olang(await getAdmin(tid));
  setState(tid, "add_admin", {});
  return ctx.reply(
    tb(al, "Введіть Telegram ID нового адміна.\n\nПопросіть людину надіслати /getid боту і передати вам число."),
    Markup.removeKeyboard(),
  );
});

bot.hears(bhears("🗑 Видалити адміна"), async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isMainAdmin(tid)) return;
  const al = olang(await getAdmin(tid));
  const admins = await db.select().from(adminsTable).orderBy(adminsTable.id);
  const others = admins.slice(1); // Cannot remove main admin
  if (others.length === 0) return ctx.reply(tb(al, "Немає інших адмінів для видалення."), managementMenu(al));
  setState(tid, "remove_admin:select", { admins: others.map(a => ({ id: a.id, name: a.name, tid: a.telegramId })) });
  return ctx.reply(tb(al, "Оберіть адміна для видалення:"), Markup.keyboard([
    ...others.map(a => [`❌ ${a.name}`]),
    [tb(al, "⬅️ Назад")],
  ]).resize());
});

// ─── Admin: Google Drive ──────────────────────────────────────────────────────

bot.hears(bhears("☁️ Google Drive"), async (ctx) => {
  const tid = String(ctx.from.id);
  const admin = await getAdmin(tid); if (!admin) return; const al = olang(admin);
  await ctx.reply(tb(al, "⏳ Перевіряю папки на Google Drive..."));
  try {
    await ensureFolderStructure();
    const link = await getDriveFolderLink();
    return ctx.reply(
      tb(al, "☁️ *Google Drive*\n\n📁 Головна папка:\n{link}\n\nСтруктура:\n📂 Графіки — Excel графіків по тижнях\n📂 Облік годин — річний Excel з вкладками по місяцях\n📂 Поїздки водіїв — статистика водіїв\n📂 Рапорти — фото рапортів по фабриках та місяцях", { link: link ?? "" }),
      { parse_mode: "Markdown", ...managementMenu(al) },
    );
  } catch (e) {
    logger.error({ err: e }, "Drive folder check error");
    return ctx.reply(tb(al, "❌ Помилка підключення до Google Drive. Перевірте налаштування сервісного акаунту."), managementMenu(al));
  }
});

// ═══════════════════════════════════════════════════════════════════
// WORKER FLOWS
// ═══════════════════════════════════════════════════════════════════

// ── Language selection (worker bot is multilingual) ──
bot.hears(trAll("menu.language"), async (ctx) => {
  const lang = wlang(await getWorker(String(ctx.from.id)));
  return ctx.reply(t(lang, "lang.choose"), langPickKeyboard());
});

bot.action(/^setlang:(uk|en|es|ru|pl)$/, async (ctx) => {
  const tid = String(ctx.from.id);
  const lang = (ctx as any).match[1] as Lang;
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  const worker = await getWorker(tid);
  if (worker) {
    await db.update(workersTable).set({ language: lang }).where(eq(workersTable.id, worker.id));
    return ctx.reply(t(lang, "lang.changed"), await workerMenuFor(worker, lang));
  }
  // not a worker yet → remember choice for registration, show generic message
  setState(tid, "lang_pref", { lang });
  return ctx.reply(t(lang, "start.notReg", { name: ctx.from.first_name }));
});

async function showMyScheduleWeek(ctx: Context, workerId: number, wantWeekStart: string | null, editMsgId: number | undefined, lang: Lang, factoryId: number | null = null) {
  const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.status, "approved"));
  if (weeks.length === 0) {
    if (editMsgId) return; return ctx.reply(t(lang, "sched.noApproved"), await workerMenuFor({ factoryId }, lang));
  }
  const curMon = getCurrentMonday(), nextMon = getNextMonday();
  const cur = weeks.find(w => String(w.weekStart) === curMon);
  const next = weeks.find(w => String(w.weekStart) === nextMon);
  const tabs: { weekStart: string; labelKey: string; active: boolean }[] = [];
  if (cur) tabs.push({ weekStart: String(cur.weekStart), labelKey: "sched.tabThis", active: false });
  if (next) tabs.push({ weekStart: String(next.weekStart), labelKey: "sched.tabNext", active: false });
  let target = wantWeekStart ? weeks.find(w => String(w.weekStart) === wantWeekStart) : (cur ?? next);
  if (!target) target = cur ?? next ?? [...weeks].sort((a, b) => String(b.weekStart).localeCompare(String(a.weekStart)))[0];
  if (!target) return;
  for (const tb of tabs) tb.active = tb.weekStart === String(target.weekStart);
  return showWorkerSchedule(ctx, workerId, target.id, String(target.weekStart), tabs, editMsgId, lang);
}

bot.hears(trAll("menu.schedule"), async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  if (!worker) return ctx.reply(t(wlang(worker), "notRegistered"));
  return showMyScheduleWeek(ctx, worker.id, null, undefined, wlang(worker), worker.factoryId);
});

bot.action(/^wsched:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  await ctx.answerCbQuery();
  if (!worker) return;
  return showMyScheduleWeek(ctx, worker.id, (ctx as any).match[1], ctx.callbackQuery.message?.message_id, wlang(worker), worker.factoryId);
});

bot.hears(trAll("menu.myInfo"), async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  if (!worker) return;
  const lang = wlang(worker);
  return ctx.reply(
    t(lang, "info.body", { name: escapeHtml(worker.fullName), id: ctx.from.id, code: worker.workerCode ?? "—" }),
    { parse_mode: "HTML" },
  );
});

bot.hears(trAll("menu.referral"), async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  const lang = wlang(worker);
  if (!worker) return ctx.reply(t(lang, "notRegistered"));
  const link = `https://t.me/${ctx.botInfo.username}?start=ref${worker.id}`;
  const cands = await db.select().from(candidatesTable)
    .where(eq(candidatesTable.referrerWorkerId, worker.id)).orderBy(desc(candidatesTable.id));

  let msg = t(lang, "ref.header", { link: escapeHtml(link) });
  if (cands.length) {
    msg += t(lang, "ref.list", { n: cands.length });
    for (const c of cands) {
      const active = c.workerId ? t(lang, "ref.active") : "";
      const bonus = c.workerId ? (c.bonusPaid ? t(lang, "ref.bonusPaid") : t(lang, "ref.bonusWait")) : "";
      msg += `\n• <b>${escapeHtml(c.fullName)}</b> — ${stageLabel(lang, c.stage)}${active}${bonus}`;
    }
  } else {
    msg += t(lang, "ref.none");
  }
  return ctx.reply(msg, { parse_mode: "HTML" });
});

// ─── Salary advance: worker requests + sees status ────────────────────────────
const advStatusLabel = (lang: Lang, s: string) =>
  t(lang, s === "approved" ? "adv.stApproved" : s === "rejected" ? "adv.stRejected" : s === "paid" ? "adv.stPaid" : "adv.stPending");

bot.hears(trAll("menu.advance"), async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  const lang = wlang(worker);
  if (!worker) return ctx.reply(t(lang, "notRegistered"));
  const rows = await db.select().from(advanceRequestsTable)
    .where(eq(advanceRequestsTable.workerId, worker.id)).orderBy(desc(advanceRequestsTable.id)).limit(10);
  let msg: string;
  if (!rows.length) msg = t(lang, "adv.none");
  else {
    msg = t(lang, "adv.listHeader") + "\n\n" + rows.map(r => {
      const d = new Date(r.createdAt).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
      return `• ${d} — *${r.amount} zł* — ${advStatusLabel(lang, r.status)}`;
    }).join("\n");
  }
  return ctx.reply(msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "adv.new"), callback_data: "adv:new" }]] } });
});

bot.action("adv:new", async (ctx) => {
  const tid = String(ctx.from.id);
  await ctx.answerCbQuery();
  const worker = await getWorker(tid);
  const lang = wlang(worker);
  if (!worker) return;
  setState(tid, "advance:enter_amount", { workerId: worker.id, lang });
  return ctx.reply(t(lang, "adv.askAmount"), Markup.removeKeyboard());
});

// Admin acts on an advance straight from the Telegram notification.
bot.action(/^adv_(approve|reject|paid)_(\d+)$/, async (ctx) => {
  const tid = String(ctx.from.id);
  if (!(await isAdmin(tid))) { await ctx.answerCbQuery("Лише для адміністрації"); return; }
  const action = (ctx as any).match[1] as "approve" | "reject" | "paid";
  const id = Number((ctx as any).match[2]);
  const r = (await db.select().from(advanceRequestsTable).where(eq(advanceRequestsTable.id, id)))[0];
  if (!r) { await ctx.answerCbQuery("Не знайдено"); return; }
  const target = action === "approve" ? "approved" : action === "reject" ? "rejected" : "paid";
  if (target === "paid" && r.status !== "approved") { await ctx.answerCbQuery("Спершу затвердіть"); return; }
  const admin = await getAdmin(tid);
  const patch: any = { status: target };
  if (target === "paid") patch.paidAt = new Date();
  else { patch.decidedBy = admin?.id ?? null; patch.decidedAt = new Date(); }
  await db.update(advanceRequestsTable).set(patch).where(eq(advanceRequestsTable.id, id));
  await ctx.answerCbQuery("✅");
  const label = target === "approved" ? "✅ Затверджено" : target === "rejected" ? "❌ Відхилено" : "💸 Виплачено";
  try { await ctx.editMessageText(`${(ctx.callbackQuery.message as any)?.text ?? ""}\n\n— ${label}`); } catch { /* ignore */ }
  notifyWorkerAdvance(r.workerId, target, r.amount).catch(() => {});
});

bot.hears(trAll("menu.factoryInfo"), async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  const lang = wlang(worker);
  if (!worker) return ctx.reply(t(lang, "notRegistered"));
  if (!worker.factoryId) return ctx.reply(t(lang, "fac.noFactory"), await workerMenuFor(worker, lang));
  const f = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, worker.factoryId)))[0];
  if (!f) return ctx.reply(t(lang, "fac.notFound"), await workerMenuFor(worker, lang));
  let msg = `🏭 *${f.name}*\n`;
  if (f.address) msg += `📍 ${f.address}\n`;
  const shifts = factoryShifts(f);
  msg += `\n${t(lang, "fac.shifts")}\n`;
  if (shifts.length) shifts.forEach((s, i) => { msg += t(lang, "fac.shiftRow", { n: i + 1, start: s.start, end: s.end }) + "\n"; });
  else msg += t(lang, "fac.notSet") + "\n";
  // Pickup stops are shown only when the factory provides transport (uses_transport).
  if (f.usesTransport) {
    const stops = (f.stops ?? []) as { name: string; time: string }[];
    if (stops.length) {
      msg += `\n${t(lang, "fac.stops")}\n`;
      for (const st of stops) msg += `• ${st.name}${st.time ? ` — ${t(lang, "fac.stopAt")} *${st.time}*` : ""}\n`;
    } else {
      msg += `\n${t(lang, "fac.noStops")}\n`;
    }
  }
  return ctx.reply(msg, { parse_mode: "Markdown", ...(await workerMenuFor(worker, lang)) });
});

// ── Interactive "my hours" review: flag wrong/remove shifts, propose additions ──
const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtShortD = (d: Date) => d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

function renderHoursReview(data: any): { text: string; kb: any[] } {
  const lang = asLang(data.lang);
  const shifts = data.shifts as any[];
  const adds = data.adds as any[];
  const totalH = shifts.filter(s => s.mark !== "remove").reduce((s: number, x: any) => s + (x.hours || 0), 0);
  let text = `${t(lang, "hours.title")}\n\n${t(lang, "hours.disclaimer")}\n\n`;
  text += t(lang, "hours.month", { shifts: shifts.length, hours: totalH.toFixed(1) }) + "\n\n";
  text += shifts.length ? t(lang, "hr.instr") : t(lang, "hr.instrEmpty");
  const kb: any[] = [];
  shifts.forEach((s, i) => {
    const icon = s.mark === "remove" ? "🗑" : s.mark === "wrong" ? "✏️" : "📅";
    const hoursLabel = (s.mark !== "remove" && s.proposedHours != null) ? `${s.hours}→${s.proposedHours}` : `${s.hours}`;
    kb.push([Markup.button.callback(`${icon} ${s.dateLabel} · ${s.shift} · ${hoursLabel}`, `hrv:pick:${i}`)]);
  });
  adds.forEach((a: any, j: number) => {
    kb.push([Markup.button.callback(t(lang, "hr.added", { date: a.dateLabel, shift: a.shift }), `hrv:da:${j}`)]);
  });
  const changes = shifts.filter(s => s.mark).length + adds.length;
  kb.push([Markup.button.callback(t(lang, "hr.add"), "hrv:add")]);
  kb.push([Markup.button.callback(`${t(lang, "hr.send")}${changes ? ` (${changes})` : ""}`, "hrv:send")]);
  kb.push([Markup.button.callback(t(lang, "hr.close"), "hrv:x")]);
  return { text, kb };
}
const sendHoursReview = (ctx: Context, data: any) => {
  const { text, kb } = renderHoursReview(data);
  setState(String(ctx.from!.id), "hours_review", data);
  return ctx.reply(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(kb) });
};

// Load this month's PRESENT shifts for a worker (used by the read-only view + the edit review)
async function loadWorkerMonthShifts(workerId: number) {
  const rows = await db
    .select({
      id: scheduleEntriesTable.id, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift,
      weekStart: scheduleWeeksTable.weekStart, factoryId: scheduleEntriesTable.factoryId, factoryName: factoriesTable.name,
      shifts: factoriesTable.shifts, s1: factoriesTable.shift1Start, s2: factoriesTable.shift2Start, s3: factoriesTable.shift3Start,
      hoursOverride: scheduleEntriesTable.hoursOverride,
    })
    .from(scheduleEntriesTable)
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(eq(scheduleEntriesTable.workerId, workerId), eq(scheduleEntriesTable.status, "present"), eq(scheduleWeeksTable.status, "approved")));
  const now = nowWarsaw();
  return rows.map(r => {
    const idx = Math.max(0, DAYS.indexOf(r.day));
    const d = new Date((r.weekStart ?? "1970-01-01") + "T00:00:00"); d.setDate(d.getDate() + idx);
    const hours = r.hoursOverride ?? factoryShiftHours({ shifts: r.shifts, shift1Start: r.s1, shift2Start: r.s2, shift3Start: r.s3 }, r.shift as Shift);
    return { entryId: r.id, _t: d.getTime(), date: ymdLocal(d), dateLabel: fmtShortD(d), inCur: d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(), shift: r.shift as Shift, factoryId: r.factoryId, factoryName: r.factoryName ?? "—", hours, mark: "" };
  }).filter(s => s.inCur).sort((a, b) => a._t - b._t).map(({ _t, inCur, ...s }) => s);
}

// Read-only summary first; editing/reporting is behind a separate button.
bot.hears(trAll("menu.myHours"), async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  const lang = wlang(worker);
  if (!worker) return ctx.reply(t(lang, "notRegistered"));
  const shifts = await loadWorkerMonthShifts(worker.id);
  const total = shifts.reduce((s, x) => s + x.hours, 0);
  let msg = `${t(lang, "hours.title")}\n\n${t(lang, "hours.disclaimer")}\n\n`;
  msg += t(lang, "hours.month", { shifts: shifts.length, hours: total.toFixed(1) }) + "\n";
  if (shifts.length) {
    msg += `\n${t(lang, "hours.worked")}\n`;
    for (const s of shifts) msg += `${s.dateLabel} — ${s.shift} · 🏭 ${s.factoryName} · ${s.hours} год\n`;
  } else {
    msg += `\n${t(lang, "hours.none")}`;
  }
  return ctx.reply(msg, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: t(lang, "hours.editBtn"), callback_data: "hrv:start" }]] },
  });
});

// Enter the interactive correction mode (flag/remove/add shifts)
bot.action("hrv:start", async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  await ctx.answerCbQuery();
  if (!worker) return;
  const shifts = await loadWorkerMonthShifts(worker.id);
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  return sendHoursReview(ctx, { month: curMonthStr(), shifts, adds: [], lang: wlang(worker) });
});

// tap a shift → clear per-shift menu (change hours / delete)
bot.action(/^hrv:pick:(\d+)$/, async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "hours_review") return ctx.answerCbQuery();
  const i = Number((ctx as any).match[1]);
  const s = st.data.shifts[i];
  if (!s) return ctx.answerCbQuery();
  const lang = asLang(st.data.lang);
  const cur = s.proposedHours != null ? `${s.hours} → ${s.proposedHours} год` : `${s.hours} год`;
  const text = t(lang, "hr.shiftMenu", { date: s.dateLabel, shift: s.shift, factory: s.factoryName, hours: cur });
  const kb = [
    [Markup.button.callback(t(lang, "hr.changeHours"), `hrv:h:${i}`)],
    [Markup.button.callback(s.mark === "remove" ? t(lang, "hr.undelete") : t(lang, "hr.delete"), `hrv:r:${i}`)],
    [Markup.button.callback(t(lang, "hr.backList"), "hrv:back")],
  ];
  try { await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(kb) }); } catch { /* ignore */ }
  return ctx.answerCbQuery();
});

// back to the shift list
bot.action("hrv:back", async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "hours_review") return ctx.answerCbQuery();
  const { text, kb } = renderHoursReview(st.data);
  try { await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(kb) }); } catch { /* ignore */ }
  return ctx.answerCbQuery();
});

// toggle "remove this shift" (returns to the list)
bot.action(/^hrv:r:(\d+)$/, async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "hours_review") return ctx.answerCbQuery();
  const s = st.data.shifts[Number((ctx as any).match[1])];
  if (s) { s.mark = s.mark === "remove" ? "" : "remove"; if (s.mark === "remove") s.proposedHours = null; }
  setState(tid, "hours_review", st.data);
  const { text, kb } = renderHoursReview(st.data);
  try { await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(kb) }); } catch { /* ignore */ }
  return ctx.answerCbQuery();
});

// edit the worked hours for a shift → ask for the correct number
bot.action(/^hrv:h:(\d+)$/, async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "hours_review") return ctx.answerCbQuery();
  const i = Number((ctx as any).match[1]);
  const s = st.data.shifts[i];
  if (!s) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  setState(tid, "hrv_hours", { review: st.data, index: i });
  return ctx.reply(t(asLang(st.data.lang), "hr.askHours", { date: s.dateLabel, shift: s.shift, hours: s.hours }), { parse_mode: "Markdown", ...Markup.removeKeyboard() });
});

// remove a proposed addition
bot.action(/^hrv:da:(\d+)$/, async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "hours_review") return ctx.answerCbQuery();
  st.data.adds.splice(Number((ctx as any).match[1]), 1);
  setState(tid, "hours_review", st.data);
  const { text, kb } = renderHoursReview(st.data);
  try { await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(kb) }); } catch { /* ignore */ }
  return ctx.answerCbQuery();
});

// start "add a missing shift" sub-flow
bot.action("hrv:add", async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "hours_review") return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  setState(tid, "hrv_add:date", { review: st.data });
  return ctx.reply(t(asLang(st.data.lang), "hr.askDate"), { parse_mode: "Markdown" });
});

// choose a shift number for the addition
bot.action(/^hrva:s:(\d+)$/, async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "hrv_add:shift") return ctx.answerCbQuery();
  const { review, date, dateLabel, factoryId, factoryName } = st.data;
  review.adds.push({ date, dateLabel, shift: String((ctx as any).match[1]), factoryId, factoryName });
  await ctx.answerCbQuery("Додано");
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  return sendHoursReview(ctx, review);
});

bot.action("hrva:x", async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  if (st?.data?.review) return sendHoursReview(ctx, st.data.review);
  return clearState(tid);
});

// submit the review → create a structured hours dispute
bot.action("hrv:send", async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "hours_review") return ctx.answerCbQuery();
  const data = st.data;
  const items: any[] = [];
  for (const s of data.shifts) {
    if (s.mark === "remove") items.push({ kind: "remove", entryId: s.entryId, date: s.date, shift: s.shift, factoryId: s.factoryId, factoryName: s.factoryName });
    else if (s.mark === "wrong" && s.proposedHours != null) items.push({ kind: "wrong", entryId: s.entryId, date: s.date, shift: s.shift, factoryId: s.factoryId, factoryName: s.factoryName, hours: s.proposedHours });
  }
  for (const a of data.adds) items.push({ kind: "add", date: a.date, shift: a.shift, factoryId: a.factoryId ?? null, factoryName: a.factoryName });
  const lang = asLang(data.lang);
  if (!items.length) return ctx.answerCbQuery(t(lang, "hr.nothing"));
  const worker = await getWorker(tid);
  if (!worker) { clearState(tid); return ctx.answerCbQuery(); }
  await db.insert(hoursDisputesTable).values({ workerId: worker.id, month: data.month, items });
  clearState(tid);
  await ctx.answerCbQuery("Надіслано ✅");
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  // On-site bell notification + Telegram to owner/scheduler
  try {
    const summary = items.map(it => it.kind === "add" ? `➕ додати ${it.date} ${it.shift}зм`
      : it.kind === "remove" ? `🗑 прибрати ${it.date} ${it.shift}зм`
      : `✏️ ${it.date} ${it.shift}зм → ${it.hours} год`).join("\n");
    await notifyRoles("scheduler", {
      type: "hours_correction",
      title: `✏️ Правки годин: ${worker.fullName}`,
      body: summary,
    });
  } catch { /* best-effort */ }
  return ctx.reply(t(lang, "hr.sent"), await workerMenuFor(worker, lang));
});

bot.action("hrv:x", async (ctx) => {
  clearState(String(ctx.from.id));
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  return ctx.answerCbQuery("Закрито");
});

bot.hears(trAll("menu.absence"), async (ctx) => {
  const tid = String(ctx.from.id);
  const worker = await getWorker(tid);
  const lang = wlang(worker);
  if (!worker) return ctx.reply(t(lang, "notRegistered"));
  const curMon = getCurrentMonday(), nextMon = getNextMonday();
  const weeks = await db.select().from(scheduleWeeksTable)
    .where(and(eq(scheduleWeeksTable.status, "approved"), inArray(scheduleWeeksTable.weekStart, [curMon, nextMon])));
  if (weeks.length === 0) return ctx.reply(t(lang, "sched.noApproved"), await workerMenuFor(worker, lang));
  const weekById = new Map(weeks.map(w => [w.id, w]));
  const rows = await db
    .select({
      id: scheduleEntriesTable.id, weekId: scheduleEntriesTable.weekId, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift,
      factoryName: factoriesTable.name, fshifts: factoriesTable.shifts, s1: factoriesTable.shift1Start, s2: factoriesTable.shift2Start, s3: factoriesTable.shift3Start,
    })
    .from(scheduleEntriesTable)
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(eq(scheduleEntriesTable.workerId, worker.id), eq(scheduleEntriesTable.status, "scheduled"), inArray(scheduleEntriesTable.weekId, weeks.map(w => w.id))));
  if (rows.length === 0) return ctx.reply(t(lang, "abs.noShifts"), await workerMenuFor(worker, lang));

  const now = nowWarsaw();
  const items = rows.map(r => {
    const wk = weekById.get(r.weekId)!;
    const idx = Math.max(0, DAYS.indexOf(r.day));
    const d = new Date(String(wk.weekStart) + "T00:00:00"); d.setDate(d.getDate() + idx);
    const start = factoryShiftStart({ shifts: r.fshifts, shift1Start: r.s1, shift2Start: r.s2, shift3Start: r.s3 }, r.shift as Shift);
    const [hh, mm] = start.split(":").map(Number);
    const startDt = new Date(d); startDt.setHours(hh || 6, mm || 0, 0, 0);
    return {
      id: r.id, weekStart: String(wk.weekStart), weekId: r.weekId, day: r.day as DayOfWeek, shift: r.shift as Shift,
      factoryName: r.factoryName ?? "—", dateLabel: d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" }),
      start, _t: startDt.getTime(), hoursUntil: (startDt.getTime() - now.getTime()) / 3600000,
    };
  }).sort((a, b) => a._t - b._t);

  const eligible = items.filter(i => i.hoursUntil >= 24);
  const tooClose = items.filter(i => i.hoursUntil >= 0 && i.hoursUntil < 24);

  let msg = t(lang, "abs.title");
  if (tooClose.length) {
    msg += t(lang, "abs.tooLate") + "\n" + tooClose.map(i => `• ${i.dateLabel} ${dayShort(lang, i.day)} ${i.shift} — ${i.factoryName}`).join("\n");
  }
  if (eligible.length === 0) {
    msg += t(lang, "abs.noneEligible");
    return ctx.reply(msg, { parse_mode: "Markdown", ...(await workerMenuFor(worker, lang)) });
  }
  msg += t(lang, "abs.pick");
  setState(tid, "absence:pick", { workerId: worker.id, lang, items: eligible.map(i => ({ id: i.id, weekStart: i.weekStart, weekId: i.weekId, day: i.day, shift: i.shift })) });
  const kb = eligible.map(i => [{ text: `${i.dateLabel} ${dayShort(lang, i.day)} · ${i.shift} · ${i.factoryName}`, callback_data: `absreq:${i.id}` }]);
  return ctx.reply(msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } });
});

// Pick a shift to report absence for (24h already enforced when the list was built)
bot.action(/^absreq:(\d+)$/, async (ctx) => {
  const tid = String(ctx.from.id); const st = getState(tid);
  await ctx.answerCbQuery();
  if (st?.action !== "absence:pick") return;
  const lang = asLang(st.data.lang);
  const item = (st.data.items as any[]).find(i => i.id === Number((ctx as any).match[1]));
  if (!item) return;
  setState(tid, "absence:enter_reason", { workerId: st.data.workerId, lang, weekStart: item.weekStart, weekId: item.weekId, day: item.day, shift: item.shift, entryId: item.id });
  try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
  return ctx.reply(t(lang, "abs.askReason", { day: dayShort(lang, item.day), shift: item.shift }), { parse_mode: "Markdown", ...Markup.removeKeyboard() });
});

bot.hears(trAll("menu.report"), async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  if (!worker) return ctx.reply("❌ Ви не зареєстровані.");

  const now = nowWarsaw();
  const day = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const inLastWeek = daysInMonth - day < 7;   // останні 7 днів місяця
  const inFirstWeek = day <= 7;               // перші 7 днів місяця

  if (!inLastWeek && !inFirstWeek) {
    const daysLeft = daysInMonth - day;
    return ctx.reply(`⏰ Рапорти можна подавати за 7 днів до кінця місяця або в перші 7 днів нового.\n\nДо кінця місяця: ${daysLeft} днів.`, await workerMenuFor(worker, wlang(worker)));
  }

  // Визначаємо за який місяць рапорт
  let reportMonth: string;
  if (inLastWeek) {
    // Здаємо рапорт за поточний місяць
    reportMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  } else {
    // Перші 7 днів — рапорт за попередній місяць
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    reportMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  }
  const monthLabel = new Date(`${reportMonth}-01`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });

  // Визначаємо фабрику з графіку за цей місяць
  const [yearStr, monStr] = reportMonth.split("-");
  const monthStart = `${yearStr}-${monStr}-01`;
  const monthEnd = new Date(parseInt(yearStr!), parseInt(monStr!), 1).toISOString().split("T")[0]!;

  const factoryRows = await db
    .select({ id: factoriesTable.id, name: factoriesTable.name })
    .from(scheduleEntriesTable)
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(
      eq(scheduleEntriesTable.workerId, worker.id),
      eq(scheduleWeeksTable.status, "approved"),
    ));

  // Unique factories from this month's schedule
  const seen = new Set<number>();
  const uniqueFactories = factoryRows.filter(f => {
    if (!f.id || seen.has(f.id)) return false;
    seen.add(f.id); return true;
  });

  if (uniqueFactories.length === 0) {
    return ctx.reply(`📄 За місяць *${monthLabel}* у вас немає підтверджених змін. Зверніться до адміністратора.`, { parse_mode: "Markdown", ...(await workerMenuFor(worker, wlang(worker))) });
  }

  if (uniqueFactories.length === 1) {
    // Одна фабрика — одразу просимо фото
    setState(String(ctx.from.id), "report:awaiting_photo", {
      workerId: worker.id, workerName: worker.fullName,
      month: reportMonth, factory: uniqueFactories[0]!.name,
    });
    return ctx.reply(
      `📄 Рапорт за *${monthLabel}* — ${uniqueFactories[0]!.name}\n\nНадішліть фото рапорту:`,
      { parse_mode: "Markdown", ...Markup.removeKeyboard() },
    );
  }

  // Кілька фабрик — запитуємо яку
  setState(String(ctx.from.id), "report:select_factory", {
    workerId: worker.id, workerName: worker.fullName,
    month: reportMonth, factories: uniqueFactories.map(f => f.name),
  });
  return ctx.reply(
    `📄 Рапорт за *${monthLabel}*\n\nВи працювали на кількох фабриках. Оберіть:`,
    { parse_mode: "Markdown", ...Markup.keyboard([...uniqueFactories.map(f => [f.name!]), ["⬅️ Назад"]]).resize() },
  );
});

// ═══════════════════════════════════════════════════════════════════
// WORKER: AVAILABILITY VIA TELEGRAM (inline keyboard)
// ═══════════════════════════════════════════════════════════════════

bot.hears(trAll("menu.availability"), async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  const lang = wlang(worker);
  if (!worker) return ctx.reply(t(lang, "notRegistered"));
  // Manual factories: workers don't fill availability — admins set the schedule
  let shiftCount = 3;
  if (worker.factoryId) {
    const [f] = await db.select({ shiftCount: factoriesTable.shiftCount, usesAvailability: factoriesTable.usesAvailability })
      .from(factoriesTable).where(eq(factoriesTable.id, worker.factoryId));
    if (f && f.usesAvailability === false) return ctx.reply(t(lang, "av.manual"));
    if (f) shiftCount = f.shiftCount;
  }
  const weekStart = getNextMonday();
  const responses: Record<string, Shift[] | null> = {};
  DAYS.forEach(d => { responses[d] = null; });
  const existing = await db.select({ day: availabilityTable.dayOfWeek, shift: availabilityTable.shift })
    .from(availabilityTable)
    .where(and(eq(availabilityTable.weekStart, weekStart), eq(availabilityTable.workerId, worker.id)));
  for (const a of existing) {
    const arr = (responses[a.day] ??= []) as Shift[];
    if (!arr.includes(a.shift as Shift)) arr.push(a.shift as Shift);
  }
  const alreadyFilled = existing.length > 0;
  setState(String(ctx.from.id), "avail:filling", { weekStart, responses, shiftCount, lang });
  await ctx.reply(
    alreadyFilled ? t(lang, "av.already", { week: formatWeekStart(weekStart) }) : t(lang, "av.intro", { week: formatWeekStart(weekStart) }),
    { parse_mode: "Markdown" },
  );
  return sendAvailabilityKeyboard(ctx, weekStart, responses, undefined, shiftCount, lang);
});


// Availability day selection callback: avail_MON_1 toggles a shift; avail_MON_off = day off
bot.action(/^avail_([a-z]+)_(1|2|3|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tid = String(ctx.from.id);
  const state = getState(tid);
  if (state?.action !== "avail:filling") return;
  const [, day, shiftRaw] = ctx.match as RegExpMatchArray;
  const { responses, weekStart, shiftCount } = state.data;
  if (shiftRaw === "off") {
    responses[day!] = []; // explicit day off
  } else {
    const cur: Shift[] = Array.isArray(responses[day!]) ? responses[day!] : [];
    const s = shiftRaw as Shift;
    responses[day!] = cur.includes(s) ? cur.filter((x: Shift) => x !== s) : [...cur, s].sort();
  }
  setState(tid, "avail:filling", { ...state.data, responses });
  await sendAvailabilityKeyboard(ctx as any, weekStart, responses, ctx.callbackQuery.message?.message_id, shiftCount ?? 3, asLang(state.data.lang));
});

// Availability confirm callback
bot.action(/^avail_confirm_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery("Зберігаю...");
  const tid = String(ctx.from.id);
  const state = getState(tid);
  if (state?.action !== "avail:filling") return;
  const worker = await getWorker(tid);
  if (!worker) return;
  const { weekStart, responses } = state.data;
  const lang = asLang(state.data.lang);
  clearState(tid);

  // Delete previous availability for THIS worker/week only (latest submission wins).
  // Match by workerId so renames/typos don't leave stale rows.
  await db.delete(availabilityTable).where(
    and(eq(availabilityTable.weekStart, weekStart), eq(availabilityTable.workerId, worker.id))
  );

  // Insert new availability entries — one row per (day, shift); resolved to workerId
  const now = new Date();
  let count = 0;
  for (const [day, shifts] of Object.entries(responses) as [DayOfWeek, Shift[] | null][]) {
    if (!Array.isArray(shifts)) continue;
    for (const shift of shifts) {
      if (!["1", "2", "3", "4", "5", "6"].includes(shift)) continue;
      await db.insert(availabilityTable).values({
        fullNameRaw: worker.fullName,
        workerId: worker.id,
        source: "telegram",
        weekStart,
        dayOfWeek: day,
        shift,
        submittedAt: now,
      });
      count++;
    }
  }

  const summary = DAYS.map(d => {
    const s = responses[d] as Shift[] | null;
    const txt = !Array.isArray(s) || s.length === 0 ? t(lang, "sched.dayOff") : s.map(x => SHIFT_SHORT[x]).join(", ");
    return `${dayShort(lang, d)}: ${txt}`;
  }).join("\n");
  try {
    await ctx.editMessageText(
      t(lang, "av.saved", { week: formatWeekStart(weekStart), summary }),
      { parse_mode: "Markdown" },
    );
  } catch { /* ignore */ }
});

bot.action("avail_cancel", async (ctx) => {
  await ctx.answerCbQuery();
  clearState(String(ctx.from.id));
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
});

// ═══════════════════════════════════════════════════════════════════
// ORDER BOARD CALLBACKS
// ═══════════════════════════════════════════════════════════════════

bot.action(/^ord_day_([a-z]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tid = String(ctx.from.id);
  const state = getState(tid);
  if (state?.action !== "order:board") return;
  const day = ctx.match[1]!;
  const cur = state.data.orders[day] ?? [0, 0, 0];
  setState(tid, "order:await_day", { ...state.data, editDay: day });
  return ctx.reply(
    `✏️ *${DAY_NAMES_UK[day as DayOfWeek]}*\nПоточні: \`${cur[0]} ${cur[1]} ${cur[2]}\`\n\nВведіть 3 числа (1зм 2зм 3зм), напр. \`8 12 5\`\nАбо \`0 0 0\` — вихідний:`,
    { parse_mode: "Markdown", ...Markup.removeKeyboard() },
  );
});

bot.action("ord_all", async (ctx) => {
  await ctx.answerCbQuery();
  const tid = String(ctx.from.id);
  const state = getState(tid);
  if (state?.action !== "order:board") return;
  setState(tid, "order:await_all", { ...state.data });
  return ctx.reply(
    "🔁 Введіть 3 числа (1зм 2зм 3зм) — застосуються до *всіх 7 днів*, напр. `8 12 5`:",
    { parse_mode: "Markdown", ...Markup.removeKeyboard() },
  );
});

bot.action("ord_copyprev", async (ctx) => {
  await ctx.answerCbQuery("Копіюю...");
  const tid = String(ctx.from.id);
  const state = getState(tid);
  if (state?.action !== "order:board") return;
  const { factoryId, weekStart } = state.data;
  const prev = new Date(weekStart); prev.setDate(prev.getDate() - 7);
  const prevWeek = prev.toISOString().split("T")[0]!;
  const prevMap = await loadOrderMap(factoryId, prevWeek);
  const hasAny = DAYS.some(d => (prevMap[d] ?? [0, 0, 0]).some(n => n > 0));
  if (!hasAny) return ctx.answerCbQuery("⚠️ Минулий тиждень порожній", { show_alert: true });
  for (const d of DAYS) await saveOrderDay(factoryId, weekStart, d, prevMap[d]!);
  state.data.orders = prevMap;
  setState(tid, "order:board", state.data);
  return renderOrderBoard(ctx as any, state.data, ctx.callbackQuery.message?.message_id);
});

bot.action("ord_done", async (ctx) => {
  await ctx.answerCbQuery("Збережено!");
  const tid = String(ctx.from.id);
  const state = getState(tid);
  if (state?.action !== "order:board") { return ctx.reply("Готово.", adminMenu()); }
  const { factoryName, weekStart, orders } = state.data;
  clearState(tid);
  const total = DAYS.reduce((s, d) => s + (orders[d]?.reduce((a: number, b: number) => a + b, 0) ?? 0), 0);
  try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
  return ctx.reply(
    `✅ Замовлення для *${factoryName}* на тиждень ${formatWeekStart(weekStart)} збережено!\n📋 Всього: ${total} змін-місць.`,
    { parse_mode: "Markdown", ...adminMenu() },
  );
});

// ═══════════════════════════════════════════════════════════════════
// HEAD DRIVER FLOWS
// ═══════════════════════════════════════════════════════════════════

bot.hears(bhears("📋 Призначити водіїв"), async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver?.isHeadDriver) return;
  const dl = olang(driver);
  const weeks = await db.select().from(scheduleWeeksTable)
    .where(eq(scheduleWeeksTable.status, "approved")).orderBy(desc(scheduleWeeksTable.weekStart));
  if (weeks.length === 0) return ctx.reply(tb(dl, "Немає затверджених графіків."));
  setState(String(ctx.from.id), "hd:select_week", { weeks: weeks.map(w => ({ id: w.id, start: w.weekStart })) });
  return ctx.reply(tb(dl, "Оберіть тиждень:"), Markup.keyboard([...weeks.map(w => [`${w.weekStart} (${formatWeekStart(w.weekStart)})`]), [tb(dl, "⬅️ Назад")]]).resize());
});

bot.hears(bhears("📅 Графік тижня"), async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver?.isHeadDriver) return ctx.reply(tb(olang(driver), "❌ Немає доступу."));
  const dl = olang(driver);
  const weeks = await db.select().from(scheduleWeeksTable)
    .where(eq(scheduleWeeksTable.status, "approved")).orderBy(desc(scheduleWeeksTable.weekStart));
  if (weeks.length === 0) return ctx.reply(tb(dl, "Немає затверджених графіків."));
  const week = weeks[0]!;
  return showFullWeekSchedule(ctx, week.id, week.weekStart, dl);
});

bot.hears(bhears("👥 Мій список водіїв"), async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver?.isHeadDriver) return ctx.reply(tb(olang(driver), "❌ Немає доступу."));
  const dl = olang(driver);
  const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
  if (drivers.length === 0) return ctx.reply(tb(dl, "Список водіїв порожній."), headDriverMenu(dl));
  const list = drivers.map((d, i) =>
    `${i + 1}. ${d.isHeadDriver ? "👑 " : ""}*${d.name}*${d.vehicle ? ` 🚗 ${d.vehicle}` : ""}${d.telegramId ? " ✅" : " ⚠️"}`
  ).join("\n");
  return ctx.reply(`🚗 *${tb(dl, "Водії")} (${drivers.length})*:\n\n${list}\n\n${tb(dl, "👑 = головний водій (теж може возити зміни)\n✅ = підключений до бота")}`, { parse_mode: "Markdown", ...headDriverMenu(dl) });
});

// ═══════════════════════════════════════════════════════════════════
// DRIVER FLOWS
// ═══════════════════════════════════════════════════════════════════

bot.hears(bhears("📍 Моя зміна сьогодні"), async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver) return ctx.reply(tb(olang(driver), "❌ Ви не зареєстровані як водій."));
  const dayName = warsawDayName();
  return showDriverShift(ctx, driver.id, getCurrentMonday(), dayName, olang(driver));
});

bot.hears(bhears("📅 Мій графік"), async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver) return ctx.reply(tb(olang(driver), "❌ Ви не зареєстровані як водій."));
  const dl = olang(driver);
  const weeks = await db.select().from(scheduleWeeksTable)
    .where(eq(scheduleWeeksTable.status, "approved")).orderBy(desc(scheduleWeeksTable.weekStart));
  if (weeks.length === 0) return ctx.reply(tb(dl, "Немає графіків."), driverMenu(dl));
  const week = weeks[0]!;
  return showDriverWeek(ctx, driver.id, week.id, week.weekStart, dl);
});

bot.hears(bhears("🚌 Почати поїздку"), async (ctx) => {
  const tid = String(ctx.from.id);
  const driver = await getDriver(tid);
  if (!driver) return ctx.reply(tb(olang(driver), "❌ Ви не зареєстровані як водій."));
  const dl = olang(driver);
  const dayName = warsawDayName();
  const week = getCurrentMonday();
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply(tb(dl, "Немає активного графіку."), driverMenu(dl));
  const assignments = await db.select({ shift: driverShiftAssignmentsTable.shift, factoryId: driverShiftAssignmentsTable.factoryId })
    .from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id), eq(driverShiftAssignmentsTable.dayOfWeek, dayName), eq(driverShiftAssignmentsTable.driverId, driver.id)));
  if (assignments.length === 0) return ctx.reply(tb(dl, "📭 На {day} у вас немає призначень.", { day: DAY_NAMES_UK[dayName] }), driverMenu(dl));
  // If several assignments today, pick the one whose shift starts soonest from now
  const now = nowWarsaw();
  const factory = await getMenuDriverFactory(assignments[0]!.factoryId);
  const trip = assignments[0]!;
  const shiftStart = factoryShiftStart(factory, trip.shift as Shift);
  const expectedPickup = shiftAnchor(now, shiftStart, 60); // pickup 1h before shift
  const lateToPickup = now > expectedPickup;
  const existingTrip = await db.select({ id: driverTripsTable.id }).from(driverTripsTable)
    .where(and(eq(driverTripsTable.driverId, driver.id), eq(driverTripsTable.weekId, weeks[0]!.id), eq(driverTripsTable.dayOfWeek, dayName), eq(driverTripsTable.shift, trip.shift as Shift)));
  if (existingTrip.length > 0) {
    await db.update(driverTripsTable).set({ pickupStartedAt: now, lateToPickup }).where(eq(driverTripsTable.id, existingTrip[0]!.id));
  } else {
    await db.insert(driverTripsTable).values({
      driverId: driver.id, weekId: weeks[0]!.id, factoryId: trip.factoryId,
      dayOfWeek: dayName, shift: trip.shift as Shift, tripDate: warsawDateStr(),
      pickupStartedAt: now, lateToPickup,
    });
  }
  const timeStr = now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  return ctx.reply(
    `🚌 *${tb(dl, "Поїздку розпочато!")}*\n🏭 ${factory?.name ?? "—"} · ${SHIFT_SHORT[trip.shift as Shift]}\n\n${tb(dl, "Час:")} ${timeStr}${lateToPickup ? `\n⚠️ ${tb(dl, "Спізнення на збір (план {t})", { t: shiftAnchor(now, shiftStart, 60).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) })}` : `\n✅ ${tb(dl, "Вчасно на місці збору")}`}`,
    { parse_mode: "Markdown", ...(driver.isHeadDriver ? headDriverMenu(dl) : driverMenu(dl)) },
  );
});

bot.hears(bhears("🏭 Прибув на фабрику"), async (ctx) => {
  const tid = String(ctx.from.id);
  const driver = await getDriver(tid);
  if (!driver) return ctx.reply(tb(olang(driver), "❌ Ви не зареєстровані як водій."));
  const dl = olang(driver);
  const dayName = warsawDayName();
  const week = getCurrentMonday();
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply(tb(dl, "Немає активного графіку."), driverMenu(dl));
  // Prefer a trip already started today; otherwise the latest trip for today
  const trips = await db.select().from(driverTripsTable)
    .where(and(eq(driverTripsTable.driverId, driver.id), eq(driverTripsTable.weekId, weeks[0]!.id), eq(driverTripsTable.dayOfWeek, dayName)));
  if (trips.length === 0) return ctx.reply(tb(dl, "⚠️ Спочатку натисніть «🚌 Почати поїздку»."), driver.isHeadDriver ? headDriverMenu(dl) : driverMenu(dl));
  const t = trips.find(x => x.pickupStartedAt && !x.arrivedFactoryAt) ?? trips[0]!;
  const now = nowWarsaw();
  const factory = await getMenuDriverFactory(t.factoryId);
  const shiftStart = factoryShiftStart(factory, t.shift as Shift);
  const expectedFactory = shiftAnchor(now, shiftStart, 15); // be at factory 15 min before shift
  const lateToFactory = now > expectedFactory;
  await db.update(driverTripsTable).set({ arrivedFactoryAt: now, lateToFactory }).where(eq(driverTripsTable.id, t.id));
  const timeStr = now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  const travelMin = t.pickupStartedAt
    ? Math.round((now.getTime() - new Date(t.pickupStartedAt).getTime()) / 60000) : null;
  return ctx.reply(
    `🏭 *${tb(dl, "Прибуття зафіксовано!")}*\n🏭 ${factory?.name ?? "—"} · ${SHIFT_SHORT[t.shift as Shift]}\n\n${tb(dl, "Час:")} ${timeStr}${travelMin !== null ? `\n⏱ ${tb(dl, "В дорозі:")} ${travelMin} ${tb(dl, "хв")}` : ""}${lateToFactory ? `\n⚠️ ${tb(dl, "Запізнення (план до {t})", { t: expectedFactory.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) })}` : `\n✅ ${tb(dl, "Прибули вчасно")}`}`,
    { parse_mode: "Markdown", ...(driver.isHeadDriver ? headDriverMenu(dl) : driverMenu(dl)) },
  );
});

// ─── Driver: Report absent workers ────────────────────────────────────────────

bot.hears(bhears("⚠️ Не прийшли до машини"), async (ctx) => {
  const tid = String(ctx.from.id);
  const driver = await getDriver(tid);
  if (!driver) return ctx.reply(tb(olang(driver), "❌ Ви не зареєстровані як водій."));
  const dl = olang(driver);
  const dayName = warsawDayName();
  const week = getCurrentMonday();
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply(tb(dl, "Немає активного графіку."), driverMenu(dl));
  const myAssignments = await db.select({ shift: driverShiftAssignmentsTable.shift, factoryId: driverShiftAssignmentsTable.factoryId })
    .from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id), eq(driverShiftAssignmentsTable.dayOfWeek, dayName), eq(driverShiftAssignmentsTable.driverId, driver.id)));
  if (myAssignments.length === 0) return ctx.reply(tb(dl, "📭 На сьогодні у вас немає призначень."), driverMenu(dl));
  const myShifts = [...new Set(myAssignments.map(a => a.shift))];
  const myKeys = new Set(myAssignments.map(a => `${a.factoryId}-${a.shift}`));
  const workersRaw = await db
    .select({ id: scheduleEntriesTable.id, name: workersTable.fullName, status: scheduleEntriesTable.status, factoryId: scheduleEntriesTable.factoryId, shift: scheduleEntriesTable.shift })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, weeks[0]!.id), eq(scheduleEntriesTable.dayOfWeek, dayName), inArray(scheduleEntriesTable.shift, myShifts as Shift[]), eq(scheduleEntriesTable.status, "scheduled")));
  // Only workers in the exact factory+shift this driver carries
  const workers = workersRaw.filter(w => myKeys.has(`${w.factoryId}-${w.shift}`));
  if (workers.length === 0) return ctx.reply(tb(dl, "Всі явки вже відмічені (або немає працівників для ваших змін)."), driverMenu(dl));
  setState(tid, "report_absent:select", { weekId: weeks[0]!.id, dayName, workers: workers.map(w => ({ id: w.id, name: w.name })), selected: [] as number[] });
  const btns = workers.map(w => [`${w.name}`]);
  return ctx.reply(
    tb(dl, "⚠️ Оберіть хто *не прийшов* (натисніть ім'я щоб відмітити ❌):\n\nПотім натисніть «✅ Підтвердити»"),
    Markup.keyboard([...btns, [tb(dl, "✅ Підтвердити відсутніх")], [tb(dl, "⬅️ Назад")]]).resize(),
  );
});

// ─── Driver: Unplanned worker ──────────────────────────────────────────────────

bot.hears(bhears("➕ Позаплановий працівник"), async (ctx) => {
  const tid = String(ctx.from.id);
  const driver = await getDriver(tid);
  if (!driver) return ctx.reply(tb(olang(driver), "❌ Ви не зареєстровані як водій."));
  const dl = olang(driver);
  const dayName = warsawDayName();
  const week = getCurrentMonday();
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply(tb(dl, "Немає активного графіку."), driverMenu(dl));
  const assignments = await db.select({ shift: driverShiftAssignmentsTable.shift, factoryId: driverShiftAssignmentsTable.factoryId })
    .from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id), eq(driverShiftAssignmentsTable.dayOfWeek, dayName), eq(driverShiftAssignmentsTable.driverId, driver.id)));
  if (assignments.length === 0) return ctx.reply(tb(dl, "📭 На сьогодні у вас немає призначень."), driverMenu(dl));
  const a = assignments[0]!;
  setState(tid, "unplanned:enter_name", { weekId: weeks[0]!.id, driverId: driver.id, factoryId: a.factoryId, dayOfWeek: dayName, shift: a.shift });
  return ctx.reply(tb(dl, "Введіть ім'я або код позапланового працівника:"), Markup.removeKeyboard());
});

// ─── Driver: Attendance (multi-select) ────────────────────────────────────────

// ─── DRIVER BOARDING (посадка) — inline tap-to-board flow ───────────────────────
type BoardWorker = { key: string; entryId: number | null; workerId: number | null; name: string; factoryId: number; shift: string; boarded: boolean; unplanned: boolean };
type BoardData = { weekId: number; dayName: DayOfWeek; sections: { factoryId: number; shift: string; factoryName: string }[]; workers: BoardWorker[]; chatId: number; messageId: number; addFactoryId?: number; addShift?: string; lang?: Lang };

const boardingText = (dayName: DayOfWeek, lang: Lang = "uk") =>
  `🚌 *${tb(lang, "Посадка")}* — ${DAY_NAMES_UK[dayName]}\n\n${tb(lang, "Натискайте, хто сів у авто (⬜→✅). За потреби додайте людей. Коли всі сіли або час їхати — «Підтвердити посадку».")}`;

function boardingMarkup(data: BoardData) {
  const lang = data.lang ?? "uk";
  const rows: { text: string; callback_data: string }[][] = [];
  for (const sec of data.sections) {
    rows.push([{ text: `— ${sec.factoryName} · ${SHIFT_SHORT[sec.shift as Shift]} —`, callback_data: "brd:noop" }]);
    for (const w of data.workers.filter(w => w.factoryId === sec.factoryId && w.shift === sec.shift)) {
      rows.push([{ text: `${w.boarded ? "✅" : "⬜"} ${w.name}${w.unplanned ? " ➕" : ""}`, callback_data: `brd:t:${w.key}` }]);
    }
    rows.push([{ text: tb(lang, "➕ Додати людину"), callback_data: `brd:add:${sec.factoryId}:${sec.shift}` }]);
  }
  const boardedN = data.workers.filter(w => w.boarded).length;
  rows.push([{ text: `${tb(lang, "✅ Підтвердити посадку")} (${boardedN})`, callback_data: "brd:ok" }]);
  rows.push([{ text: tb(lang, "❌ Скасувати"), callback_data: "brd:x" }]);
  return { inline_keyboard: rows };
}

async function recordPickupTrip(driverId: number, weekId: number, dayName: DayOfWeek, factoryId: number, shift: string, now: Date, todayStr: string) {
  const PICKUP_HOURS: Record<string, number> = { "1": 5, "2": 13, "3": 21, "4": 5, "5": 13, "6": 21 };
  const expected = new Date(); expected.setHours(PICKUP_HOURS[shift] ?? 5, 0, 0, 0);
  const lateToPickup = now > expected;
  const existing = await db.select({ id: driverTripsTable.id }).from(driverTripsTable)
    .where(and(eq(driverTripsTable.driverId, driverId), eq(driverTripsTable.weekId, weekId), eq(driverTripsTable.dayOfWeek, dayName), eq(driverTripsTable.shift, shift as Shift), eq(driverTripsTable.factoryId, factoryId)));
  if (existing.length > 0) {
    await db.update(driverTripsTable).set({ pickupStartedAt: now, lateToPickup }).where(eq(driverTripsTable.id, existing[0]!.id));
  } else {
    await db.insert(driverTripsTable).values({ driverId, weekId, factoryId, dayOfWeek: dayName, shift: shift as Shift, tripDate: todayStr, pickupStartedAt: now, lateToPickup });
  }
}

bot.hears(bhears("✅ Посадка / явка"), async (ctx) => {
  const tid = String(ctx.from.id);
  const driver = await getDriver(tid);
  if (!driver) return;
  const dl = olang(driver);
  const menu = () => driver.isHeadDriver ? headDriverMenu(dl) : driverMenu(dl);
  const dayName = warsawDayName();
  const week = getCurrentMonday();
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply(tb(dl, "Немає активного графіку."), menu());
  const weekId = weeks[0]!.id;
  const myAssignments = await db.select({ shift: driverShiftAssignmentsTable.shift, factoryId: driverShiftAssignmentsTable.factoryId })
    .from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, weekId), eq(driverShiftAssignmentsTable.dayOfWeek, dayName), eq(driverShiftAssignmentsTable.driverId, driver.id)));
  if (myAssignments.length === 0) return ctx.reply(tb(dl, "У вас немає призначень на сьогодні."), menu());

  const factoryRows = await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable);
  const facName = (id: number) => factoryRows.find(f => f.id === id)?.name ?? tb(dl, "фабрика");
  const secKeys = new Set<string>();
  const sections: BoardData["sections"] = [];
  for (const a of myAssignments) {
    const k = `${a.factoryId}-${a.shift}`;
    if (secKeys.has(k)) continue; secKeys.add(k);
    sections.push({ factoryId: a.factoryId, shift: a.shift, factoryName: facName(a.factoryId) });
  }
  const myShifts = [...new Set(myAssignments.map(a => a.shift))];
  const entriesRaw = await db
    .select({ id: scheduleEntriesTable.id, workerName: workersTable.fullName, workerId: scheduleEntriesTable.workerId, shift: scheduleEntriesTable.shift, factoryId: scheduleEntriesTable.factoryId })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.dayOfWeek, dayName), inArray(scheduleEntriesTable.shift, myShifts as Shift[]), eq(scheduleEntriesTable.status, "scheduled")));
  const entries = entriesRaw.filter(e => secKeys.has(`${e.factoryId}-${e.shift}`));
  if (entries.length === 0) return ctx.reply(tb(dl, "Немає кого забирати — усіх уже забрали інші водії, або явку вже відмічено."), menu());

  const workers: BoardWorker[] = entries.map(e => ({ key: `e${e.id}`, entryId: e.id, workerId: e.workerId, name: e.workerName ?? "—", factoryId: e.factoryId, shift: e.shift, boarded: false, unplanned: false }));
  const data: BoardData = { weekId, dayName, sections, workers, chatId: ctx.chat!.id, messageId: 0, lang: dl };
  const sent = await ctx.reply(boardingText(dayName, dl), { parse_mode: "Markdown", reply_markup: boardingMarkup(data) });
  data.messageId = sent.message_id;
  setState(tid, "boarding", data);
  return;
});

bot.action("brd:noop", (ctx) => ctx.answerCbQuery());

bot.action(/^brd:t:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "boarding") return;
  const key = (ctx.match as RegExpMatchArray)[1];
  const w = (st.data as BoardData).workers.find(x => x.key === key);
  if (w) { w.boarded = !w.boarded; setState(tid, "boarding", st.data); }
  try { await ctx.editMessageReplyMarkup(boardingMarkup(st.data as BoardData)); } catch { /* ignore */ }
});

bot.action(/^brd:add:(\d+):(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "boarding") return;
  const [, fid, sh] = ctx.match as RegExpMatchArray;
  const bl = (st.data as BoardData).lang ?? "uk";
  setState(tid, "boarding:add_name", { ...st.data, addFactoryId: Number(fid), addShift: sh });
  await ctx.reply(tb(bl, "Введіть ім'я або код працівника, якого додати в авто:"), Markup.forceReply());
});

bot.action("brd:x", async (ctx) => {
  const stx = getState(String(ctx.from.id));
  const bl = (stx?.data as BoardData)?.lang ?? "uk";
  await ctx.answerCbQuery(tb(bl, "Скасовано"));
  clearState(String(ctx.from.id));
  try { await ctx.editMessageText(tb(bl, "❌ Посадку скасовано.")); } catch { /* ignore */ }
});

bot.action("brd:ok", async (ctx) => {
  await ctx.answerCbQuery(tb((getState(String(ctx.from.id))?.data as BoardData)?.lang ?? "uk", "Зберігаю..."));
  const tid = String(ctx.from.id); const st = getState(tid);
  if (st?.action !== "boarding") return;
  const data = st.data as BoardData; clearState(tid);
  const driver = await getDriver(tid);
  if (!driver) return;
  const now = new Date();
  const todayStr = warsawDateStr();
  const { weekId, dayName } = data;

  // 1) claim boarded workers → present (+ create entries for added people)
  const boarded = data.workers.filter(w => w.boarded);
  for (const w of boarded) {
    if (w.entryId) {
      await db.update(scheduleEntriesTable).set({ status: "present", pickedUpBy: driver.id }).where(eq(scheduleEntriesTable.id, w.entryId));
    } else if (w.workerId) {
      const [ne] = await db.insert(scheduleEntriesTable).values({ weekId, workerId: w.workerId, factoryId: w.factoryId, dayOfWeek: dayName, shift: w.shift as Shift, status: "present", pickedUpBy: driver.id }).returning();
      w.entryId = ne?.id ?? null;
      await db.insert(unplannedWorkersTable).values({ weekId, driverId: driver.id, factoryId: w.factoryId, dayOfWeek: dayName, shift: w.shift as Shift, workerName: w.name, workerId: w.workerId });
    } else {
      await db.insert(unplannedWorkersTable).values({ weekId, driverId: driver.id, factoryId: w.factoryId, dayOfWeek: dayName, shift: w.shift as Shift, workerName: w.name });
    }
  }

  // 2) record pickup trip per section; mark absent only once ALL assigned drivers confirmed
  const absentEntries: { id: number; name: string; factoryName: string; shift: string }[] = [];
  let leftForOthers = 0;
  for (const sec of data.sections) {
    await recordPickupTrip(driver.id, weekId, dayName, sec.factoryId, sec.shift, now, todayStr);
    const assigned = await db.select({ driverId: driverShiftAssignmentsTable.driverId })
      .from(driverShiftAssignmentsTable)
      .where(and(eq(driverShiftAssignmentsTable.weekId, weekId), eq(driverShiftAssignmentsTable.dayOfWeek, dayName), eq(driverShiftAssignmentsTable.factoryId, sec.factoryId), eq(driverShiftAssignmentsTable.shift, sec.shift as Shift)));
    const assignedIds = assigned.map(a => a.driverId);
    const trips = await db.select({ driverId: driverTripsTable.driverId, pickup: driverTripsTable.pickupStartedAt })
      .from(driverTripsTable)
      .where(and(eq(driverTripsTable.weekId, weekId), eq(driverTripsTable.dayOfWeek, dayName), eq(driverTripsTable.factoryId, sec.factoryId), eq(driverTripsTable.shift, sec.shift as Shift)));
    const confirmedIds = new Set(trips.filter(t => t.pickup).map(t => t.driverId));
    const allConfirmed = assignedIds.length > 0 && assignedIds.every(id => confirmedIds.has(id));
    const remaining = await db.select({ id: scheduleEntriesTable.id, name: workersTable.fullName })
      .from(scheduleEntriesTable).leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
      .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.dayOfWeek, dayName), eq(scheduleEntriesTable.factoryId, sec.factoryId), eq(scheduleEntriesTable.shift, sec.shift as Shift), eq(scheduleEntriesTable.status, "scheduled")));
    if (allConfirmed) {
      for (const r of remaining) {
        await db.update(scheduleEntriesTable).set({ status: "absent" }).where(eq(scheduleEntriesTable.id, r.id));
        absentEntries.push({ id: r.id, name: r.name ?? "—", factoryName: sec.factoryName, shift: sec.shift });
      }
    } else {
      leftForOthers += remaining.length;
    }
  }

  // 3) notify on no-shows (Telegram to admins + scheduler/head-driver bell + worker)
  for (const a of absentEntries) await notifyAbsentWorker(a.id, dayName);
  if (absentEntries.length > 0) {
    const lines = absentEntries.map(a => `• ${a.name} — ${a.factoryName} · ${SHIFT_SHORT[a.shift as Shift]}`).join("\n");
    await notifyAdmins(`⚠️ *Відсутні на зміні*\n🚗 Водій: ${driver.name}\n📅 ${DAY_NAMES_UK[dayName]}\n\n${lines}`, { parse_mode: "Markdown" });
    await notifyRoles("both", { type: "no_show", title: `🔴 Невихід на зміну (${absentEntries.length})`, body: `${DAY_NAMES_UK[dayName]} · водій ${driver.name}\n${lines}` });
  }
  refreshExcelReports().catch(e => logger.error({ err: e }, "refreshExcelReports failed"));

  const bl = data.lang ?? "uk";
  const timeStr = now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  let summary = `✅ *${tb(bl, "Посадку підтверджено")}* (${timeStr})\n\n🟢 ${tb(bl, "Сіли в авто:")} ${boarded.length}`;
  if (absentEntries.length > 0) summary += `\n🔴 ${tb(bl, "Не вийшли:")} ${absentEntries.length}`;
  if (leftForOthers > 0) summary += `\n🟡 ${tb(bl, "Залишено для інших водіїв:")} ${leftForOthers}`;
  summary += `\n\n🚌 ${tb(bl, "Час виїзду зафіксовано.")}`;
  try { await ctx.editMessageText(summary, { parse_mode: "Markdown" }); } catch { /* ignore */ }
  await ctx.reply("Готово.", driver.isHeadDriver ? headDriverMenu() : driverMenu());
});

// ═══════════════════════════════════════════════════════════════════
// DOCUMENT HANDLER — mass import
// ═══════════════════════════════════════════════════════════════════

bot.on("document", async (ctx) => {
  const tid = String(ctx.from.id);
  const state = getState(tid);
  if (!state) return;

  // ── Schedule Excel import ─────────────────────────────────────────
  if (state.action === "schedule_import:awaiting_file") {
    if (!await isAdmin(tid)) return;
    clearState(tid);
    const doc = ctx.message.document;
    const fileName = doc.file_name ?? "";
    if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls")) {
      return ctx.reply("❌ Тільки .xlsx або .xls файли.", adminMenu());
    }
    await ctx.reply("⏳ Читаю Excel...");
    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const resp = await fetch(fileLink.href);
      const buf = Buffer.from(await resp.arrayBuffer());
      const XLSX = (await import("xlsx")).default;
      const wb = XLSX.read(buf, { type: "buffer" });

      // Try to detect weekStart from filename: "Графік 2026.06.01.xlsx"
      const dateMatch = fileName.match(/(\d{4})\.(\d{2})\.(\d{2})/);
      const weekStart = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;
      if (!weekStart) {
        return ctx.reply("❌ Не вдалося визначити тиждень з назви файлу.\nОчікуваний формат: \`Графік 2026.06.01.xlsx\`", { parse_mode: "Markdown", ...adminMenu() });
      }

      // Parse "Загальний" sheet: row format = ПІБ | Код | Пн зм1 | Пн зм2 | Пн зм3 | Вт зм1 ...
      const wsName = wb.SheetNames.includes("Загальний") ? "Загальний" : wb.SheetNames[0]!;
      const ws = wb.Sheets[wsName]!;
      const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as (string | number)[][];

      // Find header row (contains "ПІБ" or "ПIБ")
      const headerIdx = rows.findIndex(r => String(r[0] ?? "").toLowerCase().includes("піб") || String(r[0] ?? "").includes("ПІБ"));
      if (headerIdx < 0) return ctx.reply("❌ Не знайдено рядок заголовку (очікується колонка ПІБ).", adminMenu());

      const headers = rows[headerIdx]!.map(h => String(h ?? "").toLowerCase());

      // Map column index → { day, shift }
      const COL_MAP: Record<string, { day: DayOfWeek; shift: Shift }> = {};
      const DAY_COLS: Array<[string, DayOfWeek]> = [
        ["понеділок", "mon"], ["вівторок", "tue"], ["середа", "wed"], ["четвер", "thu"],
        ["п'ятниця", "fri"], ["субота", "sat"], ["неділя", "sun"],
        ["пн", "mon"], ["вт", "tue"], ["ср", "wed"], ["чт", "thu"], ["пт", "fri"], ["сб", "sat"], ["нд", "sun"],
      ];
      headers.forEach((h, i) => {
        const dayMatch = DAY_COLS.find(([k]) => h.includes(k));
        const shiftMatch = h.match(/зм(\d)|shift\s*(\d)/);
        if (dayMatch && shiftMatch) {
          const shift = (shiftMatch[1] ?? shiftMatch[2]) as Shift;
          if (["1", "2", "3"].includes(shift)) COL_MAP[i] = { day: dayMatch[1] as DayOfWeek, shift };
        }
      });

      // Find all workers
      const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
      const allFactories = await db.select().from(factoriesTable);

      // Create or reuse draft week
      let weekId: number;
      const existing = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "draft")));
      if (existing.length > 0) {
        weekId = existing[0]!.id;
        await db.delete(scheduleEntriesTable).where(eq(scheduleEntriesTable.weekId, weekId));
      } else {
        const [nw] = await db.insert(scheduleWeeksTable).values({ weekStart, status: "draft" }).returning();
        weekId = nw!.id;
      }

      let assigned = 0, skipped = 0;
      const dataRows = rows.slice(headerIdx + 1).filter(r => r[0] && String(r[0]).trim().length > 2);

      for (const row of dataRows) {
        const name = String(row[0] ?? "").trim();
        const code = String(row[1] ?? "").trim();
        const worker = allWorkers.find(w =>
          w.fullName === name || w.workerCode === code ||
          w.fullName.toLowerCase().includes(name.toLowerCase().split(" ")[0]!)
        );
        if (!worker) { skipped++; continue; }

        for (const [colIdx, { day, shift }] of Object.entries(COL_MAP) as [string, { day: DayOfWeek; shift: Shift }][]) {
          const cell = row[parseInt(colIdx)];
          if (!cell || String(cell).trim() === "") continue;
          const factoryName = String(cell).trim();
          const factory = allFactories.find(f => f.name === factoryName) ?? allFactories.find(f => factoryName.includes(f.name));
          if (!factory) continue;
          await db.insert(scheduleEntriesTable).values({
            weekId, workerId: worker.id, factoryId: factory.id,
            dayOfWeek: day, shift, status: "scheduled",
          });
          assigned++;
        }
      }

      return ctx.reply(
        `✅ Імпорт завершено!\n\nТиждень: ${weekStart}\n📋 Призначено: ${assigned} змін\n⚠️ Пропущено (не знайдено): ${skipped}\n\nПеревірте через "✅ Перегляд графіків"`,
        adminMenu(),
      );
    } catch (e) {
      logger.error({ err: e }, "Schedule import error");
      return ctx.reply("❌ Помилка читання файлу.", adminMenu());
    }
  }

  if (state?.action !== "import:awaiting_file") return;
  if (!await isAdmin(tid)) return;
  clearState(tid);

  const doc = ctx.message.document;
  const fileName = doc.file_name ?? "";
  const isCSV = fileName.endsWith(".csv");
  const isXLSX = fileName.endsWith(".xlsx") || fileName.endsWith(".xls");
  if (!isCSV && !isXLSX) return ctx.reply("❌ Підтримуються лише .csv та .xlsx файли.", managementMenu());

  await ctx.reply("⏳ Обробляю файл...");
  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const resp = await fetch(fileLink.href);
    const buf = Buffer.from(await resp.arrayBuffer());

    let rows: string[][] = [];
    if (isCSV) {
      const text = buf.toString("utf-8");
      rows = text.split("\n").map(l => l.split(",").map(c => c.trim().replace(/^"|"$/g, "")));
    } else {
      const XLSX = (await import("xlsx")).default;
      const wb = XLSX.read(buf, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]!]!;
      rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][];
    }

    // Skip header row
    const dataRows = rows.slice(1).filter(r => r[0] && r[0].trim().length > 2);

    let added = 0, skipped = 0, updated = 0;
    const allCodes = await db.select({ code: workersTable.workerCode }).from(workersTable);
    let maxCode = allCodes.map(r => parseInt(r.code ?? "0", 10)).filter(n => !isNaN(n)).reduce((a, b) => Math.max(a, b), 0);

    for (const row of dataRows) {
      const fullName = (row[0] ?? "").trim();
      if (!fullName) continue;
      const telegramId = row[1]?.trim() || undefined;
      const workerCode = row[2]?.trim() || undefined;

      const existing = await db.select().from(workersTable).where(eq(workersTable.fullName, fullName));
      if (existing.length > 0) {
        // Update if new data provided
        if (telegramId || workerCode) {
          await db.update(workersTable).set({
            ...(telegramId ? { telegramId } : {}),
            ...(workerCode ? { workerCode } : {}),
          }).where(eq(workersTable.id, existing[0]!.id));
          updated++;
        } else { skipped++; }
        continue;
      }
      maxCode++;
      const newCode = workerCode ?? String(maxCode).padStart(5, "0");
      await db.insert(workersTable).values({ fullName, workerCode: newCode, telegramId });
      added++;
    }

    return ctx.reply(
      `✅ Імпорт завершено!\n\n➕ Додано: ${added}\n🔄 Оновлено: ${updated}\n⏭ Пропущено (вже є): ${skipped}`,
      managementMenu(),
    );
  } catch (e) {
    logger.error({ err: e }, "Import error");
    return ctx.reply("❌ Помилка обробки файлу. Перевірте формат.", managementMenu());
  }
});

// ═══════════════════════════════════════════════════════════════════
// PHOTO HANDLER — report submission
// ═══════════════════════════════════════════════════════════════════

bot.on("photo", async (ctx) => {
  const tid = String(ctx.from.id);
  const state = getState(tid);
  if (state?.action !== "report:awaiting_photo") return;
  const { data } = state;
  clearState(tid);
  const worker = await getWorker(tid);
  const menu = await workerMenuFor(worker, wlang(worker));
  await ctx.reply("⏳ Завантажую рапорт на Google Drive...");
  try {
    const photo = ctx.message.photo.at(-1)!;
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const resp = await fetch(fileLink.href);
    const buf = Buffer.from(await resp.arrayBuffer());
    const link = await uploadReportPhoto(data.factory, data.workerName, data.month, buf, "image/jpeg");
    if (link) return ctx.reply(`✅ Рапорт збережено!\n${link}`, menu);
    return ctx.reply("❌ Помилка збереження. Спробуйте ще раз.", menu);
  } catch (e) {
    logger.error({ err: e }, "Report upload error");
    return ctx.reply("❌ Помилка завантаження.", menu);
  }
});

// ═══════════════════════════════════════════════════════════════════
// TEXT MESSAGE HANDLER — multi-step flows
// ═══════════════════════════════════════════════════════════════════

bot.on("text", async (ctx) => {
  const tid = String(ctx.from.id);
  const text = ctx.message.text;
  const state = getState(tid);
  if (!state && text !== "⬅️ Назад") return;

  // ── Factory shift times ───────────────────────────────────────────
  if (state?.action === "factory_times:select") {
    const al = olang(await getAdmin(tid));
    const factories = await db.select().from(factoriesTable);
    const match = factories.find(f => f.name === text);
    if (!match) return ctx.reply(tb(al, "Оберіть фабрику зі списку."));
    setState(tid, "factory_times:enter", { factoryId: match.id, factoryName: match.name, shift: 1 });
    const current = [match.shift1Start, match.shift2Start, match.shift3Start].map((t, i) => `${tb(al, "Зміна")} ${i + 1}: ${t ?? tb(al, "не налаштовано")}`).join("\n");
    return ctx.reply(
      tb(al, "⏰ *{name}* — Часи змін\n\nПоточні налаштування:\n{cur}\n\nВведіть час початку *Зміни 1* (формат HH:MM, наприклад `06:00`):\nАбо /skip щоб не змінювати", { name: match.name, cur: current }),
      { parse_mode: "Markdown", ...Markup.keyboard([["/skip"], [tb(al, "⬅️ Назад")]]).resize() },
    );
  }

  if (state?.action === "factory_times:enter") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    const isSkip = text === "/skip";
    const isValid = isSkip || /^\d{1,2}:\d{2}$/.test(text.trim());
    if (!isValid) return ctx.reply(tb(al, "Введіть час у форматі HH:MM (наприклад `06:00`) або /skip:"), { parse_mode: "Markdown" });

    const timeVal = isSkip ? null : text.trim();
    const colMap: Record<number, string> = { 1: "shift1Start", 2: "shift2Start", 3: "shift3Start" };
    await db.update(factoriesTable)
      .set({ [colMap[data.shift]!]: timeVal ?? undefined })
      .where(eq(factoriesTable.id, data.factoryId));

    if (data.shift < 3) {
      data.shift++;
      setState(tid, "factory_times:enter", data);
      return ctx.reply(
        tb(al, "✅ Зміна {prev} збережена.\n\nВведіть час початку *Зміни {n}* (HH:MM або /skip):", { prev: data.shift - 1, n: data.shift }),
        { parse_mode: "Markdown", ...Markup.keyboard([["/skip"], [tb(al, "⬅️ Назад")]]).resize() },
      );
    }
    clearState(tid);
    const updated = await db.select().from(factoriesTable).where(eq(factoriesTable.id, data.factoryId));
    const f = updated[0]!;
    // Rebuild the `shifts` JSON from the collected starts (end = next start, +8h for the last)
    const starts = [f.shift1Start, f.shift2Start, f.shift3Start].filter(t => t && /^\d{1,2}:\d{2}$/.test(t)) as string[];
    const addH = (t: string, h: number) => `${String((Number(t.split(":")[0]) + h) % 24).padStart(2, "0")}:${t.split(":")[1]}`;
    const shifts = starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? addH(s, 8) }));
    await db.update(factoriesTable).set({ shifts, shiftCount: Math.max(1, shifts.length) }).where(eq(factoriesTable.id, data.factoryId));
    return ctx.reply(
      tb(al, "✅ *{name}* — часи змін збережено!\n\n{list}\n\n🔔 Нагадування будуть надсилатися за 2 години до початку кожної зміни.\n\nℹ️ Для гнучкого налаштування (до 6 змін, точний кінець) скористайтесь веб-панеллю.", { name: data.factoryName, list: shifts.map((s, i) => `${tb(al, "Зміна")} ${i + 1}: ${s.start}–${s.end}`).join("\n") || "—" }),
      { parse_mode: "Markdown", ...managementMenu(al) },
    );
  }

  // ── Factory client email ──────────────────────────────────────────
  if (state?.action === "factory_email:select") {
    const al = olang(await getAdmin(tid));
    const factories = await db.select().from(factoriesTable);
    const match = factories.find(f => f.name === text);
    if (!match) return ctx.reply(tb(al, "Оберіть фабрику зі списку."));
    setState(tid, "factory_email:enter", { factoryId: match.id, factoryName: match.name });
    return ctx.reply(
      tb(al, "📧 *{name}*\nПоточний email: {email}\n\nВведіть email клієнта (куди слати графік) або /clear щоб прибрати:", { name: match.name, email: match.clientEmail ?? tb(al, "не вказано") }),
      { parse_mode: "Markdown", ...Markup.keyboard([["/clear"], [tb(al, "⬅️ Назад")]]).resize() },
    );
  }

  if (state?.action === "factory_email:enter") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    if (text === "/clear") {
      await db.update(factoriesTable).set({ clientEmail: null }).where(eq(factoriesTable.id, data.factoryId));
      clearState(tid);
      return ctx.reply(tb(al, "✅ Email для *{name}* прибрано.", { name: data.factoryName }), { parse_mode: "Markdown", ...managementMenu(al) });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text.trim())) {
      return ctx.reply(tb(al, "❌ Невірний формат email. Введіть ще раз або /clear:"));
    }
    await db.update(factoriesTable).set({ clientEmail: text.trim() }).where(eq(factoriesTable.id, data.factoryId));
    clearState(tid);
    return ctx.reply(
      tb(al, "✅ Email клієнта для *{name}* збережено:\n{email}\n\nПісля затвердження графіку лист надсилатиметься автоматично.", { name: data.factoryName, email: text.trim() }),
      { parse_mode: "Markdown", ...managementMenu(al) },
    );
  }

  // ── Add admin ─────────────────────────────────────────────────────
  if (state?.action === "add_admin") {
    const al = olang(await getAdmin(tid));
    const newTid = text.trim();
    if (!/^\d+$/.test(newTid)) return ctx.reply(tb(al, "❌ Telegram ID має містити тільки цифри. Введіть ще раз:"));
    const existing = await db.select().from(adminsTable).where(eq(adminsTable.telegramId, newTid));
    if (existing.length > 0) {
      clearState(tid);
      return ctx.reply(tb(al, "⚠️ Цей Telegram ID вже є адміном (*{name}*).", { name: existing[0]!.name }), { parse_mode: "Markdown", ...managementMenu(al) });
    }
    // Try to get name from workers/drivers table
    const worker = await db.select({ name: workersTable.fullName }).from(workersTable).where(eq(workersTable.telegramId, newTid));
    const driver = await db.select({ name: driversTable.name }).from(driversTable).where(eq(driversTable.telegramId, newTid));
    const name = worker[0]?.name ?? driver[0]?.name ?? "Admin";
    await db.insert(adminsTable).values({ telegramId: newTid, name });
    clearState(tid);
    try { await bot.telegram.sendMessage(newTid, `✅ Вас додано як адміністратора бота.`, { parse_mode: "Markdown" }); }
    catch { /* ignore */ }
    return ctx.reply(tb(al, "✅ *{name}* (`{id}`) додано як адміна.", { name, id: newTid }), { parse_mode: "Markdown", ...managementMenu(al) });
  }

  // ── Worker self-signup via factory link ───────────────────────────
  if (state?.action === "worker_signup") {
    const { data } = state;
    const fullName = text.trim().replace(/\s+/g, " ");
    if (fullName.length < 3 || !/[a-zа-яёіїєґ]/i.test(fullName)) {
      return ctx.reply("❌ Введіть коректне ім'я та прізвище (наприклад: Іван Коваль):");
    }
    // double-check this Telegram isn't already linked to a worker
    const existing = (await db.select().from(workersTable).where(eq(workersTable.telegramId, tid)))[0];
    if (existing) {
      clearState(tid);
      return ctx.reply(`✅ Ви вже зареєстровані як *${mdSafe(existing.fullName)}*.`, { parse_mode: "Markdown", ...(await workerMenuFor(existing, wlang(existing))) });
    }
    const code = await genWorkerCode();
    await db.insert(workersTable).values({
      fullName, factoryId: data.factoryId, telegramId: tid, workerCode: code,
    });
    clearState(tid);
    // best-effort: let the owner + scheduler know someone self-registered (to verify/edit)
    try {
      const staff = await db.select().from(adminsTable);
      for (const a of staff) {
        if (!a.telegramId) continue;
        if (a.role !== "owner" && a.role !== "scheduler") continue;
        await bot.telegram.sendMessage(
          a.telegramId,
          `🆕 Новий працівник зареєструвався сам:\n👤 <b>${escapeHtml(fullName)}</b>\n🏭 ${escapeHtml(data.factoryName ?? "")}\n\nПеревірте/відредагуйте в панелі (Працівники).`,
          { parse_mode: "HTML" },
        );
      }
    } catch { /* notification is best-effort */ }
    return ctx.reply(
      `✅ Дякуємо, *${mdSafe(fullName)}*!\nВас додано до фабрики *${mdSafe(data.factoryName)}*.\n\nТепер ви можете заповнювати доступність через меню.`,
      { parse_mode: "Markdown", ...(await workerMenuFor({ factoryId: data.factoryId }, "uk")) },
    );
  }

  // ── Referral candidate signup: name ───────────────────────────────
  if (state?.action === "candidate_signup:name") {
    const fullName = text.trim().replace(/\s+/g, " ");
    if (fullName.length < 3 || !/[a-zа-яёіїєґ]/i.test(fullName)) {
      return ctx.reply("❌ Введіть коректне ім'я та прізвище (наприклад: Іван Коваль):");
    }
    setState(tid, "candidate_signup:phone", { ...state.data, fullName });
    return ctx.reply("📞 Введіть ваш *номер телефону* (або надішліть /skip):", { parse_mode: "Markdown" });
  }

  // ── Referral candidate signup: phone → create candidate ───────────
  if (state?.action === "candidate_signup:phone") {
    const { data } = state;
    const phone = text.trim() === "/skip" ? null : text.trim();
    // guard against duplicate candidate (same Telegram)
    const dup = (await db.select().from(candidatesTable).where(eq(candidatesTable.telegramId, tid)))[0];
    if (dup) { clearState(tid); return ctx.reply("✅ Ви вже у списку кандидатів. Дякуємо!"); }
    const [cand] = await db.insert(candidatesTable).values({
      referrerWorkerId: data.referrerId, fullName: data.fullName, telegramId: tid,
      phone, factoryId: data.factoryId ?? null, stage: "new",
    }).returning();
    clearState(tid);
    // notify the referrer
    try {
      const ref = (await db.select().from(workersTable).where(eq(workersTable.id, data.referrerId)))[0];
      if (ref?.telegramId) {
        await bot.telegram.sendMessage(ref.telegramId, `🎉 За вашим запрошенням зареєструвався(лась) *${mdSafe(data.fullName)}*!\n\nКоли він(вона) вийде на роботу — ви отримаєте бонус. Статус дивіться у «🎁 Запроси друга».`, { parse_mode: "Markdown" });
      }
    } catch { /* best-effort */ }
    // notify owner + scheduler
    try {
      const staff = await db.select().from(adminsTable);
      for (const a of staff) {
        if (!a.telegramId || (a.role !== "owner" && a.role !== "scheduler")) continue;
        await bot.telegram.sendMessage(a.telegramId, `🆕 Новий кандидат (реферал):\n👤 <b>${escapeHtml(data.fullName)}</b>${phone ? `\n📞 ${escapeHtml(phone)}` : ""}\n🙋 Запросив: ${escapeHtml(data.referrerName ?? "—")}\n\nОпрацюйте в панелі → «Реферали».`, { parse_mode: "HTML" });
      }
    } catch { /* best-effort */ }
    return ctx.reply(
      `✅ Дякуємо, *${mdSafe(data.fullName)}*! Вашу заявку прийнято.\nМенеджер зв'яжеться з вами найближчим часом. 📞`,
      { parse_mode: "Markdown" },
    );
  }

  // ── Hours review: enter corrected hours for a shift ───────────────
  if (state?.action === "hrv_hours") {
    const { review, index } = state.data;
    const lang = asLang(review?.lang);
    const n = Number(text.trim().replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 24) return ctx.reply(t(lang, "hr.badHours"));
    const s = review.shifts[index];
    if (s) { s.proposedHours = Math.round(n * 100) / 100; s.mark = "wrong"; }
    return sendHoursReview(ctx, review);
  }

  // ── Hours review: add a missing shift — parse the date ────────────
  if (state?.action === "hrv_add:date") {
    const review = state.data.review;
    const lang = asLang(review?.lang);
    if (text.trim() === "/skip") return sendHoursReview(ctx, review);
    const m = /^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/.exec(text.trim());
    if (!m) return ctx.reply(t(lang, "hr.badDate"), { parse_mode: "Markdown" });
    const dd = Number(m[1]), mm = Number(m[2]);
    let yy = m[3] ? Number(m[3]) : new Date().getFullYear();
    if (yy < 100) yy += 2000;
    const dt = new Date(yy, mm - 1, dd);
    if (dt.getDate() !== dd || dt.getMonth() !== mm - 1) return ctx.reply(t(lang, "hr.badDate2"));
    const date = ymdLocal(dt), dateLabel = fmtShortD(dt);
    const worker = await getWorker(tid);
    const fac = worker?.factoryId ? (await db.select().from(factoriesTable).where(eq(factoriesTable.id, worker.factoryId)))[0] : undefined;
    const count = Math.min(6, Math.max(1, fac?.shiftCount ?? 3));
    setState(tid, "hrv_add:shift", { review, date, dateLabel, factoryId: fac?.id ?? null, factoryName: fac?.name ?? "(?)" });
    const shiftBtns = Array.from({ length: count }, (_, i) => Markup.button.callback(t(lang, "hr.shiftN", { n: i + 1 }), `hrva:s:${i + 1}`));
    const rows: any[] = []; for (let i = 0; i < shiftBtns.length; i += 3) rows.push(shiftBtns.slice(i, i + 3));
    rows.push([Markup.button.callback(t(lang, "hr.cancel"), "hrva:x")]);
    return ctx.reply(t(lang, "hr.pickShift", { date: dateLabel, factory: fac?.name ?? "(?)" }), Markup.inlineKeyboard(rows));
  }

  // ── Web login: set username ───────────────────────────────────────
  if (state?.action === "web_login:username") {
    const al = olang(await getAdmin(tid));
    const username = text.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
      return ctx.reply(tb(al, "❌ Логін: 3–32 символи, лише латиниця/цифри/_.- — введіть ще раз:"));
    }
    const taken = await db.select().from(adminsTable).where(and(eq(adminsTable.username, username), ne(adminsTable.telegramId, tid)));
    if (taken.length > 0) return ctx.reply(tb(al, "❌ Такий логін уже зайнятий. Введіть інший:"));
    setState(tid, "web_login:password", { username });
    return ctx.reply(tb(al, "Тепер введіть *пароль* (мінімум 8 символів):"), { parse_mode: "Markdown" });
  }

  // ── Web login: set password ───────────────────────────────────────
  if (state?.action === "web_login:password") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    if (text.length < 8) return ctx.reply(tb(al, "❌ Пароль закороткий (мінімум 8 символів). Введіть ще раз:"));
    const { hashPassword } = await import("../lib/auth");
    await db.update(adminsTable)
      .set({ username: data.username, passwordHash: hashPassword(text) })
      .where(eq(adminsTable.telegramId, tid));
    clearState(tid);
    try { await ctx.deleteMessage(); } catch { /* can't delete password msg in some chats */ }
    const url = process.env.WEB_PUBLIC_URL || tb(al, "(адреса панелі)");
    return ctx.reply(
      tb(al, "✅ Веб-доступ налаштовано!\n\n👤 Логін: <code>{user}</code>\n🔗 Панель: {url}\n\n(пароль збережено, повідомлення з ним видалено)", { user: escapeHtml(data.username), url: escapeHtml(url) }),
      { parse_mode: "HTML", ...managementMenu(al) },
    );
  }

  // ── Remove admin ──────────────────────────────────────────────────
  if (state?.action === "remove_admin:select") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    const admins: { id: number; name: string; tid: string }[] = data.admins;
    const match = admins.find(a => text.includes(a.name));
    if (!match) return ctx.reply(tb(al, "Оберіть зі списку."));
    clearState(tid);
    await db.delete(adminsTable).where(eq(adminsTable.id, match.id));
    try { await bot.telegram.sendMessage(match.tid, `ℹ️ Вас видалено зі списку адміністраторів бота.`); }
    catch { /* ignore */ }
    return ctx.reply(tb(al, "✅ *{name}* видалений(-а) з адмінів.", { name: match.name }), { parse_mode: "Markdown", ...managementMenu(al) });
  }

  // ── Workers list filter ───────────────────────────────────────────
  if (state?.action === "workers_list:select_filter") {
    clearState(tid);
    const al = olang(await getAdmin(tid));
    const isAll = bhears("👥 Усі працівники").includes(text);
    const factoryNameMatch = text.startsWith("🏭 ") ? text.slice(3) : null;

    let factoryId: number | null = null;
    let filterLabel = tb(al, "Усі");

    if (factoryNameMatch) {
      const f = await db.select().from(factoriesTable).where(eq(factoriesTable.name, factoryNameMatch));
      if (!f[0]) return ctx.reply(tb(al, "Фабрику не знайдено."), managementMenu(al));
      factoryId = f[0].id;
      filterLabel = factoryNameMatch;
    } else if (!isAll) {
      return ctx.reply(tb(al, "Оберіть зі списку."), managementMenu(al));
    }

    const workers = await db
      .select({
        fullName: workersTable.fullName,
        workerCode: workersTable.workerCode,
        telegramId: workersTable.telegramId,
        factoryName: factoriesTable.name,
      })
      .from(workersTable)
      .leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
      .where(
        factoryId
          ? and(eq(workersTable.isActive, true), eq(workersTable.factoryId, factoryId))
          : eq(workersTable.isActive, true),
      )
      .orderBy(workersTable.fullName);

    if (workers.length === 0) {
      return ctx.reply(tb(al, "Немає активних працівників ({label}).", { label: filterLabel }), managementMenu(al));
    }

    const list = workers.map((w, i) =>
      `${i + 1}. *${w.fullName}* \`${w.workerCode ?? "—"}\`${w.factoryName ? ` 🏭 ${w.factoryName}` : ""}${w.telegramId ? " ✅" : " ⚠️"}`
    ).join("\n");

    await sendLongMessage(
      ctx.chat.id,
      tb(al, "👷 *Працівники — {label} ({n})*:\n\n{list}\n\n✅ = Telegram прив'язаний  ⚠️ = не прив'язаний", { label: filterLabel, n: workers.length, list }),
      { parse_mode: "Markdown" },
    );
    return ctx.reply(tb(al, "Управління:"), managementMenu(al));
  }

  // ── Add worker (multi-step: name → factory → telegramId → code) ──
  if (state?.action === "add_worker") {
    const { data } = state;
    const al = olang(await getAdmin(tid));

    // Step 1: name
    if (!data.name) {
      data.name = text;
      setState(tid, "add_worker", data);
      return promptAddWorkerStep(ctx, data, al);
    }

    // Step 2: factory
    if (!("factoryId" in data)) {
      const factories = await db.select().from(factoriesTable);
      const skipFactory = bhears("/skip — без фабрики").includes(text) || text === "/skip";
      const matchFactory = factories.find(f => f.name === text);
      if (!skipFactory && !matchFactory && factories.length > 0) {
        return ctx.reply(tb(al, "Оберіть фабрику зі списку або /skip:"));
      }
      data.factoryId = matchFactory?.id ?? null;
      setState(tid, "add_worker", data);
      return promptAddWorkerStep(ctx, data, al);
    }

    // Step 3: telegramId
    if (!("telegramId" in data)) {
      data.telegramId = text === "/skip" ? null : text.trim();
      setState(tid, "add_worker", data);
      return promptAddWorkerStep(ctx, data, al);
    }

    // Step 4: code
    const isSkip = text === "/skip";
    let workerCode: string;
    if (isSkip) {
      const allCodes = await db.select({ code: workersTable.workerCode }).from(workersTable);
      const maxCode = allCodes.map(r => parseInt(r.code ?? "0", 10)).filter(n => !isNaN(n)).reduce((a, b) => Math.max(a, b), 0);
      workerCode = String(maxCode + 1).padStart(5, "0");
    } else {
      if (!/^\d+$/.test(text.trim())) {
        return ctx.reply(tb(al, "❌ Код має містити тільки цифри. Введіть ще раз або /skip:"));
      }
      const existing = await db.select().from(workersTable).where(eq(workersTable.workerCode, text.trim()));
      if (existing.length > 0) {
        return ctx.reply(tb(al, "❌ Код `{code}` вже зайнятий. Введіть інший або /skip:", { code: text.trim() }), { parse_mode: "Markdown" });
      }
      workerCode = text.trim();
    }

    await db.insert(workersTable).values({
      fullName: data.name,
      factoryId: data.factoryId ?? undefined,
      telegramId: data.telegramId ?? undefined,
      workerCode,
    });
    clearState(tid);
    const factoryInfo = data.factoryId
      ? (await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, data.factoryId)))[0]?.name ?? ""
      : "—";
    const inviteLink = `https://t.me/${ctx.botInfo.username}?start=${workerCode}`;
    await ctx.reply(
      tb(al, "✅ Працівник <b>{name}</b> доданий!\n🔑 Код: <code>{code}</code>\n🏭 Фабрика: {factory}", { name: escapeHtml(data.name), code: workerCode, factory: escapeHtml(factoryInfo) }) + `${data.telegramId ? `\n🔗 Telegram: <code>${escapeHtml(data.telegramId)}</code>` : ""}\n\n${tb(al, "📎 Посилання (натисніть щоб скопіювати):")}\n<code>${escapeHtml(inviteLink)}</code>`,
      { parse_mode: "HTML" },
    );
    return ctx.reply(tb(al, "Управління:"), managementMenu(al));
  }

  // ── Add driver ────────────────────────────────────────────────────
  if (state?.action === "add_driver") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    if (!data.name) {
      data.name = text; setState(tid, "add_driver", data);
      return ctx.reply(tb(al, "Введіть номер авто (або /skip):"), Markup.removeKeyboard());
    }
    const vehicle = text === "/skip" ? undefined : text;
    const inviteCode = await genDriverCode();
    await db.insert(driversTable).values({ name: data.name, vehicle, inviteCode });
    clearState(tid);
    const inviteLink = `https://t.me/${ctx.botInfo.username}?start=drv${inviteCode}`;
    await ctx.reply(
      tb(al, "✅ Водій <b>{name}</b> доданий!", { name: escapeHtml(data.name) }) + `${vehicle ? `\n🚗 ${tb(al, "Авто:")} ${escapeHtml(vehicle)}` : ""}\n\n${tb(al, "📎 Посилання-запрошення (натисніть щоб скопіювати):")}\n<code>${escapeHtml(inviteLink)}</code>\n\n${tb(al, "Надішліть його водію — він натисне і автоматично підключиться до бота.")}`,
      { parse_mode: "HTML" },
    );
    return ctx.reply(tb(al, "Управління водіями:"), managementMenu(al));
  }

  // ── Invite driver: show invite link ───────────────────────────────
  if (state?.action === "invite_driver:select") {
    const al = olang(await getAdmin(tid));
    const name = text.replace(/ [✅⚠️]$/, "").trim();
    const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
    const d = drivers.find(x => x.name === name) ?? drivers.find(x => x.name.toLowerCase().includes(name.toLowerCase()));
    if (!d) return ctx.reply(tb(al, "Оберіть водія зі списку."));
    // Ensure the driver has an invite code (older rows may not)
    let inviteCode = d.inviteCode;
    if (!inviteCode) {
      inviteCode = await genDriverCode();
      await db.update(driversTable).set({ inviteCode }).where(eq(driversTable.id, d.id));
    }
    clearState(tid);
    const inviteLink = `https://t.me/${ctx.botInfo.username}?start=drv${inviteCode}`;
    await ctx.reply(
      `🚗 <b>${escapeHtml(d.name)}</b>${d.telegramId ? `\n${tb(al, "✅ вже підключений до бота")}` : `\n${tb(al, "⚠️ ще не підключений")}`}\n\n${tb(al, "📎 Посилання-запрошення (натисніть щоб скопіювати):")}\n<code>${escapeHtml(inviteLink)}</code>`,
      { parse_mode: "HTML" },
    );
    return ctx.reply(tb(al, "Управління водіями:"), managementMenu(al));
  }

  // ── Add factory ───────────────────────────────────────────────────
  if (state?.action === "add_factory") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    if (!data.name) {
      data.name = text; setState(tid, "add_factory", data);
      return ctx.reply(tb(al, "Введіть адресу (або /skip):"), Markup.removeKeyboard());
    }
    const address = text === "/skip" ? undefined : text;
    await db.insert(factoriesTable).values({ name: data.name, address });
    clearState(tid);
    return ctx.reply(tb(al, "✅ Фабрика *{name}* додана!", { name: data.name }), { parse_mode: "Markdown", ...managementMenu(al) });
  }

  // ── Link telegram ─────────────────────────────────────────────────
  if (state?.action === "link:enter_name") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    data.searchName = text;
    setState(tid, "link:enter_id", data);
    return ctx.reply(tb(al, "Попросіть {who} надіслати /getid боту.\nПотім вставте їх Telegram ID сюди:", { who: data.type === "worker" ? tb(al, "працівника") : tb(al, "водія") }));
  }

  if (state?.action === "link:enter_id") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    const newTid = text.trim();
    if (data.type === "worker") {
      const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
      const match = workers.find(w => w.fullName.toLowerCase().includes(data.searchName.toLowerCase()));
      if (!match) { clearState(tid); return ctx.reply(tb(al, "Працівника не знайдено."), managementMenu(al)); }
      if (await tgTakenByWorker(newTid, match.id)) {
        clearState(tid);
        return ctx.reply(tb(al, "❌ Цей Telegram ID уже прив'язаний до іншого працівника."), managementMenu(al));
      }
      await db.update(workersTable).set({ telegramId: newTid }).where(eq(workersTable.id, match.id));
      clearState(tid);
      return ctx.reply(tb(al, "✅ *{name}* прив'язаний до Telegram `{id}`", { name: mdSafe(match.fullName), id: newTid }), { parse_mode: "Markdown", ...managementMenu(al) });
    } else {
      const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
      const match = drivers.find(d => d.name.toLowerCase().includes(data.searchName.toLowerCase()));
      if (!match) { clearState(tid); return ctx.reply(tb(al, "Водія не знайдено."), managementMenu(al)); }
      if (await tgTakenByDriver(newTid, match.id)) {
        clearState(tid);
        return ctx.reply(tb(al, "❌ Цей Telegram ID уже прив'язаний до іншого водія."), managementMenu(al));
      }
      await db.update(driversTable).set({ telegramId: newTid }).where(eq(driversTable.id, match.id));
      clearState(tid);
      return ctx.reply(tb(al, "✅ *{name}* прив'язаний до Telegram `{id}`", { name: mdSafe(match.name), id: newTid }), { parse_mode: "Markdown", ...managementMenu(al) });
    }
  }

  // ── Set head driver ───────────────────────────────────────────────
  if (state?.action === "set_head_driver") {
    const al = olang(await getAdmin(tid));
    const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
    const match = drivers.find(d => text.includes(d.name));
    if (!match) return ctx.reply(tb(al, "Водія не знайдено. Оберіть зі списку."));
    await db.update(driversTable).set({ isHeadDriver: false });
    await db.update(driversTable).set({ isHeadDriver: true }).where(eq(driversTable.id, match.id));
    clearState(tid);
    return ctx.reply(tb(al, "✅ *{name}* призначений головним водієм!", { name: match.name }), { parse_mode: "Markdown", ...managementMenu(al) });
  }

  // ── Factory order flow ────────────────────────────────────────────
  if (state?.action === "order:select_factory") {
    const al = olang(await getAdmin(tid));
    const factories = await db.select().from(factoriesTable);
    const match = factories.find(f => f.name === text);
    if (!match) return ctx.reply(tb(al, "Оберіть фабрику зі списку."));
    const next = getNextMonday(); const curr = getCurrentMonday();
    setState(tid, "order:select_week", { factoryId: match.id, factoryName: match.name, curr, next });
    return ctx.reply(tb(al, "Фабрика: *{name}*\nОберіть тиждень:", { name: match.name }), {
      parse_mode: "Markdown",
      ...Markup.keyboard([
        [`📅 ${tb(al, "Поточний тиждень")} (${formatWeekStart(curr)}) — ${curr}`],
        [`📅 ${tb(al, "Наступний тиждень")} (${formatWeekStart(next)}) — ${next}`],
        [tb(al, "⬅️ Назад")],
      ]).resize(),
    });
  }

  if (state?.action === "order:select_week") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return ctx.reply(tb(al, "Оберіть тиждень зі списку."));
    const weekStart = dateMatch[1]!;
    const orders = await loadOrderMap(data.factoryId, weekStart);
    setState(tid, "order:board", { factoryId: data.factoryId, factoryName: data.factoryName, weekStart, orders });
    await ctx.reply(tb(al, "Завантажую дошку замовлення..."), Markup.removeKeyboard());
    return renderOrderBoard(ctx, { factoryId: data.factoryId, factoryName: data.factoryName, weekStart, orders });
  }

  // ── Order board: edit one day (typed "8 12 5") ────────────────────
  if (state?.action === "order:await_day") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    const parts = text.trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some(isNaN) || parts.some(n => n < 0)) {
      return ctx.reply(tb(al, "Введіть 3 числа через пробіл (1зм 2зм 3зм), напр. `8 12 5`"), { parse_mode: "Markdown" });
    }
    data.orders[data.editDay] = parts;
    await saveOrderDay(data.factoryId, data.weekStart, data.editDay, parts as [number, number, number]);
    setState(tid, "order:board", data);
    return renderOrderBoard(ctx, data);
  }

  // ── Order board: apply same to all days ───────────────────────────
  if (state?.action === "order:await_all") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    const parts = text.trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some(isNaN) || parts.some(n => n < 0)) {
      return ctx.reply(tb(al, "Введіть 3 числа через пробіл, напр. `8 12 5`"), { parse_mode: "Markdown" });
    }
    for (const day of DAYS) {
      data.orders[day] = [...parts];
      await saveOrderDay(data.factoryId, data.weekStart, day, parts as [number, number, number]);
    }
    setState(tid, "order:board", data);
    return renderOrderBoard(ctx, data);
  }

  // ── Sheets: select week ───────────────────────────────────────────
  if (state?.action === "sheets:select_week") {
    const al = olang(await getAdmin(tid));
    const match = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) return ctx.reply(tb(al, "Оберіть тиждень зі списку."));
    const weekStart = match[1]!;
    clearState(tid);
    await ctx.reply(tb(al, "⏳ Синхронізую тиждень {week}...", { week: weekStart }));
    try {
      const { synced, autoAdded } = await syncAvailabilityToDb(weekStart);
      const missing = await getWorkersWhoHaventSubmitted(weekStart);
      let msg = tb(al, "✅ Синхронізовано! *{n}* записів для тижня {week}", { n: synced, week: formatWeekStart(weekStart) }) + "\n\n";
      if (autoAdded.length > 0) msg += `👤 *${tb(al, "Автоматично додано ({n}):", { n: autoAdded.length })}*\n${autoAdded.map(n => `• ${n}`).join("\n")}\n\n`;
      if (missing.length > 0) msg += `📭 *${tb(al, "Не заповнили ({n}):", { n: missing.length })}*\n${missing.map(w => `• ${w.fullName}${w.telegramId ? "" : " ⚠️"}`).join("\n")}`;
      else msg += tb(al, "🎉 Всі заповнили анкету!");
      await sendLongMessage(ctx.chat!.id, msg, { parse_mode: "Markdown" });
      return ctx.reply(tb(al, "Що далі?"), adminMenu(al));
    } catch (e) {
      logger.error({ err: e }, "Sync error");
      return ctx.reply(tb(al, "❌ Помилка синхронізації."), adminMenu(al));
    }
  }

  // ── Generate: select factory ──────────────────────────────────────
  if (state?.action === "gen:select_factory") {
    const al = olang(await getAdmin(tid));
    const factories = await db.select().from(factoriesTable);
    const match = factories.find(f => f.name === text);
    if (!match) return ctx.reply(tb(al, "Оберіть фабрику зі списку."));
    const next = getNextMonday(); const curr = getCurrentMonday();
    setState(tid, "gen:select_week", { curr, next, factoryId: match.id, factoryName: match.name });
    return ctx.reply(tb(al, "Фабрика: *{name}*\nДля якого тижня?", { name: match.name }), {
      parse_mode: "Markdown",
      ...Markup.keyboard([
        [`📅 ${tb(al, "Поточний")} (${formatWeekStart(curr)}) — ${curr}`],
        [`📅 ${tb(al, "Наступний")} (${formatWeekStart(next)}) — ${next}`],
        [tb(al, "⬅️ Назад")],
      ]).resize(),
    });
  }

  // ── Generate schedule: select week → show pre-flight summary ──────
  if (state?.action === "gen:select_week") {
    const al = olang(await getAdmin(tid));
    const { factoryId, factoryName } = state.data as { factoryId: number | null; factoryName?: string };
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return ctx.reply(tb(al, "Оберіть тиждень зі списку."));
    const weekStart = dateMatch[1]!;
    const stats = await weekFactoryStats(factoryId ?? undefined, weekStart);
    const label = factoryName ? ` — ${factoryName}` : "";
    let msg = `🔎 *${tb(al, "Перевірка перед генерацією")}*\n*${tb(al, "Тиждень:")}* ${formatWeekStart(weekStart)}${label}\n\n`;
    msg += `📋 ${tb(al, "Замовлено змін:")} *${stats.ordersTotal}* (${tb(al, "днів із замовленням:")} ${stats.daysWithOrders})\n`;
    msg += `👥 ${tb(al, "Заповнили доступність:")} *${stats.availWorkers}* ${tb(al, "осіб")} (${stats.availSlots} ${tb(al, "слотів")})\n\n`;
    if (stats.ordersTotal === 0) {
      msg += tb(al, "⚠️ Немає замовлень — спочатку заповніть \"📋 Замовлення фабрик\".");
      clearState(tid);
      return ctx.reply(msg, { parse_mode: "Markdown", ...adminMenu(al) });
    }
    if (stats.availWorkers === 0) {
      msg += tb(al, "⚠️ Ніхто не заповнив доступність — графік буде порожній.\nВсе одно генерувати?");
    } else if (stats.availSlots < stats.ordersTotal) {
      msg += tb(al, "⚠️ Доступних слотів ({a}) менше за замовлені ({b}) — буде нестача.\nГенерувати?", { a: stats.availSlots, b: stats.ordersTotal });
    } else {
      msg += tb(al, "✅ Людей достатньо. Генерувати?");
    }
    setState(tid, "gen:confirm", { factoryId, factoryName, weekStart });
    return ctx.reply(msg, { parse_mode: "Markdown", ...Markup.keyboard([[tb(al, "✅ Генерувати")], [tb(al, "⬅️ Назад")]]).resize() });
  }

  // ── Generate schedule: confirm ────────────────────────────────────
  if (state?.action === "gen:confirm") {
    const al = olang(await getAdmin(tid));
    const { factoryId, factoryName, weekStart } = state.data as { factoryId: number | null; factoryName?: string; weekStart: string };
    if (!bhears("✅ Генерувати").includes(text)) { clearState(tid); return ctx.reply(tb(al, "Скасовано."), adminMenu(al)); }
    clearState(tid);
    const label = factoryName ? ` (${factoryName})` : "";
    await ctx.reply(tb(al, "⏳ Генерую графік для тижня {week}{label}...", { week: formatWeekStart(weekStart), label }));
    try {
      const result = await generateSchedule(weekStart, factoryId ?? undefined);
      let msg = `📅 *${tb(al, "Чернетка готова!")}*\n*${tb(al, "Тиждень:")}* ${formatWeekStart(weekStart)}${label}\n*${tb(al, "Призначено:")}* ${result.totalAssigned} ${tb(al, "змін")}\n\n`;
      if (result.shortages.length > 0) {
        msg += `⚠️ *${tb(al, "Нестача людей:")}*\n`;
        for (const s of result.shortages) {
          msg += `• ${s.factoryName} ${DAY_UK[s.day]} ${SHIFT_SHORT[s.shift]}: ${tb(al, "потрібно")} ${s.needed}, ${tb(al, "є")} ${s.available} (${tb(al, "бракує")} ${s.shortage})\n`;
        }
        msg += "\n";
      } else { msg += tb(al, "✅ Всі замовлення виконані!") + "\n\n"; }
      msg += tb(al, "Перегляньте через \"✅ Перегляд графіків\"");
      await sendLongMessage(ctx.chat!.id, msg, { parse_mode: "Markdown" });
      return ctx.reply(tb(al, "Що далі?"), adminMenu(al));
    } catch (e) {
      logger.error({ err: e }, "Schedule generation error");
      return ctx.reply(tb(al, "❌ Помилка генерації. Переконайтесь що є замовлення і синхронізована доступність."), adminMenu(al));
    }
  }

  // ── View: pick factory ────────────────────────────────────────────
  if (state?.action === "view:select_factory") {
    const al = olang(await getAdmin(tid));
    const fac = (await db.select().from(factoriesTable).where(eq(factoriesTable.name, text)))[0];
    if (!fac) return ctx.reply(tb(al, "Оберіть фабрику зі списку."));
    // Weeks that have orders or schedule entries for this factory
    const orderWeeks = await db.selectDistinct({ w: factoryOrdersTable.weekStart }).from(factoryOrdersTable).where(eq(factoryOrdersTable.factoryId, fac.id));
    const entryWeeks = await db.selectDistinct({ w: scheduleWeeksTable.weekStart })
      .from(scheduleEntriesTable)
      .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
      .where(eq(scheduleEntriesTable.factoryId, fac.id));
    const weekSet = [...new Set([...orderWeeks.map(r => r.w), ...entryWeeks.map(r => r.w).filter(Boolean)])].sort().reverse();
    if (weekSet.length === 0) return ctx.reply(tb(al, "Для *{name}* немає графіків чи замовлень.", { name: fac.name }), { parse_mode: "Markdown", ...adminMenu(al) });
    // Map week → status
    const allWeeks = await db.select().from(scheduleWeeksTable);
    const statusOf = (w: string) => allWeeks.find(x => x.weekStart === w)?.status;
    setState(tid, "view:select_week", { factoryId: fac.id, factoryName: fac.name });
    const btns = weekSet.map(w => {
      const st = statusOf(w as string);
      const icon = st === "approved" ? "✅" : st === "draft" ? "📋" : "🆕";
      const label = st === "approved" ? tb(al, "Затверджено") : st === "draft" ? tb(al, "Чернетка") : tb(al, "Лише замовлення");
      return [`${icon} ${w} — ${label}`];
    });
    return ctx.reply(`🏭 *${fac.name}*\n${tb(al, "Оберіть тиждень:")}`, { parse_mode: "Markdown", ...Markup.keyboard([...btns, [tb(al, "⬅️ Назад")]]).resize() });
  }

  // ── View: pick week → show this factory's schedule ────────────────
  if (state?.action === "view:select_week") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    const match = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) return ctx.reply(tb(al, "Оберіть тиждень зі списку."));
    const weekStart = match[1]!;
    const week = (await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)))[0];
    if (!week) {
      return ctx.reply(tb(al, "Для тижня {week} ще немає згенерованого графіку.\nЗгенеруйте через \"🗓 Генерувати графік\".", { week: formatWeekStart(weekStart) }), adminMenu(al));
    }
    setState(tid, "view:selected", { weekId: week.id, weekStart: week.weekStart, status: week.status, factoryId: data.factoryId, factoryName: data.factoryName });
    await showFactoryWeekSchedule(ctx, week.id, week.weekStart, data.factoryId, data.factoryName);
    if (week.status === "draft") {
      await showReserveSummary(ctx, week.id, week.weekStart, data.factoryId);
      return ctx.reply(tb(al, "Що робити з цим графіком?"), Markup.keyboard([
        [tb(al, "✏️ Редагувати графік")],
        [tb(al, "✅ Затвердити графік"), tb(al, "🔄 Перегенерувати")],
        [tb(al, "⬅️ Назад")],
      ]).resize());
    }
    return ctx.reply(tb(al, "Графік затверджений. Можна редагувати:"), Markup.keyboard([
      [tb(al, "✏️ Редагувати графік")],
      [tb(al, "⬅️ Назад")],
    ]).resize());
  }

  if (state?.action === "view:selected") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    if (bhears("✏️ Редагувати графік").includes(text)) {
      // Factory already known — go straight to day selection
      setState(tid, "sched_edit:day", { weekId: data.weekId, weekStart: data.weekStart, factoryId: data.factoryId, factoryName: data.factoryName });
      return ctx.reply(`🏭 *${data.factoryName}*\n${tb(al, "Оберіть день:")}`, { parse_mode: "Markdown", ...Markup.keyboard([...DAYS.map(d => [DAY_NAMES_UK[d]]), [tb(al, "⬅️ Назад")]]).resize() });
    }
    if (bhears("✅ Затвердити графік").includes(text)) {
      await db.update(scheduleWeeksTable).set({ status: "approved", approvedAt: new Date() }).where(eq(scheduleWeeksTable.id, data.weekId));
      clearState(tid);
      await ctx.reply(tb(al, "✅ Графік на {week} затверджено!\n\n⏳ Зберігаю на Google Drive...", { week: formatWeekStart(data.weekStart) }));
      try {
        const driveLink = await exportScheduleToDrive(data.weekId, data.weekStart);
        if (driveLink) await ctx.reply(`☁️ ${tb(al, "Збережено:")}\n${driveLink}`);
      } catch (e) { logger.error({ err: e }, "Drive export failed"); }

      // Email schedule to each factory's client that has entries this week
      try {
        const { sendScheduleEmail } = await import("../services/email");
        const factoriesInWeek = await db
          .selectDistinct({ factoryId: scheduleEntriesTable.factoryId, factoryName: factoriesTable.name, clientEmail: factoriesTable.clientEmail })
          .from(scheduleEntriesTable)
          .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
          .where(eq(scheduleEntriesTable.weekId, data.weekId));
        const withEmail = factoriesInWeek.filter(f => f.clientEmail);
        if (withEmail.length > 0) {
          const results: string[] = [];
          for (const f of withEmail) {
            const status = await sendScheduleEmail(f.factoryId, data.weekStart);
            results.push(`• ${f.factoryName}: ${status}`);
          }
          await ctx.reply(`📧 *${tb(al, "Розсилка клієнтам:")}*\n${results.join("\n")}`, { parse_mode: "Markdown" });
        }
      } catch (e) { logger.error({ err: e }, "Client email send failed"); }

      return ctx.reply(tb(al, "Тепер розішліть працівникам через \"📢 Розсилки → Розіслати затверджений графік\""), adminMenu(al));
    }
    if (bhears("🔄 Перегенерувати").includes(text)) {
      // Count existing entries that would be wiped, warn before destroying manual edits
      const existing = await db.select({ id: scheduleEntriesTable.id })
        .from(scheduleEntriesTable)
        .where(and(eq(scheduleEntriesTable.weekId, data.weekId), eq(scheduleEntriesTable.factoryId, data.factoryId)));
      setState(tid, "view:confirm_regen", data);
      return ctx.reply(
        tb(al, "⚠️ *Увага!*\nПерегенерація *{name}* видалить поточні {n} призначень (разом із будь-якими ручними правками) і збере графік заново з доступності.\n\nПродовжити?", { name: data.factoryName, n: existing.length }),
        { parse_mode: "Markdown", ...Markup.keyboard([[tb(al, "✅ Так, перегенерувати")], [tb(al, "⬅️ Назад")]]).resize() },
      );
    }
  }

  if (state?.action === "view:confirm_regen") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    if (bhears("✅ Так, перегенерувати").includes(text)) {
      clearState(tid);
      await ctx.reply(tb(al, "⏳ Перегенерую графік для *{name}*...", { name: data.factoryName }), { parse_mode: "Markdown" });
      const result = await generateSchedule(data.weekStart, data.factoryId);
      let msg = tb(al, "✅ Перегенеровано! Призначено: {n}", { n: result.totalAssigned });
      const facShort = result.shortages.filter(s => s.factoryName === data.factoryName);
      if (facShort.length > 0) {
        msg += `\n\n⚠️ ${tb(al, "Не вистачає людей:")}\n` + facShort.map(s => `• ${DAY_NAMES_UK[s.day]} ${SHIFT_SHORT[s.shift]} — ${tb(al, "бракує")} ${s.shortage}`).join("\n");
      }
      return ctx.reply(msg, adminMenu(al));
    }
    // any other input → cancel back to menu
    clearState(tid);
    return ctx.reply(tb(al, "Скасовано."), adminMenu(al));
  }

  // ── Schedule editor: pick factory ─────────────────────────────────
  if (state?.action === "sched_edit:factory") {
    const { data } = state;
    const fac = (await db.select().from(factoriesTable).where(eq(factoriesTable.name, text)))[0];
    if (!fac) return ctx.reply("Оберіть фабрику зі списку.");
    setState(tid, "sched_edit:day", { ...data, factoryId: fac.id, factoryName: fac.name });
    return ctx.reply("Оберіть день:", Markup.keyboard([...DAYS.map(d => [DAY_NAMES_UK[d]]), ["⬅️ Назад"]]).resize());
  }

  // ── Schedule editor: pick day ─────────────────────────────────────
  if (state?.action === "sched_edit:day") {
    const { data } = state;
    const day = DAYS.find(d => DAY_NAMES_UK[d] === text);
    if (!day) return ctx.reply("Оберіть день зі списку.");
    setState(tid, "sched_edit:shift", { ...data, day });
    return ctx.reply(`День: *${DAY_NAMES_UK[day]}*\nОберіть зміну:`, {
      parse_mode: "Markdown",
      ...Markup.keyboard([["1 зміна", "2 зміна", "3 зміна"], ["⬅️ Назад"]]).resize(),
    });
  }

  // ── Schedule editor: pick shift → show editor ─────────────────────
  if (state?.action === "sched_edit:shift") {
    const { data } = state;
    const shiftMap: Record<string, Shift> = { "1 зміна": "1", "2 зміна": "2", "3 зміна": "3" };
    const shift = shiftMap[text];
    if (!shift) return ctx.reply("Оберіть зміну зі списку.");
    setState(tid, "sched_edit:actions", { ...data, shift });
    return renderShiftEditor(ctx, { ...data, shift });
  }

  // ── Schedule editor: shift actions ────────────────────────────────
  if (state?.action === "sched_edit:actions") {
    const { data } = state;
    if (text === "⬅️ Назад до змін") {
      setState(tid, "sched_edit:shift", { weekId: data.weekId, weekStart: data.weekStart, factoryId: data.factoryId, factoryName: data.factoryName, day: data.day });
      return ctx.reply("Оберіть зміну:", Markup.keyboard([["1 зміна", "2 зміна", "3 зміна"], ["⬅️ Назад"]]).resize());
    }
    if (text === "📋 Уся база фабрики") {
      const assigned = await getAssignedWorkerIds(data.weekId, data.factoryId, data.day, data.shift);
      const base = await db.select().from(workersTable)
        .where(and(eq(workersTable.isActive, true), eq(workersTable.factoryId, data.factoryId)));
      const avail = base.filter(w => !assigned.includes(w.id));
      if (avail.length === 0) return ctx.reply("Усі працівники фабрики вже в цій зміні.");
      setState(tid, "sched_edit:from_base", data);
      return ctx.reply("Оберіть кого додати (вся база фабрики):", Markup.keyboard([...avail.map(w => [`${w.fullName}`]), ["⬅️ Назад до змін"]]).resize());
    }
    if (text === "✏️ Додати вручну") {
      setState(tid, "sched_edit:manual", data);
      return ctx.reply("Введіть ПІБ нового працівника (можна кілька, кожен з нового рядка):", Markup.removeKeyboard());
    }
    if (text === "🗑 Прибрати працівника") {
      const assigned = await getAssignedEntries(data.weekId, data.factoryId, data.day, data.shift);
      if (assigned.length === 0) return ctx.reply("У цій зміні нікого немає.");
      setState(tid, "sched_edit:remove", data);
      return ctx.reply("Кого прибрати?", Markup.keyboard([...assigned.map(a => [`${a.name}`]), ["⬅️ Назад до змін"]]).resize());
    }
    // Tap reserve person "➕ Name"
    if (text.startsWith("➕ ")) {
      const name = text.slice(2).trim();
      const worker = (await db.select().from(workersTable).where(and(eq(workersTable.isActive, true), eq(workersTable.fullName, name))))[0];
      if (!worker) return ctx.reply("Працівника не знайдено.");
      await db.insert(scheduleEntriesTable).values({
        weekId: data.weekId, workerId: worker.id, factoryId: data.factoryId,
        dayOfWeek: data.day, shift: data.shift, status: "scheduled",
      });
      return renderShiftEditor(ctx, data);
    }
    return;
  }

  // ── Schedule editor: add from full base ───────────────────────────
  if (state?.action === "sched_edit:from_base") {
    const { data } = state;
    if (text === "⬅️ Назад до змін") {
      setState(tid, "sched_edit:actions", data);
      return renderShiftEditor(ctx, data);
    }
    const worker = (await db.select().from(workersTable).where(and(eq(workersTable.isActive, true), eq(workersTable.fullName, text))))[0];
    if (!worker) return ctx.reply("Оберіть зі списку.");
    await db.insert(scheduleEntriesTable).values({
      weekId: data.weekId, workerId: worker.id, factoryId: data.factoryId,
      dayOfWeek: data.day, shift: data.shift, status: "scheduled",
    });
    setState(tid, "sched_edit:actions", data);
    return renderShiftEditor(ctx, data);
  }

  // ── Schedule editor: add manual new workers ───────────────────────
  if (state?.action === "sched_edit:manual") {
    const { data } = state;
    const names = text.split("\n").map(s => s.trim()).filter(s => s.length > 1);
    if (names.length === 0) return ctx.reply("Введіть хоча б одне ім'я.");
    const allCodes = await db.select({ code: workersTable.workerCode }).from(workersTable);
    let maxCode = allCodes.map(r => parseInt(r.code ?? "0", 10)).filter(n => !isNaN(n)).reduce((a, b) => Math.max(a, b), 0);
    for (const name of names) {
      maxCode++;
      const [w] = await db.insert(workersTable).values({
        fullName: name, factoryId: data.factoryId, workerCode: String(maxCode).padStart(5, "0"),
      }).returning();
      await db.insert(scheduleEntriesTable).values({
        weekId: data.weekId, workerId: w!.id, factoryId: data.factoryId,
        dayOfWeek: data.day, shift: data.shift, status: "scheduled",
      });
    }
    await ctx.reply(`✅ Додано ${names.length} нов. працівник(ів) і поставлено в зміну.`);
    setState(tid, "sched_edit:actions", data);
    return renderShiftEditor(ctx, data);
  }

  // ── Schedule editor: remove worker from shift ─────────────────────
  if (state?.action === "sched_edit:remove") {
    const { data } = state;
    if (text === "⬅️ Назад до змін") {
      setState(tid, "sched_edit:actions", data);
      return renderShiftEditor(ctx, data);
    }
    const assigned = await getAssignedEntries(data.weekId, data.factoryId, data.day, data.shift);
    const match = assigned.find(a => a.name === text);
    if (!match) return ctx.reply("Оберіть зі списку.");
    await db.delete(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, match.entryId));
    setState(tid, "sched_edit:actions", data);
    return renderShiftEditor(ctx, data);
  }

  // ── Send approved schedule ────────────────────────────────────────
  if (state?.action === "send_schedule:select_week") {
    const al = olang(await getAdmin(tid));
    const match = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) return;
    const weekStart = match[1]!;
    const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "approved")));
    if (weeks.length === 0) return ctx.reply(tb(al, "Графік не знайдено."));
    clearState(tid);
    await ctx.reply(tb(al, "⏳ Розсилаю..."));
    const { notified, skipped } = await sendScheduleToAllWorkers(weeks[0]!.id, weekStart);
    const headDriverResult = await sendScheduleToHeadDriver(weeks[0]!.id, weekStart);
    return ctx.reply(tb(al, "📢 Розіслано!\n👷 Працівники: {n} / пропущено: {s}\n🚐 Головний водій: {hd}", { n: notified, s: skipped, hd: headDriverResult }), adminMenu(al));
  }

  // ── Remind to fill sheet ──────────────────────────────────────────
  if (state?.action === "remind:select_week") {
    const al = olang(await getAdmin(tid));
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : getNextMonday();
    clearState(tid);
    await ctx.reply(tb(al, "⏳ Перевіряю хто не заповнив..."));
    const missing = await getWorkersWhoHaventSubmitted(weekStart);
    if (missing.length === 0) return ctx.reply(tb(al, "🎉 Всі заповнили!"), adminMenu(al));
    let notified = 0, skipped = 0;
    for (const w of missing) {
      if (!w.telegramId) { skipped++; continue; }
      try {
        await bot.telegram.sendMessage(w.telegramId, t(wlang(w), "notif.availReminder", { week: formatWeekStart(weekStart), btn: t(wlang(w), "menu.availability") }), { parse_mode: "Markdown" });
        notified++;
      } catch { skipped++; }
    }
    return ctx.reply(tb(al, "📨 Готово!\n✅ {n} повідомлень\n⚠️ {s} без Telegram", { n: notified, s: skipped }), adminMenu(al));
  }

  // ── Set reminder hour ─────────────────────────────────────────────
  if (state?.action === "set_reminder_hour") {
    const al = olang(await getAdmin(tid));
    const hour = parseInt(text.trim(), 10);
    if (isNaN(hour) || hour < 0 || hour > 23) return ctx.reply(tb(al, "Введіть число від 0 до 23:"));
    clearState(tid);
    const { setReminderHour } = await import("../services/scheduler");
    setReminderHour(hour);
    return ctx.reply(tb(al, "✅ Нагадування налаштовано на *{h}:00* щонеділі!", { h: hour }), { parse_mode: "Markdown", ...adminMenu(al) });
  }

  // ── Head driver flows ─────────────────────────────────────────────
  if (state?.action === "hd:select_week") {
    const dl = olang(await getDriver(tid));
    const match = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) return;
    const weekStart = match[1]!;
    const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "approved")));
    if (weeks.length === 0) return ctx.reply(tb(dl, "Графік не знайдено."));
    setState(tid, "hd:select_day", { weekId: weeks[0]!.id, weekStart });
    return ctx.reply(tb(dl, "Оберіть день:"), Markup.keyboard([...DAYS.map(d => [DAY_NAMES_UK[d]]), [tb(dl, "⬅️ Назад")]]).resize());
  }

  if (state?.action === "hd:select_day") {
    const { data } = state;
    const dl = olang(await getDriver(tid));
    const day = DAYS.find(d => DAY_NAMES_UK[d] === text);
    if (!day) return ctx.reply(tb(dl, "Оберіть день зі списку."));
    return showHdSlots(ctx, tid, { ...data, day }, dl);
  }

  // Pick a concrete factory+shift slot
  if (state?.action === "hd:select_slot") {
    const { data } = state;
    const dl = olang(await getDriver(tid));
    const slot = (data.slots as any[]).find(s => s.label === text);
    if (!slot) return ctx.reply(tb(dl, "Оберіть зміну зі списку."));
    const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
    const assigned = await db.select({ driverId: driverShiftAssignmentsTable.driverId })
      .from(driverShiftAssignmentsTable)
      .where(and(eq(driverShiftAssignmentsTable.weekId, data.weekId), eq(driverShiftAssignmentsTable.dayOfWeek, data.day), eq(driverShiftAssignmentsTable.shift, slot.shift), eq(driverShiftAssignmentsTable.factoryId, slot.factoryId)));
    const assignedIds = new Set(assigned.map(a => a.driverId));
    setState(tid, "hd:select_driver", { ...data, factoryId: slot.factoryId, factoryName: slot.factoryName, shift: slot.shift });
    return ctx.reply(
      `🏭 *${slot.factoryName}* · ${SHIFT_SHORT[slot.shift as Shift]}\n${tb(dl, "Оберіть водія (✅ = вже призначений):")}`,
      { parse_mode: "Markdown", ...Markup.keyboard([...drivers.map(d => [`${assignedIds.has(d.id) ? "✅ " : ""}${d.isHeadDriver ? "👑 " : ""}${d.name}`]), [tb(dl, "⬅️ Назад")]]).resize() },
    );
  }

  if (state?.action === "hd:select_driver") {
    const { data } = state;
    const dl = olang(await getDriver(tid));
    const cleaned = text.replace(/^✅ /, "").replace(/^👑 /, "").trim();
    const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
    const match = drivers.find(d => d.name === cleaned) ?? drivers.find(d => cleaned.includes(d.name));
    if (!match) return ctx.reply(tb(dl, "Водія не знайдено. Оберіть зі списку."));
    const already = await db.select({ id: driverShiftAssignmentsTable.id })
      .from(driverShiftAssignmentsTable)
      .where(and(eq(driverShiftAssignmentsTable.weekId, data.weekId), eq(driverShiftAssignmentsTable.dayOfWeek, data.day), eq(driverShiftAssignmentsTable.shift, data.shift), eq(driverShiftAssignmentsTable.factoryId, data.factoryId), eq(driverShiftAssignmentsTable.driverId, match.id)));
    if (already.length > 0) {
      // Toggle off — unassign
      await db.delete(driverShiftAssignmentsTable).where(eq(driverShiftAssignmentsTable.id, already[0]!.id));
      await ctx.reply(tb(dl, "➖ *{name}* знятий зі зміни.", { name: match.name }), { parse_mode: "Markdown" });
    } else {
      await db.insert(driverShiftAssignmentsTable).values({ weekId: data.weekId, factoryId: data.factoryId, dayOfWeek: data.day, shift: data.shift, driverId: match.id });
      if (match.telegramId) await notifyDriverOfAssignment(match.telegramId, data.weekId, data.day, data.shift, data.weekStart, data.factoryId);
      await ctx.reply(`✅ *${match.name}* → ${data.factoryName} · ${SHIFT_SHORT[data.shift as Shift]}`, { parse_mode: "Markdown" });
    }
    // Loop back to the slot list for this day so the head driver can keep assigning
    return showHdSlots(ctx, tid, { weekId: data.weekId, weekStart: data.weekStart, day: data.day }, dl);
  }

  // ── Attendance multi-select ───────────────────────────────────────
  // ── Driver boarding: add a person by name/code ────────────────────
  if (state?.action === "boarding:add_name") {
    const data = state.data as BoardData;
    const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
    const byCode = allWorkers.find(w => w.workerCode === text.trim());
    const byName = allWorkers.find(w => w.fullName.toLowerCase().includes(text.toLowerCase()));
    const matched = byCode ?? byName;
    const fid = data.addFactoryId!, sh = data.addShift!;
    // If matched worker is already in this section's list, just board them
    const existing = matched ? data.workers.find(w => w.workerId === matched.id && w.factoryId === fid && w.shift === sh) : undefined;
    if (existing) {
      existing.boarded = true;
    } else {
      data.workers.push({ key: `u${data.workers.length}_${Date.now() % 100000}`, entryId: null, workerId: matched?.id ?? null, name: matched?.fullName ?? text.trim(), factoryId: fid, shift: sh, boarded: true, unplanned: true });
    }
    delete data.addFactoryId; delete data.addShift;
    setState(tid, "boarding", data);
    const bl = data.lang ?? "uk";
    try { await ctx.telegram.editMessageReplyMarkup(data.chatId, data.messageId, undefined, boardingMarkup(data)); } catch { /* ignore */ }
    return ctx.reply(`➕ ${tb(bl, "Додано в авто:")} *${matched?.fullName ?? text.trim()}*${matched ? "" : ` ${tb(bl, "(немає в базі)")}`}`, { parse_mode: "Markdown" });
  }

  if (state?.action === "advance:enter_amount") {
    const lang = asLang(state.data.lang);
    const amount = parseFloat(text.replace(",", ".").replace(/[^\d.]/g, ""));
    if (!isFinite(amount) || amount <= 0) return ctx.reply(t(lang, "adv.badAmount"));
    setState(tid, "advance:enter_comment", { ...state.data, amount: Math.round(amount * 100) / 100 });
    return ctx.reply(t(lang, "adv.askComment"));
  }

  if (state?.action === "advance:enter_comment") {
    const { data } = state;
    const lang = asLang(data.lang);
    clearState(tid);
    const comment = text.trim() === "-" ? null : text.trim();
    const ins = await db.insert(advanceRequestsTable)
      .values({ workerId: data.workerId, amount: data.amount, comment, status: "pending" })
      .returning({ id: advanceRequestsTable.id });
    const reqId = ins[0]!.id;
    const worker = await getWorker(tid);
    const wname = worker?.fullName ?? "—";
    await notifyAdmins(
      `💰 *Запит на аванс*\n\n👷 *${wname}*\n💵 Сума: *${data.amount} zł*${comment ? `\n📝 ${comment}` : ""}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: "✅ Підтвердити", callback_data: `adv_approve_${reqId}` }, { text: "❌ Відхилити", callback_data: `adv_reject_${reqId}` }],
        [{ text: "💸 Виплачено", callback_data: `adv_paid_${reqId}` }],
      ] } },
    );
    await notifyRoles("scheduler", { type: "advance", title: `💰 Запит на аванс: ${wname}`, body: `${data.amount} zł${comment ? ` · ${comment}` : ""}` });
    return ctx.reply(t(lang, "adv.sent", { amount: String(data.amount) }), { parse_mode: "Markdown", ...(await workerMenuFor(worker, lang)) });
  }

  if (state?.action === "absence:enter_reason") {
    const { data } = state;
    clearState(tid);
    const req = await db.insert(absenceRequestsTable).values({
      workerId: data.workerId, weekStart: data.weekStart, dayOfWeek: data.day,
      shift: data.shift, reason: text, status: "pending",
    }).returning({ id: absenceRequestsTable.id });
    // Find substitutes
    const inSchedule = await db.select({ workerId: scheduleEntriesTable.workerId })
      .from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, data.weekId), eq(scheduleEntriesTable.dayOfWeek, data.day), eq(scheduleEntriesTable.shift, data.shift)));
    const inScheduleIds = inSchedule.map(r => r.workerId);
    const subs = await db.select({ fullNameRaw: availabilityTable.fullNameRaw })
      .from(availabilityTable)
      .where(and(eq(availabilityTable.weekStart, data.weekStart), eq(availabilityTable.dayOfWeek, data.day), eq(availabilityTable.shift, data.shift)));
    const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
    const substituteCandidates = allWorkers.filter(w =>
      !inScheduleIds.includes(w.id) &&
      subs.some(s => s.fullNameRaw.toLowerCase().includes(w.fullName.toLowerCase().split(" ")[0]!.toLowerCase()))
    );
    const workerRecord = await db.select({ fullName: workersTable.fullName }).from(workersTable).where(eq(workersTable.id, data.workerId));
    const workerName = workerRecord[0]?.fullName ?? "Невідомий";
    const requestId = req[0]!.id;
    const subList = substituteCandidates.length > 0
      ? `\n\n👥 *Можливі заміни:*\n${substituteCandidates.map((s, i) => `${i + 1}. ${s.fullName}`).join("\n")}`
      : "\n\n⚠️ Замін не знайдено";
    const adminMsg = `⚠️ *Зголошення відсутності*\n\n👷 *${workerName}*\n📅 ${DAY_UK[data.day as DayOfWeek]} — ${SHIFT_SHORT[data.shift as Shift]}\n📝 Причина: ${text}${subList}`;
    const inlineButtons = [
      ...substituteCandidates.map(s => [{ text: `📩 Запросити ${s.fullName}`, callback_data: `absence_invite_${requestId}_${s.id}` }]),
      [{ text: "✅ Прийняти (без заміни)", callback_data: `absence_approve_${requestId}` }],
      [{ text: "❌ Відхилити", callback_data: `absence_reject_${requestId}` }],
    ];
    await notifyAdmins(adminMsg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: inlineButtons } });
    // Notify the scheduler (графікова) about the cancellation (on-site bell + Telegram)
    await notifyRoles("scheduler", {
      type: "cancellation",
      title: `🚫 Відміна зміни: ${workerName}`,
      body: `${DAY_UK[data.day as DayOfWeek]} · ${SHIFT_SHORT[data.shift as Shift]} · причина: ${text}`,
    });
    const lang = asLang(data.lang);
    return ctx.reply(
      t(lang, "abs.sent", { day: dayShort(lang, data.day), shift: String(data.shift) }),
      { parse_mode: "Markdown", ...(await workerMenuFor(await getWorker(tid), lang)) },
    );
  }

  // ── Absent worker: explain reason ─────────────────────────────────
  if (state?.action === "absent:explain_reason") {
    const { data } = state;
    clearState(tid);
    // Save reason to schedule entry
    await db.update(scheduleEntriesTable).set({ absenceReason: text }).where(eq(scheduleEntriesTable.id, data.entryId));
    // Notify admin
    await notifyAdmins(
      `📝 *Пояснення відсутності*\n\n👷 *${data.name}*\n📅 ${DAY_NAMES_UK[data.day as DayOfWeek]} ${SHIFT_SHORT[data.shift as Shift]}\n\nПричина: ${text}`,
      { parse_mode: "Markdown" },
    );
    const w = await getWorker(tid);
    return ctx.reply("✅ Дякуємо. Вашу причину передано адміністратору.", await workerMenuFor(w, wlang(w)));
  }

  // ── Fire worker ───────────────────────────────────────────────────
  if (state?.action === "fire_worker:select") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    const workers: { id: number; name: string; code: string | null }[] = data.workers;
    const match = workers.find(w => text.includes(w.name));
    if (!match) return ctx.reply(tb(al, "Оберіть працівника зі списку."));
    setState(tid, "fire_worker:confirm", { workerId: match.id, workerName: match.name });
    return ctx.reply(tb(al, "⚠️ Дійсно звільнити *{name}*?", { name: match.name }), { parse_mode: "Markdown", ...Markup.keyboard([[tb(al, "✅ Так, звільнити"), tb(al, "❌ Скасувати")]]).resize() });
  }

  if (state?.action === "fire_worker:confirm") {
    const { data } = state;
    const al = olang(await getAdmin(tid));
    if (bhears("✅ Так, звільнити").includes(text)) {
      await db.update(workersTable).set({ status: "fired", isActive: false, firedAt: new Date() }).where(eq(workersTable.id, data.workerId));
      clearState(tid);
      return ctx.reply(tb(al, "✅ *{name}* звільнений(-а).", { name: data.workerName }), { parse_mode: "Markdown", ...managementMenu(al) });
    }
    clearState(tid);
    return ctx.reply(tb(al, "Скасовано."), managementMenu(al));
  }

  // ── Report: select month ──────────────────────────────────────────
  if (state?.action === "report:select_month") {
    const { data } = state;
    const options: string[] = data.options;
    const monthLabel = (m: string) => new Date(`${m}-01`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
    const match = options.find(m => text.toLowerCase().includes(monthLabel(m).split(" ")[0]!.toLowerCase()));
    const selected = match ?? options[0]!;
    const factories: string[] = data.factories;
    if (factories.length === 1) {
      setState(tid, "report:awaiting_photo", { ...data, month: selected, factory: factories[0]! });
      return ctx.reply(`📄 Надішліть *фото* рапорту за ${monthLabel(selected)} — ${factories[0]}:`, { parse_mode: "Markdown", ...Markup.removeKeyboard() });
    }
    setState(tid, "report:select_factory", { ...data, month: selected });
    return ctx.reply("Оберіть фабрику:", Markup.keyboard([...factories.map(f => [f]), ["⬅️ Назад"]]).resize());
  }

  if (state?.action === "report:select_factory") {
    const { data } = state;
    const factories: string[] = data.factories;
    const match = factories.find(f => f === text);
    if (!match) return ctx.reply("Оберіть фабрику зі списку.");
    setState(tid, "report:awaiting_photo", { ...data, factory: match });
    const monthLabel = new Date(`${data.month}-01`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
    return ctx.reply(`📄 Надішліть *фото* рапорту за ${monthLabel} — ${match}:`, { parse_mode: "Markdown", ...Markup.removeKeyboard() });
  }

  // ── Driver: unplanned worker ──────────────────────────────────────
  if (state?.action === "unplanned:enter_name") {
    const { data } = state;
    clearState(tid);
    const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
    const byCode = allWorkers.find(w => w.workerCode === text.trim());
    const byName = allWorkers.find(w => w.fullName.toLowerCase().includes(text.toLowerCase()));
    const matched = byCode ?? byName;
    await db.insert(unplannedWorkersTable).values({
      weekId: data.weekId, driverId: data.driverId, factoryId: data.factoryId,
      dayOfWeek: data.dayOfWeek, shift: data.shift,
      workerName: matched?.fullName ?? text, workerId: matched?.id,
    });
    const driver = await getDriver(tid);
    const dl = olang(driver);
    await notifyAdmins(
      `➕ *Позаплановий працівник*\n\n👷 ${matched?.fullName ?? text}${matched ? ` (код ${matched.workerCode})` : " (не в базі)"}\n🚗 Водій: ${driver?.name ?? "—"}\n📅 ${DAY_UK[data.dayOfWeek as DayOfWeek]} ${SHIFT_SHORT[data.shift as Shift]}`,
      { parse_mode: "Markdown" },
    );
    return ctx.reply(tb(dl, "✅ *{name}* додано як позапланового.", { name: matched?.fullName ?? text }), { parse_mode: "Markdown", ...driverMenu(dl) });
  }

  // ── Driver: report absent workers ─────────────────────────────────
  if (state?.action === "report_absent:select") {
    const { data } = state;
    const dl = olang(await getDriver(tid));
    const workers: { id: number; name: string | null }[] = data.workers;

    if (bhears("✅ Підтвердити відсутніх").includes(text)) {
      if ((data.selected as number[]).length === 0) {
        clearState(tid);
        return ctx.reply(tb(dl, "Нікого не обрано."), driverMenu(dl));
      }
      clearState(tid);
      const absentIds: number[] = data.selected;
      for (const entryId of absentIds) {
        await db.update(scheduleEntriesTable).set({ status: "absent" }).where(eq(scheduleEntriesTable.id, entryId));
        await notifyAbsentWorker(entryId, data.dayName);
      }
      const absentNames = workers.filter(w => absentIds.includes(w.id)).map(w => w.name).join(", ");
      const driver = await getDriver(tid);
      await notifyAdmins(
        `⚠️ *Не прийшли до машини*\n🚗 Водій: ${driver?.name ?? "—"}\n📅 ${DAY_UK[data.dayName as DayOfWeek]}\nВідсутні: ${absentNames}`,
        { parse_mode: "Markdown" },
      );
      refreshExcelReports().catch(e => logger.error({ err: e }, "refreshExcelReports failed"));
      return ctx.reply(tb(dl, "✅ Відсутніх відмічено: {n}", { n: absentIds.length }), driverMenu(dl));
    }

    // Toggle selection
    const match = workers.find(w => w.name === text);
    if (match) {
      const selected: number[] = data.selected;
      const idx = selected.indexOf(match.id);
      if (idx === -1) selected.push(match.id); else selected.splice(idx, 1);
      data.selected = selected;
      setState(tid, "report_absent:select", data);
      const selectedNames = workers.filter(w => selected.includes(w.id)).map(w => `❌ ${w.name}`).join("\n") || tb(dl, "Нікого не обрано");
      return ctx.reply(`${tb(dl, "Обрані відсутні:")}\n${selectedNames}\n\n${tb(dl, "Продовжуйте або натисніть «✅ Підтвердити відсутніх»")}`);
    }
    return;
  }

  return;
});

// ═══════════════════════════════════════════════════════════════════
// CALLBACK QUERY HANDLERS — absence management
// ═══════════════════════════════════════════════════════════════════

bot.action(/^absence_approve_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const requestId = parseInt(ctx.match[1]!, 10);
  const req = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, requestId));
  if (!req[0]) return ctx.editMessageText("❌ Запит не знайдено.");
  const r = req[0];
  await db.update(absenceRequestsTable).set({ status: "accepted" }).where(eq(absenceRequestsTable.id, requestId));
  const entries = await db.select({ id: scheduleEntriesTable.id })
    .from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.workerId, r.workerId), eq(scheduleEntriesTable.dayOfWeek, r.dayOfWeek), eq(scheduleEntriesTable.shift, r.shift)));
  if (entries[0]) {
    await db.update(scheduleEntriesTable).set({ status: "absent", absenceReason: r.reason ?? undefined }).where(eq(scheduleEntriesTable.id, entries[0].id));
  }
  const workerRecord = await db.select().from(workersTable).where(eq(workersTable.id, r.workerId));
  if (workerRecord[0]?.telegramId) {
    try { await bot.telegram.sendMessage(workerRecord[0].telegramId, `✅ Вашу відсутність на *${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}* прийнято.`, { parse_mode: "Markdown" }); }
    catch { /* ignore */ }
  }
  refreshExcelReports().catch(() => { });
  return ctx.editMessageText(`✅ Відсутність прийнята (без заміни)\n👷 ${workerRecord[0]?.fullName ?? "—"}\n📅 ${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}`);
});

// Admin sends substitute a Yes/No question
bot.action(/^absence_invite_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("Надсилаю запит...");
  const [requestId, substituteId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
  const req = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, requestId));
  if (!req[0]) return ctx.editMessageText("❌ Запит не знайдено.");
  const r = req[0];
  const sub = await db.select().from(workersTable).where(eq(workersTable.id, substituteId));
  if (!sub[0]) return ctx.editMessageText("❌ Замінника не знайдено.");
  if (!sub[0].telegramId) {
    return ctx.answerCbQuery("⚠️ Цей працівник не підключений до бота", { show_alert: true });
  }
  try {
    await bot.telegram.sendMessage(
      sub[0].telegramId,
      `📩 *Запит на заміну зміни*\n\n📅 *${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}*\nТиждень: ${formatWeekStart(r.weekStart)}\n\nЧи можете вийти на цю зміну?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Так, можу", callback_data: `absence_invite_accept_${requestId}_${substituteId}` }],
            [{ text: "❌ Ні, не можу", callback_data: `absence_invite_decline_${requestId}_${substituteId}` }],
          ],
        },
      },
    );
    return ctx.editMessageText(`📩 Запит надіслано *${sub[0].fullName}*. Очікуємо відповідь...`, { parse_mode: "Markdown" });
  } catch {
    return ctx.answerCbQuery("❌ Не вдалося надіслати повідомлення", { show_alert: true });
  }
});

// Substitute accepts
bot.action(/^absence_invite_accept_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("✅ Дякуємо!");
  const [requestId, substituteId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
  const req = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, requestId));
  if (!req[0]) return ctx.editMessageText("❌ Запит більше не актуальний.");
  const r = req[0];
  const sub = await db.select().from(workersTable).where(eq(workersTable.id, substituteId));
  if (!sub[0]) return;
  await db.update(absenceRequestsTable).set({ status: "substituted", substituteWorkerId: substituteId }).where(eq(absenceRequestsTable.id, requestId));
  const entries = await db.select({ id: scheduleEntriesTable.id })
    .from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.workerId, r.workerId), eq(scheduleEntriesTable.dayOfWeek, r.dayOfWeek), eq(scheduleEntriesTable.shift, r.shift)));
  if (entries[0]) {
    await db.update(scheduleEntriesTable).set({ workerId: substituteId }).where(eq(scheduleEntriesTable.id, entries[0].id));
  }
  const origWorker = await db.select().from(workersTable).where(eq(workersTable.id, r.workerId));
  if (origWorker[0]?.telegramId) {
    try { await bot.telegram.sendMessage(origWorker[0].telegramId, `✅ Вашу зміну *${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}* закриє *${sub[0].fullName}*.`, { parse_mode: "Markdown" }); }
    catch { /* ignore */ }
  }
  await notifyAdmins(`✅ *Заміна підтверджена*\n👷 ${origWorker[0]?.fullName ?? "—"} → *${sub[0].fullName}*\n📅 ${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}`, { parse_mode: "Markdown" });
  return ctx.editMessageText(`✅ Підтверджую! Виходжу на зміну.\n\n📅 ${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}\nТиждень: ${formatWeekStart(r.weekStart)}`, { parse_mode: "Markdown" });
});

// Substitute declines
bot.action(/^absence_invite_decline_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("Зрозуміло.");
  const [requestId, substituteId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
  const req = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, requestId));
  if (!req[0]) return ctx.editMessageText("❌ Запит більше не актуальний.");
  const r = req[0];
  const sub = await db.select().from(workersTable).where(eq(workersTable.id, substituteId));
  await notifyAdmins(
    `❌ *${sub[0]?.fullName ?? "Замінник"}* не може вийти\n📅 ${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}\n\nОберіть іншого замінника.`,
    { parse_mode: "Markdown" },
  );
  return ctx.editMessageText("❌ Зрозуміло, дякуємо що відповіли.");
});

bot.action(/^absence_reject_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const requestId = parseInt(ctx.match[1]!, 10);
  const req = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, requestId));
  if (!req[0]) return ctx.editMessageText("❌ Запит не знайдено.");
  const r = req[0];
  await db.update(absenceRequestsTable).set({ status: "rejected" }).where(eq(absenceRequestsTable.id, requestId));
  const workerRecord = await db.select().from(workersTable).where(eq(workersTable.id, r.workerId));
  if (workerRecord[0]?.telegramId) {
    try { await bot.telegram.sendMessage(workerRecord[0].telegramId, `❌ Вашу відсутність на *${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}* відхилено. Будь ласка, вийдіть на зміну.`, { parse_mode: "Markdown" }); }
    catch { /* ignore */ }
  }
  return ctx.editMessageText(`❌ Відхилено\n👷 ${workerRecord[0]?.fullName ?? "—"}\n📅 ${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}`);
});

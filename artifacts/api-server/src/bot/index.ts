import { Telegraf, Markup, type Context } from "telegraf";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, factoriesTable, factoryOrdersTable,
  scheduleWeeksTable, scheduleEntriesTable, driverShiftAssignmentsTable, adminsTable,
  absenceRequestsTable, driverTripsTable, unplannedWorkersTable, availabilityTable,
  type DayOfWeek, type Shift, type Worker, type Driver,
} from "@workspace/db";
import { eq, and, desc, inArray, ne, notInArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  readAvailabilityFromSheets, syncAvailabilityToDb, getWorkersWhoHaventSubmitted,
  DAY_NAMES_UK, DAYS, SHIFT_LABELS,
} from "../services/sheets";
import {
  generateSchedule, formatWeekStart, getNextMonday, getCurrentMonday,
} from "../services/scheduleGenerator";
import {
  exportScheduleToDrive, getDriveFolderLink, ensureFolderStructure, uploadReportPhoto,
} from "../services/drive";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const bot = new Telegraf(token);

// ─── State machine ──────────────────────────────────────────────────────────

type PendingState = { action: string; data: Record<string, any> };
const pending = new Map<string, PendingState>();

function setState(id: string, action: string, data: Record<string, any> = {}) {
  pending.set(id, { action, data });
}
function getState(id: string) { return pending.get(id); }
function clearState(id: string) { pending.delete(id); }

// ─── Role helpers ────────────────────────────────────────────────────────────

async function isAdmin(tid: string) {
  const rows = await db.select().from(adminsTable).where(eq(adminsTable.telegramId, tid));
  return rows.length > 0;
}
async function getWorker(tid: string): Promise<Worker | undefined> {
  const rows = await db.select().from(workersTable).where(eq(workersTable.telegramId, tid));
  return rows[0];
}
async function getDriver(tid: string): Promise<Driver | undefined> {
  const rows = await db.select().from(driversTable).where(eq(driversTable.telegramId, tid));
  return rows[0];
}

// ─── Display helpers ─────────────────────────────────────────────────────────

const DAY_UK: Record<DayOfWeek, string> = {
  mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Нд",
};
const SHIFT_SHORT: Record<Shift, string> = {
  "1": "1 зміна (6–14)", "2": "2 зміна (14–22)", "3": "3 зміна (22–6)",
};

// ─── Menus ───────────────────────────────────────────────────────────────────

const adminMenu = () => Markup.keyboard([
  ["📋 Замовлення фабрик", "📊 Читати таблицю"],
  ["🗓 Генерувати графік", "✅ Перегляд графіків"],
  ["👥 Управління", "📢 Розсилки"],
]).resize();

const workerMenu = () => Markup.keyboard([
  ["📅 Мій графік на тиждень"],
  ["🙋 Зголосити відсутність", "ℹ️ Моя інформація"],
  ["📄 Здати рапорт"],
]).resize();

const headDriverMenu = () => Markup.keyboard([
  ["📋 Призначити водіїв", "📅 Графік тижня"],
  ["👥 Мій список водіїв"],
]).resize();

const driverMenu = () => Markup.keyboard([
  ["📍 Моя зміна сьогодні", "📅 Мій графік"],
  ["✅ Відмітити явку", "⚠️ Не прийшли до машини"],
  ["🚌 Почати поїздку", "🏭 Прибув на фабрику"],
  ["➕ Позаплановий працівник"],
]).resize();

const managementMenu = () => Markup.keyboard([
  ["➕ Додати працівника", "📋 Список працівників"],
  ["🔗 Прив'язати Telegram", "🚗 Водії"],
  ["🏭 Фабрики", "🔥 Звільнити працівника"],
  ["☁️ Google Drive", "⬅️ Назад"],
]).resize();

// ─── /start ──────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const tid = String(ctx.from.id);
  const name = ctx.from.first_name;
  clearState(tid);

  // Handle invite / code deep links: t.me/bot?start=join or ?start=1234
  const payload = (ctx as any).startPayload as string | undefined;

  if (payload && payload !== "") {
    const code = payload.trim();

    // Link by worker code
    const workerByCode = await db.select().from(workersTable).where(eq(workersTable.workerCode, code));
    if (workerByCode.length > 0 && !workerByCode[0]!.telegramId) {
      await db.update(workersTable).set({ telegramId: tid }).where(eq(workersTable.id, workerByCode[0]!.id));
      return ctx.reply(
        `✅ Привіт, *${workerByCode[0]!.fullName}*!\n\nВас успішно прив'язано до бота.\nВаш код: \`${code}\``,
        { parse_mode: "Markdown", ...workerMenu() },
      );
    }

    if (code === "join") {
      return ctx.reply(
        `👋 Привіт! Для реєстрації введіть свій *код працівника* (4 цифри).\n\nЦей код видає адміністратор або він є у вашій картці.`,
        { parse_mode: "Markdown", ...Markup.forceReply() },
      );
    }
  }

  if (await isAdmin(tid)) {
    return ctx.reply(`👋 Привіт, *${name}*! Ви адміністратор.`, { parse_mode: "Markdown", ...adminMenu() });
  }
  const driver = await getDriver(tid);
  if (driver) {
    if (driver.isHeadDriver) {
      return ctx.reply(`🚐 Привіт, *${driver.name}*! Ви головний водій.`, { parse_mode: "Markdown", ...headDriverMenu() });
    }
    return ctx.reply(`🚗 Привіт, *${driver.name}*! Ваше меню:`, { parse_mode: "Markdown", ...driverMenu() });
  }
  const worker = await getWorker(tid);
  if (worker) {
    return ctx.reply(`👷 Привіт, *${worker.fullName}*! Ваше меню:`, { parse_mode: "Markdown", ...workerMenu() });
  }
  return ctx.reply(
    `👋 Привіт, *${name}*!\n\nВи не зареєстровані. Зверніться до адміністратора або використайте посилання-запрошення.\n\nЯкщо ви адмін — надішліть /adminsetup`,
    { parse_mode: "Markdown" },
  );
});

// ─── /adminsetup ─────────────────────────────────────────────────────────────

bot.command("adminsetup", async (ctx) => {
  const tid = String(ctx.from.id);
  if (await isAdmin(tid)) return ctx.reply("✅ Ви вже адміністратор.");
  const all = await db.select().from(adminsTable);
  if (all.length > 0) return ctx.reply("❌ Адмін вже зареєстрований. Зверніться до нього.");
  await db.insert(adminsTable).values({ telegramId: tid, name: ctx.from.first_name });
  return ctx.reply(`✅ Ви зареєстровані як перший адміністратор!`, adminMenu());
});

// ─── /getid ───────────────────────────────────────────────────────────────────

bot.command("getid", async (ctx) => {
  await ctx.reply(`Ваш Telegram ID: \`${ctx.from.id}\`\n\nПередайте його адміністратору для прив'язки.`, { parse_mode: "Markdown" });
});

// ─── Navigation ───────────────────────────────────────────────────────────────

bot.hears("⬅️ Назад", async (ctx) => {
  const tid = String(ctx.from.id);
  clearState(tid);
  if (await isAdmin(tid)) return ctx.reply("Головне меню:", adminMenu());
  const driver = await getDriver(tid);
  if (driver) return ctx.reply("Головне меню:", driver.isHeadDriver ? headDriverMenu() : driverMenu());
  return ctx.reply("Головне меню:", workerMenu());
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN: FACTORY ORDERS
// ═══════════════════════════════════════════════════════════════════

bot.hears("📋 Замовлення фабрик", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const factories = await db.select().from(factoriesTable);
  if (factories.length === 0) {
    return ctx.reply("Спочатку додайте фабрику через 👥 Управління → 🏭 Фабрики.");
  }
  const btns = factories.map(f => [f.name]);
  setState(String(ctx.from.id), "order:select_factory", {});
  return ctx.reply("Оберіть фабрику для замовлення:", Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
});

// ─── Admin: Read Sheets ───────────────────────────────────────────────────────

bot.hears("📊 Читати таблицю", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  await ctx.reply("⏳ Зчитую Google Sheets...");
  try {
    const rows = await readAvailabilityFromSheets();
    const weeks = [...new Set(rows.map(r => r.weekStart))].sort();
    if (weeks.length === 0) {
      return ctx.reply("📭 Таблиця порожня або немає нових відповідей.");
    }
    const btns = weeks.map(w => [`📅 ${w} (${formatWeekStart(w)})`]);
    setState(tid, "sheets:select_week", { weeks });
    return ctx.reply("Оберіть тиждень:", Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
  } catch (e) {
    logger.error({ err: e }, "Error reading sheets");
    return ctx.reply("❌ Помилка читання таблиці. Перевірте що таблиця поділена з сервісним акаунтом.");
  }
});

// ─── Admin: Generate Schedule ─────────────────────────────────────────────────

bot.hears("🗓 Генерувати графік", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  const next = getNextMonday();
  const curr = getCurrentMonday();
  setState(tid, "gen:select_week", { curr, next });
  return ctx.reply("Для якого тижня генерувати графік?", Markup.keyboard([
    [`📅 Поточний тиждень (${formatWeekStart(curr)})`],
    [`📅 Наступний тиждень (${formatWeekStart(next)})`],
    ["✏️ Ввести вручну (РРРР-ММ-ДД)"],
    ["⬅️ Назад"],
  ]).resize());
});

// ─── Admin: View / Approve Schedules ─────────────────────────────────────────

bot.hears("✅ Перегляд графіків", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  const weeks = await db.select().from(scheduleWeeksTable).orderBy(desc(scheduleWeeksTable.weekStart));
  if (weeks.length === 0) return ctx.reply("Немає збережених графіків.");
  const btns = weeks.map(w => [`${w.status === "approved" ? "✅" : "📋"} ${w.weekStart} — ${w.status === "approved" ? "Затверджено" : "Чернетка"}`]);
  setState(tid, "view:select_week", { weeks: weeks.map(w => w.id) });
  return ctx.reply("Оберіть графік:", Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
});

// ─── Admin: Management ────────────────────────────────────────────────────────

bot.hears("👥 Управління", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  return ctx.reply("Управління:", managementMenu());
});

// ─── Admin: Notifications ─────────────────────────────────────────────────────

bot.hears("📢 Розсилки", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  const { getReminderHour } = await import("../services/scheduler");
  return ctx.reply(
    `📢 *Розсилки*\n\n⏰ Авто-нагадування: щонеділі о *${getReminderHour()}:00* (Київ)`,
    { parse_mode: "Markdown", ...Markup.keyboard([
      ["📨 Нагадати заповнити таблицю"],
      ["📢 Розіслати затверджений графік"],
      ["⏰ Змінити час нагадування", "🔔 Тест нагадування"],
      ["⬅️ Назад"],
    ]).resize() },
  );
});

bot.hears("📨 Нагадати заповнити таблицю", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  setState(tid, "remind:select_week", {});
  const next = getNextMonday();
  return ctx.reply("Введіть тиждень для нагадування (РРРР-ММ-ДД або 'наступний'):",
    Markup.keyboard([[`${getNextMonday()}`], ["⬅️ Назад"]]).resize());
});

bot.hears("⏰ Змінити час нагадування", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  setState(tid, "set_reminder_hour", {});
  return ctx.reply(
    "Введіть годину нагадування (за Києвом, 0–23):\nНаприклад: `18` — це 18:00 щонеділі",
    { parse_mode: "Markdown", ...Markup.keyboard([["15", "17", "18", "19", "20"], ["⬅️ Назад"]]).resize() },
  );
});

bot.hears("🔔 Тест нагадування", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  await ctx.reply("⏳ Надсилаю тестові нагадування...");
  const { sendWeeklyReminders } = await import("../services/scheduler");
  const { notified, skipped } = await sendWeeklyReminders();
  return ctx.reply(
    `✅ Тест завершено!\n📨 Надіслано: ${notified}\n⚠️ Пропущено: ${skipped}`,
    Markup.keyboard([["⬅️ Назад"]]).resize(),
  );
});

bot.hears("📢 Розіслати затверджений графік", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.status, "approved"));
  if (weeks.length === 0) return ctx.reply("Немає затверджених графіків.");
  const btns = weeks.map(w => [`✅ ${w.weekStart} (${formatWeekStart(w.weekStart)})`]);
  setState(tid, "send_schedule:select_week", { weeks: weeks.map(w => ({ id: w.id, start: w.weekStart })) });
  return ctx.reply("Оберіть тиждень для розсилки:", Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
});

// ─── Management sub-menus ─────────────────────────────────────────────────────

bot.hears("➕ Додати працівника", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  setState(String(ctx.from.id), "add_worker", {});
  return ctx.reply("Введіть повне ім'я працівника (Прізвище Ім'я, так як в таблиці):", Markup.removeKeyboard());
});

bot.hears("📋 Список працівників", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
  if (workers.length === 0) return ctx.reply("Немає активних працівників.", managementMenu());
  const list = workers.map((w, i) =>
    `${i + 1}. *${w.fullName}*${w.telegramId ? " ✅" : " ⚠️"}`
  ).join("\n");
  return ctx.reply(`👷 *Працівники (${workers.length})*:\n\n${list}\n\n✅ = прив'язаний Telegram  ⚠️ = не прив'язаний`,
    { parse_mode: "Markdown", ...managementMenu() });
});

bot.hears("🔗 Прив'язати Telegram", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  setState(String(ctx.from.id), "link:enter_name", { type: "worker" });
  return ctx.reply("Введіть ім'я працівника для прив'язки:", Markup.removeKeyboard());
});

bot.hears("🚗 Водії", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  return ctx.reply("Управління водіями:", Markup.keyboard([
    ["➕ Додати водія", "📋 Список водіїв"],
    ["🔗 Прив'язати водія", "👑 Призначити головним"],
    ["⬅️ Назад"],
  ]).resize());
});

bot.hears("➕ Додати водія", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  setState(String(ctx.from.id), "add_driver", {});
  return ctx.reply("Введіть ім'я водія:", Markup.removeKeyboard());
});

bot.hears("📋 Список водіїв", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
  if (drivers.length === 0) return ctx.reply("Немає водіїв.", managementMenu());
  const list = drivers.map((d, i) =>
    `${i + 1}. ${d.isHeadDriver ? "👑 " : ""}*${d.name}*${d.vehicle ? ` (${d.vehicle})` : ""}${d.telegramId ? " ✅" : " ⚠️"}`
  ).join("\n");
  return ctx.reply(`🚗 *Водії*:\n\n${list}`, { parse_mode: "Markdown", ...Markup.keyboard([["⬅️ Назад"]]).resize() });
});

bot.hears("🔗 Прив'язати водія", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  setState(String(ctx.from.id), "link:enter_name", { type: "driver" });
  return ctx.reply("Введіть ім'я водія для прив'язки:", Markup.removeKeyboard());
});

bot.hears("👑 Призначити головним", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
  if (drivers.length === 0) return ctx.reply("Немає водіїв.");
  setState(String(ctx.from.id), "set_head_driver", {});
  const btns = drivers.map(d => [`${d.isHeadDriver ? "👑 " : ""}${d.name}`]);
  return ctx.reply("Оберіть головного водія:", Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
});

bot.hears("🏭 Фабрики", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  return ctx.reply("Управління фабриками:", Markup.keyboard([
    ["➕ Додати фабрику", "📋 Список фабрик"],
    ["⬅️ Назад"],
  ]).resize());
});

bot.hears("➕ Додати фабрику", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  setState(String(ctx.from.id), "add_factory", {});
  return ctx.reply("Введіть назву фабрики:", Markup.removeKeyboard());
});

bot.hears("📋 Список фабрик", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const factories = await db.select().from(factoriesTable);
  if (factories.length === 0) return ctx.reply("Немає фабрик.");
  const list = factories.map((f, i) => `${i + 1}. *${f.name}*${f.address ? `\n   📍 ${f.address}` : ""}`).join("\n");
  return ctx.reply(`🏭 *Фабрики*:\n\n${list}`, { parse_mode: "Markdown", ...Markup.keyboard([["⬅️ Назад"]]).resize() });
});

// ─── Admin: Google Drive ──────────────────────────────────────────────────────

bot.hears("☁️ Google Drive", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  await ctx.reply("⏳ Перевіряю папки на Google Drive...");
  try {
    await ensureFolderStructure();
    const link = await getDriveFolderLink();
    return ctx.reply(
      `☁️ *Google Drive*\n\n📁 Головна папка:\n${link}\n\nСтруктура:\n📂 Графіки — Excel файли графіків по тижнях\n📂 Облік годин — щомісячний облік годин\n📂 Рапорти — фото рапортів по фабриках та місяцях`,
      { parse_mode: "Markdown", ...managementMenu() },
    );
  } catch (e) {
    logger.error({ err: e }, "Drive folder check error");
    return ctx.reply("❌ Помилка підключення до Google Drive. Перевірте налаштування сервісного акаунту.", managementMenu());
  }
});

// ─── Admin: Extended worker list ──────────────────────────────────────────────

bot.hears("📋 Список працівників", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true)).orderBy(workersTable.fullName);
  if (workers.length === 0) return ctx.reply("Немає активних працівників.", managementMenu());
  const list = workers.map((w, i) =>
    `${i + 1}. *${w.fullName}* \`${w.workerCode ?? "—"}\`${w.telegramId ? " ✅" : " ⚠️"}${w.status === "fired" ? " 🔴" : ""}`
  ).join("\n");
  return ctx.reply(
    `👷 *Працівники (${workers.length})*:\n\n${list}\n\n✅ = Telegram прив'язаний  ⚠️ = не прив'язаний`,
    { parse_mode: "Markdown", ...managementMenu() },
  );
});

// ─── Admin: Fire worker ───────────────────────────────────────────────────────

bot.hears("🔥 Звільнити працівника", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  const workers = await db.select().from(workersTable).where(and(eq(workersTable.isActive, true), ne(workersTable.status, "fired"))).orderBy(workersTable.fullName);
  if (workers.length === 0) return ctx.reply("Немає активних працівників.", managementMenu());
  const btns = workers.map(w => [`${w.fullName} (${w.workerCode ?? "—"})`]);
  setState(tid, "fire_worker:select", { workers: workers.map(w => ({ id: w.id, name: w.fullName, code: w.workerCode })) });
  return ctx.reply("Оберіть працівника для звільнення:", Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
});

// ═══════════════════════════════════════════════════════════════════
// WORKER FLOWS
// ═══════════════════════════════════════════════════════════════════

bot.hears("📅 Мій графік на тиждень", async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  if (!worker) return ctx.reply("❌ Ви не зареєстровані як працівник.");
  const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.status, "approved")).orderBy(desc(scheduleWeeksTable.weekStart));
  if (weeks.length === 0) return ctx.reply("📭 Немає затвердженого графіку.", workerMenu());
  const week = weeks[0]!;
  return showWorkerSchedule(ctx, worker.id, week.id, week.weekStart);
});

bot.hears("ℹ️ Моя інформація", async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  if (!worker) return;
  const botUsername = ctx.botInfo.username;
  return ctx.reply(
    `👷 *${worker.fullName}*\n🆔 Telegram: \`${ctx.from.id}\`\n🔑 Ваш код: \`${worker.workerCode ?? "—"}\`\n\nЗаслати другу посилання: \`https://t.me/${botUsername}?start=${worker.workerCode}\``,
    { parse_mode: "Markdown" },
  );
});

// ─── /invite — admin generates invite link ────────────────────────────────────

bot.command("invite", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const botUsername = ctx.botInfo.username;
  const link = `https://t.me/${botUsername}?start=join`;
  return ctx.reply(
    `🔗 *Запрошення до бота*\n\nПоділіться цим посиланням з новим працівником:\n${link}\n\n_Або надайте їм їхній код — вони зможуть зайти самостійно через_ \`/start КОД\``,
    { parse_mode: "Markdown" },
  );
});

// ─── Worker: Declare absence ──────────────────────────────────────────────────

bot.hears("🙋 Зголосити відсутність", async (ctx) => {
  const tid = String(ctx.from.id);
  const worker = await getWorker(tid);
  if (!worker) return ctx.reply("❌ Ви не зареєстровані як працівник.");
  const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.status, "approved")).orderBy(desc(scheduleWeeksTable.weekStart));
  if (weeks.length === 0) return ctx.reply("📭 Немає затвердженого графіку.", workerMenu());
  const week = weeks[0]!;
  const entries = await db
    .select({ id: scheduleEntriesTable.id, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift })
    .from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.workerId, worker.id), eq(scheduleEntriesTable.status, "scheduled")));
  if (entries.length === 0) return ctx.reply("У вас немає запланованих змін для зголошення.", workerMenu());
  const btns = entries.map(e => [`${DAY_UK[e.day]} — ${SHIFT_SHORT[e.shift as Shift]}`]);
  setState(tid, "absence:select_shift", { workerId: worker.id, weekStart: week.weekStart, weekId: week.id, entries });
  return ctx.reply(
    `🙋 *Зголосити відсутність*\n\nОберіть зміну, на яку не зможете прийти:`,
    { parse_mode: "Markdown", ...Markup.keyboard([...btns, ["⬅️ Назад"]]).resize() },
  );
});

// ─── Worker: Submit report photo ─────────────────────────────────────────────

bot.hears("📄 Здати рапорт", async (ctx) => {
  const worker = await getWorker(String(ctx.from.id));
  if (!worker) return ctx.reply("❌ Ви не зареєстровані.");
  // Check if within allowed period (7 days before month end or 7 days after month start)
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prevMonth = now.getMonth() === 0
    ? `${now.getFullYear() - 1}-12`
    : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;
  const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysRemaining = daysInCurrentMonth - now.getDate();
  const daysIntoMonth = now.getDate();
  const canSubmitPrev = daysIntoMonth <= 7;
  const canSubmitCurrent = daysRemaining <= 7;
  if (!canSubmitPrev && !canSubmitCurrent) {
    return ctx.reply(
      `⏰ Рапорти можна подавати за 7 днів до кінця місяця або в перші 7 днів нового місяця.\n\nНаступне вікно: з ${daysInCurrentMonth - 6}-го числа.`,
      workerMenu(),
    );
  }
  // Get factories from worker's schedule entries
  const factories = await db
    .select({ name: factoriesTable.name })
    .from(scheduleEntriesTable)
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(eq(scheduleEntriesTable.workerId, worker.id));
  const uniqueFactories = [...new Set(factories.map(f => f.name).filter(Boolean))] as string[];
  if (uniqueFactories.length === 0) {
    const allFactories = await db.select().from(factoriesTable);
    uniqueFactories.push(...allFactories.map(f => f.name));
  }
  const options = [canSubmitPrev ? prevMonth : null, canSubmitCurrent ? currentMonth : null].filter(Boolean) as string[];
  const monthLabel = (m: string) => new Date(`${m}-01`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
  setState(String(ctx.from.id), "report:select_month", { workerId: worker.id, workerName: worker.fullName, options, factories: uniqueFactories });
  const btns = options.map(m => [monthLabel(m)]);
  return ctx.reply("Оберіть місяць для рапорту:", Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
});

// ═══════════════════════════════════════════════════════════════════
// HEAD DRIVER FLOWS
// ═══════════════════════════════════════════════════════════════════

bot.hears("📋 Призначити водіїв", async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver?.isHeadDriver) return;
  const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.status, "approved")).orderBy(desc(scheduleWeeksTable.weekStart));
  if (weeks.length === 0) return ctx.reply("Немає затверджених графіків.");
  setState(String(ctx.from.id), "hd:select_week", { weeks: weeks.map(w => ({ id: w.id, start: w.weekStart })) });
  const btns = weeks.map(w => [`${w.weekStart} (${formatWeekStart(w.weekStart)})`]);
  return ctx.reply("Оберіть тиждень:", Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
});

bot.hears("📅 Графік тижня", async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver?.isHeadDriver) return ctx.reply("❌ Немає доступу.");
  const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.status, "approved")).orderBy(desc(scheduleWeeksTable.weekStart));
  if (weeks.length === 0) return ctx.reply("Немає затверджених графіків.");
  const week = weeks[0]!;
  return showFullWeekSchedule(ctx, week.id, week.weekStart);
});

// ═══════════════════════════════════════════════════════════════════
// DRIVER FLOWS
// ═══════════════════════════════════════════════════════════════════

bot.hears("📍 Моя зміна сьогодні", async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver) return ctx.reply("❌ Ви не зареєстровані як водій.");
  const today = new Date();
  const dayName = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][today.getDay()] as DayOfWeek;
  const week = getCurrentMonday();
  return showDriverShift(ctx, driver.id, week, dayName);
});

bot.hears("📅 Мій графік", async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver) return ctx.reply("❌ Ви не зареєстровані як водій.");
  const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.status, "approved")).orderBy(desc(scheduleWeeksTable.weekStart));
  if (weeks.length === 0) return ctx.reply("Немає графіків.", driverMenu());
  const week = weeks[0]!;
  return showDriverWeek(ctx, driver.id, week.id, week.weekStart);
});

// ─── Driver: Trip tracking ────────────────────────────────────────────────────

bot.hears("🚌 Почати поїздку", async (ctx) => {
  const tid = String(ctx.from.id);
  const driver = await getDriver(tid);
  if (!driver) return ctx.reply("❌ Ви не зареєстровані як водій.");
  const today = new Date();
  const dayName = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][today.getDay()] as DayOfWeek;
  const week = getCurrentMonday();
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply("Немає активного графіку.", driverMenu());
  const assignments = await db.select({ shift: driverShiftAssignmentsTable.shift, factoryId: driverShiftAssignmentsTable.factoryId })
    .from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id), eq(driverShiftAssignmentsTable.dayOfWeek, dayName), eq(driverShiftAssignmentsTable.driverId, driver.id)));
  if (assignments.length === 0) return ctx.reply(`📭 На ${DAY_NAMES_UK[dayName]} у вас немає призначень.`, driverMenu());
  // Record trip start
  const now = new Date();
  const trip = assignments[0]!;
  const PICKUP_HOURS: Record<Shift, number> = { "1": 5, "2": 13, "3": 21 };
  const expectedPickup = new Date(today);
  expectedPickup.setHours(PICKUP_HOURS[trip.shift as Shift]!, 0, 0, 0);
  const lateToPickup = now > expectedPickup;
  const existingTrip = await db.select({ id: driverTripsTable.id }).from(driverTripsTable)
    .where(and(eq(driverTripsTable.driverId, driver.id), eq(driverTripsTable.weekId, weeks[0]!.id), eq(driverTripsTable.dayOfWeek, dayName), eq(driverTripsTable.shift, trip.shift as Shift)));
  if (existingTrip.length > 0) {
    await db.update(driverTripsTable).set({ pickupStartedAt: now, lateToPickup }).where(eq(driverTripsTable.id, existingTrip[0]!.id));
  } else {
    await db.insert(driverTripsTable).values({
      driverId: driver.id, weekId: weeks[0]!.id, factoryId: trip.factoryId,
      dayOfWeek: dayName, shift: trip.shift as Shift, tripDate: today.toISOString().split("T")[0]!,
      pickupStartedAt: now, lateToPickup,
    });
  }
  const timeStr = now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  return ctx.reply(
    `🚌 *Поїздку розпочато!*\n\nЧас: ${timeStr}${lateToPickup ? "\n⚠️ Ви спізнились на місце збору!" : "\n✅ Вчасно на місці збору"}`,
    { parse_mode: "Markdown", ...driverMenu() },
  );
});

bot.hears("🏭 Прибув на фабрику", async (ctx) => {
  const tid = String(ctx.from.id);
  const driver = await getDriver(tid);
  if (!driver) return ctx.reply("❌ Ви не зареєстровані як водій.");
  const today = new Date();
  const dayName = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][today.getDay()] as DayOfWeek;
  const week = getCurrentMonday();
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply("Немає активного графіку.", driverMenu());
  const trip = await db.select().from(driverTripsTable)
    .where(and(eq(driverTripsTable.driverId, driver.id), eq(driverTripsTable.weekId, weeks[0]!.id), eq(driverTripsTable.dayOfWeek, dayName)));
  if (trip.length === 0) return ctx.reply("⚠️ Спочатку натисніть «🚌 Почати поїздку».", driverMenu());
  const now = new Date();
  const FACTORY_HOURS: Record<Shift, number> = { "1": 5, "2": 13, "3": 21 };
  const FACTORY_MINUTES: Record<Shift, number> = { "1": 45, "2": 45, "3": 45 };
  const shift = trip[0]!.shift;
  const expectedFactory = new Date(today);
  expectedFactory.setHours(FACTORY_HOURS[shift]!, FACTORY_MINUTES[shift]!, 0, 0);
  const lateToFactory = now > expectedFactory;
  await db.update(driverTripsTable).set({ arrivedFactoryAt: now, lateToFactory }).where(eq(driverTripsTable.id, trip[0]!.id));
  const timeStr = now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  const travelMin = trip[0]!.pickupStartedAt
    ? Math.round((now.getTime() - trip[0]!.pickupStartedAt.getTime()) / 60000)
    : null;
  return ctx.reply(
    `🏭 *Прибуття на фабрику зафіксовано!*\n\nЧас: ${timeStr}${travelMin ? `\n⏱ В дорозі: ${travelMin} хв` : ""}${lateToFactory ? "\n⚠️ Запізнення на фабрику!" : "\n✅ Прибули вчасно"}`,
    { parse_mode: "Markdown", ...driverMenu() },
  );
});

// ─── Driver: Report workers who didn't show ───────────────────────────────────

bot.hears("⚠️ Не прийшли до машини", async (ctx) => {
  const tid = String(ctx.from.id);
  const driver = await getDriver(tid);
  if (!driver) return ctx.reply("❌ Ви не зареєстровані як водій.");
  const today = new Date();
  const dayName = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][today.getDay()] as DayOfWeek;
  const week = getCurrentMonday();
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply("Немає активного графіку.", driverMenu());
  const myAssignments = await db.select({ shift: driverShiftAssignmentsTable.shift })
    .from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id), eq(driverShiftAssignmentsTable.dayOfWeek, dayName), eq(driverShiftAssignmentsTable.driverId, driver.id)));
  if (myAssignments.length === 0) return ctx.reply(`📭 На сьогодні у вас немає призначень.`, driverMenu());
  const myShifts = [...new Set(myAssignments.map(a => a.shift))];
  const workers = await db
    .select({ id: scheduleEntriesTable.id, name: workersTable.fullName, status: scheduleEntriesTable.status })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(
      eq(scheduleEntriesTable.weekId, weeks[0]!.id),
      eq(scheduleEntriesTable.dayOfWeek, dayName),
      inArray(scheduleEntriesTable.shift, myShifts as Shift[]),
      eq(scheduleEntriesTable.status, "scheduled"),
    ));
  if (workers.length === 0) return ctx.reply("Всі явки вже відмічені.", driverMenu());
  setState(tid, "report_absent:select", { weekId: weeks[0]!.id, dayName, workers: workers.map(w => ({ id: w.id, name: w.name })), selected: [] as number[] });
  const btns = workers.map(w => [`❌ ${w.name}`]);
  return ctx.reply(
    `⚠️ Оберіть хто не прийшов (натисніть на ім'я):\n\nПісля вибору натисніть «✅ Підтвердити»`,
    Markup.keyboard([...btns, ["✅ Підтвердити відсутніх"], ["⬅️ Назад"]]).resize(),
  );
});

// ─── Driver: Add unplanned worker ─────────────────────────────────────────────

bot.hears("➕ Позаплановий працівник", async (ctx) => {
  const tid = String(ctx.from.id);
  const driver = await getDriver(tid);
  if (!driver) return ctx.reply("❌ Ви не зареєстровані як водій.");
  const today = new Date();
  const dayName = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][today.getDay()] as DayOfWeek;
  const week = getCurrentMonday();
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply("Немає активного графіку.", driverMenu());
  const assignments = await db.select({ shift: driverShiftAssignmentsTable.shift, factoryId: driverShiftAssignmentsTable.factoryId })
    .from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id), eq(driverShiftAssignmentsTable.dayOfWeek, dayName), eq(driverShiftAssignmentsTable.driverId, driver.id)));
  if (assignments.length === 0) return ctx.reply(`📭 На сьогодні у вас немає призначень.`, driverMenu());
  const a = assignments[0]!;
  setState(tid, "unplanned:enter_name", { weekId: weeks[0]!.id, driverId: driver.id, factoryId: a.factoryId, dayOfWeek: dayName, shift: a.shift });
  return ctx.reply("Введіть ім'я або код позапланового працівника:", Markup.removeKeyboard());
});

// ─── Driver: Attendance ───────────────────────────────────────────────────────

bot.hears("✅ Відмітити явку", async (ctx) => {
  const driver = await getDriver(String(ctx.from.id));
  if (!driver) return;
  const today = new Date();
  const dayName = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][today.getDay()] as DayOfWeek;
  const week = getCurrentMonday();

  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, week), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply("Немає активного графіку на цей тиждень.", driverMenu());

  const entries = await db
    .select({ id: scheduleEntriesTable.id, workerId: scheduleEntriesTable.workerId, workerName: workersTable.fullName, status: scheduleEntriesTable.status })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(
      eq(scheduleEntriesTable.weekId, weeks[0]!.id),
      eq(scheduleEntriesTable.dayOfWeek, dayName),
    ));

  // Check if this driver has assignments today
  const myAssignments = await db.select().from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id), eq(driverShiftAssignmentsTable.dayOfWeek, dayName), eq(driverShiftAssignmentsTable.driverId, driver.id)));

  if (myAssignments.length === 0) return ctx.reply("У вас немає призначень на сьогодні.", driverMenu());

  const myShifts = [...new Set(myAssignments.map(a => a.shift))];
  const myEntries = entries.filter(e => myShifts.some(s => {
    return true; // simplified: show all entries for today from driver's shifts
  })).filter(e => e.status === "scheduled");

  if (myEntries.length === 0) return ctx.reply("Всі явки вже відмічені.", driverMenu());

  setState(String(ctx.from.id), "attendance:marking", {
    weekId: weeks[0]!.id,
    dayName,
    entries: myEntries.map(e => ({ id: e.id, name: e.workerName })),
    index: 0,
    absent: [] as number[],
  });

  const first = myEntries[0]!;
  return ctx.reply(
    `✅ Відмітити явку — ${DAY_UK[dayName]}\n\n👷 *${first.workerName}* — вийшов?`,
    { parse_mode: "Markdown", ...Markup.keyboard([["✅ Так, вийшов", "❌ Ні, відсутній"], ["⬅️ Назад"]]).resize() },
  );
});

// ═══════════════════════════════════════════════════════════════════
// TEXT MESSAGE HANDLER (multi-step flows)
// ═══════════════════════════════════════════════════════════════════

bot.on("text", async (ctx) => {
  const tid = String(ctx.from.id);
  const text = ctx.message.text;
  const state = getState(tid);

  // ── Add worker ────────────────────────────────────────────────────
  if (!state && text !== "⬅️ Назад") return;

  if (state?.action === "add_worker") {
    // Auto-generate worker code: find max existing numeric code + 1
    const allCodes = await db.select({ code: workersTable.workerCode }).from(workersTable);
    const maxCode = allCodes
      .map(r => parseInt(r.code ?? "0", 10))
      .filter(n => !isNaN(n))
      .reduce((a, b) => Math.max(a, b), 0);
    const newCode = String(maxCode + 1).padStart(4, "0");
    await db.insert(workersTable).values({ fullName: text, workerCode: newCode });
    const botUsername = ctx.botInfo.username;
    clearState(tid);
    return ctx.reply(
      `✅ Працівник *${text}* доданий!\n🔑 Код: \`${newCode}\`\n🔗 Посилання: \`https://t.me/${botUsername}?start=${newCode}\`\n\nАбо прив'яжіть Telegram через "🔗 Прив'язати Telegram".`,
      { parse_mode: "Markdown", ...managementMenu() },
    );
  }

  // ── Add driver ────────────────────────────────────────────────────
  if (state?.action === "add_driver") {
    const { data } = state;
    if (!data.name) {
      data.name = text;
      setState(tid, "add_driver", data);
      return ctx.reply("Введіть номер авто (або /skip):", Markup.removeKeyboard());
    } else {
      const vehicle = text === "/skip" ? undefined : text;
      await db.insert(driversTable).values({ name: data.name, vehicle });
      clearState(tid);
      return ctx.reply(`✅ Водій *${data.name}* доданий!`, { parse_mode: "Markdown", ...managementMenu() });
    }
  }

  // ── Add factory ───────────────────────────────────────────────────
  if (state?.action === "add_factory") {
    const { data } = state;
    if (!data.name) {
      data.name = text;
      setState(tid, "add_factory", data);
      return ctx.reply("Введіть адресу (або /skip):", Markup.removeKeyboard());
    } else {
      const address = text === "/skip" ? undefined : text;
      await db.insert(factoriesTable).values({ name: data.name, address });
      clearState(tid);
      return ctx.reply(`✅ Фабрика *${data.name}* додана!`, { parse_mode: "Markdown", ...managementMenu() });
    }
  }

  // ── Link telegram ─────────────────────────────────────────────────
  if (state?.action === "link:enter_name") {
    const { data } = state;
    if (!data.searchName) {
      data.searchName = text;
      setState(tid, "link:enter_id", data);
      return ctx.reply(`Попросіть ${data.type === "worker" ? "працівника" : "водія"} надіслати /getid боту.\nПотім вставте їх Telegram ID сюди:`);
    }
  }

  if (state?.action === "link:enter_id") {
    const { data } = state;
    const newTid = text.trim();
    if (data.type === "worker") {
      const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
      const match = workers.find(w => w.fullName.toLowerCase().includes(data.searchName.toLowerCase()));
      if (!match) { clearState(tid); return ctx.reply("Працівника не знайдено.", managementMenu()); }
      await db.update(workersTable).set({ telegramId: newTid }).where(eq(workersTable.id, match.id));
      clearState(tid);
      return ctx.reply(`✅ *${match.fullName}* прив'язаний до Telegram \`${newTid}\``, { parse_mode: "Markdown", ...managementMenu() });
    } else {
      const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
      const match = drivers.find(d => d.name.toLowerCase().includes(data.searchName.toLowerCase()));
      if (!match) { clearState(tid); return ctx.reply("Водія не знайдено.", managementMenu()); }
      await db.update(driversTable).set({ telegramId: newTid }).where(eq(driversTable.id, match.id));
      clearState(tid);
      return ctx.reply(`✅ *${match.name}* прив'язаний до Telegram \`${newTid}\``, { parse_mode: "Markdown", ...managementMenu() });
    }
  }

  // ── Set head driver ───────────────────────────────────────────────
  if (state?.action === "set_head_driver") {
    const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
    const match = drivers.find(d => text.includes(d.name));
    if (!match) return ctx.reply("Водія не знайдено. Оберіть зі списку.");
    await db.update(driversTable).set({ isHeadDriver: false });
    await db.update(driversTable).set({ isHeadDriver: true }).where(eq(driversTable.id, match.id));
    clearState(tid);
    return ctx.reply(`✅ *${match.name}* призначений головним водієм!`, { parse_mode: "Markdown", ...managementMenu() });
  }

  // ── Factory order flow ────────────────────────────────────────────
  if (state?.action === "order:select_factory") {
    const factories = await db.select().from(factoriesTable);
    const match = factories.find(f => f.name === text);
    if (!match) return ctx.reply("Оберіть фабрику зі списку.");
    const next = getNextMonday();
    const curr = getCurrentMonday();
    setState(tid, "order:select_week", { factoryId: match.id, factoryName: match.name, curr, next });
    return ctx.reply(`Фабрика: *${match.name}*\nОберіть тиждень:`, {
      parse_mode: "Markdown",
      ...Markup.keyboard([
        [`📅 Поточний тиждень (${formatWeekStart(curr)})`],
        [`📅 Наступний тиждень (${formatWeekStart(next)})`],
        ["✏️ Ввести вручну"],
        ["⬅️ Назад"],
      ]).resize(),
    });
  }

  if (state?.action === "order:select_week") {
    const { data } = state;
    const { curr, next } = data as { curr: string; next: string };
    let weekStart: string;
    if (text.includes("Поточний")) weekStart = curr;
    else if (text.includes("Наступний")) weekStart = next;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) weekStart = text;
    else if (text === "✏️ Ввести вручну") {
      return ctx.reply("Введіть дату понеділка (РРРР-ММ-ДД):", Markup.removeKeyboard());
    } else return ctx.reply("Введіть дату у форматі РРРР-ММ-ДД:");
    data.weekStart = weekStart;
    setState(tid, "order:enter_days", { ...data, dayIndex: 0 });
    return askOrderForDay(ctx, tid, data.factoryName, weekStart, 0);
  }

  if (state?.action === "order:enter_days") {
    const { data } = state;
    // Expect "8 12 5" — shift1 shift2 shift3 counts, or "0 0 0" to skip
    const parts = text.trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
      return ctx.reply("Введіть 3 числа через пробіл (1зміна 2зміна 3зміна), наприклад: `8 12 5`", { parse_mode: "Markdown" });
    }
    const day = DAYS[data.dayIndex] as DayOfWeek;
    // Save to DB
    for (let s = 0; s < 3; s++) {
      const count = parts[s]!;
      if (count < 0) continue;
      // Delete existing and insert
      await db.delete(factoryOrdersTable).where(and(
        eq(factoryOrdersTable.factoryId, data.factoryId),
        eq(factoryOrdersTable.weekStart, data.weekStart),
        eq(factoryOrdersTable.dayOfWeek, day),
        eq(factoryOrdersTable.shift, String(s + 1) as Shift),
      ));
      if (count > 0) {
        await db.insert(factoryOrdersTable).values({
          factoryId: data.factoryId,
          weekStart: data.weekStart,
          dayOfWeek: day,
          shift: String(s + 1) as Shift,
          workersNeeded: count,
        });
      }
    }

    const nextIndex = data.dayIndex + 1;
    if (nextIndex >= DAYS.length) {
      clearState(tid);
      return ctx.reply(`✅ Замовлення для *${data.factoryName}* на тиждень ${formatWeekStart(data.weekStart)} збережено!`,
        { parse_mode: "Markdown", ...adminMenu() });
    }
    data.dayIndex = nextIndex;
    setState(tid, "order:enter_days", data);
    return askOrderForDay(ctx, tid, data.factoryName, data.weekStart, nextIndex);
  }

  // ── Sheets: select week ───────────────────────────────────────────
  if (state?.action === "sheets:select_week") {
    const match = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) return ctx.reply("Оберіть тиждень зі списку.");
    const weekStart = match[1]!;
    clearState(tid);
    await ctx.reply(`⏳ Синхронізую тиждень ${weekStart}...`);
    try {
      const { synced, autoAdded } = await syncAvailabilityToDb(weekStart);
      const missing = await getWorkersWhoHaventSubmitted(weekStart);
      let msg = `✅ Синхронізовано! *${synced}* записів для тижня ${formatWeekStart(weekStart)}\n\n`;
      if (autoAdded.length > 0) {
        msg += `👤 *Автоматично додано до списку (${autoAdded.length}):*\n${autoAdded.map(n => `• ${n}`).join("\n")}\n\n`;
      }
      if (missing.length > 0) {
        msg += `📭 *Не заповнили анкету (${missing.length}):*\n${missing.map(w => `• ${w.fullName}${w.telegramId ? "" : " ⚠️"}`).join("\n")}`;
      } else {
        msg += `🎉 Всі працівники заповнили анкету!`;
      }
      return ctx.reply(msg, { parse_mode: "Markdown", ...adminMenu() });
    } catch (e) {
      logger.error({ err: e }, "Sync error");
      return ctx.reply("❌ Помилка синхронізації.", adminMenu());
    }
  }

  // ── Generate schedule: select week ───────────────────────────────
  if (state?.action === "gen:select_week") {
    let weekStart: string;
    const { curr, next } = state.data as { curr: string; next: string };
    if (text.includes("Поточний")) weekStart = curr;
    else if (text.includes("Наступний")) weekStart = next;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) weekStart = text;
    else return ctx.reply("Введіть дату у форматі РРРР-ММ-ДД:");
    clearState(tid);
    await ctx.reply(`⏳ Генерую графік для тижня ${formatWeekStart(weekStart)}...`);
    try {
      const result = await generateSchedule(weekStart);
      let msg = `📅 *Чернетка графіку готова!*\n*Тиждень:* ${formatWeekStart(weekStart)}\n*Призначено:* ${result.totalAssigned} змін\n\n`;
      if (result.shortages.length > 0) {
        msg += `⚠️ *Нестача людей:*\n`;
        for (const s of result.shortages) {
          msg += `• ${s.factoryName} ${DAY_UK[s.day]} ${SHIFT_SHORT[s.shift]}: потрібно ${s.needed}, є ${s.available} (бракує ${s.shortage})\n`;
        }
        msg += "\n";
      } else {
        msg += `✅ Всі замовлення виконані!\n\n`;
      }
      msg += `Перегляньте графік через "✅ Перегляд графіків"`;
      return ctx.reply(msg, { parse_mode: "Markdown", ...adminMenu() });
    } catch (e) {
      logger.error({ err: e }, "Schedule generation error");
      return ctx.reply("❌ Помилка генерації. Переконайтесь що є замовлення і синхронізована доступність.", adminMenu());
    }
  }

  // ── View/approve schedule ─────────────────────────────────────────
  if (state?.action === "view:select_week") {
    const match = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) return;
    const weekStart = match[1]!;
    const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart));
    if (weeks.length === 0) return ctx.reply("Графік не знайдено.");
    const week = weeks[0]!;
    setState(tid, "view:selected", { weekId: week.id, weekStart: week.weekStart, status: week.status });
    await showFullWeekSchedule(ctx, week.id, week.weekStart);
    if (week.status === "draft") {
      return ctx.reply("Що робити з цим графіком?", Markup.keyboard([
        ["✅ Затвердити графік", "🔄 Перегенерувати"],
        ["⬅️ Назад"],
      ]).resize());
    }
    return ctx.reply("Графік вже затверджений.", adminMenu());
  }

  if (state?.action === "view:selected") {
    const { data } = state;
    if (text === "✅ Затвердити графік") {
      await db.update(scheduleWeeksTable).set({ status: "approved", approvedAt: new Date() }).where(eq(scheduleWeeksTable.id, data.weekId));
      clearState(tid);
      await ctx.reply(`✅ Графік для тижня ${formatWeekStart(data.weekStart)} затверджено!\n\n⏳ Зберігаю на Google Drive...`);
      try {
        const driveLink = await exportScheduleToDrive(data.weekId, data.weekStart);
        if (driveLink) {
          await ctx.reply(`☁️ Графік збережено на Drive:\n${driveLink}`, adminMenu());
        }
      } catch (e) {
        logger.error({ err: e }, "Drive export failed");
      }
      return ctx.reply(`Тепер розішліть графік через "📢 Розсилки → 📢 Розіслати затверджений графік"`, adminMenu());
    }
    if (text === "🔄 Перегенерувати") {
      clearState(tid);
      await ctx.reply("⏳ Перегенерую...");
      const result = await generateSchedule(data.weekStart);
      return ctx.reply(`✅ Перегенеровано! Призначено: ${result.totalAssigned}`, adminMenu());
    }
  }

  // ── Send approved schedule ────────────────────────────────────────
  if (state?.action === "send_schedule:select_week") {
    const match = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) return;
    const weekStart = match[1]!;
    const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "approved")));
    if (weeks.length === 0) return ctx.reply("Графік не знайдено.");
    clearState(tid);
    await ctx.reply("⏳ Розсилаю...");
    const { notified, skipped } = await sendScheduleToAllWorkers(weeks[0]!.id, weekStart);
    const headDriverResult = await sendScheduleToHeadDriver(weeks[0]!.id, weekStart);
    return ctx.reply(`📢 Розіслано!\n👷 Працівники: ${notified} / пропущено: ${skipped}\n🚐 Головний водій: ${headDriverResult}`, adminMenu());
  }

  // ── Remind to fill sheet ──────────────────────────────────────────
  if (state?.action === "remind:select_week") {
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : getNextMonday();
    clearState(tid);
    await ctx.reply("⏳ Перевіряю хто не заповнив...");
    const missing = await getWorkersWhoHaventSubmitted(weekStart);
    if (missing.length === 0) return ctx.reply("🎉 Всі заповнили!", adminMenu());
    let notified = 0, skipped = 0;
    for (const w of missing) {
      if (!w.telegramId) { skipped++; continue; }
      try {
        await bot.telegram.sendMessage(w.telegramId,
          `📋 *Нагадування*\n\nБудь ласка, заповніть анкету доступності на тиждень ${formatWeekStart(weekStart)}!\n\nЯкщо ви вже заповнили — ігноруйте це повідомлення.`,
          { parse_mode: "Markdown" });
        notified++;
      } catch { skipped++; }
    }
    return ctx.reply(`📨 Нагадування надіслано!\n✅ ${notified} повідомлень\n⚠️ ${skipped} без Telegram`, adminMenu());
  }

  // ── Set reminder hour ─────────────────────────────────────────────
  if (state?.action === "set_reminder_hour") {
    const hour = parseInt(text.trim(), 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return ctx.reply("Введіть число від 0 до 23:");
    }
    clearState(tid);
    const { setReminderHour } = await import("../services/scheduler");
    setReminderHour(hour);
    return ctx.reply(
      `✅ Авто-нагадування налаштовано на *${hour}:00* (Київ) щонеділі!`,
      { parse_mode: "Markdown", ...adminMenu() },
    );
  }

  // ── Head driver: select week ──────────────────────────────────────
  if (state?.action === "hd:select_week") {
    const match = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) return;
    const weekStart = match[1]!;
    const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "approved")));
    if (weeks.length === 0) return ctx.reply("Графік не знайдено.");
    setState(tid, "hd:select_day", { weekId: weeks[0]!.id, weekStart });
    const dayBtns = DAYS.map(d => [DAY_NAMES_UK[d]]);
    return ctx.reply("Оберіть день для призначення водія:", Markup.keyboard([...dayBtns, ["⬅️ Назад"]]).resize());
  }

  if (state?.action === "hd:select_day") {
    const { data } = state;
    const day = DAYS.find(d => DAY_NAMES_UK[d] === text);
    if (!day) return ctx.reply("Оберіть день зі списку.");
    setState(tid, "hd:select_shift", { ...data, day });
    return ctx.reply("Оберіть зміну:", Markup.keyboard([
      ["1 зміна (6–14)", "2 зміна (14–22)", "3 зміна (22–6)"],
      ["⬅️ Назад"],
    ]).resize());
  }

  if (state?.action === "hd:select_shift") {
    const { data } = state;
    const shiftMap: Record<string, Shift> = {
      "1 зміна (6–14)": "1", "2 зміна (14–22)": "2", "3 зміна (22–6)": "3",
    };
    const shift = shiftMap[text];
    if (!shift) return ctx.reply("Оберіть зміну зі списку.");
    setState(tid, "hd:select_driver", { ...data, shift });
    const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
    const btns = drivers.map(d => [d.name]);
    return ctx.reply(`Призначте водія на ${DAY_NAMES_UK[data.day as DayOfWeek]} ${text}:`,
      Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
  }

  if (state?.action === "hd:select_driver") {
    const { data } = state;
    const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
    const match = drivers.find(d => d.name === text);
    if (!match) return ctx.reply("Водія не знайдено.");
    // Get factory for this shift
    const entries = await db.select({ factoryId: scheduleEntriesTable.factoryId })
      .from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, data.weekId), eq(scheduleEntriesTable.dayOfWeek, data.day), eq(scheduleEntriesTable.shift, data.shift)))
      .limit(1);
    if (entries.length === 0) return ctx.reply("Немає записів для цієї зміни.", headDriverMenu());
    // Save assignment
    await db.delete(driverShiftAssignmentsTable).where(and(
      eq(driverShiftAssignmentsTable.weekId, data.weekId),
      eq(driverShiftAssignmentsTable.dayOfWeek, data.day),
      eq(driverShiftAssignmentsTable.shift, data.shift),
      eq(driverShiftAssignmentsTable.driverId, match.id),
    ));
    await db.insert(driverShiftAssignmentsTable).values({
      weekId: data.weekId, factoryId: entries[0]!.factoryId,
      dayOfWeek: data.day, shift: data.shift, driverId: match.id,
    });
    // Notify driver
    if (match.telegramId) {
      await notifyDriverOfAssignment(match.telegramId, data.weekId, data.day, data.shift, data.weekStart);
    }
    clearState(tid);
    return ctx.reply(`✅ *${match.name}* призначений на ${DAY_NAMES_UK[data.day as DayOfWeek]} ${SHIFT_SHORT[data.shift as Shift]}`, { parse_mode: "Markdown", ...headDriverMenu() });
  }

  // ── Attendance marking ────────────────────────────────────────────
  if (state?.action === "attendance:marking") {
    const { data } = state;
    const entries: { id: number; name: string }[] = data.entries;
    const current = entries[data.index];
    if (!current) return;

    if (text === "✅ Так, вийшов") {
      await db.update(scheduleEntriesTable).set({ status: "present" }).where(eq(scheduleEntriesTable.id, current.id));
    } else if (text === "❌ Ні, відсутній") {
      await db.update(scheduleEntriesTable).set({ status: "absent" }).where(eq(scheduleEntriesTable.id, current.id));
      data.absent.push(current.id);
    } else {
      return ctx.reply("Натисніть ✅ або ❌");
    }

    const nextIndex = data.index + 1;
    if (nextIndex >= entries.length) {
      clearState(tid);
      for (const entryId of data.absent) {
        await notifyAbsentWorker(entryId, data.dayName);
      }
      return ctx.reply(`✅ Явка відмічена!\nВідсутніх: ${data.absent.length} — надіслані автоматичні запити.`, driverMenu());
    }

    data.index = nextIndex;
    setState(tid, "attendance:marking", data);
    const next = entries[nextIndex]!;
    return ctx.reply(`👷 *${next.name}* — вийшов?`, { parse_mode: "Markdown" });
  }

  // ── Worker: absence — select shift ───────────────────────────────
  if (state?.action === "absence:select_shift") {
    const { data } = state;
    const entries: { id: number; day: DayOfWeek; shift: Shift }[] = data.entries;
    const match = entries.find(e => text.startsWith(DAY_UK[e.day]) && text.includes(e.shift === "1" ? "1" : e.shift === "2" ? "2" : "3"));
    if (!match) return ctx.reply("Оберіть зміну зі списку:");
    setState(tid, "absence:enter_reason", { ...data, entryId: match.id, day: match.day, shift: match.shift });
    return ctx.reply(
      `🙋 Зміна: *${DAY_UK[match.day]} ${SHIFT_SHORT[match.shift]}*\n\nВкажіть причину відсутності:`,
      { parse_mode: "Markdown", ...Markup.removeKeyboard() },
    );
  }

  if (state?.action === "absence:enter_reason") {
    const { data } = state;
    clearState(tid);
    // Save absence request
    const req = await db.insert(absenceRequestsTable).values({
      workerId: data.workerId,
      weekStart: data.weekStart,
      dayOfWeek: data.day,
      shift: data.shift,
      reason: text,
      status: "pending",
    }).returning({ id: absenceRequestsTable.id });
    // Find substitutes: available for this slot but not in schedule
    const inSchedule = await db.select({ workerId: scheduleEntriesTable.workerId })
      .from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, data.weekId), eq(scheduleEntriesTable.dayOfWeek, data.day), eq(scheduleEntriesTable.shift, data.shift)));
    const inScheduleIds = inSchedule.map(r => r.workerId);
    const substitutes = await db.select({ fullNameRaw: availabilityTable.fullNameRaw })
      .from(availabilityTable)
      .where(and(eq(availabilityTable.weekStart, data.weekStart), eq(availabilityTable.dayOfWeek, data.day), eq(availabilityTable.shift, data.shift)));
    // Match substitute names to workers
    const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
    const substituteCandidates = allWorkers.filter(w =>
      !inScheduleIds.includes(w.id) &&
      substitutes.some(s => s.fullNameRaw.toLowerCase().includes(w.fullName.toLowerCase().split(" ")[0]!.toLowerCase()))
    ).slice(0, 5);
    // Find worker name
    const workerRecord = await db.select({ fullName: workersTable.fullName }).from(workersTable).where(eq(workersTable.id, data.workerId));
    const workerName = workerRecord[0]?.fullName ?? "Невідомий";
    // Notify all admins
    const admins = await db.select().from(adminsTable);
    const requestId = req[0]!.id;
    const subList = substituteCandidates.length > 0
      ? `\n\n👥 *Можливі заміни:*\n${substituteCandidates.map((s, i) => `${i + 1}. ${s.fullName}`).join("\n")}`
      : "\n\n⚠️ Замін не знайдено";
    const adminMsg = `⚠️ *Зголошення відсутності*\n\n👷 *${workerName}*\n📅 ${DAY_UK[data.day as DayOfWeek]} — ${SHIFT_SHORT[data.shift as Shift]}\n📝 Причина: ${text}${subList}`;
    const subButtons = substituteCandidates.map(s =>
      [{ text: `🔄 Замінити на ${s.fullName}`, callback_data: `absence_sub_${requestId}_${s.id}` }]
    );
    const inlineButtons = [
      ...subButtons,
      [{ text: "✅ Прийняти (без заміни)", callback_data: `absence_approve_${requestId}` }],
      [{ text: "❌ Відхилити", callback_data: `absence_reject_${requestId}` }],
    ];
    for (const admin of admins) {
      try {
        await bot.telegram.sendMessage(admin.telegramId, adminMsg, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: inlineButtons },
        });
      } catch { /* ignore */ }
    }
    return ctx.reply(
      `✅ *Зголошення прийнято!*\n\nВи зголосили відсутність на ${DAY_UK[data.day as DayOfWeek]} (${SHIFT_SHORT[data.shift as Shift]}).\n\nАдміністратор отримав повідомлення і прийме рішення.`,
      { parse_mode: "Markdown", ...workerMenu() },
    );
  }

  // ── Fire worker ───────────────────────────────────────────────────
  if (state?.action === "fire_worker:select") {
    const { data } = state;
    const workers: { id: number; name: string; code: string | null }[] = data.workers;
    const match = workers.find(w => text.includes(w.name));
    if (!match) return ctx.reply("Оберіть працівника зі списку.");
    setState(tid, "fire_worker:confirm", { workerId: match.id, workerName: match.name });
    return ctx.reply(
      `⚠️ Ви дійсно хочете звільнити *${match.name}*?\n\nЦе позначить їх як звільненого і видалить з активних.`,
      { parse_mode: "Markdown", ...Markup.keyboard([["✅ Так, звільнити", "❌ Скасувати"]]).resize() },
    );
  }

  if (state?.action === "fire_worker:confirm") {
    const { data } = state;
    if (text === "✅ Так, звільнити") {
      await db.update(workersTable).set({ status: "fired", isActive: false, firedAt: new Date() }).where(eq(workersTable.id, data.workerId));
      clearState(tid);
      return ctx.reply(`✅ *${data.workerName}* звільнений(-а).`, { parse_mode: "Markdown", ...managementMenu() });
    }
    clearState(tid);
    return ctx.reply("Скасовано.", managementMenu());
  }

  // ── Report: select month ──────────────────────────────────────────
  if (state?.action === "report:select_month") {
    const { data } = state;
    const options: string[] = data.options;
    const monthLabel = (m: string) => new Date(`${m}-01`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
    const match = options.find(m => text.toLowerCase().includes(monthLabel(m).toLowerCase().split(" ")[0]!.toLowerCase()));
    const selected = match ?? options[0]!;
    const factories: string[] = data.factories;
    if (factories.length === 1) {
      setState(tid, "report:awaiting_photo", { ...data, month: selected, factory: factories[0]! });
      return ctx.reply(`📄 Надішліть *фото* рапорту за ${monthLabel(selected)} — ${factories[0]}:`, { parse_mode: "Markdown", ...Markup.removeKeyboard() });
    }
    setState(tid, "report:select_factory", { ...data, month: selected });
    const btns = factories.map(f => [f]);
    return ctx.reply("Оберіть фабрику:", Markup.keyboard([...btns, ["⬅️ Назад"]]).resize());
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
    // Try to match by code or name
    const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
    const byCode = allWorkers.find(w => w.workerCode === text.trim());
    const byName = allWorkers.find(w => w.fullName.toLowerCase().includes(text.toLowerCase()));
    const matched = byCode ?? byName;
    await db.insert(unplannedWorkersTable).values({
      weekId: data.weekId, driverId: data.driverId, factoryId: data.factoryId,
      dayOfWeek: data.dayOfWeek, shift: data.shift,
      workerName: matched?.fullName ?? text,
      workerId: matched?.id,
    });
    // Notify admins
    const admins = await db.select().from(adminsTable);
    const driver = await getDriver(tid);
    for (const admin of admins) {
      try {
        await bot.telegram.sendMessage(admin.telegramId,
          `➕ *Позаплановий працівник*\n\n👷 ${matched?.fullName ?? text}${matched ? ` (код ${matched.workerCode})` : " (не в базі)"}\n🚗 Водій: ${driver?.name ?? "—"}\n📅 ${DAY_UK[data.dayOfWeek as DayOfWeek]} ${SHIFT_SHORT[data.shift as Shift]}`,
          { parse_mode: "Markdown" });
      } catch { /* ignore */ }
    }
    return ctx.reply(
      `✅ *${matched?.fullName ?? text}* додано як позапланового.\n\nАдміністратор повідомлений.`,
      { parse_mode: "Markdown", ...driverMenu() },
    );
  }

  // ── Driver: report absent workers ─────────────────────────────────
  if (state?.action === "report_absent:select") {
    const { data } = state;
    const workers: { id: number; name: string | null }[] = data.workers;
    if (text === "✅ Підтвердити відсутніх") {
      if (data.selected.length === 0) {
        clearState(tid);
        return ctx.reply("Нікого не обрано. Скасовано.", driverMenu());
      }
      clearState(tid);
      const absentIds: number[] = data.selected;
      for (const entryId of absentIds) {
        await db.update(scheduleEntriesTable).set({ status: "absent" }).where(eq(scheduleEntriesTable.id, entryId));
        await notifyAbsentWorker(entryId, data.dayName);
      }
      // Notify admins
      const admins = await db.select().from(adminsTable);
      const absentNames = workers.filter(w => absentIds.includes(w.id)).map(w => w.name).join(", ");
      const driver = await getDriver(tid);
      for (const admin of admins) {
        try {
          await bot.telegram.sendMessage(admin.telegramId,
            `⚠️ *Не прийшли до машини*\n\n🚗 Водій: ${driver?.name ?? "—"}\n📅 ${DAY_UK[data.dayName as DayOfWeek]}\n\nВідсутні: ${absentNames}`,
            { parse_mode: "Markdown" });
        } catch { /* ignore */ }
      }
      return ctx.reply(`✅ Відсутніх відмічено: ${absentIds.length}\nАдміністратор повідомлений.`, driverMenu());
    }
    // Toggle selection
    const match = workers.find(w => text.includes(w.name ?? ""));
    if (match) {
      const idx = (data.selected as number[]).indexOf(match.id);
      if (idx === -1) { data.selected.push(match.id); }
      else { data.selected.splice(idx, 1); }
      setState(tid, "report_absent:select", data);
      const selected: number[] = data.selected;
      const selectedNames = workers.filter(w => selected.includes(w.id)).map(w => `❌ ${w.name}`).join("\n") || "Нікого не обрано";
      return ctx.reply(`Обрані відсутні:\n${selectedNames}\n\nПродовжуйте обирати або натисніть «✅ Підтвердити відсутніх»`);
    }
    return;
  }

  return;
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
  await ctx.reply("⏳ Завантажую рапорт на Google Drive...");
  try {
    const photo = ctx.message.photo.at(-1)!;
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const resp = await fetch(fileLink.href);
    const buf = Buffer.from(await resp.arrayBuffer());
    const link = await uploadReportPhoto(
      data.factory, data.workerName, data.month, buf, "image/jpeg",
    );
    if (link) {
      return ctx.reply(`✅ Рапорт збережено!\n${link}`, workerMenu());
    } else {
      return ctx.reply("❌ Помилка збереження. Спробуйте ще раз.", workerMenu());
    }
  } catch (e) {
    logger.error({ err: e }, "Report upload error");
    return ctx.reply("❌ Помилка завантаження.", workerMenu());
  }
});

// ═══════════════════════════════════════════════════════════════════
// CALLBACK QUERY HANDLERS — absence approval
// ═══════════════════════════════════════════════════════════════════

bot.action(/^absence_approve_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const requestId = parseInt(ctx.match[1]!, 10);
  const req = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, requestId));
  if (!req[0]) return ctx.editMessageText("❌ Запит не знайдено.");
  const r = req[0];
  await db.update(absenceRequestsTable).set({ status: "accepted" }).where(eq(absenceRequestsTable.id, requestId));
  // Mark schedule entry as absent
  const entries = await db.select({ id: scheduleEntriesTable.id })
    .from(scheduleEntriesTable)
    .where(and(
      eq(scheduleEntriesTable.workerId, r.workerId),
      eq(scheduleEntriesTable.dayOfWeek, r.dayOfWeek),
      eq(scheduleEntriesTable.shift, r.shift),
    ));
  if (entries[0]) {
    await db.update(scheduleEntriesTable).set({ status: "absent", absenceReason: r.reason ?? undefined }).where(eq(scheduleEntriesTable.id, entries[0].id));
  }
  // Notify worker
  const workerRecord = await db.select().from(workersTable).where(eq(workersTable.id, r.workerId));
  if (workerRecord[0]?.telegramId) {
    try {
      await bot.telegram.sendMessage(workerRecord[0].telegramId,
        `✅ Ваше зголошення відсутності на *${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}* прийнято.`,
        { parse_mode: "Markdown" });
    } catch { /* ignore */ }
  }
  return ctx.editMessageText(`✅ Відсутність прийнята (без заміни)\n👷 ${workerRecord[0]?.fullName ?? "—"}\n📅 ${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}`);
});

bot.action(/^absence_sub_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const [requestId, substituteId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
  const req = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, requestId));
  if (!req[0]) return ctx.editMessageText("❌ Запит не знайдено.");
  const r = req[0];
  const sub = await db.select().from(workersTable).where(eq(workersTable.id, substituteId));
  if (!sub[0]) return ctx.editMessageText("❌ Замінника не знайдено.");
  // Update absence request
  await db.update(absenceRequestsTable).set({ status: "substituted", substituteWorkerId: substituteId }).where(eq(absenceRequestsTable.id, requestId));
  // Find schedule entry and reassign
  const entries = await db.select({ id: scheduleEntriesTable.id })
    .from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.workerId, r.workerId), eq(scheduleEntriesTable.dayOfWeek, r.dayOfWeek), eq(scheduleEntriesTable.shift, r.shift)));
  if (entries[0]) {
    await db.update(scheduleEntriesTable).set({ workerId: substituteId }).where(eq(scheduleEntriesTable.id, entries[0].id));
  }
  const workerRecord = await db.select().from(workersTable).where(eq(workersTable.id, r.workerId));
  // Notify original worker
  if (workerRecord[0]?.telegramId) {
    try {
      await bot.telegram.sendMessage(workerRecord[0].telegramId,
        `✅ Вашу зміну *${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}* буде замінено на *${sub[0].fullName}*.`,
        { parse_mode: "Markdown" });
    } catch { /* ignore */ }
  }
  // Notify substitute worker
  if (sub[0].telegramId) {
    try {
      await bot.telegram.sendMessage(sub[0].telegramId,
        `📋 *Нове призначення!*\n\nВас призначено на заміну.\n📅 ${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}\nТиждень: ${formatWeekStart(r.weekStart)}`,
        { parse_mode: "Markdown" });
    } catch { /* ignore */ }
  }
  return ctx.editMessageText(`✅ Замінено: *${workerRecord[0]?.fullName ?? "—"}* → *${sub[0].fullName}*\n📅 ${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}`, { parse_mode: "Markdown" });
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
    try {
      await bot.telegram.sendMessage(workerRecord[0].telegramId,
        `❌ Ваше зголошення відсутності на *${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}* відхилено.\n\nВам необхідно вийти на зміну або зв'язатись з адміністратором.`,
        { parse_mode: "Markdown" });
    } catch { /* ignore */ }
  }
  return ctx.editMessageText(`❌ Відхилено\n👷 ${workerRecord[0]?.fullName ?? "—"}\n📅 ${DAY_UK[r.dayOfWeek]} ${SHIFT_SHORT[r.shift]}`);
});

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

async function askOrderForDay(ctx: Context, tid: string, factoryName: string, weekStart: string, dayIndex: number) {
  const day = DAYS[dayIndex]!;
  // Load existing order if any
  const existing = await db.select().from(factoryOrdersTable).where(and(
    eq(factoryOrdersTable.weekStart, weekStart),
    eq(factoryOrdersTable.dayOfWeek, day),
  ));
  const s1 = existing.find(e => e.shift === "1")?.workersNeeded ?? 0;
  const s2 = existing.find(e => e.shift === "2")?.workersNeeded ?? 0;
  const s3 = existing.find(e => e.shift === "3")?.workersNeeded ?? 0;
  return ctx.reply(
    `🏭 *${factoryName}* — ${formatWeekStart(weekStart)}\n\n*${DAY_NAMES_UK[day]}* (день ${dayIndex + 1}/7)\n\nПоточні значення: \`${s1} ${s2} ${s3}\`\n\nВведіть кількість для кожної зміни через пробіл:\n1зміна(6-14) 2зміна(14-22) 3зміна(22-6)\n\nПриклад: \`8 12 5\`\nВведіть \`0 0 0\` якщо цей день не працює`,
    { parse_mode: "Markdown", ...Markup.keyboard([["0 0 0"], ["⬅️ Назад"]]).resize() },
  );
}

async function showWorkerSchedule(ctx: Context, workerId: number, weekId: number, weekStart: string) {
  const entries = await db
    .select({
      day: scheduleEntriesTable.dayOfWeek,
      shift: scheduleEntriesTable.shift,
      factoryName: factoriesTable.name,
      factoryAddress: factoriesTable.address,
    })
    .from(scheduleEntriesTable)
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.workerId, workerId)));

  if (entries.length === 0) {
    return ctx.reply(`📭 На тиждень ${formatWeekStart(weekStart)} у вас немає змін.`, workerMenu());
  }

  const byDay: Record<string, typeof entries[0]> = {};
  entries.forEach(e => { byDay[e.day] = e; });

  let msg = `📅 *Ваш графік — ${formatWeekStart(weekStart)}*\n\n`;
  for (const day of DAYS) {
    const e = byDay[day];
    if (e) {
      msg += `${DAY_UK[day]}: ${SHIFT_SHORT[e.shift as Shift]} — 🏭 ${e.factoryName}\n`;
      if (e.factoryAddress) msg += `   📍 ${e.factoryAddress}\n`;
    } else {
      msg += `${DAY_UK[day]}: —\n`;
    }
  }
  return ctx.reply(msg, { parse_mode: "Markdown", ...workerMenu() });
}

async function showFullWeekSchedule(ctx: Context, weekId: number, weekStart: string) {
  const entries = await db
    .select({
      day: scheduleEntriesTable.dayOfWeek,
      shift: scheduleEntriesTable.shift,
      workerName: workersTable.fullName,
      factoryName: factoriesTable.name,
    })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(eq(scheduleEntriesTable.weekId, weekId));

  if (entries.length === 0) return ctx.reply("Графік порожній.");

  let msg = `📅 *Графік — ${formatWeekStart(weekStart)}*\n\n`;
  for (const day of DAYS) {
    const dayEntries = entries.filter(e => e.day === day);
    if (dayEntries.length === 0) continue;
    msg += `*${DAY_NAMES_UK[day]}:*\n`;
    for (const shift of ["1", "2", "3"] as Shift[]) {
      const shifted = dayEntries.filter(e => e.shift === shift);
      if (shifted.length > 0) {
        msg += `  ${SHIFT_SHORT[shift]} (${shifted.length} ос.):\n`;
        shifted.forEach(e => { msg += `    • ${e.workerName}\n`; });
      }
    }
  }
  return ctx.reply(msg, { parse_mode: "Markdown" });
}

async function showDriverShift(ctx: Context, driverId: number, weekStart: string, day: DayOfWeek) {
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply("Немає активного графіку.", driverMenu());

  const assignments = await db.select({ shift: driverShiftAssignmentsTable.shift })
    .from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id), eq(driverShiftAssignmentsTable.dayOfWeek, day), eq(driverShiftAssignmentsTable.driverId, driverId)));

  if (assignments.length === 0) return ctx.reply(`📭 На ${DAY_NAMES_UK[day]} у вас немає призначень.`, driverMenu());

  let msg = `📍 *${DAY_NAMES_UK[day]}* — Ваші зміни:\n\n`;
  for (const a of assignments) {
    const workers = await db
      .select({ name: workersTable.fullName, status: scheduleEntriesTable.status })
      .from(scheduleEntriesTable)
      .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
      .where(and(eq(scheduleEntriesTable.weekId, weeks[0]!.id), eq(scheduleEntriesTable.dayOfWeek, day), eq(scheduleEntriesTable.shift, a.shift)));
    msg += `*${SHIFT_SHORT[a.shift as Shift]}*\n`;
    workers.forEach((w, i) => {
      const statusIcon = w.status === "present" ? "✅" : w.status === "absent" ? "❌" : "⏳";
      msg += `  ${i + 1}. ${statusIcon} ${w.name}\n`;
    });
    msg += "\n";
  }
  return ctx.reply(msg, { parse_mode: "Markdown", ...driverMenu() });
}

async function showDriverWeek(ctx: Context, driverId: number, weekId: number, weekStart: string) {
  const assignments = await db
    .select({ day: driverShiftAssignmentsTable.dayOfWeek, shift: driverShiftAssignmentsTable.shift, factoryName: factoriesTable.name })
    .from(driverShiftAssignmentsTable)
    .leftJoin(factoriesTable, eq(driverShiftAssignmentsTable.factoryId, factoriesTable.id))
    .where(and(eq(driverShiftAssignmentsTable.weekId, weekId), eq(driverShiftAssignmentsTable.driverId, driverId)));

  if (assignments.length === 0) return ctx.reply(`📭 На тиждень ${formatWeekStart(weekStart)} у вас немає призначень.`, driverMenu());

  let msg = `🚗 *Ваш графік — ${formatWeekStart(weekStart)}*\n\n`;
  for (const day of DAYS) {
    const dayA = assignments.filter(a => a.day === day);
    if (dayA.length > 0) {
      msg += `${DAY_UK[day]}: `;
      msg += dayA.map(a => `${SHIFT_SHORT[a.shift as Shift]} 🏭 ${a.factoryName}`).join(", ");
      msg += "\n";
    }
  }
  return ctx.reply(msg, { parse_mode: "Markdown", ...driverMenu() });
}

async function sendScheduleToAllWorkers(weekId: number, weekStart: string) {
  const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
  let notified = 0, skipped = 0;
  for (const worker of workers) {
    if (!worker.telegramId) { skipped++; continue; }
    const entries = await db
      .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, factoryName: factoriesTable.name, factoryAddress: factoriesTable.address })
      .from(scheduleEntriesTable)
      .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
      .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.workerId, worker.id)));
    if (entries.length === 0) { skipped++; continue; }
    let msg = `📅 *Ваш графік на тиждень ${formatWeekStart(weekStart)}*\n\n`;
    for (const day of DAYS) {
      const e = entries.find(x => x.day === day);
      if (e) msg += `${DAY_UK[day]}: ${SHIFT_SHORT[e.shift as Shift]} — ${e.factoryName}\n`;
      else msg += `${DAY_UK[day]}: вихідний\n`;
    }
    try {
      await bot.telegram.sendMessage(worker.telegramId, msg, { parse_mode: "Markdown" });
      notified++;
    } catch { skipped++; }
  }
  return { notified, skipped };
}

async function sendScheduleToHeadDriver(weekId: number, weekStart: string) {
  const headDrivers = await db.select().from(driversTable).where(and(eq(driversTable.isHeadDriver, true), eq(driversTable.isActive, true)));
  if (headDrivers.length === 0) return "❌ Головний водій не призначений";
  const hd = headDrivers[0]!;
  if (!hd.telegramId) return "❌ Немає Telegram у головного водія";

  const entries = await db
    .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, workerName: workersTable.fullName, factoryName: factoriesTable.name })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(eq(scheduleEntriesTable.weekId, weekId));

  let msg = `📋 *Повний графік — ${formatWeekStart(weekStart)}*\n*Призначте водіїв через меню "📋 Призначити водіїв"*\n\n`;
  for (const day of DAYS) {
    const dayEntries = entries.filter(e => e.day === day);
    if (dayEntries.length === 0) continue;
    msg += `*${DAY_NAMES_UK[day]}:*\n`;
    for (const shift of ["1", "2", "3"] as Shift[]) {
      const shifted = dayEntries.filter(e => e.shift === shift);
      if (shifted.length > 0) {
        msg += `  ${SHIFT_SHORT[shift]} — ${shifted[0]!.factoryName} (${shifted.length} ос.):\n`;
        shifted.forEach(e => { msg += `    • ${e.workerName}\n`; });
      }
    }
  }

  try {
    await bot.telegram.sendMessage(hd.telegramId, msg, { parse_mode: "Markdown" });
    return `✅ надіслано ${hd.name}`;
  } catch {
    return "❌ помилка надсилання";
  }
}

async function notifyDriverOfAssignment(driverTid: string, weekId: number, day: DayOfWeek, shift: Shift, weekStart: string) {
  const workers = await db
    .select({ name: workersTable.fullName })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.dayOfWeek, day), eq(scheduleEntriesTable.shift, shift)));

  let msg = `🚗 *Нове призначення!*\n\n*${DAY_NAMES_UK[day]}* ${SHIFT_SHORT[shift]}\nТиждень: ${formatWeekStart(weekStart)}\n\n*Список (${workers.length} ос.):*\n`;
  workers.forEach((w, i) => { msg += `${i + 1}. ${w.name}\n`; });

  try {
    await bot.telegram.sendMessage(driverTid, msg, { parse_mode: "Markdown" });
  } catch (e) {
    logger.error({ err: e }, "Error notifying driver");
  }
}

async function notifyAbsentWorker(entryId: number, day: DayOfWeek) {
  const entries = await db
    .select({ telegramId: workersTable.telegramId, name: workersTable.fullName })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(eq(scheduleEntriesTable.id, entryId));
  if (!entries[0]?.telegramId) return;
  try {
    await bot.telegram.sendMessage(entries[0].telegramId,
      `⚠️ *${entries[0].name}*, сьогодні (${DAY_NAMES_UK[day]}) ви були відмічені як відсутні.\n\nБудь ласка, поясніть причину вашої відсутності:`,
      { parse_mode: "Markdown" });
  } catch (e) {
    logger.error({ err: e }, "Error notifying absent worker");
  }
}

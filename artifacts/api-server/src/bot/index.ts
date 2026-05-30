import { Telegraf, Markup, type Context } from "telegraf";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, factoriesTable, factoryOrdersTable,
  scheduleWeeksTable, scheduleEntriesTable, driverShiftAssignmentsTable, adminsTable,
  type DayOfWeek, type Shift, type Worker, type Driver,
} from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  readAvailabilityFromSheets, syncAvailabilityToDb, getWorkersWhoHaventSubmitted,
  DAY_NAMES_UK, DAYS, SHIFT_LABELS,
} from "../services/sheets";
import {
  generateSchedule, formatWeekStart, getNextMonday, getCurrentMonday,
} from "../services/scheduleGenerator";

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
  ["ℹ️ Моя інформація"],
]).resize();

const headDriverMenu = () => Markup.keyboard([
  ["📋 Призначити водіїв", "📅 Графік тижня"],
  ["👥 Мій список водіїв"],
]).resize();

const driverMenu = () => Markup.keyboard([
  ["📍 Моя зміна сьогодні", "📅 Мій графік"],
  ["✅ Відмітити явку"],
]).resize();

const managementMenu = () => Markup.keyboard([
  ["➕ Додати працівника", "📋 Список працівників"],
  ["🔗 Прив'язати Telegram", "🚗 Водії"],
  ["🏭 Фабрики", "⬅️ Назад"],
]).resize();

// ─── /start ──────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const tid = String(ctx.from.id);
  const name = ctx.from.first_name;
  clearState(tid);

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
    `👋 Привіт, *${name}*!\n\nВи не зареєстровані. Зверніться до адміністратора.\n\nЯкщо ви адмін — надішліть /adminsetup`,
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
  return ctx.reply("Оберіть дію:", Markup.keyboard([
    ["📨 Нагадати заповнити таблицю"],
    ["📢 Розіслати затверджений графік"],
    ["⬅️ Назад"],
  ]).resize());
});

bot.hears("📨 Нагадати заповнити таблицю", async (ctx) => {
  const tid = String(ctx.from.id);
  if (!await isAdmin(tid)) return;
  setState(tid, "remind:select_week", {});
  const next = getNextMonday();
  return ctx.reply("Введіть тиждень для нагадування (РРРР-ММ-ДД або 'наступний'):",
    Markup.keyboard([[`${getNextMonday()}`], ["⬅️ Назад"]]).resize());
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
  return ctx.reply(`👷 *${worker.fullName}*\n🆔 Telegram: \`${ctx.from.id}\``, { parse_mode: "Markdown" });
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
    await db.insert(workersTable).values({ fullName: text });
    clearState(tid);
    return ctx.reply(`✅ Працівник *${text}* доданий!\n\nТепер прив'яжіть їх Telegram через "🔗 Прив'язати Telegram".`,
      { parse_mode: "Markdown", ...managementMenu() });
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
      return ctx.reply(`✅ Графік для тижня ${formatWeekStart(data.weekStart)} затверджено!\n\nТепер розішліть його через "📢 Розсилки → 📢 Розіслати затверджений графік"`, adminMenu());
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
      // Notify absent workers
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

  return;
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

import { Telegraf, Markup, Context } from "telegraf";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, factoriesTable, schedulesTable, adminsTable,
  type Worker, type Driver, type Factory
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "../lib/logger";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const bot = new Telegraf(token);

// ─── Helpers ───────────────────────────────────────────────────────────────

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0]!;
}

function formatDate(d: string): string {
  const date = new Date(d + "T00:00:00");
  return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

async function isAdmin(telegramId: string): Promise<boolean> {
  const admins = await db.select().from(adminsTable).where(eq(adminsTable.telegramId, telegramId));
  return admins.length > 0;
}

async function getWorkerByTelegramId(telegramId: string): Promise<Worker | undefined> {
  const rows = await db.select().from(workersTable).where(eq(workersTable.telegramId, telegramId));
  return rows[0];
}

async function getDriverByTelegramId(telegramId: string): Promise<Driver | undefined> {
  const rows = await db.select().from(driversTable).where(eq(driversTable.telegramId, telegramId));
  return rows[0];
}

// ─── State for multi-step flows ─────────────────────────────────────────────
const pendingActions: Map<string, { action: string; data: Record<string, string> }> = new Map();

// ─── /start ─────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  const name = ctx.from.first_name;

  const adminCheck = await isAdmin(telegramId);
  const worker = await getWorkerByTelegramId(telegramId);
  const driver = await getDriverByTelegramId(telegramId);

  if (adminCheck) {
    await ctx.reply(
      `👋 Welcome back, *${name}*! You are logged in as *Admin*.\n\nUse the menu below to manage the agency:`,
      { parse_mode: "Markdown", ...adminMainMenu() }
    );
  } else if (worker) {
    await ctx.reply(
      `👷 Welcome back, *${worker.name}*!\n\nUse the buttons below to view your schedule:`,
      { parse_mode: "Markdown", ...workerMainMenu() }
    );
  } else if (driver) {
    await ctx.reply(
      `🚗 Welcome back, *${driver.name}*!\n\nUse the buttons below to manage your route:`,
      { parse_mode: "Markdown", ...driverMainMenu() }
    );
  } else {
    await ctx.reply(
      `👋 Hello *${name}*! Welcome to the Employment Agency Bot.\n\nYou are not registered yet. Please contact your admin to be added to the system.\n\nIf you are an admin, use /adminsetup to register yourself.`,
      { parse_mode: "Markdown" }
    );
  }
});

// ─── Menus ─────────────────────────────────────────────────────────────────

function adminMainMenu() {
  return Markup.keyboard([
    ["👷 Workers", "🚗 Drivers"],
    ["🏭 Factories", "📅 Schedules"],
    ["📊 Today's Summary", "📋 Reports"],
  ]).resize();
}

function workerMainMenu() {
  return Markup.keyboard([
    ["📅 My Schedule Today", "📆 My Schedule This Week"],
    ["🏭 My Factory Info", "🚗 My Driver Info"],
  ]).resize();
}

function driverMainMenu() {
  return Markup.keyboard([
    ["📍 My Route Today", "📆 My Route This Week"],
    ["👥 My Workers List", "✅ Mark Pickup Done"],
  ]).resize();
}

// ─── Admin Setup ─────────────────────────────────────────────────────────────

bot.command("adminsetup", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const existing = await isAdmin(telegramId);
  if (existing) {
    await ctx.reply("✅ You are already registered as an admin.");
    return;
  }
  const existingAdmins = await db.select().from(adminsTable);
  if (existingAdmins.length > 0) {
    await ctx.reply("❌ Admin setup is not available. Contact the existing admin to add you.");
    return;
  }
  await db.insert(adminsTable).values({ telegramId, name: ctx.from.first_name });
  await ctx.reply(
    `✅ You have been registered as the first admin!\n\nWelcome, *${ctx.from.first_name}*!`,
    { parse_mode: "Markdown", ...adminMainMenu() }
  );
});

// ─── Admin: Workers menu ──────────────────────────────────────────────────

bot.hears("👷 Workers", async (ctx) => {
  const telegramId = String(ctx.from.id);
  if (!await isAdmin(telegramId)) return;
  await ctx.reply("👷 Worker Management:", Markup.keyboard([
    ["➕ Add Worker", "📋 List Workers"],
    ["🔗 Link Worker Telegram", "❌ Deactivate Worker"],
    ["⬅️ Back to Main Menu"],
  ]).resize());
});

bot.hears("➕ Add Worker", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.set(String(ctx.from.id), { action: "add_worker", data: {} });
  await ctx.reply("Enter the worker's full name:", Markup.removeKeyboard());
});

bot.hears("📋 List Workers", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
  if (workers.length === 0) {
    await ctx.reply("No active workers found.", adminMainMenu());
    return;
  }
  const list = workers.map((w, i) =>
    `${i + 1}. *${w.name}*${w.phone ? ` — 📞 ${w.phone}` : ""}${w.telegramId ? " ✅" : " ⚠️ (no Telegram)"}`
  ).join("\n");
  await ctx.reply(`👷 *Active Workers* (${workers.length}):\n\n${list}\n\n✅ = linked to Telegram  ⚠️ = not linked`, {
    parse_mode: "Markdown",
    ...Markup.keyboard([["⬅️ Back to Workers", "⬅️ Back to Main Menu"]]).resize()
  });
});

bot.hears("🔗 Link Worker Telegram", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.set(String(ctx.from.id), { action: "link_worker_telegram_name", data: {} });
  await ctx.reply("Enter the worker's name to link their Telegram account:", Markup.removeKeyboard());
});

bot.hears("❌ Deactivate Worker", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
  if (workers.length === 0) { await ctx.reply("No active workers."); return; }
  const buttons = workers.map(w => [w.name]);
  await ctx.reply("Select worker to deactivate:", Markup.keyboard([...buttons, ["⬅️ Back to Workers"]]).resize());
  pendingActions.set(String(ctx.from.id), { action: "deactivate_worker_select", data: {} });
});

// ─── Admin: Drivers menu ──────────────────────────────────────────────────

bot.hears("🚗 Drivers", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  await ctx.reply("🚗 Driver Management:", Markup.keyboard([
    ["➕ Add Driver", "📋 List Drivers"],
    ["🔗 Link Driver Telegram", "❌ Deactivate Driver"],
    ["⬅️ Back to Main Menu"],
  ]).resize());
});

bot.hears("➕ Add Driver", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.set(String(ctx.from.id), { action: "add_driver", data: {} });
  await ctx.reply("Enter the driver's full name:", Markup.removeKeyboard());
});

bot.hears("📋 List Drivers", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
  if (drivers.length === 0) { await ctx.reply("No active drivers.", adminMainMenu()); return; }
  const list = drivers.map((d, i) =>
    `${i + 1}. *${d.name}*${d.vehicle ? ` (${d.vehicle})` : ""}${d.telegramId ? " ✅" : " ⚠️"}`
  ).join("\n");
  await ctx.reply(`🚗 *Active Drivers* (${drivers.length}):\n\n${list}`, {
    parse_mode: "Markdown",
    ...Markup.keyboard([["⬅️ Back to Drivers", "⬅️ Back to Main Menu"]]).resize()
  });
});

bot.hears("🔗 Link Driver Telegram", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.set(String(ctx.from.id), { action: "link_driver_telegram_name", data: {} });
  await ctx.reply("Enter the driver's name to link their Telegram account:", Markup.removeKeyboard());
});

// ─── Admin: Factories menu ────────────────────────────────────────────────

bot.hears("🏭 Factories", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  await ctx.reply("🏭 Factory Management:", Markup.keyboard([
    ["➕ Add Factory", "📋 List Factories"],
    ["⬅️ Back to Main Menu"],
  ]).resize());
});

bot.hears("➕ Add Factory", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.set(String(ctx.from.id), { action: "add_factory", data: {} });
  await ctx.reply("Enter the factory name:", Markup.removeKeyboard());
});

bot.hears("📋 List Factories", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const factories = await db.select().from(factoriesTable);
  if (factories.length === 0) { await ctx.reply("No factories found.", adminMainMenu()); return; }
  const list = factories.map((f, i) =>
    `${i + 1}. *${f.name}*${f.address ? `\n   📍 ${f.address}` : ""}`
  ).join("\n");
  await ctx.reply(`🏭 *Factories* (${factories.length}):\n\n${list}`, {
    parse_mode: "Markdown",
    ...Markup.keyboard([["⬅️ Back to Factories", "⬅️ Back to Main Menu"]]).resize()
  });
});

// ─── Admin: Schedules menu ────────────────────────────────────────────────

bot.hears("📅 Schedules", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  await ctx.reply("📅 Schedule Management:", Markup.keyboard([
    ["➕ Add Schedule", "📋 Today's Schedules"],
    ["🗓 Schedule by Date", "🗑 Delete Schedule"],
    ["📢 Notify Workers Today", "📢 Notify Drivers Today"],
    ["⬅️ Back to Main Menu"],
  ]).resize());
});

bot.hears("➕ Add Schedule", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
  if (workers.length === 0) { await ctx.reply("No active workers. Add workers first."); return; }
  const buttons = workers.map(w => [w.name]);
  pendingActions.set(String(ctx.from.id), { action: "schedule_select_worker", data: {} });
  await ctx.reply("Select a worker to schedule:", Markup.keyboard([...buttons, ["⬅️ Back"]]).resize());
});

bot.hears("📋 Today's Schedules", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  await showScheduleForDate(ctx, getTodayDate());
});

bot.hears("🗓 Schedule by Date", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.set(String(ctx.from.id), { action: "schedule_by_date", data: {} });
  await ctx.reply("Enter date (YYYY-MM-DD):", Markup.removeKeyboard());
});

bot.hears("🗑 Delete Schedule", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.set(String(ctx.from.id), { action: "delete_schedule_date", data: {} });
  await ctx.reply("Enter the date of the schedule to delete (YYYY-MM-DD):", Markup.removeKeyboard());
});

// ─── Admin: Notify Workers ────────────────────────────────────────────────

bot.hears("📢 Notify Workers Today", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  await notifyWorkersForDate(ctx, getTodayDate());
});

bot.hears("📢 Notify Drivers Today", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  await notifyDriversForDate(ctx, getTodayDate());
});

// ─── Admin: Reports / Summary ─────────────────────────────────────────────

bot.hears("📊 Today's Summary", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  const today = getTodayDate();
  const schedules = await db
    .select({
      workerName: workersTable.name,
      factoryName: factoriesTable.name,
      driverName: driversTable.name,
      shiftStart: schedulesTable.shiftStart,
      shiftEnd: schedulesTable.shiftEnd,
      status: schedulesTable.status,
    })
    .from(schedulesTable)
    .leftJoin(workersTable, eq(schedulesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(schedulesTable.factoryId, factoriesTable.id))
    .leftJoin(driversTable, eq(schedulesTable.driverId, driversTable.id))
    .where(eq(schedulesTable.scheduleDate, today));

  if (schedules.length === 0) {
    await ctx.reply(`📊 No schedules for today (${formatDate(today)}).`, adminMainMenu());
    return;
  }

  const grouped: Record<string, typeof schedules> = {};
  for (const s of schedules) {
    const key = s.factoryName ?? "Unknown Factory";
    if (!grouped[key]) grouped[key] = [];
    grouped[key]!.push(s);
  }

  let msg = `📊 *Today's Summary — ${formatDate(today)}*\n*Total Workers: ${schedules.length}*\n\n`;
  for (const [factory, rows] of Object.entries(grouped)) {
    msg += `🏭 *${factory}* (${rows.length} workers)\n`;
    for (const r of rows) {
      msg += `  • ${r.workerName} — ${r.shiftStart}–${r.shiftEnd}`;
      if (r.driverName) msg += ` 🚗 ${r.driverName}`;
      msg += "\n";
    }
    msg += "\n";
  }

  await ctx.reply(msg, { parse_mode: "Markdown", ...adminMainMenu() });
});

bot.hears("📋 Reports", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.set(String(ctx.from.id), { action: "report_date", data: {} });
  await ctx.reply("Enter date for report (YYYY-MM-DD):", Markup.removeKeyboard());
});

// ─── Worker: My Schedule ─────────────────────────────────────────────────

bot.hears("📅 My Schedule Today", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const worker = await getWorkerByTelegramId(telegramId);
  if (!worker) { await ctx.reply("❌ You are not registered as a worker. Contact your admin."); return; }
  await showWorkerSchedule(ctx, worker.id, getTodayDate(), 1);
});

bot.hears("📆 My Schedule This Week", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const worker = await getWorkerByTelegramId(telegramId);
  if (!worker) { await ctx.reply("❌ You are not registered as a worker."); return; }
  const today = new Date();
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d.toISOString().split("T")[0]!);
  }
  let msg = `📆 *Your Schedule — Next 7 Days*\n\n`;
  let found = false;
  for (const day of days) {
    const rows = await db
      .select({
        factoryName: factoriesTable.name,
        factoryAddress: factoriesTable.address,
        driverName: driversTable.name,
        shiftStart: schedulesTable.shiftStart,
        shiftEnd: schedulesTable.shiftEnd,
      })
      .from(schedulesTable)
      .leftJoin(factoriesTable, eq(schedulesTable.factoryId, factoriesTable.id))
      .leftJoin(driversTable, eq(schedulesTable.driverId, driversTable.id))
      .where(and(eq(schedulesTable.workerId, worker.id), eq(schedulesTable.scheduleDate, day)));
    if (rows.length > 0) {
      found = true;
      msg += `📅 *${formatDate(day)}*\n`;
      for (const r of rows) {
        msg += `  🏭 ${r.factoryName ?? "TBD"}\n`;
        if (r.factoryAddress) msg += `  📍 ${r.factoryAddress}\n`;
        msg += `  🕐 ${r.shiftStart} – ${r.shiftEnd}\n`;
        if (r.driverName) msg += `  🚗 Driver: ${r.driverName}\n`;
      }
      msg += "\n";
    }
  }
  if (!found) msg += "No schedules found for the next 7 days.";
  await ctx.reply(msg, { parse_mode: "Markdown", ...workerMainMenu() });
});

bot.hears("🏭 My Factory Info", async (ctx) => {
  const worker = await getWorkerByTelegramId(String(ctx.from.id));
  if (!worker) return;
  const rows = await db
    .select({ factoryName: factoriesTable.name, factoryAddress: factoriesTable.address, contactPerson: factoriesTable.contactPerson, shiftStart: schedulesTable.shiftStart, shiftEnd: schedulesTable.shiftEnd })
    .from(schedulesTable)
    .leftJoin(factoriesTable, eq(schedulesTable.factoryId, factoriesTable.id))
    .where(and(eq(schedulesTable.workerId, worker.id), eq(schedulesTable.scheduleDate, getTodayDate())));
  if (rows.length === 0) { await ctx.reply("No factory assignment for today.", workerMainMenu()); return; }
  const r = rows[0]!;
  await ctx.reply(
    `🏭 *Today's Factory*\n\n*Name:* ${r.factoryName}\n*Address:* ${r.factoryAddress ?? "N/A"}\n*Contact:* ${r.contactPerson ?? "N/A"}\n*Shift:* ${r.shiftStart} – ${r.shiftEnd}`,
    { parse_mode: "Markdown", ...workerMainMenu() }
  );
});

bot.hears("🚗 My Driver Info", async (ctx) => {
  const worker = await getWorkerByTelegramId(String(ctx.from.id));
  if (!worker) return;
  const rows = await db
    .select({ driverName: driversTable.name, driverPhone: driversTable.phone, vehicle: driversTable.vehicle })
    .from(schedulesTable)
    .leftJoin(driversTable, eq(schedulesTable.driverId, driversTable.id))
    .where(and(eq(schedulesTable.workerId, worker.id), eq(schedulesTable.scheduleDate, getTodayDate())));
  if (rows.length === 0 || !rows[0]?.driverName) {
    await ctx.reply("No driver assigned for today.", workerMainMenu());
    return;
  }
  const r = rows[0]!;
  await ctx.reply(
    `🚗 *Today's Driver*\n\n*Name:* ${r.driverName}\n*Phone:* ${r.driverPhone ?? "N/A"}\n*Vehicle:* ${r.vehicle ?? "N/A"}`,
    { parse_mode: "Markdown", ...workerMainMenu() }
  );
});

// ─── Driver: My Route ────────────────────────────────────────────────────

bot.hears("📍 My Route Today", async (ctx) => {
  const driver = await getDriverByTelegramId(String(ctx.from.id));
  if (!driver) { await ctx.reply("❌ You are not registered as a driver. Contact your admin."); return; }
  await showDriverRoute(ctx, driver.id, getTodayDate());
});

bot.hears("📆 My Route This Week", async (ctx) => {
  const driver = await getDriverByTelegramId(String(ctx.from.id));
  if (!driver) return;
  const today = new Date();
  let msg = `📆 *Your Route — Next 7 Days*\n\n`;
  let found = false;
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const day = d.toISOString().split("T")[0]!;
    const rows = await db
      .select({ workerName: workersTable.name, workerAddress: workersTable.address, factoryName: factoriesTable.name, shiftStart: schedulesTable.shiftStart })
      .from(schedulesTable)
      .leftJoin(workersTable, eq(schedulesTable.workerId, workersTable.id))
      .leftJoin(factoriesTable, eq(schedulesTable.factoryId, factoriesTable.id))
      .where(and(eq(schedulesTable.driverId, driver.id), eq(schedulesTable.scheduleDate, day)));
    if (rows.length > 0) {
      found = true;
      msg += `📅 *${formatDate(day)}* — ${rows.length} worker(s)\n`;
      const factories = [...new Set(rows.map(r => r.factoryName))];
      msg += `  🏭 ${factories.join(", ")}\n`;
      for (const r of rows) {
        msg += `  👷 ${r.workerName}${r.workerAddress ? ` — 📍 ${r.workerAddress}` : ""}\n`;
      }
      msg += "\n";
    }
  }
  if (!found) msg += "No routes scheduled for the next 7 days.";
  await ctx.reply(msg, { parse_mode: "Markdown", ...driverMainMenu() });
});

bot.hears("👥 My Workers List", async (ctx) => {
  const driver = await getDriverByTelegramId(String(ctx.from.id));
  if (!driver) return;
  await showDriverRoute(ctx, driver.id, getTodayDate());
});

bot.hears("✅ Mark Pickup Done", async (ctx) => {
  const driver = await getDriverByTelegramId(String(ctx.from.id));
  if (!driver) return;
  const today = getTodayDate();
  await db.update(schedulesTable)
    .set({ status: "picked_up" })
    .where(and(eq(schedulesTable.driverId, driver.id), eq(schedulesTable.scheduleDate, today)));
  await ctx.reply("✅ All pickups for today marked as done!", driverMainMenu());
});

// ─── Back navigation ──────────────────────────────────────────────────────

bot.hears("⬅️ Back to Main Menu", async (ctx) => {
  const telegramId = String(ctx.from.id);
  pendingActions.delete(telegramId);
  if (await isAdmin(telegramId)) {
    await ctx.reply("Main Menu:", adminMainMenu());
  } else if (await getWorkerByTelegramId(telegramId)) {
    await ctx.reply("Main Menu:", workerMainMenu());
  } else if (await getDriverByTelegramId(telegramId)) {
    await ctx.reply("Main Menu:", driverMainMenu());
  }
});

bot.hears("⬅️ Back to Workers", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.delete(String(ctx.from.id));
  await ctx.reply("👷 Worker Management:", Markup.keyboard([
    ["➕ Add Worker", "📋 List Workers"],
    ["🔗 Link Worker Telegram", "❌ Deactivate Worker"],
    ["⬅️ Back to Main Menu"],
  ]).resize());
});

bot.hears("⬅️ Back to Drivers", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.delete(String(ctx.from.id));
  await ctx.reply("🚗 Driver Management:", Markup.keyboard([
    ["➕ Add Driver", "📋 List Drivers"],
    ["🔗 Link Driver Telegram", "❌ Deactivate Driver"],
    ["⬅️ Back to Main Menu"],
  ]).resize());
});

bot.hears("⬅️ Back to Factories", async (ctx) => {
  if (!await isAdmin(String(ctx.from.id))) return;
  pendingActions.delete(String(ctx.from.id));
  await ctx.reply("🏭 Factory Management:", Markup.keyboard([
    ["➕ Add Factory", "📋 List Factories"],
    ["⬅️ Back to Main Menu"],
  ]).resize());
});

bot.hears("⬅️ Back", async (ctx) => {
  pendingActions.delete(String(ctx.from.id));
  await ctx.reply("Main Menu:", adminMainMenu());
});

// ─── Text handler (multi-step flows) ─────────────────────────────────────

bot.on("text", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const text = ctx.message.text;
  const pending = pendingActions.get(telegramId);
  if (!pending) return;

  const { action, data } = pending;

  // ── Add Worker flow ──────────────────────────────────────────────────────
  if (action === "add_worker") {
    if (!data.name) {
      data.name = text;
      pendingActions.set(telegramId, { action: "add_worker", data });
      await ctx.reply("Enter phone number (or skip with /skip):", Markup.removeKeyboard());
    } else if (!data.phone) {
      data.phone = text === "/skip" ? "" : text;
      pendingActions.set(telegramId, { action: "add_worker", data });
      await ctx.reply("Enter address (or /skip):", Markup.removeKeyboard());
    } else {
      data.address = text === "/skip" ? "" : text;
      await db.insert(workersTable).values({
        name: data.name,
        phone: data.phone || undefined,
        address: data.address || undefined,
      });
      pendingActions.delete(telegramId);
      await ctx.reply(
        `✅ Worker *${data.name}* added successfully!\n\nTo link their Telegram account, use "🔗 Link Worker Telegram".`,
        { parse_mode: "Markdown", ...Markup.keyboard([["👷 Workers", "⬅️ Back to Main Menu"]]).resize() }
      );
    }
    return;
  }

  // ── Add Driver flow ──────────────────────────────────────────────────────
  if (action === "add_driver") {
    if (!data.name) {
      data.name = text;
      pendingActions.set(telegramId, { action: "add_driver", data });
      await ctx.reply("Enter phone number (or /skip):", Markup.removeKeyboard());
    } else if (!data.phone) {
      data.phone = text === "/skip" ? "" : text;
      pendingActions.set(telegramId, { action: "add_driver", data });
      await ctx.reply("Enter vehicle info (e.g. Toyota Hiace B1234CD) or /skip:", Markup.removeKeyboard());
    } else {
      data.vehicle = text === "/skip" ? "" : text;
      await db.insert(driversTable).values({
        name: data.name,
        phone: data.phone || undefined,
        vehicle: data.vehicle || undefined,
      });
      pendingActions.delete(telegramId);
      await ctx.reply(
        `✅ Driver *${data.name}* added!\n\nUse "🔗 Link Driver Telegram" to link their Telegram account.`,
        { parse_mode: "Markdown", ...Markup.keyboard([["🚗 Drivers", "⬅️ Back to Main Menu"]]).resize() }
      );
    }
    return;
  }

  // ── Add Factory flow ─────────────────────────────────────────────────────
  if (action === "add_factory") {
    if (!data.name) {
      data.name = text;
      pendingActions.set(telegramId, { action: "add_factory", data });
      await ctx.reply("Enter factory address (or /skip):", Markup.removeKeyboard());
    } else if (!data.address) {
      data.address = text === "/skip" ? "" : text;
      pendingActions.set(telegramId, { action: "add_factory", data });
      await ctx.reply("Enter contact person name (or /skip):", Markup.removeKeyboard());
    } else {
      data.contactPerson = text === "/skip" ? "" : text;
      await db.insert(factoriesTable).values({
        name: data.name,
        address: data.address || undefined,
        contactPerson: data.contactPerson || undefined,
      });
      pendingActions.delete(telegramId);
      await ctx.reply(
        `✅ Factory *${data.name}* added!`,
        { parse_mode: "Markdown", ...Markup.keyboard([["🏭 Factories", "⬅️ Back to Main Menu"]]).resize() }
      );
    }
    return;
  }

  // ── Link Worker Telegram flow ────────────────────────────────────────────
  if (action === "link_worker_telegram_name") {
    const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
    const match = workers.find(w => w.name.toLowerCase().includes(text.toLowerCase()));
    if (!match) { await ctx.reply("Worker not found. Try again:", Markup.removeKeyboard()); return; }
    data.workerId = String(match.id);
    data.workerName = match.name;
    pendingActions.set(telegramId, { action: "link_worker_telegram_id", data });
    await ctx.reply(
      `Found: *${match.name}*\n\nNow ask the worker to send /getid in this bot, then paste their Telegram ID here:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "link_worker_telegram_id") {
    const newTelegramId = text.trim();
    await db.update(workersTable).set({ telegramId: newTelegramId }).where(eq(workersTable.id, Number(data.workerId)));
    pendingActions.delete(telegramId);
    await ctx.reply(
      `✅ Worker *${data.workerName}* linked to Telegram ID \`${newTelegramId}\`!`,
      { parse_mode: "Markdown", ...adminMainMenu() }
    );
    return;
  }

  // ── Link Driver Telegram flow ────────────────────────────────────────────
  if (action === "link_driver_telegram_name") {
    const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
    const match = drivers.find(d => d.name.toLowerCase().includes(text.toLowerCase()));
    if (!match) { await ctx.reply("Driver not found. Try again:"); return; }
    data.driverId = String(match.id);
    data.driverName = match.name;
    pendingActions.set(telegramId, { action: "link_driver_telegram_id", data });
    await ctx.reply(
      `Found: *${match.name}*\n\nAsk the driver to send /getid in this bot, then paste their Telegram ID here:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "link_driver_telegram_id") {
    const newTelegramId = text.trim();
    await db.update(driversTable).set({ telegramId: newTelegramId }).where(eq(driversTable.id, Number(data.driverId)));
    pendingActions.delete(telegramId);
    await ctx.reply(
      `✅ Driver *${data.driverName}* linked to Telegram ID \`${newTelegramId}\`!`,
      { parse_mode: "Markdown", ...adminMainMenu() }
    );
    return;
  }

  // ── Deactivate Worker ────────────────────────────────────────────────────
  if (action === "deactivate_worker_select") {
    const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
    const match = workers.find(w => w.name === text);
    if (!match) { await ctx.reply("Worker not found."); return; }
    await db.update(workersTable).set({ isActive: false }).where(eq(workersTable.id, match.id));
    pendingActions.delete(telegramId);
    await ctx.reply(`✅ Worker *${match.name}* has been deactivated.`, { parse_mode: "Markdown", ...adminMainMenu() });
    return;
  }

  // ── Schedule: select worker ──────────────────────────────────────────────
  if (action === "schedule_select_worker") {
    const workers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
    const match = workers.find(w => w.name === text);
    if (!match) { await ctx.reply("Worker not found. Please pick from the list."); return; }
    data.workerId = String(match.id);
    data.workerName = match.name;
    pendingActions.set(telegramId, { action: "schedule_select_factory", data });
    const factories = await db.select().from(factoriesTable);
    if (factories.length === 0) { await ctx.reply("No factories available. Add a factory first."); return; }
    const buttons = factories.map(f => [f.name]);
    await ctx.reply(`Select factory for *${match.name}*:`, {
      parse_mode: "Markdown",
      ...Markup.keyboard([...buttons, ["⬅️ Back"]]).resize()
    });
    return;
  }

  if (action === "schedule_select_factory") {
    const factories = await db.select().from(factoriesTable);
    const match = factories.find(f => f.name === text);
    if (!match) { await ctx.reply("Factory not found. Pick from the list."); return; }
    data.factoryId = String(match.id);
    data.factoryName = match.name;
    pendingActions.set(telegramId, { action: "schedule_select_driver", data });
    const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
    const buttons = drivers.map(d => [d.name]);
    await ctx.reply("Select driver (or /skip for no driver):", Markup.keyboard([...buttons, ["/skip"], ["⬅️ Back"]]).resize());
    return;
  }

  if (action === "schedule_select_driver") {
    if (text !== "/skip") {
      const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
      const match = drivers.find(d => d.name === text);
      if (match) data.driverId = String(match.id);
    }
    pendingActions.set(telegramId, { action: "schedule_select_date", data });
    await ctx.reply(`Enter date (YYYY-MM-DD) or type 'today':`, Markup.removeKeyboard());
    return;
  }

  if (action === "schedule_select_date") {
    const dateInput = text.toLowerCase() === "today" ? getTodayDate() : text;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      await ctx.reply("Invalid date format. Use YYYY-MM-DD or type 'today':");
      return;
    }
    data.scheduleDate = dateInput;
    pendingActions.set(telegramId, { action: "schedule_select_shift", data });
    await ctx.reply("Enter shift (e.g. 08:00-17:00) or /skip for default:", Markup.keyboard([["08:00-17:00", "07:00-16:00"], ["06:00-14:00", "/skip"]]).resize());
    return;
  }

  if (action === "schedule_select_shift") {
    let shiftStart = "08:00", shiftEnd = "17:00";
    if (text !== "/skip") {
      const parts = text.split("-");
      if (parts.length === 2) { shiftStart = parts[0]!.trim(); shiftEnd = parts[1]!.trim(); }
    }
    await db.insert(schedulesTable).values({
      workerId: Number(data.workerId),
      factoryId: Number(data.factoryId),
      driverId: data.driverId ? Number(data.driverId) : undefined,
      scheduleDate: data.scheduleDate!,
      shiftStart,
      shiftEnd,
    });
    pendingActions.delete(telegramId);
    await ctx.reply(
      `✅ Schedule created!\n\n👷 *${data.workerName}*\n🏭 *${data.factoryName}*\n📅 ${formatDate(data.scheduleDate!)}\n🕐 ${shiftStart}–${shiftEnd}`,
      { parse_mode: "Markdown", ...adminMainMenu() }
    );
    return;
  }

  // ── Schedule by date ─────────────────────────────────────────────────────
  if (action === "schedule_by_date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) { await ctx.reply("Invalid format. Use YYYY-MM-DD:"); return; }
    pendingActions.delete(telegramId);
    await showScheduleForDate(ctx, text);
    return;
  }

  // ── Delete schedule ──────────────────────────────────────────────────────
  if (action === "delete_schedule_date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) { await ctx.reply("Invalid format. Use YYYY-MM-DD:"); return; }
    data.scheduleDate = text;
    pendingActions.set(telegramId, { action: "delete_schedule_confirm", data });
    const count = await db.select().from(schedulesTable).where(eq(schedulesTable.scheduleDate, text));
    await ctx.reply(
      `Found ${count.length} schedule(s) for ${formatDate(text)}.\n\nType YES to delete all, or CANCEL:`,
      Markup.removeKeyboard()
    );
    return;
  }

  if (action === "delete_schedule_confirm") {
    if (text.toUpperCase() === "YES") {
      await db.delete(schedulesTable).where(eq(schedulesTable.scheduleDate, data.scheduleDate!));
      await ctx.reply(`✅ All schedules for ${formatDate(data.scheduleDate!)} deleted.`, adminMainMenu());
    } else {
      await ctx.reply("Cancelled.", adminMainMenu());
    }
    pendingActions.delete(telegramId);
    return;
  }

  // ── Report by date ───────────────────────────────────────────────────────
  if (action === "report_date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) { await ctx.reply("Invalid format. Use YYYY-MM-DD:"); return; }
    pendingActions.delete(telegramId);
    await showScheduleForDate(ctx, text);
    return;
  }
});

// ─── /getid command (for workers/drivers to get their Telegram ID) ────────

bot.command("getid", async (ctx) => {
  await ctx.reply(`Your Telegram ID is: \`${ctx.from.id}\`\n\nShare this with your admin to link your account.`, { parse_mode: "Markdown" });
});

// ─── /help command ────────────────────────────────────────────────────────

bot.command("help", async (ctx) => {
  const telegramId = String(ctx.from.id);
  if (await isAdmin(telegramId)) {
    await ctx.reply(
      `📖 *Admin Commands*\n\n` +
      `• Use the menu buttons to manage workers, drivers, factories, and schedules\n` +
      `• /adminsetup — Register as first admin\n` +
      `• /getid — Get your Telegram ID\n\n` +
      `*Workflow:*\n1. Add factories\n2. Add workers & drivers\n3. Link their Telegram accounts\n4. Create daily schedules\n5. Notify workers & drivers`,
      { parse_mode: "Markdown", ...adminMainMenu() }
    );
  } else {
    await ctx.reply(
      `📖 *Help*\n\n• Use the menu buttons to view your schedule\n• /getid — Get your Telegram ID (share with admin)\n• Contact your admin if you're not registered`,
      { parse_mode: "Markdown" }
    );
  }
});

// ─── Shared helpers ───────────────────────────────────────────────────────

async function showScheduleForDate(ctx: Context, date: string) {
  const schedules = await db
    .select({
      workerName: workersTable.name,
      workerAddress: workersTable.address,
      factoryName: factoriesTable.name,
      driverName: driversTable.name,
      shiftStart: schedulesTable.shiftStart,
      shiftEnd: schedulesTable.shiftEnd,
      status: schedulesTable.status,
    })
    .from(schedulesTable)
    .leftJoin(workersTable, eq(schedulesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(schedulesTable.factoryId, factoriesTable.id))
    .leftJoin(driversTable, eq(schedulesTable.driverId, driversTable.id))
    .where(eq(schedulesTable.scheduleDate, date));

  if (schedules.length === 0) {
    await ctx.reply(`📋 No schedules for ${formatDate(date)}.`, adminMainMenu());
    return;
  }

  let msg = `📋 *Schedules — ${formatDate(date)}*\n*${schedules.length} worker(s)*\n\n`;
  for (const s of schedules) {
    msg += `👷 *${s.workerName}*\n`;
    msg += `  🏭 ${s.factoryName ?? "N/A"} — 🕐 ${s.shiftStart}–${s.shiftEnd}\n`;
    if (s.driverName) msg += `  🚗 Driver: ${s.driverName}\n`;
    if (s.workerAddress) msg += `  📍 ${s.workerAddress}\n`;
    msg += "\n";
  }
  await ctx.reply(msg, { parse_mode: "Markdown", ...adminMainMenu() });
}

async function showWorkerSchedule(ctx: Context, workerId: number, date: string, _days: number) {
  const rows = await db
    .select({
      factoryName: factoriesTable.name,
      factoryAddress: factoriesTable.address,
      contactPerson: factoriesTable.contactPerson,
      driverName: driversTable.name,
      driverPhone: driversTable.phone,
      shiftStart: schedulesTable.shiftStart,
      shiftEnd: schedulesTable.shiftEnd,
      status: schedulesTable.status,
    })
    .from(schedulesTable)
    .leftJoin(factoriesTable, eq(schedulesTable.factoryId, factoriesTable.id))
    .leftJoin(driversTable, eq(schedulesTable.driverId, driversTable.id))
    .where(and(eq(schedulesTable.workerId, workerId), eq(schedulesTable.scheduleDate, date)));

  if (rows.length === 0) {
    await ctx.reply(`📅 No schedule for ${formatDate(date)}.`, workerMainMenu());
    return;
  }

  const r = rows[0]!;
  let msg = `📅 *Your Schedule — ${formatDate(date)}*\n\n`;
  msg += `🏭 *Factory:* ${r.factoryName ?? "TBD"}\n`;
  if (r.factoryAddress) msg += `📍 *Address:* ${r.factoryAddress}\n`;
  if (r.contactPerson) msg += `👤 *Contact:* ${r.contactPerson}\n`;
  msg += `🕐 *Shift:* ${r.shiftStart} – ${r.shiftEnd}\n`;
  if (r.driverName) {
    msg += `\n🚗 *Driver:* ${r.driverName}\n`;
    if (r.driverPhone) msg += `📞 *Driver Phone:* ${r.driverPhone}\n`;
  } else {
    msg += `\n🚗 *Driver:* Not assigned yet\n`;
  }
  await ctx.reply(msg, { parse_mode: "Markdown", ...workerMainMenu() });
}

async function showDriverRoute(ctx: Context, driverId: number, date: string) {
  const rows = await db
    .select({
      workerName: workersTable.name,
      workerPhone: workersTable.phone,
      workerAddress: workersTable.address,
      factoryName: factoriesTable.name,
      factoryAddress: factoriesTable.address,
      shiftStart: schedulesTable.shiftStart,
      shiftEnd: schedulesTable.shiftEnd,
      status: schedulesTable.status,
    })
    .from(schedulesTable)
    .leftJoin(workersTable, eq(schedulesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(schedulesTable.factoryId, factoriesTable.id))
    .where(and(eq(schedulesTable.driverId, driverId), eq(schedulesTable.scheduleDate, date)));

  if (rows.length === 0) {
    await ctx.reply(`📍 No route for ${formatDate(date)}.`, driverMainMenu());
    return;
  }

  const factory = rows[0]!;
  let msg = `📍 *Your Route — ${formatDate(date)}*\n`;
  msg += `🏭 *Destination:* ${factory.factoryName ?? "TBD"}\n`;
  if (factory.factoryAddress) msg += `📍 *Factory Address:* ${factory.factoryAddress}\n`;
  msg += `🕐 *Shift:* ${factory.shiftStart} – ${factory.shiftEnd}\n`;
  msg += `\n👥 *Workers to Pick Up (${rows.length}):*\n`;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    msg += `\n${i + 1}. *${r.workerName}*\n`;
    if (r.workerAddress) msg += `   📍 ${r.workerAddress}\n`;
    if (r.workerPhone) msg += `   📞 ${r.workerPhone}\n`;
  }
  await ctx.reply(msg, { parse_mode: "Markdown", ...driverMainMenu() });
}

export async function notifyWorkersForDate(ctx: Context, date: string) {
  const schedules = await db
    .select({
      workerName: workersTable.name,
      workerTelegramId: workersTable.telegramId,
      factoryName: factoriesTable.name,
      factoryAddress: factoriesTable.address,
      driverName: driversTable.name,
      shiftStart: schedulesTable.shiftStart,
      shiftEnd: schedulesTable.shiftEnd,
    })
    .from(schedulesTable)
    .leftJoin(workersTable, eq(schedulesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(schedulesTable.factoryId, factoriesTable.id))
    .leftJoin(driversTable, eq(schedulesTable.driverId, driversTable.id))
    .where(eq(schedulesTable.scheduleDate, date));

  let notified = 0;
  let skipped = 0;
  for (const s of schedules) {
    if (!s.workerTelegramId) { skipped++; continue; }
    try {
      let msg = `📅 *Schedule Reminder — ${formatDate(date)}*\n\n`;
      msg += `Hello *${s.workerName}*!\n\n`;
      msg += `🏭 *Factory:* ${s.factoryName ?? "TBD"}\n`;
      if (s.factoryAddress) msg += `📍 *Address:* ${s.factoryAddress}\n`;
      msg += `🕐 *Shift:* ${s.shiftStart} – ${s.shiftEnd}\n`;
      if (s.driverName) msg += `🚗 *Driver:* ${s.driverName}\n`;
      msg += `\nPlease be ready on time! 💪`;
      await bot.telegram.sendMessage(s.workerTelegramId, msg, { parse_mode: "Markdown" });
      notified++;
    } catch (e) {
      logger.error({ err: e }, `Failed to notify worker ${s.workerName}`);
      skipped++;
    }
  }
  await ctx.reply(`📢 Notifications sent!\n✅ Notified: ${notified}\n⚠️ Skipped (no Telegram): ${skipped}`, adminMainMenu());
}

export async function notifyDriversForDate(ctx: Context, date: string) {
  const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true));
  let notified = 0;
  let skipped = 0;
  for (const driver of drivers) {
    if (!driver.telegramId) { skipped++; continue; }
    const rows = await db
      .select({
        workerName: workersTable.name,
        workerAddress: workersTable.address,
        factoryName: factoriesTable.name,
        factoryAddress: factoriesTable.address,
        shiftStart: schedulesTable.shiftStart,
      })
      .from(schedulesTable)
      .leftJoin(workersTable, eq(schedulesTable.workerId, workersTable.id))
      .leftJoin(factoriesTable, eq(schedulesTable.factoryId, factoriesTable.id))
      .where(and(eq(schedulesTable.driverId, driver.id), eq(schedulesTable.scheduleDate, date)));
    if (rows.length === 0) continue;
    try {
      const factory = rows[0]!;
      let msg = `🚗 *Route Reminder — ${formatDate(date)}*\n\n`;
      msg += `Hello *${driver.name}*!\n\n`;
      msg += `🏭 *Destination:* ${factory.factoryName ?? "TBD"}\n`;
      if (factory.factoryAddress) msg += `📍 ${factory.factoryAddress}\n`;
      msg += `🕐 *Shift:* ${factory.shiftStart}\n\n`;
      msg += `👥 *Workers to pick up (${rows.length}):*\n`;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        msg += `${i + 1}. ${r.workerName}`;
        if (r.workerAddress) msg += ` — 📍 ${r.workerAddress}`;
        msg += "\n";
      }
      msg += "\nSafe driving! 🛣️";
      await bot.telegram.sendMessage(driver.telegramId, msg, { parse_mode: "Markdown" });
      notified++;
    } catch (e) {
      logger.error({ err: e }, `Failed to notify driver ${driver.name}`);
      skipped++;
    }
  }
  await ctx.reply(`📢 Driver notifications sent!\n✅ Notified: ${notified}\n⚠️ Skipped: ${skipped}`, adminMainMenu());
}

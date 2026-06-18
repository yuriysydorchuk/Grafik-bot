import { Markup, type Context } from "telegraf";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, factoriesTable, factoryOrdersTable,
  scheduleWeeksTable, scheduleEntriesTable, driverShiftAssignmentsTable, availabilityTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
import { workerMenu, headDriverMenu, driverMenu } from "./menus";
import { DAY_UK, SHIFT_SHORT } from "./display";
import { t, tb, dayShort, type Lang } from "./i18n";
import { DAYS, DAY_NAMES_UK } from "../services/sheets";
import { formatWeekStart } from "../services/scheduleGenerator";
import { sendLongMessage } from "./notify";
import { setState, clearState } from "./state";
import { nowWarsaw, shiftAnchor, factoryShiftStart } from "./time";

export async function getMenuDriverFactory(factoryId: number) {
  return (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
}

// ─── Availability keyboard ────────────────────────────────────────────────────

export async function sendAvailabilityKeyboard(
  ctx: Context,
  weekStart: string,
  responses: Record<string, Shift[] | null>,
  editMessageId?: number,
  shiftCount = 3,
  lang: Lang = "uk",
) {
  const weekDate = new Date(weekStart + "T00:00:00");
  const shifts = (["1", "2", "3", "4", "5", "6"] as Shift[]).slice(0, Math.min(6, Math.max(1, shiftCount)));
  const rows = DAYS.map((day) => {
    const sel = responses[day];
    const has = (s: Shift) => Array.isArray(sel) && sel.includes(s);
    const shiftBtns = shifts.map(s => ({ text: (has(s) ? "✅ " : "") + t(lang, "av.shift", { n: s }), callback_data: `avail_${day}_${s}` }));
    const isOff = Array.isArray(sel) && sel.length === 0;
    return [...shiftBtns, { text: (isOff ? "✅ " : "") + t(lang, "av.off"), callback_data: `avail_${day}_off` }];
  });
  const fmtSel = (sel: Shift[] | null | undefined) =>
    !Array.isArray(sel) ? "—" : sel.length === 0 ? t(lang, "sched.dayOff") : sel.map(s => SHIFT_SHORT[s]).join(", ");
  const dayLabels = DAYS.map((day, i) => {
    const date = new Date(weekDate);
    date.setDate(weekDate.getDate() + i);
    const dateStr = date.toLocaleDateString("uk-UA", { day: "numeric", month: "numeric" });
    return `${dayShort(lang, day)} ${dateStr}: ${fmtSel(responses[day])}`;
  });

  // Confirm is always available — untouched days (—) simply mean "not available".
  const keyboard = [
    ...rows,
    [{ text: t(lang, "av.confirm"), callback_data: `avail_confirm_${weekStart}` }],
    [{ text: t(lang, "menu.back"), callback_data: "avail_cancel" }],
  ];

  const text = `${t(lang, "av.kbTitle", { week: formatWeekStart(weekStart) })}\n\n${dayLabels.join("\n")}\n\n${t(lang, "av.kbHint")}`;

  if (editMessageId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat!.id, editMessageId, undefined, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch { /* message not modified */ }
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
  }
}

// ─── Schedule editor helpers ──────────────────────────────────────────────────

export async function getAssignedWorkerIds(weekId: number, factoryId: number, day: DayOfWeek, shift: Shift): Promise<number[]> {
  const rows = await db.select({ workerId: scheduleEntriesTable.workerId })
    .from(scheduleEntriesTable)
    .where(and(
      eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.factoryId, factoryId),
      eq(scheduleEntriesTable.dayOfWeek, day), eq(scheduleEntriesTable.shift, shift),
    ));
  return rows.map(r => r.workerId);
}

export async function getAssignedEntries(weekId: number, factoryId: number, day: DayOfWeek, shift: Shift) {
  return db.select({ entryId: scheduleEntriesTable.id, name: workersTable.fullName })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(
      eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.factoryId, factoryId),
      eq(scheduleEntriesTable.dayOfWeek, day), eq(scheduleEntriesTable.shift, shift),
    ))
    .then(rows => rows.map(r => ({ entryId: r.entryId, name: r.name ?? "—" })));
}

// Reserve = workers available for this day+shift (from availability) but not yet assigned
export async function getReserveForShift(weekStart: string, weekId: number, factoryId: number, day: DayOfWeek, shift: Shift) {
  const avail = await db.select({ name: availabilityTable.fullNameRaw })
    .from(availabilityTable)
    .where(and(eq(availabilityTable.weekStart, weekStart), eq(availabilityTable.dayOfWeek, day), eq(availabilityTable.shift, shift)));
  const assigned = await getAssignedWorkerIds(weekId, factoryId, day, shift);
  const factoryWorkers = await db.select().from(workersTable)
    .where(and(eq(workersTable.isActive, true), eq(workersTable.factoryId, factoryId)));
  // Match availability names to factory workers not already assigned
  const reserve = factoryWorkers.filter(w =>
    !assigned.includes(w.id) &&
    avail.some(a => a.name.toLowerCase().includes(w.fullName.toLowerCase().split(" ")[0]!.toLowerCase()))
  );
  return reserve;
}

export async function renderShiftEditor(ctx: Context, data: any) {
  const { weekId, weekStart, factoryName, factoryId, day, shift } = data;
  const assigned = await getAssignedEntries(weekId, factoryId, day, shift);
  const needed = (await db.select().from(factoryOrdersTable).where(and(
    eq(factoryOrdersTable.factoryId, factoryId), eq(factoryOrdersTable.weekStart, weekStart),
    eq(factoryOrdersTable.dayOfWeek, day), eq(factoryOrdersTable.shift, shift),
  )))[0]?.workersNeeded ?? 0;
  const reserve = await getReserveForShift(weekStart, weekId, factoryId, day, shift);

  const shortage = needed - assigned.length;
  const assignedList = assigned.length > 0 ? assigned.map((a, i) => `${i + 1}. ${a.name}`).join("\n") : "— нікого —";
  const reserveLine = reserve.length > 0
    ? `\n\n🔄 *Резерв (заявили доступність, але не в зміні):*\n${reserve.map(r => `• ${r.fullName}`).join("\n")}`
    : "\n\n🔄 Резерву немає";

  const msg = `✏️ *${factoryName}* — ${DAY_NAMES_UK[day as DayOfWeek]}, ${SHIFT_SHORT[shift as Shift]}\n\n*Призначено (${assigned.length}/${needed}):*\n${assignedList}${shortage > 0 ? `\n\n⚠️ *Бракує: ${shortage}*` : "\n\n✅ Достатньо людей"}${reserveLine}`;

  const reserveButtons = reserve.map(r => [`➕ ${r.fullName}`]);
  await ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.keyboard([
      ...reserveButtons,
      ["📋 Уся база фабрики", "✏️ Додати вручну"],
      ["🗑 Прибрати працівника"],
      ["⬅️ Назад до змін"],
    ]).resize(),
  });
}

// Summary of shortages for a factory (or whole week if factoryId omitted)
export async function showReserveSummary(ctx: Context, weekId: number, weekStart: string, factoryId?: number) {
  const orders = await db
    .select({ factoryId: factoryOrdersTable.factoryId, factoryName: factoriesTable.name, day: factoryOrdersTable.dayOfWeek, shift: factoryOrdersTable.shift, needed: factoryOrdersTable.workersNeeded })
    .from(factoryOrdersTable)
    .leftJoin(factoriesTable, eq(factoryOrdersTable.factoryId, factoriesTable.id))
    .where(factoryId
      ? and(eq(factoryOrdersTable.weekStart, weekStart), eq(factoryOrdersTable.factoryId, factoryId))
      : eq(factoryOrdersTable.weekStart, weekStart));

  const shortages: string[] = [];
  for (const o of orders) {
    if (o.needed <= 0) continue;
    const assigned = await getAssignedWorkerIds(weekId, o.factoryId, o.day as DayOfWeek, o.shift as Shift);
    const short = o.needed - assigned.length;
    if (short > 0) {
      shortages.push(`• ${o.factoryName} ${DAY_UK[o.day as DayOfWeek]} ${SHIFT_SHORT[o.shift as Shift]}: бракує ${short}`);
    }
  }
  if (shortages.length > 0) {
    await sendLongMessage(ctx.chat!.id, `⚠️ *Нестача людей:*\n${shortages.join("\n")}\n\nНатисніть "✏️ Редагувати графік" щоб додати з резерву/бази/вручну.`, { parse_mode: "Markdown" });
  }
}

// ─── Order board helpers ──────────────────────────────────────────────────────

export type OrderMap = Record<string, [number, number, number]>;

export async function loadOrderMap(factoryId: number, weekStart: string): Promise<OrderMap> {
  const rows = await db.select().from(factoryOrdersTable)
    .where(and(eq(factoryOrdersTable.factoryId, factoryId), eq(factoryOrdersTable.weekStart, weekStart)));
  const map: OrderMap = {};
  for (const d of DAYS) map[d] = [0, 0, 0];
  for (const r of rows) {
    const idx = Number(r.shift) - 1;
    if (map[r.dayOfWeek]) map[r.dayOfWeek]![idx] = r.workersNeeded;
  }
  return map;
}

export async function saveOrderDay(factoryId: number, weekStart: string, day: string, counts: [number, number, number]) {
  for (let s = 0; s < 3; s++) {
    await db.delete(factoryOrdersTable).where(and(
      eq(factoryOrdersTable.factoryId, factoryId), eq(factoryOrdersTable.weekStart, weekStart),
      eq(factoryOrdersTable.dayOfWeek, day as DayOfWeek), eq(factoryOrdersTable.shift, String(s + 1) as Shift),
    ));
    if (counts[s]! > 0) {
      await db.insert(factoryOrdersTable).values({
        factoryId, weekStart, dayOfWeek: day as DayOfWeek,
        shift: String(s + 1) as Shift, workersNeeded: counts[s]!,
      });
    }
  }
}

export async function renderOrderBoard(ctx: Context, data: any, editMessageId?: number) {
  const { factoryName, weekStart, orders } = data;
  const weekDate = new Date(weekStart + "T00:00:00");
  const total = DAYS.reduce((sum, d) => sum + (orders[d]?.reduce((a: number, b: number) => a + b, 0) ?? 0), 0);

  const lines = DAYS.map((d, i) => {
    const date = new Date(weekDate); date.setDate(weekDate.getDate() + i);
    const dStr = date.toLocaleDateString("uk-UA", { day: "numeric", month: "numeric" });
    const [s1, s2, s3] = orders[d] ?? [0, 0, 0];
    const sum = s1 + s2 + s3;
    return `${DAY_NAMES_UK[d]} ${dStr}: ${sum === 0 ? "вихідний" : `зм1=${s1} зм2=${s2} зм3=${s3}`}`;
  });

  const dayButtons = DAYS.map((d) => {
    const [s1, s2, s3] = orders[d] ?? [0, 0, 0];
    return [{ text: `${DAY_UK[d]}: ${s1}·${s2}·${s3}`, callback_data: `ord_day_${d}` }];
  });

  const text = `🏭 *${factoryName}* — Замовлення\n📅 ${formatWeekStart(weekStart)}\n\n${lines.join("\n")}\n\n*Всього змін-місць:* ${total}\n\nНатисніть на день щоб змінити (зм1 зм2 зм3):`;
  const keyboard = [
    ...dayButtons,
    [{ text: "🔁 Однаково всім дням", callback_data: "ord_all" }],
    [{ text: "📋 Скопіювати з минулого тижня", callback_data: "ord_copyprev" }],
    [{ text: "✅ Готово", callback_data: "ord_done" }],
  ];

  if (editMessageId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat!.id, editMessageId, undefined, text, {
        parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard },
      });
      return;
    } catch { /* fall through to send */ }
  }
  return ctx.reply(text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

export async function renderAttendanceMenu(ctx: Context, entries: { id: number; name: string }[], absent: number[]) {
  const btns = entries.map(e => [absent.includes(e.id) ? `❌ ${e.name}` : `✅ ${e.name}`]);
  const absentCount = absent.length;
  return ctx.reply(
    `📋 *Відмітити явку*\nНатисніть ім'я щоб переключити ✅↔️❌\n\nПрисутніх: ${entries.length - absentCount} / Відсутніх: ${absentCount}`,
    { parse_mode: "Markdown", ...Markup.keyboard([...btns, ["✅ Підтвердити явку"], ["⬅️ Назад"]]).resize() },
  );
}

export async function showWorkerSchedule(
  ctx: Context, workerId: number, weekId: number, weekStart: string,
  tabs: { weekStart: string; labelKey: string; active: boolean }[] = [],
  editMessageId?: number,
  lang: Lang = "uk",
) {
  const entries = await db
    .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, factoryName: factoriesTable.name, factoryAddress: factoriesTable.address })
    .from(scheduleEntriesTable)
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.workerId, workerId), ne(scheduleEntriesTable.status, "absent")));
  let msg = t(lang, "sched.title", { week: formatWeekStart(weekStart) }) + "\n\n";
  if (entries.length === 0) {
    msg += t(lang, "sched.none");
  } else {
    const byDay: Record<string, typeof entries[0]> = {};
    entries.forEach(e => { byDay[e.day] = e; });
    for (const day of DAYS) {
      const e = byDay[day];
      msg += e ? `${dayShort(lang, day)}: ${SHIFT_SHORT[e.shift as Shift]} — 🏭 ${e.factoryName}\n` : `${dayShort(lang, day)}: ${t(lang, "sched.dayOff")}\n`;
    }
    const addrs = new Map<string, string>();
    for (const e of entries) if (e.factoryName && e.factoryAddress) addrs.set(e.factoryName, e.factoryAddress);
    if (addrs.size) {
      msg += `\n${t(lang, "sched.addresses")}\n`;
      for (const [name, addr] of addrs) msg += `🏭 ${name}: ${addr}\n`;
    }
  }
  // Week switcher (only when more than one week is available)
  const reply_markup = tabs.length > 1
    ? { inline_keyboard: [tabs.map(tb => ({ text: (tb.active ? "🔹 " : "") + t(lang, tb.labelKey), callback_data: `wsched:${tb.weekStart}` }))] }
    : undefined;
  if (editMessageId) {
    try { await ctx.telegram.editMessageText(ctx.chat!.id, editMessageId, undefined, msg, { parse_mode: "Markdown", reply_markup }); } catch { /* not modified */ }
  } else {
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup });
  }
}

// Head-driver assignment: list factory+shift slots for a day with counts and assigned drivers
export async function showHdSlots(ctx: Context, tid: string, data: any, lang: Lang = "uk") {
  const day = data.day as DayOfWeek;
  const entries = await db
    .select({ factoryId: scheduleEntriesTable.factoryId, factoryName: factoriesTable.name, shift: scheduleEntriesTable.shift })
    .from(scheduleEntriesTable)
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, data.weekId), eq(scheduleEntriesTable.dayOfWeek, day)));
  if (entries.length === 0) {
    clearState(tid);
    return ctx.reply(tb(lang, "📭 На {day} немає змін у графіку.", { day: DAY_NAMES_UK[day] }), headDriverMenu(lang));
  }
  const assigns = await db
    .select({ factoryId: driverShiftAssignmentsTable.factoryId, shift: driverShiftAssignmentsTable.shift, driverName: driversTable.name })
    .from(driverShiftAssignmentsTable)
    .leftJoin(driversTable, eq(driverShiftAssignmentsTable.driverId, driversTable.id))
    .where(and(eq(driverShiftAssignmentsTable.weekId, data.weekId), eq(driverShiftAssignmentsTable.dayOfWeek, day)));

  const map = new Map<string, { factoryId: number; factoryName: string; shift: Shift; count: number; drivers: string[] }>();
  for (const e of entries) {
    const key = `${e.factoryId}-${e.shift}`;
    if (!map.has(key)) map.set(key, { factoryId: e.factoryId, factoryName: e.factoryName ?? "—", shift: e.shift as Shift, count: 0, drivers: [] });
    map.get(key)!.count++;
  }
  for (const a of assigns) {
    const key = `${a.factoryId}-${a.shift}`;
    if (map.has(key) && a.driverName) map.get(key)!.drivers.push(a.driverName);
  }
  const slots = [...map.values()].sort((a, b) => a.factoryName.localeCompare(b.factoryName, "uk") || a.shift.localeCompare(b.shift));
  const labelOf = (s: typeof slots[number]) =>
    `${s.factoryName} · ${SHIFT_SHORT[s.shift]} — ${s.count} ${tb(lang, "ос.")}${s.drivers.length ? ` ✅ ${s.drivers.join(", ")}` : ""}`;
  setState(tid, "hd:select_slot", {
    weekId: data.weekId, weekStart: data.weekStart, day,
    slots: slots.map(s => ({ factoryId: s.factoryId, factoryName: s.factoryName, shift: s.shift, label: labelOf(s) })),
  });
  return ctx.reply(
    `📋 *${DAY_NAMES_UK[day]}* — ${tb(lang, "оберіть зміну, щоб призначити водія\n(✅ = вже є водій):")}`,
    { parse_mode: "Markdown", ...Markup.keyboard([...slots.map(s => [labelOf(s)]), [tb(lang, "⬅️ Назад")]]).resize() },
  );
}

export async function showFullWeekSchedule(ctx: Context, weekId: number, weekStart: string, lang: Lang = "uk") {
  const entries = await db
    .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, workerName: workersTable.fullName, factoryName: factoriesTable.name })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(eq(scheduleEntriesTable.weekId, weekId));
  if (entries.length === 0) return ctx.reply(tb(lang, "Графік порожній."));
  let msg = `📅 *${tb(lang, "Графік")} — ${formatWeekStart(weekStart)}*\n\n`;
  for (const day of DAYS) {
    const dayEntries = entries.filter(e => e.day === day);
    if (dayEntries.length === 0) continue;
    msg += `*${DAY_NAMES_UK[day]}:*\n`;
    for (const shift of ["1", "2", "3", "4", "5", "6"] as Shift[]) {
      const shifted = dayEntries.filter(e => e.shift === shift);
      if (shifted.length > 0) {
        msg += `  ${SHIFT_SHORT[shift]} (${shifted.length} ${tb(lang, "ос.")}):\n`;
        shifted.forEach(e => { msg += `    • ${e.workerName}\n`; });
      }
    }
  }
  return sendLongMessage(ctx.chat!.id, msg, { parse_mode: "Markdown" });
}

export async function showFactoryWeekSchedule(ctx: Context, weekId: number, weekStart: string, factoryId: number, factoryName: string) {
  const entries = await db
    .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, workerName: workersTable.fullName, status: scheduleEntriesTable.status })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.factoryId, factoryId)));
  if (entries.length === 0) {
    return ctx.reply(`📭 Для *${factoryName}* на тиждень ${formatWeekStart(weekStart)} ще немає призначень.`, { parse_mode: "Markdown" });
  }
  let msg = `📅 *${factoryName} — ${formatWeekStart(weekStart)}*\n\n`;
  for (const day of DAYS) {
    const dayEntries = entries.filter(e => e.day === day);
    if (dayEntries.length === 0) continue;
    msg += `*${DAY_NAMES_UK[day]}:*\n`;
    for (const shift of ["1", "2", "3", "4", "5", "6"] as Shift[]) {
      const shifted = dayEntries.filter(e => e.shift === shift);
      if (shifted.length > 0) {
        msg += `  ${SHIFT_SHORT[shift]} (${shifted.length} ос.):\n`;
        shifted.forEach(e => {
          const icon = e.status === "present" ? "✅" : e.status === "absent" ? "❌" : "•";
          msg += `    ${icon} ${e.workerName}\n`;
        });
      }
    }
  }
  return sendLongMessage(ctx.chat!.id, msg, { parse_mode: "Markdown" });
}

export async function showDriverShift(ctx: Context, driverId: number, weekStart: string, day: DayOfWeek, lang: Lang = "uk") {
  const weeks = await db.select().from(scheduleWeeksTable).where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "approved")));
  if (weeks.length === 0) return ctx.reply(tb(lang, "Немає активного графіку."), driverMenu(lang));
  const driver = (await db.select().from(driversTable).where(eq(driversTable.id, driverId)))[0];
  const menu = driver?.isHeadDriver ? headDriverMenu(lang) : driverMenu(lang);
  const assignments = await db.select({ shift: driverShiftAssignmentsTable.shift, factoryId: driverShiftAssignmentsTable.factoryId, factoryName: factoriesTable.name })
    .from(driverShiftAssignmentsTable)
    .leftJoin(factoriesTable, eq(driverShiftAssignmentsTable.factoryId, factoriesTable.id))
    .where(and(eq(driverShiftAssignmentsTable.weekId, weeks[0]!.id), eq(driverShiftAssignmentsTable.dayOfWeek, day), eq(driverShiftAssignmentsTable.driverId, driverId)));
  if (assignments.length === 0) return ctx.reply(tb(lang, "📭 На {day} немає призначень.", { day: DAY_NAMES_UK[day] }), menu);
  let msg = `📍 *${DAY_NAMES_UK[day]}* — ${tb(lang, "Ваші зміни:")}\n\n`;
  for (const a of assignments) {
    const factory = await getMenuDriverFactory(a.factoryId);
    const start = factoryShiftStart(factory, a.shift as Shift);
    const workers = await db
      .select({ name: workersTable.fullName, status: scheduleEntriesTable.status })
      .from(scheduleEntriesTable)
      .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
      .where(and(eq(scheduleEntriesTable.weekId, weeks[0]!.id), eq(scheduleEntriesTable.dayOfWeek, day), eq(scheduleEntriesTable.shift, a.shift), eq(scheduleEntriesTable.factoryId, a.factoryId)));
    msg += `🏭 *${a.factoryName ?? "—"}* · ${SHIFT_SHORT[a.shift as Shift]}\n🚌 ${tb(lang, "Збір:")} ${shiftAnchor(nowWarsaw(), start, 60).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })} · 🏭 ${tb(lang, "на фабриці до:")} ${shiftAnchor(nowWarsaw(), start, 15).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}\n`;
    workers.forEach((w, i) => {
      const icon = w.status === "present" ? "✅" : w.status === "absent" ? "❌" : "⏳";
      msg += `  ${i + 1}. ${icon} ${w.name}\n`;
    });
    msg += "\n";
  }
  await sendLongMessage(ctx.chat!.id, msg, { parse_mode: "Markdown" });
  return ctx.reply(tb(lang, "Меню:"), menu);
}

export async function showDriverWeek(ctx: Context, driverId: number, weekId: number, weekStart: string, lang: Lang = "uk") {
  const assignments = await db
    .select({ day: driverShiftAssignmentsTable.dayOfWeek, shift: driverShiftAssignmentsTable.shift, factoryName: factoriesTable.name })
    .from(driverShiftAssignmentsTable)
    .leftJoin(factoriesTable, eq(driverShiftAssignmentsTable.factoryId, factoriesTable.id))
    .where(and(eq(driverShiftAssignmentsTable.weekId, weekId), eq(driverShiftAssignmentsTable.driverId, driverId)));
  if (assignments.length === 0) return ctx.reply(tb(lang, "📭 На тиждень {week} немає призначень.", { week: formatWeekStart(weekStart) }), driverMenu(lang));
  let msg = `🚗 *${tb(lang, "Ваш графік")} — ${formatWeekStart(weekStart)}*\n\n`;
  for (const day of DAYS) {
    const dayA = assignments.filter(a => a.day === day);
    if (dayA.length > 0) {
      msg += `${DAY_UK[day]}: `;
      msg += dayA.map(a => `${SHIFT_SHORT[a.shift as Shift]} 🏭 ${a.factoryName}`).join(", ");
      msg += "\n";
    }
  }
  return ctx.reply(msg, { parse_mode: "Markdown", ...driverMenu(lang) });
}

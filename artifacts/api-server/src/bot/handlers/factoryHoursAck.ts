// Відповідь працівника на запит «підтверди свої години фабрики» (розсилка з /hours):
//   fh:(ok|no):<factory_hours.id>      — місяць;
//   fhw:(ok|no):<factory_week_hours.id> — тиждень тижневої фабрики.
// Винесено з bot/index.ts 05.11.2026 разом із двома змінами (зголошення #15 і #24):
//  • «❌ Є помилка» приймається ЛИШЕ за наявності рапорту за цей місяць×фабрику (тиждень×фабрику):
//    без рапорту офісу нема з чим порівнювати — бот просить спершу здати рапорт (кнопка відкриває
//    рапорт саме за період запиту); після здачі рапорту розбіжність з годинами фабрики сама стає
//    спором і йде в офіс, збіг — підтвердженням. З рапортом — як було: спір + пояснення текстом.
//  • власник запиту шукається за telegram_id БЕЗ огляду на is_active: звільнений (якому запит
//    прийшов уже після звільнення) раніше бачив «запит неактуальний» на обох кнопках.
// Пояснення текстом (стан fh:dispute_note) обробляє handleFhDisputeNote із загального bot.on("text").
import { type Telegraf, type Context } from "telegraf";
import { db, workersTable, factoriesTable, factoryHoursTable, factoryWeekHoursTable, monthlyReportsTable, weeklyReportsTable, type Worker } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { setState, clearState } from "../state";
import { t, asLang, DATE_LOCALE, type Lang } from "../i18n";
import { mdSafe } from "../display";
import { cancelKb, leaverMenu } from "../menus";
import { notifyAdmins, notifyRoles } from "../notify";
import { setWeekAckResponse } from "../../services/weeklyHours";
import { ddmm, weekEnd, weekLabel } from "../../lib/weekMath";
import { logger } from "../../lib/logger";

const S_NOTE = "fh:dispute_note";
const EPS = 0.01;

type MenuFor = (worker: { factoryId?: number | null } | undefined, lang: Lang) => Promise<any>;
export interface FactoryHoursAckDeps {
  menuFor: MenuFor;
  /** рапорт за місяць×фабрику (index.ts startReportFlow); extra лягає в стан діалогу рапорту */
  startMonthlyReport: (ctx: Context, tid: string, worker: Worker, month: string, lang: Lang, factoryId: number, extra: Record<string, unknown>) => Promise<unknown>;
  /** рапорт за тиждень (handlers/weeklyHours beginReportById) */
  startWeeklyReport: (ctx: Context, worker: Worker, lang: Lang, repId: number, extra: Record<string, unknown>) => Promise<unknown>;
}

/** Власник запиту — за telegram_id, активний чи звільнений (telegram_id унікальний). */
export async function workerByTelegram(tid: string): Promise<Worker | undefined> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.telegramId, tid));
  return w;
}
const menuOf = async (worker: Worker | undefined, lang: Lang, menuFor: MenuFor) =>
  worker && !worker.isActive ? leaverMenu(lang) : menuFor(worker, lang);
const monthLabel = (lang: Lang, month: string) => new Date(`${month}-01`).toLocaleDateString(DATE_LOCALE[lang], { month: "long", year: "numeric" });
const factoryName = async (factoryId: number) =>
  (await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0]?.name ?? "—";

async function notifyDispute(worker: { fullName: string }, factory: string, period: string, hours: number, note: string) {
  await notifyAdmins("hours_correction",
    `⚠️ *Помилка в годинах фабрики*\n\n👷 *${mdSafe(worker.fullName)}*\n🏭 ${mdSafe(factory)} · ${period}\n🕒 Наші години: *${hours}*\n📝 ${mdSafe(note)}`,
    { parse_mode: "Markdown" });
  await notifyRoles("scheduler", { type: "hours_correction", adminsNotified: true, title: `⚠️ Помилка в годинах фабрики: ${worker.fullName}`, body: `${factory} · ${period} · наші ${hours} год · ${note}` });
}

/**
 * Рапорт за місяць здано з кнопки «спершу здай рапорт» (у стані діалогу — fhAck = factory_hours.id):
 * розбіжність з годинами фабрики → спір і сповіщення офісу; збіг → підтверджено.
 */
export async function ackAfterMonthlyReport(ctx: Context, lang: Lang, p: { fhId: number; workerId: number; reportHours: number }): Promise<void> {
  try {
    const [row] = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.id, p.fhId));
    if (!row || row.workerId !== p.workerId) return;
    const [w] = await db.select({ fullName: workersTable.fullName }).from(workersTable).where(eq(workersTable.id, p.workerId));
    if (Math.abs(row.hours - p.reportHours) < EPS) {
      await db.update(factoryHoursTable).set({ workerResponse: "confirmed", workerResponseAt: new Date(), workerNote: null }).where(eq(factoryHoursTable.id, row.id));
      await ctx.reply(t(lang, "fh.reportMatches", { hours: row.hours }), { parse_mode: "Markdown" });
      return;
    }
    const note = `Рапорт працівника: ${p.reportHours} год (фабрика: ${row.hours} год)`;
    await db.update(factoryHoursTable).set({ workerResponse: "dispute", workerResponseAt: new Date(), workerNote: note }).where(eq(factoryHoursTable.id, row.id));
    await notifyDispute(w ?? { fullName: `#${p.workerId}` }, await factoryName(row.factoryId), row.month, row.hours, note);
    await ctx.reply(t(lang, "fh.reportDiffers", { report: p.reportHours, hours: row.hours }), { parse_mode: "Markdown" });
  } catch (e: any) { logger.warn({ err: e?.message, fhId: p.fhId }, "factory hours ack after report failed"); }
}

/** Те саме для тижня (fhAckWeek = factory_week_hours.id у стані тижневого рапорту). */
export async function ackAfterWeeklyReport(ctx: Context, lang: Lang, p: { fhwId: number; workerId: number; hoursReported: number }): Promise<void> {
  try {
    const [row] = await db.select().from(factoryWeekHoursTable).where(eq(factoryWeekHoursTable.id, p.fhwId));
    if (!row || row.workerId !== p.workerId) return;
    const [w] = await db.select({ fullName: workersTable.fullName }).from(workersTable).where(eq(workersTable.id, p.workerId));
    if (Math.abs(row.hours - p.hoursReported) < EPS) {
      await setWeekAckResponse(row.id, "confirmed");
      await ctx.reply(t(lang, "fh.reportMatches", { hours: row.hours }), { parse_mode: "Markdown" });
      return;
    }
    const note = `Рапорт працівника: ${p.hoursReported} год (фабрика: ${row.hours} год)`;
    await setWeekAckResponse(row.id, "dispute");       // відповідь + час відповіді
    await setWeekAckResponse(row.id, "dispute", note); // пояснення (виклик з note час не чіпає)
    await notifyDispute(w ?? { fullName: `#${p.workerId}` }, await factoryName(row.factoryId), `тиждень ${weekLabel(String(row.weekStart))}`, row.hours, note);
    await ctx.reply(t(lang, "fh.reportDiffers", { report: p.hoursReported, hours: row.hours }), { parse_mode: "Markdown" });
  } catch (e: any) { logger.warn({ err: e?.message, fhwId: p.fhwId }, "factory week hours ack after report failed"); }
}

export function registerFactoryHoursAck(bot: Telegraf, deps: FactoryHoursAckDeps) {
  const gone = async (ctx: Context, lang: Lang) => {
    await ctx.answerCbQuery(t(lang, "fh.gone"));
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  };

  // ── місяць ───────────────────────────────────────────────────────────────
  bot.action(/^fh:(ok|no):(\d+)$/, async (ctx) => {
    const tid = String(ctx.from.id);
    const kind = ctx.match[1] as "ok" | "no";
    const fhId = Number(ctx.match[2]);
    const worker = await workerByTelegram(tid);
    const lang = asLang(worker?.language);
    const [row] = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.id, fhId));
    // рядок міг зникнути (очистка колонки/переімпорт) або належати не цій людині
    if (!row || !worker || row.workerId !== worker.id) return gone(ctx, lang);
    const fac = await factoryName(row.factoryId);
    const month = monthLabel(lang, row.month);
    if (kind === "ok") {
      await db.update(factoryHoursTable).set({ workerResponse: "confirmed", workerResponseAt: new Date(), workerNote: null }).where(eq(factoryHoursTable.id, fhId));
      await ctx.answerCbQuery("✅");
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      return ctx.reply(t(lang, "fh.confirmed", { hours: row.hours, factory: fac, month }), { parse_mode: "Markdown" });
    }
    // «Є помилка» — лише з рапортом за цей місяць×фабрику (рапорт без фабрики — старий формат, теж рахується)
    const [rep] = await db.select({ id: monthlyReportsTable.id }).from(monthlyReportsTable)
      .where(and(eq(monthlyReportsTable.workerId, worker.id), eq(monthlyReportsTable.month, row.month), or(eq(monthlyReportsTable.factoryId, row.factoryId), isNull(monthlyReportsTable.factoryId)))).limit(1);
    if (!rep) {
      // кнопки запиту лишаємо: після рапорту людина може відповісти ще раз
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "fh.needReport", { month, factory: mdSafe(fac) }),
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "fh.btnReport"), callback_data: `fhr:${fhId}` }]] } });
    }
    await db.update(factoryHoursTable).set({ workerResponse: "dispute", workerResponseAt: new Date() }).where(eq(factoryHoursTable.id, fhId));
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    setState(tid, S_NOTE, { fhId, lang });
    return ctx.reply(t(lang, "fh.askNote"), cancelKb(lang));
  });

  // «📄 Здати рапорт» з підказки вище: рапорт за місяць×фабрику запиту; після збереження — ackAfterMonthlyReport
  bot.action(/^fhr:(\d+)$/, async (ctx) => {
    const tid = String(ctx.from.id);
    const worker = await workerByTelegram(tid);
    const lang = asLang(worker?.language);
    const [row] = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.id, Number(ctx.match[1])));
    if (!row || !worker || row.workerId !== worker.id) return gone(ctx, lang);
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return deps.startMonthlyReport(ctx, tid, worker, row.month, lang, row.factoryId, { fhAck: row.id });
  });

  // ── тиждень ──────────────────────────────────────────────────────────────
  bot.action(/^fhw:(ok|no):(\d+)$/, async (ctx) => {
    const tid = String(ctx.from.id);
    const kind = ctx.match[1] as "ok" | "no";
    const id = Number(ctx.match[2]);
    const worker = await workerByTelegram(tid);
    const lang = asLang(worker?.language);
    const [row] = await db.select().from(factoryWeekHoursTable).where(eq(factoryWeekHoursTable.id, id));
    if (!row || !worker || row.workerId !== worker.id) return gone(ctx, lang);
    const fac = await factoryName(row.factoryId);
    const ws = String(row.weekStart);
    if (kind === "ok") {
      await setWeekAckResponse(id, "confirmed");
      await ctx.answerCbQuery("✅");
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      return ctx.reply(t(lang, "fh.confirmedWeek", { hours: row.hours, factory: mdSafe(fac), from: ddmm(ws), to: ddmm(weekEnd(ws)) }), { parse_mode: "Markdown" });
    }
    // рядок тижневого рапорту створює понеділковий запит; ще не поданий → спершу рапорт.
    // Рядка немає взагалі (запиту рапорту на цей тиждень не було) — приймаємо спір як раніше.
    const [rep] = await db.select({ id: weeklyReportsTable.id, submittedAt: weeklyReportsTable.submittedAt }).from(weeklyReportsTable)
      .where(and(eq(weeklyReportsTable.workerId, worker.id), eq(weeklyReportsTable.factoryId, row.factoryId), eq(weeklyReportsTable.weekStart, ws))).limit(1);
    if (rep && !rep.submittedAt) {
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "fh.needReportWeek", { from: ddmm(ws), to: ddmm(weekEnd(ws)), factory: mdSafe(fac) }),
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "fh.btnReport"), callback_data: `fhwr:${id}` }]] } });
    }
    await setWeekAckResponse(id, "dispute");
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    setState(tid, S_NOTE, { fhId: id, lang, week: true });
    return ctx.reply(t(lang, "fh.askNote"), cancelKb(lang));
  });

  bot.action(/^fhwr:(\d+)$/, async (ctx) => {
    const tid = String(ctx.from.id);
    const worker = await workerByTelegram(tid);
    const lang = asLang(worker?.language);
    const [row] = await db.select().from(factoryWeekHoursTable).where(eq(factoryWeekHoursTable.id, Number(ctx.match[1])));
    if (!row || !worker || row.workerId !== worker.id) return gone(ctx, lang);
    const [rep] = await db.select({ id: weeklyReportsTable.id }).from(weeklyReportsTable)
      .where(and(eq(weeklyReportsTable.workerId, worker.id), eq(weeklyReportsTable.factoryId, row.factoryId), eq(weeklyReportsTable.weekStart, String(row.weekStart)))).limit(1);
    if (!rep) return gone(ctx, lang);
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return deps.startWeeklyReport(ctx, worker, lang, rep.id, { fhAckWeek: row.id });
  });
}

// Пояснення помилки текстом (стан fh:dispute_note після «Є помилка» з рапортом). Викликається з
// загального bot.on("text") в index.ts — на тому самому місці, де гілка жила раніше, щоб кнопки
// меню й «Скасувати» (hears, зареєстровані перед ним) і далі мали пріоритет над станом.
export async function handleFhDisputeNote(ctx: Context, tid: string, state: { data: Record<string, any> }, text: string, menuFor: MenuFor) {
  const lang = asLang(state.data.lang);
  clearState(tid);
  const note = text.trim().slice(0, 500);
  const worker = await workerByTelegram(tid);
  if (state.data.week) {
    const [wrow] = await db.select().from(factoryWeekHoursTable).where(eq(factoryWeekHoursTable.id, Number(state.data.fhId)));
    if (wrow && worker && wrow.workerId === worker.id) {
      await setWeekAckResponse(wrow.id, "dispute", note);
      await notifyDispute(worker, await factoryName(wrow.factoryId), `тиждень ${weekLabel(String(wrow.weekStart))}`, wrow.hours, note);
    }
    return ctx.reply(t(lang, "fh.noteSaved"), await menuOf(worker, lang, menuFor));
  }
  const [row] = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.id, Number(state.data.fhId)));
  if (row && worker && row.workerId === worker.id) {
    await db.update(factoryHoursTable).set({ workerNote: note }).where(eq(factoryHoursTable.id, row.id));
    await notifyDispute(worker, await factoryName(row.factoryId), row.month, row.hours, note);
  }
  return ctx.reply(t(lang, "fh.noteSaved"), await menuOf(worker, lang, menuFor));
}

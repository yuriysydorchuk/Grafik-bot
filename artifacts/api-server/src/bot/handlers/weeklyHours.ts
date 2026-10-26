// Тижневий облік годин у боті працівника (26.10.2026, factories.weekly_hours):
//  • відмітки зміни (wsl:*): пуш на старті зміни з «▶️ Приступив» / «🚫 Відсутній», після старту
//    «⏹ Закінчив»; час — «зараз» або вибір ранішого (крок 15 хв); логіка/валідність — services/shiftLogs.ts;
//  • рапорт за тиждень (wkr:*): запит у понеділок / нагадування у вівторок (services/weeklyHours.ts)
//    → по кожному дню Пн–Нд inline-кнопки зі змінами фабрики (скільки налаштовано) або «не працював»,
//    далі тотал годин за тиждень текстом, далі фото рапорту → weekly_reports + похідні місячні рядки.
// Реєструється РАНІШЕ за загальні bot.hears("menu.report") / bot.on("text"/"photo"/"document")
// в index.ts — чужі стани й не-тижневі фабрики пропускає далі через next().
import { Markup, type Telegraf, type Context } from "telegraf";
import { db, workersTable, factoriesTable, weeklyReportsTable, type DayOfWeek } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { setState, getState, clearState } from "../state";
import { getWorker } from "../roles";
import { t, trAll, asLang, dayShort, type Lang } from "../i18n";
import { mdSafe } from "../display";
import { cancelKb } from "../menus";
import { notifyByType, notifyAbsentWorker } from "../notify";
import {
  getLog, startLog, endLog, markAbsent, sendEndPrompt, startPickRange, endPickRange, timeOptions, wallHHMM, shiftTimeOn, shiftLabel,
} from "../../services/shiftLogs";
import { buildWeekRows, saveWeeklyReport } from "../../services/weeklyHours";
import { shiftDurationHours } from "../../services/shiftOverrides";
import { uploadReportPhoto } from "../../services/drive";
import { weekDates, weekEnd, ddmm, isoMonthOfWeek, round2, weekLabel } from "../../lib/weekMath";

const S_DAY = "wkr:day";     // data: repId, workerId, workerName, factoryId, factoryName, weekStart, lang, idx, days, shiftsByDate, hints, msgId
const S_TOTAL = "wkr:total"; // + days готові
const S_PHOTO = "wkr:photo"; // + hoursReported

type WorkerLike = { id: number; factoryId?: number | null; language?: string | null; fullName: string };
type MenuFor = (worker: WorkerLike | undefined, lang: Lang) => Promise<any>;
type ShiftOpt = { shift: string; start: string; end: string; hours: number };

const DOW_JS: DayOfWeek[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const dayLbl = (lang: Lang, date: string) => `${dayShort(lang, DOW_JS[new Date(date + "T00:00:00").getDay()]!)} ${ddmm(date)}`;
const grid = <T,>(items: T[], per: number): T[][] => { const out: T[][] = []; for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per)); return out; };

const REASON_KEY: Record<string, string> = { expired: "wsl.expired", state: "wsl.done", future: "wsl.future", early: "wsl.early", long: "wsl.long" };

export function registerWeeklyHours(bot: Telegraf, menuFor: MenuFor) {
  const ownLog = async (ctx: Context, id: number) => {
    const worker = await getWorker(String(ctx.from!.id));
    const log = await getLog(id);
    if (!worker || !log || log.workerId !== worker.id) return null;
    return { worker, log, lang: asLang(worker.language) };
  };
  const nowEarlierKb = (lang: Lang, nowCb: string, pickCb: string) => ({
    inline_keyboard: [
      [{ text: t(lang, "wsl.btnNow", { time: wallHHMM(new Date()) }), callback_data: nowCb }],
      [{ text: t(lang, "wsl.btnEarlier"), callback_data: pickCb }],
    ],
  });

  // ── Відмітки зміни ─────────────────────────────────────────────────────────
  bot.action(/^wsl:start:(\d+)$/, async (ctx) => {
    const r = await ownLog(ctx, Number(ctx.match[1]));
    if (!r) return ctx.answerCbQuery(t("uk", "wsl.expired"));
    if (r.log.status !== "pending") return ctx.answerCbQuery(t(r.lang, r.log.status === "expired" ? "wsl.expired" : "wsl.done"), { show_alert: true });
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(nowEarlierKb(r.lang, `wsl:snow:${r.log.id}`, `wsl:spick:${r.log.id}`)); } catch { /* ignore */ }
    return;
  });
  bot.action(/^wsl:spick:(\d+)$/, async (ctx) => {
    const r = await ownLog(ctx, Number(ctx.match[1]));
    if (!r || r.log.status !== "pending") return ctx.answerCbQuery(t(r?.lang ?? "uk", "wsl.expired"));
    await ctx.answerCbQuery();
    const opts = timeOptions(await startPickRange(r.log, new Date()));
    const kb = grid(opts.map(o => ({ text: o.label, callback_data: `wsl:sat:${r.log.id}:${o.epochMin}` })), 4);
    kb.push([{ text: t(r.lang, "wsl.btnNow", { time: wallHHMM(new Date()) }), callback_data: `wsl:snow:${r.log.id}` }]);
    try { await ctx.editMessageText(t(r.lang, "wsl.pickStart"), { reply_markup: { inline_keyboard: kb } }); } catch { /* ignore */ }
    return;
  });
  const doStart = async (ctx: Context, id: number, at: Date, source: "now" | "manual") => {
    const r = await ownLog(ctx, id);
    if (!r) return ctx.answerCbQuery(t("uk", "wsl.expired"));
    const res = await startLog(id, at, source);
    if (!res.ok) return ctx.answerCbQuery(t(r.lang, REASON_KEY[res.reason] ?? "wsl.expired"), { show_alert: true });
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
    await sendEndPrompt(res.log, r.lang, String(ctx.from!.id));
    return;
  };
  bot.action(/^wsl:snow:(\d+)$/, (ctx) => doStart(ctx, Number(ctx.match[1]), new Date(), "now"));
  bot.action(/^wsl:sat:(\d+):(\d+)$/, (ctx) => doStart(ctx, Number(ctx.match[1]), new Date(Number(ctx.match[2]) * 60_000), "manual"));

  bot.action(/^wsl:absent:(\d+)$/, async (ctx) => {
    const r = await ownLog(ctx, Number(ctx.match[1]));
    if (!r) return ctx.answerCbQuery(t("uk", "wsl.expired"));
    const res = await markAbsent(r.log.id);
    if (!res.ok) return ctx.answerCbQuery(t(r.lang, res.reason === "expired" ? "wsl.expired" : "wsl.done"), { show_alert: true });
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
    await ctx.reply(t(r.lang, "wsl.absentOk", { date: dayLbl(r.lang, String(r.log.workDate)) }), await menuFor(r.worker, r.lang));
    const [fac] = await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, r.log.factoryId));
    void notifyByType("no_show",
      `🚫 *Відсутній (сам відмітив у боті)*\n\n👷 *${mdSafe(r.worker.fullName)}*\n🏭 ${mdSafe(fac?.name ?? "—")} · ${ddmm(String(r.log.workDate))} · ${r.log.shift} зміна`,
      { parse_mode: "Markdown" }).catch(() => {});
    // той самий ланцюжок, що й при відмітці водієм: пояснення причини → довідки → офіс (bot/handlers/absences.ts)
    if (r.log.entryId) void notifyAbsentWorker(r.log.entryId, DOW_JS[new Date(String(r.log.workDate) + "T00:00:00").getDay()]!).catch(() => {});
    return;
  });

  bot.action(/^wsl:end:(\d+)$/, async (ctx) => {
    const r = await ownLog(ctx, Number(ctx.match[1]));
    if (!r) return ctx.answerCbQuery(t("uk", "wsl.expired"));
    if (r.log.status !== "open") return ctx.answerCbQuery(t(r.lang, r.log.status === "closed" ? "wsl.done" : "wsl.expired"), { show_alert: true });
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(nowEarlierKb(r.lang, `wsl:enow:${r.log.id}`, `wsl:epick:${r.log.id}`)); } catch { /* ignore */ }
    return;
  });
  bot.action(/^wsl:epick:(\d+)$/, async (ctx) => {
    const r = await ownLog(ctx, Number(ctx.match[1]));
    if (!r || r.log.status !== "open") return ctx.answerCbQuery(t(r?.lang ?? "uk", "wsl.expired"));
    await ctx.answerCbQuery();
    const opts = timeOptions(endPickRange(r.log, new Date()));
    const kb = grid(opts.map(o => ({ text: o.label, callback_data: `wsl:eat:${r.log.id}:${o.epochMin}` })), 4);
    kb.push([{ text: t(r.lang, "wsl.btnNow", { time: wallHHMM(new Date()) }), callback_data: `wsl:enow:${r.log.id}` }]);
    try { await ctx.editMessageText(t(r.lang, "wsl.pickEnd"), { reply_markup: { inline_keyboard: kb } }); } catch { /* ignore */ }
    return;
  });
  const doEnd = async (ctx: Context, id: number, at: Date, source: "now" | "manual") => {
    const r = await ownLog(ctx, id);
    if (!r) return ctx.answerCbQuery(t("uk", "wsl.expired"));
    const res = await endLog(id, at, source);
    if (!res.ok) return ctx.answerCbQuery(t(r.lang, REASON_KEY[res.reason] ?? "wsl.expired"), { show_alert: true });
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
    await ctx.reply(t(r.lang, "wsl.ended", { start: wallHHMM(res.log.startedAt!), end: wallHHMM(res.log.endedAt!), hours: res.log.hours ?? 0 }),
      { parse_mode: "Markdown", ...(await menuFor(r.worker, r.lang)) });
    return;
  };
  bot.action(/^wsl:enow:(\d+)$/, (ctx) => doEnd(ctx, Number(ctx.match[1]), new Date(), "now"));
  bot.action(/^wsl:eat:(\d+):(\d+)$/, (ctx) => doEnd(ctx, Number(ctx.match[1]), new Date(Number(ctx.match[2]) * 60_000), "manual"));

  // ── Рапорт за тиждень: табличка «день × зміна» в одному повідомленні (як доступність, views.ts) ──
  // Рядок на день: кнопки змін фабрики + «вих.»; одна зміна на день; за графіком уже відмічено,
  // тож більшість лише підтверджує. Далі тотал за тиждень текстом і фото рапорту.
  type DaySel = { shift: string | null; hours: number };
  async function beginReport(ctx: Context, worker: WorkerLike, lang: Lang, rep: { id: number; factoryId: number; weekStart: string | Date }) {
    const tid = String(ctx.from!.id);
    const weekStart = String(rep.weekStart);
    const { fac, rows } = await buildWeekRows(rep.factoryId, weekStart);
    if (!fac) { await ctx.reply(t(lang, "wkr.expired")); return; }
    const row = rows.find(r => r.workerId === worker.id);
    const n = Math.min(6, Math.max(1, fac.shiftCount ?? 3));
    const shiftsByDate: Record<string, ShiftOpt[]> = {};
    const days: Record<string, DaySel> = {};
    for (const date of weekDates(weekStart)) {
      const opts: ShiftOpt[] = [];
      for (let s = 1; s <= n; s++) {
        const st = await shiftTimeOn(fac, date, String(s));
        if (st) opts.push({ shift: String(s), start: st.start, end: st.end, hours: shiftDurationHours(st.start, st.end) });
      }
      shiftsByDate[date] = opts;
      // передзаповнення з графіку (не відсутній); години — з відмітки, якщо є, інакше тривалість зміни
      const c = row?.days[date];
      if (c?.entry && c.entry.status !== "absent") {
        const o = opts.find(x => x.shift === c.entry!.shift);
        const logged = c.log && (c.log.status === "closed" || c.log.status === "auto") ? c.log.hours : null;
        days[date] = { shift: c.entry.shift, hours: logged ?? o?.hours ?? c.entry.hours };
      } else days[date] = { shift: null, hours: 0 };
    }
    setState(tid, S_DAY, {
      repId: rep.id, workerId: worker.id, workerName: worker.fullName, factoryId: fac.id, factoryName: fac.name,
      weekStart, lang, days, shiftsByDate, msgId: null,
    });
    await sendGrid(ctx, tid);
  }

  async function sendGrid(ctx: Context, tid: string) {
    const st = getState(tid);
    if (!st || st.action !== S_DAY) return;
    const d = st.data; const lang = asLang(d.lang);
    const dates = weekDates(d.weekStart);
    const lines: string[] = []; let sum = 0;
    const kb = dates.map((date, i) => {
      const sel = d.days[date] as DaySel;
      const opts: ShiftOpt[] = d.shiftsByDate[date] ?? [];
      lines.push(`${dayLbl(lang, date)}: ${sel.shift ? `${t(lang, "hr.shiftN", { n: sel.shift })} · ${sel.hours} ${t(lang, "wkr.h")}` : t(lang, "wkr.dayOff")}`);
      sum += sel.shift ? sel.hours : 0;
      const btns = opts.map(o => ({ text: `${sel.shift === o.shift ? "✅ " : ""}${o.shift}`, callback_data: `wkr:g:${d.repId}:${i}:${o.shift}` }));
      btns.push({ text: `${sel.shift ? "" : "✅ "}${t(lang, "wkr.btnOffShort")}`, callback_data: `wkr:g:${d.repId}:${i}:0` });
      return [{ text: dayLbl(lang, date), callback_data: `wkr:n:${d.repId}` }, ...btns];
    });
    kb.push([{ text: t(lang, "wkr.btnConfirm"), callback_data: `wkr:c:${d.repId}` }]);
    kb.push([{ text: t(lang, "hr.cancel"), callback_data: `wkr:x:${d.repId}` }]);
    const shiftsLegend = ((d.shiftsByDate[dates[0]!] ?? []) as ShiftOpt[]).map(o => `${o.shift} — ${o.start}–${o.end}`).join(", ");
    const text = t(lang, "wkr.gridTitle", { from: ddmm(d.weekStart), to: ddmm(weekEnd(d.weekStart)), factory: mdSafe(d.factoryName), legend: shiftsLegend })
      + "\n\n" + mdSafe(lines.join("\n")) + "\n\n" + t(lang, "wkr.gridSum", { sum: round2(sum) });
    const extra = { parse_mode: "Markdown" as const, reply_markup: { inline_keyboard: kb } };
    if (d.msgId) {
      try { await ctx.telegram.editMessageText(tid, d.msgId, undefined, text, extra); return; } catch { /* нижче — нове повідомлення */ }
    }
    const msg = await ctx.telegram.sendMessage(tid, text, extra);
    setState(tid, S_DAY, { ...d, msgId: msg.message_id });
    return;
  }

  const daysSummary = (lang: Lang, d: any) => {
    const lines: string[] = []; let sum = 0;
    for (const date of weekDates(d.weekStart)) {
      const v = d.days[date] as DaySel | undefined;
      if (v?.shift) { lines.push(`${dayLbl(lang, date)} — ${t(lang, "hr.shiftN", { n: v.shift })} (${v.hours})`); sum += v.hours; }
      else lines.push(`${dayLbl(lang, date)} — ${t(lang, "wkr.dayOff")}`);
    }
    return { summary: lines.join("\n"), sum: round2(sum) };
  };

  // стан чистимо лише якщо він досі про ЦЕЙ рапорт (людина могла відкрити інший, поки йшло завантаження)
  const clearIfMine = (tid: string, repId: number) => {
    const st = getState(tid);
    if (st && st.action.startsWith("wkr:") && st.data.repId === repId) clearState(tid);
  };
  async function finish(ctx: Context, tid: string, d: any, hoursReported: number, photoLink: string | null) {
    clearIfMine(tid, d.repId);
    const worker = await getWorker(tid);
    const lang = asLang(d.lang);
    const menu = await menuFor(worker, lang);
    const days: Record<string, DaySel> = {};
    for (const date of weekDates(d.weekStart)) days[date] = d.days[date] ?? { shift: null, hours: 0 };
    await saveWeeklyReport(d.repId, { days, hoursReported, photoLink });
    const p = { from: ddmm(d.weekStart), to: ddmm(weekEnd(d.weekStart)), hours: hoursReported };
    return ctx.reply(t(lang, hoursReported > 0 ? "wkr.saved" : "wkr.savedNoWork", p), { parse_mode: "Markdown", ...menu });
  }

  bot.action(/^wkr:go:(\d+)$/, async (ctx) => {
    const tid = String(ctx.from.id);
    const worker = await getWorker(tid);
    const [rep] = await db.select().from(weeklyReportsTable).where(eq(weeklyReportsTable.id, Number(ctx.match[1])));
    if (!worker || !rep || rep.workerId !== worker.id) { await ctx.answerCbQuery(); return ctx.reply(t(asLang(worker?.language), "wkr.expired")); }
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
    return beginReport(ctx, worker, asLang(worker.language), rep);
  });
  // Рапорт за тиждень — лише з автоматичного запиту (понеділок/вівторок, або «Нагадати» з вкладки тижня)
  // за ПОПЕРЕДНІЙ тиждень (рішення власника 26.10.2026); «📄 Рапорт» у меню лишається місячним, як скрізь.

  const gridState = (ctx: Context, repId: number) => {
    const st = getState(String(ctx.from!.id));
    return st && st.action === S_DAY && st.data.repId === repId ? st : null;
  };
  bot.action(/^wkr:n:(\d+)$/, (ctx) => ctx.answerCbQuery()); // підпис дня — не кнопка
  bot.action(/^wkr:g:(\d+):(\d):(\d)$/, async (ctx) => {
    const tid = String(ctx.from.id);
    const st = gridState(ctx, Number(ctx.match[1]));
    if (!st) return ctx.answerCbQuery(t("uk", "wkr.expired"));
    const d = st.data;
    const date = weekDates(d.weekStart)[Number(ctx.match[2])];
    if (!date) return ctx.answerCbQuery();
    const v = ctx.match[3]!;
    const opt = (d.shiftsByDate[date] as ShiftOpt[] | undefined)?.find(o => o.shift === v);
    const days = { ...d.days, [date]: v === "0" || !opt ? { shift: null, hours: 0 } : { shift: opt.shift, hours: opt.hours } };
    setState(tid, S_DAY, { ...d, days });
    await ctx.answerCbQuery();
    return sendGrid(ctx, tid);
  });
  bot.action(/^wkr:x:(\d+)$/, async (ctx) => {
    const tid = String(ctx.from.id);
    const st = gridState(ctx, Number(ctx.match[1]));
    await ctx.answerCbQuery();
    if (!st) return;
    const lang = asLang(st.data.lang);
    clearState(tid);
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
    return ctx.reply(t(lang, "wkr.cancelled"), await menuFor(await getWorker(tid), lang));
  });
  bot.action(/^wkr:c:(\d+)$/, async (ctx) => {
    const tid = String(ctx.from.id);
    const st = gridState(ctx, Number(ctx.match[1]));
    if (!st) return ctx.answerCbQuery(t("uk", "wkr.expired"));
    const d = st.data; const lang = asLang(d.lang);
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
    const { summary, sum } = daysSummary(lang, d);
    setState(tid, S_TOTAL, { ...d });
    return ctx.reply(t(lang, "wkr.askTotal", { from: ddmm(d.weekStart), to: ddmm(weekEnd(d.weekStart)), summary: mdSafe(summary), sum }), { parse_mode: "Markdown", ...cancelKb(lang) });
  });

  bot.on("text", async (ctx, next) => {
    const tid = String(ctx.from.id);
    const st = getState(tid);
    if (!st || (st.action !== S_TOTAL && st.action !== S_PHOTO)) return next();
    const d = st.data; const lang = asLang(d.lang);
    const text = ctx.message.text.trim();
    if (trAll("hr.cancel").includes(text) || trAll("menu.back").includes(text)) return next(); // глобальне «Скасувати»
    if (st.action === S_PHOTO) return ctx.reply(t(lang, "report.needPhoto"), { parse_mode: "Markdown", ...cancelKb(lang) });
    const hours = parseFloat(text.replace(",", ".").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(hours) || hours < 0 || hours > 120) return ctx.reply(t(lang, "wkr.badTotal"));
    const h = round2(hours);
    const anyShift = Object.values(d.days as Record<string, { shift: string | null }>).some(v => v.shift);
    if (h === 0 && !anyShift) return finish(ctx, tid, d, 0, null);
    setState(tid, S_PHOTO, { ...d, hoursReported: h });
    return ctx.reply(t(lang, "wkr.askPhoto", { from: ddmm(d.weekStart), to: ddmm(weekEnd(d.weekStart)), hours: h }), { parse_mode: "Markdown", ...cancelKb(lang) });
  });

  const onFile = async (ctx: Context, fileId: string, mime: string): Promise<boolean> => {
    const tid = String(ctx.from!.id);
    const st = getState(tid);
    if (!st || st.action !== S_PHOTO) return false;
    const d = st.data; const lang = asLang(d.lang);
    if (!mime.startsWith("image/")) { await ctx.reply(t(lang, "report.needPhoto"), { parse_mode: "Markdown", ...cancelKb(lang) }); return true; }
    await ctx.reply(t(lang, "report.uploading"));
    try {
      const link = await ctx.telegram.getFileLink(fileId);
      const resp = await fetch(link.href);
      const buf = Buffer.from(await resp.arrayBuffer());
      const [prev] = await db.select({ link: weeklyReportsTable.photoLink }).from(weeklyReportsTable).where(eq(weeklyReportsTable.id, d.repId));
      // файл тижня у папці місяця (ISO-місяць тижня); повторна здача дописує сторінку в той самий PDF
      const photoLink = await uploadReportPhoto(d.factoryName, d.workerName, isoMonthOfWeek(d.weekStart), buf, mime, prev?.link ?? null, `tydzień ${weekLabel(d.weekStart)}`);
      if (!photoLink) { await ctx.reply(t(lang, "report.photoFail"), { parse_mode: "Markdown", ...cancelKb(lang) }); return true; }
      await finish(ctx, tid, d, d.hoursReported, photoLink);
    } catch (e) {
      logger.error({ err: e }, "weekly report upload failed");
      clearIfMine(tid, d.repId);
      await ctx.reply(t(lang, "report.uploadErr"), await menuFor(await getWorker(tid), lang));
    }
    return true;
  };
  bot.on("photo", async (ctx, next) => {
    const photo = ctx.message.photo.at(-1)!;
    if (!(await onFile(ctx, photo.file_id, "image/jpeg"))) return next();
  });
  bot.on("document", async (ctx, next) => {
    const doc = ctx.message.document;
    if (!(await onFile(ctx, doc.file_id, doc.mime_type ?? ""))) return next();
  });
}

export { Markup };

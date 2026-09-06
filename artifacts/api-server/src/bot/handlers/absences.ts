// «🚫 Мої пропуски» — працівник бачить свої відсутності (status='absent') за
// місяць: виправдані (absence_excused) / невиправдані, з датою, зміною, фабрикою
// і поясненням; кнопка на попередній місяць. Тут же — одноразове пояснення
// пропуску (текст; той самий флоу після пуша «вас відмітили відсутнім» —
// notify.ts ставить стан S_REASON) і ОКРЕМА необовʼязкова опція «📎 Додати
// фото/документ» (одна довідка/скріншот до вже поясненого пропуску: кнопка під
// підтвердженням і в списку).
// Реєструється РАНІШЕ за загальні bot.on("photo"/"document"/"text") в index.ts —
// чужі стани пропускає далі через next().
import { Markup, type Telegraf } from "telegraf";
import path from "node:path";
import fs from "node:fs";
import {
  db, scheduleEntriesTable, scheduleWeeksTable, factoriesTable, absenceAttachmentsTable,
  type Shift, type DayOfWeek,
} from "@workspace/db";
import { and, eq, gte, lt, inArray, desc } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { ABSENCE_DOCS_DIR, makeStoredName, sniffDocMime, shrinkDocBuffer, shrinkImageBuffer } from "../../lib/uploads";
import { entryDateStr, weekFromForMonth } from "../../lib/dates";
import { setState, getState, clearState } from "../state";
import { getWorker } from "../roles";
import { t, trAll, asLang, dayShort, DATE_LOCALE, type Lang } from "../i18n";
import { mdSafe, DAY_UK, SHIFT_SHORT } from "../display";
import { nowWarsaw } from "../time";
import { notifyAdmins, notifyAdminsFile } from "../notify";

export const S_REASON = "absent:explain_reason"; // data: entryId, day, shift, name
const S_ATTACH = "absent:attach";                 // data: entryId, name, day, shift, date, reason; чекаємо один файл
const MAX_BYTES = 15 * 1024 * 1024;

type WorkerLike = { id: number; factoryId?: number | null; language?: string | null; fullName: string };
type MenuFor = (worker: WorkerLike | undefined, lang: Lang) => Promise<any>;

const wlang = (w?: { language?: string | null } | null): Lang => asLang(w?.language);
// Кнопки меню/скасування будь-якою мовою — не приймати їх як текст причини:
// стан скидається, а натискання йде далі до звичайного хендлера кнопки.
const MENU_KEYS = ["hr.cancel", "menu.schedule", "menu.availability", "menu.factoryInfo", "menu.myHours", "menu.absence", "menu.myAbsences", "menu.myInfo", "menu.referral", "menu.report", "menu.advance", "menu.language"];
const MENU_TEXTS = new Set(MENU_KEYS.flatMap(k => trAll(k)));
const cancelKb = (lang: Lang) => Markup.keyboard([[t(lang, "hr.cancel")]]).resize();
const monthLabel = (lang: Lang, m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(DATE_LOCALE[lang], { month: "long", year: "numeric" });
const monthStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const shiftLabel = (lang: Lang, s: Shift) => t(lang, "hr.shiftN", { n: s });
const fmtDate = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
const ymdWarsaw = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }); // YYYY-MM-DD

// Відсутності працівника за календарний місяць (approved-тижні, дата — фактична дата зміни).
async function loadMonthAbsences(workerId: number, month: string) {
  const monthStart = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const monthEnd = m === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  const rows = await db
    .select({
      id: scheduleEntriesTable.id, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift,
      reason: scheduleEntriesTable.absenceReason, excused: scheduleEntriesTable.absenceExcused,
      explainedAt: scheduleEntriesTable.absenceExplainedAt,
      factoryName: factoriesTable.name, weekStart: scheduleWeeksTable.weekStart,
    })
    .from(scheduleEntriesTable)
    .innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(
      eq(scheduleEntriesTable.workerId, workerId), eq(scheduleEntriesTable.status, "absent"),
      eq(scheduleWeeksTable.status, "approved"),
      gte(scheduleWeeksTable.weekStart, weekFromForMonth(monthStart)), lt(scheduleWeeksTable.weekStart, monthEnd),
    ));
  const items = rows
    .map(r => ({ ...r, date: entryDateStr(String(r.weekStart), r.day), files: 0 }))
    .filter(r => r.date >= monthStart && r.date < monthEnd)
    .sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));
  if (items.length) {
    const att = await db.select({ entryId: absenceAttachmentsTable.entryId }).from(absenceAttachmentsTable)
      .where(inArray(absenceAttachmentsTable.entryId, items.map(i => i.id)));
    for (const a of att) { const it = items.find(i => i.id === a.entryId); if (it) it.files++; }
  }
  return items;
}

async function renderAbsences(worker: WorkerLike, lang: Lang, month: string) {
  const items = await loadMonthAbsences(worker.id, month);
  let msg = t(lang, "wabs.title", { month: monthLabel(lang, month) });
  const line = (i: typeof items[number]) => {
    const head = `\n• *${fmtDate(i.date)}* (${dayShort(lang, i.day)}) · ${shiftLabel(lang, i.shift as Shift)} · ${mdSafe(i.factoryName ?? "—")}`;
    // Пояснення, внесене працівником у боті, — з датою внесення (може бути значно пізніше за пропуск).
    const at = i.explainedAt ? ` _(${t(lang, "wabs.explainedAt", { date: fmtDate(ymdWarsaw(i.explainedAt)) })})_` : "";
    const reason = i.reason ? `💬 ${mdSafe(i.reason)}${at}` : t(lang, "wabs.noReason");
    return `${head}\n   ${reason}${i.files ? ` · 📎 ${i.files}` : ""}`;
  };
  if (!items.length) msg += t(lang, "wabs.none");
  else {
    const just = items.filter(i => i.excused), unjust = items.filter(i => !i.excused);
    if (just.length) msg += t(lang, "wabs.justified", { n: just.length }) + just.map(line).join("");
    if (unjust.length) msg += t(lang, "wabs.unjustified", { n: unjust.length }) + unjust.map(line).join("");
    msg += t(lang, "wabs.hint");
  }
  // Пояснити можна лише пропуск без пояснення (одноразово); документ — один,
  // додається окремо до пропуску, який працівник уже пояснив сам.
  const kb: { text: string; callback_data: string }[][] = items
    .filter(i => !i.reason)
    .map(i => [{ text: t(lang, "wabs.explainBtn", { date: fmtDate(i.date), shift: shiftLabel(lang, i.shift as Shift) }), callback_data: `wabs:ex:${i.id}` }]);
  for (const i of items.filter(i => i.reason && i.explainedAt && !i.files))
    kb.push([{ text: t(lang, "wabs.attachListBtn", { date: fmtDate(i.date), shift: shiftLabel(lang, i.shift as Shift) }), callback_data: `wabs:att:${i.id}` }]);
  const cur = monthStr(nowWarsaw());
  if (month === cur) {
    const prev = new Date(`${month}-01T00:00:00`); prev.setMonth(prev.getMonth() - 1);
    kb.push([{ text: t(lang, "wabs.prevMonth", { month: monthLabel(lang, monthStr(prev)) }), callback_data: `wabs:m:${monthStr(prev)}` }]);
  } else {
    kb.push([{ text: t(lang, "wabs.curMonth", { month: monthLabel(lang, cur) }), callback_data: `wabs:m:${cur}` }]);
  }
  return { msg, kb };
}

// Скачати файл з Telegram, перевірити тип магічними байтами, стиснути, зберегти.
async function storeAttachment(ctx: any, worker: WorkerLike, entryId: number, fileId: string, kind: "photo" | "document", fileName: string): Promise<boolean> {
  const link = await ctx.telegram.getFileLink(fileId);
  let buf: Buffer = Buffer.from(await (await fetch(link.href)).arrayBuffer());
  if (buf.length > MAX_BYTES) return false;
  let mime: string | null = sniffDocMime(buf);
  if (!mime || !(mime.startsWith("image/") || mime === "application/pdf")) return false;
  if (mime === "application/pdf") buf = await shrinkDocBuffer(buf, mime, logger);
  else ({ buf, mime } = await shrinkImageBuffer(buf, mime, logger));
  const ext = mime === "application/pdf" ? ".pdf" : mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
  const stored = makeStoredName(`a${ext}`);
  fs.mkdirSync(ABSENCE_DOCS_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(ABSENCE_DOCS_DIR, stored), buf);
  await db.insert(absenceAttachmentsTable).values({
    entryId, workerId: worker.id, filePath: path.join("absence-attachments", stored),
    fileName: fileName || `absence-${entryId}${ext}`, fileMime: mime, tgFileId: fileId, tgKind: kind,
  });
  return true;
}

const whenLine = (data: Record<string, any>) => data.date
  ? `📅 ${fmtDate(data.date)} · ${DAY_UK[data.day as DayOfWeek]} ${SHIFT_SHORT[data.shift as Shift]}`
  : `📅 ${DAY_UK[data.day as DayOfWeek]} ${SHIFT_SHORT[data.shift as Shift]}`;

// Завершення пояснення: сповіщення адмінам і пропозиція (необовʼязкова) додати документ.
async function finishExplanation(ctx: any, tid: string, worker: WorkerLike | undefined, data: Record<string, any>, menuFor: MenuFor) {
  clearState(tid);
  const lang = wlang(worker);
  await notifyAdmins("no_show",
    `📝 *Пояснення відсутності*\n\n👷 *${mdSafe(data.name)}*\n${whenLine(data)}\n\nПричина: ${mdSafe(data.reason)}`,
    { parse_mode: "Markdown" },
  );
  await ctx.reply(t(lang, "wabs.sent"), await menuFor(worker, lang));
  return ctx.reply(t(lang, "wabs.attachHint").trim(), {
    reply_markup: { inline_keyboard: [[{ text: t(lang, "wabs.attachBtn"), callback_data: `wabs:att:${data.entryId}` }]] },
  });
}

// Документ додано: адмінам — контекст + сам файл (пересилка по file_id).
async function finishAttachment(ctx: any, tid: string, worker: WorkerLike, data: Record<string, any>, menuFor: MenuFor) {
  clearState(tid);
  const lang = wlang(worker);
  const [f] = await db.select().from(absenceAttachmentsTable)
    .where(eq(absenceAttachmentsTable.entryId, Number(data.entryId))).orderBy(desc(absenceAttachmentsTable.id)).limit(1);
  await notifyAdmins("no_show",
    `📎 *Документ до пояснення відсутності*\n\n👷 *${mdSafe(data.name)}*\n${whenLine(data)}\n\nПричина: ${mdSafe(data.reason)}\n_(файл нижче; також на сторінці «Відсутності»)_`,
    { parse_mode: "Markdown" },
  );
  if (f?.tgFileId) await notifyAdminsFile("no_show", f.tgFileId, f.tgKind === "photo" ? "photo" : "document", `📎 ${data.name}`);
  return ctx.reply(t(lang, "wabs.fileSaved"), await menuFor(worker, lang));
}

export function registerWorkerAbsences(bot: Telegraf<any>, menuFor: MenuFor) {
  bot.hears(trAll("menu.myAbsences"), async (ctx) => {
    const worker = await getWorker(String(ctx.from.id));
    const lang = wlang(worker);
    if (!worker) return ctx.reply(t(lang, "notRegistered"));
    const { msg, kb } = await renderAbsences(worker, lang, monthStr(nowWarsaw()));
    return ctx.reply(msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } });
  });

  // Перемикання місяця — редагуємо те саме повідомлення.
  bot.action(/^wabs:m:(\d{4}-\d{2})$/, async (ctx) => {
    const worker = await getWorker(String(ctx.from!.id));
    await ctx.answerCbQuery().catch(() => {});
    if (!worker) return;
    const lang = wlang(worker);
    const { msg, kb } = await renderAbsences(worker, lang, (ctx.match as RegExpMatchArray)[1]!);
    return ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } })
      .catch(() => ctx.reply(msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } }));
  });

  // «✍️ Пояснити» зі списку — лише свій пропуск і лише без пояснення.
  bot.action(/^wabs:ex:(\d+)$/, async (ctx) => {
    const tid = String(ctx.from!.id);
    const worker = await getWorker(tid);
    await ctx.answerCbQuery().catch(() => {});
    if (!worker) return;
    const lang = wlang(worker);
    const entryId = Number((ctx.match as RegExpMatchArray)[1]);
    const [e] = await db
      .select({
        id: scheduleEntriesTable.id, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift,
        reason: scheduleEntriesTable.absenceReason, status: scheduleEntriesTable.status,
        factoryName: factoriesTable.name, weekStart: scheduleWeeksTable.weekStart,
      })
      .from(scheduleEntriesTable)
      .innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
      .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
      .where(and(eq(scheduleEntriesTable.id, entryId), eq(scheduleEntriesTable.workerId, worker.id)));
    if (!e || e.status !== "absent") return;
    if (e.reason) return ctx.reply(t(lang, "wabs.alreadyExplained"));
    const date = entryDateStr(String(e.weekStart), e.day);
    setState(tid, S_REASON, { entryId: e.id, day: e.day, shift: e.shift, name: worker.fullName, date });
    return ctx.reply(
      t(lang, "wabs.askReason", { date: fmtDate(date), shift: shiftLabel(lang, e.shift as Shift), factory: mdSafe(e.factoryName ?? "—") }),
      { parse_mode: "Markdown", ...cancelKb(lang) },
    );
  });

  // «📎 Додати фото/документ» — лише до свого пропуску, який працівник уже пояснив сам, і лише один файл.
  bot.action(/^wabs:att:(\d+)$/, async (ctx) => {
    const tid = String(ctx.from!.id);
    const worker = await getWorker(tid);
    await ctx.answerCbQuery().catch(() => {});
    if (!worker) return;
    const lang = wlang(worker);
    const entryId = Number((ctx.match as RegExpMatchArray)[1]);
    const [e] = await db
      .select({
        id: scheduleEntriesTable.id, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift,
        reason: scheduleEntriesTable.absenceReason, explainedAt: scheduleEntriesTable.absenceExplainedAt, status: scheduleEntriesTable.status,
        weekStart: scheduleWeeksTable.weekStart,
      })
      .from(scheduleEntriesTable)
      .innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
      .where(and(eq(scheduleEntriesTable.id, entryId), eq(scheduleEntriesTable.workerId, worker.id)));
    if (!e || e.status !== "absent" || !e.reason || !e.explainedAt) return;
    const [has] = await db.select({ id: absenceAttachmentsTable.id }).from(absenceAttachmentsTable).where(eq(absenceAttachmentsTable.entryId, e.id)).limit(1);
    if (has) return ctx.reply(t(lang, "wabs.hasFile"));
    setState(tid, S_ATTACH, { entryId: e.id, day: e.day, shift: e.shift, name: worker.fullName, date: entryDateStr(String(e.weekStart), e.day), reason: e.reason });
    return ctx.reply(t(lang, "wabs.askFiles"), cancelKb(lang));
  });

  bot.on("text", async (ctx, next) => {
    const tid = String(ctx.from.id);
    const state = getState(tid);
    if (state?.action === S_REASON) {
      const { data } = state;
      const text = ctx.message.text.trim();
      if (MENU_TEXTS.has(text)) { clearState(tid); return next(); }
      if (!text) return;
      const worker = await getWorker(tid);
      const lang = wlang(worker);
      // Повторне пояснення заборонене: якщо причина вже є (напр. поставив адмін) — не перезаписуємо.
      const [cur] = await db.select({ reason: scheduleEntriesTable.absenceReason }).from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, Number(data.entryId)));
      if (cur?.reason) { clearState(tid); return ctx.reply(t(lang, "wabs.alreadyExplained"), await menuFor(worker, lang)); }
      await db.update(scheduleEntriesTable).set({ absenceReason: text, absenceExplainedAt: new Date() }).where(eq(scheduleEntriesTable.id, Number(data.entryId)));
      return finishExplanation(ctx, tid, worker, { ...data, reason: text }, menuFor);
    }
    if (state?.action === S_ATTACH) {
      // Текст замість файлу (кнопка меню тощо) — виходимо зі стану, натискання йде далі.
      clearState(tid);
      return next();
    }
    return next();
  });

  // Один файл: прийняли → зберегли → адмінам контекст + файл.
  const onFile = async (ctx: any, fileId: string, kind: "photo" | "document", fileName: string) => {
    const tid = String(ctx.from.id);
    const state = getState(tid);
    if (state?.action !== S_ATTACH) return false;
    const worker = await getWorker(tid);
    const lang = wlang(worker);
    if (!worker) return true;
    let ok = false;
    try { ok = await storeAttachment(ctx, worker, Number(state.data.entryId), fileId, kind, fileName); }
    catch (e: any) { logger.warn({ err: e?.message }, "absence attachment failed"); }
    if (!ok) { await ctx.reply(t(lang, "wabs.fileBad"), cancelKb(lang)); return true; }
    await finishAttachment(ctx, tid, worker, state.data, menuFor);
    return true;
  };

  bot.on("photo", async (ctx, next) => {
    const photo = ctx.message.photo.at(-1)!;
    if (!(await onFile(ctx, photo.file_id, "photo", "photo.jpg"))) return next();
  });
  bot.on("document", async (ctx, next) => {
    const doc = ctx.message.document;
    if (!(await onFile(ctx, doc.file_id, "document", doc.file_name ?? "document"))) return next();
  });
}

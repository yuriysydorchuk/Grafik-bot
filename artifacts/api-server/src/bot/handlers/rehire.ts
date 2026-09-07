// Повернення звільненого працівника («Повернутися на роботу»). Усі входи ведуть
// в один флоу: питання працівнику → запит офісу (owner + scheduler, той самий
// адресат, що й алерт «зареєструвався сам») → один тап «✅ Відновити» /
// «❌ Відхилити» → services/workerRehire.restoreWorker. Новий профіль НЕ
// створюється: старий (історія, №, документи, рапорти) знову активний з
// фабрикою лінка і, за потреби, новим Telegram (старий — у журналі змін).
//
// Входи: ?start=fac<id>/facs<id> тим самим Telegram (bot/index.ts → offerRehire),
// ім'я в чаті за старим лінком новим Telegram (completeNameSignup → «Це я?»),
// скан паспорта за новим лінком (routes/passportScan.ts → requestRehire).
// Стан очікування — bot_states (S_PENDING на tg заявника), рішення — callback-дані.
import { Markup, type Telegraf, type Context } from "telegraf";
import { db, workersTable, factoriesTable, adminsTable } from "@workspace/db";
import type { Worker } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { nextWorkerCode } from "../../lib/workerCode";
import { setState, getState, clearState } from "../state";
import { getAdmin } from "../roles";
import { t, tb, asLang, oLang, DATE_LOCALE, type Lang } from "../i18n";
import { mdSafe, escapeHtml } from "../display";
import { findLikelyDuplicate } from "../workerMatch";
import { bot } from "../instance";
import { restoreWorker } from "../../services/workerRehire";

export const S_ISYOU = "rehire:isyou";     // новий tg, ім'я збіглось зі звільненим: data: workerId, factoryId, factoryName, lang, fullName
export const S_PENDING = "rehire:pending"; // запит в офісі: data: workerId, factoryId, lang, adminMsgs[]

type MenuFor = (worker: { factoryId?: number | null } | null | undefined, lang: Lang) => Promise<any>;
let menuFor: MenuFor = async () => Markup.removeKeyboard();

type AdminMsg = { chatId: string; messageId: number; lang: Lang; text: string };
type SignupData = { fullName: string; factoryId: number; factoryName: string; lang: Lang };

const fmtDate = (d: Date | string | null | undefined, lang: Lang) =>
  d ? new Date(d).toLocaleDateString(DATE_LOCALE[lang]) : "—";

export async function firedWorkerByTg(tid: string): Promise<Worker | undefined> {
  const [w] = await db.select().from(workersTable).where(and(eq(workersTable.telegramId, tid), eq(workersTable.isActive, false)));
  return w;
}

async function factoryName(id: number | null | undefined): Promise<string> {
  if (id == null) return "—";
  const [f] = await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, id));
  return f?.name ?? "—";
}

// Той самий Telegram, профіль звільнений, фабрика відома з лінка → одразу
// «Повертаєтесь на {factory}?» (крок вибору фабрики не потрібен).
export async function offerRehire(ctx: Context, worker: Worker, factory: { id: number; name: string }) {
  const tid = String(ctx.from!.id);
  const lang = asLang(worker.language);
  const st = getState(tid);
  if (st?.action === S_PENDING) return ctx.reply(t(lang, "rehire.alreadyPending"));
  return ctx.reply(
    t(lang, "rehire.offer", { name: mdSafe(worker.fullName), date: fmtDate(worker.firedAt, lang), factory: mdSafe(factory.name) }),
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[
      Markup.button.callback(t(lang, "rehire.yes"), `rh:yes:${factory.id}`),
      Markup.button.callback(t(lang, "rehire.no"), "rh:no"),
    ]]) },
  );
}

// Запит офісу: одне повідомлення owner + scheduler з кнопками рішення. Перший,
// хто натиснув, вирішує; повідомлення в усіх адресатів редагується (ids —
// у pending-стані заявника). newTelegram = tg заявника ≠ tg у профілі.
export async function requestRehire(opts: { worker: Worker; factoryId: number; tid: string; lang?: Lang }): Promise<void> {
  const { worker, factoryId, tid } = opts;
  const lang = opts.lang ?? asLang(worker.language);
  const [fac, oldFac] = await Promise.all([factoryName(factoryId), factoryName(worker.factoryId)]);
  const newTelegram = worker.telegramId !== tid;
  const kb = (al: Lang) => ({ inline_keyboard: [[
    { text: tb(al, "✅ Відновити"), callback_data: `rhadm:ok:${worker.id}:${factoryId}:${tid}` },
    { text: tb(al, "❌ Відхилити"), callback_data: `rhadm:no:${worker.id}:${factoryId}:${tid}` },
  ]] });
  const adminMsgs: AdminMsg[] = [];
  const staff = await db.select().from(adminsTable);
  for (const a of staff) {
    if (!a.telegramId || (a.role !== "owner" && a.role !== "scheduler")) continue;
    const al = oLang(a.language);
    const text = tb(al, "🔄 <b>{name}</b> (№{code}, звільнений {date}, був на {oldFactory}) просить повернутись на <b>{factory}</b>.", {
      name: escapeHtml(worker.fullName), code: worker.workerCode ?? String(worker.id), date: fmtDate(worker.firedAt, al),
      oldFactory: escapeHtml(oldFac), factory: escapeHtml(fac),
    }) + (newTelegram ? "\n" + tb(al, "⚠️ Новий Telegram-акаунт (старий: {old})", { old: worker.telegramId ?? "—" }) : "");
    try {
      const m = await bot.telegram.sendMessage(a.telegramId, text, { parse_mode: "HTML", reply_markup: kb(al) });
      adminMsgs.push({ chatId: a.telegramId, messageId: m.message_id, lang: al, text });
    } catch (e) { logger.warn({ err: e, adminId: a.id }, "rehire request send failed"); }
  }
  setState(tid, S_PENDING, { workerId: worker.id, factoryId, lang, adminMsgs });
  await bot.telegram.sendMessage(tid, t(lang, "rehire.sent"), Markup.removeKeyboard()).catch(() => {});
}

async function finalizeAdminMsgs(msgs: AdminMsg[] | undefined, ok: boolean, adminName: string) {
  for (const m of msgs ?? []) {
    const line = tb(m.lang, ok ? "✅ Відновив(ла) {admin}" : "❌ Відхилив(ла) {admin}", { admin: escapeHtml(adminName) });
    await bot.telegram.editMessageText(m.chatId, m.messageId, undefined, `${m.text}\n\n${line}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

// Завершення самореєстрації за СТАРИМ лінком (?start=fac<id>, ім'я в чаті) —
// перенесено з bot/index.ts: тут перехоплюється дубль зі звільненим профілем
// («Це я?» замість нового профілю). skipRehireAsk — людина вже відповіла «Ні».
export async function completeNameSignup(ctx: Context, tid: string, data: SignupData, opts: { skipRehireAsk?: boolean } = {}) {
  const { fullName, factoryId, factoryName: facName, lang } = data;
  // Дублікат-детект: звільнений профіль → пропонуємо повернення (профіль НЕ
  // створюємо); активний → створюємо, адмін отримує «Обʼєднати» / «Різні люди».
  const dup = findLikelyDuplicate(fullName, await db.select().from(workersTable));
  if (dup && !dup.isActive && !opts.skipRehireAsk) {
    setState(tid, S_ISYOU, { workerId: dup.id, factoryId, factoryName: facName, lang, fullName });
    return ctx.reply(
      t(lang, "rehire.isYou", { name: mdSafe(dup.fullName), code: dup.workerCode ?? String(dup.id) }),
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[
        Markup.button.callback(t(lang, "rehire.me"), "rh:me"),
        Markup.button.callback(t(lang, "rehire.notMe"), "rh:notme"),
      ]]) },
    );
  }
  const code = await nextWorkerCode();
  const [freshWorker] = await db.insert(workersTable).values({
    fullName, factoryId, telegramId: tid, workerCode: code, language: lang,
  }).returning();
  clearState(tid);
  // best-effort: let the owner + scheduler know someone self-registered (to verify/edit)
  try {
    const staff = await db.select().from(adminsTable);
    const dupNote = dup
      ? `\n⚠️ Можливий дублікат: схожий профіль <b>${escapeHtml(dup.fullName)}</b> №${escapeHtml(dup.workerCode ?? String(dup.id))}${dup.isActive ? "" : " (звільнений)"}.`
      : "";
    const dupKb = dup && freshWorker ? {
      inline_keyboard: [[
        { text: `🔗 Обʼєднати (лишити №${dup.workerCode ?? dup.id})`, callback_data: `wmerge_${dup.id}_${freshWorker.id}` },
        { text: "👥 Різні люди", callback_data: "wmerge_skip" },
      ]],
    } : undefined;
    for (const a of staff) {
      if (!a.telegramId) continue;
      if (a.role !== "owner" && a.role !== "scheduler") continue;
      await bot.telegram.sendMessage(
        a.telegramId,
        `🆕 Новий працівник зареєструвався сам (старий лінк, без анкети):\n👤 <b>${escapeHtml(fullName)}</b>\n🏭 ${escapeHtml(facName ?? "")}${dupNote}\n\nПеревірте/відредагуйте в панелі (Працівники) і попросіть скан паспорта.`,
        { parse_mode: "HTML", ...(dupKb ? { reply_markup: dupKb } : {}) },
      );
    }
  } catch { /* notification is best-effort */ }
  return ctx.reply(
    t(lang, "signup.done", { name: mdSafe(fullName), factory: mdSafe(facName) }),
    { parse_mode: "Markdown", ...(await menuFor({ factoryId }, lang)) },
  );
}

export function registerRehire(botT: Telegraf<any>, menuForFn: MenuFor) {
  menuFor = menuForFn;

  // Той самий Telegram: «Повертаєтесь на {factory}?»
  botT.action(/^rh:yes:(\d+)$/, async (ctx): Promise<void> => {
    const tid = String(ctx.from!.id);
    const factoryId = Number((ctx as any).match[1]);
    const worker = await firedWorkerByTg(tid);
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    if (!worker) return;
    if (getState(tid)?.action === S_PENDING) { await ctx.reply(t(asLang(worker.language), "rehire.alreadyPending")); return; }
    await requestRehire({ worker, factoryId, tid });
  });
  botT.action("rh:no", async (ctx) => {
    const tid = String(ctx.from!.id);
    const worker = await firedWorkerByTg(tid);
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return ctx.reply(t(asLang(worker?.language), "rehire.declined"), Markup.removeKeyboard());
  });

  // Новий Telegram, ім'я збіглось зі звільненим: «Це я?» → «Оновити Telegram?»
  botT.action("rh:me", async (ctx) => {
    const tid = String(ctx.from!.id);
    const st = getState(tid);
    await ctx.answerCbQuery();
    if (st?.action !== S_ISYOU) return;
    const lang = asLang(st.data.lang);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return ctx.reply(t(lang, "rehire.updateTg"), Markup.inlineKeyboard([[
      Markup.button.callback(t(lang, "rehire.yes"), "rh:tg:yes"),
      Markup.button.callback(t(lang, "rehire.no"), "rh:tg:no"),
    ]]));
  });
  botT.action("rh:notme", async (ctx) => {
    const tid = String(ctx.from!.id);
    const st = getState(tid);
    await ctx.answerCbQuery();
    if (st?.action !== S_ISYOU) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    const d = st.data;
    return completeNameSignup(ctx, tid, { fullName: d.fullName, factoryId: d.factoryId, factoryName: d.factoryName, lang: asLang(d.lang) }, { skipRehireAsk: true });
  });
  botT.action("rh:tg:yes", async (ctx): Promise<void> => {
    const tid = String(ctx.from!.id);
    const st = getState(tid);
    await ctx.answerCbQuery();
    if (st?.action !== S_ISYOU) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, Number(st.data.workerId)));
    const lang = asLang(st.data.lang);
    if (!worker || worker.isActive) { clearState(tid); await ctx.reply(t(lang, "rehire.updateTgNo")); return; }
    await requestRehire({ worker, factoryId: Number(st.data.factoryId), tid, lang });
  });
  botT.action("rh:tg:no", async (ctx) => {
    const tid = String(ctx.from!.id);
    const st = getState(tid);
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    clearState(tid);
    return ctx.reply(t(asLang(st?.data?.lang), "rehire.updateTgNo"), Markup.removeKeyboard());
  });

  // Рішення офісу. Гейт — getAdmin (роль driver виключена). «Вже вирішено» =
  // pending-стану заявника вже немає (перший тап зняв його).
  botT.action(/^rhadm:(ok|no):(\d+):(\d+):(\d+)$/, async (ctx) => {
    const admin = await getAdmin(String(ctx.from!.id));
    if (!admin) { await ctx.answerCbQuery("Лише для адміністрації"); return; }
    const al = oLang(admin.language);
    const decision = (ctx as any).match[1] as "ok" | "no";
    const workerId = Number((ctx as any).match[2]);
    const factoryId = Number((ctx as any).match[3]);
    const reqTid = String((ctx as any).match[4]);
    const st = getState(reqTid);
    if (st?.action !== S_PENDING || Number(st.data.workerId) !== workerId) { await ctx.answerCbQuery(tb(al, "Вже вирішено")); return; }
    const lang = asLang(st.data.lang);
    const adminMsgs: AdminMsg[] = st.data.adminMsgs ?? [];
    if (decision === "no") {
      clearState(reqTid);
      await ctx.answerCbQuery(tb(al, "Відхилено"));
      await finalizeAdminMsgs(adminMsgs, false, admin.name);
      await bot.telegram.sendMessage(reqTid, t(lang, "rehire.rejected"), Markup.removeKeyboard()).catch(() => {});
      return;
    }
    const r = await restoreWorker({ workerId, factoryId, telegramId: reqTid, adminId: admin.id });
    if (!r.ok) {
      // «уже активний» — хтось відновив з веба: закриваємо запит; інші помилки
      // (Telegram зайнятий активним) лишають запит відкритим для ручного розбору.
      await ctx.answerCbQuery(r.error, { show_alert: true });
      if (/уже активний/.test(r.error)) { clearState(reqTid); await finalizeAdminMsgs(adminMsgs, true, admin.name); }
      return;
    }
    clearState(reqTid);
    await ctx.answerCbQuery(tb(al, "Відновлено"));
    await finalizeAdminMsgs(adminMsgs, true, admin.name);
    const fac = await factoryName(r.worker.factoryId);
    await bot.telegram.sendMessage(reqTid, t(lang, "rehire.restored", { factory: mdSafe(fac) }), { parse_mode: "Markdown", ...(await menuFor(r.worker, lang)) }).catch(() => {});
  });
}

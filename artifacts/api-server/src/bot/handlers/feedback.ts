// Бот ↔ зголошення з панелі (docs/tasks/2026-10-29-feedback-module.md).
// Головному: під пушем про нове зголошення — «✔ Прийняти» / «❔ Уточнити» / «✖ Відхилити»
// (уточнити/відхилити просять текст наступним повідомленням: стани fb:ask / fb:reject).
// Автору: під «виправлено» — «✔ Працює» / «✖ Досі ні» (стан fb:no → текст), під запитанням —
// «💬 Відповісти» (стан fb:reply → текст). Автор звіряється по admins.telegram_id (не getAdmin:
// readOnly/скоуп-адміни теж автори). Реєструється ДО глобального bot.on("text").
import { Markup, type Telegraf } from "telegraf";
import { getAdmin, adminMenuFor } from "../roles";
import { tb, oLang, type Lang } from "../i18n";
import { setState, getState, clearState } from "../state";
import { mdEsc } from "../../services/taskUtils";
import {
  adminByTelegramId, loadReport, setStatus, replyToAuthor, authorComment, authorConfirm, STATUS_LABEL, type FeedbackStatus,
} from "../../services/feedback";

const S_ASK = "fb:ask", S_REJECT = "fb:reject", S_NO = "fb:no", S_REPLY = "fb:reply";
const cancelKb = (lang: Lang) => Markup.keyboard([[tb(lang, "✖️ Скасувати")]]).resize();
const isCancel = (t: string) => /^✖️|^❌|скасувати|cancel|отмена/i.test(t);

async function stamp(ctx: any, text: string, name: string) {
  await ctx.answerCbQuery(text).catch(() => {});
  const old = ctx.callbackQuery?.message?.text as string | undefined;
  if (old) await ctx.editMessageText(`${old}\n\n— ${text} · ${mdEsc(name)}`).catch(() => {});
}

export function registerFeedback(bot: Telegraf<any>): void {
  // ── головний адмін ──
  bot.action(/^fb:(accept|ask|reject|fixed):(\d+)$/, async (ctx) => {
    const tid = String(ctx.from!.id);
    const admin = await getAdmin(tid);
    if (!admin?.isMain) return ctx.answerCbQuery("Лише головний адмін").catch(() => {});
    const lang = oLang(admin.language);
    const m = ctx.match as RegExpMatchArray;
    const action = m[1]!, id = Number(m[2]);
    const r = await loadReport(id);
    if (!r) return ctx.answerCbQuery(tb(lang, "Зголошення не знайдено")).catch(() => {});
    if (action === "fixed") {
      if (r.status === "fixed" || r.status === "confirmed") return ctx.answerCbQuery(`${tb(lang, "Статус")}: ${tb(lang, STATUS_LABEL[r.status as FeedbackStatus])}`).catch(() => {});
      await setStatus(r, "fixed", admin.id, { via: "bot" });
      return stamp(ctx, tb(lang, "✔ Виправлено, автору надіслано"), admin.name ?? "");
    }
    if (action === "accept") {
      if (r.status !== "new" && r.status !== "clarify") return ctx.answerCbQuery(`${tb(lang, "Статус")}: ${tb(lang, STATUS_LABEL[r.status as FeedbackStatus])}`).catch(() => {});
      await setStatus(r, "review", admin.id, { via: "bot" });
      return stamp(ctx, tb(lang, "✔ Прийнято"), admin.name ?? "");
    }
    await ctx.answerCbQuery().catch(() => {});
    setState(tid, action === "ask" ? S_ASK : S_REJECT, { id });
    const prompt = action === "ask" ? tb(lang, "Напишіть запитання автору зголошення") : tb(lang, "Напишіть автору, чому відхиляєте (піде йому в бот)");
    return ctx.reply(`${action === "ask" ? "❔" : "✖"} ${prompt}: *#${id} ${mdEsc(r.title.slice(0, 80))}*`, { parse_mode: "Markdown", ...cancelKb(lang) });
  });

  // ── автор ──
  bot.action(/^fb:(ok|no|reply):(\d+)$/, async (ctx) => {
    const tid = String(ctx.from!.id);
    const author = await adminByTelegramId(tid);
    const m = ctx.match as RegExpMatchArray;
    const action = m[1]!, id = Number(m[2]);
    const r = await loadReport(id);
    if (!author || !r || r.authorAdminId !== author.id) return ctx.answerCbQuery("Це не ваше зголошення").catch(() => {});
    const lang = oLang(author.language);
    if (action === "ok") {
      if (r.status !== "fixed") return ctx.answerCbQuery(`${tb(lang, "Статус")}: ${tb(lang, STATUS_LABEL[r.status as FeedbackStatus])}`).catch(() => {});
      await authorConfirm(r, author.id, true, null, "bot");
      return stamp(ctx, tb(lang, "✔ Дякуємо, підтверджено"), author.name ?? "");
    }
    await ctx.answerCbQuery().catch(() => {});
    setState(tid, action === "no" ? S_NO : S_REPLY, { id });
    const prompt = action === "no" ? tb(lang, "Напишіть, що саме досі не працює") : tb(lang, "Напишіть відповідь одним повідомленням");
    return ctx.reply(`💬 ${prompt}: *#${id} ${mdEsc(r.title.slice(0, 80))}*`, { parse_mode: "Markdown", ...cancelKb(lang) });
  });

  bot.on("text", async (ctx, next) => {
    const tid = String(ctx.from.id);
    const st = getState(tid);
    if (!st || ![S_ASK, S_REJECT, S_NO, S_REPLY].includes(st.action)) return next();
    const text = ctx.message.text.trim();
    const id = Number((st.data as any)?.id);
    const r = await loadReport(id);
    clearState(tid);
    if (st.action === S_ASK || st.action === S_REJECT) {
      const admin = await getAdmin(tid);
      if (!admin?.isMain) return next();
      const lang = oLang(admin.language);
      const menu = await adminMenuFor(admin, lang);
      if (isCancel(text)) return ctx.reply(tb(lang, "Скасовано"), menu);
      if (!r) return ctx.reply(tb(lang, "Зголошення не знайдено"), menu);
      if (st.action === S_ASK) { await replyToAuthor(r, admin.id, text, "question", "bot"); return ctx.reply(`✅ ${tb(lang, "Запитання надіслано автору")}`, menu); }
      await setStatus(r, "rejected", admin.id, { via: "bot", reply: text });
      return ctx.reply(`✅ ${tb(lang, "Відхилено, автор отримав відповідь")}`, menu);
    }
    const author = await adminByTelegramId(tid);
    if (!author || !r || r.authorAdminId !== author.id) return next();
    const lang = oLang(author.language);
    // меню автора: офісне, якщо є; інакше без клавіатури
    const admin = await getAdmin(tid);
    const menu = admin ? await adminMenuFor(admin, lang) : Markup.removeKeyboard();
    if (isCancel(text)) return ctx.reply(tb(lang, "Скасовано"), menu);
    if (st.action === S_NO) {
      if (r.status !== "fixed") return ctx.reply(tb(lang, "Зголошення вже не в статусі «виправлено»"), menu);
      await authorConfirm(r, author.id, false, text, "bot");
      return ctx.reply(`✅ ${tb(lang, "Передано, зголошення повернуто в роботу")}`, menu);
    }
    await authorComment(r, author.id, text, "bot");
    return ctx.reply(`✅ ${tb(lang, "Відповідь надіслано")}`, menu);
  });
}

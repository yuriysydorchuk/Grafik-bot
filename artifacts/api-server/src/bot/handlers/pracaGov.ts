// Бот ↔ робот praca.gov.pl (12.10.2026): кнопка «🔢 Ввести код» під запитом робота → стан
// pz:code → наступне текстове повідомлення адміна = код SMS profilu zaufanego → provideCode().
// Повідомлення з кодом видаляється з чату (як пароль у web_login:password). Стан перевіряє,
// що подача досі чекає код, інакше — «запізно». Реєструється ДО глобального bot.on("text").
import { Markup, type Telegraf } from "telegraf";
import { getAdmin } from "../roles";
import { tb, oLang } from "../i18n";
import { setState, getState, clearState } from "../state";
import { adminMenuFor } from "../roles";
import { submitCode, isAwaitingCode, awaitingCodeFor, submissionById } from "../../services/pracaGov";

export const S_PZ_CODE = "pz:code";

export function registerPracaGov(bot: Telegraf): void {
  bot.action(/^pz:code:(\d+)$/, async (ctx) => {
    const tid = String(ctx.from!.id);
    const admin = await getAdmin(tid);
    if (!admin) return ctx.answerCbQuery("Лише для офісу").catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const lang = oLang(admin.language);
    const id = Number((ctx.match as RegExpMatchArray)[1]);
    const sub = await submissionById(id);
    if (!sub || sub.adminId !== admin.id) return ctx.reply(tb(lang, "Цю подачу не знайдено або вона не ваша"));
    if (!isAwaitingCode(id)) return ctx.reply(tb(lang, "Робот уже не чекає код для цієї подачі"), await adminMenuFor(admin, lang));
    setState(tid, S_PZ_CODE, { submissionId: id });
    return ctx.reply(`🔢 ${tb(lang, "Надішліть код з SMS одним повідомленням (лише цифри)")}`, Markup.keyboard([[tb(lang, "✖️ Скасувати")]]).resize());
  });

  bot.on("text", async (ctx, next) => {
    const tid = String(ctx.from.id);
    const st = getState(tid);
    if (st?.action !== S_PZ_CODE) return next();
    const admin = await getAdmin(tid);
    if (!admin) { clearState(tid); return next(); }
    const lang = oLang(admin.language);
    const text = ctx.message.text.trim();
    if (/^✖️|^❌|скасувати|cancel/i.test(text)) { clearState(tid); return ctx.reply(tb(lang, "Скасовано"), await adminMenuFor(admin, lang)); }
    await ctx.deleteMessage().catch(() => {}); // код (навіть неповний) не лишаємо в чаті — стираємо до будь-яких перевірок
    const digits = text.replace(/\D/g, "");
    if (digits.length < 4) return ctx.reply(tb(lang, "Код — лише цифри. Спробуйте ще раз або натисніть «Скасувати»."));
    // id з кнопки, або єдина подача адміна, що чекає код
    let id = Number((st.data as any)?.submissionId);
    if (!id) { const ids = awaitingCodeFor(admin.id); id = ids.length === 1 ? ids[0]! : 0; }
    clearState(tid);
    if (!id) return ctx.reply(tb(lang, "Робот зараз не чекає код"), await adminMenuFor(admin, lang));
    try {
      await submitCode(id, digits);
      return ctx.reply(`✅ ${tb(lang, "Код передано роботу")}`, await adminMenuFor(admin, lang));
    } catch (e: any) {
      return ctx.reply(`⚠️ ${e?.message ?? "Помилка"}`, await adminMenuFor(admin, lang));
    }
  });
}

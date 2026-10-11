// «🔗 Лінк реєстрації» в боті (11.10.2026): рекрутер/офіс-менеджер обирає фабрику й отримує
// свій сталий лінк ?start=rec<токен> + QR-картинку (services/signupLinks.ts). Хто зареєструється
// за ним — отримує workers.signup_link_id («хто привів»). Доступ — cap `signupLinks`:
// офісний адмін бачить кнопку в «👥 Управління», веб-лише адмін зі скоупом (офіс-менеджер
// міста, без офісного меню) — однокнопкову клавіатуру на /start; фабрики — лише зі скоупу.
import { Markup, type Context, type Telegraf } from "telegraf";
import { eq } from "drizzle-orm";
import { db, factoriesTable, type Admin } from "@workspace/db";
import { getAdmin, getScopedAdmin, adminHasCap } from "../roles";
import { tb, bhears, oLang, type Lang } from "../i18n";
import { escapeHtml } from "../display";
import { resolveScope, factoryInScope } from "../../lib/scope";
import { getOrCreateSignupLink, signupLinkQrPng, signupLinkUrl } from "../../services/signupLinks";

export const BTN_SIGNUP_LINK = "🔗 Лінк реєстрації";

// Адмін з правом на лінки: офісний (getAdmin) або веб-лише зі скоупом (getScopedAdmin).
// Ролі «лише перегляд» getScopedAdmin теж повертає — cap signupLinks у них нема (міграція
// їх оминає), тож гейт по cap достатній.
export async function signupLinkAdmin(tid: string): Promise<Admin | undefined> {
  const a = (await getAdmin(tid)) ?? (await getScopedAdmin(tid));
  if (!a || !(await adminHasCap(a, "signupLinks"))) return undefined;
  return a;
}

export const signupLinkKeyboard = (lang: Lang) => Markup.keyboard([[tb(lang, BTN_SIGNUP_LINK)]]).resize();

async function scopeOf(admin: Admin) {
  return resolveScope(admin.scopeCities as string[] | null, admin.scopeFactoryIds as number[] | null);
}

async function factoriesFor(admin: Admin): Promise<{ id: number; name: string }[]> {
  const scope = await scopeOf(admin);
  const rows = await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.isOffice, false));
  return rows.filter(f => factoryInScope(scope, f.id)).sort((a, b) => a.name.localeCompare(b.name, "pl"));
}

export async function showSignupLinkFactories(ctx: Context, admin: Admin) {
  const lang = oLang(admin.language);
  const facs = await factoriesFor(admin);
  if (!facs.length) return ctx.reply(tb(lang, "Немає фабрик, на які можна дати лінк реєстрації."));
  if (facs.length === 1) return sendSignupLink(ctx, admin, facs[0]!);
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < facs.length; i += 2) rows.push(facs.slice(i, i + 2).map(f => Markup.button.callback(f.name, `sul:${f.id}`)));
  return ctx.reply(tb(lang, "На яку фабрику потрібен лінк реєстрації?"), Markup.inlineKeyboard(rows));
}

export async function sendSignupLink(ctx: Context, admin: Admin, factory: { id: number; name: string }) {
  const lang = oLang(admin.language);
  const link = await getOrCreateSignupLink(admin.id, factory.id);
  const url = signupLinkUrl(link.token);
  const caption = tb(lang,
    "🔗 <b>Лінк реєстрації — {factory}</b>\n\nНатисніть, щоб скопіювати:\n<code>{url}</code>\n\nХто зареєструється за цим лінком або QR-кодом — буде записаний як приведений вами.",
    { factory: escapeHtml(factory.name), url: escapeHtml(url) });
  try {
    const png = await signupLinkQrPng(url);
    return await ctx.replyWithPhoto({ source: png, filename: `qr-${factory.id}.png` }, { caption, parse_mode: "HTML" });
  } catch {
    return ctx.reply(caption, { parse_mode: "HTML" }); // QR не зібрався — лінк усе одно віддаємо
  }
}

export function registerSignupLinks(bot: Telegraf<any>) {
  const open = async (ctx: Context) => {
    const admin = await signupLinkAdmin(String(ctx.from!.id));
    if (!admin) return;
    return showSignupLinkFactories(ctx, admin);
  };
  bot.hears(bhears(BTN_SIGNUP_LINK), open);
  // легасі-команда адмінів: раніше давала ?start=join, який бот не розбирав (мертвий лінк)
  bot.command("invite", open);
  bot.action(/^sul:(\d+)$/, async (ctx) => {
    const admin = await signupLinkAdmin(String(ctx.from!.id));
    await ctx.answerCbQuery().catch(() => {});
    if (!admin) return;
    const id = Number((ctx as any).match[1]);
    const [fac] = await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, id));
    if (!fac || !factoryInScope(await scopeOf(admin), fac.id)) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return sendSignupLink(ctx, admin, fac);
  });
}

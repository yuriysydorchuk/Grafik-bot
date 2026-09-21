// SMS-кампанії в боті: вхід за персональним лінком ?start=sms<токен> (людина вже відома —
// імʼя, телефон, мова з отримувача), автостворення кандидата у воронці «SMS-кампанії»,
// кнопки «Хочу на роботу» (→ анкета через passport-scan, як QR-реєстрація на фабриці),
// «Приведу друга» (реферальний код, якщо отримувач — наш колишній працівник) і «Не зараз».
// Spec: docs/tasks/2026-09-21-sms-campaigns.md (батч 2).
import { Markup, type Telegraf, type Context } from "telegraf";
import { db, candidatesTable, candidateActivityTable, factoriesTable, adminsTable, workersTable, smsRecipientsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { t, asLang, type Lang } from "../i18n";
import { mdSafe, escapeHtml } from "../display";
import { bot } from "../instance";
import { getWorker } from "../roles";
import { findRecipientByToken, logSmsEvent, advanceRecipient, ensureSmsFunnel } from "../../services/sms/campaigns";
import { createSelfScanToken, passportScanLink } from "../../routes/passportScan";
import { ensureReferralCode } from "../../lib/referral";
import { loadCampaignParams, renderCampaign, campaignKeyboard } from "../../services/referralCampaign";

const officePhone = (offer: { phone?: string }): string => offer.phone || process.env.SMS_OFFICE_PHONE || "";

// Блок пропозиції з полів кампанії — лише заповнені рядки.
function offerLines(lang: Lang, offer: Record<string, any>, factoryName: string | null): string {
  const lines: string[] = [];
  if (factoryName) lines.push(`🏭 ${t(lang, "sms.factory")}: *${mdSafe(factoryName)}*${offer.city ? ` (${mdSafe(offer.city)})` : ""}`);
  if (offer.rate) lines.push(`💰 ${t(lang, "sms.rate")}: ${mdSafe(offer.rate)}${offer.monthly ? ` · ${mdSafe(offer.monthly)}` : ""}`);
  if (offer.housing) lines.push(`🏠 ${t(lang, "sms.housing")}: ${mdSafe(offer.housing)}`);
  if (offer.transport) lines.push(`🚌 ${t(lang, "sms.transport")}: ${mdSafe(offer.transport)}`);
  if (offer.startDate) lines.push(`📅 ${t(lang, "sms.start")}: ${mdSafe(offer.startDate)}`);
  return lines.join("\n");
}

const smsKeyboard = (lang: Lang, recipientId: number) => Markup.inlineKeyboard([
  [Markup.button.callback(t(lang, "sms.btnJob"), `sms:job:${recipientId}`)],
  [Markup.button.callback(t(lang, "sms.btnFriend"), `sms:ref:${recipientId}`), Markup.button.callback(t(lang, "sms.btnLater"), `sms:later:${recipientId}`)],
]);

export async function handleSmsStart(ctx: Context, token: string): Promise<unknown> {
  const tid = String(ctx.from!.id);
  const rec = await findRecipientByToken(token);
  if (!rec) return ctx.reply(t("uk", "sms.invalid", { phone: process.env.SMS_OFFICE_PHONE || "" }) + "\n" + t("en", "sms.invalid", { phone: process.env.SMS_OFFICE_PHONE || "" }));
  const lang = asLang(rec.lang);
  const c = rec.campaign;
  await logSmsEvent(rec.id, "bot_start", { meta: { tid } });
  await advanceRecipient(rec.id, "bot", { botAt: new Date() });

  // Уже наш працівник — нічого не створюємо (меню в нього є).
  const asWorker = await getWorker(tid);
  if (asWorker) return ctx.reply(t(lang, "sms.alreadyWorker", { name: mdSafe(asWorker.fullName) }), { parse_mode: "Markdown" });

  // Кандидат: наявний за Telegram → дописуємо джерело; інакше створюємо з даних отримувача.
  const displayName = rec.name || [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(" ") || rec.phone;
  let cand = (await db.select().from(candidatesTable).where(eq(candidatesTable.telegramId, tid)))[0];
  if (cand) {
    if (!cand.campaignId) await db.update(candidatesTable).set({ source: "sms", campaignId: c.id, language: cand.language ?? rec.lang, phone: cand.phone ?? rec.phone }).where(eq(candidatesTable.id, cand.id));
  } else {
    [cand] = await db.insert(candidatesTable).values({
      funnelId: c.funnelId ?? await ensureSmsFunnel(), fullName: displayName, telegramId: tid, phone: rec.phone,
      factoryId: (c.offer as any)?.factoryId ?? null, stage: "new", source: "sms", campaignId: c.id, language: rec.lang,
      assignedAdminId: c.recruiterAdminId ?? null, notes: `SMS-кампанія «${c.name}»`,
    }).returning();
    await db.insert(candidateActivityTable).values({ candidateId: cand!.id, kind: "created", detail: `З SMS-кампанії «${c.name}» (${rec.lang})` });
    // сповіщення рекрутеру кампанії (best-effort)
    if (c.recruiterAdminId) {
      try {
        const [a] = await db.select().from(adminsTable).where(eq(adminsTable.id, c.recruiterAdminId));
        if (a?.telegramId) await bot.telegram.sendMessage(a.telegramId, `📨 SMS-кампанія «${escapeHtml(c.name)}»: у бот зайшов(ла) <b>${escapeHtml(displayName)}</b> ${escapeHtml(rec.phone)} (${rec.lang}). Кандидат у «SMS-кампанії».`, { parse_mode: "HTML" });
      } catch (e) { logger.warn({ err: e }, "sms recruiter notify failed"); }
    }
  }
  await db.update(smsRecipientsTable).set({ candidateId: cand!.id }).where(eq(smsRecipientsTable.id, rec.id));

  const factoryId = (c.offer as any)?.factoryId as number | null | undefined;
  const fac = factoryId ? (await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0] : null;
  const offer = offerLines(lang, c.offer as any, fac?.name ?? null);
  const firstName = rec.firstName || displayName.split(" ")[0] || "";
  const text = t(lang, c.kind === "referral" ? "sms.helloRef" : "sms.hello", { name: mdSafe(firstName) }) + (offer ? `\n\n${offer}` : "");
  return ctx.reply(text, { parse_mode: "Markdown", ...smsKeyboard(lang, rec.id) });
}

async function loadRec(recipientId: number) {
  const [r] = await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.id, recipientId));
  if (!r) return null;
  const c = (await import("../../services/sms/campaigns")).getCampaign;
  const camp = await c(r.campaignId);
  return camp ? { ...r, campaign: camp } : null;
}

export function registerSmsCampaign(b: Telegraf<Context>): void {
  b.action(/^sms:(job|ref|later):(\d+)$/, async (ctx) => {
    const kind = ctx.match[1]!, id = Number(ctx.match[2]);
    const tid = String(ctx.from!.id);
    await ctx.answerCbQuery().catch(() => {});
    const rec = await loadRec(id);
    if (!rec) return ctx.reply(t("uk", "sms.invalid", { phone: process.env.SMS_OFFICE_PHONE || "" }));
    const lang = asLang(rec.lang);
    const offer = rec.campaign.offer as any;
    const phone = officePhone(offer);
    await logSmsEvent(rec.id, `btn_${kind}`, { meta: { tid } });

    if (kind === "job") {
      const factoryId = offer?.factoryId as number | undefined;
      if (!factoryId) return ctx.reply(t(lang, "sms.noFactory", { phone: mdSafe(phone) }), { parse_mode: "Markdown" });
      const token = await createSelfScanToken({ factoryId, telegramId: tid, language: lang, candidateId: rec.candidateId ?? undefined });
      return ctx.reply(t(lang, "sms.jobLink", { link: passportScanLink(token), phone: mdSafe(phone) }), { parse_mode: "Markdown", link_preview_options: { is_disabled: true } });
    }
    if (kind === "ref") {
      if (!rec.workerId) return ctx.reply(t(lang, "sms.friendNeedsWorker"), { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, "sms.btnJob"), `sms:job:${rec.id}`)]]) });
      const [w] = await db.select().from(workersTable).where(eq(workersTable.id, rec.workerId));
      const code = await ensureReferralCode(rec.workerId);
      const r = renderCampaign(lang, await loadCampaignParams(), { fullName: w?.fullName ?? rec.name ?? "", firstName: rec.firstName, isActive: !!w?.isActive }, code, process.env.TELEGRAM_BOT_USERNAME);
      return ctx.reply(r.worker, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: campaignKeyboard(lang) });
    }
    return ctx.reply(t(lang, "sms.later", { name: mdSafe(rec.firstName || rec.name || "") }), { parse_mode: "Markdown" });
  });
}

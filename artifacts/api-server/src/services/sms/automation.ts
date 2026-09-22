// Автоматика SMS-кампаній (батч 4, spec docs/tasks/2026-09-21-sms-campaigns.md):
//  1) автозадача «відкрили сторінку, не зайшли в бот» — одна групова задача на кампанію
//     (правило sms_no_bot у taskAutoRules, виконавець — рекрутер кампанії → resolveAssignee);
//  2) денний звіт хвилі в бот (тип сповіщень `sms` у roles.notify) — після вікна відправки;
//  3) нагадування в бот через 24 год тим, хто зайшов, але не заповнив анкету (одне);
//  4) «приведи друга» активним працівникам з імпорту — через реферальну розсилку бота, не SMS
//     (рішення власника 21.09.2026).
import { db, smsCampaignsTable, smsRecipientsTable, smsEventsTable, candidatesTable, type SmsCampaign } from "@workspace/db";
import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { Markup } from "telegraf";
import { bot } from "../../bot/instance";
import { t, asLang } from "../../bot/i18n";
import { mdSafe, escapeHtml } from "../../bot/display";
import { notifyByType } from "../../bot/notify";
import { logger } from "../../lib/logger";
import { campaignStats, logSmsEvent, recipientLink } from "./campaigns";
import { warsawNow } from "./sender";
import { loadCampaignParams, sendReferralCampaign, type CampaignSendResult } from "../referralCampaign";

const DAY = 86400_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 1. Кандидати автозадачі sms_no_bot ─────────────────────────────────────
// Вікно: відкрили `lead` … `lead + windowDays` днів тому і досі не в боті. Задача групова на
// кампанію (source_key smsnb:<campaignId>): список у description, оновлюється щоночі; коли у
// вікні нікого не лишається — auto_resolved (люди старші за вікно вважаються відпрацьованими).
export type SmsNoBotCandidate = {
  sourceKey: string; rule: "sms_no_bot"; title: string; description: string; priority: "normal"; dueAt: string;
  autoParams: Record<string, unknown>; assign: { prefer: number | null };
};
export async function smsNoBotCandidates(today: string, leadDays = 2, windowDays = 7, now = new Date()): Promise<SmsNoBotCandidate[]> {
  const to = new Date(now.getTime() - leadDays * DAY);
  const from = new Date(now.getTime() - (leadDays + windowDays) * DAY);
  const rows = await db.select({
    id: smsRecipientsTable.id, campaignId: smsRecipientsTable.campaignId, name: smsRecipientsTable.name, phone: smsRecipientsTable.phone,
    lang: smsRecipientsTable.lang, token: smsRecipientsTable.token, viewedAt: smsRecipientsTable.viewedAt,
  }).from(smsRecipientsTable)
    .where(and(inArray(smsRecipientsTable.status, ["viewed", "cta"]), isNotNull(smsRecipientsTable.viewedAt), gte(smsRecipientsTable.viewedAt, from), lt(smsRecipientsTable.viewedAt, to)))
    .orderBy(smsRecipientsTable.viewedAt);
  if (!rows.length) return [];
  const byCampaign = new Map<number, typeof rows>();
  for (const r of rows) byCampaign.set(r.campaignId, [...(byCampaign.get(r.campaignId) ?? []), r]);
  const campaigns = await db.select().from(smsCampaignsTable).where(inArray(smsCampaignsTable.id, [...byCampaign.keys()]));
  const out: SmsNoBotCandidate[] = [];
  for (const c of campaigns) {
    if (c.status === "closed" || c.status === "draft") continue;
    const people = byCampaign.get(c.id) ?? [];
    const shown = people.slice(0, 60);
    const lines = shown.map((p) => `• ${p.name || "—"} · ${p.phone} · ${p.lang}${p.viewedAt ? ` · відкрив ${p.viewedAt.toLocaleDateString("uk-UA", { timeZone: "Europe/Warsaw" })}` : ""}\n  ${recipientLink(p.token)}`);
    if (people.length > shown.length) lines.push(`…і ще ${people.length - shown.length} у картці кампанії (фільтр «відкрив сторінку»)`);
    out.push({
      sourceKey: `smsnb:${c.id}`, rule: "sms_no_bot",
      title: `SMS «${c.name}»: ${people.length} відкрили сторінку, не зайшли в бот — подзвонити`,
      description: `Кампанія «${c.name}» · панель: /sms-campaigns/${c.id}\nЛюди відкрили персональну сторінку ${leadDays}+ дн. тому, але в бот не зайшли. Подзвонити / написати у WhatsApp:\n\n${lines.join("\n")}`,
      priority: "normal", dueAt: today,
      autoParams: { grouped: true, campaignId: c.id, campaignName: c.name, count: people.length, people: shown.map((p) => ({ id: p.id, name: p.name, phone: p.phone, lang: p.lang })) },
      assign: { prefer: c.recruiterAdminId ?? null },
    });
  }
  return out;
}

// ── 2. Денний звіт хвилі ───────────────────────────────────────────────────
// Крон після вікна відправки (15:05 Warsaw): кампанії, з яких сьогодні щось пішло.
const warsawDateExpr = (col: unknown) => sql`to_char((${col} at time zone 'UTC') at time zone 'Europe/Warsaw', 'YYYY-MM-DD')`; // колонка naive-UTC (як sentToday у sender)
export async function sendSmsDailyReport(now = new Date()): Promise<number> {
  const date = warsawNow(now).date;
  const today = await db.select({
    campaignId: smsRecipientsTable.campaignId,
    sent: sql<number>`count(*)::int`,
    failed: sql<number>`count(*) filter (where ${smsRecipientsTable.status} = 'failed')::int`,
    delivered: sql<number>`count(*) filter (where ${smsRecipientsTable.deliveredAt} is not null)::int`,
    viewed: sql<number>`count(*) filter (where ${smsRecipientsTable.viewedAt} is not null)::int`,
    bot: sql<number>`count(*) filter (where ${smsRecipientsTable.botAt} is not null)::int`,
  }).from(smsRecipientsTable).where(and(isNotNull(smsRecipientsTable.sentAt), sql`${warsawDateExpr(smsRecipientsTable.sentAt)} = ${date}`)).groupBy(smsRecipientsTable.campaignId);
  if (!today.length) return 0;
  const campaigns = await db.select().from(smsCampaignsTable).where(inArray(smsCampaignsTable.id, today.map((r) => r.campaignId)));
  const blocks: string[] = [];
  for (const c of campaigns) {
    const d = today.find((r) => r.campaignId === c.id)!;
    const s = await campaignStats(c);
    const pct = (n: number, base: number) => (base ? ` (${Math.round((n / base) * 100)}%)` : "");
    blocks.push(
      `<b>${escapeHtml(c.name)}</b> · ${c.status === "sent" ? "завершена" : c.status === "paused" ? "пауза" : "триває"}\n` +
      `Сьогодні: відправлено ${d.sent}, не доставлено ${d.failed}, доставлено ${d.delivered}${pct(d.delivered, d.sent)}, відкрили ${d.viewed}${pct(d.viewed, d.sent)}, у боті ${d.bot}\n` +
      `Разом: ${s.sent} SMS → відкрили ${s.viewed}${pct(s.viewed, s.sent)} → у боті ${s.bot} → анкети ${s.form} → на зміні ${s.hired} · у черзі ${s.queued} · ~${s.costEstimate} zł`,
    );
  }
  const text = `📨 <b>SMS-кампанії — звіт за ${date.split("-").reverse().join(".")}</b>\n\n${blocks.join("\n\n")}\n\nПанель: /sms-campaigns`;
  await notifyByType("sms", text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  return campaigns.length;
}

// Кампанія дійшла до кінця черги (sender ставить status=sent) — одне повідомлення.
export async function notifySmsCampaignFinished(c: SmsCampaign): Promise<void> {
  try {
    const s = await campaignStats(c);
    await notifyByType("sms", `✅ <b>SMS-кампанія «${escapeHtml(c.name)}» відправлена повністю</b>\n${s.sent} SMS · відкрили ${s.viewed} · у боті ${s.bot} · анкети ${s.form} · ~${s.costEstimate} zł\nСтатуси доставки ще підтягуються 72 год.`, { parse_mode: "HTML" });
  } catch (e) { logger.warn({ err: e, campaignId: c.id }, "sms finished notify failed"); }
}

// ── 3. Нагадування через 24 год без анкети ────────────────────────────────
// Зайшли в бот 24–72 год тому, статус досі bot (анкети нема), кандидат не став працівником,
// нагадування ще не було (подія remind). Одне повідомлення з кнопкою анкети.
export async function sendSmsReminders(now = new Date()): Promise<number> {
  const rows = await db.select({
    id: smsRecipientsTable.id, firstName: smsRecipientsTable.firstName, name: smsRecipientsTable.name, lang: smsRecipientsTable.lang,
    tid: candidatesTable.telegramId, candLang: candidatesTable.language,
  }).from(smsRecipientsTable)
    .innerJoin(candidatesTable, eq(candidatesTable.id, smsRecipientsTable.candidateId))
    .where(and(
      eq(smsRecipientsTable.status, "bot"), isNotNull(smsRecipientsTable.botAt),
      gte(smsRecipientsTable.botAt, new Date(now.getTime() - 3 * DAY)), lt(smsRecipientsTable.botAt, new Date(now.getTime() - DAY)),
      isNotNull(candidatesTable.telegramId), isNull(candidatesTable.workerId),
      sql`not exists (select 1 from ${smsEventsTable} e where e.recipient_id = ${smsRecipientsTable.id} and e.kind = 'remind')`,
    ));
  let n = 0;
  for (const r of rows) {
    const lang = asLang(r.candLang ?? r.lang);
    const name = mdSafe(r.firstName || (r.name ?? "").split(" ")[0] || "");
    try {
      await bot.telegram.sendMessage(r.tid!, t(lang, "sms.remind", { name }), {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, "sms.btnJob"), `sms:job:${r.id}`)], [Markup.button.callback(t(lang, "sms.btnLater"), `sms:later:${r.id}`)]]),
      });
      await logSmsEvent(r.id, "remind", { meta: { tid: r.tid } });
      n++;
      await sleep(50);
    } catch (e: any) {
      // заблокував бота тощо — фіксуємо, щоб не пробувати щогодини
      await logSmsEvent(r.id, "remind", { meta: { error: String(e?.description ?? e?.message ?? e) } });
      logger.warn({ err: e, recipientId: r.id }, "sms reminder failed");
    }
  }
  if (n) logger.info({ n }, "sms reminders sent");
  return n;
}

// ── 4. «Приведи друга» активним працівникам з імпорту ─────────────────────
// Пропущені при імпорті як active_worker (є worker_id) і ще не отримували (подія referral_bot)
// → реферальна розсилка бота з чинними умовами кампанії «приведи друга» (settings).
export async function notifyActiveWorkersReferral(campaignId: number): Promise<CampaignSendResult & { pending: number }> {
  const rows = await db.select({ id: smsRecipientsTable.id, workerId: smsRecipientsTable.workerId }).from(smsRecipientsTable)
    .where(and(
      eq(smsRecipientsTable.campaignId, campaignId), eq(smsRecipientsTable.status, "skipped"), eq(smsRecipientsTable.skippedReason, "active_worker"), isNotNull(smsRecipientsTable.workerId),
      sql`not exists (select 1 from ${smsEventsTable} e where e.recipient_id = ${smsRecipientsTable.id} and e.kind = 'referral_bot')`,
    ));
  const empty = { notified: 0, skipped: 0, failed: [], pending: 0 };
  if (!rows.length) return empty;
  const ids = [...new Set(rows.map((r) => r.workerId!))];
  const r = await sendReferralCampaign(ids, await loadCampaignParams());
  const failedIds = new Set(r.failed.map((f) => f.id));
  for (const row of rows) {
    if (failedIds.has(row.workerId!)) continue;
    await logSmsEvent(row.id, "referral_bot", { meta: { workerId: row.workerId } });
  }
  return { ...r, pending: rows.length };
}

// Скільки активних працівників з імпорту ще не отримали «приведи друга» (кнопка в картці).
export async function pendingActiveWorkers(campaignId: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(smsRecipientsTable)
    .where(and(
      eq(smsRecipientsTable.campaignId, campaignId), eq(smsRecipientsTable.status, "skipped"), eq(smsRecipientsTable.skippedReason, "active_worker"), isNotNull(smsRecipientsTable.workerId),
      sql`not exists (select 1 from ${smsEventsTable} e where e.recipient_id = ${smsRecipientsTable.id} and e.kind = 'referral_bot')`,
    ));
  return r?.n ?? 0;
}

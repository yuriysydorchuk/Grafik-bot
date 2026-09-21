// Відправка SMS-кампаній кроном: у вікні розкладу (Europe/Warsaw), з денним лімітом,
// батчами, з in-flight guard (один процес, але крон може накластись на довгий батч).
// Статуси доставки — опитування провайдера для «sent» без відповіді (до 72 год).
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db, smsCampaignsTable, smsRecipientsTable, type SmsCampaign, type SmsSchedule } from "@workspace/db";
import { logger } from "../../lib/logger";
import { getSmsProvider, type SmsProviderName } from "./provider";
import { renderForRecipient, logSmsEvent, advanceRecipient, recipientLink } from "./campaigns";
import { randomInviteCode } from "../../lib/invite";

const TZ = "Europe/Warsaw";

// Локальний час Варшави: день тижня 1..7 (пн=1) і хвилини від півночі.
export function warsawNow(now = new Date()): { day: number; minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const hh = Number(get("hour")) % 24, mm = Number(get("minute"));
  return { day: dayMap[get("weekday")] ?? 0, minutes: hh * 60 + mm, date: `${get("year")}-${get("month")}-${get("day")}` };
}
const toMin = (hhmm: string): number => { const [h, m] = hhmm.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

export function inSendWindow(schedule: SmsSchedule, now = new Date()): boolean {
  const w = warsawNow(now);
  if (schedule.days?.length && !schedule.days.includes(w.day)) return false;
  return w.minutes >= toMin(schedule.from || "00:00") && w.minutes < toMin(schedule.to || "24:00");
}

// Скільки вже відправлено сьогодні (за датою Варшави) — денний ліміт.
async function sentToday(campaignId: number, now = new Date()): Promise<number> {
  const { date } = warsawNow(now);
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(smsRecipientsTable)
    .where(and(eq(smsRecipientsTable.campaignId, campaignId), isNotNull(smsRecipientsTable.sentAt), sql`(${smsRecipientsTable.sentAt} at time zone 'UTC' at time zone ${TZ})::date = ${date}::date`));
  return r?.n ?? 0;
}

const inFlight = new Set<number>();
export const isSmsCampaignInFlight = (id: number): boolean => inFlight.has(id);

// Один прохід по одній кампанії: до batchSize отримувачів у черзі, в межах денного ліміту.
// force=true — поза вікном (тест / ручний запуск батча з панелі).
export async function sendCampaignBatch(c: SmsCampaign, opts: { force?: boolean; limit?: number; now?: Date } = {}): Promise<{ sent: number; failed: number; remaining: number }> {
  const now = opts.now ?? new Date();
  const sched = c.schedule;
  if (!opts.force && !inSendWindow(sched, now)) return { sent: 0, failed: 0, remaining: -1 };
  if (inFlight.has(c.id)) return { sent: 0, failed: 0, remaining: -1 };
  inFlight.add(c.id);
  try {
    const already = await sentToday(c.id, now);
    const room = Math.max(0, (sched.dailyLimit || 1500) - already);
    const take = Math.min(opts.limit ?? sched.batchSize ?? 200, room);
    if (take <= 0) return { sent: 0, failed: 0, remaining: -1 };
    const queue = await db.select().from(smsRecipientsTable)
      .where(and(eq(smsRecipientsTable.campaignId, c.id), eq(smsRecipientsTable.status, "queued")))
      .orderBy(smsRecipientsTable.id).limit(take);
    if (!queue.length) {
      if (c.status === "sending") {
        await db.update(smsCampaignsTable).set({ status: "sent", finishedAt: new Date(), updatedAt: new Date() }).where(eq(smsCampaignsTable.id, c.id));
        const { notifySmsCampaignFinished } = await import("./automation");
        await notifySmsCampaignFinished({ ...c, status: "sent" });
      }
      return { sent: 0, failed: 0, remaining: 0 };
    }
    const provider = getSmsProvider(c.provider as SmsProviderName);
    const items = queue.map((r) => { const t = renderForRecipient(c, r); return { recipientId: r.id, phone: r.phone, text: t.text, from: c.sender, parts: t.parts }; });
    const results = await provider.send(items.map(({ parts: _p, ...it }) => it));
    let sent = 0, failed = 0;
    for (const res of results) {
      const it = items.find((x) => x.recipientId === res.recipientId)!;
      if (res.ok) {
        sent++;
        await db.update(smsRecipientsTable).set({ status: "sent", sentAt: now, providerMsgId: res.msgId ?? null, parts: res.parts ?? it.parts }).where(eq(smsRecipientsTable.id, res.recipientId));
        await logSmsEvent(res.recipientId, "sent", { meta: { provider: provider.name, msgId: res.msgId, parts: res.parts ?? it.parts } });
      } else {
        failed++;
        await db.update(smsRecipientsTable).set({ status: "failed", sentAt: now, failReason: res.error?.slice(0, 300) ?? "помилка" }).where(eq(smsRecipientsTable.id, res.recipientId));
        await logSmsEvent(res.recipientId, "failed", { meta: { provider: provider.name, error: res.error } });
      }
    }
    const [{ n: remaining }] = await db.select({ n: sql<number>`count(*)::int` }).from(smsRecipientsTable).where(and(eq(smsRecipientsTable.campaignId, c.id), eq(smsRecipientsTable.status, "queued")));
    logger.info({ campaignId: c.id, sent, failed, remaining }, "SMS batch sent");
    return { sent, failed, remaining: remaining ?? 0 };
  } finally {
    inFlight.delete(c.id);
  }
}

// Крон кожні 5 хв: усі кампанії в статусі sending/test.
export async function runSmsSender(now = new Date()): Promise<void> {
  const active = await db.select().from(smsCampaignsTable).where(inArray(smsCampaignsTable.status, ["sending", "test"]));
  for (const c of active) {
    try { await sendCampaignBatch(c, { now }); }
    catch (e: any) { logger.error({ err: e, campaignId: c.id }, "SMS batch failed"); }
  }
}

// Крон кожні 15 хв: статуси доставки для «sent» без відповіді (останні 72 год).
export async function pollSmsStatuses(): Promise<{ delivered: number; failed: number }> {
  const since = new Date(Date.now() - 72 * 3600 * 1000);
  const pending = await db.select({ id: smsRecipientsTable.id, msgId: smsRecipientsTable.providerMsgId, campaignId: smsRecipientsTable.campaignId })
    .from(smsRecipientsTable)
    .where(and(eq(smsRecipientsTable.status, "sent"), isNotNull(smsRecipientsTable.providerMsgId), gte(smsRecipientsTable.sentAt, since)));
  if (!pending.length) return { delivered: 0, failed: 0 };
  const campaigns = new Map<number, SmsCampaign>();
  for (const c of await db.select().from(smsCampaignsTable).where(inArray(smsCampaignsTable.id, [...new Set(pending.map((p) => p.campaignId))]))) campaigns.set(c.id, c);
  let delivered = 0, failed = 0;
  const byProvider = new Map<string, typeof pending>();
  for (const p of pending) { const prov = campaigns.get(p.campaignId)?.provider ?? "smsapi"; if (!byProvider.has(prov)) byProvider.set(prov, []); byProvider.get(prov)!.push(p); }
  for (const [prov, list] of byProvider) {
    const provider = getSmsProvider(prov as SmsProviderName);
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      let statuses; try { statuses = await provider.status(chunk.map((p) => p.msgId!)); } catch (e: any) { logger.warn({ err: e }, "SMS status poll failed"); continue; }
      for (const st of statuses) {
        const rec = chunk.find((p) => p.msgId === st.msgId); if (!rec) continue;
        if (st.status === "delivered") { delivered++; await advanceRecipient(rec.id, "delivered", { deliveredAt: new Date() }); await logSmsEvent(rec.id, "delivered"); }
        else if (st.status === "failed") { failed++; await db.update(smsRecipientsTable).set({ status: "failed", failReason: st.reason ?? "не доставлено" }).where(eq(smsRecipientsTable.id, rec.id)); await logSmsEvent(rec.id, "failed", { meta: { reason: st.reason } }); }
      }
    }
  }
  if (delivered || failed) logger.info({ delivered, failed }, "SMS statuses updated");
  return { delivered, failed };
}

// Тестове SMS на свій номер: без запису в отримувачі, лише результат провайдера.
// Тест на свій номер = справжній отримувач у кампанії з сегментом «тест» (лінк, сторінка, бот і
// кандидат працюють наскрізно). Повторний тест на той самий номер переюзує токен.
export async function sendTestSms(c: SmsCampaign, phone: string, lang: string, name = "Test"): Promise<{ ok: boolean; error?: string; text: string; parts: number; msgId?: string; link: string }> {
  let [rec] = await db.select().from(smsRecipientsTable).where(and(eq(smsRecipientsTable.campaignId, c.id), eq(smsRecipientsTable.phone, phone)));
  if (!rec) {
    [rec] = await db.insert(smsRecipientsTable).values({ campaignId: c.id, phone, name, firstName: name, lang, segment: "тест", token: randomInviteCode(24), status: "queued" }).returning();
  }
  const t = renderForRecipient(c, { lang, firstName: rec!.firstName || name, name: rec!.name || name, token: rec!.token });
  const provider = getSmsProvider(c.provider as SmsProviderName);
  const [res] = await provider.send([{ recipientId: rec!.id, phone, text: t.text, from: c.sender }]);
  const now = new Date();
  if (res?.ok) {
    await db.update(smsRecipientsTable).set({ status: "sent", sentAt: now, providerMsgId: res.msgId ?? null, parts: res.parts ?? t.parts, failReason: null }).where(eq(smsRecipientsTable.id, rec!.id));
    await logSmsEvent(rec!.id, "sent", { meta: { provider: provider.name, msgId: res.msgId, parts: res.parts ?? t.parts, test: true } });
  } else {
    await logSmsEvent(rec!.id, "failed", { meta: { provider: provider.name, error: res?.error, test: true } });
  }
  logger.info({ campaignId: c.id, recipientId: rec!.id, ok: !!res?.ok, msgId: res?.msgId, error: res?.error }, "SMS test sent");
  return { ok: !!res?.ok, error: res?.error, text: t.text, parts: t.parts, msgId: res?.msgId, link: recipientLink(rec!.token) };
}

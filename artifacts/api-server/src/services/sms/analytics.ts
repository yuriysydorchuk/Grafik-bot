// Аналітика сторінки SMS-кампанії (рішення власника 22.09.2026: «вести статистику і історію рухів
// по сайту, щоб аналізувати і міняти»). Усе рахується з sms_events × sms_recipients кампанії:
// воронка кроків (унікальні люди), по вакансіях і послугах (розгорнули → цікавить → друг), кнопки
// контактів, FAQ, мови, пристрої, години й дні відкриттів, час від SMS до першого відкриття.
import { db, smsRecipientsTable, smsEventsTable, type SmsCampaign, type SmsVacancy } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export type SmsAnalytics = {
  people: { sent: number; delivered: number; viewed: number; engaged: number; interested: number; friend: number; contact: number; returning: number };
  vacancies: { id: string; title: string; opens: number; interested: number; friends: number }[];
  services: { id: string; title: string; opens: number; interested: number }[];
  buttons: Record<string, number>;
  faq: { n: number; opens: number }[];
  langs: Record<string, number>;
  devices: Record<string, number>;
  byHour: number[];                                   // відкриття сторінки (події view) за годинами Варшави
  byDay: { date: string; views: number; interested: number }[];
  timeToView: { medianMin: number | null; p75Min: number | null; within1h: number; within24h: number };
  events: number;
};

export const SERVICE_TITLES: Record<string, string> = { "svc:karta": "Карта побиту", "svc:ukr": "PESEL UKR / статус UKR", "svc:prawko": "Заміна водійського посвідчення" };
const BUTTON_KINDS = ["cta_call", "cta_wa", "cta_viber", "cta_bot", "link_maps", "link_site", "link_insta", "link_fb", "link_vacancies", "link_reviews"];

export async function campaignAnalytics(c: SmsCampaign): Promise<SmsAnalytics> {
  const recips = await db.select({ id: smsRecipientsTable.id, status: smsRecipientsTable.status, sentAt: smsRecipientsTable.sentAt, deliveredAt: smsRecipientsTable.deliveredAt, viewedAt: smsRecipientsTable.viewedAt })
    .from(smsRecipientsTable).where(eq(smsRecipientsTable.campaignId, c.id));
  const evs = await db.select({ rid: smsEventsTable.recipientId, kind: smsEventsTable.kind, at: smsEventsTable.at, device: smsEventsTable.device, meta: smsEventsTable.meta })
    .from(smsEventsTable).innerJoin(smsRecipientsTable, eq(smsRecipientsTable.id, smsEventsTable.recipientId))
    .where(eq(smsRecipientsTable.campaignId, c.id)).orderBy(smsEventsTable.id);
  const v = (m: unknown): string => String((m as any)?.v ?? (m as any)?.vacancyId ?? "");

  const uniq = (pred: (e: typeof evs[number]) => boolean) => new Set(evs.filter(pred).map((e) => e.rid)).size;
  const sent = recips.filter((r) => r.sentAt && r.status !== "skipped").length;
  const delivered = recips.filter((r) => r.deliveredAt).length;
  const viewedIds = new Set(evs.filter((e) => e.kind === "view").map((e) => e.rid));
  const viewCounts = new Map<number, number>();
  for (const e of evs) if (e.kind === "view") viewCounts.set(e.rid, (viewCounts.get(e.rid) ?? 0) + 1);
  const people = {
    sent, delivered, viewed: viewedIds.size,
    engaged: uniq((e) => !["view", "sent", "failed", "delivered", "lang"].includes(e.kind)),
    interested: uniq((e) => e.kind === "interested" || e.kind === "interested_ref"),
    friend: uniq((e) => e.kind === "friend"),
    contact: uniq((e) => ["cta_call", "cta_wa", "cta_viber", "cta_bot"].includes(e.kind)),
    returning: [...viewCounts.values()].filter((n) => n > 1).length,
  };

  const landing = (c.landing ?? {}) as { vacancies?: SmsVacancy[] };
  const vacList: { id: string; title: string }[] = landing.vacancies?.length
    ? landing.vacancies.map((x) => ({ id: x.id, title: x.title?.uk || x.title?.ru || x.title?.en || x.id }))
    : [{ id: "offer", title: "Робота на виробництві" }];
  const per = (kind: string, id: string) => uniq((e) => e.kind === kind && v(e.meta) === id);
  const vacancies = [
    ...vacList.map((x) => ({ id: x.id, title: x.title, opens: per("open_vacancy", x.id), interested: per("interested", x.id), friends: per("friend", x.id) })),
    { id: "any", title: "Головна кнопка (без вакансії)", opens: 0, interested: per("interested", "any"), friends: per("friend", "") + per("friend", "any") },
  ];
  const services = Object.entries(SERVICE_TITLES).map(([id, title]) => ({ id, title, opens: per("open_service", id), interested: per("interested", id) }));
  const buttons: Record<string, number> = {};
  for (const k of BUTTON_KINDS) buttons[k] = uniq((e) => e.kind === k);
  const faqMap = new Map<number, Set<number>>();
  for (const e of evs) if (e.kind === "open_faq") { const n = Number(v(e.meta)) || 0; if (!faqMap.has(n)) faqMap.set(n, new Set()); faqMap.get(n)!.add(e.rid); }
  const faq = [...faqMap.entries()].sort((a, b) => a[0] - b[0]).map(([n, s]) => ({ n, opens: s.size }));
  const langs: Record<string, number> = {};
  for (const e of evs) if (e.kind === "lang") { const l = v(e.meta) || "?"; langs[l] = (langs[l] ?? 0) + 1; }
  const devices: Record<string, number> = {};
  for (const rid of viewedIds) { const first = evs.find((e) => e.rid === rid && e.kind === "view"); const d = first?.device ?? "невідомо"; devices[d] = (devices[d] ?? 0) + 1; }

  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" });
  const byHour = Array(24).fill(0) as number[];
  const dayMap = new Map<string, { views: number; interested: number }>();
  for (const e of evs) {
    if (e.kind !== "view" && e.kind !== "interested" && e.kind !== "interested_ref") continue;
    const parts = fmt.formatToParts(e.at); const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    if (!dayMap.has(date)) dayMap.set(date, { views: 0, interested: 0 });
    if (e.kind === "view") { byHour[Number(get("hour")) % 24]!++; dayMap.get(date)!.views++; } else dayMap.get(date)!.interested++;
  }
  const byDay = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, x]) => ({ date, ...x }));

  const deltas: number[] = [];
  for (const r of recips) if (r.sentAt && r.viewedAt && r.viewedAt > r.sentAt) deltas.push((r.viewedAt.getTime() - r.sentAt.getTime()) / 60000);
  deltas.sort((a, b) => a - b);
  const q = (p: number) => (deltas.length ? Math.round(deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))]!) : null);
  const timeToView = { medianMin: q(0.5), p75Min: q(0.75), within1h: deltas.filter((m) => m <= 60).length, within24h: deltas.filter((m) => m <= 1440).length };

  return { people, vacancies, services, buttons, faq, langs, devices, byHour, byDay, timeToView, events: evs.length };
}

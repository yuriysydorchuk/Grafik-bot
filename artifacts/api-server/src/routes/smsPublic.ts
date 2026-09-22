// Публічна сторінка персонального SMS-лінка /r/<токен> (батч 2 SMS-кампаній):
// GET /r/:token — дані для продажної сторінки (імʼя, мова, пропозиція, лендінг, лінки),
// подія «переглянув»; GET /r/:token/e?k=cta_bot|cta_call|cta_wa — подія кнопки
// (GET, щоб sendBeacon/перехід не впирались у CSRF-гард на мутаціях).
// БЕЗ authRequired — монтується до auth-роутерів (routes/index.ts), rate-limit по префіксу.
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { db, factoriesTable, adminsTable, smsEventsTable, smsRecipientsTable, candidatesTable, candidateActivityTable, type SmsVacancy, type SmsContacts } from "@workspace/db";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { findRecipientByToken, logSmsEvent, advanceRecipient, ensureSmsFunnel } from "../services/sms/campaigns";
import { normalizePhone } from "../services/sms/phone";
import { clientIp, parseDevice } from "../lib/clientInfo";
import { bot } from "../bot/instance";
import { escapeHtml } from "../bot/display";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use("/r", rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Забагато запитів. Спробуйте пізніше." } }));

const TOKEN_RE = /^[0-9A-Z]{8,24}$/; // 8 (нові, одна частина SMS) … 24 (старі)
const botLink = (token: string): string => {
  const u = process.env.TELEGRAM_BOT_USERNAME || "";
  return u ? `https://t.me/${u}?start=sms${token}` : "";
};

router.get("/r/:token", async (req, res) => {
  const token = String(req.params.token || "").toUpperCase();
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: "Лінк недійсний." });
  const rec = await findRecipientByToken(token);
  if (!rec) return res.status(404).json({ error: "Лінк недійсний." });
  const c = rec.campaign;
  const ip = clientIp(req), device = parseDevice(req.headers["user-agent"]);
  await logSmsEvent(rec.id, "view", { ip, userAgent: req.headers["user-agent"] as string, device });
  await advanceRecipient(rec.id, "viewed", { viewedAt: rec.viewedAt ?? new Date() });
  const offer = (c.offer ?? {}) as Record<string, any>;
  const fac = offer.factoryId ? (await db.select({ name: factoriesTable.name, city: factoriesTable.city }).from(factoriesTable).where(eq(factoriesTable.id, Number(offer.factoryId))))[0] : null;
  const phone = offer.phone || process.env.SMS_OFFICE_PHONE || "";
  const landing = (c.landing ?? {}) as Record<string, any>;
  // міста на сторінці: з лендінгу кампанії, інакше — міста фабрик (без офісу), в алфавіті
  const cities: string[] = landing.cities?.length ? landing.cities : (await db.select({ city: factoriesTable.city }).from(factoriesTable).where(and(isNotNull(factoriesTable.city), ne(factoriesTable.city, ""), sql`coalesce(${factoriesTable.isOffice}, false) = false`)))
    .map((r) => String(r.city).trim()).filter((v, i, a) => v && a.indexOf(v) === i).sort((a, b) => a.localeCompare(b, "uk"));
  const evs = await db.select({ kind: smsEventsTable.kind, meta: smsEventsTable.meta }).from(smsEventsTable).where(and(eq(smsEventsTable.recipientId, rec.id), inArray(smsEventsTable.kind, ["interested", "interested_ref", "friend"])));
  const interestedVacancies = [...new Set(evs.filter((e) => e.kind === "interested").map((e) => String((e.meta as any)?.vacancyId ?? "")).filter(Boolean))];
  const friends = [...new Set(evs.filter((e) => e.kind === "friend" && !(e.meta as any)?.duplicate).map((e) => String((e.meta as any)?.name ?? "")).filter(Boolean))];
  // вакансії: з лендінгу кампанії; порожньо → одна з пропозиції кампанії (щоб сторінка працювала до заповнення списку)
  const vacancies: SmsVacancy[] = landing.vacancies?.length ? landing.vacancies : [{
    // без назв клієнтів на сторінці (рішення власника 22.09.2026 — не давати інфу конкурентам)
    id: "offer", title: { uk: "Робота на виробництві", ru: "Работа на производстве", en: "Production job" },
    city: offer.city || fac?.city || cities[0] || "", rate: offer.rate, housing: offer.housing, transport: offer.transport, shifts: "", desc: {}, perks: [],
  }];
  const contacts: SmsContacts = { phone, address: "ul. Krakowskie Przedmieście 55, 20-076 Lublin", site: "https://eurosupp.pl/", vacanciesUrl: "https://eurosupp.pl/dla-pracownika/", instagram: "https://www.instagram.com/eurosupport.eu", facebook: "https://www.facebook.com/share/1DEH5b7CnP/", ...(landing.contacts ?? {}) };
  // мапа — за назвою бізнесу + адресою, не лише адресою (за адресою Google відкривав сусідню агенцію)
if (!contacts.maps) contacts.maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`EuroSupport agencja pracy tymczasowej ${contacts.address ?? "Lublin"}`)}`;
  return res.json({
    firstName: rec.firstName || (rec.name || "").split(" ")[0] || "",
    lang: rec.lang, kind: c.kind,
    // без внутрішньої назви кампанії й назви фабрики (клієнта) у публічній відповіді (ревʼю 22.09.2026)
    offer: { ...offer, factoryId: undefined, city: offer.city || fac?.city || null, phone, whatsapp: offer.whatsapp || phone },
    landing, cities, vacancies, contacts,
    recruiter: { name: landing.recruiterName || process.env.SMS_RECRUITER_NAME || "", hours: landing.hours || process.env.SMS_RECRUITER_HOURS || "10–17" },
    interested: interestedVacancies.length > 0 || evs.some((e) => e.kind === "interested_ref"),
    interestedVacancies, friends,
    telegram: botLink(token),
    closed: c.status === "closed",
  });
});

// «Мене цікавить» = заявка в рекрутації (рішення власника 22.09.2026): кандидат у воронці «SMS-кампанії»
// (стадія «Нові заявки», source=sms, нотатка з вакансією/послугою, наступна дія — сьогодні), один на
// отримувача; повторний інтерес по іншій вакансії — лише запис в активність кандидата.
async function upsertInterestedCandidate(rec: { id: number; name: string | null; phone: string; lang: string; candidateId: number | null }, c: { id: number; name: string; funnelId: number | null; recruiterAdminId: number | null; offer: unknown }, label: string): Promise<number> {
  let candId = rec.candidateId;
  if (!candId) {
    const [byPhone] = await db.select({ id: candidatesTable.id }).from(candidatesTable).where(and(eq(candidatesTable.campaignId, c.id), eq(candidatesTable.phone, rec.phone))).limit(1);
    candId = byPhone?.id ?? null;
  }
  if (!candId) {
    const [cand] = await db.insert(candidatesTable).values({
      funnelId: c.funnelId ?? await ensureSmsFunnel(), fullName: rec.name || rec.phone, phone: rec.phone, stage: "new", source: "sms", campaignId: c.id, language: rec.lang,
      assignedAdminId: c.recruiterAdminId ?? null, factoryId: (c.offer as any)?.factoryId ?? null, nextActionAt: new Date(),
      notes: `Зацікавлений з SMS-кампанії «${c.name}»${label ? `: ${label}` : ""}. Звʼязатись протягом 1 робочого дня.`,
    }).returning({ id: candidatesTable.id });
    candId = cand!.id;
    await db.insert(candidateActivityTable).values({ candidateId: candId, kind: "created", detail: `Натиснув(ла) «Мене цікавить» на SMS-сторінці${label ? ` — ${label}` : ""}` });
  } else {
    await db.insert(candidateActivityTable).values({ candidateId: candId, kind: "note", detail: `Ще раз «Мене цікавить» на SMS-сторінці${label ? ` — ${label}` : ""}` });
  }
  if (rec.candidateId !== candId) await db.update(smsRecipientsTable).set({ candidateId: candId }).where(eq(smsRecipientsTable.id, rec.id));
  return candId;
}

async function notifyRecruiter(campaign: { recruiterAdminId: number | null }, text: string): Promise<void> {
  if (!campaign.recruiterAdminId) return;
  try {
    const [a] = await db.select({ telegramId: adminsTable.telegramId }).from(adminsTable).where(eq(adminsTable.id, campaign.recruiterAdminId));
    if (a?.telegramId) await bot.telegram.sendMessage(a.telegramId, text, { parse_mode: "HTML" });
  } catch (e) { logger.warn({ err: e }, "sms recruiter notify failed"); }
}
// Послуги легалізації на сторінці (svc:*) — картка рекрутеру з назвою послуги, не вакансії.
const SERVICE_TITLES: Record<string, string> = { "svc:karta": "Послуга: карта побиту", "svc:ukr": "Послуга: PESEL UKR / статус UKR", "svc:prawko": "Послуга: заміна водійського посвідчення" };
const vacancyTitle = (landing: Record<string, any>, id: string): string => {
  if (SERVICE_TITLES[id]) return SERVICE_TITLES[id]!;
  if (id === "offer") return "Робота на виробництві"; // дефолтна вакансія з пропозиції (без landing.vacancies)
  if (id === "any" || !id) return "головна кнопка";
  const v = (landing.vacancies as SmsVacancy[] | undefined)?.find((x) => x.id === id);
  return v ? (v.title?.uk || v.title?.ru || v.title?.en || id) : "";
};

// Кнопки й кліки сторінки — усе логується в sms_events з id отримувача (власник хоче знати, хто
// куди клікнув). Конверсійні (cta_*, interested*) ще й піднімають статус до `cta`; «Мене цікавить»
// (interested, ?v=<вакансія|svc:послуга>) шле рекрутеру кампанії картку в бот (перший раз по
// кожній вакансії). Решта (open_*, link_*, lang) — лише журнал.
const CTA_EVENTS = new Set(["cta_bot", "cta_call", "cta_wa", "cta_viber", "interested", "interested_ref"]);
const TRACK_EVENTS = new Set(["open_vacancy", "open_service", "open_faq", "link_maps", "link_site", "link_insta", "link_fb", "link_vacancies", "link_reviews", "lang"]);
router.get("/r/:token/e", async (req, res) => {
  const token = String(req.params.token || "").toUpperCase();
  const k = String(req.query.k || "");
  const vacancyId = String(req.query.v || "").slice(0, 40);
  if (!TOKEN_RE.test(token) || !(CTA_EVENTS.has(k) || TRACK_EVENTS.has(k))) return res.status(204).end();
  const rec = await findRecipientByToken(token);
  if (rec && TRACK_EVENTS.has(k)) {
    await logSmsEvent(rec.id, k, { ip: clientIp(req), userAgent: req.headers["user-agent"] as string, device: parseDevice(req.headers["user-agent"]), meta: vacancyId ? { v: vacancyId } : undefined });
  } else if (rec) {
    const first = k.startsWith("interested")
      ? !(await db.select({ id: smsEventsTable.id, meta: smsEventsTable.meta }).from(smsEventsTable).where(and(eq(smsEventsTable.recipientId, rec.id), eq(smsEventsTable.kind, k))))
          .some((e) => k !== "interested" || String((e.meta as any)?.vacancyId ?? "") === vacancyId)
      : false;
    await logSmsEvent(rec.id, k, { ip: clientIp(req), userAgent: req.headers["user-agent"] as string, device: parseDevice(req.headers["user-agent"]), meta: vacancyId ? { vacancyId } : undefined });
    await advanceRecipient(rec.id, "cta");
    if (first) {
      const title = vacancyTitle((rec.campaign.landing ?? {}) as Record<string, any>, vacancyId);
      try { await upsertInterestedCandidate(rec, rec.campaign, k === "interested_ref" ? "хоче привести друга" : title); }
      catch (e) { logger.warn({ err: e, recipientId: rec.id }, "sms interested candidate failed"); }
      await notifyRecruiter(rec.campaign, `📞 <b>Зацікавлений з SMS</b>${k === "interested_ref" ? " · хоче привести друга" : ""}\n<b>${escapeHtml(rec.name || "—")}</b> · ${escapeHtml(rec.phone)} · ${rec.lang}${title ? `\nВакансія: ${escapeHtml(title)}` : ""}\nКампанія «${escapeHtml(rec.campaign.name)}». Звʼязатись протягом 1 робочого дня.`);
    }
  }
  return res.status(204).end();
});

// «Порекомендувати друга»: імʼя + телефон друга → кандидат у воронці «SMS-кампанії» (source
// sms_friend, нотатка з рекомендувачем) + подія friend у рекомендувача + картка рекрутеру.
// POST з нашого JS — шле X-Requested-With (CSRF-гард). Дубль телефону в кампанії — не створюємо.
router.post("/r/:token/friend", async (req, res) => {
  const token = String(req.params.token || "").toUpperCase();
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: "Лінк недійсний." });
  const rec = await findRecipientByToken(token);
  if (!rec) return res.status(404).json({ error: "Лінк недійсний." });
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const phone = normalizePhone(String(req.body?.phone ?? ""));
  const vacancyId = String(req.body?.vacancyId ?? "").slice(0, 40);
  if (!name || !phone) return res.status(400).json({ error: "name_phone" });
  if (phone === rec.phone) return res.status(400).json({ error: "own_phone" });
  const c = rec.campaign;
  const title = vacancyTitle((c.landing ?? {}) as Record<string, any>, vacancyId);
  const [dup] = await db.select({ id: candidatesTable.id }).from(candidatesTable).where(and(eq(candidatesTable.campaignId, c.id), eq(candidatesTable.phone, phone))).limit(1);
  if (!dup) {
    const [cand] = await db.insert(candidatesTable).values({
      funnelId: c.funnelId ?? await ensureSmsFunnel(), fullName: name, phone, stage: "new", source: "sms_friend", campaignId: c.id, language: rec.lang,
      assignedAdminId: c.recruiterAdminId ?? null, factoryId: (c.offer as any)?.factoryId ?? null,
      notes: `Рекомендація друга з SMS-кампанії «${c.name}»: від ${rec.name || "—"} ${rec.phone}${title ? ` · вакансія: ${title}` : ""}`,
    }).returning();
    await db.insert(candidateActivityTable).values({ candidateId: cand!.id, kind: "created", detail: `Рекомендував(ла) ${rec.name || rec.phone} з SMS-сторінки` });
  }
  await logSmsEvent(rec.id, "friend", { ip: clientIp(req), userAgent: req.headers["user-agent"] as string, device: parseDevice(req.headers["user-agent"]), meta: { name, phone, vacancyId, duplicate: !!dup } });
  await advanceRecipient(rec.id, "cta");
  if (!dup) await notifyRecruiter(c, `🎁 <b>Рекомендація друга з SMS</b>\n<b>${escapeHtml(name)}</b> · ${escapeHtml(phone)}${title ? ` · ${escapeHtml(title)}` : ""}\nВід: ${escapeHtml(rec.name || "—")} ${escapeHtml(rec.phone)} (бонус ${escapeHtml(String((c.offer as any)?.bonus || "300 zł"))} після 10 змін друга)\nКампанія «${escapeHtml(c.name)}». Кандидат у воронці «SMS-кампанії».`);
  return res.json({ ok: true }); // без «дубль/не дубль» назовні — не даємо перевіряти чужі номери
});

export default router;

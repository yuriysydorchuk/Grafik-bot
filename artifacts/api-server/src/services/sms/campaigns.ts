// SMS-кампанії: воронка, CRUD, імпорт отримувачів (валідація як у Drive-таблиці,
// дедуп, відокремлення активних працівників), персональні токени, події, статистика.
// Spec: docs/tasks/2026-09-21-sms-campaigns.md. Відправка — sender.ts.
import { and, eq, inArray, isNotNull, ne, sql, desc } from "drizzle-orm";
import {
  db, funnelsTable, smsCampaignsTable, smsRecipientsTable, smsEventsTable, workersTable, workerQuestionnairesTable, candidatesTable,
  type FunnelStage, type SmsCampaign, type SmsRecipient, type SmsTexts, type SmsSchedule, type SmsOffer, type SmsLanding,
} from "@workspace/db";
import { randomInviteCode } from "../../lib/invite";
import { logger } from "../../lib/logger";
import { normalizePhone, phoneCheck, phoneCountry, smsParts, renderSmsText } from "./phone";
import { getSmsProvider, smsLinkBase, type SmsProviderName } from "./provider";

export const SMS_FUNNEL_KIND = "sms";
const SMS_STAGES: FunnelStage[] = [
  { key: "new", color: "blue", label: "🆕 Нові заявки" },
  { key: "contacted", color: "amber", label: "📞 Зв'язалися" },
  { key: "interview", color: "violet", label: "🤝 Співбесіда" },
  { key: "hired", color: "emerald", label: "✅ Працюють" },
  { key: "rejected", color: "slate", label: "❌ Відмова" },
];

// Окрема воронка «SMS-кампанії» (рішення власника 21.09.2026), етапи як у «Реферали». Ідемпотентно.
export async function ensureSmsFunnel(): Promise<number> {
  const existing = (await db.select({ id: funnelsTable.id }).from(funnelsTable).where(eq(funnelsTable.kind, SMS_FUNNEL_KIND)))[0];
  if (existing) return existing.id;
  const [created] = await db.insert(funnelsTable).values({ name: "SMS-кампанії", kind: SMS_FUNNEL_KIND, stages: SMS_STAGES, sortOrder: 1 }).returning({ id: funnelsTable.id });
  logger.info({ funnelId: created!.id }, "Created SMS campaigns funnel");
  return created!.id;
}

export const SMS_LANGS = ["uk", "ru", "en"] as const;
export type SmsLang = (typeof SMS_LANGS)[number];
// Мова-оцінка з таблиці Drive («uk?», «uk/ru», «?», «ka»…) → мова тексту SMS.
export function smsLangOf(raw: string | null | undefined, phone?: string): SmsLang {
  const v = (raw ?? "").toLowerCase().trim();
  if (v.startsWith("en") || v === "asia/en" || v.startsWith("es") || v.startsWith("ar") || v.startsWith("tr") || v.startsWith("vi")) return "en";
  if (v.startsWith("ru") || v.startsWith("ka") || v.startsWith("bg") || v.startsWith("ro")) return "ru";
  if (v.startsWith("uk") || v === "?" || v === "") return v === "?" || v === "" ? (phone && phoneCountry(phone) === "other" ? "en" : "uk") : "uk";
  return "uk";
}

export const DEFAULT_SCHEDULE: SmsSchedule = { days: [2, 3, 4], from: "10:00", to: "14:00", dailyLimit: 1500, batchSize: 200 };

export type CampaignInput = {
  name: string; kind?: "job" | "referral"; provider?: SmsProviderName; sender?: string;
  texts?: SmsTexts; landing?: SmsLanding; offer?: SmsOffer; schedule?: Partial<SmsSchedule>;
  recruiterAdminId?: number | null;
};

export async function createCampaign(input: CampaignInput, adminId: number | null): Promise<SmsCampaign> {
  const funnelId = await ensureSmsFunnel();
  const [row] = await db.insert(smsCampaignsTable).values({
    name: input.name.trim(), kind: input.kind ?? "job", provider: input.provider ?? "smsapi", sender: input.sender?.trim() || "EuroSupport",
    texts: input.texts ?? {}, landing: input.landing ?? {}, offer: input.offer ?? {},
    schedule: { ...DEFAULT_SCHEDULE, ...(input.schedule ?? {}) },
    recruiterAdminId: input.recruiterAdminId ?? null, funnelId, createdBy: adminId,
  }).returning();
  return row!;
}

export async function updateCampaign(id: number, patch: Partial<CampaignInput> & { status?: SmsCampaign["status"] }): Promise<SmsCampaign | null> {
  const cur = await getCampaign(id);
  if (!cur) return null;
  const set: Partial<typeof smsCampaignsTable.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.sender !== undefined) set.sender = patch.sender.trim() || "EuroSupport";
  if (patch.texts !== undefined) set.texts = patch.texts;
  if (patch.landing !== undefined) set.landing = patch.landing;
  if (patch.offer !== undefined) set.offer = patch.offer;
  if (patch.schedule !== undefined) set.schedule = { ...cur.schedule, ...patch.schedule };
  if (patch.recruiterAdminId !== undefined) set.recruiterAdminId = patch.recruiterAdminId;
  if (patch.status !== undefined) set.status = patch.status;
  const [row] = await db.update(smsCampaignsTable).set(set).where(eq(smsCampaignsTable.id, id)).returning();
  return row ?? null;
}

export async function getCampaign(id: number): Promise<SmsCampaign | null> {
  return (await db.select().from(smsCampaignsTable).where(eq(smsCampaignsTable.id, id)))[0] ?? null;
}
export async function listCampaigns(): Promise<SmsCampaign[]> {
  return db.select().from(smsCampaignsTable).orderBy(desc(smsCampaignsTable.id));
}

// Статус кампанії: запуск/пауза/закриття. Запуск — лише owner (гейт у роуті).
export async function setCampaignStatus(id: number, status: SmsCampaign["status"]): Promise<SmsCampaign | null> {
  const set: Partial<typeof smsCampaignsTable.$inferInsert> = { status, updatedAt: new Date() };
  if (status === "sending" || status === "test") set.startedAt = new Date();
  const [row] = await db.update(smsCampaignsTable).set(set).where(eq(smsCampaignsTable.id, id)).returning();
  return row ?? null;
}

// ── Імпорт ─────────────────────────────────────────────────────────────────
export type ImportRow = { phone: string; name?: string | null; lang?: string | null; segment?: string | null; year?: number | string | null; sourceFile?: string | null };
export type ImportOptions = {
  includeUa?: boolean;      // слати на +380 (дорого) — за замовчуванням лише записи від uaMinYear
  uaMinYear?: number;       // 2024
  skipAlreadySent?: boolean; // номер уже отримував SMS в іншій кампанії → пропустити
};
export type ImportSummary = {
  total: number; added: number; skipped: Record<string, number>; byLang: Record<string, number>; activeWorkers: number;
};

const nameKey = (s: string): string =>
  (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1).sort().join(" ");
const firstNameOf = (name: string | null | undefined): string => {
  const t = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (t.length === 0) return "";
  return t.length === 1 ? t[0]! : t[0]!;
};

export async function importRecipients(campaignId: number, rows: ImportRow[], opts: ImportOptions = {}): Promise<ImportSummary> {
  const uaMinYear = opts.uaMinYear ?? 2024;
  const summary: ImportSummary = { total: rows.length, added: 0, skipped: {}, byLang: {}, activeWorkers: 0 };
  const skip = (why: string) => { summary.skipped[why] = (summary.skipped[why] ?? 0) + 1; };

  // Активні працівники: за телефоном анкети або за нормалізованим іменем.
  const active = await db.select({ id: workersTable.id, fullName: workersTable.fullName }).from(workersTable).where(eq(workersTable.status, "active"));
  const activeByName = new Map<string, number>();
  for (const w of active) { const k = nameKey(w.fullName); if (k.split(" ").length >= 2) activeByName.set(k, w.id); }
  const activeIds = new Set(active.map((w) => w.id));
  const qPhones = await db.select({ workerId: workerQuestionnairesTable.workerId, phone: workerQuestionnairesTable.phone }).from(workerQuestionnairesTable).where(isNotNull(workerQuestionnairesTable.phone));
  const activeByPhone = new Map<string, number>();
  for (const q of qPhones) { const p = q.phone ? normalizePhone(q.phone) : null; if (p && q.workerId && activeIds.has(q.workerId)) activeByPhone.set(p, q.workerId); }

  const existing = new Set((await db.select({ phone: smsRecipientsTable.phone }).from(smsRecipientsTable).where(eq(smsRecipientsTable.campaignId, campaignId))).map((r) => r.phone));
  const sentElsewhere = opts.skipAlreadySent
    ? new Set((await db.select({ phone: smsRecipientsTable.phone }).from(smsRecipientsTable).where(and(ne(smsRecipientsTable.campaignId, campaignId), inArray(smsRecipientsTable.status, ["sent", "delivered", "viewed", "cta", "bot", "form", "hired"])))).map((r) => r.phone))
    : new Set<string>();

  const toInsert: (typeof smsRecipientsTable.$inferInsert)[] = [];
  for (const row of rows) {
    const phone = normalizePhone(String(row.phone ?? ""));
    if (!phone) { skip("invalid"); continue; }
    if (existing.has(phone)) { skip("duplicate"); continue; }
    existing.add(phone);
    const check = phoneCheck(phone);
    const year = row.year != null && String(row.year).trim() !== "" ? Number(String(row.year).slice(0, 4)) : null;
    const lang = smsLangOf(row.lang, phone);
    const base = {
      campaignId, phone, name: row.name?.trim() || null, firstName: firstNameOf(row.name) || null, lang, segment: row.segment ?? null,
      year: Number.isFinite(year as number) ? year : null, sourceFile: row.sourceFile ?? null, token: randomInviteCode(24),
    };
    const workerId = activeByPhone.get(phone) ?? (row.name ? activeByName.get(nameKey(row.name)) : undefined);
    if (workerId) { summary.activeWorkers++; skip("active_worker"); toInsert.push({ ...base, status: "skipped", skippedReason: "active_worker", workerId }); continue; }
    if (check.smsOk !== "так") { skip(check.smsOk === "закордон" ? "foreign" : "invalid"); toInsert.push({ ...base, status: "skipped", skippedReason: "invalid" }); continue; }
    if (phoneCountry(phone) === "UA" && !opts.includeUa && !(year && year >= uaMinYear)) { skip("ua_excluded"); toInsert.push({ ...base, status: "skipped", skippedReason: "ua_excluded" }); continue; }
    if (sentElsewhere.has(phone)) { skip("already_sent"); toInsert.push({ ...base, status: "skipped", skippedReason: "already_sent" }); continue; }
    toInsert.push({ ...base, status: "queued" });
    summary.added++;
    summary.byLang[lang] = (summary.byLang[lang] ?? 0) + 1;
  }
  for (let i = 0; i < toInsert.length; i += 500) await db.insert(smsRecipientsTable).values(toInsert.slice(i, i + 500));
  logger.info({ campaignId, ...summary }, "SMS recipients imported");
  return summary;
}

// ── Лінки, тексти, події ───────────────────────────────────────────────────
export const recipientLink = (token: string): string => `${smsLinkBase()}/r/${token}`;

export function renderForRecipient(c: SmsCampaign, r: Pick<SmsRecipient, "lang" | "firstName" | "name" | "token">): { text: string; parts: number; encoding: string } {
  const tpl = c.texts[r.lang as SmsLang] || c.texts.uk || c.texts.en || c.texts.ru || "";
  const text = renderSmsText(tpl, { name: r.firstName || firstNameOf(r.name), link: recipientLink(r.token) });
  const p = smsParts(text);
  return { text, parts: p.parts, encoding: p.encoding };
}

export async function logSmsEvent(recipientId: number, kind: string, extra: { ip?: string | null; userAgent?: string | null; device?: string | null; meta?: unknown } = {}): Promise<void> {
  await db.insert(smsEventsTable).values({ recipientId, kind, ip: extra.ip ?? null, userAgent: extra.userAgent?.slice(0, 300) ?? null, device: extra.device ?? null, meta: extra.meta ?? null });
}

export async function findRecipientByToken(token: string): Promise<(SmsRecipient & { campaign: SmsCampaign }) | null> {
  const [r] = await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.token, token));
  if (!r) return null;
  const c = await getCampaign(r.campaignId);
  return c ? { ...r, campaign: c } : null;
}

// Просування статусу воронки лише вперед (delivered → viewed → cta → bot → form → hired).
const ORDER = ["queued", "sent", "failed", "delivered", "viewed", "cta", "bot", "form", "hired"];
export async function advanceRecipient(id: number, status: string, extra: Partial<typeof smsRecipientsTable.$inferInsert> = {}): Promise<void> {
  const [r] = await db.select({ status: smsRecipientsTable.status }).from(smsRecipientsTable).where(eq(smsRecipientsTable.id, id));
  if (!r) return;
  const cur = ORDER.indexOf(r.status), next = ORDER.indexOf(status);
  const set = next > cur ? { status, ...extra } : extra;
  if (Object.keys(set).length) await db.update(smsRecipientsTable).set(set).where(eq(smsRecipientsTable.id, id));
}

// ── Статистика ─────────────────────────────────────────────────────────────
export type CampaignStats = {
  recipients: number; queued: number; sent: number; delivered: number; failed: number; viewed: number; cta: number; bot: number; form: number; hired: number; skipped: number;
  activeWorkers: number; parts: number; costEstimate: number; byLang: Record<string, number>;
};
export async function campaignStats(c: SmsCampaign): Promise<CampaignStats> {
  const rows = await db.select({ status: smsRecipientsTable.status, skippedReason: smsRecipientsTable.skippedReason, lang: smsRecipientsTable.lang, parts: smsRecipientsTable.parts, phone: smsRecipientsTable.phone, sentAt: smsRecipientsTable.sentAt })
    .from(smsRecipientsTable).where(eq(smsRecipientsTable.campaignId, c.id));
  const provider = getSmsProvider(c.provider as SmsProviderName);
  const s: CampaignStats = { recipients: 0, queued: 0, sent: 0, delivered: 0, failed: 0, viewed: 0, cta: 0, bot: 0, form: 0, hired: 0, skipped: 0, activeWorkers: 0, parts: 0, costEstimate: 0, byLang: {} };
  for (const r of rows) {
    if (r.status === "skipped") { s.skipped++; if (r.skippedReason === "active_worker") s.activeWorkers++; continue; }
    s.recipients++;
    s.byLang[r.lang] = (s.byLang[r.lang] ?? 0) + 1;
    const i = ORDER.indexOf(r.status);
    if (r.status === "queued") s.queued++;
    if (r.status === "failed") { s.failed++; }
    if (r.sentAt) s.sent++;
    if (i >= ORDER.indexOf("delivered")) s.delivered++;
    if (i >= ORDER.indexOf("viewed")) s.viewed++;
    if (i >= ORDER.indexOf("cta")) s.cta++;
    if (i >= ORDER.indexOf("bot")) s.bot++;
    if (i >= ORDER.indexOf("form")) s.form++;
    if (i >= ORDER.indexOf("hired")) s.hired++;
    if (r.sentAt) { const p = r.parts ?? 1; s.parts += p; s.costEstimate += p * provider.price(r.phone); }
  }
  s.costEstimate = Math.round(s.costEstimate * 100) / 100;
  return s;
}

// Кандидати, створені з кампанії (для картки і плитки дашборду).
export async function campaignCandidateCount(campaignId: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(candidatesTable).where(eq(candidatesTable.campaignId, campaignId));
  return r?.n ?? 0;
}

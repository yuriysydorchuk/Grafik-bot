import nodemailer from "nodemailer";
import { db } from "@workspace/db";
import {
  scheduleEntriesTable, scheduleWeeksTable, factoriesTable, settingsTable,
  emailTemplatesTable, factoryEmailRecipientsTable,
  type DayOfWeek,
} from "@workspace/db";
import { eq, and, ne, desc, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { DAYS } from "./sheets";

// ─── Email template (settings-backed, scenario "schedule") ───────────────────
// Plain-text letter: greeting + signature; the schedule itself goes as an Excel
// attachment. Placeholders: {data} — day date or week range, {fabryka} — factory name.
export const SCHEDULE_EMAIL_DEFAULTS = {
  subject: "Grafik na {data}",
  body: `Dzień dobry. Wysyłam grafik na {data}
Z wyrazami szacunku,
Viktoriia Oliinyk
Specjalista ds. administracji personalnej i grafików
+48 731 437 822
e-mail: office.eurosupp@gmail.com
ul. Krakowskie Przedmieście 55, 20-076, Lublin
tel.:  +48 530 878 711
facebook/eurosupportES
instagram/euro_support_
https://eurosupp.pl/
Viber: +48 530 878 711
NIP: 9462698100; Regon: 386387801`,
} as const;

// Legacy: до 09.2026 єдиний глобальний шаблон жив у settings під цими ключами.
// Тепер шаблони — таблиця email_templates; старі значення сідуть у перший
// («стандартний») шаблон при першому зверненні (ensureDefaultTemplate).
const TPL_KEYS = { subject: "email_tpl_schedule_subject", body: "email_tpl_schedule_body" } as const;

export type EmailTemplateRow = typeof emailTemplatesTable.$inferSelect;

// Гарантує, що є хоча б один шаблон і рівно один isDefault. Повертає стандартний.
export async function ensureDefaultTemplate(): Promise<EmailTemplateRow> {
  const all = await db.select().from(emailTemplatesTable).orderBy(emailTemplatesTable.id);
  if (all.length === 0) {
    const rows = await db.select().from(settingsTable).where(inArray(settingsTable.key, [TPL_KEYS.subject, TPL_KEYS.body]));
    const byKey = new Map(rows.map(r => [r.key, r.value]));
    const [created] = await db.insert(emailTemplatesTable).values({
      name: "Standardowy",
      subject: byKey.get(TPL_KEYS.subject)?.trim() || SCHEDULE_EMAIL_DEFAULTS.subject,
      body: byKey.get(TPL_KEYS.body)?.trim() || SCHEDULE_EMAIL_DEFAULTS.body,
      isDefault: true,
    }).returning();
    return created!;
  }
  const def = all.find(t => t.isDefault);
  if (def) return def;
  const [fixed] = await db.update(emailTemplatesTable).set({ isDefault: true }).where(eq(emailTemplatesTable.id, all[0]!.id)).returning();
  return fixed!;
}

export async function listEmailTemplates(): Promise<EmailTemplateRow[]> {
  await ensureDefaultTemplate();
  return db.select().from(emailTemplatesTable).orderBy(emailTemplatesTable.id);
}

// Стандартний шаблон (для сумісності зі старими викликами)
export async function getScheduleEmailTemplate(): Promise<{ subject: string; body: string }> {
  const def = await ensureDefaultTemplate();
  return { subject: def.subject, body: def.body };
}

export type FactoryRecipient = { id: number; email: string; name: string | null; templateId: number | null };

// Отримувачі графіку фабрики. Якщо таблиця для фабрики порожня, а legacy
// factories.client_email заповнений — повертаємо його як єдиного отримувача
// (id = 0), щоб старі дані працювали до міграції в UI.
export async function factoryEmailRecipients(factoryId: number, legacyEmail?: string | null): Promise<FactoryRecipient[]> {
  const rows = await db.select({
    id: factoryEmailRecipientsTable.id, email: factoryEmailRecipientsTable.email,
    name: factoryEmailRecipientsTable.name, templateId: factoryEmailRecipientsTable.templateId,
  }).from(factoryEmailRecipientsTable).where(eq(factoryEmailRecipientsTable.factoryId, factoryId)).orderBy(factoryEmailRecipientsTable.id);
  if (rows.length) return rows;
  const legacy = legacyEmail?.trim();
  return legacy ? [{ id: 0, email: legacy, name: null, templateId: null }] : [];
}

export const isEmail = (v: string) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v);

// Замінює список отримувачів фабрики. factories.client_email тримаємо як
// денормалізований кеш «усі адреси через кому» — його читають старі поверхні
// (approve-роут, бот-затвердження, /hours). Повертає збережений список.
export async function setFactoryRecipients(
  factoryId: number,
  input: { email: string; name?: string | null; templateId?: number | null }[],
): Promise<FactoryRecipient[]> {
  const seen = new Set<string>();
  const clean = input
    .map(r => ({ email: String(r.email ?? "").trim().toLowerCase(), name: r.name?.trim() || null, templateId: r.templateId ?? null }))
    .filter(r => isEmail(r.email) && !seen.has(r.email) && seen.add(r.email))
    .slice(0, 20);
  await db.transaction(async (tx) => {
    await tx.delete(factoryEmailRecipientsTable).where(eq(factoryEmailRecipientsTable.factoryId, factoryId));
    if (clean.length) await tx.insert(factoryEmailRecipientsTable).values(clean.map(r => ({ factoryId, ...r })));
    await tx.update(factoriesTable).set({ clientEmail: clean.length ? clean.map(r => r.email).join(", ") : null }).where(eq(factoriesTable.id, factoryId));
  });
  return factoryEmailRecipients(factoryId);
}

// Мапа factoryId → список email-ів (для списків фабрик / модалок графіку)
export async function factoryEmailMap(factoryIds: number[], legacy: Map<number, string | null>): Promise<Map<number, FactoryRecipient[]>> {
  const out = new Map<number, FactoryRecipient[]>();
  if (factoryIds.length === 0) return out;
  const rows = await db.select({
    id: factoryEmailRecipientsTable.id, factoryId: factoryEmailRecipientsTable.factoryId, email: factoryEmailRecipientsTable.email,
    name: factoryEmailRecipientsTable.name, templateId: factoryEmailRecipientsTable.templateId,
  }).from(factoryEmailRecipientsTable).where(inArray(factoryEmailRecipientsTable.factoryId, factoryIds)).orderBy(factoryEmailRecipientsTable.id);
  for (const r of rows) {
    const list = out.get(r.factoryId) ?? [];
    list.push({ id: r.id, email: r.email, name: r.name, templateId: r.templateId });
    out.set(r.factoryId, list);
  }
  for (const fid of factoryIds) {
    if (out.has(fid)) continue;
    const l = legacy.get(fid)?.trim();
    if (l) out.set(fid, [{ id: 0, email: l, name: null, templateId: null }]);
  }
  return out;
}

const fillTemplate = (tpl: string, params: Record<string, string>) => {
  let out = tpl;
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, v);
  return out;
};

// "07.07.2026" — dates as dd.mm.yyyy with leading zeros (client-facing)
const fmtDate = (x: Date) =>
  `${String(x.getDate()).padStart(2, "0")}.${String(x.getMonth() + 1).padStart(2, "0")}.${x.getFullYear()}`;

// {data} value: single day date, or "start – end" for the whole week
const dataLabel = (weekStart: string, day?: DayOfWeek | null): string => {
  const d = new Date(weekStart + "T00:00:00");
  if (day) { d.setDate(d.getDate() + DAYS.indexOf(day)); return fmtDate(d); }
  const end = new Date(d); end.setDate(d.getDate() + 6);
  return `${fmtDate(d)} – ${fmtDate(end)}`;
};

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

// Довільний лист із вкладеннями (лист клієнту про розбіжності годин тощо).
// Кидає помилку, якщо SMTP не налаштовано — викликач показує її адміну.
export async function sendEmailWithAttachments(
  to: string,
  subject: string,
  text: string,
  attachments: { filename: string; content: Buffer }[],
): Promise<void> {
  const tx = getTransporter();
  if (!tx) throw new Error("SMTP не налаштовано (лист не надіслано)");
  await tx.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to, subject, text, attachments,
  });
}

// Send schedule for one factory to all its recipients — whole week, or a single day when `day` is given.
// Отримувачі групуються по шаблону: одна група = один лист (спільний Excel у вкладенні).
// Returns a human-readable status string.
export async function sendScheduleEmail(factoryId: number, weekStart: string, day?: DayOfWeek | null): Promise<string> {
  const factory = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
  if (!factory) return "фабрику не знайдено";
  const recipients = await factoryEmailRecipients(factoryId, factory.clientEmail);
  if (recipients.length === 0) return "email клієнта не вказано";

  const candidates = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  const week = candidates.find(w => w.status === "approved") ?? candidates[0];
  if (!week) return "тиждень не знайдено";

  const entries = await db
    .select({ id: scheduleEntriesTable.id })
    .from(scheduleEntriesTable)
    .where(and(
      eq(scheduleEntriesTable.weekId, week.id),
      eq(scheduleEntriesTable.factoryId, factoryId),
      ne(scheduleEntriesTable.status, "absent"),
      ...(day ? [eq(scheduleEntriesTable.dayOfWeek, day)] : []),
    ));
  if (entries.length === 0) return day ? "на цей день немає змін" : "на цей тиждень немає змін";

  const params = { data: dataLabel(weekStart, day), fabryka: factory.name };
  const defaultTpl = await ensureDefaultTemplate();
  const templates = new Map((await db.select().from(emailTemplatesTable)).map(t => [t.id, t]));
  // template id → адреси; отримувач без шаблону (або з видаленим) іде стандартним
  const groups = new Map<number, string[]>();
  for (const r of recipients) {
    const tpl = (r.templateId != null && templates.get(r.templateId)) || defaultTpl;
    groups.set(tpl.id, [...(groups.get(tpl.id) ?? []), r.email]);
  }
  const allTo = recipients.map(r => r.email).join(", ");

  const tx = getTransporter();
  if (!tx) {
    logger.warn({ factory: factory.name, to: allTo }, "SMTP not configured — email not sent (preview logged)");
    const preview = fillTemplate(defaultTpl.body, params);
    logger.info({ subject: fillTemplate(defaultTpl.subject, params), textPreview: preview.slice(0, 200) }, "Email preview");
    return "⚠️ SMTP не налаштовано (лист не надіслано)";
  }

  // Same Excel the client gets on Drive (position/gender segregation), scoped to the day when given
  const attachments: { filename: string; content: Buffer }[] = [];
  try {
    const { buildScheduleExcelBuffer } = await import("./drive");
    const excel = await buildScheduleExcelBuffer(week.id, factoryId, day ?? null);
    if (excel) attachments.push({ filename: excel.fileName, content: excel.buffer });
  } catch (e) {
    logger.error({ err: e }, "Failed to build Excel attachment for schedule email");
  }

  const sent: string[] = [];
  const failed: string[] = [];
  for (const [tplId, to] of groups) {
    const tpl = templates.get(tplId) ?? defaultTpl;
    try {
      await tx.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
        to: to.join(", "),
        subject: fillTemplate(tpl.subject, params),
        text: fillTemplate(tpl.body, params),
        attachments,
      });
      logger.info({ factory: factory.name, to, template: tpl.name, day: day ?? "week" }, "Schedule email sent");
      sent.push(...to);
    } catch (e) {
      logger.error({ err: e, to }, "Failed to send schedule email");
      failed.push(...to);
    }
  }
  if (failed.length === 0) return `✅ надіслано на ${sent.join(", ")}`;
  if (sent.length === 0) return "❌ помилка надсилання email";
  return `⚠️ надіслано на ${sent.join(", ")}; не вдалося: ${failed.join(", ")}`;
}

import nodemailer from "nodemailer";
import { db } from "@workspace/db";
import {
  scheduleEntriesTable, scheduleWeeksTable, factoriesTable, settingsTable,
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

const TPL_KEYS = { subject: "email_tpl_schedule_subject", body: "email_tpl_schedule_body" } as const;

export async function getScheduleEmailTemplate(): Promise<{ subject: string; body: string }> {
  const rows = await db.select().from(settingsTable).where(inArray(settingsTable.key, [TPL_KEYS.subject, TPL_KEYS.body]));
  const byKey = new Map(rows.map(r => [r.key, r.value]));
  return {
    subject: byKey.get(TPL_KEYS.subject)?.trim() || SCHEDULE_EMAIL_DEFAULTS.subject,
    body: byKey.get(TPL_KEYS.body)?.trim() || SCHEDULE_EMAIL_DEFAULTS.body,
  };
}

export async function saveScheduleEmailTemplate(subject: string, body: string): Promise<void> {
  for (const [value, key] of [[subject, TPL_KEYS.subject], [body, TPL_KEYS.body]] as const) {
    await db.insert(settingsTable).values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
  }
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

// Send schedule for one factory to its client email — whole week, or a single day when `day` is given.
// Returns a human-readable status string.
export async function sendScheduleEmail(factoryId: number, weekStart: string, day?: DayOfWeek | null): Promise<string> {
  const factory = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
  if (!factory) return "фабрику не знайдено";
  if (!factory.clientEmail) return "email клієнта не вказано";

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
  const tpl = await getScheduleEmailTemplate();
  const subject = fillTemplate(tpl.subject, params);
  const text = fillTemplate(tpl.body, params);

  const tx = getTransporter();
  if (!tx) {
    logger.warn({ factory: factory.name, to: factory.clientEmail }, "SMTP not configured — email not sent (preview logged)");
    logger.info({ subject, textPreview: text.slice(0, 200) }, "Email preview");
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

  try {
    await tx.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: factory.clientEmail,
      subject,
      text,
      attachments,
    });
    logger.info({ factory: factory.name, to: factory.clientEmail, day: day ?? "week" }, "Schedule email sent");
    return `✅ надіслано на ${factory.clientEmail}`;
  } catch (e) {
    logger.error({ err: e }, "Failed to send schedule email");
    return "❌ помилка надсилання email";
  }
}

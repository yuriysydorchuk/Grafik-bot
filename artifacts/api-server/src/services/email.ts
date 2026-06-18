import nodemailer from "nodemailer";
import { db } from "@workspace/db";
import {
  scheduleEntriesTable, workersTable, factoriesTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { DAYS } from "./sheets";

// Polish day labels for the client-facing email
const DAY_PL: Record<string, string> = {
  mon: "Poniedziałek", tue: "Wtorek", wed: "Środa",
  thu: "Czwartek", fri: "Piątek", sat: "Sobota", sun: "Niedziela",
};
const SHIFT_PL: Record<string, string> = { "1": "Zmiana 1", "2": "Zmiana 2", "3": "Zmiana 3" };

const weekLabel = (weekStart: string) => {
  const d = new Date(weekStart + "T00:00:00");
  const end = new Date(d); end.setDate(d.getDate() + 6);
  const fmt = (x: Date) => x.toLocaleDateString("pl-PL", { day: "numeric", month: "numeric", year: "numeric" });
  return `${fmt(d)} – ${fmt(end)}`;
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

// ─── Per-factory email template ───────────────────────────────────────────────
// Default template. To customise per factory, branch on factoryName here later.
function buildScheduleEmailHtml(factoryName: string, weekStart: string, byDay: Map<string, { shift: Shift; name: string }[]>): string {
  let rowsHtml = "";
  for (const day of DAYS) {
    const entries = byDay.get(day) ?? [];
    if (entries.length === 0) continue;
    rowsHtml += `<tr><td colspan="2" style="background:#f0f0f0;font-weight:bold;padding:6px;">${DAY_PL[day]}</td></tr>`;
    for (const shift of ["1", "2", "3"] as Shift[]) {
      const names = entries.filter(e => e.shift === shift).map(e => e.name);
      if (names.length === 0) continue;
      rowsHtml += `<tr><td style="padding:4px 8px;border:1px solid #ddd;white-space:nowrap;">${SHIFT_PL[shift]} (${names.length})</td><td style="padding:4px 8px;border:1px solid #ddd;">${names.join(", ")}</td></tr>`;
    }
  }
  return `
    <div style="font-family:Arial,sans-serif;max-width:700px;">
      <h2>Grafik pracy — ${factoryName}</h2>
      <p>Tydzień: <b>${weekLabel(weekStart)}</b></p>
      <table style="border-collapse:collapse;width:100%;">${rowsHtml}</table>
      <p style="color:#888;font-size:12px;margin-top:16px;">Wiadomość wygenerowana automatycznie.</p>
    </div>`;
}

// Send approved schedule for one factory to its client email.
// Returns a human-readable status string.
export async function sendScheduleEmail(factoryId: number, weekStart: string): Promise<string> {
  const factory = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
  if (!factory) return "фабрику не знайдено";
  if (!factory.clientEmail) return "email клієнта не вказано";

  const entries = await db
    .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, name: workersTable.fullName })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(eq(scheduleEntriesTable.factoryId, factoryId)));

  const byDay = new Map<string, { shift: Shift; name: string }[]>();
  for (const e of entries) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day)!.push({ shift: e.shift as Shift, name: e.name ?? "—" });
  }

  const html = buildScheduleEmailHtml(factory.name, weekStart, byDay);
  const subject = `Grafik pracy — ${factory.name} — ${weekLabel(weekStart)}`;

  const tx = getTransporter();
  if (!tx) {
    logger.warn({ factory: factory.name, to: factory.clientEmail }, "SMTP not configured — email not sent (preview logged)");
    logger.info({ subject, htmlPreview: html.slice(0, 200) }, "Email preview");
    return "⚠️ SMTP не налаштовано (лист не надіслано)";
  }

  try {
    await tx.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: factory.clientEmail,
      subject,
      html,
    });
    logger.info({ factory: factory.name, to: factory.clientEmail }, "Schedule email sent");
    return `✅ надіслано на ${factory.clientEmail}`;
  } catch (e) {
    logger.error({ err: e }, "Failed to send schedule email");
    return "❌ помилка надсилання email";
  }
}

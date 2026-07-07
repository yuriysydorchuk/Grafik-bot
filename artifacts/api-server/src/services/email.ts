import nodemailer from "nodemailer";
import { db } from "@workspace/db";
import {
  scheduleEntriesTable, scheduleWeeksTable, workersTable, factoriesTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and, ne, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { DAYS } from "./sheets";

// Polish day labels for the client-facing email
const DAY_PL: Record<string, string> = {
  mon: "Poniedziałek", tue: "Wtorek", wed: "Środa",
  thu: "Czwartek", fri: "Piątek", sat: "Sobota", sun: "Niedziela",
};
const SHIFT_PL: Record<string, string> = { "1": "Zmiana 1", "2": "Zmiana 2", "3": "Zmiana 3" };

const fmtPl = (x: Date) => x.toLocaleDateString("pl-PL", { day: "numeric", month: "numeric", year: "numeric" });

const weekLabel = (weekStart: string) => {
  const d = new Date(weekStart + "T00:00:00");
  const end = new Date(d); end.setDate(d.getDate() + 6);
  return `${fmtPl(d)} – ${fmtPl(end)}`;
};

// "Poniedziałek 7.07.2026" — label for a single-day email
const dayLabel = (weekStart: string, day: DayOfWeek) => {
  const d = new Date(weekStart + "T00:00:00");
  d.setDate(d.getDate() + DAYS.indexOf(day));
  return `${DAY_PL[day]} ${fmtPl(d)}`;
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
function buildScheduleEmailHtml(factoryName: string, periodLabel: string, byDay: Map<string, { shift: Shift; name: string }[]>): string {
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
      <p><b>${periodLabel}</b></p>
      <table style="border-collapse:collapse;width:100%;">${rowsHtml}</table>
      <p style="color:#888;font-size:12px;margin-top:16px;">Wiadomość wygenerowana automatycznie.</p>
    </div>`;
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
    .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, name: workersTable.fullName })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(
      eq(scheduleEntriesTable.weekId, week.id),
      eq(scheduleEntriesTable.factoryId, factoryId),
      ne(scheduleEntriesTable.status, "absent"),
      ...(day ? [eq(scheduleEntriesTable.dayOfWeek, day)] : []),
    ));
  if (entries.length === 0) return day ? "на цей день немає змін" : "на цей тиждень немає змін";

  const byDay = new Map<string, { shift: Shift; name: string }[]>();
  for (const e of entries) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day)!.push({ shift: e.shift as Shift, name: e.name ?? "—" });
  }

  const periodLabel = day ? dayLabel(weekStart, day) : `Tydzień: ${weekLabel(weekStart)}`;
  const html = buildScheduleEmailHtml(factory.name, periodLabel, byDay);
  const subject = `Grafik pracy — ${factory.name} — ${day ? dayLabel(weekStart, day) : weekLabel(weekStart)}`;

  const tx = getTransporter();
  if (!tx) {
    logger.warn({ factory: factory.name, to: factory.clientEmail }, "SMTP not configured — email not sent (preview logged)");
    logger.info({ subject, htmlPreview: html.slice(0, 200) }, "Email preview");
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
      html,
      attachments,
    });
    logger.info({ factory: factory.name, to: factory.clientEmail, day: day ?? "week" }, "Schedule email sent");
    return `✅ надіслано на ${factory.clientEmail}`;
  } catch (e) {
    logger.error({ err: e }, "Failed to send schedule email");
    return "❌ помилка надсилання email";
  }
}

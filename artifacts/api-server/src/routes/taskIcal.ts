// Підписка на календар задач (макет 5б «Підписка»): приватний iCal-лінк адміна для Google /
// Apple Calendar. Публічний роут без сесії — токен = adminId + HMAC(SESSION_SECRET), нічого не
// зберігаємо; зміна SESSION_SECRET відкликає всі лінки. Віддає зустрічі (з часом і тривалістю)
// та відкриті задачі зі строком (весь день) за −30…+120 днів.
import { Router, type IRouter } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db, tasksTable, adminsTable } from "@workspace/db";
import { addDaysStr } from "../lib/dates";
import { OPEN_STATUSES, warsawToday, dateStr } from "../services/taskUtils";

const SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
const sign = (adminId: number) => createHmac("sha256", SECRET).update(`ical:${adminId}`).digest("hex").slice(0, 32);
export const icalToken = (adminId: number) => `${adminId}.${sign(adminId)}`;
export function icalUrl(adminId: number): string {
  const base = (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
  return `${base}/api/calendar/${icalToken(adminId)}.ics`;
}
function parseToken(raw: string): number | null {
  const [id, sig] = raw.replace(/\.ics$/, "").split(".");
  const adminId = Number(id);
  if (!Number.isInteger(adminId) || !sig) return null;
  const want = Buffer.from(sign(adminId)); const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? adminId : null;
}
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const dt = (d: string) => d.replace(/-/g, "");

const router: IRouter = Router();
router.get("/calendar/:token", async (req, res) => {
  const adminId = parseToken(String(req.params.token));
  if (!adminId) return res.status(404).type("text/plain").send("not found");
  const [a] = await db.select({ id: adminsTable.id, name: adminsTable.name }).from(adminsTable).where(eq(adminsTable.id, adminId));
  if (!a) return res.status(404).type("text/plain").send("not found");
  const today = warsawToday();
  const rows = await db.select().from(tasksTable).where(and(
    or(eq(tasksTable.assigneeAdminId, adminId), eq(tasksTable.creatorAdminId, adminId), sql`exists (select 1 from task_assignees x where x.task_id = ${tasksTable.id} and x.admin_id = ${adminId})`),
    inArray(tasksTable.status, [...OPEN_STATUSES, "done"]),
    gte(tasksTable.dueAt, addDaysStr(today, -30)), lte(tasksTable.dueAt, addDaysStr(today, 120)),
  ));
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Euro Support//Grafik-bot tasks//UK", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(`Задачі · ${a.name}`)}`, "X-WR-TIMEZONE:Europe/Warsaw"];
  for (const t of rows) {
    const due = dateStr(t.dueAt); if (!due) continue;
    lines.push("BEGIN:VEVENT", `UID:task-${t.id}@grafik-bot`, `DTSTAMP:${dt(today)}T000000Z`, `SUMMARY:${esc(`${t.kind === "meeting" ? "🗓 " : t.status === "done" ? "✓ " : ""}${t.title}`)}`);
    if (t.dueTime) {
      const [h, m] = t.dueTime.split(":").map(Number);
      const startMin = h! * 60 + m!, endMin = startMin + (t.durationMin ?? (t.kind === "meeting" ? 45 : 30));
      const hm = (x: number) => `${String(Math.floor(x / 60) % 24).padStart(2, "0")}${String(x % 60).padStart(2, "0")}00`;
      lines.push(`DTSTART;TZID=Europe/Warsaw:${dt(due)}T${hm(startMin)}`, `DTEND;TZID=Europe/Warsaw:${dt(due)}T${hm(endMin)}`);
    } else lines.push(`DTSTART;VALUE=DATE:${dt(due)}`, `DTEND;VALUE=DATE:${dt(addDaysStr(due, 1))}`);
    if (t.place) lines.push(`LOCATION:${esc(t.place)}`);
    const desc = [t.description, (t.agenda ?? []).length ? (t.agenda ?? []).map((x, i) => `${i + 1}. ${x}`).join("\n") : null].filter(Boolean).join("\n");
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    lines.push(`STATUS:${t.status === "done" ? "COMPLETED" : t.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.send(lines.join("\r\n") + "\r\n");
});
export default router;

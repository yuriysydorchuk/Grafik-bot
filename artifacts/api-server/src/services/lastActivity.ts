// Останній слід роботи людини: явка (present у тижні обліку — сюди ж лягають відмітки зміни
// в боті й посадка водія), останній день у файлі годин фабрики, рапорт. Джерело для
// попередження «звільняєш ранішою датою» (POST /hours/last-activity) і для підказки дати в
// задачі перевірки звільнення (services/fireReview.ts): «останній робочий день — це і є день
// звільнення». Дата `exact=false` — слід лише з точністю до місяця (години фабрики без
// розбивки по днях, рапорт): тоді date = останній день місяця, а точну дату дає `lastExact`.
import { db, scheduleEntriesTable, scheduleWeeksTable, factoryHoursTable, monthlyReportsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { entryDateStr } from "../lib/dates";
import { accountingWeekSql } from "./weeks";

export type ActivitySource = "явка" | "години фабрики" | "рапорт";
export interface ActivityPoint { date: string; source: ActivitySource; exact: boolean }
export interface LastActivity extends ActivityPoint { lastExact: ActivityPoint | null }

const monthLastDay = (m: string): string => {
  const [yy, mm] = m.split("-").map(Number);
  return `${m}-${String(new Date(yy!, mm!, 0).getDate()).padStart(2, "0")}`;
};

// onlyFactory: для цих людей рахується слід лише на вказаній фабриці (людина на кількох фабриках:
// слід з іншої фабрики не каже, коли вона востаннє працювала на цій). Рапорт без фабрики рахується.
export async function loadLastActivity(workerIds: number[], onlyFactory?: Map<number, number>): Promise<Map<number, LastActivity>> {
  const out = new Map<number, LastActivity>();
  const skip = (workerId: number, factoryId: number | null | undefined) => { const f = onlyFactory?.get(workerId); return f != null && factoryId != null && factoryId !== f; };
  const ids = [...new Set(workerIds.filter(Boolean))];
  if (!ids.length) return out;
  const bump = (id: number, p: ActivityPoint) => {
    const cur = out.get(id);
    const lastExact = p.exact && (!cur?.lastExact || p.date > cur.lastExact.date) ? p : cur?.lastExact ?? null;
    // за однакової дати точний слід важливіший за місячний
    const top = !cur || p.date > cur.date || (p.date === cur.date && p.exact && !cur.exact) ? p : cur;
    out.set(id, { date: top.date, source: top.source, exact: top.exact, lastExact });
  };
  const ents = await db.select({ workerId: scheduleEntriesTable.workerId, factoryId: scheduleEntriesTable.factoryId, day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart })
    .from(scheduleEntriesTable)
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(accountingWeekSql, eq(scheduleEntriesTable.status, "present"), inArray(scheduleEntriesTable.workerId, ids)));
  for (const e of ents) if (e.workerId && !skip(e.workerId, e.factoryId)) bump(e.workerId, { date: entryDateStr(String(e.weekStart), e.day), source: "явка", exact: true });
  const fh = await db.select({ workerId: factoryHoursTable.workerId, factoryId: factoryHoursTable.factoryId, month: factoryHoursTable.month, hours: factoryHoursTable.hours, days: factoryHoursTable.days })
    .from(factoryHoursTable).where(inArray(factoryHoursTable.workerId, ids));
  for (const r of fh) {
    if (!r.hours || r.hours <= 0 || skip(r.workerId, r.factoryId)) continue;
    const days = r.days && typeof r.days === "object" ? Object.keys(r.days).sort() : [];
    const last = days.at(-1);
    bump(r.workerId, last ? { date: last, source: "години фабрики", exact: true } : { date: monthLastDay(r.month), source: "години фабрики", exact: false });
  }
  const reps = await db.select({ workerId: monthlyReportsTable.workerId, factoryId: monthlyReportsTable.factoryId, month: monthlyReportsTable.month })
    .from(monthlyReportsTable).where(inArray(monthlyReportsTable.workerId, ids));
  for (const r of reps) if (!skip(r.workerId, r.factoryId)) bump(r.workerId, { date: monthLastDay(r.month), source: "рапорт", exact: false });
  return out;
}

// Щоденний фід для зовнішнього сервісу розрахунку рекрутерів: активні
// працівники зі стажем ≤60 днів (від employmentStartDate, фолбек createdAt),
// у яких є години в обліку (сума за весь час роботи, мінус 8, не нижче 0).
// Пише в окремий Google Sheet (перезапис усього листа щодня), не в БД.
import { google } from "googleapis";
import { db } from "@workspace/db";
import { workersTable, factoriesTable, scheduleEntriesTable, scheduleWeeksTable, settingsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getDriveAuth } from "./drive";
import { daysBetween } from "./svodni";
import { warsawDateStr, factoryShiftHours } from "../bot/time";

type FactoryRow = typeof factoriesTable.$inferSelect;

const MAX_TENURE_DAYS = 60;
const HOURS_OFFSET = 8;
const SETTINGS_KEY = "recruiter_hours_sheet_id";

async function getSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  return rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settingsTable).values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

const dayStr = (v: string | Date | null | undefined): string | null => {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
};

async function ensureSpreadsheetId(sheets: ReturnType<typeof google.sheets>): Promise<string> {
  const existing = await getSetting(SETTINGS_KEY);
  if (existing) return existing;
  const created = await sheets.spreadsheets.create({
    requestBody: { properties: { title: "Облік годин — рекрутинг (авто)" } },
  });
  const id = created.data.spreadsheetId!;
  await setSetting(SETTINGS_KEY, id);
  logger.info({ spreadsheetId: id, url: `https://docs.google.com/spreadsheets/d/${id}` }, "Recruiter hours sheet created — share it with the external service manually");
  return id;
}

export async function syncRecruiterHoursSheet(): Promise<{ spreadsheetId: string; rows: number }> {
  const today = warsawDateStr();

  const activeWorkers = await db.select({
    id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode,
    employmentStartDate: workersTable.employmentStartDate, createdAt: workersTable.createdAt,
  }).from(workersTable).where(eq(workersTable.isActive, true));

  const freshWorkers = activeWorkers.filter(w => {
    const start = dayStr(w.employmentStartDate) ?? dayStr(w.createdAt);
    if (!start) return false;
    return daysBetween(start, today) <= MAX_TENURE_DAYS;
  });

  const auth = getDriveAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = await ensureSpreadsheetId(sheets);

  if (freshWorkers.length === 0) {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: "A1:Z" });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: "A1", valueInputOption: "RAW",
      requestBody: { values: [["ПІБ", "Код", "Години"]] },
    });
    return { spreadsheetId, rows: 0 };
  }

  const freshIds = freshWorkers.map(w => w.id);
  const facRows = await db.select().from(factoriesTable);
  const facById = new Map<number, FactoryRow>(facRows.map(f => [f.id, f]));

  const entries = await db.select({
    workerId: scheduleEntriesTable.workerId, factoryId: scheduleEntriesTable.factoryId,
    shift: scheduleEntriesTable.shift, hoursOverride: scheduleEntriesTable.hoursOverride,
  })
    .from(scheduleEntriesTable)
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(
      eq(scheduleWeeksTable.status, "approved"),
      eq(scheduleEntriesTable.status, "present"),
      inArray(scheduleEntriesTable.workerId, freshIds),
    ));

  const totalByWorker = new Map<number, number>();
  for (const e of entries) {
    const fac = facById.get(e.factoryId);
    const hours = e.hoursOverride ?? factoryShiftHours(fac, e.shift);
    totalByWorker.set(e.workerId, (totalByWorker.get(e.workerId) ?? 0) + hours);
  }

  const rows = freshWorkers
    .map(w => ({ ...w, total: totalByWorker.get(w.id) ?? 0 }))
    .filter(w => w.total > 0)
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "pl"))
    .map(w => [w.fullName, w.workerCode ?? "", Math.round(Math.max(0, w.total - HOURS_OFFSET) * 100) / 100]);

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: "A1:Z" });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: "A1", valueInputOption: "RAW",
    requestBody: { values: [["ПІБ", "Код", "Години"], ...rows] },
  });

  logger.info({ spreadsheetId, rows: rows.length }, "Recruiter hours sheet synced");
  return { spreadsheetId, rows: rows.length };
}

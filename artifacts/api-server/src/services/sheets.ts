import { google } from "googleapis";
import { db } from "@workspace/db";
import { availabilityTable, workersTable, type DayOfWeek, type Shift } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";

const DAYS: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES_UK: Record<DayOfWeek, string> = {
  mon: "Понеділок", tue: "Вівторок", wed: "Середа",
  thu: "Четвер", fri: "П'ятниця", sat: "Субота", sun: "Неділя",
};

export { DAY_NAMES_UK, DAYS };

export const SHIFT_LABELS: Record<Shift, string> = {
  "1": "1 зміна (6:00–14:00)",
  "2": "2 зміна (14:00–22:00)",
  "3": "3 зміна (22:00–6:00)",
};

function parseShiftValue(val: string): Shift | null {
  const v = (val || "").trim().toLowerCase();
  if (v.startsWith("1 shift") || v === "1") return "1";
  if (v.startsWith("2 shift") || v === "2") return "2";
  if (v.startsWith("3 shift") || v === "3") return "3";
  return null;
}

// Parse "28.07.2025 - 03.08.2025" → "2025-07-28" (Monday)
function parseWeekStart(dateStr: string): string | null {
  if (!dateStr) return null;
  const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

// Excel serial date → JS Date
function excelSerialToDate(serial: number): Date {
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  return new Date(utc_value * 1000);
}

function getGoogleAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const credentials = JSON.parse(json);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

export interface SheetRow {
  submittedAt: Date;
  weekStart: string;
  fullName: string;
  availability: Partial<Record<DayOfWeek, Shift | null>>;
}

export async function readAvailabilityFromSheets(weekStart?: string): Promise<SheetRow[]> {
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  if (!sheetsId) throw new Error("GOOGLE_SHEETS_ID not set");

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Try to detect sheet name
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetsId });
  const sheetName = meta.data.sheets?.[0]?.properties?.title ?? "Sheet1";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetsId,
    range: `${sheetName}!A1:M`,
  });

  const rows = res.data.values ?? [];
  if (rows.length < 2) return [];

  const headers = rows[0] as string[];
  // Find column indices by detecting keywords
  let tsCol = 0, dateCol = 1, nameCol = 3;
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] ?? "").toLowerCase();
    if (h.includes("час") || h.includes("time") || h.includes("метка")) tsCol = i;
    if (h.includes("дата") || h.includes("date") || h.includes("data")) dateCol = i;
    if (h.includes("surname name") || h.includes("прізвище") && h.includes("ім")) nameCol = i;
  }

  // Day columns: search for day keywords in headers
  const dayColMap: Partial<Record<DayOfWeek, number>> = {};
  const dayKeywords: Array<[DayOfWeek, string[]]> = [
    ["mon", ["monday", "понед", "poniedzialek", "пн"]],
    ["tue", ["tuesday", "вівторок", "wtorek", "вт"]],
    ["wed", ["wednesday", "середа", "sroda", "ср"]],
    ["thu", ["thursday", "четвер", "czwartek", "чт"]],
    ["fri", ["friday", "п'ятниця", "piatek", "пт"]],
    ["sat", ["saturday", "субота", "sobota", "сб"]],
    ["sun", ["sunday", "неділя", "niedziela", "нд"]],
  ];
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] ?? "").toLowerCase();
    for (const [day, keywords] of dayKeywords) {
      if (keywords.some(k => h.includes(k))) {
        dayColMap[day] = i;
        break;
      }
    }
  }

  // Fallback: if days not found by name, assume columns 6-12
  if (Object.keys(dayColMap).length === 0) {
    DAYS.forEach((d, i) => { dayColMap[d] = 6 + i; });
  }

  const result: SheetRow[] = [];
  for (const row of rows.slice(1)) {
    if (!row || row.length === 0) continue;

    const tsRaw = row[tsCol];
    const dateRaw = row[dateCol] as string;
    const nameRaw = (row[nameCol] as string ?? "").trim();
    if (!nameRaw) continue;

    // Parse timestamp
    let submittedAt: Date;
    if (typeof tsRaw === "number") {
      submittedAt = excelSerialToDate(tsRaw);
    } else {
      submittedAt = new Date(tsRaw as string);
      if (isNaN(submittedAt.getTime())) submittedAt = new Date();
    }

    const parsedWeek = parseWeekStart(dateRaw);
    if (!parsedWeek) continue;
    if (weekStart && parsedWeek !== weekStart) continue;

    const availability: Partial<Record<DayOfWeek, Shift | null>> = {};
    for (const [day, col] of Object.entries(dayColMap) as [DayOfWeek, number][]) {
      availability[day] = parseShiftValue(row[col] as string ?? "");
    }

    result.push({ submittedAt, weekStart: parsedWeek, fullName: nameRaw, availability });
  }

  return result;
}

// Get unique weeks that have responses
export async function getAvailableWeeks(): Promise<string[]> {
  const rows = await readAvailabilityFromSheets();
  const weeks = new Set(rows.map(r => r.weekStart));
  return [...weeks].sort();
}

// Sync latest availability from Sheets into DB for a given week
// Auto-adds workers who are not yet in the master list
export async function syncAvailabilityToDb(weekStart: string): Promise<{
  synced: number;
  autoAdded: string[];
}> {
  const rows = await readAvailabilityFromSheets(weekStart);

  // Keep only latest submission per person per week
  const latestByName = new Map<string, SheetRow>();
  for (const row of rows) {
    const key = normalizeFullName(row.fullName);
    const existing = latestByName.get(key);
    if (!existing || row.submittedAt > existing.submittedAt) {
      latestByName.set(key, row);
    }
  }

  // Get all workers for matching
  let allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));

  const autoAdded: string[] = [];
  let synced = 0;

  // Clear existing availability for this week
  await db.delete(availabilityTable).where(eq(availabilityTable.weekStart, weekStart));

  for (const [normalizedName, row] of latestByName) {
    // Try to match to master list
    let worker = allWorkers.find(w =>
      normalizeFullName(w.fullName) === normalizedName ||
      normalizedName.includes(normalizeFullName(w.fullName)) ||
      normalizeFullName(w.fullName).includes(normalizedName)
    );

    // Auto-add worker if not in master list
    if (!worker) {
      const [newWorker] = await db.insert(workersTable).values({
        fullName: row.fullName.trim(),
        isActive: true,
      }).returning();
      worker = newWorker;
      allWorkers = [...allWorkers, newWorker!];
      autoAdded.push(row.fullName.trim());
    }

    // Insert availability entries for each day+shift they're available
    for (const [day, shift] of Object.entries(row.availability) as [DayOfWeek, Shift | null][]) {
      if (!shift) continue;
      await db.insert(availabilityTable).values({
        fullNameRaw: row.fullName,
        weekStart,
        dayOfWeek: day,
        shift,
        submittedAt: row.submittedAt,
      });
      synced++;
    }
  }

  return { synced, autoAdded };
}

// Get workers from master list who have NOT submitted for this week
export async function getWorkersWhoHaventSubmitted(weekStart: string): Promise<Worker[]> {
  const rows = await readAvailabilityFromSheets(weekStart);
  const submittedNames = new Set(rows.map(r => normalizeFullName(r.fullName)));

  const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));

  return allWorkers.filter(w => !submittedNames.has(normalizeFullName(w.fullName)));
}

type Worker = typeof workersTable.$inferSelect;

export function normalizeFullName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

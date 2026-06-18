import { google } from "googleapis";
import { Readable } from "node:stream";
import { db } from "@workspace/db";
import {
  settingsTable, scheduleEntriesTable, workersTable, factoriesTable,
  driverTripsTable, driversTable, absenceRequestsTable, scheduleWeeksTable,
  positionsTable, factoryPositionsTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and, gte, lt, ne } from "drizzle-orm";
import { logger } from "../lib/logger";
import { factoryShifts } from "../bot/time";
import { DAYS } from "./sheets";
import { formatWeekStart } from "./scheduleGenerator";
import type { DayOfWeek as _DayOfWeek } from "@workspace/db";

// Polish localization for Excel files
const DAY_NAMES_PL: Record<string, string> = {
  mon: "Poniedziałek", tue: "Wtorek", wed: "Środa",
  thu: "Czwartek", fri: "Piątek", sat: "Sobota", sun: "Niedziela",
};
const DAY_SHORT_PL: Record<string, string> = {
  mon: "Pon", tue: "Wt", wed: "Śr", thu: "Czw", fri: "Pt", sat: "Sob", sun: "Nd",
};
const SHIFT_LABELS_PL: Record<string, string> = {
  "1": "Zmiana 1", "2": "Zmiana 2", "3": "Zmiana 3",
};
const monthLabelPL = (month: string) =>
  new Date(`${month}-01`).toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
const weekLabelPL = (weekStart: string) => {
  const d = new Date(weekStart + "T00:00:00");
  const end = new Date(d); end.setDate(d.getDate() + 6);
  const fmt = (date: Date) => date.toLocaleDateString("pl-PL", { day: "numeric", month: "numeric" });
  return `${fmt(d)} – ${fmt(end)}`;
};

// @ts-ignore – xlsx types are CJS
import XLSX from "xlsx";
import ExcelJS from "exceljs";

const SHIFT_FILL = ["FF2563EB", "FFEA580C", "FF7C3AED", "FF059669", "FFDB2777", "FF0891B2"];
const shiftFillFor = (n: number) => SHIFT_FILL[n - 1] ?? "FF6B7280";

// Shift times removed — factories may have different hours.
// Excel uses only "Zmiana 1/2/3" labels.

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getDriveAuth() {
  // Preferred: OAuth2 as the admin's own Google account.
  // Service accounts have NO Drive storage quota, so file uploads fail with
  // "Service Accounts do not have storage quota". Uploading as a real user
  // (the admin) stores files in their 15 GB Drive, owned by them.
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = process.env;
  if (GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REFRESH_TOKEN) {
    const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
    return oauth2;
  }

  // Fallback: service account (works for folder creation / read, but file
  // uploads will fail due to the quota limitation above).
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("No Google credentials set (need GOOGLE_OAUTH_* or GOOGLE_SERVICE_ACCOUNT_JSON)");
  const credentials = JSON.parse(json);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
}

// ─── Settings store ───────────────────────────────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  return rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settingsTable).values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

// ─── Folder helpers ───────────────────────────────────────────────────────────

export async function getOrCreateFolder(name: string, parentId?: string): Promise<string> {
  const auth = getDriveAuth();
  const drive = google.drive({ version: "v3", auth });

  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const res = await drive.files.list({ q, fields: "files(id,name)", spaces: "drive" });
  if (res.data.files?.length) return res.data.files[0]!.id!;

  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) },
    fields: "id",
  });
  const folderId = created.data.id!;
  await drive.permissions.create({ fileId: folderId, requestBody: { role: "reader", type: "anyone" } });
  return folderId;
}

export async function ensureFolderStructure() {
  const auth = getDriveAuth();
  const drive = google.drive({ version: "v3", auth });

  let rootId = await getSetting("drive_root_folder_id");
  if (!rootId) {
    rootId = await getOrCreateFolder("Графіки бот");
    await setSetting("drive_root_folder_id", rootId);

    // Share with admin's personal Google account so it appears in their Drive
    const adminEmail = process.env.ADMIN_GOOGLE_EMAIL;
    if (adminEmail) {
      try {
        await drive.permissions.create({
          fileId: rootId,
          requestBody: { role: "writer", type: "user", emailAddress: adminEmail },
          sendNotificationEmail: false,
        });
        logger.info({ adminEmail }, "Root folder shared with admin Google account");
      } catch (e) {
        logger.warn({ err: e }, "Could not share Drive folder with admin email");
      }
    }

    logger.info({ rootId }, "Created Drive root folder 'Графіки бот'");
  }

  const ensure = async (settingKey: string, folderName: string) => {
    let id = await getSetting(settingKey);
    if (!id) { id = await getOrCreateFolder(folderName, rootId!); await setSetting(settingKey, id); }
    return id;
  };

  const schedulesId = await ensure("drive_schedules_folder_id", "Графіки");
  const hoursId = await ensure("drive_hours_folder_id", "Облік годин");
  const tripsId = await ensure("drive_trips_folder_id", "Поїздки водіїв");
  const reportsId = await ensure("drive_reports_folder_id", "Рапорти");
  return { rootId, schedulesId, hoursId, tripsId, reportsId };
}

export async function getDriveFolderLink(): Promise<string | null> {
  const rootId = await getSetting("drive_root_folder_id");
  return rootId ? `https://drive.google.com/drive/folders/${rootId}` : null;
}

// ─── Upload helper ────────────────────────────────────────────────────────────

async function uploadOrUpdateFile(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
  fileName: string,
  buffer: Buffer,
  settingKey: string,
): Promise<string> {
  const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const existingId = await getSetting(settingKey);

  if (existingId) {
    try {
      await drive.files.update({ fileId: existingId, media: { mimeType, body: Readable.from(buffer) } });
      return existingId;
    } catch {
      await setSetting(settingKey, ""); // stale ID — fall through to create
    }
  }

  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType },
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id",
  });
  const fileId = created.data.id!;
  await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
  await setSetting(settingKey, fileId);
  return fileId;
}

// ─── Schedule Excel builder (reused by Drive export + direct download) ─────────

type SchedRow = { day: string; shift: string; workerName: string | null; workerCode: string | null; positionId?: number | null; positionName?: string | null; gender?: string | null };
type SegConfig = { usesPositions: boolean; usesGender: boolean; posOrder: { id: number; name: string }[] };

const genderTagPL = (g?: string | null) => g === "female" ? "K" : g === "male" ? "M" : "";
const genderRankPL = (g?: string | null) => g === "female" ? 0 : g === "male" ? 1 : 2;

// Order people in a shift into labelled groups: by position (factory order) then gender.
function groupShiftPeople(people: SchedRow[], seg: SegConfig): { label: string | null; people: SchedRow[] }[] {
  const byName = (a: SchedRow, b: SchedRow) => (a.workerName ?? "").localeCompare(b.workerName ?? "", "pl");
  if (seg.usesPositions) {
    const order = [...seg.posOrder, { id: -1, name: "Bez stanowiska" }];
    return order.map(pos => {
      const grp = people
        .filter(p => (p.positionId ?? -1) === pos.id)
        .sort((a, b) => (seg.usesGender ? genderRankPL(a.gender) - genderRankPL(b.gender) : 0) || byName(a, b));
      return { label: grp.length ? `${pos.name} — ${grp.length} os.` : null, people: grp };
    }).filter(g => g.people.length > 0);
  }
  if (seg.usesGender) {
    return [
      { g: "female", label: "Kobiety" }, { g: "male", label: "Mężczyźni" }, { g: null, label: "—" },
    ].map(({ g, label }) => {
      const grp = people.filter(p => (p.gender ?? null) === g).sort(byName);
      return { label: grp.length ? `${label} — ${grp.length} os.` : null, people: grp };
    }).filter(g => g.people.length > 0);
  }
  return [{ label: null, people: [...people].sort(byName) }];
}

function buildFactoryWorkbook(
  factoryName: string, factoryId: number, fEntries: SchedRow[], weekStart: string,
  allFactories: { id: number; shift1Start: string | null; shift2Start: string | null; shift3Start: string | null; shifts?: { start: string; end: string }[] | null; shiftCount?: number | null }[],
  seg: SegConfig = { usesPositions: false, usesGender: false, posOrder: [] },
): Promise<Buffer> {
  const weekPL = weekLabelPL(weekStart);
  const fac = allFactories.find(x => x.id === factoryId);
  const fShifts = factoryShifts(fac);
  const nShifts = Math.min(6, Math.max(1, fac?.shiftCount ?? (fShifts.length || 3)));
  const thin = (argb: string) => ({
    top: { style: "thin", color: { argb } }, left: { style: "thin", color: { argb } },
    bottom: { style: "thin", color: { argb } }, right: { style: "thin", color: { argb } },
  });
  // Extra "Płeć" (K/M) column only when the factory splits by gender.
  const cols = seg.usesGender ? 4 : 3;

  const wb = new ExcelJS.Workbook();
  for (const day of DAYS) {
    const dayEntries = fEntries.filter(e => e.day === day);
    if (dayEntries.length === 0) continue;
    const ws = wb.addWorksheet(DAY_NAMES_PL[day]!.slice(0, 31), { views: [{ showGridLines: false }] });
    ws.columns = seg.usesGender ? [{ width: 6 }, { width: 34 }, { width: 8 }, { width: 12 }] : [{ width: 6 }, { width: 36 }, { width: 14 }];
    let r = 1;
    ws.mergeCells(r, 1, r, cols);
    const title = ws.getCell(r, 1);
    title.value = `${DAY_NAMES_PL[day]!.toUpperCase()} · ${weekPL}`;
    title.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } } as any;
    title.alignment = { vertical: "middle", horizontal: "center" };
    ws.getRow(r).height = 30; r++;
    ws.mergeCells(r, 1, r, cols);
    const sub = ws.getCell(r, 1);
    sub.value = `🏭 ${factoryName}`;
    sub.font = { bold: true, size: 11, color: { argb: "FF374151" } };
    sub.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } } as any;
    sub.alignment = { vertical: "middle", horizontal: "center" };
    ws.getRow(r).height = 20; r += 2;
    for (const shift of (["1", "2", "3", "4", "5", "6"] as Shift[]).slice(0, nShifts)) {
      const people = dayEntries.filter(e => e.shift === shift);
      if (people.length === 0) continue;
      const st = fShifts[Number(shift) - 1];
      ws.mergeCells(r, 1, r, cols);
      const sh = ws.getCell(r, 1);
      sh.value = `ZMIANA ${shift}   ·   ${st ? `${st.start} – ${st.end}` : ""}   ·   ${people.length} os.`;
      sh.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
      sh.fill = { type: "pattern", pattern: "solid", fgColor: { argb: shiftFillFor(Number(shift)) } } as any;
      sh.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      ws.getRow(r).height = 24; r++;
      const hdr = ws.getRow(r);
      hdr.values = seg.usesGender ? ["Lp.", "Imię i nazwisko", "Płeć", "Kod"] : ["Lp.", "Imię i nazwisko", "Kod"];
      hdr.eachCell((c) => {
        c.font = { bold: true, color: { argb: "FF374151" } };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } } as any;
        c.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
        c.border = thin("FFD1D5DB") as any;
      });
      ws.getRow(r).height = 18; r++;
      let n = 1;
      for (const grp of groupShiftPeople(people, seg)) {
        // group sub-header (position and/or gender)
        if (grp.label) {
          ws.mergeCells(r, 1, r, cols);
          const gh = ws.getCell(r, 1);
          gh.value = `▸ ${grp.label}`;
          gh.font = { bold: true, italic: true, size: 10, color: { argb: "FF4B5563" } };
          gh.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } } as any;
          gh.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
          ws.getRow(r).height = 16; r++;
        }
        for (const p of grp.people) {
          const row = ws.getRow(r);
          row.values = seg.usesGender
            ? [n, p.workerName ?? "", genderTagPL(p.gender), p.workerCode ?? ""]
            : [n, p.workerName ?? "", p.workerCode ?? ""];
          const bg = n % 2 === 0 ? "FFF9FAFB" : "FFFFFFFF";
          row.eachCell((c, col) => {
            c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } } as any;
            c.border = thin("FFE5E7EB") as any;
            c.alignment = { vertical: "middle", horizontal: col === 2 ? "left" : "center", indent: col === 2 ? 1 : 0 };
          });
          n++; r++;
        }
      }
      r++;
    }
  }
  if (wb.worksheets.length === 0) {
    const ws = wb.addWorksheet("Grafik");
    ws.getCell(1, 1).value = `${factoryName} — ${weekPL}: brak wpisów`;
  }
  return wb.xlsx.writeBuffer().then(b => Buffer.from(b));
}

// Load a factory's segregation config (flags + ordered positions) for the Excel builder.
async function loadSegConfig(factoryId: number): Promise<SegConfig> {
  const f = (await db.select({ usesPositions: factoriesTable.usesPositions, usesGender: factoriesTable.usesGender }).from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
  if (!f) return { usesPositions: false, usesGender: false, posOrder: [] };
  const posOrder = f.usesPositions
    ? (await db.select({ id: factoryPositionsTable.positionId, name: positionsTable.name })
        .from(factoryPositionsTable)
        .leftJoin(positionsTable, eq(factoryPositionsTable.positionId, positionsTable.id))
        .where(eq(factoryPositionsTable.factoryId, factoryId))
        .orderBy(factoryPositionsTable.sortOrder, factoryPositionsTable.id))
        .map(p => ({ id: p.id, name: p.name ?? "?" }))
    : [];
  return { usesPositions: f.usesPositions, usesGender: f.usesGender, posOrder };
}

// Build a downloadable Excel for one factory's week. Returns buffer + filename.
export async function buildScheduleExcelBuffer(weekId: number, factoryId: number): Promise<{ buffer: Buffer; fileName: string; factoryName: string } | null> {
  const factory = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
  if (!factory) return null;
  const week = (await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.id, weekId)))[0];
  const weekStart = week?.weekStart ?? "";
  const entries = await db
    .select({ day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, workerName: workersTable.fullName, workerCode: workersTable.workerCode, positionId: workersTable.positionId, positionName: positionsTable.name, gender: workersTable.gender })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(positionsTable, eq(workersTable.positionId, positionsTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.factoryId, factoryId), ne(scheduleEntriesTable.status, "absent")));
  const allFactories = await db.select().from(factoriesTable);
  const seg = await loadSegConfig(factoryId);
  const buffer = await buildFactoryWorkbook(factory.name, factoryId, entries, weekStart, allFactories, seg);
  return { buffer, fileName: `Grafik ${factory.name} ${weekStart.replace(/-/g, ".")}.xlsx`, factoryName: factory.name };
}

// ─── Schedule Excel export (per factory subfolder) ───────────────────────────

export async function exportScheduleToDrive(weekId: number, weekStart: string, onlyFactoryId?: number): Promise<string | null> {
  try {
    const { schedulesId } = await ensureFolderStructure();
    const auth = getDriveAuth();
    const drive = google.drive({ version: "v3", auth });

    const entries = await db
      .select({
        day: scheduleEntriesTable.dayOfWeek,
        shift: scheduleEntriesTable.shift,
        workerName: workersTable.fullName,
        workerCode: workersTable.workerCode,
        positionId: workersTable.positionId,
        positionName: positionsTable.name,
        gender: workersTable.gender,
        factoryId: scheduleEntriesTable.factoryId,
        factoryName: factoriesTable.name,
        status: scheduleEntriesTable.status,
      })
      .from(scheduleEntriesTable)
      .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
      .leftJoin(positionsTable, eq(workersTable.positionId, positionsTable.id))
      .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
      .where(and(eq(scheduleEntriesTable.weekId, weekId), ne(scheduleEntriesTable.status, "absent")));

    // Group entries by factory
    const byFactory = new Map<string, { name: string; entries: typeof entries }>();
    for (const e of entries) {
      const key = String(e.factoryId);
      if (!byFactory.has(key)) byFactory.set(key, { name: e.factoryName ?? "Невідома", entries: [] });
      byFactory.get(key)!.entries.push(e);
    }

    const allFactories = await db.select().from(factoriesTable);
    const fileName = `Графік ${weekStart.replace(/-/g, ".")}.xlsx`;
    let firstFileId: string | null = null;

    // Create one Excel per factory, inside its subfolder. Tab = day.
    for (const [factoryIdStr, { name: factoryName, entries: fEntries }] of byFactory) {
      const factoryId = Number(factoryIdStr);
      if (onlyFactoryId != null && factoryId !== onlyFactoryId) continue;
      const factoryFolderId = await getOrCreateFolder(factoryName, schedulesId);
      const seg = await loadSegConfig(factoryId);
      const buffer = await buildFactoryWorkbook(factoryName, factoryId, fEntries, weekStart, allFactories, seg);
      const settingKey = `schedule_file_${weekId}_${factoryId}`;
      const fileId = await uploadOrUpdateFile(drive, factoryFolderId, fileName, buffer, settingKey);
      if (!firstFileId) firstFileId = fileId;
      logger.info({ fileId, weekStart, factoryName }, "Factory schedule exported to Drive");
    }

    if (firstFileId) {
      await db.update(scheduleWeeksTable).set({ driveFileId: firstFileId }).where(eq(scheduleWeeksTable.id, weekId));
    }

    // Return link to the Графіки folder (not a single file, since there are multiple)
    return `https://drive.google.com/drive/folders/${schedulesId}`;
  } catch (e) {
    logger.error({ err: e }, "Error exporting schedule to Drive");
    return null;
  }
}

// ─── Report photo upload (converted to PDF) ───────────────────────────────────

async function imageToPdf(imageBuffer: Buffer, mimeType: string): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.create();

  const image = mimeType === "image/png"
    ? await pdfDoc.embedPng(imageBuffer)
    : await pdfDoc.embedJpg(imageBuffer);

  // A4 portrait: 595 × 842 pts; scale image to fit with 20pt margin
  const margin = 20;
  const maxW = 595 - margin * 2;
  const maxH = 842 - margin * 2;
  const scale = Math.min(maxW / image.width, maxH / image.height, 1);
  const w = image.width * scale;
  const h = image.height * scale;

  const page = pdfDoc.addPage([595, 842]);
  page.drawImage(image, { x: (595 - w) / 2, y: (842 - h) / 2, width: w, height: h });

  return Buffer.from(await pdfDoc.save());
}

export async function uploadReportPhoto(
  factoryName: string,
  workerName: string,
  month: string,
  photoBuffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  try {
    const { reportsId } = await ensureFolderStructure();
    const auth = getDriveAuth();
    const drive = google.drive({ version: "v3", auth });

    const factoryFolderId = await getOrCreateFolder(factoryName, reportsId);
    const monthName = new Date(`${month}-01`).toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
    const monthFolderId = await getOrCreateFolder(monthName, factoryFolderId);

    const pdfBuffer = await imageToPdf(photoBuffer, mimeType);
    const fileName = `${workerName} — ${monthName}.pdf`;

    const created = await drive.files.create({
      requestBody: { name: fileName, parents: [monthFolderId], mimeType: "application/pdf" },
      media: { mimeType: "application/pdf", body: Readable.from(pdfBuffer) },
      fields: "id",
    });
    await drive.permissions.create({ fileId: created.data.id!, requestBody: { role: "reader", type: "anyone" } });
    return `https://drive.google.com/file/d/${created.data.id}/view`;
  } catch (e) {
    logger.error({ err: e }, "Error uploading report photo");
    return null;
  }
}

// ─── Hours tracking Excel (per factory subfolder, one file per year, tab per month) ──

export async function updateHoursTracking(month: string): Promise<string | null> {
  try {
    const { hoursId } = await ensureFolderStructure();
    const auth = getDriveAuth();
    const drive = google.drive({ version: "v3", auth });

    const [yearStr, monStr] = month.split("-");
    const year = parseInt(yearStr!);
    const mon = parseInt(monStr!);
    const monthStart = `${yearStr}-${monStr}-01`;
    const monthEnd = new Date(year, mon, 1).toISOString().split("T")[0]!;

    const entries = await db
      .select({
        workerId: scheduleEntriesTable.workerId,
        workerName: workersTable.fullName,
        workerCode: workersTable.workerCode,
        factoryId: scheduleEntriesTable.factoryId,
        factoryName: factoriesTable.name,
        weekStart: scheduleWeeksTable.weekStart,
        status: scheduleEntriesTable.status,
        absenceReason: scheduleEntriesTable.absenceReason,
        dayOfWeek: scheduleEntriesTable.dayOfWeek,
        shift: scheduleEntriesTable.shift,
      })
      .from(scheduleEntriesTable)
      .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
      .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
      .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
      .where(
        and(
          eq(scheduleWeeksTable.status, "approved"),
          gte(scheduleWeeksTable.weekStart, monthStart),
          lt(scheduleWeeksTable.weekStart, monthEnd),
        ),
      );

    // Group entries by factory
    const byFactory = new Map<string, { name: string; entries: typeof entries }>();
    for (const e of entries) {
      const key = String(e.factoryId);
      if (!byFactory.has(key)) byFactory.set(key, { name: e.factoryName ?? "Невідома", entries: [] });
      byFactory.get(key)!.entries.push(e);
    }

    const monthLabel = new Date(`${month}-01`).toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
    const fileName = `Ewidencja godzin ${year}.xlsx`;

    for (const [factoryId, { name: factoryName, entries: fEntries }] of byFactory) {
      const factoryFolderId = await getOrCreateFolder(factoryName, hoursId);

      // Aggregate worker stats for this factory this month
      type WorkerStat = {
        name: string; code: string;
        present: number; absent: number; cancelled: number;
        details: { day: string; shift: string; type: string; reason: string | null }[];
      };
      const workerStats = new Map<number, WorkerStat>();

      for (const e of fEntries) {
        if (!e.workerId) continue;
        if (!workerStats.has(e.workerId)) {
          workerStats.set(e.workerId, { name: e.workerName ?? "", code: e.workerCode ?? "", present: 0, absent: 0, cancelled: 0, details: [] });
        }
        const s = workerStats.get(e.workerId)!;
        if (e.status === "present") {
          s.present++;
        } else if (e.status === "absent") {
          if (e.absenceReason) {
            s.cancelled++;
            s.details.push({ day: DAY_NAMES_PL[e.dayOfWeek], shift: SHIFT_LABELS_PL[e.shift] ?? e.shift, type: "Odwołano", reason: e.absenceReason });
          } else {
            s.absent++;
            s.details.push({ day: DAY_NAMES_PL[e.dayOfWeek], shift: SHIFT_LABELS_PL[e.shift] ?? e.shift, type: "Nieobecny", reason: null });
          }
        }
      }

      const workers = [...workerStats.values()].sort((a, b) => a.name.localeCompare(b.name, "pl"));

      const reliabilityLabel = (present: number, absent: number, cancelled: number) => {
        const total = present + absent + cancelled;
        if (total === 0) return "—";
        const pct = Math.round((present / total) * 100);
        if (pct >= 95) return `✅ ${pct}%`;
        if (pct >= 85) return `🟡 ${pct}%`;
        if (pct >= 70) return `🟠 ${pct}%`;
        return `🔴 ${pct}%`;
      };

      const sheetData: (string | number)[][] = [
        [`${factoryName} — Ewidencja godzin — ${monthLabel}`], [],
        ["PRZEPRACOWANY CZAS"],
        ["Nr", "Imię i nazwisko", "Kod", "Zmiany", "Godziny (×8)", "Nieobecności", "Odwołano", "Frekwencja %", "Niezawodność"],
        ...workers.map((w, i) => {
          const total = w.present + w.absent + w.cancelled;
          const pct = total > 0 ? Math.round((w.present / total) * 100) : 100;
          return [i + 1, w.name, w.code, w.present, w.present * 8, w.absent, w.cancelled, `${pct}%`, reliabilityLabel(w.present, w.absent, w.cancelled)];
        }),
        [],
        ["SZCZEGÓŁY NIEOBECNOŚCI"],
        ["Nr", "Imię i nazwisko", "Dzień", "Zmiana", "Typ", "Powód"],
      ];
      let n = 1;
      for (const w of workers) {
        for (const d of w.details) sheetData.push([n++, w.name, d.day, d.shift, d.type, d.reason ?? "—"]);
      }
      if (n === 1) sheetData.push(["—", "Відсутностей немає"]);

      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws["!cols"] = [{ wch: 4 }, { wch: 30 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 30 }];

      const settingKey = `hours_file_${year}_${factoryId}`;
      const existingFileId = await getSetting(settingKey);
      let wb = XLSX.utils.book_new();
      if (existingFileId) {
        try {
          const resp = await drive.files.get({ fileId: existingFileId, alt: "media" }, { responseType: "arraybuffer" });
          wb = XLSX.read(Buffer.from(resp.data as ArrayBuffer), { type: "buffer" });
        } catch { /* stale — start fresh */ }
      }

      if (wb.SheetNames.includes(monthLabel)) {
        delete wb.Sheets[monthLabel];
        wb.SheetNames = wb.SheetNames.filter(s => s !== monthLabel);
      }
      XLSX.utils.book_append_sheet(wb, ws, monthLabel);

      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      const fileId = await uploadOrUpdateFile(drive, factoryFolderId, fileName, buffer, settingKey);
      logger.info({ fileId, month, factoryName }, "Hours tracking updated");
    }

    return `https://drive.google.com/drive/folders/${hoursId}`;
  } catch (e) {
    logger.error({ err: e }, "Error updating hours tracking");
    return null;
  }
}

// ─── Driver trips Excel (one file per year, tab per month) ────────────────────

export async function updateDriverTripsExcel(month: string): Promise<string | null> {
  try {
    const { tripsId } = await ensureFolderStructure();
    const auth = getDriveAuth();
    const drive = google.drive({ version: "v3", auth });

    const [yearStr, monStr] = month.split("-");
    const year = parseInt(yearStr!);
    const mon = parseInt(monStr!);
    const monthStart = `${yearStr}-${monStr}-01`;
    const monthEnd = new Date(year, mon, 1).toISOString().split("T")[0]!;

    // Fetch all trips for this month
    const trips = await db
      .select({
        driverId: driverTripsTable.driverId,
        driverName: driversTable.name,
        driverVehicle: driversTable.vehicle,
        factoryName: factoriesTable.name,
        shift: driverTripsTable.shift,
        lateToPickup: driverTripsTable.lateToPickup,
        lateToFactory: driverTripsTable.lateToFactory,
        tripDate: driverTripsTable.tripDate,
        pickupStartedAt: driverTripsTable.pickupStartedAt,
        arrivedFactoryAt: driverTripsTable.arrivedFactoryAt,
      })
      .from(driverTripsTable)
      .leftJoin(driversTable, eq(driverTripsTable.driverId, driversTable.id))
      .leftJoin(factoriesTable, eq(driverTripsTable.factoryId, factoriesTable.id))
      .where(and(gte(driverTripsTable.tripDate, monthStart), lt(driverTripsTable.tripDate, monthEnd)));

    // Get all unique factory names
    const allFactories = [...new Set(trips.map(t => t.factoryName).filter(Boolean))] as string[];

    // Group by driver
    const driverStats = new Map<number, {
      name: string; vehicle: string | null;
      total: number; latePickup: number; lateFactory: number;
      byFactory: Record<string, number>;
    }>();

    for (const t of trips) {
      if (!t.driverId) continue;
      if (!driverStats.has(t.driverId)) {
        driverStats.set(t.driverId, { name: t.driverName ?? "", vehicle: t.driverVehicle ?? null, total: 0, latePickup: 0, lateFactory: 0, byFactory: {} });
      }
      const s = driverStats.get(t.driverId)!;
      s.total++;
      if (t.lateToPickup) s.latePickup++;
      if (t.lateToFactory) s.lateFactory++;
      if (t.factoryName) s.byFactory[t.factoryName] = (s.byFactory[t.factoryName] ?? 0) + 1;
    }

    const monthLabel = new Date(`${month}-01`).toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
    const drivers = [...driverStats.values()].sort((a, b) => a.name.localeCompare(b.name, "pl"));

    const header = ["Nr", "Kierowca", "Auto", "Łącznie przejazdów", ...allFactories, "Spóźn. na zbiór", "Spóźn. do fabryki"];
    const sheetData: (string | number)[][] = [
      [`Przejazdy kierowców — ${monthLabel}`], [],
      header,
      ...drivers.map((d, i) => [
        i + 1, d.name, d.vehicle ?? "—", d.total,
        ...allFactories.map(f => d.byFactory[f] ?? 0),
        d.latePickup, d.lateFactory,
      ]),
    ];

    if (drivers.length === 0) {
      sheetData.push(["—", "Поїздок не зафіксовано", "", 0]);
    }

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    ws["!cols"] = [{ wch: 4 }, { wch: 25 }, { wch: 12 }, { wch: 16 }, ...allFactories.map(() => ({ wch: 16 })), { wch: 16 }, { wch: 18 }];

    // Load or create annual workbook
    const fileName = `Przejazdy kierowców ${year}.xlsx`;
    const settingKey = `trips_file_${year}`;
    const existingFileId = await getSetting(settingKey);

    let wb = XLSX.utils.book_new();
    if (existingFileId) {
      try {
        const resp = await drive.files.get({ fileId: existingFileId, alt: "media" }, { responseType: "arraybuffer" });
        wb = XLSX.read(Buffer.from(resp.data as ArrayBuffer), { type: "buffer" });
      } catch { /* stale file — start fresh */ }
    }

    if (wb.SheetNames.includes(monthLabel)) {
      delete wb.Sheets[monthLabel];
      wb.SheetNames = wb.SheetNames.filter(n => n !== monthLabel);
    }
    XLSX.utils.book_append_sheet(wb, ws, monthLabel);

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const fileId = await uploadOrUpdateFile(drive, tripsId, fileName, buffer, settingKey);
    logger.info({ fileId, month }, "Driver trips Excel updated");
    return `https://drive.google.com/file/d/${fileId}/view`;
  } catch (e) {
    logger.error({ err: e }, "Error updating driver trips Excel");
    return null;
  }
}

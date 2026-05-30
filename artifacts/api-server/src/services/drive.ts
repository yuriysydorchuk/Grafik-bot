import { google } from "googleapis";
import { db } from "@workspace/db";
import {
  settingsTable, scheduleEntriesTable, workersTable, factoriesTable, driverTripsTable, driversTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { DAYS, DAY_NAMES_UK, SHIFT_LABELS } from "./sheets";
import { formatWeekStart } from "./scheduleGenerator";

// @ts-ignore – xlsx types are CJS
import XLSX from "xlsx";

const SHIFT_TIMES: Record<Shift, string> = {
  "1": "06:00–14:00",
  "2": "14:00–22:00",
  "3": "22:00–06:00",
};

function getDriveAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const credentials = JSON.parse(json);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
}

async function getSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  return rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settingsTable).values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

export async function getOrCreateFolder(name: string, parentId?: string): Promise<string> {
  const auth = getDriveAuth();
  const drive = google.drive({ version: "v3", auth });

  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const res = await drive.files.list({ q, fields: "files(id,name)", spaces: "drive" });
  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0]!.id!;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: "id",
  });

  const folderId = created.data.id!;
  // Make folder readable with link
  await drive.permissions.create({
    fileId: folderId,
    requestBody: { role: "reader", type: "anyone" },
  });

  return folderId;
}

export async function ensureFolderStructure(): Promise<{
  rootId: string; schedulesId: string; hoursId: string; reportsId: string;
}> {
  let rootId = await getSetting("drive_root_folder_id");
  if (!rootId) {
    rootId = await getOrCreateFolder("Agram Bot");
    await setSetting("drive_root_folder_id", rootId);
    logger.info({ rootId }, "Created Drive root folder");
  }

  let schedulesId = await getSetting("drive_schedules_folder_id");
  if (!schedulesId) {
    schedulesId = await getOrCreateFolder("Графіки", rootId);
    await setSetting("drive_schedules_folder_id", schedulesId);
  }

  let hoursId = await getSetting("drive_hours_folder_id");
  if (!hoursId) {
    hoursId = await getOrCreateFolder("Облік годин", rootId);
    await setSetting("drive_hours_folder_id", hoursId);
  }

  let reportsId = await getSetting("drive_reports_folder_id");
  if (!reportsId) {
    reportsId = await getOrCreateFolder("Рапорти", rootId);
    await setSetting("drive_reports_folder_id", reportsId);
  }

  return { rootId, schedulesId, hoursId, reportsId };
}

export async function getDriveFolderLink(): Promise<string | null> {
  const rootId = await getSetting("drive_root_folder_id");
  return rootId ? `https://drive.google.com/drive/folders/${rootId}` : null;
}

// Export approved schedule to Excel and upload to Drive
export async function exportScheduleToDrive(weekId: number, weekStart: string): Promise<string | null> {
  try {
    const { schedulesId } = await ensureFolderStructure();

    const entries = await db
      .select({
        day: scheduleEntriesTable.dayOfWeek,
        shift: scheduleEntriesTable.shift,
        workerName: workersTable.fullName,
        workerCode: workersTable.workerCode,
        factoryName: factoriesTable.name,
        status: scheduleEntriesTable.status,
      })
      .from(scheduleEntriesTable)
      .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
      .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
      .where(eq(scheduleEntriesTable.weekId, weekId));

    const wb = XLSX.utils.book_new();

    // One sheet per day+shift combination that has workers
    const combinations = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = `${entry.day}-${entry.shift}`;
      if (!combinations.has(key)) combinations.set(key, []);
      combinations.get(key)!.push(entry);
    }

    // Summary sheet
    const summaryData: string[][] = [
      ["Графік на тиждень " + formatWeekStart(weekStart)],
      [],
      ["ПІБ Працівника", "Код", ...DAYS.flatMap(d => [`${d.toUpperCase()} зм1`, `${d.toUpperCase()} зм2`, `${d.toUpperCase()} зм3`])],
    ];

    // Get unique workers
    const allWorkers = new Map<string, { name: string; code: string; days: Record<string, string> }>();
    for (const e of entries) {
      const key = e.workerName ?? "";
      if (!allWorkers.has(key)) allWorkers.set(key, { name: e.workerName ?? "", code: e.workerCode ?? "", days: {} });
      allWorkers.get(key)!.days[`${e.day}-${e.shift}`] = e.factoryName ?? "";
    }

    for (const [, w] of allWorkers) {
      const row: string[] = [w.name, w.code];
      for (const day of DAYS) {
        for (const shift of ["1", "2", "3"] as Shift[]) {
          row.push(w.days[`${day}-${shift}`] ?? "");
        }
      }
      summaryData.push(row);
    }

    const summaryWs = XLSX.utils.aoa_to_sheet(summaryData);
    // Set column widths
    summaryWs["!cols"] = [{ wch: 30 }, { wch: 8 }, ...DAYS.flatMap(() => [{ wch: 14 }, { wch: 14 }, { wch: 14 }])];
    XLSX.utils.book_append_sheet(wb, summaryWs, "Загальний");

    // Per-day sheets
    for (const day of DAYS) {
      const dayEntries = entries.filter(e => e.day === day);
      if (dayEntries.length === 0) continue;

      const sheetData: (string | number)[][] = [
        [`${DAY_NAMES_UK[day]} — ${formatWeekStart(weekStart)}`],
        [],
        ["№", "ПІБ", "Код", "Зміна", "Час", "Фабрика"],
      ];

      let num = 1;
      for (const shift of ["1", "2", "3"] as Shift[]) {
        const shiftEntries = dayEntries.filter(e => e.shift === shift);
        for (const e of shiftEntries) {
          sheetData.push([num++, e.workerName ?? "", e.workerCode ?? "", `${shift} зміна`, SHIFT_TIMES[shift], e.factoryName ?? ""]);
        }
      }

      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws["!cols"] = [{ wch: 4 }, { wch: 30 }, { wch: 8 }, { wch: 10 }, { wch: 14 }, { wch: 20 }];
      XLSX.utils.book_append_sheet(wb, ws, DAY_NAMES_UK[day]!);
    }

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    // Upload to Drive
    const auth = getDriveAuth();
    const drive = google.drive({ version: "v3", auth });
    const fileName = `Графік ${weekStart.replace(/-/g, ".")}.xlsx`;

    // Check if file already exists (for update)
    const existing = await db.select({ driveFileId: (await import("@workspace/db")).scheduleWeeksTable.driveFileId })
      .from((await import("@workspace/db")).scheduleWeeksTable)
      .where(eq((await import("@workspace/db")).scheduleWeeksTable.id, weekId));

    const existingFileId = existing[0]?.driveFileId;

    let fileId: string;
    if (existingFileId) {
      // Update existing file
      const updated = await drive.files.update({
        fileId: existingFileId,
        media: {
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          body: buffer,
        },
        fields: "id",
      });
      fileId = updated.data.id!;
    } else {
      // Create new file
      const created = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [schedulesId],
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        media: {
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          body: buffer,
        },
        fields: "id",
      });
      fileId = created.data.id!;

      // Make readable
      await drive.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" },
      });
    }

    // Save Drive file ID to DB
    await db.update((await import("@workspace/db")).scheduleWeeksTable)
      .set({ driveFileId: fileId })
      .where(eq((await import("@workspace/db")).scheduleWeeksTable.id, weekId));

    logger.info({ fileId, weekStart }, "Schedule exported to Drive");
    return `https://drive.google.com/file/d/${fileId}/view`;
  } catch (e) {
    logger.error({ err: e }, "Error exporting schedule to Drive");
    return null;
  }
}

// Upload a photo (from Telegram) as PDF report to Drive
export async function uploadReportPhoto(
  factoryName: string,
  workerName: string,
  month: string, // "2025-06"
  photoBuffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  try {
    const { reportsId } = await ensureFolderStructure();
    const auth = getDriveAuth();
    const drive = google.drive({ version: "v3", auth });

    const factoryFolderId = await getOrCreateFolder(factoryName, reportsId);
    const [year, mon] = month.split("-");
    const monthName = new Date(`${month}-01`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
    const monthFolderId = await getOrCreateFolder(monthName, factoryFolderId);

    const fileName = `${workerName} — ${monthName}.${mimeType === "image/jpeg" ? "jpg" : "png"}`;

    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [monthFolderId],
        mimeType,
      },
      media: { mimeType, body: photoBuffer },
      fields: "id",
    });

    await drive.permissions.create({
      fileId: created.data.id!,
      requestBody: { role: "reader", type: "anyone" },
    });

    return `https://drive.google.com/file/d/${created.data.id}/view`;
  } catch (e) {
    logger.error({ err: e }, "Error uploading report photo");
    return null;
  }
}

// Generate and upload hours tracking Excel
export async function updateHoursTracking(month: string): Promise<string | null> {
  try {
    const { hoursId } = await ensureFolderStructure();

    // Get all confirmed (present) entries for this month
    const [year, mon] = month.split("-").map(Number);
    const monthStart = `${year}-${String(mon).padStart(2, "0")}-01`;
    const monthEnd = new Date(year!, mon!, 1).toISOString().split("T")[0]!;

    const entries = await db
      .select({
        workerName: workersTable.fullName,
        workerCode: workersTable.workerCode,
        weekStart: (await import("@workspace/db")).scheduleWeeksTable.weekStart,
        status: scheduleEntriesTable.status,
        absenceReason: scheduleEntriesTable.absenceReason,
      })
      .from(scheduleEntriesTable)
      .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
      .leftJoin((await import("@workspace/db")).scheduleWeeksTable, eq(scheduleEntriesTable.weekId, (await import("@workspace/db")).scheduleWeeksTable.id))
      .where(eq((await import("@workspace/db")).scheduleWeeksTable.status, "approved"));

    // Filter by month
    const monthEntries = entries.filter(e => {
      if (!e.weekStart) return false;
      return e.weekStart >= monthStart && e.weekStart < monthEnd;
    });

    // Group by worker
    const workerStats = new Map<string, { name: string; code: string; present: number; absent: number; cancelled: number }>();
    for (const e of monthEntries) {
      const key = e.workerName ?? "";
      if (!workerStats.has(key)) {
        workerStats.set(key, { name: e.workerName ?? "", code: e.workerCode ?? "", present: 0, absent: 0, cancelled: 0 });
      }
      const stats = workerStats.get(key)!;
      if (e.status === "present") stats.present++;
      else if (e.status === "absent") stats.absent++;
    }

    const wb = XLSX.utils.book_new();
    const monthLabel = new Date(`${month}-01`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });

    const sheetData: (string | number)[][] = [
      [`Облік годин — ${monthLabel}`],
      [],
      ["№", "ПІБ", "Код", "Відпрацьовано змін", "Годин (×8)", "Пропущено змін", "Відмінено змін"],
      ...([...workerStats.values()].map((s, i) => [
        i + 1, s.name, s.code, s.present, s.present * 8, s.absent, s.cancelled,
      ])),
    ];

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    ws["!cols"] = [{ wch: 4 }, { wch: 30 }, { wch: 8 }, { wch: 18 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws, monthLabel);

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const auth = getDriveAuth();
    const drive = google.drive({ version: "v3", auth });
    const fileName = `Облік годин — ${monthLabel}.xlsx`;

    const existing = await getSetting(`hours_file_${month}`);
    let fileId: string;

    if (existing) {
      try {
        await drive.files.update({
          fileId: existing,
          media: {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            body: buffer,
          },
        });
        fileId = existing;
      } catch {
        existing && await setSetting(`hours_file_${month}`, "");
        const created = await drive.files.create({
          requestBody: { name: fileName, parents: [hoursId] },
          media: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: buffer },
          fields: "id",
        });
        fileId = created.data.id!;
        await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
        await setSetting(`hours_file_${month}`, fileId);
      }
    } else {
      const created = await drive.files.create({
        requestBody: { name: fileName, parents: [hoursId] },
        media: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: buffer },
        fields: "id",
      });
      fileId = created.data.id!;
      await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
      await setSetting(`hours_file_${month}`, fileId);
    }

    return `https://drive.google.com/file/d/${fileId}/view`;
  } catch (e) {
    logger.error({ err: e }, "Error updating hours tracking");
    return null;
  }
}

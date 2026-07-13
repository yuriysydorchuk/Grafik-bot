// Читання книг сводних із Google для svodniSync: gsheet — напряму батчем,
// xlsx (Лодзь) — через тимчасову конвертацію у Google Sheet OAuth-акаунтом
// (та сама механіка, що в syncPayrollSummaries: формули в Office-файлах не
// мають кешованих значень для API, конвертація їх обчислює).
import { Readable } from "node:stream";
import { google } from "googleapis";
import type { payrollSourcesTable } from "@workspace/db";
import { getDriveAuth } from "./drive";

type Src = typeof payrollSourcesTable.$inferSelect;

function saAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(json),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly", "https://www.googleapis.com/auth/drive.readonly"],
  });
}

async function readAllTabs(api: ReturnType<typeof google.sheets>, spreadsheetId: string): Promise<Map<string, unknown[][]>> {
  const meta = await api.spreadsheets.get({ spreadsheetId });
  const tabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? "").filter(Boolean);
  const res = await api.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tabs.map(t => `'${t}'!A1:AG400`),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const grids = new Map<string, unknown[][]>();
  (res.data.valueRanges ?? []).forEach((vr, i) => grids.set(tabs[i]!, (vr.values ?? []) as unknown[][]));
  return grids;
}

export async function readSourceGrids(src: Src): Promise<Map<string, unknown[][]>> {
  const auth = saAuth();
  const api = google.sheets({ version: "v4", auth });
  if (src.kind !== "xlsx") return readAllTabs(api, src.spreadsheetId);

  // xlsx → тимчасовий Google Sheet від OAuth-користувача (see payrollSummaries)
  const saDrive = google.drive({ version: "v3", auth });
  const userAuth = getDriveAuth();
  const userDrive = google.drive({ version: "v3", auth: userAuth as any });
  const userSheets = google.sheets({ version: "v4", auth: userAuth as any });
  let tempId: string | null = null;
  try {
    const dl = await saDrive.files.get(
      { fileId: src.spreadsheetId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    const up = await userDrive.files.create({
      requestBody: { name: `tmp svodni import ${src.id}`, mimeType: "application/vnd.google-apps.spreadsheet" },
      media: {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Readable.from(Buffer.from(dl.data as ArrayBuffer)),
      },
    });
    tempId = up.data.id ?? null;
    if (!tempId) throw new Error("xlsx → gsheet conversion failed");
    return await readAllTabs(userSheets, tempId);
  } finally {
    if (tempId) await userDrive.files.delete({ fileId: tempId, supportsAllDrives: true }).catch(() => {});
  }
}

export async function readGotowkaGrids(src: Src): Promise<Map<string, unknown[][]>> {
  const api = google.sheets({ version: "v4", auth: saAuth() });
  return readAllTabs(api, src.spreadsheetId);
}

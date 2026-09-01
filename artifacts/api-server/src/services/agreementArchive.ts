// Архів сканів умов на Google Drive: Umowy → <фірма> → файл (один скан на
// умову — на відміну від фактур тут нема помісячного розбиття). Патерн — той
// самий, що invoiceArchive.ts (branchRootId/invoiceFolderId), лише спрощений.
import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { google } from "googleapis";
import { db, agreementConditionsTable, companiesTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { UPLOADS_ROOT, AGREEMENTS_DIR, sniffDocMime } from "../lib/uploads";
import { getDriveAuth, getOrCreateFolder, ensureFolderStructure } from "./drive";
import { imageToPdf } from "./imagePdf";

const ROOT_FOLDER = "Umowy";

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  return row?.value ?? null;
}
async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settingsTable).values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|']/g, "_").replace(/\s+/g, " ").trim() || "umowa";

const folderMemo = new Map<string, string>();

async function agreementFolderId(firm: string): Promise<string> {
  const key = `firm|${firm}`;
  if (folderMemo.has(key)) return folderMemo.get(key)!;
  let rootId = await getSetting("drive_agreements_folder_id");
  if (!rootId) {
    let driveRootId = await getSetting("drive_root_folder_id");
    if (!driveRootId) driveRootId = (await ensureFolderStructure()).rootId;
    rootId = await getOrCreateFolder(ROOT_FOLDER, driveRootId!);
    await setSetting("drive_agreements_folder_id", rootId);
  }
  const firmId = await getOrCreateFolder(firm, rootId);
  folderMemo.set(key, firmId);
  return firmId;
}

async function uploadFile(folderId: string, name: string, mimeType: string, buffer: Buffer, existingId: string | null): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getDriveAuth() });
  if (existingId) {
    try {
      await drive.files.update({ fileId: existingId, requestBody: { name }, media: { mimeType, body: Readable.from(buffer) } });
      return existingId;
    } catch { /* stale id — падаємо на create */ }
  }
  const created = await drive.files.create({
    requestBody: { name, parents: [folderId], mimeType },
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id",
  });
  const fileId = created.data.id!;
  await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } }).catch(() => {});
  return fileId;
}

export async function retireAgreementDriveFile(fileId: string | null | undefined): Promise<void> {
  if (!fileId) return;
  try {
    const drive = google.drive({ version: "v3", auth: getDriveAuth() });
    await drive.files.update({ fileId, requestBody: { trashed: true } });
  } catch (e) {
    logger.warn({ fileId, err: String(e) }, "agreement drive file retire failed");
  }
}

// Заливає локально збережений скан умови (agreement_conditions.file_path) на Drive.
export async function archiveAgreementToDrive(id: number): Promise<void> {
  const [row] = await db.select().from(agreementConditionsTable).where(eq(agreementConditionsTable.id, id));
  if (!row) return;
  const setRow = (patch: Record<string, unknown>) => db.update(agreementConditionsTable).set(patch).where(eq(agreementConditionsTable.id, id));
  const fail = async (why: string) => setRow({ driveError: why });
  try {
    if (!row.filePath) return; // без файла нема чого архівувати
    const abs = path.resolve(UPLOADS_ROOT, row.filePath);
    if (!abs.startsWith(UPLOADS_ROOT) || !fs.existsSync(abs)) { await fail("файл не знайдено на сервері"); return; }
    const raw = fs.readFileSync(abs);
    const mime = sniffDocMime(raw) ?? "application/octet-stream";
    let buffer: Buffer = raw;
    let ext = ".pdf";
    let uploadMime = "application/pdf";
    if (mime === "image/jpeg" || mime === "image/png") {
      buffer = await imageToPdf(raw, mime);
    } else if (!mime.includes("pdf")) {
      ext = path.extname(abs) || "";
      uploadMime = mime;
    }
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, row.companyId));
    const firm = company?.name ?? "Inne";
    const folderId = await agreementFolderId(firm);
    const fileId = await uploadFile(folderId, `${safeName(row.title)}${ext}`, uploadMime, buffer, row.driveFileId);
    await setRow({ driveFileId: fileId, driveError: null });
  } catch (e: any) {
    await fail(`Drive: ${String(e?.message ?? e).slice(0, 160)}`);
  }
}

// Фонове довантаження після завантаження скана — fire-and-forget, помилка лишиться в drive_error.
export function archiveAgreementLater(id: number): void {
  setImmediate(() => {
    archiveAgreementToDrive(id).catch(e => logger.warn({ id, err: String(e) }, "background agreement archive failed"));
  });
}

export { AGREEMENTS_DIR };

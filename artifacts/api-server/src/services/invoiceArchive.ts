// Архів фактур на Google Drive (рішення власника 12.08.2026):
//   Faktury kosztowe / Faktury sprzedażowe → <рік> → M<міс>.<рр> → <фірма> → файл.
// KSeF-фактури зберігаються у СТАНДАРТНОМУ форматі (XML з KSeF, без конвертації в
// PDF), назва файла = номер фактури. Ручні/скани з /cost-invoices — PDF (фото
// загортається в PDF через imagePdf). Рядок, який не вдалося заархівувати, несе
// drive_error з причиною — веб світить його червоним. Принагідно з XML читаються
// термін оплати (due_date, лише якщо ще порожній) і FormaPlatnosci → payment_method_xml.
import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { google } from "googleapis";
import { db, invoicesTable, ksefInvoicesTable, companiesTable, settingsTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { UPLOADS_ROOT, sniffDocMime } from "../lib/uploads";
import { getDriveAuth, getOrCreateFolder, ensureFolderStructure } from "./drive";
import { ksefAccessFor, downloadKsefInvoiceXml, parseKsefXmlMeta } from "./ksef";
import { buildKsefInvoicePdf } from "./ksefPdf";
import { imageToPdf } from "./imagePdf";

const KSEF_XML_DIR = path.join(UPLOADS_ROOT, "ksef-xml");

const COST_BRANCH = "Faktury kosztowe";
const SALES_BRANCH = "Faktury sprzedażowe";

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  return row?.value ?? null;
}
async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settingsTable).values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

// імʼя файла = номер фактури; прибираємо лише небезпечні для пошуку/скачування символи
const safeName = (num: string) => num.replace(/[\\/:*?"<>|']/g, "_").replace(/\s+/g, " ").trim() || "faktura";

// Імʼя файла в архіві (вимога власника 26.08.2026): «<номер> <контрагент>».
// Контрагент = друга сторона фактури: для закупівель/сканів — постачальник,
// для продажів — покупець. Довгі юрназви обрізаються, щоб імʼя лишалось читабельним.
export function archiveFileName(number: string, counterparty: string | null | undefined): string {
  const co = (counterparty ?? "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return safeName(co ? `${number} ${co}` : number);
}

// "2026-08-03" → { year: "2026", month: "M8.26" } (формат вимоги: M1.26, M2.26, …)
export function driveMonthFolder(dateStr: string): { year: string; month: string } {
  const [y, m] = dateStr.split("-");
  return { year: y!, month: `M${Number(m)}.${y!.slice(2)}` };
}

// ── Кеш папок (у межах процесу) ────────────────────────────────────────────────
const folderMemo = new Map<string, string>();

async function branchRootId(branch: string): Promise<string> {
  const settingKey = branch === COST_BRANCH ? "drive_faktury_cost_folder_id" : "drive_faktury_sales_folder_id";
  const memoKey = `root|${branch}`;
  if (folderMemo.has(memoKey)) return folderMemo.get(memoKey)!;
  let id = await getSetting(settingKey);
  if (!id) {
    let rootId = await getSetting("drive_root_folder_id");
    if (!rootId) rootId = (await ensureFolderStructure()).rootId;
    id = await getOrCreateFolder(branch, rootId!);
    await setSetting(settingKey, id);
  }
  folderMemo.set(memoKey, id);
  return id;
}

// proforma — окрема підпапка «Proformy» всередині папки фірми місяця (лише
// ручні/скан-рядки costInvoices, KSeF проформ не має — це нефіскальний документ)
async function invoiceFolderId(branch: string, issueDate: string, firm: string, proforma = false): Promise<string> {
  const { year, month } = driveMonthFolder(issueDate);
  const key = `${branch}|${year}|${month}|${firm}|${proforma ? "proforma" : "main"}`;
  if (folderMemo.has(key)) return folderMemo.get(key)!;
  const rootId = await branchRootId(branch);
  const yearId = await getOrCreateFolder(year, rootId);
  const monthId = await getOrCreateFolder(month, yearId);
  const firmId = await getOrCreateFolder(firm, monthId);
  const finalId = proforma ? await getOrCreateFolder("Proformy", firmId) : firmId;
  folderMemo.set(key, finalId);
  return finalId;
}

async function uploadFile(folderId: string, name: string, mimeType: string, buffer: Buffer, existingId: string | null): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getDriveAuth() });
  if (existingId) {
    try {
      // разом із вмістом оновлюємо й імʼя — force-перезалив підтягує нову схему назв
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

// Перейменувати файл на Drive (без перезаливу вмісту) — апгрейд схеми назв
async function renameDriveFile(fileId: string, name: string): Promise<boolean> {
  try {
    const drive = google.drive({ version: "v3", auth: getDriveAuth() });
    await drive.files.update({ fileId, requestBody: { name } });
    return true;
  } catch (e) {
    logger.warn({ fileId, name, err: String(e) }, "drive file rename failed");
    return false;
  }
}

// Прибрати файл з Drive (у кошик) — коли фактуру видалили/переназвали/замінили файл
export async function retireDriveFile(fileId: string | null | undefined): Promise<void> {
  if (!fileId) return;
  try {
    const drive = google.drive({ version: "v3", auth: getDriveAuth() });
    await drive.files.update({ fileId, requestBody: { trashed: true } });
  } catch (e) {
    logger.warn({ fileId, err: String(e) }, "drive file retire failed");
  }
}

// ── Основний прохід ────────────────────────────────────────────────────────────
export interface ArchiveOptions {
  month?: string;        // "YYYY-MM" — лише фактури, виставлені в цьому місяці
  fromMonth?: string;    // нижня межа: місяць виставлення >= fromMonth (авто-запуски
                         // НЕ тягнуть минулі місяці — рішення власника 13.08.2026;
                         // минуле доганяється вручну кнопкою місяця на /cost-invoices)
  localIds?: number[];   // конкретні ручні/скан-рядки (миттєвий аплоуд після створення)
  ksefIds?: number[];    // конкретні KSeF-рядки
  force?: boolean;       // перезалити навіть якщо drive_file_id уже є
  skipKsef?: boolean;    // лише локальні (скани) — без походу в KSeF
}
export interface ArchiveResult {
  processed: number; uploaded: number; failed: number;
  alreadyRunning?: boolean;
  errors: string[];      // помилки рівня фірми/запуску (не по-рядкові)
}

let running = false;

export async function archiveInvoicesToDrive(opts: ArchiveOptions = {}): Promise<ArchiveResult> {
  if (running) return { processed: 0, uploaded: 0, failed: 0, alreadyRunning: true, errors: [] };
  running = true;
  const res: ArchiveResult = { processed: 0, uploaded: 0, failed: 0, errors: [] };
  try {
    const companies = new Map((await db.select().from(companiesTable)).map(c => [c.id, c]));

    // 1) локальні рядки (/cost-invoices: manual + scan) → PDF у Faktury kosztowe
    const lConds = [sql`${invoicesTable.source} IN ('manual', 'scan')`];
    if (opts.localIds?.length) lConds.push(inArray(invoicesTable.id, opts.localIds));
    if (opts.month) lConds.push(eq(invoicesTable.periodMonth, opts.month));
    if (opts.fromMonth) lConds.push(sql`${invoicesTable.periodMonth} >= ${opts.fromMonth}`);
    if (!opts.force) lConds.push(isNull(invoicesTable.driveFileId));
    const locals = await db.select().from(invoicesTable).where(and(...lConds));

    for (const row of locals) {
      res.processed++;
      const setRow = (patch: Record<string, unknown>) =>
        db.update(invoicesTable).set(patch).where(eq(invoicesTable.id, row.id));
      const fail = async (why: string) => { res.failed++; await setRow({ driveError: why, driveSyncedAt: new Date() }); };
      try {
        if (!row.number || !row.issueDate) { await fail("немає номера або дати виставлення"); continue; }
        if (!row.filePath) { await fail("внесена без файла — додай скан або PDF"); continue; }
        const abs = path.resolve(UPLOADS_ROOT, row.filePath);
        if (!abs.startsWith(UPLOADS_ROOT) || !fs.existsSync(abs)) { await fail("файл не знайдено на сервері"); continue; }
        const raw = fs.readFileSync(abs);
        const mime = sniffDocMime(raw) ?? "application/octet-stream";
        let buffer: Buffer = raw;
        let ext = ".pdf";
        let uploadMime = "application/pdf";
        if (mime === "image/jpeg" || mime === "image/png") {
          buffer = await imageToPdf(raw, mime); // фото → одно­сторінковий PDF
        } else if (!mime.includes("pdf")) {
          ext = path.extname(abs) || ""; // екзотика (webp тощо) — заливаємо як є
          uploadMime = mime;
        }
        const firm = companies.get(row.companyId ?? -1)?.name ?? "Inne";
        const folderId = await invoiceFolderId(COST_BRANCH, row.issueDate, firm, row.docType === "PROFORMA");
        const fileId = await uploadFile(folderId, `${archiveFileName(row.number, row.counterparty)}${ext}`, uploadMime, buffer, row.driveFileId);
        res.uploaded++;
        await setRow({ driveFileId: fileId, driveError: null, driveSyncedAt: new Date() });
      } catch (e: any) {
        await fail(`Drive: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }

    // 2) KSeF-рядки (purchase → Faktury kosztowe, sale → Faktury sprzedażowe) → XML
    if (!opts.skipKsef) {
      const kConds = [];
      if (opts.ksefIds?.length) kConds.push(inArray(ksefInvoicesTable.id, opts.ksefIds));
      if (opts.month) kConds.push(sql`substring(${ksefInvoicesTable.issueDate}::text, 1, 7) = ${opts.month}`);
      if (opts.fromMonth) kConds.push(sql`substring(${ksefInvoicesTable.issueDate}::text, 1, 7) >= ${opts.fromMonth}`);
      // «не залито» = бракує PDF-візуалізації. На Диск їде ЛИШЕ PDF (рішення
      // 26.08.2026); drive_file_id (legacy-XML перших заливів) — прибираємо в кошик,
      // тому рядки з ним теж підбираються.
      if (!opts.force) kConds.push(or(isNull(ksefInvoicesTable.drivePdfId), isNotNull(ksefInvoicesTable.driveFileId))!);
      const ksefRows = await db.select().from(ksefInvoicesTable).where(kConds.length ? and(...kConds) : undefined);

      fs.mkdirSync(KSEF_XML_DIR, { recursive: true });
      // авторизація в KSeF — лінива, раз на фірму за прохід
      const accessByCompany = new Map<number, string | null>();
      const accessFor = async (companyId: number): Promise<string | null> => {
        if (accessByCompany.has(companyId)) return accessByCompany.get(companyId)!;
        const co = companies.get(companyId);
        let access: string | null = null;
        try {
          access = co ? await ksefAccessFor({ name: co.name, nip: co.nip }) : null;
          if (co && !access) res.errors.push(`${co.name}: немає KSeF-токена — фактури фірми пропущені`);
        } catch (e: any) {
          res.errors.push(`${co?.name ?? companyId}: KSeF-авторизація не вдалася (${String(e?.message ?? e).slice(0, 120)})`);
        }
        accessByCompany.set(companyId, access);
        return access;
      };

      for (const row of ksefRows) {
        res.processed++;
        const setRow = (patch: Record<string, unknown>) =>
          db.update(ksefInvoicesTable).set(patch).where(eq(ksefInvoicesTable.id, row.id));
        try {
          // XML: локальна копія або скачування з KSeF
          let xml: string | null = null;
          if (row.xmlPath) {
            const abs = path.resolve(UPLOADS_ROOT, row.xmlPath);
            if (abs.startsWith(UPLOADS_ROOT) && fs.existsSync(abs)) xml = fs.readFileSync(abs, "utf8");
          }
          if (!xml) {
            const access = await accessFor(row.companyId);
            if (!access) continue; // фірмова помилка вже в res.errors; рядок лишається «ще не синковано»
            xml = await downloadKsefInvoiceXml(access, row.ksefNumber);
            const rel = path.join("ksef-xml", `${safeName(row.ksefNumber)}.xml`);
            fs.writeFileSync(path.resolve(UPLOADS_ROOT, rel), xml);
            const meta = parseKsefXmlMeta(xml);
            await setRow({
              xmlPath: rel,
              paymentMethodXml: meta.paymentMethod,
              ...(meta.dueDate && !row.dueDate ? { dueDate: meta.dueDate } : {}),
            });
          }
          const firm = companies.get(row.companyId)?.name ?? "Inne";
          const branch = row.kind === "sale" ? SALES_BRANCH : COST_BRANCH;
          const folderId = await invoiceFolderId(branch, row.issueDate, firm);
          const patch: Record<string, unknown> = { driveError: null, driveSyncedAt: new Date() };
          // контрагент в імені файла — друга сторона: закупівля → постачальник, продаж → покупець
          const counterparty = row.kind === "sale" ? row.buyerName : row.sellerName;
          const baseName = archiveFileName(row.invoiceNumber, counterparty);
          // legacy: XML перших заливів прибираємо з Диска (на Диску має лишатись лише PDF)
          if (row.driveFileId) {
            await retireDriveFile(row.driveFileId);
            patch.driveFileId = null;
          }
          if (!row.drivePdfId || opts.force) {
            const pdf = await buildKsefInvoicePdf(xml, { ksefNumber: row.ksefNumber, invoicingDate: row.invoicingDate });
            patch.drivePdfId = await uploadFile(folderId, `${baseName}.pdf`, "application/pdf", Buffer.from(pdf), row.drivePdfId);
            res.uploaded++;
          } else if (row.driveFileId) {
            // PDF уже був, ми лише прибрали XML — заодно піднімаємо імʼя до нової схеми
            await renameDriveFile(row.drivePdfId, `${baseName}.pdf`);
          }
          await setRow(patch);
        } catch (e: any) {
          res.failed++;
          await setRow({ driveError: `KSeF/Drive: ${String(e?.message ?? e).slice(0, 160)}`, driveSyncedAt: new Date() }).catch(() => {});
        }
      }
    }

    logger.info({ ...res, month: opts.month ?? "all" }, "invoice drive archive done");
    return res;
  } finally {
    running = false;
  }
}

// Разовий апгрейд архіву до схеми імен v2 (26.08.2026): «<номер> <контрагент>.pdf»,
// на Диску лише PDF. Прибирає legacy-XML у кошик і перейменовує вже залиті файли.
// Guard у settings — виконується один раз на середовище (крон/синк викликають щодня).
export async function upgradeArchiveNamesV2(): Promise<void> {
  const FLAG = "invoice_archive_names_v2";
  if (await getSetting(FLAG)) return;
  const drive = google.drive({ version: "v3", auth: getDriveAuth() });
  const ksefRows = await db.select().from(ksefInvoicesTable)
    .where(or(isNotNull(ksefInvoicesTable.driveFileId), isNotNull(ksefInvoicesTable.drivePdfId))!);
  for (const row of ksefRows) {
    const counterparty = row.kind === "sale" ? row.buyerName : row.sellerName;
    const baseName = archiveFileName(row.invoiceNumber, counterparty);
    if (row.driveFileId) {
      await retireDriveFile(row.driveFileId);
      await db.update(ksefInvoicesTable).set({ driveFileId: null }).where(eq(ksefInvoicesTable.id, row.id));
    }
    if (row.drivePdfId) await renameDriveFile(row.drivePdfId, `${baseName}.pdf`);
  }
  const locals = await db.select().from(invoicesTable).where(isNotNull(invoicesTable.driveFileId));
  for (const row of locals) {
    if (!row.number || !row.driveFileId) continue;
    try {
      const meta = await drive.files.get({ fileId: row.driveFileId, fields: "name" });
      const ext = path.extname(meta.data.name ?? "") || ".pdf";
      await renameDriveFile(row.driveFileId, `${archiveFileName(row.number, row.counterparty)}${ext}`);
    } catch { /* stale id — файл зник з Диска, перезаллється звичайним проходом */ }
  }
  await setSetting(FLAG, new Date().toISOString());
  logger.info({ ksef: ksefRows.length, locals: locals.length }, "invoice archive names v2 upgrade done");
}

// Фонове довантаження одного локального рядка (після скану/ручного додавання) —
// fire-and-forget, помилка лишиться в drive_error рядка.
export function archiveLocalInvoiceLater(id: number): void {
  setImmediate(() => {
    archiveInvoicesToDrive({ localIds: [id], force: true, skipKsef: true })
      .catch(e => logger.warn({ id, err: String(e) }, "background invoice archive failed"));
  });
}

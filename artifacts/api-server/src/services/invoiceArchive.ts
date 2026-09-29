// Архів фактур на Google Drive. Папки — офісного акаунта (рішення власника 29.09.2026,
// доступ на редагування виданий акаунту Юрія, яким ходить OAuth):
//   закупівлі:  FAKTURY → <рік> → M<міс>.<рр> → <ФІРМА> → [Skany | Proformy] → файл
//   продажі:    FAKTURY SPRZEDAŻOWI → M<міс>.<рр> → <ФІРМА> → файл   (без рівня року — як веде офіс)
// Фірма — назва папки офісу (ES → ESG, решта — по імені без урахування регістру);
// підпапки шукаються без регістру (в офісі є PROFORMA/PROFORMY/Proformy впереміш).
// KSeF-фактури — PDF-візуалізація прямо в папці фірми; внесені вручну (скан/фото/PDF
// з /cost-invoices) — у «Skany», проформи — у «Proformy». Назва файла = номер + контрагент.
// Рядок, який не вдалося заархівувати, несе drive_error з причиною — веб світить його
// червоним. Принагідно з XML читаються термін оплати (due_date, лише якщо ще порожній)
// і FormaPlatnosci → payment_method_xml.
// Режим relocate (кнопка місяця) — для вже залитих файлів звіряє папку та імʼя і
// переносить/перейменовує на Диску (файл лишається тим самим id); dryRun — лише звіт.
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
const FOLDER_MIME = "application/vnd.google-apps.folder";

// Назви папок фірм у офісному архіві (довідник companies → папка офісу)
const FIRM_FOLDER: Record<string, string> = { ES: "ESG" };
export const firmFolderName = (companyName: string | null | undefined): string =>
  FIRM_FOLDER[companyName ?? ""] ?? companyName ?? "Inne";

// Підпапки в папці фірми місяця + їхні історичні написання в офісі
const SUBFOLDERS = {
  main: null,
  proforma: { name: "Proformy", aliases: ["proformy", "proforma", "проформи", "проформа"] },
  scan: { name: "Skany", aliases: ["skany", "skan", "scans", "скани", "скан"] },
} as const;
export type ArchiveSubfolder = keyof typeof SUBFOLDERS;

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

// Ключ порівняння назв папок: без регістру, без зайвих пробілів, кирилична «М»
// у «М3.26» = латинська (офіс так і називав частину місяців).
export const folderKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ").replace(/м/g, "m");

// Шлях у архіві для фактури: сегменти папок від кореня гілки
export function archivePath(branch: string, issueDate: string, companyName: string | null | undefined, sub: ArchiveSubfolder = "main"): string[] {
  const { year, month } = driveMonthFolder(issueDate);
  const segs = branch === SALES_BRANCH ? [month] : [year, month];
  segs.push(firmFolderName(companyName));
  const s = SUBFOLDERS[sub];
  if (s) segs.push(s.name);
  return segs;
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

// Підпапка за назвою без урахування регістру/написання (aliases); створюється з
// канонічною назвою, якщо жодного варіанта нема. dryRun — не створює (null).
async function findOrCreateFolder(name: string, parentId: string, aliases: readonly string[], dryRun: boolean): Promise<string | null> {
  const memoKey = `${parentId}|${folderKey(name)}`;
  if (folderMemo.has(memoKey)) return folderMemo.get(memoKey)!;
  const drive = google.drive({ version: "v3", auth: getDriveAuth() });
  const keys = new Set([folderKey(name), ...aliases.map(folderKey)]);
  const listed = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: "files(id,name)", pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  const hits = (listed.data.files ?? []).filter(f => keys.has(folderKey(f.name ?? "")));
  // точний збіг канонічної назви має пріоритет, далі — перший за назвою (стабільно)
  const hit = hits.find(f => f.name === name) ?? hits.sort((x, y) => (x.name ?? "").localeCompare(y.name ?? ""))[0];
  let id = hit?.id ?? null;
  if (!id) {
    if (dryRun) return null;
    const created = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] }, fields: "id", supportsAllDrives: true,
    });
    id = created.data.id!;
  }
  folderMemo.set(memoKey, id);
  return id;
}

// id цільової папки фактури; у dryRun — null, якщо якоїсь ланки ще нема
async function invoiceFolderId(branch: string, issueDate: string, companyName: string | null | undefined, sub: ArchiveSubfolder = "main", dryRun = false): Promise<string | null> {
  let parent: string | null = await branchRootId(branch);
  const s = SUBFOLDERS[sub];
  for (const seg of archivePath(branch, issueDate, companyName, sub)) {
    const aliases: readonly string[] = s && seg === s.name ? s.aliases : [];
    parent = await findOrCreateFolder(seg, parent!, aliases, dryRun);
    if (!parent) return null;
  }
  return parent;
}

async function uploadFile(folderId: string, name: string, mimeType: string, buffer: Buffer, existingId: string | null): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getDriveAuth() });
  if (existingId) {
    try {
      // разом із вмістом оновлюємо й імʼя — force-перезалив підтягує нову схему назв;
      // і місце — файл, залитий у стару структуру, переїжджає в поточну папку
      await drive.files.update({ fileId: existingId, supportsAllDrives: true, requestBody: { name }, media: { mimeType, body: Readable.from(buffer) } });
      await ensurePlacement(existingId, folderId, name, false);
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

// Звірити, що вже залитий файл лежить у потрібній папці під потрібним іменем;
// перенести/перейменувати без перезаливу (id файла не змінюється — БД чинна).
// "missing" — файла на Диску нема (кошик/видалений): треба перезалити.
export type PlacementResult = "ok" | "moved" | "renamed" | "missing";
async function ensurePlacement(fileId: string, folderId: string, name: string, dryRun: boolean): Promise<{ status: PlacementResult; from?: string; oldName?: string }> {
  const drive = google.drive({ version: "v3", auth: getDriveAuth() });
  let meta: { name?: string | null; parents?: string[] | null; trashed?: boolean | null };
  try {
    meta = (await drive.files.get({ fileId, fields: "name,parents,trashed", supportsAllDrives: true })).data;
  } catch { return { status: "missing" }; }
  if (meta.trashed) return { status: "missing" };
  const parents = meta.parents ?? [];
  const inPlace = parents.includes(folderId);
  const sameName = meta.name === name;
  if (inPlace && sameName) return { status: "ok" };
  if (!dryRun) {
    await drive.files.update({
      fileId, supportsAllDrives: true,
      ...(inPlace ? {} : { addParents: folderId, removeParents: parents.join(",") }),
      requestBody: sameName ? {} : { name },
    });
  }
  return inPlace ? { status: "renamed", oldName: meta.name ?? "" } : { status: "moved", from: parents.join(","), oldName: meta.name ?? "" };
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
  relocate?: boolean;    // і вже залиті рядки: звірити папку/імʼя на Диску, перенести за потреби
  dryRun?: boolean;      // нічого не міняти (ні на Диску, ні в БД) — лише звіт у plan
}
export interface ArchiveResult {
  processed: number; uploaded: number; failed: number;
  moved: number;         // перенесено/перейменовано без перезаливу (relocate)
  alreadyRunning?: boolean;
  errors: string[];      // помилки рівня фірми/запуску (не по-рядкові)
  plan?: string[];       // dryRun: що було б зроблено, по рядку на файл
}

let running = false;

export async function archiveInvoicesToDrive(opts: ArchiveOptions = {}): Promise<ArchiveResult> {
  if (running) return { processed: 0, uploaded: 0, failed: 0, moved: 0, alreadyRunning: true, errors: [] };
  running = true;
  const dryRun = !!opts.dryRun;
  const relocate = !!opts.relocate || dryRun;
  const res: ArchiveResult = { processed: 0, uploaded: 0, failed: 0, moved: 0, errors: [], ...(dryRun ? { plan: [] } : {}) };
  const note = (line: string) => { res.plan?.push(line); };
  // вже залитий файл: звірити місце/імʼя; повертає true, якщо рядок закрито (нічого заливати)
  const settle = async (fileId: string | null, branch: string, issueDate: string, companyName: string | null | undefined, sub: ArchiveSubfolder, name: string, label: string): Promise<boolean> => {
    if (!fileId || opts.force) return false;
    if (!relocate) return true;
    const pathStr = [branch, ...archivePath(branch, issueDate, companyName, sub)].join("/");
    const folderId = await invoiceFolderId(branch, issueDate, companyName, sub, dryRun);
    if (!folderId) { note(`MOVE  ${label} → ${pathStr}/${name}  (папку буде створено)`); res.moved++; return true; }
    const p = await ensurePlacement(fileId, folderId, name, dryRun);
    if (p.status === "missing") { note(`RE-UP ${label} → ${pathStr}/${name}  (файла на Диску нема)`); return false; }
    if (p.status !== "ok") { res.moved++; note(`${p.status === "moved" ? "MOVE " : "RENAME"} ${label}: «${p.oldName}» → ${pathStr}/${name}`); }
    return true;
  };
  try {
    const companies = new Map((await db.select().from(companiesTable)).map(c => [c.id, c]));

    // 1) локальні рядки (/cost-invoices: manual + scan) → PDF у Faktury kosztowe
    const lConds = [sql`${invoicesTable.source} IN ('manual', 'scan')`];
    if (opts.localIds?.length) lConds.push(inArray(invoicesTable.id, opts.localIds));
    if (opts.month) lConds.push(eq(invoicesTable.periodMonth, opts.month));
    if (opts.fromMonth) lConds.push(sql`${invoicesTable.periodMonth} >= ${opts.fromMonth}`);
    if (!opts.force && !relocate) lConds.push(isNull(invoicesTable.driveFileId));
    const locals = await db.select().from(invoicesTable).where(and(...lConds));

    for (const row of locals) {
      res.processed++;
      const setRow = (patch: Record<string, unknown>) =>
        dryRun ? Promise.resolve() : db.update(invoicesTable).set(patch).where(eq(invoicesTable.id, row.id));
      const fail = async (why: string) => { res.failed++; note(`FAIL  local#${row.id}: ${why}`); await setRow({ driveError: why, driveSyncedAt: new Date() }); };
      try {
        if (!row.number || !row.issueDate) { await fail("немає номера або дати виставлення"); continue; }
        const firmName = companies.get(row.companyId ?? -1)?.name;
        const sub: ArchiveSubfolder = row.docType === "PROFORMA" ? "proforma" : "scan";
        const fileName = archiveFileName(row.number, row.counterparty);
        if (await settle(row.driveFileId, COST_BRANCH, row.issueDate, firmName, sub, `${fileName}.pdf`, `local#${row.id} ${row.number}`)) continue;
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
        if (dryRun) { note(`UP    local#${row.id} → ${[COST_BRANCH, ...archivePath(COST_BRANCH, row.issueDate, firmName, sub)].join("/")}/${fileName}${ext}`); res.uploaded++; continue; }
        const folderId = (await invoiceFolderId(COST_BRANCH, row.issueDate, firmName, sub))!;
        const fileId = await uploadFile(folderId, `${fileName}${ext}`, uploadMime, buffer, row.driveFileId);
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
      if (!opts.force && !relocate) kConds.push(or(isNull(ksefInvoicesTable.drivePdfId), isNotNull(ksefInvoicesTable.driveFileId))!);
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
          dryRun ? Promise.resolve() : db.update(ksefInvoicesTable).set(patch).where(eq(ksefInvoicesTable.id, row.id));
        const firmName = companies.get(row.companyId)?.name;
        const branch = row.kind === "sale" ? SALES_BRANCH : COST_BRANCH;
        // контрагент в імені файла — друга сторона: закупівля → постачальник, продаж → покупець
        const counterparty = row.kind === "sale" ? row.buyerName : row.sellerName;
        const baseName = archiveFileName(row.invoiceNumber, counterparty);
        try {
          // вже є PDF (і legacy-XML прибрано) — лише звірка місця/імені
          if (!row.driveFileId && await settle(row.drivePdfId, branch, row.issueDate, firmName, "main", `${baseName}.pdf`, `ksef#${row.id} ${row.invoiceNumber}`)) continue;
          if (dryRun) { note(`UP    ksef#${row.id} → ${[branch, ...archivePath(branch, row.issueDate, firmName)].join("/")}/${baseName}.pdf${row.xmlPath ? "" : "  (XML з KSeF)"}`); res.uploaded++; continue; }
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
          const folderId = (await invoiceFolderId(branch, row.issueDate, firmName))!;
          const patch: Record<string, unknown> = { driveError: null, driveSyncedAt: new Date() };
          // legacy: XML перших заливів прибираємо з Диска (на Диску має лишатись лише PDF)
          if (row.driveFileId) {
            await retireDriveFile(row.driveFileId);
            patch.driveFileId = null;
          }
          if (!row.drivePdfId || opts.force) {
            const pdf = await buildKsefInvoicePdf(xml, { ksefNumber: row.ksefNumber, invoicingDate: row.invoicingDate });
            patch.drivePdfId = await uploadFile(folderId, `${baseName}.pdf`, "application/pdf", Buffer.from(pdf), row.drivePdfId);
            res.uploaded++;
          } else if (relocate) {
            // PDF уже був, ми лише прибрали XML — заодно звіряємо місце й імʼя
            const p = await ensurePlacement(row.drivePdfId, folderId, `${baseName}.pdf`, false);
            if (p.status === "missing") {
              const pdf = await buildKsefInvoicePdf(xml, { ksefNumber: row.ksefNumber, invoicingDate: row.invoicingDate });
              patch.drivePdfId = await uploadFile(folderId, `${baseName}.pdf`, "application/pdf", Buffer.from(pdf), null);
              res.uploaded++;
            } else if (p.status !== "ok") res.moved++;
          } else {
            await renameDriveFile(row.drivePdfId, `${baseName}.pdf`);
          }
          await setRow(patch);
        } catch (e: any) {
          res.failed++;
          note(`FAIL  ksef#${row.id}: ${String(e?.message ?? e).slice(0, 160)}`);
          await setRow({ driveError: `KSeF/Drive: ${String(e?.message ?? e).slice(0, 160)}`, driveSyncedAt: new Date() }).catch(() => {});
        }
      }
    }

    logger.info({ ...res, plan: undefined, planLines: res.plan?.length, month: opts.month ?? "all", relocate, dryRun }, "invoice drive archive done");
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

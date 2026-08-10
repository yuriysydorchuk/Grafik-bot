// «Фактури коштові» (/cost-invoices) — робочий модуль внесення й контролю оплат
// закупівельних фактур. Об'єднує три джерела в одному списку:
//   - KSeF-закупівлі (авто, ksef_invoices kind=purchase),
//   - внесені вручну на сайті та скани з бота (invoices, source manual|scan),
//   - історичні рядки sheet-синку (invoices, source=sheet — read-only тут).
// Доступ: viewFinance АБО costInvoices (роль «бухгалтерія» бачить лише цей модуль).
import { Router, type IRouter } from "express";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { db , vehiclesTable } from "@workspace/db";
import { invoicesTable, ksefInvoicesTable, companiesTable, hostelsTable } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { authRequired, requireAnyCap, type AuthedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import { UPLOADS_ROOT, INVOICES_DIR, sniffDocMime, makeStoredName, deleteStoredFile } from "../lib/uploads";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireAnyCap("viewFinance", "costInvoices"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const validMonth = (s: any) => typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
const r2 = (n: number) => Math.round(n * 100) / 100;
const normNumber = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, "");

// Уніфікований рядок списку: origin визначає, звідки правити (ksef | local)
export type CostInvoiceRow = {
  key: string; origin: "ksef" | "local"; id: number;
  source: "ksef" | "manual" | "scan" | "sheet";
  companyId: number | null; firm: string | null;
  issueDate: string | null; number: string | null;
  seller: string | null; sellerNip: string | null;
  gross: number; dueDate: string | null;
  paid: boolean; paidDate: string | null; paidSource: string | null;
  note: string | null; hasFile: boolean;
  dupOfKsefId: number | null; // ручна/sheet-фактура, яку вже видно в KSeF (щоб не рахувати двічі)
  hostelId: number | null;    // привʼязка до хостелу (лише local-рядки)
  vehicleId: number | null;   // привʼязка до авто (лізинг/сервіс; лише local-рядки)
  city: string | null;        // cost-center місто (P&L по містах; лише local-рядки)
};

router.get("/cost-invoices", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
  const companyId = Number(req.query.companyId) || null;
  const companies = new Map((await db.select().from(companiesTable)).map(c => [c.id, c.name]));

  const kConds = [eq(ksefInvoicesTable.kind, "purchase"), eq(ksefInvoicesTable.revenueMonth, month)];
  if (companyId) kConds.push(eq(ksefInvoicesTable.companyId, companyId));
  const ksefRows = await db.select().from(ksefInvoicesTable).where(and(...kConds)).orderBy(desc(ksefInvoicesTable.issueDate));

  // sheet-рядки (стара гугл-таблиця) сюди не тягнемо — вони живуть на /invoices
  const lConds = [eq(invoicesTable.periodMonth, month), sql`${invoicesTable.source} IN ('manual', 'scan')`];
  if (companyId) lConds.push(eq(invoicesTable.companyId, companyId));
  const localRows = await db.select().from(invoicesTable).where(and(...lConds)).orderBy(desc(invoicesTable.sortIdx));

  // дедуп-підказка: локальний рядок, що збігається з KSeF номером+сумою
  const ksefByNum = new Map<string, { id: number; gross: number }[]>();
  for (const k of ksefRows) {
    const key = normNumber(k.invoiceNumber);
    if (!ksefByNum.has(key)) ksefByNum.set(key, []);
    ksefByNum.get(key)!.push({ id: k.id, gross: k.gross });
  }

  const rows: CostInvoiceRow[] = [];
  for (const k of ksefRows) {
    const paid = k.manualStatus ? k.manualStatus === "paid" : k.paidDate != null;
    rows.push({
      key: `k${k.id}`, origin: "ksef", id: k.id, source: "ksef",
      companyId: k.companyId, firm: companies.get(k.companyId) ?? null,
      issueDate: k.issueDate, number: k.invoiceNumber,
      seller: k.sellerName, sellerNip: k.sellerNip,
      gross: k.gross, dueDate: null,
      paid,
      paidDate: k.manualStatus === "paid" ? k.manualPaidDate ?? k.paidDate : k.manualStatus ? null : k.paidDate,
      paidSource: k.manualStatus ? "manual" : k.paidDate ? k.paidVia ?? "bank" : null,
      note: null, hasFile: false, dupOfKsefId: null, hostelId: null, vehicleId: null, city: null,
    });
  }
  for (const l of localRows) {
    const paid = l.manualStatus ? l.manualStatus === "paid" : !l.unpaid;
    const dup = ksefByNum.get(normNumber(l.number))?.find(x => Math.abs(x.gross - l.amount) <= 0.05) ?? null;
    rows.push({
      key: `l${l.id}`, origin: "local", id: l.id,
      source: (l.source === "manual" || l.source === "scan" ? l.source : "sheet"),
      companyId: l.companyId, firm: l.companyId ? companies.get(l.companyId) ?? null : null,
      issueDate: l.issueDate, number: l.number,
      seller: l.counterparty, sellerNip: l.sellerNip,
      gross: l.amount, dueDate: l.dueDate,
      paid,
      paidDate: l.manualStatus === "paid" ? l.manualPaidDate ?? l.paidDate : l.manualStatus ? null : l.paidDate,
      paidSource: l.manualStatus ? "manual" : paid ? "sheet" : null,
      note: l.note, hasFile: !!l.filePath, dupOfKsefId: dup?.id ?? null, hostelId: l.hostelId, vehicleId: l.vehicleId, city: l.city,
    });
  }
  rows.sort((a, b) => String(b.issueDate ?? "").localeCompare(String(a.issueDate ?? "")));

  // cost-center міста для селектора (фабрики ∪ хостели ∪ уже проставлені)
  const cityRows: any = await db.execute(sql`
    SELECT DISTINCT c FROM (
      SELECT city AS c FROM factories WHERE city IS NOT NULL AND city <> ''
      UNION SELECT city FROM hostels WHERE city IS NOT NULL AND city <> ''
      UNION SELECT city FROM invoices WHERE city IS NOT NULL AND city <> ''
    ) x ORDER BY 1`);

  // зведення без дублів (дубльований локальний рядок не рахуємо вдруге)
  const counted = rows.filter(r => !r.dupOfKsefId);
  ok(res, {
    month, rows,
    cities: ((cityRows.rows ?? cityRows) as any[]).map((r: any) => String(r.c)),
    totals: {
      count: counted.length,
      gross: r2(counted.reduce((s, r) => s + r.gross, 0)),
      paidGross: r2(counted.filter(r => r.paid).reduce((s, r) => s + r.gross, 0)),
      unpaidGross: r2(counted.filter(r => !r.paid).reduce((s, r) => s + r.gross, 0)),
      unpaidCount: counted.filter(r => !r.paid).length,
    },
    companies: [...companies.entries()].map(([id, name]) => ({ id, name })),
  });
});

router.get("/cost-invoices/months", async (_req, res) => {
  // місяці, де є або KSeF-закупівлі, або локальні рядки
  const r: any = await db.execute(sql`
    SELECT DISTINCT m FROM (
      SELECT revenue_month AS m FROM ksef_invoices WHERE kind = 'purchase'
      UNION SELECT period_month FROM invoices
    ) x ORDER BY m DESC`);
  ok(res, { months: ((r?.rows ?? r) as any[]).map(x => String(x.m)) });
});

// ── Створення/редагування локальних рядків ─────────────────────────────────────
function parseBody(b: any): { err?: string; patch?: Record<string, unknown> } {
  const patch: Record<string, unknown> = {};
  if (b.issueDate !== undefined) { if (!validDate(b.issueDate)) return { err: "issueDate: YYYY-MM-DD" }; patch.issueDate = b.issueDate; patch.periodMonth = String(b.issueDate).slice(0, 7); }
  if (b.number !== undefined) { const n = String(b.number ?? "").trim(); if (!n) return { err: "number required" }; patch.number = n; }
  if (b.seller !== undefined) patch.counterparty = String(b.seller ?? "").trim() || null;
  if (b.sellerNip !== undefined) { const nip = String(b.sellerNip ?? "").replace(/\D/g, ""); if (nip && nip.length !== 10) return { err: "NIP — 10 цифр" }; patch.sellerNip = nip || null; }
  if (b.amount !== undefined) { const a = Number(String(b.amount).replace(/\s/g, "").replace(",", ".")); if (!Number.isFinite(a) || a <= 0) return { err: "amount > 0" }; patch.amount = Math.round(a * 100) / 100; }
  if (b.dueDate !== undefined) { if (b.dueDate && !validDate(b.dueDate)) return { err: "dueDate: YYYY-MM-DD" }; patch.dueDate = b.dueDate || null; }
  if (b.note !== undefined) patch.note = String(b.note ?? "").trim() || null;
  if (b.category !== undefined) patch.category = String(b.category ?? "").trim() || null;
  return { patch };
}

// привʼязка фактури до хостелу (рахунки за оренду/медіа) і cost-center міста
// (P&L по містах) — наша метадата
async function applyHostelId(b: any, patch: Record<string, unknown>): Promise<string | null> {
  if (b.city !== undefined) patch.city = b.city ? String(b.city).trim() : null;
  if (b.hostelId === undefined) return null;
  const hid = b.hostelId ? Number(b.hostelId) : null;
  if (hid !== null && !Number.isFinite(hid)) return "bad hostelId";
  if (hid) {
    const [h] = await db.select({ id: hostelsTable.id }).from(hostelsTable).where(eq(hostelsTable.id, hid));
    if (!h) return "unknown hostel";
  }
  patch.hostelId = hid;
  return null;
}

// привʼязка фактури до авто (лізингові/сервісні — картка авто рахує виплачено/залишок)
async function applyVehicleId(b: any, patch: Record<string, unknown>): Promise<string | null> {
  if (b.vehicleId === undefined) return null;
  const vid = b.vehicleId ? Number(b.vehicleId) : null;
  if (vid !== null && !Number.isFinite(vid)) return "bad vehicleId";
  if (vid) {
    const [v] = await db.select({ id: vehiclesTable.id }).from(vehiclesTable).where(eq(vehiclesTable.id, vid));
    if (!v) return "unknown vehicle";
  }
  patch.vehicleId = vid;
  return null;
}

router.post("/cost-invoices", async (req, res) => {
  const b = req.body ?? {};
  const companyId = Number(b.companyId);
  if (!companyId) return fail(res, 400, "companyId required");
  const [co] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!co) return fail(res, 400, "unknown company");
  const { err, patch } = parseBody(b);
  if (err) return fail(res, 400, err);
  if (!patch?.issueDate || !patch?.number || !patch?.amount) return fail(res, 400, "issueDate, number, amount — обов'язкові");
  const hostelErr = await applyHostelId(b, patch);
  const vehicleErr = await applyVehicleId(b, patch);
  if (vehicleErr) return fail(res, 400, vehicleErr);
  if (hostelErr) return fail(res, 400, hostelErr);
  const paid = !!b.paid;
  const paidDate = paid ? (validDate(b.paidDate) ? b.paidDate : new Date().toISOString().slice(0, 10)) : null;
  const [row] = await db.insert(invoicesTable).values({
    ...patch as any,
    companyId,
    source: "manual", tabName: "manual", sortIdx: Math.floor(Date.now() / 1000),
    statusRaw: paid ? "Opłacona (панель)" : "Nie oplacona", unpaid: !paid, paidDate,
    createdBy: (req as AuthedRequest).admin?.adminId ?? null,
  }).returning();
  ok(res, row);
});

router.patch("/cost-invoices/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  // повне редагування — лише для рядків сайту/бота; sheet-рядки: тільки оплата/нотатка
  if (row.source === "manual" || row.source === "scan") {
    const parsed = parseBody(b);
    if (parsed.err) return fail(res, 400, parsed.err);
    Object.assign(patch, parsed.patch);
    if (b.companyId !== undefined) {
      const co = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, Number(b.companyId)));
      if (!co.length) return fail(res, 400, "unknown company");
      patch.companyId = Number(b.companyId);
    }
  } else if (b.note !== undefined) patch.note = String(b.note ?? "").trim() || null;
  {
    const hostelErr = await applyHostelId(b, patch);
  const vehicleErr = await applyVehicleId(b, patch);
  if (vehicleErr) return fail(res, 400, vehicleErr);
    if (hostelErr) return fail(res, 400, hostelErr);
  }
  if (b.paid !== undefined) {
    if (row.source === "manual" || row.source === "scan") {
      patch.unpaid = !b.paid;
      patch.paidDate = b.paid ? (validDate(b.paidDate) ? b.paidDate : row.paidDate ?? new Date().toISOString().slice(0, 10)) : null;
      patch.manualStatus = null; patch.manualPaidDate = null;
    } else {
      // sheet-рядок — через override, як на старій сторінці
      patch.manualStatus = b.paid ? "paid" : "unpaid";
      patch.manualPaidDate = b.paid && validDate(b.paidDate) ? b.paidDate : null;
    }
  }
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(invoicesTable).set(patch).where(eq(invoicesTable.id, id)).returning();
  ok(res, updated);
});

// оплата KSeF-рядка з цієї ж сторінки (дзеркало PATCH /ksef/invoices/:id, але під
// гейтом costInvoices — бухгалтерія не має доступу до /ksef)
router.patch("/cost-invoices/ksef/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [inv] = await db.select().from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  if (!inv) return fail(res, 404, "not found");
  const b = req.body ?? {};
  if (b.paid === undefined) return fail(res, 400, "paid required");
  const autoPaid = inv.paidDate != null;
  const patch: Record<string, unknown> = Boolean(b.paid) === autoPaid
    ? { manualStatus: null, manualPaidDate: null }
    : { manualStatus: b.paid ? "paid" : "unpaid", manualPaidDate: b.paid && validDate(b.paidDate) ? b.paidDate : null };
  const [updated] = await db.update(ksefInvoicesTable).set(patch).where(eq(ksefInvoicesTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/cost-invoices/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (row.source !== "manual" && row.source !== "scan") return fail(res, 400, "sheet-рядки не видаляються звідси");
  deleteStoredFile(row.filePath);
  await db.delete(invoicesTable).where(eq(invoicesTable.id, id));
  ok(res, { ok: true });
});

// ── Файл (скан/фото фактури) ───────────────────────────────────────────────────
const uploadScan = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Розпізнавання з сайту: файл → Document AI → чернетка полів (нічого не зберігає;
// збереження — звичайним POST /cost-invoices + аплоуд файлу)
router.post("/cost-invoices/scan", uploadScan.single("file"), async (req, res) => {
  if (!req.file) return fail(res, 400, "Файл не отримано");
  const mime = sniffDocMime(req.file.buffer);
  if (!mime || !/pdf|jpeg|png|webp/.test(mime)) return fail(res, 400, "Дозволені PDF або фото (jpg/png/webp)");
  try {
    const { processInvoice, detectOurCompany } = await import("../services/docai");
    const { draft, fullText } = await processInvoice(req.file.buffer, mime);
    const companies = await db.select({ id: companiesTable.id, nip: companiesTable.nip }).from(companiesTable);
    ok(res, { draft: { ...draft, companyId: detectOurCompany(draft, fullText, companies) } });
  } catch (e: any) {
    logger.warn({ err: e?.message }, "site invoice scan failed");
    fail(res, 502, e?.message || "Не вдалося розпізнати");
  }
});

router.post("/cost-invoices/:id/file", uploadScan.single("file"), async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (!req.file) return fail(res, 400, "Файл не отримано");
  const mime = sniffDocMime(req.file.buffer);
  if (!mime || mime.includes("msword") || mime.includes("wordprocessing")) return fail(res, 400, "Дозволені PDF або фото");
  const stored = makeStoredName(req.file.originalname || "scan");
  fs.writeFileSync(path.join(INVOICES_DIR, stored), req.file.buffer);
  deleteStoredFile(row.filePath);
  const rel = path.join("invoices", stored);
  await db.update(invoicesTable).set({ filePath: rel }).where(eq(invoicesTable.id, id));
  ok(res, { ok: true, filePath: rel });
});

router.get("/cost-invoices/:id/file", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!row?.filePath) return fail(res, 404, "no file");
  const abs = path.resolve(UPLOADS_ROOT, row.filePath);
  if (!abs.startsWith(UPLOADS_ROOT) || !fs.existsSync(abs)) return fail(res, 404, "no file");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const ext = path.extname(abs).toLowerCase();
  const byExt: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
  const mime = sniffDocMime(fs.readFileSync(abs)) ?? byExt[ext] ?? "application/octet-stream";
  res.setHeader("Content-Type", mime);
  // inline — щоб браузер показував у вкладці/превʼю, а не скачував
  res.setHeader("Content-Disposition", `inline; filename="faktura-${id}${ext || ""}"`);
  fs.createReadStream(abs).pipe(res);
});

export default router;

// Використовується бот-сканером: створити рядок source='scan' (файл уже на диску).
export async function createScannedInvoice(data: {
  companyId: number; issueDate: string; number: string; seller: string | null;
  sellerNip: string | null; amount: number; fileRel: string; createdBy: number | null;
}): Promise<number> {
  const [row] = await db.insert(invoicesTable).values({
    companyId: data.companyId, periodMonth: data.issueDate.slice(0, 7),
    issueDate: data.issueDate, number: data.number, amount: Math.round(data.amount * 100) / 100,
    counterparty: data.seller, sellerNip: data.sellerNip,
    statusRaw: "Nie oplacona", unpaid: true,
    source: "scan", tabName: "manual", sortIdx: Math.floor(Date.now() / 1000),
    filePath: data.fileRel, createdBy: data.createdBy,
  }).returning({ id: invoicesTable.id });
  logger.info({ id: row!.id, number: data.number }, "scanned invoice stored");
  return row!.id;
}
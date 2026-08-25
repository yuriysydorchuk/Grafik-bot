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
import { invoicesTable, ksefInvoicesTable, companiesTable, hostelsTable, adminsTable, cleaningProjectsTable, counterpartyRulesTable } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { authRequired, requireAnyCap, type AuthedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import { UPLOADS_ROOT, INVOICES_DIR, sniffDocMime, makeStoredName, deleteStoredFile } from "../lib/uploads";
import { lastSyncStatus, syncKsef } from "../services/ksef";
import { archiveInvoicesToDrive, archiveLocalInvoiceLater, retireDriveFile } from "../services/invoiceArchive";
import { getExpenseCats, patternCondition, type ExpenseCat } from "../services/bankClassify";
import { canonCity } from "../services/svodniSync";

const router: IRouter = Router();
router.use(authRequired);
// скоуп по префіксу — роль бухгалтерії (costInvoices) не мусить проходити фін-гейти сусідніх роутерів
router.use("/cost-invoices", requireAnyCap("viewFinance", "costInvoices"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const validMonth = (s: any) => typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
const r2 = (n: number) => Math.round(n * 100) / 100;
const normNumber = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, "");

// сьогодні за локальним часом сервера (Europe/Berlin) — НЕ toISOString, вона зрізає день
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Спосіб оплати: ручний вибір кшєнгової має пріоритет; авто — банк-матч (переказ),
// FormaPlatnosci з XML KSeF або текст статусу старого реєстру («Gotówka»/«Przelew»)
export type PayMethod = "przelew" | "gotowka" | null;
const validMethod = (v: any): v is PayMethod => v === null || v === "przelew" || v === "gotowka";
const methodFromText = (s: string | null | undefined): PayMethod =>
  /got[óo]wk/i.test(s ?? "") ? "gotowka" : /przelew/i.test(s ?? "") ? "przelew" : null;

// ── Категорія витрат фактури ───────────────────────────────────────────────────
// Та сама система, що й у витягах: ручна (manual_category) ?? правило контрагента
// по назві постачальника ?? авто-патерн категорії ?? 'other'. Рахується при
// читанні — зміни патернів/правил перекласифіковують фактури самі.
function invoiceCatCase(haystack: string, cats: ExpenseCat[], rules: { pattern: string; category: string }[]): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const ruleWhens = rules.map(r => `WHEN ${haystack} LIKE '%${esc(r.pattern.toUpperCase().replace(/\s+/g, " "))}%' THEN '${esc(r.category)}'`).join(" ");
  const patWhens = cats.filter(c => c.pattern).map(c => `WHEN ${patternCondition(c.pattern!, haystack)} THEN '${esc(c.key)}'`).join(" ");
  return `CASE WHEN manual_category IS NOT NULL THEN manual_category ${ruleWhens} ${patWhens} ELSE 'other' END`;
}

// key → {cat, manual} для набору id-шок однієї з двох таблиць
async function invoiceCats(table: "ksef_invoices" | "invoices", ids: number[], haystack: string): Promise<Map<number, { cat: string; manual: boolean }>> {
  const out = new Map<number, { cat: string; manual: boolean }>();
  if (!ids.length) return out;
  const cats = await getExpenseCats();
  // новіше правило пріоритетніше (у витягах послідовне застосування лишає останнє)
  const rules = await db.select().from(counterpartyRulesTable).orderBy(desc(counterpartyRulesTable.id));
  const r: any = await db.execute(sql`
    SELECT id, ${sql.raw(invoiceCatCase(haystack, cats, rules))} AS cat, (manual_category IS NOT NULL) AS manual
    FROM ${sql.raw(table)} WHERE id IN (${sql.raw(ids.join(","))})`);
  for (const row of (r?.rows ?? r) as any[]) out.set(Number(row.id), { cat: String(row.cat), manual: !!row.manual });
  return out;
}

const KSEF_HAY = `upper(coalesce(seller_name, ''))`;
const LOCAL_HAY = `upper(coalesce(counterparty, '') || ' ' || coalesce(note, ''))`;

// валідний ключ ручної категорії фактури (owner_* тут не мають сенсу)
async function validInvoiceCat(v: string): Promise<boolean> {
  if (v === "other") return true;
  return (await getExpenseCats()).some(c => c.key === v);
}

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
  paymentMethod: PayMethod;   // ефективний спосіб оплати (ручний ?? авто)
  paymentMethodSource: "manual" | "auto" | null;
  cashReport: boolean;        // «рапорт готівковий» — чекбокс кшєнгової
  cleaning: boolean;          // видаток бізнесу прибирання (розділ /cleaning; KSeF — segment='cleaning')
  cleaningProjectId: number | null; // вспульнота видатку (NULL = загальний видаток прибирання)
  overdue: boolean;           // не оплачена і термін минув
  driveFileId: string | null; // файл в архіві Google Drive (KSeF: XML)
  drivePdfId: string | null;  // PDF-візуалізація KSeF-фактури (лінк веде сюди)
  driveError: string | null;  // чому файла нема на Drive
  addedBy: string | null;     // хто вніс (скан з бота / сайт)
  addedAt: string | null;
  category: string;           // ефективна категорія витрат (ключ expense_categories або 'other')
  categorySource: "manual" | "auto";
};

router.get("/cost-invoices", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : todayStr().slice(0, 7);
  const companyId = Number(req.query.companyId) || null;
  const companies = new Map((await db.select().from(companiesTable)).map(c => [c.id, c.name]));
  const admins = new Map((await db.select({ id: adminsTable.id, name: adminsTable.name }).from(adminsTable)).map(a => [a.id, a.name]));
  const today = todayStr();

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

  // ефективні категорії витрат обох джерел (ручна ?? правило ?? патерн ?? other)
  const [kCats, lCats] = await Promise.all([
    invoiceCats("ksef_invoices", ksefRows.map(k => k.id), KSEF_HAY),
    invoiceCats("invoices", localRows.map(l => l.id), LOCAL_HAY),
  ]);

  const rows: CostInvoiceRow[] = [];
  for (const k of ksefRows) {
    const paid = k.manualStatus ? k.manualStatus === "paid" : k.paidDate != null;
    // авто-метод: банківський матч = переказ, інакше FormaPlatnosci з XML фактури
    const autoMethod: PayMethod = k.paidVia === "bank" && k.paidTxnId ? "przelew" : (k.paymentMethodXml as PayMethod) ?? null;
    const method: PayMethod = (k.paymentMethod as PayMethod) ?? autoMethod;
    rows.push({
      key: `k${k.id}`, origin: "ksef", id: k.id, source: "ksef",
      companyId: k.companyId, firm: companies.get(k.companyId) ?? null,
      issueDate: k.issueDate, number: k.invoiceNumber,
      seller: k.sellerName, sellerNip: k.sellerNip,
      gross: k.gross, dueDate: k.dueDate,
      paid,
      paidDate: k.manualStatus === "paid" ? k.manualPaidDate ?? k.paidDate : k.manualStatus ? null : k.paidDate,
      paidSource: k.manualStatus ? "manual" : k.paidDate ? k.paidVia ?? "bank" : null,
      note: null, hasFile: false, dupOfKsefId: null, hostelId: null, vehicleId: null, city: null,
      paymentMethod: method, paymentMethodSource: k.paymentMethod ? "manual" : method ? "auto" : null,
      cashReport: k.cashReport, cleaning: k.segment === "cleaning", cleaningProjectId: k.cleaningProjectId,
      overdue: !paid && !!k.dueDate && k.dueDate < today,
      driveFileId: k.driveFileId, drivePdfId: k.drivePdfId, driveError: k.driveError, addedBy: null, addedAt: null,
      category: kCats.get(k.id)?.cat ?? "other",
      categorySource: kCats.get(k.id)?.manual ? "manual" : "auto",
    });
  }
  for (const l of localRows) {
    const paid = l.manualStatus ? l.manualStatus === "paid" : !l.unpaid;
    const dup = ksefByNum.get(normNumber(l.number))?.find(x => Math.abs(x.gross - l.amount) <= 0.05) ?? null;
    const autoMethod = methodFromText(l.statusRaw);
    const method: PayMethod = (l.paymentMethod as PayMethod) ?? autoMethod;
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
      paymentMethod: method, paymentMethodSource: l.paymentMethod ? "manual" : method ? "auto" : null,
      cashReport: l.cashReport, cleaning: l.cleaning, cleaningProjectId: l.cleaningProjectId,
      overdue: !paid && !!l.dueDate && l.dueDate < today,
      driveFileId: l.driveFileId, drivePdfId: null, driveError: l.driveError,
      addedBy: l.createdBy ? admins.get(l.createdBy) ?? null : null,
      addedAt: l.importedAt ? l.importedAt.toISOString() : null,
      category: lCats.get(l.id)?.cat ?? "other",
      categorySource: lCats.get(l.id)?.manual ? "manual" : "auto",
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
  const sum = (list: CostInvoiceRow[]) => r2(list.reduce((s, r) => s + r.gross, 0));
  const przelew = counted.filter(r => r.paymentMethod === "przelew");
  const gotowka = counted.filter(r => r.paymentMethod === "gotowka");
  const overdue = counted.filter(r => r.overdue);
  ok(res, {
    month, rows,
    cities: ((cityRows.rows ?? cityRows) as any[]).map((r: any) => String(r.c)),
    totals: {
      count: counted.length,
      gross: sum(counted),
      paidGross: sum(counted.filter(r => r.paid)),
      unpaidGross: sum(counted.filter(r => !r.paid)),
      unpaidCount: counted.filter(r => !r.paid).length,
      przelewGross: sum(przelew), przelewCount: przelew.length,
      gotowkaGross: sum(gotowka), gotowkaCount: gotowka.length,
      overdueGross: sum(overdue), overdueCount: overdue.length,
    },
    companies: [...companies.entries()].map(([id, name]) => ({ id, name })),
    // словник категорій — бухгалтерія (cap costInvoices) не має доступу до /bank/categories
    categories: (await getExpenseCats()).map(c => ({ key: c.key, label: c.label, icon: c.icon, color: c.color })),
    ksefSync: await lastSyncStatus(),
  });
});

// KSeF-синк + довантаження архіву на Drive з цієї сторінки (кшєнгова не має /ksef).
// Синк чекаємо (він швидкий, інкрементальний), архів іде у фоні — сторінка
// перечитає стан за хвилину-другу.
router.post("/cost-invoices/sync", async (_req, res) => {
  const sync = await syncKsef();
  // фоновий архів — лише з поточного місяця (минуле власник доганяє кнопкою місяця)
  const fromMonth = todayStr().slice(0, 7);
  setImmediate(() => {
    archiveInvoicesToDrive({ fromMonth }).catch(e => logger.warn({ err: String(e) }, "invoice archive after sync failed"));
  });
  ok(res, { sync, archiveStarted: true });
});

// Підтягнути на Drive ВСІ фактури вибраного місяця (KSeF-закупівлі + продажі +
// скани/ручні), пропускаючи вже залиті (зелені). Синхронно — кнопка чекає з
// прогрес-спінером; місяць обмежений, тож це десятки секунд, не години.
router.post("/cost-invoices/drive-month", async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const r = await archiveInvoicesToDrive({ month });
  if (r.alreadyRunning) return fail(res, 409, "Архів уже виконується у фоні — спробуй за хвилину");
  ok(res, r);
});

// Разовий пуш ОДНІЄЇ фактури на Drive (кнопка-хмарка в рядку) — не чекаючи крону.
// Для KSeF-рядка заодно скачується XML → підтягуються термін оплати і форма оплати.
router.post("/cost-invoices/ksef/:id/drive", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const r = await archiveInvoicesToDrive({ ksefIds: [id], force: true });
  if (r.alreadyRunning) return fail(res, 409, "Архів уже виконується у фоні — спробуй за хвилину");
  if (r.errors.length) return fail(res, 502, r.errors[0]!);
  const [updated] = await db.select().from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  ok(res, { driveFileId: updated?.driveFileId ?? null, driveError: updated?.driveError ?? null, dueDate: updated?.dueDate ?? null });
});

router.post("/cost-invoices/:id/drive", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const r = await archiveInvoicesToDrive({ localIds: [id], force: true, skipKsef: true });
  if (r.alreadyRunning) return fail(res, 409, "Архів уже виконується у фоні — спробуй за хвилину");
  const [updated] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  ok(res, { driveFileId: updated?.driveFileId ?? null, driveError: updated?.driveError ?? null });
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

// ручна категорія витрат (null/"" = повернути на авто)
async function applyExpenseCategory(b: any, patch: Record<string, unknown>): Promise<string | null> {
  if (b.expenseCategory === undefined) return null;
  const v = b.expenseCategory === null || b.expenseCategory === "" ? null : String(b.expenseCategory);
  if (v && !(await validInvoiceCat(v))) return "unknown category";
  patch.manualCategory = v;
  return null;
}

// привʼязка фактури до хостелу (рахунки за оренду/медіа) і cost-center міста
// (P&L по містах) — наша метадата
async function applyHostelId(b: any, patch: Record<string, unknown>): Promise<string | null> {
  if (b.city !== undefined) patch.city = canonCity(b.city);
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

// позначка «видаток прибирання» (розділ /cleaning) + опційна вспульнота.
// Для local-рядків cleaning — власна колонка; для KSeF це segment='cleaning' —
// мапиться у викликах нижче.
async function applyCleaningProject(b: any, patch: Record<string, unknown>): Promise<string | null> {
  if (b.cleaningProjectId === undefined) return null;
  const pid = b.cleaningProjectId ? Number(b.cleaningProjectId) : null;
  if (pid !== null && !Number.isFinite(pid)) return "bad cleaningProjectId";
  if (pid) {
    const [p] = await db.select({ id: cleaningProjectsTable.id }).from(cleaningProjectsTable).where(eq(cleaningProjectsTable.id, pid));
    if (!p) return "unknown cleaning project";
  }
  patch.cleaningProjectId = pid;
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
  if (b.cleaning !== undefined) patch.cleaning = !!b.cleaning;
  const cleaningErr = await applyCleaningProject(b, patch);
  if (cleaningErr) return fail(res, 400, cleaningErr);
  const catErr = await applyExpenseCategory(b, patch);
  if (catErr) return fail(res, 400, catErr);
  const paid = !!b.paid;
  const paidDate = paid ? (validDate(b.paidDate) ? b.paidDate : new Date().toISOString().slice(0, 10)) : null;
  const [row] = await db.insert(invoicesTable).values({
    ...patch as any,
    companyId,
    source: "manual", tabName: "manual", sortIdx: Math.floor(Date.now() / 1000),
    statusRaw: paid ? "Opłacona (панель)" : "Nie oplacona", unpaid: !paid, paidDate,
    createdBy: (req as AuthedRequest).admin?.adminId ?? null,
  }).returning();
  archiveLocalInvoiceLater(row!.id); // файл долетить окремим POST /:id/file — той перезалиє
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
  // позначка «на прибирання» + вспульнота (розділ /cleaning)
  if (b.cleaning !== undefined) patch.cleaning = !!b.cleaning;
  {
    const cleaningErr = await applyCleaningProject(b, patch);
    if (cleaningErr) return fail(res, 400, cleaningErr);
  }
  {
    const catErr = await applyExpenseCategory(b, patch);
    if (catErr) return fail(res, 400, catErr);
  }
  // спосіб оплати (переказ/готівка/назад на авто) і «рапорт готівковий» — кшєнгова
  if (b.paymentMethod !== undefined) {
    if (!validMethod(b.paymentMethod)) return fail(res, 400, "paymentMethod: przelew | gotowka | null");
    patch.paymentMethod = b.paymentMethod;
  }
  if (b.cashReport !== undefined) patch.cashReport = !!b.cashReport;
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
  // зміна реквізитів, що визначають місце/імʼя файла в архіві → старий файл у
  // кошик, рядок перезаливається у фоні
  const identityChanged =
    (patch.number !== undefined && patch.number !== row.number) ||
    (patch.issueDate !== undefined && patch.issueDate !== row.issueDate) ||
    (patch.companyId !== undefined && patch.companyId !== row.companyId);
  if (identityChanged && row.driveFileId) {
    await retireDriveFile(row.driveFileId);
    patch.driveFileId = null; patch.driveError = null; patch.driveSyncedAt = null;
  }
  const [updated] = await db.update(invoicesTable).set(patch).where(eq(invoicesTable.id, id)).returning();
  if (identityChanged) archiveLocalInvoiceLater(id);
  ok(res, updated);
});

// KSeF-рядок з цієї ж сторінки (дзеркало PATCH /ksef/invoices/:id, але під гейтом
// costInvoices — бухгалтерія не має доступу до /ksef): оплата + спосіб оплати +
// «рапорт готівковий» + термін оплати (виправлення, якщо XML не мав/мав хибний)
router.patch("/cost-invoices/ksef/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [inv] = await db.select().from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  if (!inv) return fail(res, 404, "not found");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.paid !== undefined) {
    const autoPaid = inv.paidDate != null;
    if (Boolean(b.paid) === autoPaid) { patch.manualStatus = null; patch.manualPaidDate = null; }
    else { patch.manualStatus = b.paid ? "paid" : "unpaid"; patch.manualPaidDate = b.paid && validDate(b.paidDate) ? b.paidDate : null; }
  }
  if (b.paymentMethod !== undefined) {
    if (!validMethod(b.paymentMethod)) return fail(res, 400, "paymentMethod: przelew | gotowka | null");
    patch.paymentMethod = b.paymentMethod;
  }
  if (b.cashReport !== undefined) patch.cashReport = !!b.cashReport;
  // позначка «на прибирання»: для KSeF-рядка це segment (закупівля main → cleaning)
  if (b.cleaning !== undefined) patch.segment = b.cleaning ? "cleaning" : "main";
  {
    const cleaningErr = await applyCleaningProject(b, patch);
    if (cleaningErr) return fail(res, 400, cleaningErr);
  }
  {
    const catErr = await applyExpenseCategory(b, patch);
    if (catErr) return fail(res, 400, catErr);
  }
  if (b.dueDate !== undefined) {
    if (b.dueDate !== null && !validDate(b.dueDate)) return fail(res, 400, "dueDate: YYYY-MM-DD");
    patch.dueDate = b.dueDate;
  }
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(ksefInvoicesTable).set(patch).where(eq(ksefInvoicesTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/cost-invoices/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (row.source !== "manual" && row.source !== "scan") return fail(res, 400, "sheet-рядки не видаляються звідси");
  deleteStoredFile(row.filePath);
  await retireDriveFile(row.driveFileId); // архівна копія — у кошик Drive
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
  // новий файл = нова архівна копія: стару — в кошик, перезалив у фоні
  await retireDriveFile(row.driveFileId);
  await db.update(invoicesTable).set({ filePath: rel, driveFileId: null, driveError: null, driveSyncedAt: null }).where(eq(invoicesTable.id, id));
  archiveLocalInvoiceLater(id);
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
  archiveLocalInvoiceLater(row!.id); // скан одразу їде в архів на Drive
  return row!.id;
}
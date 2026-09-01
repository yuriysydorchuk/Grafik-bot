// «Умови» (агрименти/договори) — окрема від разових фактур /cost-invoices
// сутність: одноразові/на термін/безстрокові зобов'язання, що щомісяця самі
// генерують запис-витрату (agreement_charges), видимий на /cost-invoices поруч
// із фактурами. Доступ — той самий, що й у cost-invoices (роль «бухгалтерія»).
import { Router, type IRouter } from "express";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { db, agreementConditionsTable, agreementChargesTable, companiesTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { authRequired, requireAnyCap, type AuthedRequest } from "../lib/auth";
import { UPLOADS_ROOT, AGREEMENTS_DIR, sniffDocMime, makeStoredName, deleteStoredFile } from "../lib/uploads";
import { archiveAgreementLater, retireAgreementDriveFile } from "../services/agreementArchive";
import { logAgreementAudit, agreementAuditDiff, agreementAuditRows, type AgreementEntity } from "../services/agreementAudit";
import { VAT_RATES, currentMonthStr, backfillCondition, materializeMonth, materializeAgreementMonth, materializeSelectedMonths } from "../services/agreementConditions";
import { getExpenseCats } from "../services/bankClassify";
import { canonCity } from "../services/svodniSync";

const router: IRouter = Router();
router.use(authRequired);
router.use("/agreements", requireAnyCap("viewFinance", "costInvoices"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validMonth = (s: any) => typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
const KIND = new Set(["one_time", "fixed_term", "indefinite"]);

async function validCategory(v: string): Promise<boolean> {
  if (v === "other") return true;
  return (await getExpenseCats()).some(c => c.key === v);
}

// «Назва» умови в списку — не вільний текст, а «тип (за що) + контрагент»,
// щоб не дублювати сенс категорії ручним написом (вимога 31.08.2026)
async function categoryLabel(key: string): Promise<string> {
  if (key === "other") return "Інше";
  return (await getExpenseCats()).find(c => c.key === key)?.label ?? key;
}
async function composeTitle(category: string, counterparty: string | null): Promise<string> {
  const label = await categoryLabel(category);
  return counterparty ? `${label} · ${counterparty}` : label;
}

function computedStatus(row: { active: boolean; startMonth: string; endMonth: string | null }): "deleted" | "scheduled" | "ended" | "active" {
  if (!row.active) return "deleted";
  const now = currentMonthStr();
  if (row.startMonth > now) return "scheduled";
  if (row.endMonth != null && row.endMonth < now) return "ended";
  return "active";
}

router.get("/agreements", async (req, res) => {
  const companyId = Number(req.query.companyId) || null;
  const conds = companyId ? [eq(agreementConditionsTable.companyId, companyId)] : [];
  const rows = await db.select().from(agreementConditionsTable).where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(agreementConditionsTable.id));
  const companies = new Map((await db.select().from(companiesTable)).map(c => [c.id, c.name]));
  ok(res, {
    rows: rows.map(r => ({ ...r, firm: companies.get(r.companyId) ?? null, hasFile: !!r.filePath, status: computedStatus(r) })),
    companies: [...companies.entries()].map(([id, name]) => ({ id, name })),
    categories: await getExpenseCats(),
  });
});

router.post("/agreements", async (req, res) => {
  const b = req.body ?? {};
  const companyId = Number(b.companyId);
  if (!companyId) return fail(res, 400, "companyId required");
  const [co] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!co) return fail(res, 400, "unknown company");
  const kind = String(b.kind ?? "");
  if (!KIND.has(kind)) return fail(res, 400, "kind: one_time | fixed_term | indefinite");
  const category = String(b.category ?? "");
  if (!category || !(await validCategory(category))) return fail(res, 400, "unknown category");
  const counterparty = b.counterparty ? String(b.counterparty).trim() : null;
  const title = await composeTitle(category, counterparty);
  // сума завжди брутто (кшєнгова вписує суму з документа як є) — vatRate лише
  // інформаційний тег ставки, жодного розрахунку net→gross нема
  const amount = Number(String(b.amount ?? "").replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, "amount > 0");
  const vatRate = b.vatRate === undefined ? "23" : String(b.vatRate);
  if (!VAT_RATES.includes(vatRate as any)) return fail(res, 400, "vatRate: 23 | 8 | zw");
  if (!validMonth(b.startMonth)) return fail(res, 400, "startMonth: YYYY-MM");
  const startMonth = String(b.startMonth);
  let endMonth: string | null;
  if (kind === "one_time") endMonth = startMonth;
  else if (kind === "fixed_term") {
    if (!validMonth(b.endMonth)) return fail(res, 400, "endMonth: YYYY-MM (обов'язково для терміну)");
    if (String(b.endMonth) < startMonth) return fail(res, 400, "endMonth раніше startMonth");
    endMonth = String(b.endMonth);
  } else endMonth = null; // indefinite

  const [row] = await db.insert(agreementConditionsTable).values({
    companyId, title, counterparty,
    category, kind, amount, vatRate,
    city: b.city !== undefined ? canonCity(b.city) : null,
    startMonth, endMonth,
    note: b.note ? String(b.note).trim() : null,
    createdBy: (req as AuthedRequest).admin?.adminId ?? null,
  }).returning();
  // заднім числом кшєнгова обирає, які саме минулі місяці зарахувати
  // (backfillMonths з піка на сайті) — без цього поля лишається старий
  // автоматичний повний бекфіл (прямі виклики API, one_time тощо)
  const created = Array.isArray(b.backfillMonths)
    ? await materializeSelectedMonths(row!, b.backfillMonths.filter((m: unknown) => validMonth(m)).map(String))
    : await backfillCondition(row!);
  const adm = (req as AuthedRequest).admin;
  await logAgreementAudit("condition", row!.id, "created", { adminId: adm?.adminId, name: adm?.name });
  ok(res, { ...row, status: computedStatus(row!), chargesCreated: created });
});

router.patch("/agreements/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(agreementConditionsTable).where(eq(agreementConditionsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (!row.active) return fail(res, 400, "умова видалена");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.counterparty !== undefined) patch.counterparty = b.counterparty ? String(b.counterparty).trim() : null;
  if (b.category !== undefined) {
    const v = String(b.category ?? "");
    if (!v || !(await validCategory(v))) return fail(res, 400, "unknown category");
    patch.category = v;
  }
  // «Назва» — похідна від категорії+контрагента, перераховується при зміні будь-якого з них
  if (b.category !== undefined || b.counterparty !== undefined) {
    const category = (patch.category as string | undefined) ?? row.category;
    const counterparty = b.counterparty !== undefined ? (patch.counterparty as string | null) : row.counterparty;
    patch.title = await composeTitle(category, counterparty);
  }
  if (b.city !== undefined) patch.city = canonCity(b.city);
  if (b.note !== undefined) patch.note = b.note ? String(b.note).trim() : null;

  if (b.amount !== undefined) {
    const amount = Number(String(b.amount).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, "amount > 0");
    patch.amount = amount;
  }
  if (b.vatRate !== undefined) {
    const vatRate = String(b.vatRate);
    if (!VAT_RATES.includes(vatRate as any)) return fail(res, 400, "vatRate: 23 | 8 | zw");
    patch.vatRate = vatRate;
  }

  // endMonth — дострокове завершення (у минуле) або продовження (у майбутнє);
  // one_time завжди дорівнює startMonth, тут не редагується
  if (b.endMonth !== undefined && row.kind !== "one_time") {
    if (row.kind === "fixed_term" && !validMonth(b.endMonth)) return fail(res, 400, "endMonth: YYYY-MM");
    if (b.endMonth && String(b.endMonth) < row.startMonth) return fail(res, 400, "endMonth раніше startMonth");
    patch.endMonth = row.kind === "indefinite" ? (b.endMonth ? String(b.endMonth) : null) : String(b.endMonth);
  }
  patch.updatedAt = new Date();

  const [updated] = await db.update(agreementConditionsTable).set(patch).where(eq(agreementConditionsTable.id, id)).returning();
  // продовження строку вперед — догенерувати нові місяці одразу
  if (typeof patch.endMonth === "string" && (row.endMonth == null || patch.endMonth > row.endMonth)) {
    await backfillCondition(updated!);
  }
  const adm = (req as AuthedRequest).admin;
  const diff = agreementAuditDiff(row as any, patch);
  if (diff.length) await logAgreementAudit("condition", id, "updated", { adminId: adm?.adminId, name: adm?.name }, diff);
  ok(res, { ...updated, status: computedStatus(updated!) });
});

router.delete("/agreements/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(agreementConditionsTable).where(eq(agreementConditionsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  await db.update(agreementConditionsTable).set({ active: false, updatedAt: new Date() }).where(eq(agreementConditionsTable.id, id));
  const adm = (req as AuthedRequest).admin;
  await logAgreementAudit("condition", id, "deleted", { adminId: adm?.adminId, name: adm?.name },
    [{ field: "title", from: row.title, to: null }]);
  ok(res, { ok: true });
});

router.get("/agreements/audit", async (req, res) => {
  const entity: AgreementEntity = req.query.entity === "charge" ? "charge" : "condition";
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  ok(res, { entries: await agreementAuditRows(entity, id) });
});

router.post("/agreements/generate", async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : currentMonthStr();
  ok(res, await materializeMonth(month));
});

// Точковий бекфіл ОДНІЄЇ умови за конкретний місяць — коли на створенні кшєнгова
// свідомо зняла місяць з піка, а пізніше вирішила таки його зарахувати.
router.post("/agreements/:id/generate", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(agreementConditionsTable).where(eq(agreementConditionsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const month = validMonth(req.body?.month) ? String(req.body.month) : currentMonthStr();
  ok(res, await materializeAgreementMonth(row, month));
});

// ── Файл (скан умови) ───────────────────────────────────────────────────────
const uploadScan = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post("/agreements/:id/file", uploadScan.single("file"), async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(agreementConditionsTable).where(eq(agreementConditionsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (!req.file) return fail(res, 400, "Файл не отримано");
  const mime = sniffDocMime(req.file.buffer);
  if (!mime || mime.includes("msword") || mime.includes("wordprocessing")) return fail(res, 400, "Дозволені PDF або фото");
  const stored = makeStoredName(req.file.originalname || "umowa");
  fs.writeFileSync(path.join(AGREEMENTS_DIR, stored), req.file.buffer);
  deleteStoredFile(row.filePath);
  const rel = path.join("agreements", stored);
  await retireAgreementDriveFile(row.driveFileId);
  await db.update(agreementConditionsTable).set({ filePath: rel, driveFileId: null, driveError: null, updatedAt: new Date() }).where(eq(agreementConditionsTable.id, id));
  const adm = (req as AuthedRequest).admin;
  await logAgreementAudit("condition", id, "file", { adminId: adm?.adminId, name: adm?.name });
  archiveAgreementLater(id);
  ok(res, { ok: true, filePath: rel });
});

router.get("/agreements/:id/file", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(agreementConditionsTable).where(eq(agreementConditionsTable.id, id));
  if (!row?.filePath) return fail(res, 404, "no file");
  const abs = path.resolve(UPLOADS_ROOT, row.filePath);
  if (!abs.startsWith(UPLOADS_ROOT) || !fs.existsSync(abs)) return fail(res, 404, "no file");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const ext = path.extname(abs).toLowerCase();
  const byExt: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
  const mime = sniffDocMime(fs.readFileSync(abs)) ?? byExt[ext] ?? "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `inline; filename="umowa-${id}${ext || ""}"`);
  fs.createReadStream(abs).pipe(res);
});

// ── Місячні записи-витрати (agreement_charges) ─────────────────────────────────
router.patch("/agreements/charges/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(agreementChargesTable).where(eq(agreementChargesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (row.status === "deleted") return fail(res, 400, "запис видалено");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = { source: "manual-edit", createdBy: (req as AuthedRequest).admin?.adminId ?? null, updatedAt: new Date() };
  if (b.amount !== undefined) {
    const a = Number(String(b.amount).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(a) || a <= 0) return fail(res, 400, "amount > 0");
    patch.amount = a;
  }
  if (b.note !== undefined) patch.note = b.note ? String(b.note).trim() : null;
  const [updated] = await db.update(agreementChargesTable).set(patch).where(eq(agreementChargesTable.id, id)).returning();
  const adm = (req as AuthedRequest).admin;
  const diff = agreementAuditDiff(row as any, patch);
  if (diff.length) await logAgreementAudit("charge", id, "updated", { adminId: adm?.adminId, name: adm?.name }, diff);
  ok(res, updated);
});

router.delete("/agreements/charges/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(agreementChargesTable).where(eq(agreementChargesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  await db.update(agreementChargesTable).set({ status: "deleted", updatedAt: new Date() }).where(eq(agreementChargesTable.id, id));
  const adm = (req as AuthedRequest).admin;
  await logAgreementAudit("charge", id, "deleted", { adminId: adm?.adminId, name: adm?.name },
    [{ field: "month", from: row.month, to: null }]);
  ok(res, { ok: true });
});

export default router;

// Експорт даних працівників (28.10.2026): Excel-список, CSV/XLSX для Gratyfikant nexo, ZIP
// документів по папках Firma/Fabryka/Pracownik — спільні фільтри (services/workerExport.ts).
// Гейти: список/CSV — editData|viewWorkers|workerDocs|legalization (персональні дані анкети —
// як у профілі для цих ролей); ZIP файлів — editData|workerDocs|legalization. Скоуп-адмін —
// SCOPE_RULES «free» + workerInScopeSql у завантаженні.
import { Router, type IRouter } from "express";
import { authRequired, requireAnyCap, requireCap, type AuthedRequest } from "../lib/auth";
import { hasCap } from "../lib/roles";
import { parseExportFilters, loadExportRows, buildWorkersXlsx, buildGratyfikantCsv, buildGratyfikantXlsx, countDocsForZip, streamDocsZip, DEFAULT_XLSX_COLS, allowedFields, resolveCols, renderCells, parseCondSpec, applyCondSpec, OPS_BY_TYPE } from "../services/workerExport";
import { warsawToday as warsawDateStr } from "../services/taskUtils";
import type { AdminScope } from "../lib/scope";

const router: IRouter = Router();
router.use("/workers/export", authRequired);
const LIST = requireAnyCap("editData", "viewWorkers", "workerDocs", "legalization");
const FILES = requireAnyCap("editData", "workerDocs", "legalization");
// анкетні поля (PESEL, адреса, рахунок, телефон…) — лише cap workerDocs, як GET /workers/:id/questionnaire;
// без неї каталог/колонки/умови їх не містять, CSV для Gratyfikant (увесь з анкети) — 403
const canAnketa = (req: AuthedRequest) => hasCap(req.admin?.role, req.admin?.caps, "workerDocs");

const zipOpts = (q: Record<string, unknown>, scope?: AdminScope | null) => ({
  docTypeIds: String(q.docTypeIds ?? "").split(",").map(Number).filter(n => Number.isInteger(n) && n > 0),
  includeContracts: q.contracts === "1" || q.contracts === "true",
  scope: scope ?? null,
});
const stamp = () => warsawDateStr().replace(/-/g, "");

const colKeys = (q: Record<string, unknown>) => typeof q.cols === "string" && q.cols ? String(q.cols).split(",").map(s => s.trim()).filter(Boolean) : undefined;

// Усі рядки під фільтри: швидкі (query) + конструктор умов (f=JSON {or:[{and:[{k,op,v}]}]})
async function loadFiltered(req: { query: Record<string, unknown> } & Partial<AuthedRequest>) {
  const rows = await loadExportRows(parseExportFilters(req.query), (req as AuthedRequest).admin?.scope);
  return applyCondSpec(rows, parseCondSpec(req.query.f), canAnketa(req as AuthedRequest));
}

// Каталог полів (колонки Excel/списку і поля умов): тип, оператори, варіанти, підписи
router.get("/workers/export/fields", LIST, async (_req, res) => {
  const ok = canAnketa(_req as AuthedRequest);
  const fields = (await allowedFields(ok)).map(f => ({ key: f.key, header: f.header, label: f.label, group: f.group, type: f.type, options: f.options }));
  const keys = new Set(fields.map(f => f.key));
  res.json({ fields, defaults: DEFAULT_XLSX_COLS.filter(k => keys.has(k)), ops: OPS_BY_TYPE, canAnketa: ok });
});

// Превʼю: скільки людей під фільтри + перші 200 рядків у вибраних колонках (+ скільки файлів піде в ZIP)
router.get("/workers/export/preview", LIST, async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const rows = await loadFiltered(req as any);
  const files = await countDocsForZip(rows, zipOpts(q, (req as AuthedRequest).admin?.scope));
  const cols = await resolveCols(colKeys(q), canAnketa(req as AuthedRequest));
  const limit = Math.max(1, Math.min(500, Number(q.limit) || 200));
  res.json({ count: rows.length, ...files, columns: cols.map(c => ({ key: c.key, header: c.header, label: c.label })), rows: renderCells(rows.slice(0, limit), cols), ids: rows.slice(0, limit).map(r => r.id) });
});

router.get("/workers/export/xlsx", LIST, async (req, res) => {
  const rows = await loadFiltered(req as any);
  const buffer = await buildWorkersXlsx(rows, colKeys(req.query as Record<string, unknown>), canAnketa(req as AuthedRequest));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`Pracownicy ${stamp()}.xlsx`)}"`);
  res.send(buffer);
});

// format=xlsx — ті самі колонки аркушем (як зразок księgowej), типово CSV («;», UTF-8 BOM)
router.get("/workers/export/csv", requireCap("workerDocs"), async (req, res) => {
  const rows = await loadFiltered(req as any);
  if (req.query.format === "xlsx") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`Gratyfikant pracownicy ${stamp()}.xlsx`)}"`);
    res.send(await buildGratyfikantXlsx(rows));
    return;
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`Gratyfikant pracownicy ${stamp()}.csv`)}"`);
  res.send(buildGratyfikantCsv(rows));
});

router.get("/workers/export/docs.zip", FILES, async (req, res) => {
  const rows = await loadFiltered(req as any);
  await streamDocsZip(rows, zipOpts(req.query as Record<string, unknown>, (req as AuthedRequest).admin?.scope), res, `Dokumenty pracownikow ${stamp()}.zip`);
});

export default router;

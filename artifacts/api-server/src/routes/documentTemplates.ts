// Бібліотека шаблонів документів (§2.2/§10 плану worker-docs-signing, cap
// workerDocs): CRUD + автопереклад + клонування «стандартного» шаблону.
// Прив'язка до фабрик/компаній редагується прямо тут (поле scope на самому
// шаблоні), не на сторінці фабрики.
import { Router, type IRouter } from "express";
import { db, documentTemplatesTable, type DocumentTemplate } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import { extractPlaceholderKeys, renderTemplatePreview } from "../services/contracts";
import { translateHtml, translateConfigured, sha256 } from "../services/docTranslate";

const router: IRouter = Router();
router.use(authRequired);
const WD = requireCap("workerDocs");

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });

const KINDS = [
  "umowa", "regulamin", "zus", "tax", "ppk", "bhp",
  "wniosek_konto", "wniosek_reka", "wniosek_zaliczki", "andros_extra", "sprzatanie_umowa", "custom",
] as const;
const SCOPES = ["all", "company", "factory"] as const;
const LANGS = ["pl", "en", "es", "ru", "uk"] as const;

router.get("/document-templates", WD, async (req, res) => {
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const rows = await db.select().from(documentTemplatesTable)
    .where(kind ? eq(documentTemplatesTable.kind, kind) : undefined)
    .orderBy(desc(documentTemplatesTable.id));
  ok(res, rows.map(withPlaceholders));
});

router.get("/document-templates/placeholders", WD, async (_req, res) => {
  // Довідник для палітри редактора: усі плейсхолдери, що реально трапляються
  // в бібліотеці — щоб адмін бачив, чим система вже вміє наповнювати документ.
  const rows = await db.select({ body: documentTemplatesTable.body }).from(documentTemplatesTable);
  const keys = new Set<string>();
  for (const r of rows) for (const lang of LANGS) {
    const html = (r.body as Record<string, string>)[lang];
    if (html) for (const k of extractPlaceholderKeys(html)) keys.add(k);
  }
  ok(res, [...keys].sort());
});

// Прев'ю ФІНАЛЬНОГО вигляду (реальний Puppeteer-рендер) — для ще незбереженого
// чорновика тексту редактора, тому приймає html напряму, а не id. Плейсхолдери
// підсвічені своїми назвами (не демо-даними) — прев'ю верстки, не фейкового тексту.
router.post("/document-templates/preview", WD, async (req, res) => {
  const html = req.body?.html;
  if (typeof html !== "string" || !html.trim()) return fail(res, 400, "Потрібне html-тіло для прев'ю");
  try {
    const pdf = await renderTemplatePreview(html);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  } catch (e: any) {
    fail(res, 500, e?.message ?? "Не вдалося згенерувати прев'ю");
  }
});

router.get("/document-templates/:id", WD, async (req, res) => {
  const [row] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, Number(req.params.id)));
  if (!row) return fail(res, 404, "Шаблон не знайдено");
  ok(res, withPlaceholders(row));
});

function withPlaceholders(row: DocumentTemplate) {
  const body = row.body as Record<string, string>;
  return { ...row, placeholders: extractPlaceholderKeys(body.pl ?? Object.values(body)[0] ?? "") };
}

function validateScope(body: any): string | null {
  if (!KINDS.includes(body.kind)) return `kind має бути одним з: ${KINDS.join(", ")}`;
  if (!SCOPES.includes(body.scope)) return `scope має бути одним з: ${SCOPES.join(", ")}`;
  if (body.scope === "company" && !Array.isArray(body.scopeCompanyIds)) return "scopeCompanyIds обов'язковий при scope=company";
  if (body.scope === "factory" && !Array.isArray(body.scopeFactoryIds)) return "scopeFactoryIds обов'язковий при scope=factory";
  return null;
}

router.post("/document-templates", WD, async (req: AuthedRequest, res) => {
  const b = req.body ?? {};
  const err = validateScope(b);
  if (err) return fail(res, 400, err);
  if (!b.title?.trim()) return fail(res, 400, "Потрібна назва (title)");
  if (!b.body?.pl?.trim()) return fail(res, 400, "Потрібне тіло польською (body.pl)");
  const [row] = await db.insert(documentTemplatesTable).values({
    kind: b.kind, title: String(b.title).trim(), isBase: !!b.isBase, scope: b.scope,
    scopeCompanyIds: b.scopeCompanyIds ?? [], scopeFactoryIds: b.scopeFactoryIds ?? [],
    positionId: b.positionId ?? null, body: b.body,
    createdBy: req.admin?.adminId ?? null, updatedBy: req.admin?.adminId ?? null,
  }).returning();
  ok(res, withPlaceholders(row!));
});

// Клон — джерело body копіюється 1:1, isBase скидається (клон не стає новим
// стандартом сам по собі), scope теж скидається на "factory"+[] — новий
// шаблон навмисно нікуди не прив'язаний, поки адмін сам не вкаже де.
router.post("/document-templates/:id/clone", WD, async (req: AuthedRequest, res) => {
  const [src] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, Number(req.params.id)));
  if (!src) return fail(res, 404, "Шаблон не знайдено");
  const title = req.body?.title?.trim() || `${src.title} (копія)`;
  const [row] = await db.insert(documentTemplatesTable).values({
    kind: src.kind, title, isBase: false, scope: "factory", scopeCompanyIds: [], scopeFactoryIds: [],
    positionId: src.positionId, body: src.body,
    createdBy: req.admin?.adminId ?? null, updatedBy: req.admin?.adminId ?? null,
  }).returning();
  ok(res, withPlaceholders(row!));
});

router.put("/document-templates/:id", WD, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, id));
  if (!existing) return fail(res, 404, "Шаблон не знайдено");
  const b = req.body ?? {};
  const err = validateScope({ ...existing, ...b });
  if (err) return fail(res, 400, err);

  const patch: Record<string, unknown> = { updatedAt: new Date(), updatedBy: req.admin?.adminId ?? null };
  if (b.title !== undefined) patch.title = String(b.title).trim();
  if (b.isBase !== undefined) patch.isBase = !!b.isBase;
  if (b.isActive !== undefined) patch.isActive = !!b.isActive;
  if (b.scope !== undefined) patch.scope = b.scope;
  if (b.scopeCompanyIds !== undefined) patch.scopeCompanyIds = b.scopeCompanyIds;
  if (b.scopeFactoryIds !== undefined) patch.scopeFactoryIds = b.scopeFactoryIds;
  if (b.positionId !== undefined) patch.positionId = b.positionId;

  // Редагування тіла: PL завжди можна правити; інша мова — лише якщо явно
  // позначена вручну (langIsManual), інакше це поле для автоперекладу.
  if (b.body !== undefined) {
    const body = { ...(existing.body as Record<string, string>) };
    const langIsManual = { ...(existing.langIsManual as Record<string, boolean>) };
    for (const lang of LANGS) {
      if (b.body[lang] === undefined) continue;
      body[lang] = b.body[lang];
      if (lang !== "pl") langIsManual[lang] = true; // ручна правка — більше не чіпаємо автоперекладом
    }
    patch.body = body;
    patch.langIsManual = langIsManual;
  }

  const [row] = await db.update(documentTemplatesTable).set(patch).where(eq(documentTemplatesTable.id, id)).returning();
  ok(res, withPlaceholders(row!));
});

router.delete("/document-templates/:id", WD, async (req, res) => {
  await db.delete(documentTemplatesTable).where(eq(documentTemplatesTable.id, Number(req.params.id)));
  ok(res, { deleted: true });
});

// Перекладає PL-тіло на решту мов (окрім позначених langIsManual), пише
// lang_source_hash — при повторному save() без зміни PL повторний переклад
// не запускається даремно (веб сам вирішує, коли викликати цей ендпоінт).
router.post("/document-templates/:id/translate", WD, async (req: AuthedRequest, res) => {
  if (!translateConfigured()) return fail(res, 501, "Автопереклад не налаштований на цьому сервері (GOOGLE_DOCAI_KEY_FILE)");
  const id = Number(req.params.id);
  const [row] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, id));
  if (!row) return fail(res, 404, "Шаблон не знайдено");
  const plHtml = (row.body as Record<string, string>).pl;
  if (!plHtml) return fail(res, 400, "Немає PL-тексту для перекладу");

  const force = !!req.body?.force; // «перекласти заново» — скидає langIsManual для обраної мови
  const only = Array.isArray(req.body?.langs) ? req.body.langs as string[] : ["en", "es", "ru", "uk"];
  const langIsManual = { ...(row.langIsManual as Record<string, boolean>) };
  const langSourceHash = { ...(row.langSourceHash as Record<string, string>) };
  const body = { ...(row.body as Record<string, string>) };
  const plHash = sha256(plHtml);

  const translated: string[] = [];
  for (const lang of only) {
    if (lang === "pl") continue;
    if (!force && langIsManual[lang]) continue; // ручна правка — не перезаписуємо мовчки
    if (!force && langSourceHash[lang] === plHash) continue; // PL відтоді не змінювався
    try {
      body[lang] = await translateHtml(plHtml, lang as "en" | "es" | "ru" | "uk");
      langSourceHash[lang] = plHash;
      langIsManual[lang] = false;
      translated.push(lang);
    } catch (e: any) {
      return fail(res, 502, e?.message ?? `Не вдалося перекласти на ${lang}`);
    }
  }

  const [updated] = await db.update(documentTemplatesTable)
    .set({ body, langIsManual, langSourceHash, updatedAt: new Date(), updatedBy: req.admin?.adminId ?? null })
    .where(eq(documentTemplatesTable.id, id)).returning();
  ok(res, { ...withPlaceholders(updated!), translated });
});

export default router;

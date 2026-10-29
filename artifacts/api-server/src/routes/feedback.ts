// Зголошення проблем і побажань з панелі (docs/tasks/2026-10-29-feedback-module.md).
// Створити / «мої» / по сторінці / голос / коментар / підтвердження — кожен залогінений
// (readOnly: префікс /feedback у READ_ONLY_ALLOWED_PREFIXES; скоуп: правило «free» у SCOPE_RULES).
// Усе адмінське — під префіксом /feedback/admin з requireMainAdmin (гейт по префіксу,
// не голий router.use — див. правило про роутери в CLAUDE.md).
import { Router, type IRouter } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { db, adminsTable, feedbackReportsTable, feedbackAttachmentsTable, feedbackCommentsTable, feedbackVotesTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { authRequired, requireMainAdmin, type AuthedRequest } from "../lib/auth";
import { FEEDBACK_DIR, sniffDocMime, compressUploadImage, makeStoredName } from "../lib/uploads";
import {
  createReport, loadReport, setStatus, replyToAuthor, authorComment, authorConfirm, toggleVote, similar, counters,
  createTaskFromReport, buildPack, applyTriageResult, loadFeedbackSettings, saveFeedbackSettings, extOf, unreadSql, packWarnings, packWarningsFor, isDuplicateAuthor,
  OPEN_STATUSES, STATUSES, KINDS, SEVERITIES, type FeedbackStatus, type CreateFeedbackInput,
} from "../services/feedback";

const router: IRouter = Router();
router.use("/feedback", authRequired);
router.use("/feedback/admin", requireMainAdmin);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });
const me = (req: AuthedRequest) => req.admin!.adminId;
const isMain = (req: AuthedRequest) => !!req.admin?.isMain;
// Чи бачить роль сторінку (дзеркало canAccessPage у вебі): головний/owner — усе; інакше — pages ролі.
// Зголошення по сторінках, яких роль не бачить, їй не показуються (витік фінансових заголовків).
const pageAllowed = (req: AuthedRequest, p: string | null) => !p || isMain(req) || req.admin!.role === "owner" || req.admin!.pages.includes(p) || req.admin!.pages.some(x => x !== "/" && p.startsWith(x + "/"));

const MIME_OK = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 6 } });

const votesSql = sql<number>`(select count(*)::int from feedback_votes v where v.report_id = ${feedbackReportsTable.id})`;
const votedSql = (adminId: number) => sql<boolean>`exists (select 1 from feedback_votes v where v.report_id = ${feedbackReportsTable.id} and v.admin_id = ${adminId})`;
const attCountSql = sql<number>`(select count(*)::int from feedback_attachments a where a.report_id = ${feedbackReportsTable.id})`;
const commentsCountSql = sql<number>`(select count(*)::int from feedback_comments c where c.report_id = ${feedbackReportsTable.id} and c.kind <> 'system')`;

// ── для всіх ролей ──────────────────────────────────────────────────────────
router.get("/feedback/mine", async (req: AuthedRequest, res) => {
  const rows = await db.select({
    id: feedbackReportsTable.id, kind: feedbackReportsTable.kind, severity: feedbackReportsTable.severity, status: feedbackReportsTable.status,
    title: feedbackReportsTable.title, pagePath: feedbackReportsTable.pagePath, pageLabel: feedbackReportsTable.pageLabel,
    reply: feedbackReportsTable.reply, createdAt: feedbackReportsTable.createdAt, updatedAt: feedbackReportsTable.updatedAt,
    duplicateOfId: feedbackReportsTable.duplicateOfId, unread: unreadSql, votes: votesSql,
    lastQuestion: sql<string | null>`(select body from feedback_comments c where c.report_id = ${feedbackReportsTable.id} and c.kind = 'question' order by c.id desc limit 1)`,
  }).from(feedbackReportsTable).where(eq(feedbackReportsTable.authorAdminId, me(req))).orderBy(desc(feedbackReportsTable.id)).limit(100);
  const s = await loadFeedbackSettings();
  ok(res, { reports: rows, unread: rows.filter(r => r.unread).length, widgetOff: !isMain(req) && s.widgetOffRoles.includes(req.admin!.role) });
});
router.post("/feedback/mine/seen", async (req: AuthedRequest, res) => {
  await db.update(feedbackReportsTable).set({ authorSeenAt: new Date() }).where(eq(feedbackReportsTable.authorAdminId, me(req)));
  ok(res, { ok: true });
});

// Відкриті по сторінці від усіх (для «у мене теж») — без вкладень і контексту.
router.get("/feedback/page", async (req: AuthedRequest, res) => {
  const p = String(req.query.path ?? "").trim();
  if (!p || !pageAllowed(req, p)) return ok(res, []);
  const rows = await db.select({
    id: feedbackReportsTable.id, kind: feedbackReportsTable.kind, severity: feedbackReportsTable.severity, status: feedbackReportsTable.status,
    title: feedbackReportsTable.title, createdAt: feedbackReportsTable.createdAt, votes: votesSql, voted: votedSql(me(req)),
    mine: sql<boolean>`${feedbackReportsTable.authorAdminId} = ${me(req)}`,
  }).from(feedbackReportsTable).where(and(eq(feedbackReportsTable.pagePath, p), inArray(feedbackReportsTable.status, OPEN_STATUSES)))
    .orderBy(desc(feedbackReportsTable.id)).limit(30);
  ok(res, rows);
});

router.get("/feedback/similar", async (req: AuthedRequest, res) => {
  const s = await loadFeedbackSettings();
  if (!s.dedupHint) return ok(res, []);
  const q = String(req.query.q ?? "").trim();
  if (q.length < 8) return ok(res, []);
  ok(res, await similar(String(req.query.path ?? "") || null, q, me(req), p => pageAllowed(req, p)));
});

router.post("/feedback", async (req: AuthedRequest, res) => {
  const b = (req.body ?? {}) as Partial<CreateFeedbackInput>;
  const description = String(b.description ?? "").trim();
  if (!b.kind || !KINDS.includes(b.kind)) return fail(res, 400, "Вкажіть тип зголошення");
  if (description.length < 5 && b.origin === "widget") return fail(res, 400, "Опишіть, будь ласка, детальніше (мінімум кілька слів)");
  if (b.kind === "bug" && b.severity && !SEVERITIES.includes(b.severity)) return fail(res, 400, "Невідома вага");
  const r = await createReport({
    kind: b.kind, severity: b.severity ?? null,
    description: description || (b.clientError?.message ? `Помилка: ${b.clientError.message}` : "—"),
    steps: b.steps ?? null, expected: b.expected ?? null,
    aboutPage: b.aboutPage !== false, pagePath: b.pagePath ?? null, pageLabel: b.pageLabel ?? null, pageUrl: b.pageUrl ?? null,
    pageFilters: b.pageFilters && typeof b.pageFilters === "object" ? b.pageFilters : null,
    origin: b.origin, clientError: b.clientError ?? null,
    context: b.context && typeof b.context === "object" ? b.context : {},
    breadcrumbs: Array.isArray(b.breadcrumbs) ? b.breadcrumbs : [], recorded: !!b.recorded, buildVersion: b.buildVersion ?? null,
  }, { adminId: me(req), role: req.admin!.role, isMain: isMain(req) });
  ok(res, { id: r.id });
});

// Автор або головний
async function accessible(req: AuthedRequest, id: number) {
  const r = await loadReport(id);
  if (!r) return undefined;
  if (isMain(req) || r.authorAdminId === me(req)) return r;
  if (await isDuplicateAuthor(r.id, me(req))) return r; // автор дубля бачить оригінал (без контексту — як автор)
  return undefined;
}

// Вкладення: multipart files[] + meta (JSON-масив по файлах: {kind, meta}). PNG-скріншоти з
// замазкою лишаємо PNG (JPEG розмазав би пікселізацію), решту зображень стискаємо.
router.post("/feedback/:id/attachments", upload.array("files", 6), async (req: AuthedRequest, res) => {
  const r = await accessible(req, Number(req.params.id));
  if (!r) return fail(res, 404, "Зголошення не знайдено");
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) return fail(res, 400, "Немає файлів");
  let metas: { kind?: string; meta?: Record<string, unknown> }[] = [];
  try { metas = JSON.parse(String(req.body?.meta ?? "[]")); } catch { metas = []; }
  const out: number[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const mime = sniffDocMime(f.buffer);
    if (!mime || !MIME_OK.has(mime)) return fail(res, 400, `Файл «${f.originalname}»: тип не підтверджено вмістом (дозволено фото і PDF)`);
    const originalName = Buffer.from(f.originalname ?? "file", "latin1").toString("utf8");
    const kindRaw = String(metas[i]?.kind ?? "upload");
    const kind = kindRaw === "screenshot" || kindRaw === "pin" ? kindRaw : "upload";
    let buffer = f.buffer, fileName = originalName, storedMime = mime;
    if (mime !== "image/png" || kind === "upload") { const c = await compressUploadImage(f.buffer, mime, originalName); buffer = c.buffer; fileName = c.fileName; storedMime = c.mime; }
    const stored = makeStoredName(fileName);
    await fs.promises.writeFile(path.join(FEEDBACK_DIR, stored), buffer);
    const [a] = await db.insert(feedbackAttachmentsTable).values({
      reportId: r.id, kind, path: stored, name: fileName, mime: storedMime, size: buffer.length,
      meta: metas[i]?.meta && typeof metas[i]!.meta === "object" ? metas[i]!.meta! : null,
    }).returning({ id: feedbackAttachmentsTable.id });
    out.push(a!.id);
  }
  await db.update(feedbackReportsTable).set({ updatedAt: new Date() }).where(eq(feedbackReportsTable.id, r.id));
  ok(res, { ids: out });
});

router.get("/feedback/:id", async (req: AuthedRequest, res) => {
  const r = await accessible(req, Number(req.params.id));
  if (!r) return fail(res, 404, "Зголошення не знайдено");
  const [att, com, votes, author] = await Promise.all([
    db.select().from(feedbackAttachmentsTable).where(eq(feedbackAttachmentsTable.reportId, r.id)).orderBy(feedbackAttachmentsTable.id),
    db.select({ id: feedbackCommentsTable.id, adminId: feedbackCommentsTable.adminId, adminName: adminsTable.name, kind: feedbackCommentsTable.kind, body: feedbackCommentsTable.body, via: feedbackCommentsTable.via, createdAt: feedbackCommentsTable.createdAt })
      .from(feedbackCommentsTable).leftJoin(adminsTable, eq(adminsTable.id, feedbackCommentsTable.adminId)).where(eq(feedbackCommentsTable.reportId, r.id)).orderBy(feedbackCommentsTable.id),
    db.select({ adminId: feedbackVotesTable.adminId, name: adminsTable.name }).from(feedbackVotesTable).leftJoin(adminsTable, eq(adminsTable.id, feedbackVotesTable.adminId)).where(eq(feedbackVotesTable.reportId, r.id)),
    db.select({ id: adminsTable.id, name: adminsTable.name }).from(adminsTable).where(eq(adminsTable.id, r.authorAdminId)),
  ]);
  const mine = r.authorAdminId === me(req);
  if (mine) await db.update(feedbackReportsTable).set({ authorSeenAt: new Date() }).where(eq(feedbackReportsTable.id, r.id));
  // автор дубля (не головний, не автор) — вкладення не віддаємо: бачить лише текст і відповіді
  const dupViewer = !isMain(req) && !mine;
  ok(res, {
    ...r, mine, authorName: author[0]?.name ?? "?",
    attachments: dupViewer ? [] : att.map(a => ({ id: a.id, kind: a.kind, name: a.name, mime: a.mime, size: a.size, meta: a.meta, url: `/api/feedback/${r.id}/attachments/${a.id}` })),
    comments: com, votes: votes.map(v => ({ adminId: v.adminId, name: v.name })),
    // контекст і крихти автору не показуємо (бачить головний); автору — лише його ж текст
    ...(isMain(req) ? {} : { context: { role: r.context?.roleLabel }, breadcrumbs: [], clientError: null }),
  });
});

router.get("/feedback/:id/attachments/:aid", async (req: AuthedRequest, res) => {
  const r = await accessible(req, Number(req.params.id));
  if (!r || (!isMain(req) && r.authorAdminId !== me(req))) return fail(res, 404, "Не знайдено");
  const [a] = await db.select().from(feedbackAttachmentsTable).where(and(eq(feedbackAttachmentsTable.id, Number(req.params.aid)), eq(feedbackAttachmentsTable.reportId, r.id)));
  if (!a) return fail(res, 404, "Файл не знайдено");
  res.setHeader("Content-Type", a.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  res.sendFile(path.join(FEEDBACK_DIR, path.basename(a.path)));
});

router.post("/feedback/:id/vote", async (req: AuthedRequest, res) => {
  const r = await loadReport(Number(req.params.id));
  if (!r) return fail(res, 404, "Зголошення не знайдено");
  ok(res, { votes: await toggleVote(r.id, me(req), true) });
});
router.delete("/feedback/:id/vote", async (req: AuthedRequest, res) => {
  const r = await loadReport(Number(req.params.id));
  if (!r) return fail(res, 404, "Зголошення не знайдено");
  ok(res, { votes: await toggleVote(r.id, me(req), false) });
});

router.post("/feedback/:id/comments", async (req: AuthedRequest, res) => {
  const r = await accessible(req, Number(req.params.id));
  if (!r || (!isMain(req) && r.authorAdminId !== me(req))) return fail(res, 404, "Зголошення не знайдено");
  const body = String(req.body?.body ?? "").trim();
  if (!body) return fail(res, 400, "Порожній коментар");
  try {
    if (isMain(req) && r.authorAdminId !== me(req)) {
      const kind = req.body?.kind === "question" ? "question" : "answer";
      ok(res, await replyToAuthor(r, me(req), body, kind, "web"));
    } else ok(res, await authorComment(r, me(req), body, "web"));
  } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});

router.post("/feedback/:id/confirm", async (req: AuthedRequest, res) => {
  const r = await loadReport(Number(req.params.id));
  if (!r || r.authorAdminId !== me(req)) return fail(res, 404, "Зголошення не знайдено");
  try { ok(res, await authorConfirm(r, me(req), !!req.body?.ok, req.body?.note ? String(req.body.note) : null, "web")); }
  catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});

// ── головний адмін ──────────────────────────────────────────────────────────
router.get("/feedback/admin/counters", async (_req, res) => ok(res, await counters()));

router.get("/feedback/admin/list", async (req: AuthedRequest, res) => {
  const q = req.query as Record<string, string | undefined>;
  const conds: any[] = [];
  const st = (q.status ?? "open").split(",").map(s => s.trim()).filter(Boolean);
  if (st.includes("open")) conds.push(inArray(feedbackReportsTable.status, OPEN_STATUSES));
  else if (!st.includes("all")) conds.push(inArray(feedbackReportsTable.status, st.filter(s => (STATUSES as string[]).includes(s))));
  if (q.kind) conds.push(inArray(feedbackReportsTable.kind, q.kind.split(",")));
  if (q.page) conds.push(eq(feedbackReportsTable.pagePath, q.page));
  if (q.author) conds.push(eq(feedbackReportsTable.authorAdminId, Number(q.author)));
  if (q.build) conds.push(eq(feedbackReportsTable.buildVersion, q.build));
  if (q.q?.trim()) { const like = `%${q.q.trim().toLowerCase()}%`; conds.push(sql`(lower(${feedbackReportsTable.title}) like ${like} or lower(${feedbackReportsTable.description}) like ${like} or ${feedbackReportsTable.id}::text = ${q.q.trim()})`); }
  const rows = await db.select({
    id: feedbackReportsTable.id, kind: feedbackReportsTable.kind, severity: feedbackReportsTable.severity, status: feedbackReportsTable.status,
    title: feedbackReportsTable.title, pagePath: feedbackReportsTable.pagePath, pageLabel: feedbackReportsTable.pageLabel, origin: feedbackReportsTable.origin,
    authorAdminId: feedbackReportsTable.authorAdminId, authorName: adminsTable.name, buildVersion: feedbackReportsTable.buildVersion,
    createdAt: feedbackReportsTable.createdAt, updatedAt: feedbackReportsTable.updatedAt, statusChangedAt: feedbackReportsTable.statusChangedAt,
    lastAdminActivityAt: feedbackReportsTable.lastAdminActivityAt, confirmRequestedAt: feedbackReportsTable.confirmRequestedAt,
    duplicateOfId: feedbackReportsTable.duplicateOfId, taskId: feedbackReportsTable.taskId, recorded: feedbackReportsTable.recorded,
    votes: votesSql, attachments: attCountSql, comments: commentsCountSql,
  }).from(feedbackReportsTable).leftJoin(adminsTable, eq(adminsTable.id, feedbackReportsTable.authorAdminId))
    .where(conds.length ? and(...conds) : undefined).orderBy(desc(feedbackReportsTable.id)).limit(500);
  const [pages, authors, builds] = await Promise.all([
    db.select({ path: feedbackReportsTable.pagePath, label: feedbackReportsTable.pageLabel, n: sql<number>`count(*)::int` }).from(feedbackReportsTable).groupBy(feedbackReportsTable.pagePath, feedbackReportsTable.pageLabel).orderBy(sql`3 desc`),
    db.select({ id: adminsTable.id, name: adminsTable.name, n: sql<number>`count(*)::int` }).from(feedbackReportsTable).innerJoin(adminsTable, eq(adminsTable.id, feedbackReportsTable.authorAdminId)).groupBy(adminsTable.id, adminsTable.name).orderBy(sql`3 desc`),
    db.select({ build: feedbackReportsTable.buildVersion, n: sql<number>`count(*)::int` }).from(feedbackReportsTable).groupBy(feedbackReportsTable.buildVersion).orderBy(sql`1 desc`),
  ]);
  ok(res, { rows, facets: { pages: pages.filter(p => p.path), authors, builds: builds.filter(b => b.build) } });
});

router.patch("/feedback/admin/:id", async (req: AuthedRequest, res) => {
  const r = await loadReport(Number(req.params.id));
  if (!r) return fail(res, 404, "Зголошення не знайдено");
  const b = req.body ?? {};
  try {
    const patch: Partial<typeof feedbackReportsTable.$inferInsert> = {};
    if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim().slice(0, 120);
    if (b.kind && KINDS.includes(b.kind)) patch.kind = b.kind;
    if (b.severity === null || SEVERITIES.includes(b.severity)) patch.severity = b.severity;
    if (Object.keys(patch).length) await db.update(feedbackReportsTable).set({ ...patch, updatedAt: new Date() }).where(eq(feedbackReportsTable.id, r.id));
    let next = (await loadReport(r.id))!;
    if (b.status && (STATUSES as string[]).includes(b.status)) {
      next = await setStatus(next, b.status as FeedbackStatus, me(req), { reply: b.reply !== undefined ? String(b.reply ?? "") : undefined, duplicateOfId: b.duplicateOfId !== undefined ? (b.duplicateOfId ? Number(b.duplicateOfId) : null) : undefined, via: "web" });
    } else if (typeof b.reply === "string" && b.reply.trim()) {
      next = await replyToAuthor(next, me(req), b.reply, "answer", "web");
    }
    if (b.duplicateOfId !== undefined && !b.status) await db.update(feedbackReportsTable).set({ duplicateOfId: b.duplicateOfId ? Number(b.duplicateOfId) : null }).where(eq(feedbackReportsTable.id, r.id));
    ok(res, await loadReport(r.id));
  } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});

router.post("/feedback/admin/:id/task", async (req: AuthedRequest, res) => {
  const r = await loadReport(Number(req.params.id));
  if (!r) return fail(res, 404, "Зголошення не знайдено");
  ok(res, { taskId: await createTaskFromReport(r, me(req)) });
});

function packFilterOf(q: Record<string, string | undefined>) {
  const status = (q.status ?? "open").split(",").map(s => s.trim()).filter(Boolean);
  return {
    status: status.includes("open") ? undefined : status.includes("all") ? STATUSES : status,
    kind: q.kind ? q.kind.split(",") : undefined, pagePath: q.page || null, since: q.since || null,
    ids: q.ids ? q.ids.split(",").map(Number).filter(Number.isFinite) : undefined,
  };
}
// Перед скачуванням пакета: незамазані скріншоти з фінансових сторінок (панель показує підтвердження).
router.get("/feedback/admin/pack-check", async (req: AuthedRequest, res) => ok(res, { warnings: await packWarnings(packFilterOf(req.query as Record<string, string | undefined>)) }));

// Пакет для Claude: ZIP з feedback.json + shots/<id>-<aid>.<ext> (ті самі фільтри, що й список).
router.get("/feedback/admin/pack.zip", async (req: AuthedRequest, res) => {
  const filter = packFilterOf(req.query as Record<string, string | undefined>);
  const pack = await buildPack(filter);
  const warnings = await packWarningsFor(pack); // з того самого набору, що й ZIP (agy: подвійний buildPack)
  const { attachmentsRaw, ...rest } = pack;
  const json = { ...rest, warnings };
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="feedback-pack-${new Date().toISOString().slice(0, 10)}.zip"`);
  const zip = archiver("zip", { zlib: { level: 6 } });
  zip.on("error", (e: Error) => { if (!res.headersSent) res.status(500).end(); else res.end(); void e; });
  zip.pipe(res);
  zip.append(JSON.stringify(json, null, 2), { name: "feedback.json" });
  zip.append(PACK_README, { name: "README.md" });
  for (const a of attachmentsRaw) {
    const p = path.join(FEEDBACK_DIR, path.basename(a.path));
    if (fs.existsSync(p)) zip.file(p, { name: `shots/${a.reportId}-${a.id}${extOf(a.mime)}` });
  }
  await zip.finalize();
});

router.post("/feedback/admin/import", upload.single("file"), async (req: AuthedRequest, res) => {
  let input: any = null;
  try {
    const f = (req as any).file as Express.Multer.File | undefined;
    input = f ? JSON.parse(f.buffer.toString("utf8")) : req.body;
  } catch { return fail(res, 400, "Файл не є коректним JSON"); }
  if (!input || !Array.isArray(input.items)) return fail(res, 400, "Очікую {items:[{id, status, reply, …}]}");
  ok(res, await applyTriageResult(input, me(req)));
});

router.get("/feedback/admin/settings", async (_req, res) => ok(res, await loadFeedbackSettings()));
router.put("/feedback/admin/settings", async (req: AuthedRequest, res) => ok(res, await saveFeedbackSettings(req.body ?? {})));

const PACK_README = `# Пакет зголошень для тріажу (Grafik-bot)

feedback.json — відкриті зголошення з панелі: опис/кроки/очікування, сторінка й фільтри,
автоконтекст (роль, браузер, збірка, невдалі запити з req.id), «хлібні крихти» дій,
коментарі, голоси. shots/ — скріншоти (анотовані, замазка незворотна), піни, файли.
Розбір — скілом /feedback-triage у Claude Code (docs/feedback/README.md).
`;

export default router;

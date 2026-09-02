// Публічні токен-роути онлайн-підписання (§5/§10 плану worker-docs-signing).
// НЕ authRequired — токен у шляху є ЄДИНОЮ авторизацією (ентропія ~120 біт,
// randomInviteCode(24), TTL 72г, одноразовий). CSRF-гейт app.ts НЕ потребує
// винятку для цих шляхів: сторінка /sign/:token — наш власний same-origin
// фронтенд і шле X-Requested-With через ту саму обгортку api()/post(), що й
// решта панелі (перевірено — на відміну від /auth/login, тут нема застарілого
// «сирого» fetch без заголовка).
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { db, signatureTokensTable, signatureEventsTable, contractsTable, contractFilesTable, workersTable, factoriesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { UPLOADS_ROOT } from "../lib/uploads";
import { clientIp, parseDevice, lookupGeo } from "../lib/clientInfo";
import { applyWorkerSignature } from "../services/contracts";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });

// Публічний ендпоінт — головна лінія оборони від перебору токена. Ентропія
// самого токена (~120 біт) робить перебір непрактичним і без цього, це —
// глибокоешелонований захист (той самий підхід, що authLimiter в auth.ts).
const signLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Забагато запитів. Спробуйте пізніше." },
});
// Скоупимо по префіксу — цей роутер тепер монтується РАНІШЕ за решту (щоб
// уникнути 401-перехоплення блоковими authRequired-гейтами інших роутерів,
// див. коментар у routes/index.ts), тож неупакований router.use() тут зачепив
// би rate-limit'ом узагалі всі запити до /api, не лише /sign/*.
router.use("/sign", signLimiter);

async function logEvent(req: any, tokenId: number, contractId: number, event: string, extra?: Record<string, unknown>) {
  const ip = clientIp(req);
  const device = parseDevice(req.headers?.["user-agent"]);
  try {
    const [row] = await db.insert(signatureEventsTable).values({
      contractId, tokenId, event, ip, device, extra: extra ?? null,
    }).returning({ id: signatureEventsTable.id });
    if (row) lookupGeo(ip).then(geo => {
      if (geo) db.update(signatureEventsTable).set({ geo }).where(eq(signatureEventsTable.id, row.id)).catch(() => {});
    }).catch(() => {});
  } catch (e) {
    logger.error({ err: e }, "signature logEvent failed");
  }
}

async function loadValidToken(token: string) {
  const [row] = await db.select().from(signatureTokensTable).where(eq(signatureTokensTable.token, token));
  if (!row) return { error: "Лінк недійсний." };
  if (row.revokedAt) return { error: "Лінк відкликано." };
  if (row.usedAt) return { error: "Умову вже підписано за цим лінком." };
  if (new Date(row.expiresAt).getTime() < Date.now()) return { error: "Термін дії лінку вичерпано." };
  return { token: row };
}

// Комплект (факторі-пакет + сталий пакет, згенеровані/надіслані разом) — усі
// contractId одного токена, підписуються ОДНІЄЮ сесією (не по одному лінку).
const bundleOf = (token: { contractId: number; extraContractIds: number[] | null }): number[] =>
  [token.contractId, ...(token.extraContractIds ?? [])];

// Мета умови(-в) + список файлів для сторінки підписання.
router.get("/sign/:token", async (req, res) => {
  const { token, error } = await loadValidToken(req.params.token);
  if (error || !token) return fail(res, 404, error ?? "Лінк недійсний.");
  const bundle = bundleOf(token);
  const contracts = await db.select().from(contractsTable).where(inArray(contractsTable.id, bundle));
  const primary = contracts.find(c => c.id === token.contractId);
  if (!primary) return fail(res, 404, "Умову не знайдено.");
  const [worker] = await db.select({ fullName: workersTable.fullName, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, primary.workerId));
  const factoryIds = [...new Set(contracts.map(c => c.factoryId).filter((x): x is number => x != null))];
  const factories = factoryIds.length ? await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable).where(inArray(factoriesTable.id, factoryIds)) : [];
  const facName = new Map(factories.map(f => [f.id, f.name]));

  const rawFiles = await db.select({ id: contractFilesTable.id, title: contractFilesTable.title, sortOrder: contractFilesTable.sortOrder, contractId: contractFilesTable.contractId })
    .from(contractFilesTable).where(inArray(contractFilesTable.contractId, bundle)).orderBy(contractFilesTable.sortOrder);
  // Групуємо по пакету (сталий / конкретна фабрика), щоб працівник бачив, що
  // саме до чого належить, навіть коли підписує кілька пакетів заразом.
  const files = rawFiles.map(f => {
    const c = contracts.find(cc => cc.id === f.contractId);
    return { id: f.id, title: f.title, sortOrder: f.sortOrder, groupLabel: c?.factoryId ? (facName.get(c.factoryId) ?? null) : "Стандартний пакет" };
  });

  await db.update(signatureTokensTable).set({ viewCount: token.viewCount + 1 }).where(eq(signatureTokensTable.id, token.id));
  await Promise.all(bundle.map(cid => logEvent(req, token.id, cid, "opened")));

  ok(res, {
    workerName: worker?.fullName ?? null, language: worker?.language ?? "uk", factoryName: facName.get(primary.factoryId ?? -1) ?? null,
    dateFrom: primary.dateFrom, dateTo: primary.dateTo, files,
  });
});

// Стрім НЕПІДПИСАНОГО файлу для перегляду/canvas-рендеру (nosniff, без кешу —
// «чистого» URL для завантаження немає, фронт малює в canvas через pdf.js).
router.get("/sign/:token/file/:fileId", async (req, res) => {
  const { token, error } = await loadValidToken(req.params.token);
  if (error || !token) return fail(res, 404, error ?? "Лінк недійсний.");
  const bundle = bundleOf(token);
  const fileId = Number(req.params.fileId);
  const [file] = await db.select().from(contractFilesTable).where(eq(contractFilesTable.id, fileId));
  if (!file || !bundle.includes(file.contractId) || !file.unsignedPath) return fail(res, 404, "Файл не знайдено.");
  const abs = path.join(UPLOADS_ROOT, file.unsignedPath);
  if (!fs.existsSync(abs)) return fail(res, 404, "Файл не знайдено на диску.");

  await logEvent(req, token.id, file.contractId, "doc_viewed", { fileId });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/pdf");
  fs.createReadStream(abs).pipe(res);
});

// Підтвердження, що працівник переглянув документ і дає згоду (окрема подія —
// сервер вимагає її ПЕРЕД /sign, не довіряючи лише клієнтському стану).
router.post("/sign/:token/consent", async (req, res) => {
  const { token, error } = await loadValidToken(req.params.token);
  if (error || !token) return fail(res, 404, error ?? "Лінк недійсний.");
  await Promise.all(bundleOf(token).map(cid => logEvent(req, token.id, cid, "consent_given")));
  ok(res, { ok: true });
});

// Власне підпис: PNG з canvas → вбудовується в кожен файл КОЖНОГО пакета
// комплекту (крім company-зон), токен стає одноразово використаним, усі
// пакети комплекту → worker_signed однією дією (не по одному).
router.post("/sign/:token", async (req, res) => {
  const { token, error } = await loadValidToken(req.params.token);
  if (error || !token) return fail(res, 404, error ?? "Лінк недійсний.");
  const signature = req.body?.signature;
  if (!signature || typeof signature !== "string") return fail(res, 400, "Немає підпису.");

  const events = await db.select({ event: signatureEventsTable.event }).from(signatureEventsTable).where(eq(signatureEventsTable.tokenId, token.id));
  if (!events.some(e => e.event === "consent_given")) return fail(res, 400, "Спершу перегляньте документ і підтвердьте згоду.");

  try {
    const bundle = bundleOf(token);
    let signedFiles = 0;
    for (const contractId of bundle) {
      const result = await applyWorkerSignature(contractId, signature);
      signedFiles += result.signedFiles;
      const files = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, contractId));
      await logEvent(req, token.id, contractId, "signed", {
        files: files.map(f => ({ id: f.id, title: f.title, sha256: f.signedSha256 })),
      });
    }
    await db.update(signatureTokensTable).set({ usedAt: new Date() }).where(eq(signatureTokensTable.id, token.id));

    ok(res, { ok: true, signedFiles });
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося застосувати підпис.");
  }
});

router.post("/sign/:token/decline", async (req, res) => {
  const { token, error } = await loadValidToken(req.params.token);
  if (error || !token) return fail(res, 404, error ?? "Лінк недійсний.");
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : null;
  const bundle = bundleOf(token);
  await db.update(contractsTable).set({ status: "declined", declineReason: reason, updatedAt: new Date() }).where(inArray(contractsTable.id, bundle));
  await db.update(signatureTokensTable).set({ revokedAt: new Date() }).where(eq(signatureTokensTable.id, token.id));
  await Promise.all(bundle.map(cid => logEvent(req, token.id, cid, "declined", { reason })));
  ok(res, { ok: true });
});

export default router;

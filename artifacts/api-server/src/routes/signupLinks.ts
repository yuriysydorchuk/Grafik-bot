// Лінки реєстрації працівників (/signup-links, 11.10.2026): персональний лінк/QR рекрутера
// чи офіс-менеджера на фабрику, список своїх лінків з лічильниками, хто за ним зареєструвався
// («хто привів» — база бонусів рекрутерам). Головний адмін/owner бачать лінки всіх.
// Роутер поза scopeGate admin-api — скоуп звіряється тут: фабрика лінка має бути у скоупі,
// чужі лінки скоуп-адміну недоступні.
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, factoriesTable } from "@workspace/db";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import { factoryInScope } from "../lib/scope";
import {
  getOrCreateSignupLink, listSignupLinks, rotateSignupLink, signupLinkById, signupLinkQrPng, signupLinkUrl, signupLinkWorkers,
} from "../services/signupLinks";

const router: IRouter = Router();
router.use("/signup-links", authRequired, requireCap("signupLinks"));

const seesAll = (req: AuthedRequest) => !!req.admin && (req.admin.isMain || req.admin.role === "owner");

// Свій лінк або будь-який для головного/owner; інакше 404 (не розкриваємо існування чужих).
// Фабрика лінка має бути в ПОТОЧНОМУ скоупі: скоуп звузили після створення — старий лінк
// (люди, QR, rotate) для цього адміна зникає, поки скоуп не повернуть (ревʼю codex 11.10.2026).
async function ownLink(req: AuthedRequest, id: number) {
  if (!Number.isInteger(id)) return undefined;
  const link = await signupLinkById(id);
  if (!link) return undefined;
  if (seesAll(req)) return link;
  if (link.adminId !== req.admin!.adminId || !factoryInScope(req.admin!.scope, link.factoryId)) return undefined;
  return link;
}

// ?all=1 — усі рекрутери (лише головний/owner); інакше свої
router.get("/signup-links", async (req: AuthedRequest, res) => {
  const all = req.query.all === "1" && seesAll(req);
  const rows = await listSignupLinks(all ? {} : { adminId: req.admin!.adminId });
  return res.json(seesAll(req) ? rows : rows.filter(r => factoryInScope(req.admin!.scope, r.factoryId)));
});

// Get-or-create лінка на фабрику: сталий, його можна друкувати
router.post("/signup-links", async (req: AuthedRequest, res) => {
  const factoryId = Number(req.body?.factoryId);
  if (!Number.isInteger(factoryId) || factoryId <= 0) return res.status(400).json({ error: "factoryId обовʼязковий" });
  const [fac] = await db.select({ id: factoriesTable.id, isOffice: factoriesTable.isOffice }).from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (!fac) return res.status(404).json({ error: "Фабрику не знайдено" });
  if (fac.isOffice) return res.status(400).json({ error: "На офісну «фабрику» самореєстрації немає" });
  if (!factoryInScope(req.admin!.scope, factoryId)) return res.status(403).json({ error: "forbidden" });
  const link = await getOrCreateSignupLink(req.admin!.adminId, factoryId);
  const [row] = await listSignupLinks({ adminId: link.adminId }).then(rows => rows.filter(r => r.id === link.id));
  return res.json(row ?? { ...link, url: signupLinkUrl(link.token) });
});

// Перевипустити токен: старий лінк/QR перестає працювати, атрибуція старих реєстрацій лишається
router.post("/signup-links/:id/rotate", async (req: AuthedRequest, res) => {
  const link = await ownLink(req, Number(req.params.id));
  if (!link) return res.status(404).json({ error: "Не знайдено" });
  const updated = await rotateSignupLink(link.id);
  const [row] = (await listSignupLinks({ adminId: link.adminId })).filter(r => r.id === link.id);
  return res.json(row ?? { ...updated, url: signupLinkUrl(updated!.token) });
});

router.get("/signup-links/:id/workers", async (req: AuthedRequest, res) => {
  const link = await ownLink(req, Number(req.params.id));
  if (!link) return res.status(404).json({ error: "Не знайдено" });
  return res.json(await signupLinkWorkers(link.id));
});

// PNG QR-код лінка (для <img> у панелі й друку); GET — CSRF-гард не зачіпає
router.get("/signup-links/:id/qr.png", async (req: AuthedRequest, res) => {
  const link = await ownLink(req, Number(req.params.id));
  if (!link) return res.status(404).json({ error: "Не знайдено" });
  const png = await signupLinkQrPng(signupLinkUrl(link.token));
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, no-store"); // після «Оновити лінк» картинка має змінитись
  return res.send(png);
});

export default router;

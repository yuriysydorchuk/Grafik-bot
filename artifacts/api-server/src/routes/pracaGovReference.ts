// Довідкові дані форми PSZ-PPWPU під cap `legalization` (13.10.2026): фірми (1.2/1.3/4/PKD/KRAZ),
// фабрики (3.4 TERYT + назва посади/KZiS за замовчуванням), посади на фабриці (3.2/3.3), посади (KZiS).
// Окремий вузький API, щоб людина з легалізації вела ці поля без права editData на весь довідник;
// білі списки полів — лише те, що потрібно повідомленню.
import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, companiesTable, factoriesTable, factoryPositionsTable, positionsTable } from "@workspace/db";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";

const router: IRouter = Router();
router.use("/praca-gov/reference", authRequired, requireCap("legalization"));

const ok = (res: any, data: unknown) => res.json(data);
const fail = (res: any, code: number, error: string) => res.status(code).json({ error });
const str = (v: unknown) => String(v ?? "").trim() || null;
const int = (v: unknown): number | null => { if (v === undefined || v === null || v === "") return null; const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error("Очікується ціле число ≥ 0"); return n; };
const idOf = (v: string | string[]): number | null => { const n = Number(Array.isArray(v) ? v[0] : v); return Number.isInteger(n) && n > 0 ? n : null; };
// KZiS: порожньо → null; інакше рівно 6 цифр, інакше помилка (обрізання/доповнення дало б інший код)
const kzis = (v: unknown): string | null => { const k = String(v ?? "").trim(); if (!k) return null; if (!/^\d{6}$/.test(k)) throw new Error("Код KZiS — рівно 6 цифр"); return k; };

router.get("/praca-gov/reference", async (_req: AuthedRequest, res) => {
  const [cos, fas, fps, pos] = await Promise.all([
    db.select({ id: companiesTable.id, name: companiesTable.name, legalName: companiesTable.legalName, city: companiesTable.city, pkd: companiesTable.pkd, kraz: companiesTable.kraz, contactEmail: companiesTable.contactEmail, contactPhone: companiesTable.contactPhone, headcountEmployment: companiesTable.headcountEmployment, headcountCivil: companiesTable.headcountCivil, employsWorkers: companiesTable.employsWorkers, isActive: companiesTable.isActive }).from(companiesTable).orderBy(asc(companiesTable.name)),
    db.select({ id: factoriesTable.id, name: factoriesTable.name, address: factoriesTable.address, city: factoriesTable.city, companyId: factoriesTable.companyId, isOffice: factoriesTable.isOffice, contractDuties: factoriesTable.contractDuties,
      addrPostalCode: factoriesTable.addrPostalCode, addrWojewodztwo: factoriesTable.addrWojewodztwo, addrPowiat: factoriesTable.addrPowiat, addrGmina: factoriesTable.addrGmina, addrMiejscowosc: factoriesTable.addrMiejscowosc, addrStreet: factoriesTable.addrStreet, addrHouseNo: factoriesTable.addrHouseNo, addrAptNo: factoriesTable.addrAptNo,
      uaStanowisko: factoriesTable.uaStanowisko, uaKzisCode: factoriesTable.uaKzisCode }).from(factoriesTable).orderBy(asc(factoriesTable.name)),
    db.select({ factoryId: factoryPositionsTable.factoryId, positionId: factoryPositionsTable.positionId, name: positionsTable.name, contractDuties: factoryPositionsTable.contractDuties, uaStanowisko: factoryPositionsTable.uaStanowisko, kzisCode: factoryPositionsTable.kzisCode, sortOrder: factoryPositionsTable.sortOrder }).from(factoryPositionsTable).leftJoin(positionsTable, eq(positionsTable.id, factoryPositionsTable.positionId)).orderBy(asc(factoryPositionsTable.sortOrder)),
    db.select({ id: positionsTable.id, name: positionsTable.name, kzisCode: positionsTable.kzisCode, isActive: positionsTable.isActive }).from(positionsTable).orderBy(asc(positionsTable.sortOrder)),
  ]);
  const coName = new Map(cos.map(c => [c.id, c.name]));
  ok(res, {
    companies: cos.filter(c => c.employsWorkers !== false && c.isActive !== false),
    factories: fas.filter(f => !f.isOffice).map(f => ({ ...f, companyName: f.companyId ? coName.get(f.companyId) ?? null : null, positions: fps.filter(p => p.factoryId === f.id) })),
    positions: pos.filter(p => p.isActive !== false),
  });
});

router.patch("/praca-gov/reference/company/:id", async (req: AuthedRequest, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, "Невірний id");
  const b = req.body ?? {}; const patch: Record<string, unknown> = {};
  for (const k of ["pkd", "kraz", "contactEmail", "contactPhone", "city"] as const) if (b[k] !== undefined) patch[k] = str(b[k]);
  try { for (const k of ["headcountEmployment", "headcountCivil"] as const) if (b[k] !== undefined) patch[k] = int(b[k]); } catch (e: any) { return fail(res, 400, e.message); }
  if (!Object.keys(patch).length) return fail(res, 400, "Нема полів");
  await db.update(companiesTable).set(patch).where(eq(companiesTable.id, id));
  ok(res, { ok: true });
});

router.patch("/praca-gov/reference/factory/:id", async (req: AuthedRequest, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, "Невірний id");
  const b = req.body ?? {}; const patch: Record<string, unknown> = {};
  for (const k of ["addrPostalCode", "addrWojewodztwo", "addrPowiat", "addrGmina", "addrMiejscowosc", "addrStreet", "addrHouseNo", "addrAptNo", "uaStanowisko"] as const) if (b[k] !== undefined) patch[k] = str(b[k]);
  try { if (b.uaKzisCode !== undefined) patch.uaKzisCode = kzis(b.uaKzisCode); } catch (e: any) { return fail(res, 400, e.message); }
  if (!Object.keys(patch).length) return fail(res, 400, "Нема полів");
  await db.update(factoriesTable).set(patch).where(eq(factoriesTable.id, id));
  ok(res, { ok: true });
});

router.patch("/praca-gov/reference/factory/:id/position/:positionId", async (req: AuthedRequest, res) => {
  const fid = idOf(req.params.id), pid = idOf(req.params.positionId); if (!fid || !pid) return fail(res, 400, "Невірний id");
  const b = req.body ?? {}; const patch: Record<string, unknown> = {};
  if (b.uaStanowisko !== undefined) patch.uaStanowisko = str(b.uaStanowisko);
  try { if (b.kzisCode !== undefined) patch.kzisCode = kzis(b.kzisCode); } catch (e: any) { return fail(res, 400, e.message); }
  if (!Object.keys(patch).length) return fail(res, 400, "Нема полів");
  const r = await db.update(factoryPositionsTable).set(patch).where(and(eq(factoryPositionsTable.factoryId, fid), eq(factoryPositionsTable.positionId, pid))).returning({ id: factoryPositionsTable.id });
  if (!r.length) return fail(res, 404, "Посада не привʼязана до фабрики");
  ok(res, { ok: true });
});

router.patch("/praca-gov/reference/position/:id", async (req: AuthedRequest, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, "Невірний id");
  const b = req.body ?? {};
  if (b.kzisCode === undefined) return fail(res, 400, "Нема полів");
  let code: string | null; try { code = kzis(b.kzisCode); } catch (e: any) { return fail(res, 400, e.message); }
  await db.update(positionsTable).set({ kzisCode: code }).where(eq(positionsTable.id, id));
  ok(res, { ok: true });
});

export default router;

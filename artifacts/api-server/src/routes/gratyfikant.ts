// Імпорт вивантажень з Gratyfikant nexo (Налаштування → Gratyfikant, cap
// svodniSensitive): список умов АБО картотека з песелями (тип — по заголовках).
// dry=1 — лише превʼю; без dry: пише pesel/gratyfikant_name у профілі
// (тільки порожні, ручне не перетирає) і заміняє знімок умов фірми в
// gratyfikant_umowy. Матчер/парсери — services/gratyfikantImport.ts (під тестами).
import { Router, type IRouter } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { workersTable, gratyfikantUmowyTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import {
  detectFileKind, parseUmowyRows, parseKartotekaRows, matchNexo, candidateMap, normName,
} from "../services/gratyfikantImport";

const router: IRouter = Router();
router.use(authRequired);
router.use("/gratyfikant", requireCap("svodniSensitive"));

const FIRMS = ["ES", "ESO", "Klinex"];
const uploadXlsx = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });

router.post("/gratyfikant/import", uploadXlsx.single("file"), async (req: AuthedRequest, res) => {
  const firm = String(req.body?.firm ?? "").trim();
  if (!FIRMS.includes(firm)) return fail(res, 400, "firm: ES | ESO | Klinex");
  if (!req.file?.buffer) return fail(res, 400, "файл обовʼязковий (xlsx)");
  const dry = req.query.dry === "1" || req.body?.dry === "1";

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(req.file.buffer as any);
  } catch {
    return fail(res, 400, "не вдалося прочитати xlsx");
  }
  const ws = wb.worksheets[0];
  if (!ws) return fail(res, 400, "порожній файл");
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (c, cn) => { vals[cn - 1] = c.value; });
    rows.push(vals);
  });
  const kind = detectFileKind(rows[0] ?? []);
  if (!kind) return fail(res, 400, "невідомий формат: чекаю список умов (Nr umowy) або картотеку (PESEL)");

  const workers = await db.select({
    id: workersTable.id, fullName: workersTable.fullName, isActive: workersTable.isActive,
    gratyfikantName: workersTable.gratyfikantName, pesel: workersTable.pesel,
  }).from(workersTable);
  // матчимо ВСІХ (і звільнених): PESEL/нексо-імʼя — ідентичність людини, а лісти
  // за минулі місяці включають уже звільнених (липневий кейс: 65 пропущених)
  const everyone = workers.filter(w => w.fullName !== "Test");

  // Схвалений список змін: превʼю віддає КОЖНУ зміну з ключем, застосування
  // приймає approved (JSON-масив ключів) — точні збіги веб відзначає одразу,
  // нечіткі чекають ручного підтвердження. Без approved застосовується все
  // (пряме API-використання), веб завжди шле явний список.
  const approvedRaw = typeof req.body?.approved === "string" ? req.body.approved : null;
  let approved: Set<string> | null = null;
  if (approvedRaw != null) {
    try { approved = new Set(JSON.parse(approvedRaw)); } catch { return fail(res, 400, "approved: JSON-масив ключів"); }
  }
  const isApproved = (key: string) => approved == null || approved.has(key);

  if (kind === "kartoteka") {
    const items = parseKartotekaRows(rows);
    const cands = candidateMap(items);
    const peselTaken = new Map(workers.filter(w => w.pesel).map(w => [w.pesel!, w.fullName]));
    type Change = { key: string; kind: "pesel" | "name"; workerId: number; our: string; to: string; method: string };
    const changes: Change[] = [];
    const conflicts: string[] = [];
    const matchedKeys = new Set<string>();
    for (const w of everyone) {
      const m = matchNexo(w.gratyfikantName || w.fullName, cands);
      if (!m) continue;
      matchedKeys.add(normName(m.hit.name));
      if (m.hit.pesel && !w.pesel) {
        const holder = peselTaken.get(m.hit.pesel);
        if (holder && holder !== w.fullName) conflicts.push(`${w.fullName}: PESEL ${m.hit.pesel} вже у ${holder}`);
        else {
          changes.push({ key: `pesel:${w.id}`, kind: "pesel", workerId: w.id, our: w.fullName, to: m.hit.pesel, method: m.method });
          peselTaken.set(m.hit.pesel, w.fullName);
        }
      }
      if (!w.gratyfikantName && normName(m.hit.name) !== normName(w.fullName)) {
        changes.push({ key: `name:${w.id}`, kind: "name", workerId: w.id, our: w.fullName, to: m.hit.name, method: m.method });
      }
    }
    const act = changes.filter(c => isApproved(c.key));
    if (!dry) {
      for (const c of act) {
        if (c.kind === "pesel") await db.update(workersTable).set({ pesel: c.to }).where(eq(workersTable.id, c.workerId));
        else await db.update(workersTable).set({ gratyfikantName: c.to }).where(eq(workersTable.id, c.workerId));
      }
    }
    return res.json({
      kind, firm, applied: !dry, appliedCount: dry ? 0 : act.length,
      inFile: items.length, withPesel: items.filter(i => i.pesel).length,
      changes, conflicts,
      unmatchedInFile: items.filter(i => !matchedKeys.has(normName(i.name))).length,
    });
  }

  // kind === "umowy": знімок умов фірми + привʼязка до профілів. Схвалення
  // керує ПРИВʼЯЗКАМИ (link:<нормоване імʼя>): не схвалена → умова
  // імпортується, але без workerId (можна довʼязати наступним імпортом).
  const items = parseUmowyRows(rows);
  const cands = candidateMap(everyone.map(w => ({ name: w.gratyfikantName || w.fullName, id: w.id, fullName: w.fullName })));
  type Link = { key: string; nexoName: string; workerId: number; workerName: string; method: string };
  const linkByName = new Map<string, Link>();
  for (const u of items) {
    const k = normName(u.name);
    if (linkByName.has(k)) continue;
    const m = matchNexo(u.name, cands);
    if (m) linkByName.set(k, { key: `link:${k}`, nexoName: u.name, workerId: m.hit.id, workerName: (m.hit as any).fullName, method: m.method });
  }
  const values = items.map(u => {
    const link = linkByName.get(normName(u.name));
    const useLink = link && isApproved(link.key);
    return {
      firm, nexoName: u.name, workerId: useLink ? link.workerId : null,
      umowaNr: u.nr, odDnia: u.od, doDnia: u.do, dzial: u.dzial,
    };
  });
  if (!dry) {
    await db.delete(gratyfikantUmowyTable).where(eq(gratyfikantUmowyTable.firm, firm));
    for (let i = 0; i < values.length; i += 200) {
      await db.insert(gratyfikantUmowyTable).values(values.slice(i, i + 200));
    }
  }
  const links = [...linkByName.values()];
  return res.json({
    kind, firm, applied: !dry,
    inFile: items.length, links,
    linkedToWorkers: links.filter(l => isApproved(l.key)).length,
    unlinked: new Set(items.map(i => normName(i.name))).size - links.length,
  });
});

// Стан знімків умов по фірмах (для секції в Налаштуваннях)
router.get("/gratyfikant/status", async (_req, res) => {
  const rows = await db.select().from(gratyfikantUmowyTable);
  const byFirm: Record<string, { umowy: number; linked: number; importedAt: string | null }> = {};
  for (const f of FIRMS) byFirm[f] = { umowy: 0, linked: 0, importedAt: null };
  for (const r of rows) {
    const b = byFirm[r.firm] ?? (byFirm[r.firm] = { umowy: 0, linked: 0, importedAt: null });
    b.umowy++;
    if (r.workerId != null) b.linked++;
    const ts = r.importedAt?.toISOString?.() ?? null;
    if (ts && (!b.importedAt || ts > b.importedAt)) b.importedAt = ts;
  }
  const workers = await db.select({ pesel: workersTable.pesel, isActive: workersTable.isActive }).from(workersTable);
  const act = workers.filter(w => w.isActive);
  res.json({ firms: byFirm, activeWorkers: act.length, withPesel: act.filter(w => w.pesel).length });
});

export default router;

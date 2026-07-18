// «Сводні» (/svodni) — повне дзеркало зарплатних таблиць по містах.
// Доступ: capability `svodni` (сторінка, відкритий шар: фактичні години,
// ставки, відрахування, до виплати); закритий шар (księgowość-години,
// ksieg brutto/netto, готівка, конто) віддається ЛИШЕ з `svodniSensitive`
// (owner бачить усе) — фільтрація тут, в API, а не в інтерфейсі.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { svodniRowsTable, svodniTabChecksTable, svodniTabMetaTable, svodniLocksTable, workersTable, factoriesTable, companiesTable, hostelDeductionsTable, advanceRequestsTable, positionsTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import { hasCap } from "../lib/roles";
import { logger } from "../lib/logger";
import { matchWorker, findLikelyDuplicate } from "../bot/workerMatch";
import { cleanName } from "../services/payrollSummaries";
import { rematchSvodni, applyRatesFromSvodni, ensureSvodniFactories, dedupeWorkers, parseSheetDate, isUnder26, cityOfRegion, OFFICE_TAB_RE, EXTRA_STUDENTS_LABEL } from "../services/svodniSync";
import { computePayout, computeKsiegHours, legalStatusOf, applyLegalDefaults, ksiegRatesOf } from "../services/svodni";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const canSensitive = (req: AuthedRequest) => hasCap(req.admin!.role, req.admin!.caps, "svodniSensitive");

// Відповідь API: закритий шар (księgowość/готівка/конто + чутливі extras)
// віддається лише з capability svodniSensitive — фільтрація тут, не в UI.
const SENSITIVE_EXTRAS = new Set(["kontoH", "gotowkaH", "doplataEs", "godzFaktBlock", "zaliczkaBlock"]);
const SENSITIVE_HR = new Set(["kontoNr"]); // номер банківського рахунку
function serializeRow(r: typeof svodniRowsTable.$inferSelect, workerName: string | null, sensitive: boolean, workerLegal?: string | null, workerPref?: { kind: string; value: number | null } | null) {
  const base: Record<string, unknown> = {
    id: r.id, city: r.city, firm: r.firm, factoryLabel: r.factoryLabel, factoryId: r.factoryId,
    sortIdx: r.sortIdx, section: r.section, rawName: r.rawName,
    workerId: r.workerId, workerName, linkStatus: r.linkStatus, manual: r.manual,
    hoursNotified: r.hoursNotified, hours: r.hours, shifts: r.shifts,
    rateBrutto: r.rateBrutto, rateNetto: r.rateNetto, premia: r.premia,
    zaliczka: r.zaliczka, zaliczkaBd: r.zaliczkaBd, hostel: r.hostel, odziez: r.odziez,
    dojazd: r.dojazd, kara: r.kara, komornik: r.komornik, kaucja: r.kaucja,
    potracenia: r.potracenia, doWyplaty: r.doWyplaty, brutto: r.brutto,
    isStudent: r.isStudent, under26: r.under26,
    extras: sensitive ? r.extras : Object.fromEntries(Object.entries(r.extras as Record<string, unknown>).filter(([k]) => !SENSITIVE_EXTRAS.has(k))),
    hr: sensitive ? r.hr : Object.fromEntries(Object.entries(r.hr as Record<string, unknown>).filter(([k]) => !SENSITIVE_HR.has(k))),
    mismatch: r.mismatch, rowColor: r.rowColor,
    // форма легалізації: з тексту Księgowość рядка, fallback — профіль працівника
    legalStatus: legalStatusOf((r.extras as Record<string, unknown>).zusStatus as string) ?? workerLegal ?? null,
  };
  if (sensitive) {
    base.payoutPref = workerPref ?? null; // побажання працівника (примітки профілю)
    base.hoursDeclared = r.hoursDeclared;
    base.ksiegBrutto = r.ksiegBrutto;
    base.ksiegNetto = r.ksiegNetto;
    base.gotowka = r.gotowka;
    base.konto = r.konto;
  }
  return base;
}

// ── Затвердження: локи на фабрику або ціле місто (factoryLabel = "") ─────────
// Залочений рядок не редагується/не видаляється; from-hours і синк із Google
// його пропускають, доки лок не знімуть повторним натисканням.
const normLabel = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
type LockRow = typeof svodniLocksTable.$inferSelect;
async function monthLocks(month: string): Promise<LockRow[]> {
  return db.select().from(svodniLocksTable).where(eq(svodniLocksTable.periodMonth, month));
}
function isLocked(locks: LockRow[], city: string, factoryLabel: string | null): boolean {
  return locks.some(l => l.city === city
    && (l.factoryLabel === "" || (factoryLabel != null && normLabel(l.factoryLabel) === normLabel(factoryLabel))));
}

// toggle: перший виклик ставить лок, повторний — знімає
router.post("/svodni/lock", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  const city = String(req.body?.city ?? "").trim();
  const factoryLabel = String(req.body?.factoryLabel ?? "").trim(); // "" = усе місто
  if (!month || !city) return fail(res, 400, "month і city обовʼязкові");
  const existing = (await monthLocks(month)).find(l => l.city === city && l.factoryLabel === factoryLabel);
  if (existing) {
    await db.delete(svodniLocksTable).where(eq(svodniLocksTable.id, existing.id));
    return ok(res, { locked: false });
  }
  await db.insert(svodniLocksTable).values({ periodMonth: month, city, factoryLabel, lockedBy: req.admin!.adminId });
  ok(res, { locked: true });
});

router.get("/svodni/months", requireCap("svodni"), async (_req, res) => {
  // місяці: з рядків ∪ з реєстру джерел ∪ поточний і попередній — щоб порожню
  // сводну можна було почати (імпорт з Google або генерація з обліку годин)
  const rows = await db.selectDistinct({ m: svodniRowsTable.periodMonth }).from(svodniRowsTable);
  const { payrollSourcesTable } = await import("@workspace/db");
  const src = await db.selectDistinct({ m: payrollSourcesTable.periodMonth }).from(payrollSourcesTable);
  const months = new Set([...rows.map(x => x.m), ...src.map(x => x.m)]);
  const now = new Date();
  for (const d of [now, new Date(now.getFullYear(), now.getMonth() - 1, 1)]) {
    months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  ok(res, { months: [...months].sort().reverse() });
});

router.get("/svodni", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const city = String(req.query.city ?? "").trim() || null;
  const sensitive = canSensitive(req);

  const where = city
    ? and(eq(svodniRowsTable.periodMonth, month), eq(svodniRowsTable.city, city))
    : eq(svodniRowsTable.periodMonth, month);
  const raw = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName, workerLegal: workersTable.legalStatus, prefKind: workersTable.payoutPrefKind, prefValue: workersTable.payoutPrefValue })
    .from(svodniRowsTable)
    .leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
    .where(where)
    .orderBy(asc(svodniRowsTable.factoryLabel), asc(svodniRowsTable.sortIdx));

  // офісні вкладки і «Додаткові студенти» — лише із закритим доступом
  const tabAllowed = (label: string) => sensitive || (!OFFICE_TAB_RE.test(label) && label !== EXTRA_STUDENTS_LABEL);
  const rows = raw.filter(({ r }) => tabAllowed(r.factoryLabel))
    .map(({ r, workerName, workerLegal, prefKind, prefValue }) => serializeRow(r, workerName, sensitive, workerLegal, prefKind ? { kind: prefKind, value: prefValue ?? null } : null));

  const checks = (await db.select().from(svodniTabChecksTable).where(
    city
      ? and(eq(svodniTabChecksTable.periodMonth, month), eq(svodniTabChecksTable.city, city))
      : eq(svodniTabChecksTable.periodMonth, month)))
    .filter(c => tabAllowed(c.factoryLabel));

  // міста: з рядків місяця ∪ з реєстру джерел (payroll_sources) — щоб місто
  // без згенерованої сводної теж мало вкладку з кнопками синку/генерації
  const { payrollSourcesTable } = await import("@workspace/db");
  const monthSources = await db.select({ region: payrollSourcesTable.region })
    .from(payrollSourcesTable).where(eq(payrollSourcesTable.periodMonth, month));
  const citySet = new Set((await db.selectDistinct({ c: svodniRowsTable.city }).from(svodniRowsTable)
    .where(eq(svodniRowsTable.periodMonth, month))).map(x => x.c));
  for (const s of monthSources) {
    const c = cityOfRegion(s.region);
    if (c) citySet.add(c);
  }
  const cities = [...citySet]
    .filter(c => sensitive || c !== "Офіс") // віртуальне «місто» вкладки офісу
    .sort();

  // метадані вкладок: порядок колонок як у таблиці + інфо-блоки (STAWKA EUROCASH)
  const tabMeta = (await db.select().from(svodniTabMetaTable).where(
    city
      ? and(eq(svodniTabMetaTable.periodMonth, month), eq(svodniTabMetaTable.city, city))
      : eq(svodniTabMetaTable.periodMonth, month)))
    .filter(m => tabAllowed(m.factoryLabel))
    .map(m => ({ city: m.city, factoryLabel: m.factoryLabel, colOrder: m.colOrder, info: m.info }));

  const locks = (await monthLocks(month)).map(l => ({ city: l.city, factoryLabel: l.factoryLabel }));
  ok(res, { month, city, cities, rows, checks, tabMeta, sensitive, locks });
});

// незматчені люди: місто · фабрика · місяці + кандидати для привʼязки
router.get("/svodni/unmatched", requireCap("svodni"), async (_req, res) => {
  const rows = await db.select({
    rawName: svodniRowsTable.rawName, city: svodniRowsTable.city,
    factoryLabel: svodniRowsTable.factoryLabel, periodMonth: svodniRowsTable.periodMonth,
  }).from(svodniRowsTable).where(eq(svodniRowsTable.linkStatus, "unmatched"));
  const workers = dedupeWorkers(await db.select({ id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode, isActive: workersTable.isActive })
    .from(workersTable));
  const grouped = new Map<string, { rawName: string; city: string; factories: Set<string>; months: Set<string> }>();
  for (const r of rows) {
    const k = `${r.city}::${cleanName(r.rawName).toUpperCase()}`;
    const g = grouped.get(k) ?? grouped.set(k, { rawName: r.rawName, city: r.city, factories: new Set(), months: new Set() }).get(k)!;
    g.factories.add(r.factoryLabel);
    g.months.add(r.periodMonth);
  }
  const out = [...grouped.values()].map(g => ({
    rawName: g.rawName, city: g.city,
    factories: [...g.factories].sort(), months: [...g.months].sort(),
    candidates: matchWorker(cleanName(g.rawName), workers).candidates.slice(0, 4).map(w => ({ id: w.id, name: w.fullName })),
  })).sort((a, b) => a.city.localeCompare(b.city) || a.rawName.localeCompare(b.rawName));
  ok(res, { people: out });
});

// ручна привʼязка / «зовнішній» / скидання — на всі рядки цього імені в місті
router.post("/svodni/link", requireCap("svodni"), async (req, res) => {
  const rawName = String(req.body?.rawName ?? "").trim();
  const city = String(req.body?.city ?? "").trim();
  const workerId = req.body?.workerId != null ? Number(req.body.workerId) : null;
  const status = String(req.body?.status ?? "confirmed");
  if (!rawName || !city) return fail(res, 400, "rawName і city обовʼязкові");
  if (!["confirmed", "unmatched"].includes(status)) return fail(res, 400, "bad status");
  if (status === "confirmed" && !workerId) return fail(res, 400, "workerId обовʼязковий для confirmed");
  const all = await db.select({ id: svodniRowsTable.id, rawName: svodniRowsTable.rawName })
    .from(svodniRowsTable).where(eq(svodniRowsTable.city, city));
  const keyOf = (s: string) => cleanName(s).toUpperCase();
  const ids = all.filter(r => keyOf(r.rawName) === keyOf(rawName)).map(r => r.id);
  if (!ids.length) return fail(res, 404, "рядків не знайдено");
  await db.update(svodniRowsTable)
    .set({ workerId: status === "confirmed" ? workerId : null, linkStatus: status })
    .where(inArray(svodniRowsTable.id, ids));
  ok(res, { updated: ids.length });
});

// Інлайн-редагування клітинки. Рядок стає manual (синк його більше не чіпає).
// Компоненти виплати тягнуть перерахунок do wypłaty (і готівки, якщо відома
// офіційна частина); пряме редагування do wypłaty/brutto — «як введено».
const OPEN_NUM_FIELDS = new Set([
  "hoursNotified", "hours", "shifts", "rateBrutto", "rateNetto", "premia",
  "zaliczka", "zaliczkaBd", "hostel", "odziez", "dojazd", "kara", "komornik",
  "kaucja", "potracenia", "doWyplaty", "brutto",
]);
const SENS_NUM_FIELDS = new Set(["hoursDeclared", "ksiegBrutto", "ksiegNetto", "gotowka", "konto"]);
const TEXT_FIELDS = new Set(["rawName", "section"]);
// кадрові текстові поля (hr.*) + текстовий ZUS-статус у extras
const HR_TEXT_FIELDS = new Set([
  "zusStatus", "zaswiadczenieDo", "zaswiadczenieWystawione", "koniecStudiow",
  "wniosekZaliczki", "dataStart", "dataLiczymy", "dataWypowiedzenia",
  "dataUrodzenia", "dniOdpracowane", "status", "uwagi", "powOsw", "kontoNr",
  "stanowisko", "linia", "szkolenie", "nrOsobowy", "firma", "oddzial",
  "umowaOd", "umowaDo", "hoursText",
]);
const BOOL_FIELDS = new Set(["isStudent", "under26"]);
const EXTRA_FIELDS = new Set([
  "nocneH", "doplataNocna", "oplataKierowcy", "doplataEs", "badania", "nakladki",
  "zwrotKosztow", "kartaPobytu", "karaKlient", "karaEs", "zadluzenie", "migawka", "dokumenty", "workListHours",
  "premiaBase", "premiaAgram", "premiaEs", "ksiegHours", "kontoH", "gotowkaH", "godzFaktBlock", "zaliczkaBlock",
]);
// не компоненти виплати — правка не перераховує do wypłaty
// premiaEs тут НЕМАЄ: це бонус за годину (AGRAM) — входить у формулу виплати
const NON_PAYOUT_EXTRAS = new Set(["workListHours", "ksiegHours", "kontoH", "gotowkaH", "premiaBase", "premiaAgram", "godzFaktBlock", "zaliczkaBlock"]);
const PAYOUT_COMPONENTS = new Set([
  "hours", "rateNetto", "premia", "zaliczka", "zaliczkaBd", "hostel", "odziez",
  "dojazd", "kara", "komornik", "kaucja", "potracenia",
]);

// Додати людину в сводну фабрики: наявного працівника (рядок префілиться з
// профілю — ставки, студент, до-26, дата народження) або нового — тоді профіль
// створюється автоматично і далі заповнюється просто з таблиці.
router.post("/svodni/rows", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const periodMonth = validMonth(req.body?.periodMonth) ? String(req.body.periodMonth) : null;
  const city = String(req.body?.city ?? "").trim();
  const factoryLabel = String(req.body?.factoryLabel ?? "").trim();
  const workerId = req.body?.workerId != null ? Number(req.body.workerId) : null;
  const newName = String(req.body?.newWorkerName ?? "").trim();
  if (!periodMonth || !city || !factoryLabel) return fail(res, 400, "periodMonth, city, factoryLabel обовʼязкові");
  if (!workerId && !newName) return fail(res, 400, "вкажи працівника або імʼя нового");
  if ((OFFICE_TAB_RE.test(factoryLabel) || factoryLabel === EXTRA_STUDENTS_LABEL) && !canSensitive(req)) {
    return fail(res, 403, "forbidden");
  }
  if (isLocked(await monthLocks(periodMonth), city, factoryLabel)) return fail(res, 409, "Фабрику затверджено — спершу розблокуй");

  // фабрика/фірма з довідника (для нового працівника — його фабрика)
  const factories = await db.select().from(factoriesTable);
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const factory = factories.find(f => norm(f.name) === norm(factoryLabel))
    ?? factories.find(f => norm(f.name).startsWith(norm(factoryLabel)) || norm(factoryLabel).startsWith(norm(f.name)));
  const companies = await db.select().from(companiesTable);
  const firm = factory?.companyId ? companies.find(c => c.id === factory.companyId)?.name ?? null : null;

  let worker: typeof workersTable.$inferSelect | undefined;
  if (workerId) {
    [worker] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
    if (!worker) return fail(res, 404, "працівника не знайдено");
  } else {
    // захист від дублікатів: схоже імʼя вже в базі → 409; force=true створює свідомо
    if (!req.body?.force) {
      const likely = findLikelyDuplicate(newName, await db.select().from(workersTable));
      if (likely) {
        return res.status(409).json({
          error: `Схожий працівник уже є: ${likely.fullName} (№${likely.workerCode ?? likely.id}${likely.isActive ? "" : ", звільнений"})`,
          duplicate: { id: likely.id, fullName: likely.fullName, workerCode: likely.workerCode, isActive: likely.isActive },
        });
      }
    }
    // новий профіль: код — наступний вільний, фабрика/фірма — з цієї сводної
    const [codeRow] = await db.select({ max: sql<number>`coalesce(max(${workersTable.workerCode}::int), 0)` })
      .from(workersTable).where(sql`${workersTable.workerCode} ~ '^[0-9]+$'`);
    [worker] = await db.insert(workersTable).values({
      fullName: newName, workerCode: String((codeRow?.max ?? 0) + 1).padStart(5, "0"),
      factoryId: factory?.id ?? null, companyId: factory?.companyId ?? null,
    }).returning();
  }

  const [{ maxSort }] = await db.select({ maxSort: sql<number>`coalesce(max(${svodniRowsTable.sortIdx}), -1)` })
    .from(svodniRowsTable).where(and(
      eq(svodniRowsTable.periodMonth, periodMonth), eq(svodniRowsTable.city, city),
      eq(svodniRowsTable.factoryLabel, factoryLabel)));

  // префіл із профілю — властивості людини «їдуть» за нею між місяцями
  const under26 = worker!.birthDate ? isUnder26(worker!.birthDate) : worker!.under26;
  const hr: Record<string, string> = {};
  if (worker!.birthDate) {
    const [y, m, d] = worker!.birthDate.split("-");
    hr.dataUrodzenia = `${d}.${m}.${y}`;
  }
  const [created] = await db.insert(svodniRowsTable).values({
    periodMonth, city, firm, factoryLabel, factoryId: factory?.id ?? null,
    sortIdx: (maxSort ?? -1) + 1, rawName: worker!.fullName,
    workerId: worker!.id, linkStatus: "confirmed", manual: true,
    rateBrutto: worker!.hourlyRate ?? null, rateNetto: worker!.hourlyRateNetto ?? null,
    hoursNotified: worker!.notifyHours ?? null,
    isStudent: worker!.isStudent, under26,
    extras: {}, hr, sheetValues: {},
  }).returning();
  ok(res, serializeRow(created!, worker!.fullName, canSensitive(req), worker!.legalStatus));
});

router.delete("/svodni/rows/:id", requireCap("svodni"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, id));
  if (row && isLocked(await monthLocks(row.periodMonth), row.city, row.factoryLabel))
    return fail(res, 409, "Фабрику затверджено — спершу розблокуй");
  await db.delete(svodniRowsTable).where(eq(svodniRowsTable.id, id));
  ok(res, { ok: true });
});

// профільні властивості людини: правка в сводній оновлює профіль працівника
// (і навпаки — профіль префілиться при додаванні в наступні місяці)
async function syncWorkerProfile(workerId: number, field: string, merged: any) {
  const set: Partial<typeof workersTable.$inferInsert> = {};
  if (field === "rateBrutto" && merged.rateBrutto != null) set.hourlyRate = merged.rateBrutto;
  if (field === "rateNetto") set.hourlyRateNetto = merged.rateNetto;
  if (field === "isStudent" && merged.isStudent != null) set.isStudent = merged.isStudent;
  if (field === "under26" && merged.under26 != null) set.under26 = merged.under26;
  if (field === "hoursNotified") set.notifyHours = merged.hoursNotified ?? null;
  if (field === "extras.zusStatus") {
    // текст Księgowość → канонічна форма легалізації в профілі (якщо розпізнали)
    const ls = legalStatusOf(merged.extras?.zusStatus);
    if (ls) { set.legalStatus = ls; set.isStudent = ls === "student"; }
  }
  if (field === "hr.dataUrodzenia") {
    const raw = String(merged.hr?.dataUrodzenia ?? "").trim();
    const bd = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : parseSheetDate(raw);
    if (bd) { set.birthDate = bd; set.under26 = isUnder26(bd); }
  }
  if (Object.keys(set).length) await db.update(workersTable).set(set).where(eq(workersTable.id, workerId));
}

router.patch("/svodni/rows/:id", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const field = String(req.body?.field ?? "");
  const rawValue = req.body?.value;
  const isExtra = field.startsWith("extras.");
  const extraKey = isExtra ? field.slice(7) : null;
  const isHr = field.startsWith("hr.");
  const hrKey = isHr ? field.slice(3) : null;
  const isZusStatus = isExtra && extraKey === "zusStatus";
  const sensitiveField = SENS_NUM_FIELDS.has(field)
    || (isExtra && !!extraKey && SENSITIVE_EXTRAS.has(extraKey))
    || (isHr && hrKey === "kontoNr");
  if (sensitiveField && !canSensitive(req)) return fail(res, 403, "forbidden");
  if (!OPEN_NUM_FIELDS.has(field) && !sensitiveField && !TEXT_FIELDS.has(field) && !BOOL_FIELDS.has(field)
    && !(isExtra && extraKey && (EXTRA_FIELDS.has(extraKey) || isZusStatus))
    && !(isHr && hrKey && HR_TEXT_FIELDS.has(hrKey))) return fail(res, 400, "поле не редагується");

  const [row] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (isLocked(await monthLocks(row.periodMonth), row.city, row.factoryLabel))
    return fail(res, 409, "Фабрику затверджено — спершу розблокуй");

  const set: Record<string, unknown> = { manual: true, mismatch: null };
  const extras = { ...(row.extras as Record<string, unknown>) };
  if (isHr || isZusStatus) {
    const v = String(rawValue ?? "").trim();
    if (isHr) {
      const hr = { ...(row.hr as Record<string, unknown>) };
      if (v) hr[hrKey!] = v; else delete hr[hrKey!];
      set.hr = hr;
    } else {
      if (v) extras.zusStatus = v; else delete extras.zusStatus;
      set.extras = extras;
    }
    await db.update(svodniRowsTable).set(set as any).where(eq(svodniRowsTable.id, id));
    if (row.workerId) await syncWorkerProfile(row.workerId, field, { hr: set.hr ?? row.hr, extras: set.extras ?? row.extras });
    const [u] = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName, workerLegal: workersTable.legalStatus })
      .from(svodniRowsTable)
      .leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
      .where(eq(svodniRowsTable.id, id));
    return ok(res, serializeRow(u!.r, u!.workerName, canSensitive(req), u!.workerLegal));
  }
  if (TEXT_FIELDS.has(field)) {
    const v = String(rawValue ?? "").trim();
    if (field === "rawName" && !v) return fail(res, 400, "імʼя не може бути порожнім");
    set[field] = v || null;
  } else if (BOOL_FIELDS.has(field)) {
    set[field] = rawValue == null ? null : !!rawValue;
  } else {
    const v = rawValue === "" || rawValue == null ? null : Number(String(rawValue).replace(",", "."));
    if (v != null && !Number.isFinite(v)) return fail(res, 400, "не число");
    if (isExtra) {
      if (v == null) delete extras[extraKey!]; else extras[extraKey!] = v;
      set.extras = extras;
    } else set[field] = v;
  }

  // перерахунок похідних (сайт — джерело: mismatch скидається)
  const merged: any = { ...row, ...set, extras: set.extras ?? row.extras };
  const affectsPayout = PAYOUT_COMPONENTS.has(field) || (isExtra && !NON_PAYOUT_EXTRAS.has(extraKey!));
  if (affectsPayout) {
    const payout = computePayout(merged, row.city as any);
    if (payout != null) { set.doWyplaty = payout; merged.doWyplaty = payout; }
    if ((field === "hours" || field === "rateBrutto") && merged.hours != null && merged.rateBrutto != null) {
      set.brutto = Math.round(merged.hours * merged.rateBrutto * 100) / 100;
    }
    // фабричні формули Godzin Faktycznie (Eurocash: /30,5; Sushi: (виплата+zaliczka)/24,6 і BRUTTO = godz×30,5)
    const kh = computeKsiegHours(row.factoryLabel, merged);
    if (kh) {
      const extras2 = { ...(set.extras as Record<string, unknown> ?? row.extras as Record<string, unknown>) };
      extras2.ksiegHours = kh.ksiegHours;
      set.extras = extras2;
      merged.extras = extras2;
      if (kh.brutto != null) { set.brutto = kh.brutto; merged.brutto = kh.brutto; }
    }
  }
  // статусні правила бухгалтерії (студент до 26 → конто; не зголошений → готівка;
  // год. oświadczenia → конто, решта готівкою): перераховуються і від компонентів
  // виплати, і від правки «Год. повід.» / студент / до-26
  const affectsLegal = affectsPayout || field === "hoursNotified" || BOOL_FIELDS.has(field);
  if (affectsLegal && !OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
    let profileLegal: string | null = null;
    let payoutPref: { kind: "all_konto" | "hours" | "amount"; value: number | null } | null = null;
    if (row.workerId) {
      const [pw] = await db.select({ ls: workersTable.legalStatus, pk: workersTable.payoutPrefKind, pv: workersTable.payoutPrefValue })
        .from(workersTable).where(eq(workersTable.id, row.workerId));
      profileLegal = pw?.ls ?? null;
      payoutPref = pw?.pk ? { kind: pw.pk as any, value: pw.pv ?? null } : null;
    }
    applyLegalDefaults(merged, true, { profileLegal: profileLegal as any, factoryLabel: row.factoryLabel, payoutPref });
    for (const k of ["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
      if (merged[k] !== row[k]) set[k] = merged[k];
    }
  }
  // księgowa частина: години księg. → netto/brutto зі ставок; konto ↔ ksiegNetto;
  // готівка = до виплати − ksiegNetto (+ Dopłata ES) — та сама формула, що в таблиці
  const rnd = (n: number) => Math.round(n * 100) / 100;
  if (field === "hoursDeclared" && merged.hoursDeclared != null) {
    // ручні księg. години → по księgowій парі ставок (бонус понад стандартну
    // пару в конто не входить), а не по платіжних ставках рядка
    const kr = ksiegRatesOf(merged, legalStatusOf(merged.extras?.zusStatus) ?? null);
    if (kr.netto != null) { merged.ksiegNetto = rnd(merged.hoursDeclared * kr.netto); set.ksiegNetto = merged.ksiegNetto; set.konto = merged.ksiegNetto; }
    if (kr.brutto != null) { merged.ksiegBrutto = rnd(merged.hoursDeclared * kr.brutto); set.ksiegBrutto = merged.ksiegBrutto; }
  }
  if (field === "konto") { merged.ksiegNetto = merged.konto; set.ksiegNetto = merged.konto; }
  if (field === "ksiegNetto") set.konto = merged.ksiegNetto;
  const touchesKsieg = ["hoursDeclared", "ksiegNetto", "ksiegBrutto", "konto"].includes(field);
  if ((affectsPayout || touchesKsieg) && merged.ksiegNetto != null && merged.doWyplaty != null) {
    const doplata = typeof merged.extras?.doplataEs === "number" ? merged.extras.doplataEs : 0;
    set.gotowka = rnd(merged.doWyplaty - merged.ksiegNetto + doplata);
  }

  await db.update(svodniRowsTable).set(set as any).where(eq(svodniRowsTable.id, id));
  if (row.workerId) await syncWorkerProfile(row.workerId, field, merged);
  const [updated] = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName, workerLegal: workersTable.legalStatus })
    .from(svodniRowsTable)
    .leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
    .where(eq(svodniRowsTable.id, id));
  ok(res, serializeRow(updated!.r, updated!.workerName, canSensitive(req), updated!.workerLegal));
});

// «Години підтверджені → до сводної»: створює/оновлює сводну місяця з обліку
// годин (сайт — джерело). Береться ЛИШЕ облік годин (рапорт місяця пріоритетно,
// інакше затверджені явки) і профіль працівника (ставки/статуси/дата народження/
// год. повідомлення). Аванси, штрафи, хостел тощо поки вписуються вручну в
// сводній — формули перерахують. Google-таблиці тут не використовуються.
router.post("/svodni/from-hours", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  // опційні фільтри: одна фабрика або ціле місто (без них — весь місяць)
  const onlyFactoryId = req.body?.factoryId != null ? Number(req.body.factoryId) : null;
  const onlyCity = String(req.body?.city ?? "").trim() || null;
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;

  // 1) фактичні години по парі (працівник, фабрика): явки затверджених тижнів
  const { scheduleEntriesTable, scheduleWeeksTable } = await import("@workspace/db");
  const { weekFromForMonth, entryDateStr } = await import("../lib/dates");
  const { factoryShiftHours } = await import("../bot/time");
  const facRows = await db.select().from(factoriesTable);
  const facById = new Map(facRows.map(f => [f.id, f]));
  const att = await db.select({
    workerId: scheduleEntriesTable.workerId, factoryId: scheduleEntriesTable.factoryId,
    shift: scheduleEntriesTable.shift, hoursOverride: scheduleEntriesTable.hoursOverride,
    day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart,
  }).from(scheduleEntriesTable)
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(
      eq(scheduleWeeksTable.status, "approved"), eq(scheduleEntriesTable.status, "present"),
      sql`${scheduleWeeksTable.weekStart} >= ${weekFromForMonth(monthStart)}`, sql`${scheduleWeeksTable.weekStart} < ${monthEnd}`,
    ));
  const key2 = (w: number, f: number | null) => `${w}|${f ?? 0}`;
  const hoursByPair = new Map<string, { workerId: number; factoryId: number | null; hours: number }>();
  for (const r of att) {
    if (!r.workerId) continue;
    const date = entryDateStr(String(r.weekStart), r.day);
    if (date < monthStart || date >= monthEnd) continue;
    const cur = hoursByPair.get(key2(r.workerId, r.factoryId))
      ?? hoursByPair.set(key2(r.workerId, r.factoryId), { workerId: r.workerId, factoryId: r.factoryId, hours: 0 }).get(key2(r.workerId, r.factoryId))!;
    cur.hours += r.hoursOverride ?? factoryShiftHours(r.factoryId != null ? facById.get(r.factoryId) : undefined, r.shift as any);
  }
  // 2) рапорти місяця — пріоритет над явками (та сама політика, що у фінансах)
  const { monthlyReportsTable } = await import("@workspace/db");
  const reports = await db.select().from(monthlyReportsTable).where(eq(monthlyReportsTable.month, month));
  for (const r of reports) {
    const k = key2(r.workerId, r.factoryId);
    const cur = hoursByPair.get(k) ?? hoursByPair.set(k, { workerId: r.workerId, factoryId: r.factoryId, hours: 0 }).get(k)!;
    cur.hours = r.hoursReported;
  }

  // 3) профілі та місто фабрики (з історії сводних)
  const cityRows = await db.select({ factoryId: svodniRowsTable.factoryId, city: svodniRowsTable.city, id: svodniRowsTable.id })
    .from(svodniRowsTable).where(sql`${svodniRowsTable.factoryId} IS NOT NULL`).orderBy(desc(svodniRowsTable.id));
  const cityByFactory = new Map<number, string>();
  for (const c of cityRows) if (c.factoryId != null && !cityByFactory.has(c.factoryId)) cityByFactory.set(c.factoryId, c.city);
  const cityOf = (factoryId: number | null) => (factoryId != null ? cityByFactory.get(factoryId) : null) ?? "Люблін";

  // фільтри «одна фабрика» / «ціле місто» + пропуск затверджених фабрик/міст
  const locks = await monthLocks(month);
  let skippedLocked = 0;
  for (const [k, pair] of [...hoursByPair]) {
    if (onlyFactoryId != null && pair.factoryId !== onlyFactoryId) { hoursByPair.delete(k); continue; }
    if (onlyCity && cityOf(pair.factoryId) !== onlyCity) { hoursByPair.delete(k); continue; }
    const label = pair.factoryId != null ? facById.get(pair.factoryId)?.name ?? "Без фабрики" : "Без фабрики";
    if (isLocked(locks, cityOf(pair.factoryId), label)) { hoursByPair.delete(k); skippedLocked++; }
  }

  const workerIds = [...new Set([...hoursByPair.values()].map(p => p.workerId))];
  if (!workerIds.length) {
    return fail(res, 400, skippedLocked ? "усе вибране затверджено (🔒) — спершу розблокуй" : "немає підтверджених годин у вибраному");
  }
  const workers = await db.select().from(workersTable).where(inArray(workersTable.id, workerIds));
  const wById = new Map(workers.map(w => [w.id, w]));
  // становіска: назва позиції працівника → секція рядка (для фабрик з посадами)
  const positions = await db.select().from(positionsTable);
  const posById = new Map(positions.map(p => [p.id, p.name]));

  // системні джерела відрахувань: виплачені аванси місяця → Zaliczka,
  // зняття за хостел (вкладка «Хостели») → Hostel
  const advances = await db.select().from(advanceRequestsTable).where(and(
    inArray(advanceRequestsTable.workerId, workerIds), eq(advanceRequestsTable.status, "paid"),
    sql`${advanceRequestsTable.paidAt} >= ${monthStart}`, sql`${advanceRequestsTable.paidAt} < ${monthEnd}`,
  ));
  const advByWorker = new Map<number, number>();
  for (const a of advances) advByWorker.set(a.workerId, (advByWorker.get(a.workerId) ?? 0) + a.amount);
  const hostels = await db.select().from(hostelDeductionsTable).where(and(
    eq(hostelDeductionsTable.periodMonth, month), inArray(hostelDeductionsTable.workerId, workerIds),
  ));
  const hostelByWorker = new Map<number, number>();
  for (const h of hostels) hostelByWorker.set(h.workerId, (hostelByWorker.get(h.workerId) ?? 0) + h.amount);

  const existing = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.periodMonth, month));
  const existByKey = new Map(existing.map(r => [`${r.workerId ?? 0}|${r.factoryLabel}`, r]));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let created = 0, updated = 0, skippedNoRate = 0;
  for (const pair of hoursByPair.values()) {
    const w = wById.get(pair.workerId);
    if (!w) continue;
    const fac = pair.factoryId != null ? facById.get(pair.factoryId) : undefined;
    const factoryLabel = fac?.name ?? "Без фабрики";
    const city = cityOf(pair.factoryId);
    // становіско (секція): позиція з профілю — для фабрик, що ведуть посади
    const section = fac?.usesPositions && w.positionId != null ? posById.get(w.positionId) ?? null : null;
    const prev = existByKey.get(`${pair.workerId}|${factoryLabel}`);
    if (prev) {
      // повторне підтвердження: оновлюємо години + системні відрахування
      // (аванси/хостели — їх джерело тепер система), перераховуємо формули;
      // інші ручні правки (кари, odzież…) не затираються
      const zal = advByWorker.get(pair.workerId);
      const hos = hostelByWorker.get(pair.workerId);
      const merged: any = {
        ...prev, hours: r2(pair.hours),
        zaliczka: zal != null ? r2(zal) : prev.zaliczka,
        hostel: hos != null ? r2(hos) : prev.hostel,
      };
      const payout = computePayout(merged, city as any);
      if (payout != null) merged.doWyplaty = payout;
      if (merged.hours != null && merged.rateBrutto != null) merged.brutto = r2(merged.hours * merged.rateBrutto);
      applyLegalDefaults(merged, true, { profileLegal: (w.legalStatus ?? null) as any, factoryLabel, payoutPref: w.payoutPrefKind ? { kind: w.payoutPrefKind as any, value: w.payoutPrefValue ?? null } : null });
      await db.update(svodniRowsTable).set({
        hours: merged.hours, zaliczka: merged.zaliczka, hostel: merged.hostel,
        doWyplaty: merged.doWyplaty, brutto: merged.brutto,
        hoursDeclared: merged.hoursDeclared, ksiegBrutto: merged.ksiegBrutto,
        ksiegNetto: merged.ksiegNetto, konto: merged.konto, gotowka: merged.gotowka,
        section: section ?? prev.section,
        manual: true, mismatch: null,
      }).where(eq(svodniRowsTable.id, prev.id));
      updated++;
      continue;
    }
    const hr: Record<string, string> = {};
    if (w.birthDate) { const [yy, mm, dd] = w.birthDate.split("-"); hr.dataUrodzenia = `${dd}.${mm}.${yy}`; }
    const under26 = w.birthDate ? isUnder26(w.birthDate) : w.under26;
    const row: any = {
      periodMonth: month, city, firm: null, factoryLabel, factoryId: pair.factoryId,
      section, sortIdx: created, rawName: w.fullName, workerId: w.id, linkStatus: "confirmed",
      manual: true, // сайт — джерело: синк із Google цей рядок не перезаписує
      hoursNotified: w.notifyHours ?? null, hours: r2(pair.hours),
      rateBrutto: w.hourlyRate ?? null, rateNetto: w.hourlyRateNetto ?? null,
      zaliczka: advByWorker.has(pair.workerId) ? r2(advByWorker.get(pair.workerId)!) : null,
      hostel: hostelByWorker.has(pair.workerId) ? r2(hostelByWorker.get(pair.workerId)!) : null,
      isStudent: w.isStudent, under26,
      extras: {}, hr, sheetValues: {}, mismatch: null,
      doWyplaty: null, brutto: null,
    };
    if (row.rateNetto == null) skippedNoRate++;
    row.doWyplaty = computePayout(row, city as any);
    if (row.hours != null && row.rateBrutto != null) row.brutto = r2(row.hours * row.rateBrutto);
    applyLegalDefaults(row, true, { profileLegal: (w.legalStatus ?? null) as any, factoryLabel, payoutPref: w.payoutPrefKind ? { kind: w.payoutPrefKind as any, value: w.payoutPrefValue ?? null } : null });
    await db.insert(svodniRowsTable).values(row);
    created++;
  }
  ok(res, { month, created, updated, workers: workerIds.length, noNettoRate: skippedNoRate, skippedLocked });
});

// ── Хостели: зняття з ЗП за місяць (джерело колонки Hostel у сводній) ────────
router.get("/hostels", requireCap("svodni"), async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const rows = await db.select({ h: hostelDeductionsTable, workerName: workersTable.fullName, factoryName: factoriesTable.name })
    .from(hostelDeductionsTable)
    .leftJoin(workersTable, eq(hostelDeductionsTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(hostelDeductionsTable.factoryId, factoriesTable.id))
    .where(eq(hostelDeductionsTable.periodMonth, month));
  const months = await db.selectDistinct({ m: hostelDeductionsTable.periodMonth }).from(hostelDeductionsTable);
  ok(res, {
    month,
    months: months.map(x => x.m).sort().reverse(),
    rows: rows.map(({ h, workerName, factoryName }) => ({
      id: h.id, workerId: h.workerId, workerName, city: h.city,
      factoryId: h.factoryId, factoryLabel: factoryName ?? h.factoryLabel, amount: h.amount, note: h.note,
    })).sort((a, b) => (a.city ?? "").localeCompare(b.city ?? "") || (a.factoryLabel ?? "").localeCompare(b.factoryLabel ?? "") || (a.workerName ?? "").localeCompare(b.workerName ?? "", "pl")),
  });
});
router.post("/hostels", requireCap("svodni"), async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  const workerId = Number(req.body?.workerId);
  const amount = Number(req.body?.amount);
  if (!month || !Number.isFinite(workerId) || !Number.isFinite(amount) || amount <= 0) {
    return fail(res, 400, "month, workerId і сума > 0 обовʼязкові");
  }
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return fail(res, 404, "працівника не знайдено");
  const [fac] = w.factoryId != null ? await db.select().from(factoriesTable).where(eq(factoriesTable.id, w.factoryId)) : [];
  const cityRow = w.factoryId != null
    ? (await db.select({ city: svodniRowsTable.city }).from(svodniRowsTable)
        .where(eq(svodniRowsTable.factoryId, w.factoryId)).orderBy(desc(svodniRowsTable.id)).limit(1))[0]
    : undefined;
  const [created] = await db.insert(hostelDeductionsTable).values({
    periodMonth: month, workerId, amount: Math.round(amount * 100) / 100,
    city: cityRow?.city ?? "Люблін", factoryId: w.factoryId, factoryLabel: fac?.name ?? null,
    note: String(req.body?.note ?? "").trim() || null,
  }).returning();
  ok(res, created);
});
router.patch("/hostels/:id", requireCap("svodni"), async (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(id) || !Number.isFinite(amount) || amount <= 0) return fail(res, 400, "сума > 0");
  const [u] = await db.update(hostelDeductionsTable).set({ amount: Math.round(amount * 100) / 100 })
    .where(eq(hostelDeductionsTable.id, id)).returning();
  ok(res, u ?? {});
});
router.delete("/hostels/:id", requireCap("svodni"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(hostelDeductionsTable).where(eq(hostelDeductionsTable.id, id));
  ok(res, { ok: true });
});

router.post("/svodni/rematch", requireCap("svodni"), async (_req, res) => {
  ok(res, await rematchSvodni());
});

// синк із Google (книги місяців з реєстру /payroll) + фабрики;
// опційно city — тягне лише джерела цього міста; затверджені вкладки пропускаються
router.post("/svodni/sync", requireCap("svodni"), async (req, res) => {
  const months: string[] = Array.isArray(req.body?.months) ? req.body.months.filter(validMonth) : [];
  if (!months.length) return fail(res, 400, "months=[YYYY-MM,…] обовʼязково");
  const city = String(req.body?.city ?? "").trim() || null;
  try {
    const { syncSvodni } = await import("../services/svodniSync");
    const result = await syncSvodni(months, { city });
    const factories = await ensureSvodniFactories();
    ok(res, { result, factories });
  } catch (e) {
    logger.error({ err: e }, "svodni sync failed");
    fail(res, 500, "Помилка синхронізації");
  }
});

// ── Excel-експорт сводної: весь місяць / місто / фабрика, з вибором колонок ──
// Документ польською (правило проєкту). Сенситивні колонки — лише з svodniSensitive.
const XLS_COLS: { key: string; header: string; sensitive?: boolean; get: (r: any) => unknown }[] = [
  { key: "name", header: "Nazwisko i imię", get: r => r.workerName ?? r.rawName },
  { key: "section", header: "Stanowisko", get: r => r.section },
  { key: "hoursNotified", header: "Ilość godz w powiadomieniu", get: r => r.hoursNotified },
  { key: "hours", header: "Ilość godzin", get: r => r.hours },
  { key: "shifts", header: "Ilość zmian", get: r => r.shifts },
  { key: "rateBrutto", header: "Stawka brutto", get: r => r.rateBrutto },
  { key: "rateNetto", header: "Stawka netto", get: r => r.rateNetto },
  { key: "premia", header: "Premia", get: r => r.premia },
  { key: "zaliczka", header: "Zaliczka", get: r => r.zaliczka },
  { key: "zaliczkaBd", header: "Zaliczka BD", get: r => r.zaliczkaBd },
  { key: "hostel", header: "Hostel", get: r => r.hostel },
  { key: "odziez", header: "Odzież", get: r => r.odziez },
  { key: "dojazd", header: "Dojazd", get: r => r.dojazd },
  { key: "kara", header: "Kara", get: r => r.kara },
  { key: "komornik", header: "Komornik", get: r => r.komornik },
  { key: "kaucja", header: "Kaucja", get: r => r.kaucja },
  { key: "potracenia", header: "Potrącenia", get: r => r.potracenia },
  { key: "brutto", header: "Brutto", get: r => r.brutto },
  { key: "doWyplaty", header: "Do wypłaty", get: r => r.doWyplaty },
  { key: "legalStatus", header: "Księgowość", get: r => (r.extras as any)?.zusStatus ?? r.legalStatus },
  { key: "hoursDeclared", header: "Godziny księgowość", sensitive: true, get: r => r.hoursDeclared },
  { key: "ksiegBrutto", header: "Księg. brutto", sensitive: true, get: r => r.ksiegBrutto },
  { key: "ksiegNetto", header: "Księg. netto", sensitive: true, get: r => r.ksiegNetto },
  { key: "konto", header: "Konto", sensitive: true, get: r => r.konto },
  { key: "gotowka", header: "Gotówka", sensitive: true, get: r => r.gotowka },
  { key: "kontoNr", header: "Nr konta", sensitive: true, get: r => (r.hr as any)?.kontoNr },
];

router.get("/svodni/excel", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const city = String(req.query.city ?? "").trim() || null;
  const factory = String(req.query.factory ?? "").trim() || null;
  const sensitive = canSensitive(req);
  const wanted = String(req.query.cols ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const cols = XLS_COLS.filter(c =>
    (sensitive || !c.sensitive) && (!wanted.length || c.key === "name" || wanted.includes(c.key)));

  const where = [eq(svodniRowsTable.periodMonth, month)];
  if (city) where.push(eq(svodniRowsTable.city, city));
  const raw = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName, workerLegal: workersTable.legalStatus })
    .from(svodniRowsTable)
    .leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
    .where(and(...where))
    .orderBy(asc(svodniRowsTable.city), asc(svodniRowsTable.factoryLabel), asc(svodniRowsTable.sortIdx));
  const tabAllowedX = (label: string) => sensitive || (!OFFICE_TAB_RE.test(label) && label !== EXTRA_STUDENTS_LABEL);
  const rows = raw
    .filter(({ r }) => tabAllowedX(r.factoryLabel))
    .filter(({ r }) => !factory || normLabel(r.factoryLabel) === normLabel(factory))
    .map(({ r, workerName, workerLegal }) => ({
      ...r, workerName,
      legalStatus: legalStatusOf((r.extras as any)?.zusStatus) ?? workerLegal ?? null,
    }));
  if (!rows.length) return fail(res, 404, "немає рядків за вибором");

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const byFactory = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.city} · ${r.factoryLabel}`;
    (byFactory.get(k) ?? byFactory.set(k, []).get(k)!).push(r);
  }
  const collator = new Intl.Collator("pl");
  for (const [label, list] of byFactory) {
    // назва вкладки: обрізаємо заборонені символи Excel і 31 символ ліміту
    const ws = wb.addWorksheet(label.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
    ws.addRow(["Lp", ...cols.map(c => c.header)]).font = { bold: true };
    // секції-становіска, всередині — за алфавітом; без секції — в кінець
    const sections = new Map<string, typeof list>();
    for (const r of list) (sections.get(r.section ?? "") ?? sections.set(r.section ?? "", []).get(r.section ?? "")!).push(r);
    const sectionKeys = [...sections.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : collator.compare(a, b)));
    let lp = 1;
    for (const sec of sectionKeys) {
      if (sec && sections.size > 1) {
        const row = ws.addRow([sec]);
        row.font = { bold: true };
        ws.mergeCells(row.number, 1, row.number, cols.length + 1);
      }
      const people = sections.get(sec)!.sort((a, b) => collator.compare(String(a.workerName ?? a.rawName), String(b.workerName ?? b.rawName)));
      for (const r of people) ws.addRow([lp++, ...cols.map(c => c.get(r) ?? "")]);
    }
    // сумарний рядок по числових колонках
    const sums = cols.map(c => list.reduce((a, r) => {
      const v = c.get(r);
      return typeof v === "number" ? a + v : a;
    }, 0));
    const totalRow = ws.addRow(["", ...cols.map((c, i) => ["name", "section", "legalStatus", "kontoNr", "rateBrutto", "rateNetto"].includes(c.key) ? "" : Math.round(sums[i]! * 100) / 100)]);
    totalRow.font = { bold: true };
    ws.getCell(totalRow.number, 1).value = "Razem";
    ws.columns.forEach((col, i) => { col.width = i === 1 ? 32 : 14; });
  }
  const buffer = await wb.xlsx.writeBuffer();
  const namePart = factory ?? city ?? "wszystkie";
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`Zestawienie ${namePart} ${month}.xlsx`)}"`);
  res.send(Buffer.from(buffer));
});

// застосувати ставки/студент/до-26 місяця до профілів працівників (фінансова дія)
router.post("/svodni/apply-rates", requireCap("viewFinance"), async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  ok(res, await applyRatesFromSvodni(month));
});

export default router;

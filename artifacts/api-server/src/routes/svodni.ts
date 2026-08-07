// «Сводні» (/svodni) — повне дзеркало зарплатних таблиць по містах.
// Доступ: capability `svodni` (сторінка, відкритий шар: фактичні години,
// ставки, відрахування, до виплати); закритий шар (księgowość-години,
// ksieg brutto/netto, готівка, конто) віддається ЛИШЕ з `svodniSensitive`
// (owner бачить усе) — фільтрація тут, в API, а не в інтерфейсі.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { svodniRowsTable, svodniTabChecksTable, svodniTabMetaTable, svodniLocksTable, workersTable, factoriesTable, factoryPositionsTable, companiesTable, hostelDeductionsTable, advanceRequestsTable, positionsTable, workerChangesTable, factoryHoursTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import { hasCap } from "../lib/roles";
import { logger } from "../lib/logger";
import { matchWorker, findLikelyDuplicate } from "../bot/workerMatch";
import { cleanName } from "../services/payrollSummaries";
import { rematchSvodni, applyRatesFromSvodni, ensureSvodniFactories, dedupeWorkers, parseSheetDate, isUnder26, cityOfRegion, factoryCityMap, OFFICE_TAB_RE, EXTRA_STUDENTS_LABEL } from "../services/svodniSync";
import { computePayout, legalStatusOf, normalizeProfileLegal, applyLegalDefaults, ksiegRatesOf, KSIEG_STD_NETTO, KSIEG_STD_BRUTTO, AGRAM_FACTORY_IDS, CASH_BONUS_FACTORY_IDS, EUROCASH_FACTORY_IDS, eurocashRatesFromBlock, eurocashBracketIndex, agramBonusPerHour, factoryBonusPerHour, resolveBaseRates, monthEndStr, splitTotalByWindows, computeSegmented, SEG_SHARE_COLS, type RateRules, type SegmentCalcIn, type EurocashRates } from "../services/svodni";
import { loadRateRules } from "../services/rateRules";
import { addDaysStr } from "../lib/dates";

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
    mismatch: r.mismatch, rowColor: r.rowColor, note: r.note,
    // форма легалізації: з тексту Księgowość рядка, fallback — профіль працівника
    // (профільні значення нормалізуються: у БД живуть і старі ключі на кшталт
    // oswiadczenie/student_do26 — без нормалізації веб-бейдж їх не знає)
    legalStatus: legalStatusOf((r.extras as Record<string, unknown>).zusStatus as string) ?? normalizeProfileLegal(workerLegal) ?? null,
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

// Додає до серіалізованого рядка його сегменти (порізка місяця) — щоб відповіді
// PATCH не затирали сегменти в кеші вебу (він замінює рядок цілком)
async function withSegments(base: Record<string, unknown>, rowId: number, sensitive = true, workerLegal: string | null = null): Promise<Record<string, unknown>> {
  const segs = await db.select().from(svodniRowsTable)
    .where(eq(svodniRowsTable.segmentOf, rowId)).orderBy(asc(svodniRowsTable.segmentFrom));
  if (segs.length) {
    base.segments = segs.map(s => ({
      ...serializeRow(s, null, sensitive, ((s.extras as Record<string, unknown>)?.segLegal as string | undefined) ?? workerLegal),
      from: s.segmentFrom, to: s.segmentTo, label: s.segmentLabel,
    }));
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
  // офісні вкладки і «Додаткові студенти» живуть у віртуальному місті «Офіс»
  // (рядки тримають реальне місто) — лок з вкладки «Офіс» має їх матчити
  const effCity = factoryLabel != null && (OFFICE_TAB_RE.test(factoryLabel) || factoryLabel === EXTRA_STUDENTS_LABEL)
    ? "Офіс" : city;
  return locks.some(l => l.city === effCity
    && (l.factoryLabel === "" || (factoryLabel != null && normLabel(l.factoryLabel) === normLabel(factoryLabel))));
}

// Лок фіксує вік «до 26» на момент затвердження сводної (правило: вік
// студента — на дату виплати ≈ дату закріплення). Поки сводна відкрита,
// прапор рахується «на сьогодні»; тут — останній перерахунок для тих, кому
// 26 виповнилося між розрахунком і затвердженням, далі рядки заморожені.
async function freezeUnder26AtLock(month: string, lock: Pick<LockRow, "city" | "factoryLabel">, priorLocks: LockRow[]): Promise<void> {
  const rows = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.periodMonth, month), isNotNull(svodniRowsTable.workerId)));
  const ids = [...new Set(rows.map(r => r.workerId!))];
  if (!ids.length) return;
  const ws = await db.select().from(workersTable).where(inArray(workersTable.id, ids));
  const wById = new Map(ws.map(w => [w.id, w]));
  const segParents = new Set(rows.filter(r => r.segmentOf != null).map(r => r.segmentOf!));
  const ruleOf = await loadRateRules();
  const toRecalc = new Set<number>();
  for (const row of rows) {
    const w = wById.get(row.workerId!);
    if (!w?.birthDate) continue;
    if (!isLocked([lock as LockRow], row.city, row.factoryLabel)) continue; // не в скоупі цього лока
    if (isLocked(priorLocks, row.city, row.factoryLabel)) continue; // вже був заморожений іншим локом
    const u = isUnder26(w.birthDate);
    if ((row.under26 ?? null) === u) continue;
    if (segParents.has(row.id)) {
      // порізаний батько: прапор оновлюємо, гроші перерахує recomputeSegmentedParent
      await db.update(svodniRowsTable).set({ under26: u }).where(eq(svodniRowsTable.id, row.id));
      toRecalc.add(row.id);
    } else if (row.segmentOf != null) {
      // сегмент: прапор + студентська ставка вікна (нетто = брутто ↔ оподаткована)
      const set: Record<string, unknown> = { under26: u };
      const stud26was = row.isStudent === true && row.under26 === true;
      const stud26now = row.isStudent === true && u;
      if (stud26was !== stud26now) {
        const resolved = resolveBaseRates(w, ruleOf(row.factoryId, w.positionId), stud26now);
        // 160-годинний гейт стажу — від МІСЯЧНИХ годин (батьківський рядок), не сегмента
        const parentHours = rows.find(p => p.id === row.segmentOf)?.hours ?? row.hours;
        const bonus = stud26now ? 0 : factoryBonusPerHour(w, row.factoryId, row.periodMonth, parentHours);
        set.rateNetto = stud26now
          ? (resolved.brutto ?? row.rateBrutto ?? row.rateNetto)
          : resolved.netto != null ? Math.round((resolved.netto + bonus) * 100) / 100 : row.rateNetto;
      }
      await db.update(svodniRowsTable).set(set).where(eq(svodniRowsTable.id, row.id));
      toRecalc.add(row.segmentOf);
    } else {
      // звичайний рядок: та сама машинерія, що й зміна дати народження у профілі
      const { set } = rowSetFromProfile(row, w, new Set(["birthDate"]), undefined, ruleOf(row.factoryId, w.positionId));
      delete set.extras; // hr/extras не чіпаємо — міняється лише вік і похідні
      if (Object.keys(set).length) {
        await db.update(svodniRowsTable).set({ ...set, manual: true }).where(eq(svodniRowsTable.id, row.id));
      }
    }
  }
  for (const pid of toRecalc) await recomputeSegmentedParent(pid);
}

// toggle: перший виклик ставить лок, повторний — знімає
router.post("/svodni/lock", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  const city = String(req.body?.city ?? "").trim();
  const factoryLabel = String(req.body?.factoryLabel ?? "").trim(); // "" = усе місто
  if (!month || !city) return fail(res, 400, "month і city обовʼязкові");
  const locks = await monthLocks(month);
  const existing = locks.find(l => l.city === city && l.factoryLabel === factoryLabel);
  if (existing) {
    await db.delete(svodniLocksTable).where(eq(svodniLocksTable.id, existing.id));
    return ok(res, { locked: false });
  }
  await freezeUnder26AtLock(month, { city, factoryLabel }, locks);
  await db.insert(svodniLocksTable).values({ periodMonth: month, city, factoryLabel, lockedBy: req.admin!.adminId });
  ok(res, { locked: true });
});

// ── Налаштування сводних: мінімальна ставка року (księgowa пара) ─────────────
router.get("/svodni/settings", requireCap("svodni"), async (_req, res) => {
  const { KSIEG_STD_NETTO, KSIEG_STD_BRUTTO } = await import("../services/svodni");
  ok(res, { minNetto: KSIEG_STD_NETTO(), minBrutto: KSIEG_STD_BRUTTO() });
});
router.put("/svodni/settings", requireCap("viewFinance"), async (req, res) => {
  const netto = Number(String(req.body?.minNetto ?? "").replace(",", "."));
  const brutto = Number(String(req.body?.minBrutto ?? "").replace(",", "."));
  if (!Number.isFinite(netto) || netto <= 0 || !Number.isFinite(brutto) || brutto <= 0) {
    return fail(res, 400, "мінімальні ставки мають бути додатними числами");
  }
  const { saveKsiegMinRates } = await import("../services/svodniSettings");
  await saveKsiegMinRates(netto, brutto);
  ok(res, { minNetto: netto, minBrutto: brutto });
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
  // сегменти (порізка місяця) вкладаються в батьківський рядок, у списку їх нема
  const segsOf = new Map<number, typeof raw>();
  for (const x of raw) {
    if (x.r.segmentOf == null) continue;
    const l = segsOf.get(x.r.segmentOf) ?? []; l.push(x); segsOf.set(x.r.segmentOf, l);
  }
  const rows = raw.filter(({ r }) => r.segmentOf == null && tabAllowed(r.factoryLabel))
    .map(({ r, workerName, workerLegal, prefKind, prefValue }) => {
      const base = serializeRow(r, workerName, sensitive, workerLegal, prefKind ? { kind: prefKind, value: prefValue ?? null } : null);
      const segs = segsOf.get(r.id);
      if (segs?.length) {
        // сегмент — повний рядок (усі колонки: до виплати, konto, готівка, частки
        // відрахувань) + період; форма легалізації — своя (extras.segLegal)
        base.segments = segs
          .sort((a, b) => (a.r.segmentFrom! < b.r.segmentFrom! ? -1 : 1))
          .map(s => ({
            ...serializeRow(s.r, workerName, sensitive, ((s.r.extras as Record<string, unknown>)?.segLegal as string | undefined) ?? workerLegal),
            from: s.r.segmentFrom, to: s.r.segmentTo, label: s.r.segmentLabel,
          }));
      }
      return base;
    });

  // Фірма рядка: явна (книги Лодзі / заголовок вкладки при синку) → з фабрики
  // рядка (factories.company_id). svodni_rows.firm у більшості міст порожня,
  // а веб фарбує вкладки фабрик за фірмою саме з цього поля.
  const facFirm = new Map((await db.select({ id: factoriesTable.id, name: companiesTable.name })
    .from(factoriesTable).innerJoin(companiesTable, eq(factoriesTable.companyId, companiesTable.id))).map(x => [x.id, x.name]));
  for (const r of rows) if (!r.firm && r.factoryId != null) r.firm = facFirm.get(r.factoryId as number) ?? null;

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

  const lockRows = await monthLocks(month);
  const locks = lockRows.map(l => ({ city: l.city, factoryLabel: l.factoryLabel }));
  // «є зміни після затвердження»: у журналі профілів зʼявились зміни, що діють
  // у цьому місяці, для людей із залоченої області — лок варто переглянути
  const staleLocks: { city: string; factoryLabel: string }[] = [];
  if (lockRows.length) {
    const workerIds = [...new Set(raw.map(({ r }) => r.workerId).filter((x): x is number => x != null))];
    if (workerIds.length) {
      // строго ДО першого числа наступного місяця: "-31" валить date-каст
      // Postgres у коротких місяцях (30/28 днів)
      const [sy, sm] = month.split("-").map(Number);
      const nextMonthStart = sm === 12 ? `${sy! + 1}-01-01` : `${sy}-${String(sm! + 1).padStart(2, "0")}-01`;
      const changes = await db.select().from(workerChangesTable).where(and(
        inArray(workerChangesTable.workerId, workerIds),
        sql`${workerChangesTable.effectiveDate} < ${nextMonthStart}`));
      for (const l of lockRows) {
        const stale = raw.some(({ r }) => r.workerId != null
          && isLocked([l], r.city, r.factoryLabel)
          && changes.some(c => c.workerId === r.workerId && c.createdAt > l.lockedAt));
        if (stale) staleLocks.push({ city: l.city, factoryLabel: l.factoryLabel });
      }
    }
  }
  const { KSIEG_STD_NETTO, KSIEG_STD_BRUTTO } = await import("../services/svodni");
  ok(res, { month, city, cities, rows, checks, tabMeta, sensitive, locks, staleLocks, ksiegMin: { netto: KSIEG_STD_NETTO(), brutto: KSIEG_STD_BRUTTO() } });
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
  // бонусні фабрики (Agram нал+стаж, LST нал): до профільної ставки додається бонус
  const facBonus = factory != null ? factoryBonusPerHour(worker!, factory.id, periodMonth, null) : 0;
  const prefillNetto = worker!.hourlyRateNetto != null
    ? Math.round((worker!.hourlyRateNetto + facBonus) * 100) / 100
    : null;
  const [created] = await db.insert(svodniRowsTable).values({
    periodMonth, city, firm, factoryLabel, factoryId: factory?.id ?? null,
    sortIdx: (maxSort ?? -1) + 1, rawName: worker!.fullName,
    workerId: worker!.id, linkStatus: "confirmed", manual: true,
    rateBrutto: worker!.hourlyRate ?? null, rateNetto: prefillNetto,
    hoursNotified: worker!.notifyHours ?? null,
    isStudent: worker!.isStudent, under26,
    extras: {}, hr, sheetValues: {},
  }).returning();
  ok(res, serializeRow(created!, worker!.fullName, canSensitive(req), worker!.legalStatus, worker!.payoutPrefKind ? { kind: worker!.payoutPrefKind, value: worker!.payoutPrefValue ?? null } : null));
});

// обʼєднати сегменти назад в один рядок: сегменти зносяться, батько
// перераховується по власних (min) ставках; далі ставки можна правити як звичайно
router.post("/svodni/rows/:id/unsplit", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (isLocked(await monthLocks(row.periodMonth), row.city, row.factoryLabel))
    return fail(res, 409, "Фабрику затверджено — спершу розблокуй");
  await db.delete(svodniRowsTable).where(eq(svodniRowsTable.segmentOf, id));
  const rnd2 = (n: number) => Math.round(n * 100) / 100;
  const merged: any = { ...row };
  const payout = computePayout(merged, row.city as any);
  if (payout != null) merged.doWyplaty = payout;
  if (merged.hours != null && merged.rateBrutto != null) merged.brutto = rnd2(merged.hours * merged.rateBrutto);
  let w: typeof workersTable.$inferSelect | undefined;
  if (row.workerId != null) [w] = await db.select().from(workersTable).where(eq(workersTable.id, row.workerId));
  if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
    applyLegalDefaults(merged, true, {
      profileLegal: (w?.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, city: row.city,
      payoutPref: w?.payoutPrefKind ? { kind: w.payoutPrefKind as any, value: w.payoutPrefValue ?? null } : null,
    });
  }
  await db.update(svodniRowsTable).set({
    doWyplaty: merged.doWyplaty, brutto: merged.brutto,
    hoursDeclared: merged.hoursDeclared, ksiegBrutto: merged.ksiegBrutto,
    ksiegNetto: merged.ksiegNetto, konto: merged.konto, gotowka: merged.gotowka,
    manual: true, mismatch: null,
  }).where(eq(svodniRowsTable.id, id));
  ok(res, { ok: true });
});

router.delete("/svodni/rows/:id", requireCap("svodni"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, id));
  if (row?.segmentOf != null)
    return fail(res, 400, "це сегмент порізки — обʼєднай рядок або редагуй сегменти");
  if (row && isLocked(await monthLocks(row.periodMonth), row.city, row.factoryLabel))
    return fail(res, 409, "Фабрику затверджено — спершу розблокуй");
  await db.delete(svodniRowsTable).where(eq(svodniRowsTable.id, id)); // сегменти йдуть каскадом (FK)
  ok(res, { ok: true });
});

// профільні властивості людини: правка в сводній оновлює профіль працівника
// (і навпаки — профіль префілиться при додаванні в наступні місяці)
async function syncWorkerProfile(workerId: number, field: string, merged: any) {
  const set: Partial<typeof workersTable.$inferInsert> = {};
  if (field === "rateBrutto" && merged.rateBrutto != null) set.hourlyRate = merged.rateBrutto;
  if (field === "rateNetto") {
    // бонусні фабрики (Agram/LST): у рядку ставка з бонусами, у профілі тримаємо
    // БАЗУ — інакше наступний from-hours додав би бонус ще раз. Студенту до 26
    // бонус у ставку НЕ входив (нетто = брутто) — віднімати нічого
    let netto = merged.rateNetto;
    const stud26Row = merged.isStudent === true && merged.under26 === true;
    if (netto != null && !stud26Row && merged.factoryId != null && CASH_BONUS_FACTORY_IDS.has(merged.factoryId)) {
      const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
      if (w) netto = Math.round(Math.max(0, netto - factoryBonusPerHour(w, merged.factoryId, merged.periodMonth, merged.hours)) * 100) / 100;
    }
    set.hourlyRateNetto = netto;
  }
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

// ── Сегменти всередині місяця ────────────────────────────────────────────────
// Людина з різними умовами в різні періоди місяця (посада/ставка змінилась з
// дати): батьківський рядок тримає суми і місячний розклад konto/готівки,
// рядки-сегменти — свої години/ставки/base. Порізка годин — по датах явок;
// рапортна сума ділиться пропорційно явкам у вікнах (без явок — по днях).
type SegRow = typeof svodniRowsTable.$inferSelect;
type SegState = { rateNetto: number | null; rateBrutto: number | null; section: string | null; isStudent: boolean | null; under26: boolean | null; label: string | null; legal: string | null };

function windowsBetween(month: string, boundaries: string[]): { from: string; to: string }[] {
  const start = `${month}-01`, end = monthEndStr(month);
  const bs = [...new Set(boundaries)].filter(b => b > start && b <= end).sort();
  const froms = [start, ...bs];
  return froms.map((f, i) => ({ from: f, to: i < bs.length ? addDaysStr(froms[i + 1]!, -1) : end }));
}

// фактичні години явок (затверджені тижні, present) по вікнах місяця
async function attendanceByWindows(
  workerId: number | null, factoryId: number | null, month: string,
  windows: { from: string; to: string }[],
): Promise<number[]> {
  const out = windows.map(() => 0);
  if (workerId == null) return out;
  const { scheduleEntriesTable, scheduleWeeksTable } = await import("@workspace/db");
  const { weekFromForMonth, entryDateStr } = await import("../lib/dates");
  const { factoryShiftHours } = await import("../bot/time");
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  const fac = factoryId != null ? (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0] : undefined;
  const att = await db.select({
    shift: scheduleEntriesTable.shift, hoursOverride: scheduleEntriesTable.hoursOverride,
    day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart,
    factoryId: scheduleEntriesTable.factoryId,
  }).from(scheduleEntriesTable)
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(
      eq(scheduleEntriesTable.workerId, workerId),
      eq(scheduleWeeksTable.status, "approved"), eq(scheduleEntriesTable.status, "present"),
      sql`${scheduleWeeksTable.weekStart} >= ${weekFromForMonth(monthStart)}`, sql`${scheduleWeeksTable.weekStart} < ${monthEnd}`,
    ));
  for (const r of att) {
    if ((r.factoryId ?? null) !== (factoryId ?? null)) continue; // «Без фабрики» ≠ всі фабрики
    const date = entryDateStr(String(r.weekStart), r.day);
    if (date < monthStart || date >= monthEnd) continue;
    const idx = windows.findIndex(w => date >= w.from && date <= w.to);
    if (idx < 0) continue;
    out[idx] = out[idx]! + (r.hoursOverride ?? factoryShiftHours(fac, r.shift as any));
  }
  return out.map(h => Math.round(h * 100) / 100);
}

// План порізки рядка: вікна + години кожного + значення (стан до/після зміни)
async function planSegments(
  parent: SegRow, existingSegs: SegRow[], boundaries: string[],
  stateAt: (windowFrom: string) => SegState,
): Promise<{ windows: { from: string; to: string }[]; parts: (SegState & { hours: number; manualHours?: boolean })[] } | null> {
  const allBounds = [...existingSegs.map(s => s.segmentFrom!).filter(Boolean), ...boundaries];
  const windows = windowsBetween(parent.periodMonth, allBounds);
  if (windows.length < 2) return null;
  const att = await attendanceByWindows(parent.workerId, parent.factoryId, parent.periodMonth, windows);
  const total = parent.hours ?? Math.round(att.reduce((a, b) => a + b, 0) * 100) / 100;
  if (!total) return null; // без годин різати нічого
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // «липкі» ручні години: вікно, що точно збігається з наявним сегментом із
  // вручну вписаними годинами, тримає їх — авторозподіл ділить лише решту.
  // (Сегмент, який нова межа ріже навпіл, «ручність» втрачає — число вже не його.)
  const monthEnd = monthEndStr(parent.periodMonth);
  const manuals = windows.map(wn => {
    const seg = existingSegs.find(s => s.segmentFrom === wn.from && (s.segmentTo ?? monthEnd) === wn.to);
    return seg && (seg.extras as Record<string, unknown>)?.manualHours && seg.hours != null ? seg.hours : null;
  });
  const manualSum = manuals.reduce<number>((a, b) => a + (b ?? 0), 0);
  const autoIdx = windows.map((_, i) => i).filter(i => manuals[i] == null);
  const autoTotal = Math.max(r2(total - manualSum), 0);
  const autoSplit = autoIdx.length
    ? splitTotalByWindows(autoTotal, autoIdx.map(i => ({ ...windows[i]!, attHours: att[i]! })))
    : [];
  const hoursPerWin = windows.map((_, i) => manuals[i] ?? autoSplit[autoIdx.indexOf(i)] ?? 0);
  // сусідні вікна з ІДЕНТИЧНИМИ умовами зшиваються (відкат зміни зливає
  // розбивку; вирівнявся весь місяць → лишиться одне вікно = unsplit)
  // статуси порівнюємо НОРМАЛІЗОВАНО: у профілях живуть легасі-ключі
  // (oswiadczenie = powiadomienie, student_do26 = student) — без нормалізації
  // однакові по суті вікна не зшивались
  const sameLegal = (a: string | null, b: string | null) =>
    (normalizeProfileLegal(a) ?? a ?? null) === (normalizeProfileLegal(b) ?? b ?? null);
  const same = (a: SegState, b: SegState) =>
    a.rateNetto === b.rateNetto && a.rateBrutto === b.rateBrutto && a.section === b.section
    && a.isStudent === b.isStudent && a.under26 === b.under26
    && sameLegal(a.legal, b.legal) && (a.label ?? null) === (b.label ?? null);
  const mWindows: { from: string; to: string }[] = [];
  const mParts: (SegState & { hours: number; manualHours?: boolean })[] = [];
  windows.forEach((wn, i) => {
    const part = { ...stateAt(wn.from), hours: hoursPerWin[i]!, manualHours: manuals[i] != null };
    const prev = mParts[mParts.length - 1];
    if (prev && same(prev, part)) {
      prev.hours = r2(prev.hours + part.hours);
      prev.manualHours = prev.manualHours || part.manualHours;
      mWindows[mWindows.length - 1]!.to = wn.to;
    } else {
      mWindows.push({ ...wn });
      mParts.push(part);
    }
  });
  return { windows: mWindows, parts: mParts };
}

// стан «до зміни» на дату: сегмент, що покриває дату, інакше сам батьківський
// рядок; форма легалізації — з сегмента (extras.segLegal) / тексту Księgowość /
// профілю ДО зміни
function oldStateAt(parent: SegRow, existingSegs: SegRow[], oldProfileLegal: string | null): (date: string) => SegState {
  return (date) => {
    const seg = existingSegs.find(s => s.segmentFrom! <= date && date <= (s.segmentTo ?? "9999"));
    const src = seg ?? parent;
    const raw = (seg?.extras as any)?.segLegal as string | undefined;
    const legal = seg && raw !== undefined
      ? (raw || null) // "" = явно без статусу
      : legalStatusOf(String((parent.extras as any)?.zusStatus ?? "")) ?? oldProfileLegal;
    return { rateNetto: src.rateNetto, rateBrutto: src.rateBrutto, section: src.section, isStudent: src.isStudent, under26: src.under26, label: seg?.segmentLabel ?? null, legal: legal ?? null };
  };
}

// вхід computeSegmented з батьківського рядка БД
function segParentInput(row: SegRow) {
  return {
    city: row.city, factoryLabel: row.factoryLabel, hoursNotified: row.hoursNotified,
    premia: row.premia, zaliczka: row.zaliczka, zaliczkaBd: row.zaliczkaBd, hostel: row.hostel,
    odziez: row.odziez, dojazd: row.dojazd, kara: row.kara, komornik: row.komornik,
    kaucja: row.kaucja, potracenia: row.potracenia,
    extras: (row.extras ?? {}) as Record<string, unknown>,
  };
}

// Перерахунок порізаного рядка новим двигуном: кожен сегмент — «міні-місяць»
// (свій doWyplaty, свій розклад konto/готівки за правилами свого статусу,
// частка місячних відрахувань), батько = сума сегментів (computeSegmented)
async function recomputeSegmentedParent(parentId: number): Promise<void> {
  const [parent] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, parentId));
  if (!parent) return;
  const segs = await db.select().from(svodniRowsTable)
    .where(eq(svodniRowsTable.segmentOf, parentId)).orderBy(asc(svodniRowsTable.segmentFrom));
  if (!segs.length) return;
  let w: typeof workersTable.$inferSelect | undefined;
  if (parent.workerId != null) [w] = await db.select().from(workersTable).where(eq(workersTable.id, parent.workerId));
  const calc = computeSegmented(
    segParentInput(parent),
    segs.map((s): SegmentCalcIn => {
      const raw = (s.extras as any)?.segLegal as string | undefined;
      return {
        hours: s.hours, rateNetto: s.rateNetto, rateBrutto: s.rateBrutto,
        isStudent: s.isStudent, under26: s.under26,
        // "" = явно без статусу; відсутній ключ (старі рядки) — поточний профіль
        legal: raw !== undefined ? (raw || null) : (w?.legalStatus ?? null),
      };
    }),
    w?.payoutPrefKind ? { kind: w.payoutPrefKind as any, value: w.payoutPrefValue ?? null } : null,
  );
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!, c = calc.segs[i]!;
    const shareSet: Record<string, unknown> = {};
    for (const k of SEG_SHARE_COLS) shareSet[k] = c.alloc[k] ?? null;
    await db.update(svodniRowsTable).set({
      ...shareSet,
      hoursNotified: c.hoursNotified,
      extras: {
        ...c.extras,
        ...((s.extras as any)?.segLegal !== undefined ? { segLegal: (s.extras as any).segLegal } : {}),
        ...((s.extras as any)?.manualHours ? { manualHours: true } : {}), // «липкі» години переживають перерахунок
      },
      doWyplaty: c.doWyplaty, brutto: c.brutto,
      hoursDeclared: c.hoursDeclared, ksiegBrutto: c.ksiegBrutto, ksiegNetto: c.ksiegNetto,
      konto: c.konto, gotowka: c.gotowka, manual: true, mismatch: null,
    } as any).where(eq(svodniRowsTable.id, s.id));
  }
  await db.update(svodniRowsTable).set({
    hours: calc.parent.hours, rateNetto: calc.parent.rateNetto, rateBrutto: calc.parent.rateBrutto,
    brutto: calc.parent.brutto, doWyplaty: calc.parent.doWyplaty,
    hoursDeclared: calc.parent.hoursDeclared, ksiegBrutto: calc.parent.ksiegBrutto,
    ksiegNetto: calc.parent.ksiegNetto, konto: calc.parent.konto, gotowka: calc.parent.gotowka,
    manual: true, mismatch: null,
  }).where(eq(svodniRowsTable.id, parentId));
}

// записати сегменти за планом (зносить старі) і перерахувати батька
async function writeSegments(parent: SegRow, plan: NonNullable<Awaited<ReturnType<typeof planSegments>>>): Promise<void> {
  // атомарно: конкурентний виклик/збій не має лишити рядок без сегментів
  // або з задубльованими
  await db.transaction(async (tx) => {
  await tx.delete(svodniRowsTable).where(eq(svodniRowsTable.segmentOf, parent.id));
  for (let i = 0; i < plan.windows.length; i++) {
    const win = plan.windows[i]!, p = plan.parts[i]!;
    await tx.insert(svodniRowsTable).values({
      periodMonth: parent.periodMonth, city: parent.city, firm: parent.firm,
      factoryLabel: parent.factoryLabel, factoryId: parent.factoryId,
      sortIdx: parent.sortIdx, section: p.section, rawName: parent.rawName,
      workerId: parent.workerId, linkStatus: parent.linkStatus, manual: true,
      hours: p.hours, rateNetto: p.rateNetto, rateBrutto: p.rateBrutto,
      isStudent: p.isStudent, under26: p.under26,
      // segLegal завжди явний: "" = «без статусу» (не плутати з відсутнім,
      // який означав би «взяти поточний профіль»); manualHours — «липкі» години
      extras: { segLegal: p.legal ?? "", ...(p.manualHours ? { manualHours: true } : {}) },
      hr: {}, sheetValues: {}, mismatch: null,
      segmentOf: parent.id, segmentFrom: win.from, segmentTo: win.to, segmentLabel: p.label,
    });
  }
  });
  await recomputeSegmentedParent(parent.id);
}

// ── Пропагація зміни профілю у сводні від дати («зміна з датою набуття») ─────
// Поля профілю, які можна міняти з пропагацією; нормалізація значень.
const LEGAL_SET = new Set(["student", "dyplom", "powiadomienie", "zus", "oczekuje", "karta_pobytu", "staly_pobyt", "polak"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FINANCE_TRACKED = new Set(["hourlyRate", "hourlyRateNetto"]);
function normTrackedChanges(body: Record<string, unknown>): { patch: Partial<typeof workersTable.$inferInsert>; err?: string } {
  const patch: any = {};
  const has = (k: string) => body[k] !== undefined;
  const s = (v: unknown) => (v == null ? null : String(v).trim() || null);
  const n = (v: unknown) => { const x = v == null || v === "" ? null : Number(String(v).replace(",", ".")); return x != null && !Number.isFinite(x) ? undefined : x; };
  if (has("legalStatus")) {
    const ls = s(body.legalStatus);
    if (ls && !LEGAL_SET.has(ls)) return { patch, err: "Невідома форма легалізації" };
    patch.legalStatus = ls;
    // статус керує прапорцем студента, включно з очищенням: «—» ≠ студент
    patch.isStudent = ls === "student";
  }
  if (has("birthDate")) {
    const bd = s(body.birthDate);
    if (bd && !DATE_RE.test(bd)) return { patch, err: "Дата народження — YYYY-MM-DD" };
    patch.birthDate = bd;
    if (bd) patch.under26 = isUnder26(bd);
  }
  if (has("employmentStartDate")) {
    const d = s(body.employmentStartDate);
    if (d && !DATE_RE.test(d)) return { patch, err: "Дата працевлаштування — YYYY-MM-DD" };
    patch.employmentStartDate = d;
  }
  if (has("notifyHours")) { const v = n(body.notifyHours); if (v === undefined || (v != null && v < 0)) return { patch, err: "Год. повідомлення — число" }; patch.notifyHours = v; }
  if (has("hourlyRate")) { const v = n(body.hourlyRate); if (v == null || v <= 0) return { patch, err: "Ставка брутто — число > 0" }; patch.hourlyRate = v; }
  if (has("hourlyRateNetto")) { const v = n(body.hourlyRateNetto); if (v === undefined || (v != null && v <= 0)) return { patch, err: "Ставка нетто — число > 0" }; patch.hourlyRateNetto = v; }
  if (has("agramStazBonus")) patch.agramStazBonus = !!body.agramStazBonus;
  if (has("agramCashBonus")) patch.agramCashBonus = !!body.agramCashBonus;
  if (has("isStudent")) patch.isStudent = !!body.isStudent;
  if (has("positionId")) {
    const v = body.positionId == null ? null : Number(body.positionId);
    if (v != null && !Number.isFinite(v)) return { patch, err: "Невідома посада" };
    patch.positionId = v;
  }
  if (has("payoutPrefKind")) {
    const k = s(body.payoutPrefKind);
    if (k && !["all_konto", "hours", "amount"].includes(k)) return { patch, err: "Невідомий тип побажання" };
    patch.payoutPrefKind = k;
    if (!k) patch.payoutPrefValue = null;
  }
  if (has("payoutPrefValue")) { const v = n(body.payoutPrefValue); if (v === undefined || (v != null && v < 0)) return { patch, err: "Значення побажання — число" }; patch.payoutPrefValue = v; }
  return { patch };
}

// Приведення рядка сводної до профілю w з урахуванням того, ЩО саме змінилось
// (changed): мапінг полів профілю → поля рядка + перерахунок похідних тим самим
// шляхом, що правка клітинки (computePayout → applyLegalDefaults). Повертає
// set для UPDATE і людський дифф для превʼю.
type RowDiff = { key: string; from: unknown; to: unknown };
function rowSetFromProfile(
  row: typeof svodniRowsTable.$inferSelect,
  w: typeof workersTable.$inferSelect,
  changed: Set<string>,
  sectionLabel: string | null | undefined, // undefined = посаду не міняли
  rules: RateRules = {}, // правила фабричних ставок (fallback, коли профіль порожній)
): { set: Record<string, unknown>; diffs: RowDiff[]; merged: any } {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const merged: any = { ...row, extras: { ...(row.extras as Record<string, unknown>) }, hr: { ...(row.hr as Record<string, string>) } };
  const isBonusFac = row.factoryId != null && CASH_BONUS_FACTORY_IDS.has(row.factoryId);
  if (changed.has("birthDate")) {
    // вік «до 26» — на момент розрахунку (наближення дати виплати); лок фіксує остаточно
    merged.under26 = w.birthDate ? isUnder26(w.birthDate) : w.under26;
    if (w.birthDate) { const [yy, mm, dd] = w.birthDate.split("-"); merged.hr.dataUrodzenia = `${dd}.${mm}.${yy}`; }
    else delete merged.hr.dataUrodzenia;
  }
  if (changed.has("legalStatus") || changed.has("isStudent")) {
    merged.isStudent = w.legalStatus != null ? w.legalStatus === "student" : w.isStudent;
    // текст Księgowość із таблиці більше не має перекривати профіль
    delete merged.extras.zusStatus;
    if (w.birthDate) merged.under26 = isUnder26(w.birthDate);
  }
  if (changed.has("notifyHours")) merged.hoursNotified = w.notifyHours ?? null;
  if (sectionLabel !== undefined) merged.section = sectionLabel;
  // ставки: явна зміна ставки або будь-що, що впливає на фабричний бонус/студентство
  const rateAffected = changed.has("hourlyRate") || changed.has("hourlyRateNetto")
    || (isBonusFac && ["agramStazBonus", "agramCashBonus", "employmentStartDate"].some(k => changed.has(k)))
    || ["legalStatus", "isStudent", "birthDate"].some(k => changed.has(k));
  if (rateAffected) {
    const stud26 = merged.isStudent === true && merged.under26 === true;
    const base = resolveBaseRates(w, rules, stud26);
    if (changed.has("hourlyRate")) merged.rateBrutto = w.hourlyRate ?? base.brutto;
    const statusTouched = changed.has("legalStatus") || changed.has("isStudent") || changed.has("birthDate");
    if (isBonusFac) {
      // бонусні фабрики (Agram нал+стаж, LST нал): бонус поверх бази;
      // студент до 26 неоподаткований — нетто = брутто БЕЗ бонусів
      const b = stud26 ? (base.brutto ?? merged.rateBrutto ?? null) : (base.netto ?? KSIEG_STD_NETTO());
      if (b != null) merged.rateNetto = r2(b + (stud26 ? 0 : factoryBonusPerHour(w, row.factoryId, row.periodMonth, row.hours)));
    } else if (stud26 && statusTouched) {
      // студент до 26 неоподаткований: нетто = брутто («як є»)
      if (merged.rateBrutto ?? base.brutto) merged.rateNetto = merged.rateBrutto ?? base.brutto;
    } else if (!stud26 && row.isStudent === true && row.under26 === true && statusTouched
      && base.netto != null) {
      // був студентом (нетто = брутто) → став звичайним: оподаткована профільна/фабрична
      merged.rateNetto = base.netto;
    } else if (changed.has("hourlyRateNetto") && (w.hourlyRateNetto ?? base.netto) != null) {
      merged.rateNetto = w.hourlyRateNetto ?? base.netto;
    }
  }
  // похідні: до виплати/брутто + місячний розклад konto/готівки за правилами
  const payout = computePayout(merged, row.city as any);
  if (payout != null) merged.doWyplaty = payout;
  if (merged.hours != null && merged.rateBrutto != null) merged.brutto = r2(merged.hours * merged.rateBrutto);
  if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
    applyLegalDefaults(merged, true, {
      profileLegal: (w.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, city: row.city,
      payoutPref: w.payoutPrefKind ? { kind: w.payoutPrefKind as any, value: w.payoutPrefValue ?? null } : null,
    });
  }
  const set: Record<string, unknown> = {};
  const diffs: RowDiff[] = [];
  const numish = (v: unknown) => typeof v === "number" ? r2(v) : v ?? null;
  for (const k of ["hoursNotified", "rateBrutto", "rateNetto", "isStudent", "under26", "section",
    "doWyplaty", "brutto", "hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
    if (numish(merged[k]) !== numish((row as any)[k])) { set[k] = merged[k] ?? null; diffs.push({ key: k, from: (row as any)[k], to: merged[k] ?? null }); }
  }
  if (JSON.stringify(merged.extras) !== JSON.stringify(row.extras)) {
    set.extras = merged.extras;
    const oldZus = (row.extras as any)?.zusStatus;
    if (oldZus && !merged.extras.zusStatus) diffs.push({ key: "zusStatus", from: oldZus, to: null });
  }
  if (JSON.stringify(merged.hr) !== JSON.stringify(row.hr)) {
    set.hr = merged.hr;
    if ((merged.hr as any).dataUrodzenia !== (row.hr as any)?.dataUrodzenia)
      diffs.push({ key: "dataUrodzenia", from: (row.hr as any)?.dataUrodzenia ?? null, to: (merged.hr as any).dataUrodzenia ?? null });
  }
  return { set, diffs, merged };
}

// Спільна частина impact/apply: рядки людини від місяця дати + дифи по кожному
async function profileChangeContext(workerId: number, body: Record<string, unknown>, from: string, sensitive: boolean) {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return { err: "працівника не знайдено" } as const;
  const { patch, err } = normTrackedChanges((body.changes ?? {}) as Record<string, unknown>);
  if (err) return { err } as const;
  if (!Object.keys(patch).length) return { err: "нема змін" } as const;
  const changed = new Set(Object.keys(patch));
  const nextW = { ...w, ...patch } as typeof workersTable.$inferSelect;
  const fromMonth = from.slice(0, 7);
  const rows = (await db.select().from(svodniRowsTable).where(and(
    eq(svodniRowsTable.workerId, workerId), isNull(svodniRowsTable.segmentOf),
    sql`${svodniRowsTable.periodMonth} >= ${fromMonth}`)))
    // офісні вкладки і «Додаткові студенти» — лише із закритим доступом
    // (як у GET /svodni): не показувати і не давати редагувати через apply
    .filter(r => sensitive || (!OFFICE_TAB_RE.test(r.factoryLabel) && r.factoryLabel !== EXTRA_STUDENTS_LABEL));
  // наявні сегменти батьківських рядків (для повторної порізки/старих значень)
  const segsByParent = new Map<number, SegRow[]>();
  if (rows.length) {
    const segs = await db.select().from(svodniRowsTable)
      .where(inArray(svodniRowsTable.segmentOf, rows.map(r => r.id)));
    for (const s of segs) { const l = segsByParent.get(s.segmentOf!) ?? []; l.push(s); segsByParent.set(s.segmentOf!, l); }
  }
  const ruleOf = await loadRateRules();
  // посада → секція (лише фабрики, що ведуть посади); без посади — найдешевша
  // посада фабрики рядка (дзеркало from-hours: ставка безпосадних і так від неї)
  let sectionOf: (row: typeof svodniRowsTable.$inferSelect) => string | null | undefined = () => undefined;
  if (changed.has("positionId")) {
    const facs = await db.select().from(factoriesTable);
    const facById = new Map(facs.map(f => [f.id, f]));
    const positions = await db.select().from(positionsTable);
    const posById = new Map(positions.map(p => [p.id, p.name]));
    sectionOf = (row) => {
      if (row.factoryId == null || !facById.get(row.factoryId)?.usesPositions) return undefined;
      const pid = nextW.positionId ?? ruleOf(row.factoryId, null).cheapestPositionId ?? null;
      return pid != null ? posById.get(pid) ?? null : null;
    };
  }
  const locksByMonth = new Map<string, LockRow[]>();
  for (const month of new Set(rows.map(r => r.periodMonth))) locksByMonth.set(month, await monthLocks(month));
  // зміна з середини місяця по полях, що міняють умови оплати → перший
  // зачеплений місяць ріжеться на сегменти (до дати — старі умови, з дати — нові)
  const SPLIT_FIELDS = new Set(["hourlyRate", "hourlyRateNetto", "positionId", "legalStatus", "isStudent", "birthDate", "agramStazBonus", "agramCashBonus", "employmentStartDate"]);
  const wantsSplit = Number(from.slice(8, 10)) > 1 && [...changed].some(k => SPLIT_FIELDS.has(k));
  const items: {
    row: SegRow; set?: Record<string, unknown>; diffs: RowDiff[]; locked: boolean;
    plan?: NonNullable<Awaited<ReturnType<typeof planSegments>>>;
    split?: { from: string; to: string; hours: number; rateNetto: number | null; label: string | null; legal: string | null; doWyplaty: number | null; konto: number | null; gotowka: number | null }[];
    unsplit?: boolean; // умови вирівнялись по всьому місяцю — сегменти зшиваються
  }[] = [];
  for (const row of rows) {
    const locked = isLocked(locksByMonth.get(row.periodMonth) ?? [], row.city, row.factoryLabel);
    const { set, diffs, merged } = rowSetFromProfile(row, nextW, changed, sectionOf(row), ruleOf(row.factoryId, nextW.positionId));
    // сегментний шлях: (а) зміна з середини першого місяця → порізка;
    // (б) рядок УЖЕ порізаний → нові умови застосовуються до сегментів
    // від дати (батько ніколи не пишеться повз сегменти)
    const existingSegs = (segsByParent.get(row.id) ?? []);
    if ((wantsSplit && row.periodMonth === fromMonth) || existingSegs.length) {
      const existing = existingSegs.sort((a, b) => (a.segmentFrom! < b.segmentFrom! ? -1 : 1));
      const oldAt = oldStateAt(row, existing, w.legalStatus ?? null);
      // ОВЕРЛЕЙ, не заміна: до стану кожного вікна ≥ from застосовуються лише
      // ЗМІНЕНІ аспекти — вікна, що кодують ПІЗНІШІ зміни (інша ставка з 15-го),
      // зберігають свої відмінності й не «зшиваються» ранішою зміною
      const r2o = (n: number) => Math.round(n * 100) / 100;
      const isBonusRow = row.factoryId != null && CASH_BONUS_FACTORY_IDS.has(row.factoryId);
      const rowRules = ruleOf(row.factoryId, nextW.positionId);
      const legalChanged = changed.has("legalStatus") || changed.has("isStudent");
      const overlay = (base: SegState): SegState => {
        const st: SegState = { ...base };
        if (legalChanged) {
          st.legal = nextW.legalStatus ?? null;
          st.isStudent = nextW.legalStatus != null ? nextW.legalStatus === "student" : !!nextW.isStudent;
        }
        if (changed.has("birthDate")) st.under26 = nextW.birthDate ? isUnder26(nextW.birthDate) : nextW.under26;
        if (changed.has("positionId")) { st.section = sectionOf(row) ?? null; st.label = sectionOf(row) ?? null; }
        const stud26w = st.isStudent === true && st.under26 === true;
        const resolved = resolveBaseRates(nextW, rowRules, stud26w);
        if (changed.has("hourlyRate") && (nextW.hourlyRate ?? resolved.brutto) != null) st.rateBrutto = nextW.hourlyRate ?? resolved.brutto;
        const baseStud26 = base.isStudent === true && base.under26 === true;
        // ставку вікна перераховуємо лише коли її реально зачеплено: явна зміна
        // ставки, бонусні поля (Agram/LST) або зміна студентства САМЕ цього вікна
        const rateTouched = changed.has("hourlyRate") || changed.has("hourlyRateNetto")
          || (isBonusRow && ["agramStazBonus", "agramCashBonus", "employmentStartDate"].some(k => changed.has(k)))
          || stud26w !== baseStud26;
        if (rateTouched) {
          if (isBonusRow) {
            const b = stud26w ? (resolved.brutto ?? st.rateBrutto ?? null) : (resolved.netto ?? KSIEG_STD_NETTO());
            if (b != null) st.rateNetto = r2o(b + (stud26w ? 0 : factoryBonusPerHour(nextW, row.factoryId, row.periodMonth, row.hours)));
          } else if (stud26w) {
            st.rateNetto = st.rateBrutto ?? resolved.brutto ?? st.rateNetto; // неоподаткований: нетто = брутто
          } else if ((nextW.hourlyRateNetto ?? resolved.netto) != null) {
            st.rateNetto = nextW.hourlyRateNetto ?? resolved.netto;
          }
        }
        return st;
      };
      // нова межа — лише для середини першого місяця; для наступних місяців
      // (або дати 1-го числа) межі лишаються, нові умови покривають вікна ≥ from
      const boundaries = wantsSplit && row.periodMonth === fromMonth ? [from] : [];
      const plan = await planSegments(row, existing, boundaries, d => (d >= from ? overlay(oldAt(d)) : oldAt(d)));
      // умови вирівнялись по ВСЬОМУ місяцю → сегменти зшиваються в звичайний рядок
      if (plan && plan.windows.length === 1 && existing.length) {
        const uniform = plan.parts[0]!;
        const m3: any = {
          ...row, rateNetto: uniform.rateNetto, rateBrutto: uniform.rateBrutto,
          section: uniform.section ?? row.section, isStudent: uniform.isStudent, under26: uniform.under26,
        };
        const payout3 = computePayout(m3, row.city as any);
        if (payout3 != null) m3.doWyplaty = payout3;
        if (m3.hours != null && m3.rateBrutto != null) m3.brutto = Math.round(m3.hours * m3.rateBrutto * 100) / 100;
        if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
          applyLegalDefaults(m3, true, {
            profileLegal: (uniform.legal ?? null) as any, factoryLabel: row.factoryLabel, city: row.city,
            payoutPref: nextW.payoutPrefKind ? { kind: nextW.payoutPrefKind as any, value: nextW.payoutPrefValue ?? null } : null,
          });
        }
        const uSet: Record<string, unknown> = {};
        const uDiffs: RowDiff[] = [];
        for (const k of ["rateBrutto", "rateNetto", "isStudent", "under26", "section", "doWyplaty", "brutto", "hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
          uSet[k] = m3[k] ?? null;
          const nv = typeof m3[k] === "number" ? Math.round(m3[k] * 100) / 100 : m3[k] ?? null;
          const ov = typeof (row as any)[k] === "number" ? Math.round((row as any)[k] * 100) / 100 : (row as any)[k] ?? null;
          if (nv !== ov) uDiffs.push({ key: k, from: (row as any)[k] ?? null, to: m3[k] ?? null });
        }
        items.push({ row, locked, set: uSet, diffs: uDiffs, unsplit: true });
        continue;
      }
      if (plan && plan.windows.length >= 2) {
        // чесний диф: повний посегментний розрахунок (кожен сегмент за правилами
        // свого статусу, батько = сума) — те саме, що зробить apply
        const calc = computeSegmented(
          segParentInput(row),
          plan.parts.map((p): SegmentCalcIn => ({
            hours: p.hours, rateNetto: p.rateNetto, rateBrutto: p.rateBrutto,
            isStudent: p.isStudent, under26: p.under26, legal: p.legal,
          })),
          nextW.payoutPrefKind ? { kind: nextW.payoutPrefKind as any, value: nextW.payoutPrefValue ?? null } : null,
        );
        const sDiffs: RowDiff[] = [];
        for (const k of ["rateBrutto", "rateNetto", "doWyplaty", "brutto", "hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
          const nv = typeof (calc.parent as any)[k] === "number" ? Math.round((calc.parent as any)[k] * 100) / 100 : (calc.parent as any)[k] ?? null;
          const ov = typeof (row as any)[k] === "number" ? Math.round((row as any)[k] * 100) / 100 : (row as any)[k] ?? null;
          if (nv !== ov) sDiffs.push({ key: k, from: (row as any)[k] ?? null, to: (calc.parent as any)[k] ?? null });
        }
        // план порізки для превʼю: період + години + ставка + свій розклад
        const splitView = plan.windows.map((wn, i) => ({
          from: wn.from, to: wn.to,
          hours: plan.parts[i]!.hours, rateNetto: plan.parts[i]!.rateNetto,
          label: plan.parts[i]!.label ?? plan.parts[i]!.section ?? null,
          legal: plan.parts[i]!.legal,
          doWyplaty: calc.segs[i]!.doWyplaty, konto: calc.segs[i]!.konto, gotowka: calc.segs[i]!.gotowka,
        }));
        items.push({ row, locked, plan, split: splitView, diffs: sDiffs });
        continue;
      }
      // порізаний рядок без плану (нема годин) — не чіпаємо батька повз сегменти
      if (existingSegs.length) continue;
    }
    items.push({ row, set, diffs, locked });
  }
  const nonEmpty = items.filter(it => it.diffs.length || it.plan || it.unsplit);
  // контекст для порожнього превʼю: скільки рядків перевірено і які місяці
  // сводних людина взагалі має (щоб підказати «обери ранішу дату»)
  const allMonths = await db.selectDistinct({ m: svodniRowsTable.periodMonth })
    .from(svodniRowsTable).where(and(eq(svodniRowsTable.workerId, workerId), isNull(svodniRowsTable.segmentOf)));
  return { w, patch, changed, items: nonEmpty, checkedRows: rows.length, workerMonths: allMonths.map(x => x.m).sort() } as const;
}

const SENSITIVE_DIFF_KEYS = new Set(["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka", "zusStatus"]);
const serializeImpact = (items: any[], sensitive: boolean) =>
  items.map(({ row, diffs, locked, split, unsplit }) => ({
    rowId: row.id, month: row.periodMonth, city: row.city, factoryLabel: row.factoryLabel, locked,
    hours: row.hours, merge: unsplit || undefined,
    diffs: diffs.filter((d: RowDiff) => sensitive || !SENSITIVE_DIFF_KEYS.has(d.key)),
    // план порізки на сегменти (зміна з середини місяця); konto/готівка — закритий шар
    split: split ? split.map((s: any) => ({
      from: s.from, to: s.to, hours: s.hours, rateNetto: s.rateNetto, label: s.label,
      legal: s.legal, doWyplaty: s.doWyplaty,
      ...(sensitive ? { konto: s.konto, gotowka: s.gotowka } : {}),
    })) : undefined,
  }));

// dry-run: що зачепить зміна профілю від дати (місяці/фабрики/дифи, 🔒)
// дзеркало гейтів PATCH /workers/:id: побажання по виплаті + бонусні галочки
// і дата працевлаштування (впливають на ЗП) — лише svodniSensitive
const SENSITIVE_TRACKED = new Set(["payoutPrefKind", "payoutPrefValue", "employmentStartDate", "agramStazBonus", "agramCashBonus"]);
function trackedGateFail(req: AuthedRequest): string | null {
  const keys = Object.keys((req.body?.changes ?? {}) as object);
  if (keys.some(k => FINANCE_TRACKED.has(k)) && !hasCap(req.admin!.role, req.admin!.caps, "viewFinance")) return "forbidden";
  if (keys.some(k => SENSITIVE_TRACKED.has(k)) && !canSensitive(req)) return "forbidden";
  return null;
}

router.post("/svodni/profile-impact", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const workerId = Number(req.body?.workerId);
  const from = String(req.body?.from ?? "");
  if (!Number.isFinite(workerId) || !DATE_RE.test(from)) return fail(res, 400, "workerId і from=YYYY-MM-DD обовʼязкові");
  const gate = trackedGateFail(req);
  if (gate) return fail(res, 403, gate);
  const ctx = await profileChangeContext(workerId, req.body ?? {}, from, canSensitive(req));
  if ("err" in ctx) return fail(res, 400, ctx.err!);
  ok(res, { items: serializeImpact(ctx.items, canSensitive(req)), checkedRows: ctx.checkedRows, workerMonths: ctx.workerMonths });
});

// застосування: профіль + журнал + вибрані рядки (залочені — ніколи)
router.post("/svodni/profile-apply", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const workerId = Number(req.body?.workerId);
  const from = String(req.body?.from ?? "");
  const rowIds = new Set<number>(Array.isArray(req.body?.rowIds) ? req.body.rowIds.map(Number) : []);
  if (!Number.isFinite(workerId) || !DATE_RE.test(from)) return fail(res, 400, "workerId і from=YYYY-MM-DD обовʼязкові");
  const gate = trackedGateFail(req);
  if (gate) return fail(res, 403, gate);
  const ctx = await profileChangeContext(workerId, req.body ?? {}, from, canSensitive(req));
  if ("err" in ctx) return fail(res, 400, ctx.err!);
  const toApply = ctx.items.filter(it => !it.locked && rowIds.has(it.row.id));
  const skippedLocked = ctx.items.filter(it => it.locked).map(it => ({ month: it.row.periodMonth, city: it.row.city, factoryLabel: it.row.factoryLabel }));
  await db.update(workersTable).set(ctx.patch).where(eq(workersTable.id, workerId));
  for (const it of toApply) {
    if (it.plan) {
      // зміна з середини місяця → рядок ріжеться на сегменти
      await writeSegments(it.row, it.plan);
    } else {
      // умови вирівнялись по всьому місяцю → сегменти зшиваються назад
      if (it.unsplit) await db.delete(svodniRowsTable).where(eq(svodniRowsTable.segmentOf, it.row.id));
      await db.update(svodniRowsTable).set({ ...it.set, manual: true, mismatch: null } as any).where(eq(svodniRowsTable.id, it.row.id));
    }
  }
  const appliedRows = toApply.map(it => ({ month: it.row.periodMonth, city: it.row.city, factoryLabel: it.row.factoryLabel }));
  const changesBody = (req.body?.changes ?? {}) as Record<string, unknown>;
  for (const field of Object.keys(changesBody)) {
    if (!(field in ctx.patch)) continue;
    const oldV = (ctx.w as any)[field];
    const newV = (ctx.patch as any)[field];
    if (String(oldV ?? "") === String(newV ?? "")) continue; // фактичної зміни нема
    await db.insert(workerChangesTable).values({
      workerId, field,
      oldValue: oldV == null ? null : String(oldV),
      newValue: newV == null ? null : String(newV),
      effectiveDate: from,
      appliedRows: appliedRows.length ? appliedRows : null,
      skippedLocked: skippedLocked.length ? skippedLocked : null,
      adminId: req.admin!.adminId,
    });
  }
  ok(res, { applied: appliedRows.length, skippedLocked });
});

// «Видалити зміну» з історії профілю: значення повертається до попереднього
// (з запису журналу), зачеплені сводні від дати набуття перераховуються тим
// самим двигуном, що й застосування, а сам запис зникає з журналу.
function parseJournalValue(field: string, v: string | null): unknown {
  if (v == null || v === "") return null;
  if (["agramStazBonus", "agramCashBonus", "isStudent"].includes(field)) return v === "true";
  if (["hourlyRate", "hourlyRateNetto", "notifyHours", "payoutPrefValue", "positionId", "factoryId"].includes(field)) return Number(v);
  return v;
}
router.delete("/svodni/profile-change/:id", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [entry] = await db.select().from(workerChangesTable).where(eq(workerChangesTable.id, id));
  if (!entry) return fail(res, 404, "запис не знайдено");
  if (["fired", "restored"].includes(entry.field))
    return fail(res, 400, "звільнення/поновлення скасовуються кнопками профілю");
  // гейти — ті самі, що в застосуванні змін
  if (FINANCE_TRACKED.has(entry.field) && !hasCap(req.admin!.role, req.admin!.caps, "viewFinance")) return fail(res, 403, "forbidden");
  if (SENSITIVE_TRACKED.has(entry.field) && !canSensitive(req)) return fail(res, 403, "forbidden");
  const oldVal = parseJournalValue(entry.field, entry.oldValue);
  // фабрику модуль пропагації не веде — просто повертаємо і зносимо запис
  if (entry.field === "factoryId") {
    await db.update(workersTable).set({ factoryId: oldVal as number | null }).where(eq(workersTable.id, entry.workerId));
    await db.delete(workerChangesTable).where(eq(workerChangesTable.id, id));
    return ok(res, { applied: 0, skippedLocked: [] });
  }
  const ctx = await profileChangeContext(entry.workerId, { changes: { [entry.field]: oldVal } }, entry.effectiveDate, canSensitive(req));
  if ("err" in ctx) return fail(res, 400, ctx.err!);
  await db.update(workersTable).set(ctx.patch).where(eq(workersTable.id, entry.workerId));
  const toApply = ctx.items.filter(it => !it.locked);
  for (const it of toApply) {
    if (it.plan) {
      await writeSegments(it.row, it.plan);
    } else {
      if (it.unsplit) await db.delete(svodniRowsTable).where(eq(svodniRowsTable.segmentOf, it.row.id));
      await db.update(svodniRowsTable).set({ ...it.set, manual: true, mismatch: null } as any).where(eq(svodniRowsTable.id, it.row.id));
    }
  }
  const skippedLocked = ctx.items.filter(it => it.locked).map(it => ({ month: it.row.periodMonth, city: it.row.city, factoryLabel: it.row.factoryLabel }));
  await db.delete(workerChangesTable).where(eq(workerChangesTable.id, id));
  ok(res, { applied: toApply.length, skippedLocked });
});

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
    && field !== "note"
    && !(isExtra && extraKey && (EXTRA_FIELDS.has(extraKey) || isZusStatus))
    && !(isHr && hrKey && HR_TEXT_FIELDS.has(hrKey))) return fail(res, 400, "поле не редагується");

  const [row] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  // «Замітки» — робоча нотатка, не фінансове поле: правиться і на затверджених
  // вкладках, не робить рядок manual (щоб не «заморожувати» його від синку)
  if (field === "note") {
    const v = String(rawValue ?? "").trim();
    await db.update(svodniRowsTable).set({ note: v || null }).where(eq(svodniRowsTable.id, id));
    const [u] = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName, workerLegal: workersTable.legalStatus, prefKind: workersTable.payoutPrefKind, prefValue: workersTable.payoutPrefValue })
      .from(svodniRowsTable)
      .leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
      .where(eq(svodniRowsTable.id, id));
    return ok(res, await withSegments(
      serializeRow(u!.r, u!.workerName, canSensitive(req), u!.workerLegal, u!.prefKind ? { kind: u!.prefKind, value: u!.prefValue ?? null } : null),
      id, canSensitive(req), u!.workerLegal));
  }
  if (isLocked(await monthLocks(row.periodMonth), row.city, row.factoryLabel))
    return fail(res, 409, "Фабрику затверджено — спершу розблокуй");
  // сегментний рядок: правляться лише години і ставки, решта — на батькові;
  // після правки батько перераховується (Σ база, min-ставки, konto/готівка)
  if (row.segmentOf != null) {
    if (!["hours", "rateNetto", "rateBrutto"].includes(field)) return fail(res, 400, "у сегменті редагуються лише години та ставки");
    const v = rawValue === "" || rawValue == null ? null : Number(String(rawValue).replace(",", "."));
    if (v != null && !Number.isFinite(v)) return fail(res, 400, "не число");
    const m: any = { ...row, [field]: v };
    const rnd2 = (n: number) => Math.round(n * 100) / 100;
    await db.update(svodniRowsTable).set({
      [field]: v, manual: true,
      // вписані вручну години «липкі»: наступні перебудови сегментів їх не перетирають
      ...(field === "hours" ? { extras: { ...(row.extras as Record<string, unknown>), manualHours: true } } : {}),
      doWyplaty: m.hours != null && m.rateNetto != null ? rnd2(m.hours * m.rateNetto) : null,
      brutto: m.hours != null && m.rateBrutto != null ? rnd2(m.hours * m.rateBrutto) : null,
    }).where(eq(svodniRowsTable.id, row.id));
    await recomputeSegmentedParent(row.segmentOf);
    const [parent] = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName, workerLegal: workersTable.legalStatus, prefKind: workersTable.payoutPrefKind, prefValue: workersTable.payoutPrefValue })
      .from(svodniRowsTable).leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
      .where(eq(svodniRowsTable.id, row.segmentOf));
    return ok(res, parent
      ? await withSegments(
          serializeRow(parent.r, parent.workerName, canSensitive(req), parent.workerLegal, parent.prefKind ? { kind: parent.prefKind, value: parent.prefValue ?? null } : null),
          parent.r.id, canSensitive(req), parent.workerLegal)
      : { ok: true });
  }
  // батьківський рядок порізки: години/ставки/похідні рахуються З сегментів —
  // напряму правляться лише місячні вводи (премія, аванси, кари, extras, hr…),
  // після чого батько перераховується сегментним двигуном
  const [segMark] = await db.select({ id: svodniRowsTable.id }).from(svodniRowsTable)
    .where(eq(svodniRowsTable.segmentOf, row.id)).limit(1);
  const isSegParent = !!segMark;
  if (isSegParent && ["hours", "rateNetto", "rateBrutto", "doWyplaty", "brutto", "hoursDeclared", "ksiegNetto", "ksiegBrutto", "konto", "gotowka"].includes(field))
    return fail(res, 409, "рядок розбитий на сегменти — це поле рахується з сегментів (редагуй сегменти або обʼєднай)");

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
      // зміна статусу Księgowość → одразу перерахувати розклад конто/готівки
      // за правилами (проганяємо ті самі застосунки, що й числові правки);
      // порізаний батько перераховується сегментним двигуном нижче
      if (!isSegParent && !OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
        const mergedZ: any = { ...row, extras };
        let profileLegal: string | null = null;
        let payoutPref: { kind: "all_konto" | "hours" | "amount"; value: number | null } | null = null;
        if (row.workerId) {
          const [pw] = await db.select({ ls: workersTable.legalStatus, pk: workersTable.payoutPrefKind, pv: workersTable.payoutPrefValue })
            .from(workersTable).where(eq(workersTable.id, row.workerId));
          profileLegal = pw?.ls ?? null;
          payoutPref = pw?.pk ? { kind: pw.pk as any, value: pw.pv ?? null } : null;
        }
        applyLegalDefaults(mergedZ, true, { profileLegal: profileLegal as any, factoryLabel: row.factoryLabel, payoutPref, city: row.city });
        for (const k of ["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
          if (mergedZ[k] !== row[k]) set[k] = mergedZ[k];
        }
      }
    }
    await db.update(svodniRowsTable).set(set as any).where(eq(svodniRowsTable.id, id));
    if (isSegParent) await recomputeSegmentedParent(id); // порізаний батько: konto/готівка з сегментів
    if (row.workerId) await syncWorkerProfile(row.workerId, field, { hr: set.hr ?? row.hr, extras: set.extras ?? row.extras });
    const [u] = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName, workerLegal: workersTable.legalStatus, prefKind: workersTable.payoutPrefKind, prefValue: workersTable.payoutPrefValue })
      .from(svodniRowsTable)
      .leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
      .where(eq(svodniRowsTable.id, id));
    return ok(res, await withSegments(
      serializeRow(u!.r, u!.workerName, canSensitive(req), u!.workerLegal, u!.prefKind ? { kind: u!.prefKind, value: u!.prefValue ?? null } : null),
      id, canSensitive(req), u!.workerLegal));
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

  // перерахунок похідних (сайт — джерело: mismatch скидається);
  // порізаний батько похідні НЕ рахує тут — після запису піде сегментним двигуном
  const merged: any = { ...row, ...set, extras: set.extras ?? row.extras };
  const affectsPayout = !isSegParent && (PAYOUT_COMPONENTS.has(field) || (isExtra && !NON_PAYOUT_EXTRAS.has(extraKey!)));
  if (affectsPayout) {
    const payout = computePayout(merged, row.city as any);
    if (payout != null) { set.doWyplaty = payout; merged.doWyplaty = payout; }
    if ((field === "hours" || field === "rateBrutto") && merged.hours != null && merged.rateBrutto != null) {
      set.brutto = Math.round(merged.hours * merged.rateBrutto * 100) / 100;
    }
  }
  // статусні правила бухгалтерії (студент до 26 → конто; не зголошений → готівка;
  // год. oświadczenia → конто, решта готівкою): перераховуються і від компонентів
  // виплати, і від правки «Год. повід.» / студент / до-26
  const affectsLegal = !isSegParent && (affectsPayout || field === "hoursNotified" || BOOL_FIELDS.has(field));
  if (affectsLegal && !OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
    let profileLegal: string | null = null;
    let payoutPref: { kind: "all_konto" | "hours" | "amount"; value: number | null } | null = null;
    if (row.workerId) {
      const [pw] = await db.select({ ls: workersTable.legalStatus, pk: workersTable.payoutPrefKind, pv: workersTable.payoutPrefValue })
        .from(workersTable).where(eq(workersTable.id, row.workerId));
      profileLegal = pw?.ls ?? null;
      payoutPref = pw?.pk ? { kind: pw.pk as any, value: pw.pv ?? null } : null;
    }
    applyLegalDefaults(merged, true, { profileLegal: profileLegal as any, factoryLabel: row.factoryLabel, payoutPref, city: row.city });
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
  if (isSegParent) await recomputeSegmentedParent(id); // місячні вводи → перерозподіл між сегментами
  if (row.workerId) await syncWorkerProfile(row.workerId, field, merged);
  const [updated] = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName, workerLegal: workersTable.legalStatus, prefKind: workersTable.payoutPrefKind, prefValue: workersTable.payoutPrefValue })
    .from(svodniRowsTable)
    .leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
    .where(eq(svodniRowsTable.id, id));
  ok(res, await withSegments(
    serializeRow(updated!.r, updated!.workerName, canSensitive(req), updated!.workerLegal, updated!.prefKind ? { kind: updated!.prefKind, value: updated!.prefValue ?? null } : null),
    id, canSensitive(req), updated!.workerLegal));
});

// «Години підтверджені → до сводної»: створює/оновлює сводну місяця з обліку
// годин (сайт — джерело). Береться ЛИШЕ облік годин (рапорт місяця пріоритетно,
// інакше затверджені явки) і профіль працівника (ставки/статуси/дата народження/
// год. повідомлення). Аванси, штрафи, хостел тощо поки вписуються вручну в
// сводній — формули перерахують. Google-таблиці тут не використовуються.
router.post("/svodni/from-hours", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  // опційні фільтри: одна фабрика або ціле місто (без них — весь місяць);
  // workerIds — точний список людей видимого скоупу (вкладка обліку годин:
  // фірмова вкладка мульти-контрактної фабрики шле лише СВОЇХ людей, і сміттєві
  // пари поза списком вкладки скоуп не роздувають)
  const onlyFactoryId = req.body?.factoryId != null ? Number(req.body.factoryId) : null;
  const onlyCity = String(req.body?.city ?? "").trim() || null;
  const onlyWorkerIds = Array.isArray(req.body?.workerIds) && req.body.workerIds.length
    ? new Set<number>(req.body.workerIds.map(Number).filter(Number.isInteger)) : null;
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
  // остання ТОЧНА дата активності місяця по людині (явки; нижче — дні з файлу
  // фабрики): маркер «не оформлений» для звільнених ранішою датою
  const lastActByWorker = new Map<number, string>();
  const bumpAct = (w: number, date: string) => { if (date > (lastActByWorker.get(w) ?? "")) lastActByWorker.set(w, date); };
  for (const r of att) {
    if (!r.workerId) continue;
    const date = entryDateStr(String(r.weekStart), r.day);
    if (date < monthStart || date >= monthEnd) continue;
    bumpAct(r.workerId, date);
    const cur = hoursByPair.get(key2(r.workerId, r.factoryId))
      ?? hoursByPair.set(key2(r.workerId, r.factoryId), { workerId: r.workerId, factoryId: r.factoryId, hours: 0 }).get(key2(r.workerId, r.factoryId))!;
    cur.hours += r.hoursOverride ?? factoryShiftHours(r.factoryId != null ? facById.get(r.factoryId) : undefined, r.shift as any);
  }
  // 2) джерело годин — вибір адміна: `source` = reports (дефолт: рапорти
  // працівників, як завжди) | factory (колонка «Години з фабрики») |
  // attendance (чисті явки затвердженого графіку). reports/factory накладаються
  // ПОВЕРХ явок — пара без рапорту/запису лишається з явками (фолбек).
  const source = ["reports", "factory", "attendance"].includes(String(req.body?.source)) ? String(req.body.source) : "reports";
  // Джерело авторитетне: наявний запис переноситься ЯК Є, включно з 0 (у
  // сводній буде 0 год) — модалка перед перенесенням попереджає про такі
  // рядки окремим блоком. Фолбек на явки — лише коли запису в джерелі НЕМАЄ.
  if (source === "reports") {
    const { monthlyReportsTable } = await import("@workspace/db");
    const reports = await db.select().from(monthlyReportsTable).where(eq(monthlyReportsTable.month, month));
    for (const r of reports) {
      const k = key2(r.workerId, r.factoryId);
      const cur = hoursByPair.get(k) ?? hoursByPair.set(k, { workerId: r.workerId, factoryId: r.factoryId, hours: 0 }).get(k)!;
      cur.hours = r.hoursReported;
    }
  } else if (source === "factory") {
    const { factoryHoursTable } = await import("@workspace/db");
    const fh = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.month, month));
    for (const r of fh) {
      const k = key2(r.workerId, r.factoryId);
      const cur = hoursByPair.get(k) ?? hoursByPair.set(k, { workerId: r.workerId, factoryId: r.factoryId, hours: 0 }).get(k)!;
      cur.hours = r.hours;
    }
  }

  // 3) профілі та місто фабрики: НЕ вгадуємо. Історія сводних → регіони
  // «Зарплат» (factoryCityMap); фабрика без міста пропускається і звітується.
  const cityByFactory = await factoryCityMap();
  const cityOf = (factoryId: number | null): string | null =>
    factoryId != null ? cityByFactory.get(factoryId) ?? null : null;

  // фільтри «одна фабрика» / «ціле місто» + пропуск затверджених фабрик/міст
  const locks = await monthLocks(month);
  let skippedLocked = 0;
  const noCity = new Set<string>();
  for (const [k, pair] of [...hoursByPair]) {
    if (onlyFactoryId != null && pair.factoryId !== onlyFactoryId) { hoursByPair.delete(k); continue; }
    if (onlyWorkerIds && !onlyWorkerIds.has(pair.workerId)) { hoursByPair.delete(k); continue; }
    const label = pair.factoryId != null ? facById.get(pair.factoryId)?.name ?? "Без фабрики" : "Без фабрики";
    const city = cityOf(pair.factoryId);
    if (!city) { hoursByPair.delete(k); noCity.add(label); continue; }
    if (onlyCity && city !== onlyCity) { hoursByPair.delete(k); continue; }
    if (isLocked(locks, city, label)) { hoursByPair.delete(k); skippedLocked++; }
  }

  const workerIds = [...new Set([...hoursByPair.values()].map(p => p.workerId))];
  if (!workerIds.length) {
    return fail(res, 400, skippedLocked ? "усе вибране затверджено (🔒) — спершу розблокуй"
      : noCity.size ? `місто фабрики невідоме (нема ні в сводних, ні в Зарплатах): ${[...noCity].join(", ")}`
      : "немає підтверджених годин у вибраному");
  }
  const workers = await db.select().from(workersTable).where(inArray(workersTable.id, workerIds));
  const wById = new Map(workers.map(w => [w.id, w]));
  // дні з файлу фабрики (factory_hours.days) — теж точні дати активності
  {
    const { factoryHoursTable } = await import("@workspace/db");
    const fhDays = await db.select({ workerId: factoryHoursTable.workerId, days: factoryHoursTable.days })
      .from(factoryHoursTable).where(and(eq(factoryHoursTable.month, month), inArray(factoryHoursTable.workerId, workerIds)));
    for (const r of fhDays) for (const d of Object.keys(r.days ?? {})) bumpAct(r.workerId, d);
  }
  // «Не оформлений»: людина звільнена, а точні дати активності місяця ПІЗНІШІ
  // за дату звільнення (або звільнена ще до початку місяця, а години є) —
  // період після звільнення юридично не оформлений. Позначка ставиться в
  // статус рядка (extras.zusStatus) ПІСЛЯ applyLegalDefaults: суто текст у
  // колонці статусу, розклад konto/готівки не зачіпає (legalStatusOf її не знає).
  const localDayStr = (v: Date) => `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  const isUnregistered = (w: typeof workers[number], pairHours: number): boolean => {
    if (w.isActive || !w.firedAt || pairHours <= 0) return false;
    const fired = localDayStr(new Date(w.firedAt));
    if (fired < monthStart) return true;
    const lastAct = lastActByWorker.get(w.id);
    return lastAct != null && fired < lastAct;
  };
  // Мульти-контрактні фабрики — ЛИШЕ явний прапорець factories.multi_firm
  // (Sushi&Food: Klinex + аутсорсинг). Вивід з фірм працівників був багом:
  // разова підміна/помилка профілю ділила вкладки одноконтрактних клієнтів
  // (BIMIZ, PREMIUM FRUITS — 08.2026). Вкладка ділиться по фірмі працівника,
  // дзеркально вкладкам таблиці.
  const companiesAll = await db.select().from(companiesTable);
  const coNameById = new Map(companiesAll.map(c => [c.id, c.name]));
  const tabLabelFor = (fac: typeof facRows[number] | undefined, w0: typeof workers[number]): string => {
    if (!fac) return "Без фабрики";
    if (!fac.multiFirm) return fac.name;
    const cn = coNameById.get(w0.companyId ?? -1) ?? "";
    const suffix = cn === "ES" ? "EURO SUPORT" : cn.toUpperCase(); // як вкладки таблиці
    return suffix ? `${fac.name} ${suffix}` : fac.name;
  };
  // становіска: назва позиції працівника → секція рядка (для фабрик з посадами)
  const positions = await db.select().from(positionsTable);
  const posById = new Map(positions.map(p => [p.id, p.name]));
  const ruleOf = await loadRateRules();

  // Eurocash: ставка працівника — від порогу продуктивності. Extras пари
  // (нічні/ставка агенції/потроненя) — з обліку годин (імпорт розрахункового
  // файлу фабрики); таблиця порогів — дзеркало блоку STAWKA EUROCASH вкладки
  // сводної (найсвіжіший місяць ≤ поточного; фолбек — останній наявний, ставки
  // міняються рідко, а вкладки нового місяця на момент розрахунку ще нема).
  const ecFactoryIds = [...new Set([...hoursByPair.values()]
    .filter(p => p.factoryId != null && EUROCASH_FACTORY_IDS.has(p.factoryId)).map(p => p.factoryId!))];
  const ecExtrasByPair = new Map<string, NonNullable<typeof factoryHoursTable.$inferSelect.extras>>();
  const ecRatesByFactory = new Map<number, EurocashRates | null>();
  if (ecFactoryIds.length) {
    const fhRows = await db.select().from(factoryHoursTable).where(and(
      eq(factoryHoursTable.month, month), inArray(factoryHoursTable.factoryId, ecFactoryIds),
    ));
    for (const r of fhRows) if (r.extras) ecExtrasByPair.set(key2(r.workerId, r.factoryId), r.extras);
    for (const fid of ecFactoryIds) {
      const label = facById.get(fid)?.name ?? "";
      const metas = await db.select().from(svodniTabMetaTable)
        .where(eq(svodniTabMetaTable.factoryLabel, label))
        .orderBy(desc(svodniTabMetaTable.periodMonth));
      const withBlock = metas.filter(m => (m.info as { stawkaEurocash?: (string | number)[][] })?.stawkaEurocash);
      const meta = withBlock.find(m => m.periodMonth <= month) ?? withBlock[0];
      ecRatesByFactory.set(fid, eurocashRatesFromBlock(
        (meta?.info as { stawkaEurocash?: (string | number)[][] } | undefined)?.stawkaEurocash ?? null));
    }
  }
  const eurocashUnmatched: { name: string; reason: string }[] = [];

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
  // системні відрахування (аванси/хостел) знімаються ОДИН раз на людину-місяць:
  // у рядок «основної» фабрики (де найбільше годин), а не в кожну пару —
  // інакше людина на двох фабриках платила б хостел двічі
  const mainFactoryOf = new Map<number, number | null>();
  const mainHours = new Map<number, number>();
  for (const pair of hoursByPair.values()) {
    if ((mainHours.get(pair.workerId) ?? -1) < pair.hours) {
      mainHours.set(pair.workerId, pair.hours);
      mainFactoryOf.set(pair.workerId, pair.factoryId);
    }
  }
  const isMainPair = (p: { workerId: number; factoryId: number | null }) => mainFactoryOf.get(p.workerId) === p.factoryId;

  const existing = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf)));
  const existByKey = new Map(existing.map(r => [`${r.workerId ?? 0}|${r.factoryLabel}`, r]));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let created = 0, updated = 0, skippedNoRate = 0;
  // самозвірка після запису: що передали ↔ що реально лежить у сводній
  const expectedRows: { workerId: number; label: string; hours: number; name: string }[] = [];
  for (const pair of hoursByPair.values()) {
    const w = wById.get(pair.workerId);
    if (!w) continue;
    const fac = pair.factoryId != null ? facById.get(pair.factoryId) : undefined;
    const factoryLabel = tabLabelFor(fac, w);
    const city = cityOf(pair.factoryId)!; // пари без міста відфільтровані вище
    // становіско (секція): позиція з профілю — для фабрик, що ведуть посади;
    // без посади в профілі — найдешевша посада фабрики (ставку вона й так задає),
    // інакше безсекційні рядки візуально «прилипали» до останньої секції вкладки
    const rules = ruleOf(pair.factoryId, w.positionId);
    const sectionPosId = w.positionId ?? rules.cheapestPositionId ?? null;
    const section = fac?.usesPositions && sectionPosId != null ? posById.get(sectionPosId) ?? null : null;
    // вік «до 26» — на момент розрахунку (наближення дати виплати, яка в M+1);
    // остаточно вік фіксується локом сводної (freezeUnder26AtLock)
    const under26 = w.birthDate ? isUnder26(w.birthDate) : w.under26;
    // Ставки: профіль (override) → правила фабрики (посада → найдешевша посада
    // → базова пара). Бонусні фабрики (Agram нал+стаж, LST нал): бонус поверх
    // нетто; студент до 26 — нетто = брутто, без бонусів
    const isAgram = pair.factoryId != null && AGRAM_FACTORY_IDS.has(pair.factoryId);
    const isBonusFac = pair.factoryId != null && CASH_BONUS_FACTORY_IDS.has(pair.factoryId);
    const stud26 = (w.isStudent || w.legalStatus === "student") && !!under26;
    const base = resolveBaseRates(w, rules, stud26);
    const bonus = stud26 ? 0 : factoryBonusPerHour(w, pair.factoryId, month, r2(pair.hours));
    const bonusNetto = (): number | null => {
      // бонусна фабрика без бази з профілю/правил — стандартна пара (25,35)
      const b = stud26 ? base.brutto : (base.netto ?? KSIEG_STD_NETTO());
      return b != null ? r2(b + bonus) : null;
    };
    // Eurocash: пара ставок від порогу (ставка агенції з файлу → зелений рядок,
    // фолбек — продуктивність у діапазони); студент до 26 — нетто = брутто і
    // нічна брутто (4,50), інші — нетто-рядок і нічна нетто (3,50). Потроненя
    // фабрики переносяться в колонку potrąceń. Виплата Eurocash — вся на конто.
    const isEurocash = pair.factoryId != null && EUROCASH_FACTORY_IDS.has(pair.factoryId);
    let ec: { rateNetto: number; rateBrutto: number; nocneH: number | null; doplataNocna: number; potracenia: number | null } | null = null;
    if (isEurocash) {
      const ecx = ecExtrasByPair.get(key2(pair.workerId, pair.factoryId));
      const ecRates = ecRatesByFactory.get(pair.factoryId!) ?? null;
      if (!ecx) eurocashUnmatched.push({ name: w.fullName, reason: "немає даних файлу фабрики в обліку годин" });
      else if (!ecRates) eurocashUnmatched.push({ name: w.fullName, reason: "немає блоку STAWKA EUROCASH у дзеркалі вкладки — запусти синк сводних" });
      else {
        const idx = eurocashBracketIndex(ecRates, ecx.stawkaAgencji ?? null, ecx.produktywnosc ?? null);
        if (idx == null || ecRates.brutto[idx] == null || ecRates.netto[idx] == null) {
          eurocashUnmatched.push({ name: w.fullName, reason: `поріг не знайдено (ставка агенції ${ecx.stawkaAgencji ?? "—"}, продуктивність ${ecx.produktywnosc ?? "—"})` });
        } else {
          ec = {
            rateBrutto: ecRates.brutto[idx]!,
            rateNetto: stud26 ? ecRates.brutto[idx]! : ecRates.netto[idx]!,
            nocneH: ecx.nocneH != null && ecx.nocneH > 0 ? r2(ecx.nocneH) : null,
            doplataNocna: stud26 ? ecRates.nightBrutto : ecRates.nightNetto,
            potracenia: ecx.potracenia != null && ecx.potracenia !== 0 ? r2(ecx.potracenia) : null,
          };
        }
      }
    }
    // Eurocash без порога (нема extras файлу / блоку ставок / бракет не
    // знайшовся) — пару НЕ переносимо: фолбек на стандартну пару тут виглядав
    // би як порахована ставка (інцидент 06.08.2026 — трьом новим упала
    // мінімалка 25,35). Відсутній рядок помітніший за тихо неправильний;
    // причина — в eurocashUnmatched відповіді.
    if (isEurocash && !ec) continue;
    // побажання по виплаті: профіль → Eurocash-дефолт «все на конто»
    const payoutPref = w.payoutPrefKind
      ? { kind: w.payoutPrefKind as "all_konto" | "hours" | "amount", value: w.payoutPrefValue ?? null }
      : isEurocash ? { kind: "all_konto" as const, value: null } : null;
    expectedRows.push({ workerId: pair.workerId, label: factoryLabel, hours: r2(pair.hours), name: w.fullName });
    const prev = existByKey.get(`${pair.workerId}|${factoryLabel}`);
    if (prev) {
      // порізаний на сегменти рядок: нові сумарні години розкладаються по тих
      // самих межах (пропорційно явкам у вікнах), ставки сегментів не чіпаються
      const prevSegs = await db.select().from(svodniRowsTable)
        .where(eq(svodniRowsTable.segmentOf, prev.id)).orderBy(asc(svodniRowsTable.segmentFrom));
      if (prevSegs.length) {
        const windows = prevSegs.map(s => ({ from: s.segmentFrom!, to: s.segmentTo ?? monthEndStr(month) }));
        const att = await attendanceByWindows(pair.workerId, pair.factoryId, month, windows);
        // «липкі» ручні години сегментів: авторозподіл ділить лише решту
        const manuals = prevSegs.map(s => (s.extras as Record<string, unknown>)?.manualHours && s.hours != null ? s.hours : null);
        const manualSum = manuals.reduce<number>((a, b) => a + (b ?? 0), 0);
        const autoIdx = windows.map((_, i) => i).filter(i => manuals[i] == null);
        const autoTotal = Math.max(r2(r2(pair.hours) - manualSum), 0);
        const autoSplit = autoIdx.length
          ? splitTotalByWindows(autoTotal, autoIdx.map(i => ({ ...windows[i]!, attHours: att[i]! })))
          : [];
        const hoursPerWin = windows.map((_, i) => manuals[i] ?? autoSplit[autoIdx.indexOf(i)] ?? 0);
        for (let i = 0; i < prevSegs.length; i++) {
          const s = prevSegs[i]!, h = hoursPerWin[i]!;
          await db.update(svodniRowsTable).set({
            hours: h,
            doWyplaty: s.rateNetto != null ? r2(h * s.rateNetto) : null,
            brutto: s.rateBrutto != null ? r2(h * s.rateBrutto) : null,
          }).where(eq(svodniRowsTable.id, s.id));
        }
        const zalS = isMainPair(pair) ? advByWorker.get(pair.workerId) : undefined;
        const hosS = isMainPair(pair) ? hostelByWorker.get(pair.workerId) : undefined;
        await db.update(svodniRowsTable).set({
          zaliczka: zalS != null ? r2(zalS) : prev.zaliczka,
          hostel: hosS != null ? r2(hosS) : prev.hostel,
        }).where(eq(svodniRowsTable.id, prev.id));
        await recomputeSegmentedParent(prev.id);
        updated++;
        continue;
      }
      // повторне підтвердження: оновлюємо години + системні відрахування
      // (аванси/хостели — їх джерело тепер система), перераховуємо формули;
      // інші ручні правки (кари, odzież…) не затираються.
      // Бонусні фабрики (Agram/LST): ставка перечитується (галочки/дата могли змінитися)
      // Eurocash: файл фабрики авторитетний — ставки/нічні/потроненя перекриваються
      const zal = isMainPair(pair) ? advByWorker.get(pair.workerId) : undefined;
      const hos = isMainPair(pair) ? hostelByWorker.get(pair.workerId) : undefined;
      const mergedExtras: Record<string, number | string> = { ...((prev.extras as Record<string, number | string>) ?? {}) };
      if (ec) {
        if (ec.nocneH != null) { mergedExtras.nocneH = ec.nocneH; mergedExtras.doplataNocna = ec.doplataNocna; }
        else { delete mergedExtras.nocneH; delete mergedExtras.doplataNocna; }
      }
      const merged: any = {
        ...prev, hours: r2(pair.hours),
        rateNetto: ec ? ec.rateNetto : isBonusFac ? bonusNetto() ?? prev.rateNetto : prev.rateNetto,
        rateBrutto: ec ? ec.rateBrutto : prev.rateBrutto,
        potracenia: ec ? ec.potracenia : prev.potracenia,
        extras: mergedExtras,
        zaliczka: zal != null ? r2(zal) : prev.zaliczka,
        hostel: hos != null ? r2(hos) : prev.hostel,
      };
      const payout = computePayout(merged, city as any);
      if (payout != null) merged.doWyplaty = payout;
      if (merged.hours != null && merged.rateBrutto != null) merged.brutto = r2(merged.hours * merged.rateBrutto);
      applyLegalDefaults(merged, true, { profileLegal: (w.legalStatus ?? null) as any, factoryLabel, city, payoutPref });
      const unregU = isUnregistered(w, r2(pair.hours));
      if (unregU) merged.extras = { ...merged.extras, zusStatus: "не оформлений" };
      await db.update(svodniRowsTable).set({
        hours: merged.hours, rateNetto: merged.rateNetto, zaliczka: merged.zaliczka, hostel: merged.hostel,
        ...(ec || unregU ? { extras: merged.extras } : {}),
        ...(ec ? { rateBrutto: merged.rateBrutto, potracenia: merged.potracenia } : {}),
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
    const row: any = {
      periodMonth: month, city, firm: null, factoryLabel, factoryId: pair.factoryId,
      section, sortIdx: created, rawName: w.fullName, workerId: w.id, linkStatus: "confirmed",
      manual: true, // сайт — джерело: синк із Google цей рядок не перезаписує
      hoursNotified: w.notifyHours ?? null, hours: r2(pair.hours),
      // без статусу легалізації і без ставки (профіль+правила) — мінімалка
      // («як по освядченню»); розклад applyLegalDefaults і так віддасть готівкою.
      // Eurocash: пара від порогу продуктивності + нічні/потроненя з файлу фабрики
      rateBrutto: ec ? ec.rateBrutto : base.brutto ?? (w.legalStatus == null || (isBonusFac && !stud26) ? KSIEG_STD_BRUTTO() : null),
      rateNetto: ec ? ec.rateNetto : isBonusFac ? bonusNetto() : base.netto ?? (w.legalStatus == null ? KSIEG_STD_NETTO() : null),
      potracenia: ec ? ec.potracenia : null,
      zaliczka: isMainPair(pair) && advByWorker.has(pair.workerId) ? r2(advByWorker.get(pair.workerId)!) : null,
      hostel: isMainPair(pair) && hostelByWorker.has(pair.workerId) ? r2(hostelByWorker.get(pair.workerId)!) : null,
      isStudent: w.isStudent, under26,
      extras: ec && ec.nocneH != null ? { nocneH: ec.nocneH, doplataNocna: ec.doplataNocna } : {},
      hr, sheetValues: {}, mismatch: null,
      doWyplaty: null, brutto: null,
    };
    if (row.rateNetto == null) skippedNoRate++;
    row.doWyplaty = computePayout(row, city as any);
    if (row.hours != null && row.rateBrutto != null) row.brutto = r2(row.hours * row.rateBrutto);
    applyLegalDefaults(row, true, { profileLegal: (w.legalStatus ?? null) as any, factoryLabel, city, payoutPref });
    if (isUnregistered(w, r2(pair.hours))) row.extras = { ...row.extras, zusStatus: "не оформлений" };
    await db.insert(svodniRowsTable).values(row);
    created++;
  }
  // Самозвірка: перечитуємо сводну і порівнюємо години кожної пари з тим, що
  // реально записалось (батьківські рядки, сегменти вже перераховані в суму).
  const verifyMismatches: { name: string; label: string; expected: number; actual: number | null }[] = [];
  if (expectedRows.length) {
    const fresh = await db.select({ workerId: svodniRowsTable.workerId, factoryLabel: svodniRowsTable.factoryLabel, hours: svodniRowsTable.hours })
      .from(svodniRowsTable)
      .where(and(eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf),
        inArray(svodniRowsTable.workerId, expectedRows.map(e => e.workerId))));
    const freshByKey = new Map(fresh.map(f => [`${f.workerId}|${f.factoryLabel}`, f.hours]));
    for (const e of expectedRows) {
      const actual = freshByKey.get(`${e.workerId}|${e.label}`);
      if (actual == null || Math.abs(actual - e.hours) > 0.01) {
        verifyMismatches.push({ name: e.name, label: e.label, expected: e.hours, actual: actual ?? null });
      }
    }
  }
  ok(res, {
    month, created, updated, workers: workerIds.length, noNettoRate: skippedNoRate, skippedLocked, noCity: [...noCity],
    verified: expectedRows.length, verifyMismatches, eurocashUnmatched,
  });
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

  const where = [eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf)];
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

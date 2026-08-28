// «Сводні» (/svodni) — повне дзеркало зарплатних таблиць по містах.
// Доступ: capability `svodni` (сторінка, відкритий шар: фактичні години,
// ставки, відрахування, до виплати); закритий шар (księgowość-години,
// ksieg brutto/netto, готівка, конто) віддається ЛИШЕ з `svodniSensitive`
// (owner бачить усе) — фільтрація тут, в API, а не в інтерфейсі.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { svodniRowsTable, svodniTabChecksTable, svodniTabMetaTable, svodniLocksTable, workersTable, factoriesTable, factoryPositionsTable, factoryPayoutRulesTable, companiesTable, hostelDeductionsTable, advanceRequestsTable, positionsTable, workerChangesTable, factoryHoursTable, adminsTable, penaltiesTable, scheduleEntriesTable, scheduleWeeksTable, gratyfikantUmowyTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import { hasCap } from "../lib/roles";
import { logger } from "../lib/logger";
import { matchWorker, findLikelyDuplicate } from "../bot/workerMatch";
import { cleanName } from "../services/payrollSummaries";
import { rematchSvodni, applyRatesFromSvodni, ensureSvodniFactories, dedupeWorkers, parseSheetDate, isUnder26, cityOfRegion, factoryCityMap, OFFICE_TAB_RE, EXTRA_STUDENTS_LABEL } from "../services/svodniSync";
import { computePayout, legalStatusOf, normalizeProfileLegal, applyLegalDefaults, ksiegRatesOf, KSIEG_STD_NETTO, KSIEG_STD_BRUTTO, EUROCASH_FACTORY_IDS, eurocashRatesFromBlock, eurocashBracketIndex, factoryBonusPerHour, hasCashBonus, legacyPayoutRule, resolveBaseRates, monthEndStr, splitTotalByWindows, computeSegmented, findSvodniRowForPair, SEG_SHARE_COLS, debtCarryFromRow, type PayoutRule, type RateRules, type SegmentCalcIn, type EurocashRates } from "../services/svodni";
import { PayoutRules } from "../services/factoryRules";
import { loadRateRules } from "../services/rateRules";
import { nameCaps } from "../services/drive";
import { addDaysStr, entryDateStr, weekFromForMonth } from "../lib/dates";
import { absencePenaltyOf } from "../lib/absences";
import { listaRecords, listaXlsxBuffer } from "../services/gratyfikantExport";
import { defaultPayDate, umowaStatusFor } from "../services/gratyfikantImport";

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
    sortIdx: r.sortIdx, sourceId: r.sourceId, section: r.section, rawName: r.rawName,
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
    // ІНВАРІАНТ ПАРИ: księg. брутто = księg. години × księgowa ставка брутто.
    // Розрив (ручні правки однієї клітинки, легасі до фіксу 22.08.2026) —
    // червона підсвітка клітинки в вебі, щоб не ловити очима (інцидент BIMIZ).
    // Батьки сегментованих рядків пропускаються: їхня ставка = min сегментів.
    if (r.hoursDeclared != null && r.ksiegBrutto != null && r.segmentOf == null) {
      const { brutto: kbRate } = ksiegRatesOf(
        { rateBrutto: r.rateBrutto, rateNetto: r.rateNetto, isStudent: r.isStudent, extras: r.extras as Record<string, unknown> },
        base.legalStatus as any);
      if (kbRate != null && Math.abs(r.hoursDeclared * kbRate - r.ksiegBrutto) > 0.2) base.ksiegMismatch = true;
    }
  }
  return base;
}

// Додає до серіалізованого рядка його сегменти (порізка місяця) — щоб відповіді
// PATCH не затирали сегменти в кеші вебу (він замінює рядок цілком)
async function withSegments(base: Record<string, unknown>, rowId: number, sensitive = true, workerLegal: string | null = null): Promise<Record<string, unknown>> {
  const segs = await db.select().from(svodniRowsTable)
    .where(eq(svodniRowsTable.segmentOf, rowId)).orderBy(asc(svodniRowsTable.segmentFrom));
  if (segs.length) {
    delete base.ksiegMismatch; // ставка батька = min сегментів — пара легально «рвана»
    base.segments = segs.map(s => ({
      ...serializeRow(s, null, sensitive, ((s.extras as Record<string, unknown>)?.segLegal as string | undefined) ?? workerLegal),
      from: s.segmentFrom, to: s.segmentTo, label: s.segmentLabel,
    }));
  }
  return base;
}

// Фірма рядка: явна (книги Лодзі / заголовок вкладки при синку) → з фабрики
// рядка (factories.company_id). svodni_rows.firm у більшості міст порожня,
// а веб фарбує вкладки фабрик за фірмою саме з цього поля. Мульти-контрактні
// фабрики (multi_firm) — виняток: фірма там ідентифікує ГРУПУ рядка всередині
// вкладки, порожню не вгадуємо з фабрики (рядок чесно йде в «без фірми»).
// Збагачувати МУСЯТЬ і відповіді PATCH: веб замінює рядок у кеші відповіддю
// цілком, і рядок без фірми серед збагачених GET-ом стрибав у групу «Без фірми»
// до перезавантаження сторінки (баг 13.08.2026).
async function enrichFirms(rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.some(r => !r.firm && r.factoryId != null)) return;
  const facFirm = new Map((await db.select({ id: factoriesTable.id, name: companiesTable.name, multiFirm: factoriesTable.multiFirm })
    .from(factoriesTable).innerJoin(companiesTable, eq(factoriesTable.companyId, companiesTable.id)))
    .filter(x => !x.multiFirm).map(x => [x.id, x.name]));
  for (const r of rows) if (!r.firm && r.factoryId != null) r.firm = facFirm.get(r.factoryId as number) ?? null;
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

// Правило konto/готівки для ОДНОГО рядка сводної (версії з БД + legacy-фолбек);
// батч-операції (from-hours, profile-apply, синк) вантажать PayoutRules.load()
// раз і резолвлять по рядку самі.
async function payoutRuleForRow(row: { factoryId: number | null; factoryLabel: string; periodMonth: string }): Promise<PayoutRule> {
  const rules = await PayoutRules.load(row.factoryId != null ? [row.factoryId] : []);
  return rules.for(row.factoryId, row.factoryLabel, row.periodMonth);
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
  const payoutRules = await PayoutRules.load();
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
        const bonus = stud26now ? 0 : factoryBonusPerHour(w, payoutRules.for(row.factoryId, row.factoryLabel, row.periodMonth), row.periodMonth, parentHours);
        set.rateNetto = stud26now
          ? (resolved.brutto ?? row.rateBrutto ?? row.rateNetto)
          : resolved.netto != null ? Math.round((resolved.netto + bonus) * 100) / 100 : row.rateNetto;
        // вшитий бонус сегмента (завжди готівковий) — синхронно зі ставкою
        const segExtras = { ...(row.extras as Record<string, unknown>) };
        if (bonus > 0) segExtras.facBonus = bonus; else delete segExtras.facBonus;
        set.extras = segExtras;
      }
      await db.update(svodniRowsTable).set(set).where(eq(svodniRowsTable.id, row.id));
      toRecalc.add(row.segmentOf);
    } else {
      // звичайний рядок: та сама машинерія, що й зміна дати народження у профілі
      // (extras лишаємо в set — там живе вшитий бонус facBonus, який міняється
      // разом зі студентством; hr рядок цей шлях не чіпає)
      const { set } = rowSetFromProfile(row, w, new Set(["birthDate"]), undefined, ruleOf(row.factoryId, w.positionId), payoutRules.for(row.factoryId, row.factoryLabel, row.periodMonth));
      if (Object.keys(set).length) {
        await db.update(svodniRowsTable).set({ ...set, manual: true }).where(eq(svodniRowsTable.id, row.id));
      }
    }
  }
  for (const pid of toRecalc) await recomputeSegmentedParent(pid);
}

// toggle: перший виклик ставить лок, повторний — знімає. При знятті приймає
// applyChangeIds — прийняті з ревʼю зміни профілів (див. /svodni/lock-pending)
// застосовуються до рядків щойно розлоченої області тим самим двигуном
router.post("/svodni/lock", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  const city = String(req.body?.city ?? "").trim();
  const factoryLabel = String(req.body?.factoryLabel ?? "").trim(); // "" = усе місто
  if (!month || !city) return fail(res, 400, "month і city обовʼязкові");
  const locks = await monthLocks(month);
  const existing = locks.find(l => l.city === city && l.factoryLabel === factoryLabel);
  if (existing) {
    const applyIds = Array.isArray(req.body?.applyChangeIds)
      ? (req.body.applyChangeIds as unknown[]).map(Number).filter(Number.isFinite) : [];
    await db.delete(svodniLocksTable).where(eq(svodniLocksTable.id, existing.id));
    const applied = applyIds.length ? await applyReviewedChanges(month, existing, applyIds, req) : 0;
    // показані в ревʼю, але не прийняті зміни — явно відхилені (маркер, а не
    // «випали з вікна часу» — інакше вертались би після закриття дірки
    // перелочування). Гейтнуті капами поля адмін не бачив — не чіпаємо.
    const fin = hasCap(req.admin!.role, req.admin!.caps, "viewFinance");
    const sens = canSensitive(req);
    const scopeRows = await db.select({ workerId: svodniRowsTable.workerId, city: svodniRowsTable.city, factoryLabel: svodniRowsTable.factoryLabel })
      .from(svodniRowsTable).where(and(
        eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf), isNotNull(svodniRowsTable.workerId)));
    const scopeWorkerIds = [...new Set(scopeRows.filter(r => isLocked([existing], r.city, r.factoryLabel)).map(r => r.workerId!))];
    const shown = await pendingJournalForScope(month, existing, scopeWorkerIds);
    const dismissIds = shown
      .filter(({ c }) => !applyIds.includes(c.id)
        && !(FINANCE_TRACKED.has(c.field) && !fin) && !(SENSITIVE_TRACKED.has(c.field) && !sens))
      .map(({ c }) => c.id);
    if (dismissIds.length) {
      await db.update(workerChangesTable).set({ reviewDismissedAt: sql`now()` })
        .where(inArray(workerChangesTable.id, dismissIds));
    }
    return ok(res, { locked: false, applied });
  }
  await freezeUnder26AtLock(month, { city, factoryLabel }, locks);
  await db.insert(svodniLocksTable).values({ periodMonth: month, city, factoryLabel, lockedBy: req.admin!.adminId });
  ok(res, { locked: true });
});

// ── Ревʼю змін профілів під локом ────────────────────────────────────────────
// Поки область затверджена, зміни профілів у її рядки не пропагуються
// (profile-apply пропускає залочені, голий PATCH сводну взагалі не чіпає).
// Перед розблокуванням веб питає цей список — зміни журналу після lockedAt,
// що діють у місяці (критерій той самий, що ❗ staleLocks) — і показує ревʼю:
// кожну можна прийняти (застосувати до рядків області) або відхилити.
// Поля, які двигун пропагації вміє застосувати (ключі normTrackedChanges);
// решта (фабрика, звільнення, національність) — у списку інформаційно.
const PROPAGATABLE_FIELDS = new Set([
  "legalStatus", "birthDate", "employmentStartDate", "notifyHours", "hourlyRate",
  "hourlyRateNetto", "agramStazBonus", "agramCashBonus", "isStudent", "positionId",
  "payoutPrefKind", "payoutPrefValue",
]);
// строго ДО першого числа наступного місяця: "-31" валить date-каст Postgres
// у коротких місяцях (30/28 днів)
function nextMonthStart(month: string): string {
  const [sy, sm] = month.split("-").map(Number);
  return sm === 12 ? `${sy! + 1}-01-01` : `${sy}-${String(sm! + 1).padStart(2, "0")}-01`;
}

// Зміна вже пропагована в рядки цієї області? (запис appliedRows накриває скоуп)
function appliedCoversScope(c: typeof workerChangesTable.$inferSelect, month: string, lock: LockRow): boolean {
  return Array.isArray(c.appliedRows) && (c.appliedRows as { month: string; city: string; factoryLabel: string }[])
    .some(a => a.month === month && isLocked([lock], a.city, a.factoryLabel));
}

// Журнальні зміни-кандидати для ревʼю області: зроблені ПІСЛЯ поточного лока
// АБО старіші, але ніде не застосовані до цієї області і не відхилені явно.
// Друга гілка закриває дірку перелочування: зміна під старішим (заміненим)
// локом випадала з вікна «createdAt > lockedAt» назавжди (кейс бекфілу
// легалізацій 21.08 — Sadovyi лишився без студентської ставки).
async function pendingJournalForScope(month: string, lock: LockRow, workerIds: number[]) {
  if (!workerIds.length) return [];
  const raw = await db.select({ c: workerChangesTable, adminName: adminsTable.name, workerName: workersTable.fullName })
    .from(workerChangesTable)
    .leftJoin(adminsTable, eq(workerChangesTable.adminId, adminsTable.id))
    .innerJoin(workersTable, eq(workerChangesTable.workerId, workersTable.id))
    .where(and(
      inArray(workerChangesTable.workerId, workerIds),
      sql`${workerChangesTable.effectiveDate} < ${nextMonthStart(month)}`))
    .orderBy(asc(workerChangesTable.createdAt));
  return raw.filter(({ c }) => c.createdAt > lock.lockedAt
    || (c.reviewDismissedAt == null && !appliedCoversScope(c, month, lock)));
}

// ── Kara до зняття по області, що розблоковується ────────────────────────────
// Незняті штрафи за пропуски місяця сводної (+ штрафи реєстру /penalties цього
// місяця), чий цільовий рядок (пара джерела або фолбек-основна фабрика — та
// сама логіка, що applyDeductionGroups) лежить у розлочуваній області. Поки
// вкладка затверджена, перенесення їх пропускає — при розлоку веб показує їх
// у ревʼю, прийняті переносяться apply-*-deductions одразу після розлоку.
// Люди без жодного рядка місяця — окремим інфо-списком «нема з чого зняти»
// (best-effort скоуп по фабриці джерела штрафу).
async function pendingKaraForScope(
  month: string, lock: LockRow, monthRows: (typeof svodniRowsTable.$inferSelect)[],
): Promise<{
  // пропуски ЗГРУПОВАНІ по людині+цільовому рядку (людина з 5 пропусками —
  // один рядок ревʼю з датами і сумою, не 5 «дублів»)
  absences: { workerId: number; workerName: string | null; dates: string[]; sourceFactories: string[]; targetFactoryLabel: string; entryIds: number[]; amount: number }[];
  penalties: { id: number; workerId: number; workerName: string | null; sourceFactory: string | null; targetFactoryLabel: string; amount: number; note: string | null }[];
  unrowed: { workerName: string | null; kind: "absence" | "penalty"; factory: string | null; count: number; amount: number }[];
}> {
  const monthStart = `${month}-01`;
  const monthEnd = nextMonthStart(month);
  const byHours = (a: typeof monthRows[number], b: typeof monthRows[number]) => (b.hours ?? 0) - (a.hours ?? 0);
  const targetRowFor = (workerId: number, factoryId: number | null) => {
    const mine = monthRows.filter(r => r.workerId === workerId);
    return (factoryId != null ? mine.filter(r => r.factoryId === factoryId).sort(byHours)[0] : undefined)
      ?? mine.sort(byHours)[0];
  };
  // скоуп для «безрядкових»: фабрика джерела збігається з розлочуваною вкладкою
  // або (міський лок) лежить у цьому місті сводної
  const scopeLabels = new Set(monthRows.filter(r => isLocked([lock], r.city, r.factoryLabel)).map(r => r.factoryLabel));
  const inScopeBySource = (facName: string | null, facCity: string | null) =>
    facName != null && (facName === lock.factoryLabel || scopeLabels.has(facName)
      || (lock.factoryLabel === "" && facCity === lock.city));

  const absRows = await db.select({ e: scheduleEntriesTable, weekStart: scheduleWeeksTable.weekStart, facName: factoriesTable.name, facCity: factoriesTable.city })
    .from(scheduleEntriesTable)
    .innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(
      eq(scheduleWeeksTable.status, "approved"),
      sql`${scheduleWeeksTable.weekStart} >= ${weekFromForMonth(monthStart)}`,
      sql`${scheduleWeeksTable.weekStart} < ${monthEnd}`,
      eq(scheduleEntriesTable.status, "absent"), eq(scheduleEntriesTable.absenceExcused, false),
      isNull(scheduleEntriesTable.absenceDeductedMonth)));
  const absItems = absRows
    .map(r => ({ ...r, date: entryDateStr(String(r.weekStart), r.e.dayOfWeek), amount: absencePenaltyOf(r.e) }))
    .filter(r => r.date >= monthStart && r.date < monthEnd && r.amount > 0);
  const penItems = (await db.select({ p: penaltiesTable, facName: factoriesTable.name, facCity: factoriesTable.city })
    .from(penaltiesTable).leftJoin(factoriesTable, eq(penaltiesTable.factoryId, factoriesTable.id))
    .where(and(eq(penaltiesTable.periodMonth, month), eq(penaltiesTable.deducted, false))))
    .map(x => ({ ...x, facName: x.facName ?? x.p.factoryLabel }));

  const wIds = [...new Set([...absItems.map(a => a.e.workerId), ...penItems.map(p => p.p.workerId)])];
  const names = new Map((wIds.length ? await db.select({ id: workersTable.id, name: workersTable.fullName })
    .from(workersTable).where(inArray(workersTable.id, wIds)) : []).map(w => [w.id, w.name]));

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const absGroups = new Map<string, Awaited<ReturnType<typeof pendingKaraForScope>>["absences"][number]>();
  const penalties: Awaited<ReturnType<typeof pendingKaraForScope>>["penalties"] = [];
  const unrowedGroups = new Map<string, Awaited<ReturnType<typeof pendingKaraForScope>>["unrowed"][number]>();
  const unrowedAdd = (workerId: number, kind: "absence" | "penalty", factory: string | null, amount: number) => {
    const key = `${workerId}|${kind}|${factory ?? ""}`;
    const g = unrowedGroups.get(key) ?? unrowedGroups.set(key, { workerName: names.get(workerId) ?? null, kind, factory, count: 0, amount: 0 }).get(key)!;
    g.count++;
    g.amount = r2(g.amount + amount);
  };
  for (const a of absItems) {
    const target = targetRowFor(a.e.workerId, a.e.factoryId);
    if (!target) {
      if (inScopeBySource(a.facName, a.facCity)) unrowedAdd(a.e.workerId, "absence", a.facName, a.amount);
      continue;
    }
    if (!isLocked([lock], target.city, target.factoryLabel)) continue;
    const key = `${a.e.workerId}|${target.factoryLabel}`;
    const g = absGroups.get(key) ?? absGroups.set(key, {
      workerId: a.e.workerId, workerName: names.get(a.e.workerId) ?? null,
      dates: [], sourceFactories: [], targetFactoryLabel: target.factoryLabel, entryIds: [], amount: 0,
    }).get(key)!;
    g.entryIds.push(a.e.id);
    g.dates.push(a.date);
    if (a.facName && !g.sourceFactories.includes(a.facName)) g.sourceFactories.push(a.facName);
    g.amount = r2(g.amount + a.amount);
  }
  for (const p of penItems) {
    const target = targetRowFor(p.p.workerId, p.p.factoryId);
    if (!target) {
      if (inScopeBySource(p.facName, p.facCity ?? null)) unrowedAdd(p.p.workerId, "penalty", p.facName, p.p.amount);
      continue;
    }
    if (!isLocked([lock], target.city, target.factoryLabel)) continue;
    penalties.push({ id: p.p.id, workerId: p.p.workerId, workerName: names.get(p.p.workerId) ?? null, sourceFactory: p.facName, targetFactoryLabel: target.factoryLabel, amount: p.p.amount, note: p.p.note });
  }
  const byName = (a: { workerName: string | null }, b: { workerName: string | null }) => (a.workerName ?? "").localeCompare(b.workerName ?? "", "pl");
  const absences = [...absGroups.values()];
  for (const g of absences) g.dates.sort();
  absences.sort(byName);
  penalties.sort(byName);
  const unrowed = [...unrowedGroups.values()].sort(byName);
  return { absences, penalties, unrowed };
}

router.post("/svodni/lock-pending", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  const city = String(req.body?.city ?? "").trim();
  const factoryLabel = String(req.body?.factoryLabel ?? "").trim();
  if (!month || !city) return fail(res, 400, "month і city обовʼязкові");
  const lock = (await monthLocks(month)).find(l => l.city === city && l.factoryLabel === factoryLabel);
  if (!lock) return fail(res, 400, "область не залочена");
  const sensitive = canSensitive(req);
  const fin = hasCap(req.admin!.role, req.admin!.caps, "viewFinance");
  // люди з рядками залоченої області цього місяця
  const monthRows = await db.select().from(svodniRowsTable).where(and(
    eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf),
    isNotNull(svodniRowsTable.workerId)));
  const workerIds = [...new Set(monthRows.filter(r => isLocked([lock], r.city, r.factoryLabel)).map(r => r.workerId!))];
  const pendingKara = await pendingKaraForScope(month, lock, monthRows);
  if (!workerIds.length) return ok(res, { lockedAt: lock.lockedAt, changes: [], hidden: 0, pendingKara });
  const pending = await pendingJournalForScope(month, lock, workerIds);
  const ws = await db.select().from(workersTable).where(inArray(workersTable.id, [...new Set(pending.map(x => x.c.workerId))]));
  const wById = new Map(ws.map(w => [w.id, w]));
  let hidden = 0;
  const out: Record<string, unknown>[] = [];
  for (const { c, adminName, workerName } of pending) {
    // «старі» = зроблені до поточного лока (дірка перелочування): показуємо
    // лише ті, що реально міняють цифри області — решта вже відображена в
    // рядках пізнішими перерахунками, докучати ними не треба
    const resurfaced = !(c.createdAt > lock.lockedAt);
    // гейти полів — дзеркало profile-impact: без капи зміну не показуємо
    // (старі гейтнуті не рахуємо і в hidden — їх уже показували в свій цикл)
    if ((FINANCE_TRACKED.has(c.field) && !fin) || (SENSITIVE_TRACKED.has(c.field) && !sensitive)) {
      if (!resurfaced) hidden++;
      continue;
    }
    const entry: Record<string, unknown> = {
      id: c.id, workerId: c.workerId, workerName, field: c.field,
      oldValue: c.oldValue, newValue: c.newValue, effectiveDate: c.effectiveDate,
      createdAt: c.createdAt, adminName, propagatable: PROPAGATABLE_FIELDS.has(c.field),
    };
    if (entry.propagatable) {
      // превʼю: «прийняти» = привести рядки області до ПОТОЧНОГО профілю по
      // цьому полю (кілька змін одного поля колапсують в один підсумковий диф)
      const w = wById.get(c.workerId);
      const ctx = w ? await profileChangeContext(c.workerId, { changes: { [c.field]: (w as any)[c.field] } }, c.effectiveDate, sensitive) : null;
      entry.items = ctx && !("err" in ctx)
        ? serializeImpact(ctx.items.filter(it => it.row.periodMonth === month && isLocked([lock], it.row.city, it.row.factoryLabel)), sensitive)
        : [];
    }
    if (resurfaced) {
      const items = (entry.items as { diffs: unknown[]; split?: unknown; merge?: unknown }[] | undefined) ?? [];
      if (!entry.propagatable || !items.some(it => it.diffs.length || it.split || it.merge)) continue;
    }
    out.push(entry);
  }
  ok(res, { lockedAt: lock.lockedAt, changes: out, hidden, pendingKara });
});

// Прийняті при розблокуванні зміни: групуємо по людині (union полів, значення —
// з ПОТОЧНОГО профілю, from = найраніша дата серед прийнятих), рахуємо тим самим
// двигуном, що profile-apply, і пишемо ЛИШЕ рядки щойно розлоченої області
// (інші локи, напр. міський поверх фабричного, поважаються). Журналу прийнятих
// змін дописується appliedRows, скоуп зникає зі skippedLocked.
async function applyReviewedChanges(month: string, scope: Pick<LockRow, "city" | "factoryLabel" | "lockedAt">, changeIds: number[], req: AuthedRequest): Promise<number> {
  const sensitive = canSensitive(req);
  const fin = hasCap(req.admin!.role, req.admin!.caps, "viewFinance");
  const entries = changeIds.length
    ? await db.select().from(workerChangesTable).where(inArray(workerChangesTable.id, changeIds)) : [];
  // критерій прийнятності — дзеркало pendingJournalForScope: зміни під поточним
  // локом АБО старіші незастосовані/невідхилені (дірка перелочування)
  const eligible = entries.filter(c => (c.createdAt > scope.lockedAt
      || (c.reviewDismissedAt == null && !appliedCoversScope(c, month, scope as LockRow)))
    && PROPAGATABLE_FIELDS.has(c.field)
    && !(FINANCE_TRACKED.has(c.field) && !fin)
    && !(SENSITIVE_TRACKED.has(c.field) && !sensitive));
  const byWorker = new Map<number, typeof eligible>();
  for (const c of eligible) { const l = byWorker.get(c.workerId) ?? []; l.push(c); byWorker.set(c.workerId, l); }
  let appliedTotal = 0;
  for (const [workerId, list] of byWorker) {
    const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
    if (!w) continue;
    const changes: Record<string, unknown> = {};
    for (const c of list) {
      // ставка, очищена в профілі пізніше (NULL = «авто»), двигуном не
      // приймається — таку зміну пропускаємо, рядок і так рахує from-hours
      if (c.field === "hourlyRate" && (w as any).hourlyRate == null) continue;
      changes[c.field] = (w as any)[c.field];
    }
    if (!Object.keys(changes).length) continue;
    const from = list.map(c => String(c.effectiveDate)).sort()[0]!;
    const ctx = await profileChangeContext(workerId, { changes }, from, sensitive);
    if ("err" in ctx) continue;
    const toApply = ctx.items.filter(it => !it.locked
      && it.row.periodMonth === month
      && isLocked([scope as LockRow], it.row.city, it.row.factoryLabel));
    if (!toApply.length) continue;
    for (const it of toApply) {
      if (it.plan) {
        await writeSegments(it.row, it.plan);
      } else {
        if (it.unsplit) await db.delete(svodniRowsTable).where(eq(svodniRowsTable.segmentOf, it.row.id));
        await db.update(svodniRowsTable).set({ ...it.set, manual: true, mismatch: null } as any).where(eq(svodniRowsTable.id, it.row.id));
      }
    }
    appliedTotal += toApply.length;
    const appliedScope = toApply.map(it => ({ month: it.row.periodMonth, city: it.row.city, factoryLabel: it.row.factoryLabel }));
    for (const c of list) {
      const prevApplied = Array.isArray(c.appliedRows) ? c.appliedRows as { month: string; city: string; factoryLabel: string }[] : [];
      const prevSkipped = (Array.isArray(c.skippedLocked) ? c.skippedLocked as { month: string; city: string; factoryLabel: string }[] : [])
        .filter(s => !appliedScope.some(a => a.month === s.month && a.city === s.city && a.factoryLabel === s.factoryLabel));
      await db.update(workerChangesTable).set({
        appliedRows: [...prevApplied, ...appliedScope],
        skippedLocked: prevSkipped.length ? prevSkipped : null,
      }).where(eq(workerChangesTable.id, c.id));
    }
  }
  return appliedTotal;
}

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

// ── Фабричні правила konto/готівки (factory_payout_rules) ────────────────────
// Версійні: «діє з» = місяць цілком (сводна місяця, в який потрапляє дата, вже
// за новим правилом). Фабрика без версій працює за legacy-правилами з коду
// (legacyPayoutRule). Читання — svodniSensitive (правила і є закритий шар),
// запис — viewFinance (як мінімальні ставки сводних).
const RULE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseRuleBody(body: Record<string, unknown>): { set?: Partial<typeof factoryPayoutRulesTable.$inferInsert>; err?: string } {
  const numOrNull = (v: unknown, name: string): { v?: number | null; err?: string } => {
    if (v == null || v === "") return { v: null };
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? { v: n } : { err: `${name} — невідʼємне число` };
  };
  const set: Partial<typeof factoryPayoutRulesTable.$inferInsert> = {};
  for (const [key, name] of [["capH", "стеля годин"], ["capHighH", "підвищена стеля"], ["capThresholdH", "поріг підвищеної стелі"], ["stazMinHours", "мін. години стажевого"]] as const) {
    if (key in body) {
      const r = numOrNull(body[key], name);
      if (r.err) return { err: r.err };
      set[key] = r.v;
    }
  }
  if ("cashBonus" in body) {
    const r = numOrNull(body.cashBonus, "готівковий бонус");
    if (r.err) return { err: r.err };
    set.cashBonus = r.v ?? 0;
  }
  if ("capFirm" in body) set.capFirm = String(body.capFirm ?? "").trim() || null;
  if ("stazBonus" in body) set.stazBonus = !!body.stazBonus;
  if ("premiaCash" in body) set.premiaCash = !!body.premiaCash;
  if ("note" in body) set.note = String(body.note ?? "").trim() || null;
  if ("stazSteps" in body) {
    if (body.stazSteps == null) set.stazSteps = [];
    else {
      if (!Array.isArray(body.stazSteps)) return { err: "сходинки стажу — масив {days, add}" };
      const steps: { days: number; add: number }[] = [];
      for (const s of body.stazSteps) {
        const days = Number((s as any)?.days), add = Number((s as any)?.add);
        if (!Number.isFinite(days) || days < 0 || !Number.isFinite(add)) return { err: "сходинка стажу: days ≥ 0, add — число" };
        steps.push({ days, add });
      }
      set.stazSteps = steps.sort((a, z) => a.days - z.days);
    }
  }
  if ("effectiveFrom" in body) {
    const d = String(body.effectiveFrom ?? "").trim();
    if (!RULE_DATE_RE.test(d)) return { err: "дата «діє з» — YYYY-MM-DD" };
    set.effectiveFrom = d;
  }
  return { set };
}

router.get("/svodni/factory-rules", requireCap("svodniSensitive"), async (req, res) => {
  const factoryId = Number(req.query.factoryId);
  if (!Number.isInteger(factoryId)) return fail(res, 400, "factoryId обовʼязковий");
  const [factory] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (!factory) return fail(res, 404, "фабрику не знайдено");
  const now = new Date();
  const month = validMonth(req.query.month) ? String(req.query.month) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const rules = await PayoutRules.load([factoryId]);
  const versions = await db.select().from(factoryPayoutRulesTable)
    .where(eq(factoryPayoutRulesTable.factoryId, factoryId))
    .orderBy(desc(factoryPayoutRulesTable.effectiveFrom));
  const effectiveRow = rules.rowFor(factoryId, month);
  ok(res, {
    factoryId, month,
    versions,
    legacy: legacyPayoutRule(factoryId, factory.name), // спадкові правила з коду (фолбек до першої версії)
    effective: rules.for(factoryId, factory.name, month),
    effectiveSource: effectiveRow ? { id: effectiveRow.id, effectiveFrom: effectiveRow.effectiveFrom } : "legacy",
  });
});

router.post("/svodni/factory-rules", requireCap("viewFinance"), async (req: AuthedRequest, res) => {
  const factoryId = Number(req.body?.factoryId);
  if (!Number.isInteger(factoryId)) return fail(res, 400, "factoryId обовʼязковий");
  const [factory] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (!factory) return fail(res, 404, "фабрику не знайдено");
  const { set, err } = parseRuleBody(req.body ?? {});
  if (err) return fail(res, 400, err);
  if (!set?.effectiveFrom) return fail(res, 400, "дата «діє з» обовʼязкова");
  const [dup] = await db.select({ id: factoryPayoutRulesTable.id }).from(factoryPayoutRulesTable)
    .where(and(eq(factoryPayoutRulesTable.factoryId, factoryId), eq(factoryPayoutRulesTable.effectiveFrom, set.effectiveFrom)));
  if (dup) return fail(res, 409, "версія з цією датою вже є — редагуй її");
  const [created] = await db.insert(factoryPayoutRulesTable).values({
    factoryId, effectiveFrom: set.effectiveFrom,
    capH: set.capH ?? null, capHighH: set.capHighH ?? null, capThresholdH: set.capThresholdH ?? null,
    capFirm: set.capFirm ?? null, cashBonus: set.cashBonus ?? 0, stazBonus: set.stazBonus ?? false,
    stazMinHours: set.stazMinHours ?? null, stazSteps: set.stazSteps ?? [], premiaCash: set.premiaCash ?? false,
    note: set.note ?? null, createdBy: req.admin!.adminId,
  }).returning();
  ok(res, created);
});

router.patch("/svodni/factory-rules/:id", requireCap("viewFinance"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(factoryPayoutRulesTable).where(eq(factoryPayoutRulesTable.id, id));
  if (!row) return fail(res, 404, "версію не знайдено");
  const { set, err } = parseRuleBody(req.body ?? {});
  if (err) return fail(res, 400, err);
  if (!set || !Object.keys(set).length) return fail(res, 400, "нема змін");
  if (set.effectiveFrom && set.effectiveFrom !== row.effectiveFrom) {
    const [dup] = await db.select({ id: factoryPayoutRulesTable.id }).from(factoryPayoutRulesTable)
      .where(and(eq(factoryPayoutRulesTable.factoryId, row.factoryId), eq(factoryPayoutRulesTable.effectiveFrom, set.effectiveFrom)));
    if (dup) return fail(res, 409, "версія з цією датою вже є");
  }
  const [updated] = await db.update(factoryPayoutRulesTable).set(set).where(eq(factoryPayoutRulesTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/svodni/factory-rules/:id", requireCap("viewFinance"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return fail(res, 400, "bad id");
  await db.delete(factoryPayoutRulesTable).where(eq(factoryPayoutRulesTable.id, id));
  ok(res, { ok: true });
});

// Перерахунок наявних рядків сводної фабрики від місяця після зміни правила:
// вшитий бонус перечитується від правила ДЕЛЬТОЮ поверх поточної ставки рядка
// (ручні правки ставки не скидаються — міняється лише бонусна частина), далі
// той самий ланцюжок, що ручна правка клітинки (computePayout →
// applyLegalDefaults). «Старий бонус» рядка БЕЗ маркера extras.facBonus — це
// НЕ нуль: рядки до ери маркерів (синк з таблиць, до 20.08.2026) несуть бонус
// вшитим у ставку за старим хардкодом, тож фолбек — бонус legacy-правила
// (нуль подвоював би бонус: перша ж версія правила LST додала +1 до вже
// бонусних 26,35 — інцидент 22.08.2026). Наслідок: перша версія, що повторює
// legacy, гарантовано не рухає ставки. Порізані рядки: дельта по кожному
// сегменту + сегментний двигун. Залочені вкладки пропускаються. Рядки без
// factory_id (легасі-вкладки без привʼязки) свідомо не чіпаються. dryRun —
// лише дифи для превʼю.
type RuleImpactRow = {
  id: number; month: string; city: string; factoryLabel: string; name: string;
  locked: boolean; segmented: boolean;
  diffs: { key: string; from: unknown; to: unknown }[];
};
async function factoryRuleRecompute(factoryId: number, fromMonth: string, dryRun: boolean): Promise<
  { err: string } | { rows: RuleImpactRow[]; updated: number; skippedLocked: number }
> {
  const [factory] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (!factory) return { err: "фабрику не знайдено" };
  const rules = await PayoutRules.load([factoryId]);
  const parents = await db.select().from(svodniRowsTable).where(and(
    eq(svodniRowsTable.factoryId, factoryId), isNull(svodniRowsTable.segmentOf),
    sql`${svodniRowsTable.periodMonth} >= ${fromMonth}`));
  if (!parents.length) return { rows: [], updated: 0, skippedLocked: 0 };
  const segs = await db.select().from(svodniRowsTable)
    .where(inArray(svodniRowsTable.segmentOf, parents.map(p => p.id)));
  const segsByParent = new Map<number, SegRow[]>();
  for (const s of segs) { const l = segsByParent.get(s.segmentOf!) ?? []; l.push(s); segsByParent.set(s.segmentOf!, l); }
  const workerIds = [...new Set(parents.map(p => p.workerId).filter((x): x is number => x != null))];
  const ws = workerIds.length ? await db.select().from(workersTable).where(inArray(workersTable.id, workerIds)) : [];
  const wById = new Map(ws.map(w => [w.id, w]));
  const locksByMonth = new Map<string, LockRow[]>();
  for (const month of new Set(parents.map(p => p.periodMonth))) locksByMonth.set(month, await monthLocks(month));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // вшитий бонус рядка без маркера facBonus — за legacy-правилом (див. шапку)
  const legacyRule = legacyPayoutRule(factoryId, factory.name);
  const oldBonusOf = (extras: unknown, w: typeof ws[number] | undefined, stud26: boolean, month: string, monthHours: number | null | undefined): number => {
    const marked = (extras as Record<string, unknown> | null)?.facBonus;
    if (typeof marked === "number") return marked;
    return stud26 || !w ? 0 : factoryBonusPerHour(w, legacyRule, month, monthHours);
  };
  const numish = (v: unknown) => typeof v === "number" ? r2(v) : v ?? null;
  const DIFF_KEYS = ["rateNetto", "doWyplaty", "hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const;
  const out: RuleImpactRow[] = [];
  let updated = 0, skippedLocked = 0;

  for (const row of parents.sort((a, z) => a.periodMonth.localeCompare(z.periodMonth) || a.sortIdx - z.sortIdx)) {
    if (OFFICE_TAB_RE.test(row.factoryLabel) || row.factoryLabel === EXTRA_STUDENTS_LABEL) continue;
    const locked = isLocked(locksByMonth.get(row.periodMonth) ?? [], row.city, row.factoryLabel);
    const rule = rules.for(factoryId, factory.name, row.periodMonth);
    const w = row.workerId != null ? wById.get(row.workerId) : undefined;
    const payoutPref = w?.payoutPrefKind ? { kind: w.payoutPrefKind as "all_konto" | "hours" | "amount", value: w.payoutPrefValue ?? null } : null;
    const rowSegs = (segsByParent.get(row.id) ?? []).sort((a, z) => (a.segmentFrom! < z.segmentFrom! ? -1 : 1));

    if (rowSegs.length) {
      // порізаний рядок: бонусна дельта по кожному сегменту, батько — сегментним двигуном
      const monthHours = r2(rowSegs.reduce((a, s) => a + (s.hours ?? 0), 0));
      const nextSegs = rowSegs.map(s => {
        const segStud26 = !!(s.isStudent && s.under26);
        const oldB = oldBonusOf(s.extras, w, segStud26, row.periodMonth, monthHours);
        const newB = !segStud26 && w ? factoryBonusPerHour(w, rule, row.periodMonth, monthHours) : segStud26 ? 0 : oldB;
        const rateNetto = r2(newB) !== r2(oldB) && s.rateNetto != null ? r2(Math.max(0, s.rateNetto - oldB + newB)) : s.rateNetto;
        return { seg: s, newBonus: r2(newB), oldBonus: r2(oldB), rateNetto };
      });
      const calc = computeSegmented(
        segParentInput(row, rule),
        nextSegs.map(({ seg, newBonus, rateNetto }): SegmentCalcIn => {
          const raw = (seg.extras as any)?.segLegal as string | undefined;
          return {
            hours: seg.hours, rateNetto, rateBrutto: seg.rateBrutto,
            isStudent: seg.isStudent, under26: seg.under26,
            legal: raw !== undefined ? (raw || null) : (w?.legalStatus ?? null),
            facBonus: newBonus > 0 ? newBonus : null,
          };
        }),
        payoutPref,
      );
      const diffs: RuleImpactRow["diffs"] = [];
      for (const k of DIFF_KEYS) {
        const nv = numish((calc.parent as any)[k]), ov = numish((row as any)[k]);
        if (nv !== ov) diffs.push({ key: k, from: (row as any)[k] ?? null, to: (calc.parent as any)[k] ?? null });
      }
      if (!diffs.length) continue;
      if (locked) { out.push({ id: row.id, month: row.periodMonth, city: row.city, factoryLabel: row.factoryLabel, name: row.rawName, locked, segmented: true, diffs }); skippedLocked++; continue; }
      if (!dryRun) {
        for (const { seg, newBonus, oldBonus, rateNetto } of nextSegs) {
          if (newBonus === oldBonus && rateNetto === seg.rateNetto) continue;
          const segExtras = { ...(seg.extras as Record<string, unknown>) };
          if (newBonus > 0) segExtras.facBonus = newBonus; else delete segExtras.facBonus;
          await db.update(svodniRowsTable).set({
            rateNetto,
            doWyplaty: seg.hours != null && rateNetto != null ? r2(seg.hours * rateNetto) : seg.doWyplaty,
            extras: segExtras,
          }).where(eq(svodniRowsTable.id, seg.id));
        }
        await recomputeSegmentedParent(row.id);
        updated++;
      }
      out.push({ id: row.id, month: row.periodMonth, city: row.city, factoryLabel: row.factoryLabel, name: row.rawName, locked, segmented: true, diffs });
      continue;
    }

    // звичайний рядок
    const merged: any = { ...row, extras: { ...(row.extras as Record<string, unknown>) } };
    const stud26 = merged.isStudent === true && merged.under26 === true;
    const oldBonus = oldBonusOf(merged.extras, w, stud26, row.periodMonth, row.hours);
    if (w && r2(stud26 ? 0 : factoryBonusPerHour(w, rule, row.periodMonth, row.hours)) !== r2(oldBonus)) {
      const newBonus = r2(stud26 ? 0 : factoryBonusPerHour(w, rule, row.periodMonth, row.hours));
      if (merged.rateNetto != null) merged.rateNetto = r2(Math.max(0, merged.rateNetto - oldBonus + newBonus));
      if (newBonus > 0) merged.extras.facBonus = newBonus; else delete merged.extras.facBonus;
    }
    const payout = computePayout(merged, row.city as any);
    if (payout != null) merged.doWyplaty = payout;
    applyLegalDefaults(merged, true, {
      profileLegal: (w?.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, city: row.city,
      firm: row.firm, factoryId, rule, payoutPref,
    });
    const diffs: RuleImpactRow["diffs"] = [];
    for (const k of DIFF_KEYS) {
      const nv = numish(merged[k]), ov = numish((row as any)[k]);
      if (nv !== ov) diffs.push({ key: k, from: (row as any)[k] ?? null, to: merged[k] ?? null });
    }
    const extrasChanged = JSON.stringify(merged.extras) !== JSON.stringify(row.extras);
    if (!diffs.length && !extrasChanged) continue;
    if (locked) { skippedLocked++; out.push({ id: row.id, month: row.periodMonth, city: row.city, factoryLabel: row.factoryLabel, name: row.rawName, locked, segmented: false, diffs }); continue; }
    if (!dryRun) {
      await db.update(svodniRowsTable).set({
        rateNetto: merged.rateNetto, doWyplaty: merged.doWyplaty, extras: merged.extras,
        hoursDeclared: merged.hoursDeclared, ksiegBrutto: merged.ksiegBrutto,
        ksiegNetto: merged.ksiegNetto, konto: merged.konto, gotowka: merged.gotowka,
        manual: true, mismatch: null,
      }).where(eq(svodniRowsTable.id, row.id));
      updated++;
    }
    out.push({ id: row.id, month: row.periodMonth, city: row.city, factoryLabel: row.factoryLabel, name: row.rawName, locked, segmented: false, diffs });
  }
  return { rows: out, updated, skippedLocked };
}

router.post("/svodni/factory-rules/impact", requireCap("viewFinance"), async (req, res) => {
  const factoryId = Number(req.body?.factoryId);
  const fromMonth = validMonth(req.body?.fromMonth) ? String(req.body.fromMonth) : null;
  if (!Number.isInteger(factoryId) || !fromMonth) return fail(res, 400, "factoryId і fromMonth=YYYY-MM обовʼязкові");
  const r = await factoryRuleRecompute(factoryId, fromMonth, true);
  if ("err" in r) return fail(res, 404, r.err);
  ok(res, r);
});

router.post("/svodni/factory-rules/recompute", requireCap("viewFinance"), async (req, res) => {
  const factoryId = Number(req.body?.factoryId);
  const fromMonth = validMonth(req.body?.fromMonth) ? String(req.body.fromMonth) : null;
  if (!Number.isInteger(factoryId) || !fromMonth) return fail(res, 400, "factoryId і fromMonth=YYYY-MM обовʼязкові");
  const r = await factoryRuleRecompute(factoryId, fromMonth, false);
  if ("err" in r) return fail(res, 404, r.err);
  ok(res, r);
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
  const raw = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName, workerLegal: workersTable.legalStatus, prefKind: workersTable.payoutPrefKind, prefValue: workersTable.payoutPrefValue, workerNationality: workersTable.nationality, workerCash: workersTable.agramCashBonus })
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
    .map(({ r, workerName, workerLegal, prefKind, prefValue, workerNationality }) => {
      const base = serializeRow(r, workerName, sensitive, workerLegal, prefKind ? { kind: prefKind, value: prefValue ?? null } : null);
      base.nationality = workerNationality; // прапорець біля імені у веб-таблиці
      const segs = segsOf.get(r.id);
      if (segs?.length) {
        delete base.ksiegMismatch; // ставка батька = min сегментів — пара легально «рвана»
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

  await enrichFirms(rows);

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
    .map(m => ({ city: m.city, factoryLabel: m.factoryLabel, colOrder: m.colOrder, info: m.info as Record<string, unknown> }));

  // Інфо-блок STAWKA EUROCASH: вкладка місяця без свого блоку (типово Eurocash —
  // сводну тепер робить сайт, вкладки в книзі Google ще нема) успадковує блок
  // найсвіжішого минулого місяця цього ж міста+factoryLabel — таблиця норм і
  // ставок видна щомісяця (та сама логіка, що у from-hours при розрахунку).
  {
    const hasBlock = (info: unknown) => !!(info as { stawkaEurocash?: unknown } | null)?.stawkaEurocash;
    const covered = new Set(tabMeta.filter(m => hasBlock(m.info)).map(m => `${m.city}|${m.factoryLabel}`));
    const wanted = new Map<string, { city: string; factoryLabel: string }>();
    for (const { r } of raw) {
      const k = `${r.city}|${r.factoryLabel}`;
      if (!covered.has(k) && tabAllowed(r.factoryLabel)) wanted.set(k, { city: r.city, factoryLabel: r.factoryLabel });
    }
    if (wanted.size) {
      const older = await db.select().from(svodniTabMetaTable).where(and(
        sql`${svodniTabMetaTable.periodMonth} < ${month}`,
        inArray(svodniTabMetaTable.factoryLabel, [...new Set([...wanted.values()].map(w => w.factoryLabel))]),
      )).orderBy(desc(svodniTabMetaTable.periodMonth));
      for (const w of wanted.values()) {
        const src = older.find(m => m.city === w.city && m.factoryLabel === w.factoryLabel && hasBlock(m.info));
        if (!src) continue;
        const block = (src.info as { stawkaEurocash: (string | number)[][] }).stawkaEurocash;
        const cur = tabMeta.find(m => m.city === w.city && m.factoryLabel === w.factoryLabel);
        if (cur) cur.info = { ...cur.info, stawkaEurocash: block };
        else tabMeta.push({ city: w.city, factoryLabel: w.factoryLabel, colOrder: [], info: { stawkaEurocash: block } });
      }
    }
  }

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
  // Попередження «нал-бонус, а готівки мало»: людина з галочкою нал-бонусу на
  // бонусній фабриці, розклад порахований, а готівкою виходить < 500 зл (або
  // вся мала виплата пішла на конто). Частина ЗП цих людей за домовленістю —
  // налом, тож «все на конто» = порушення домовленості, яке треба побачити до
  // виплати. Лише для закритого перегляду — суми готівки sensitive.
  const cashWarnings: { city: string; factoryLabel: string; name: string; gotowka: number }[] = [];
  if (sensitive) {
    const warnRules = await PayoutRules.load();
    for (const { r, workerName, workerCash } of raw) {
      if (r.segmentOf != null || !tabAllowed(r.factoryLabel)) continue;
      if (!workerCash || r.workerId == null || r.factoryId == null) continue;
      if (r.isStudent === true && r.under26 === true) continue; // студенту до 26 бонус не належить
      if (warnRules.for(r.factoryId, r.factoryLabel, month).cashBonus <= 0) continue;
      if (r.doWyplaty == null || r.konto == null) continue; // розклад ще не порахований
      const got = r.gotowka ?? 0;
      if (got + 0.005 < Math.min(500, Math.max(r.doWyplaty, 0)))
        cashWarnings.push({ city: r.city, factoryLabel: r.factoryLabel, name: workerName ?? r.rawName, gotowka: Math.round(got * 100) / 100 });
    }
  }
  const { KSIEG_STD_NETTO, KSIEG_STD_BRUTTO } = await import("../services/svodni");
  ok(res, { month, city, cities, rows, checks, tabMeta, sensitive, locks, staleLocks, cashWarnings, ksiegMin: { netto: KSIEG_STD_NETTO(), brutto: KSIEG_STD_BRUTTO() } });
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

  // фірма рядка: мульти-контрактна вкладка (Sushi&Food) — з профілю працівника
  // (групи фірм усередині таблиці), інакше — фірма фабрики
  const firm = factory?.multiFirm
    ? (worker!.companyId != null ? companies.find(c => c.id === worker!.companyId)?.name ?? null : null)
    : factory?.companyId ? companies.find(c => c.id === factory.companyId)?.name ?? null : null;

  // префіл із профілю — властивості людини «їдуть» за нею між місяцями
  const under26 = worker!.birthDate ? isUnder26(worker!.birthDate) : worker!.under26;
  const hr: Record<string, string> = {};
  if (worker!.birthDate) {
    const [y, m, d] = worker!.birthDate.split("-");
    hr.dataUrodzenia = `${d}.${m}.${y}`;
  }
  // бонусні фабрики (Agram нал+стаж, LST нал): до профільної ставки додається
  // бонус (він же в extras.facBonus — розклад тримає його готівкою);
  // студенту до 26 бонуси не нараховуються
  const stud26Add = (worker!.isStudent || worker!.legalStatus === "student") && !!under26;
  const facBonus = !stud26Add && factory != null
    ? factoryBonusPerHour(worker!, await payoutRuleForRow({ factoryId: factory.id, factoryLabel, periodMonth }), periodMonth, null)
    : 0;
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
    extras: facBonus > 0 && prefillNetto != null ? { facBonus } : {}, hr, sheetValues: {},
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
  const merged: any = { ...row, extras: { ...(row.extras as Record<string, unknown>) } };
  let w: typeof workersTable.$inferSelect | undefined;
  if (row.workerId != null) [w] = await db.select().from(workersTable).where(eq(workersTable.id, row.workerId));
  // вшитий бонус (Agram/LST) після зшивання — від поточного профілю: сегментні
  // значення знесено разом із сегментами, а батько тримає min-ставки
  const unsplitRule = await payoutRuleForRow(row);
  if (w && row.factoryId != null && hasCashBonus(unsplitRule)) {
    const stud26U = !!(row.isStudent && row.under26);
    const bonusU = stud26U ? 0 : factoryBonusPerHour(w, unsplitRule, row.periodMonth, row.hours);
    if (bonusU > 0) merged.extras.facBonus = bonusU; else delete merged.extras.facBonus;
  }
  const payout = computePayout(merged, row.city as any);
  if (payout != null) merged.doWyplaty = payout;
  if (merged.hours != null && merged.rateBrutto != null) merged.brutto = rnd2(merged.hours * merged.rateBrutto);
  if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
    applyLegalDefaults(merged, true, {
      profileLegal: (w?.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, city: row.city, firm: row.firm,
      factoryId: row.factoryId, rule: unsplitRule,
      payoutPref: w?.payoutPrefKind ? { kind: w.payoutPrefKind as any, value: w.payoutPrefValue ?? null } : null,
    });
  }
  await db.update(svodniRowsTable).set({
    doWyplaty: merged.doWyplaty, brutto: merged.brutto, extras: merged.extras,
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
    if (netto != null && !stud26Row && merged.factoryId != null) {
      const syncRule = await payoutRuleForRow({ factoryId: merged.factoryId, factoryLabel: merged.factoryLabel ?? "", periodMonth: merged.periodMonth });
      if (hasCashBonus(syncRule)) {
        const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
        if (w) netto = Math.round(Math.max(0, netto - factoryBonusPerHour(w, syncRule, merged.periodMonth, merged.hours)) * 100) / 100;
      }
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
type SegState = { rateNetto: number | null; rateBrutto: number | null; section: string | null; isStudent: boolean | null; under26: boolean | null; label: string | null; legal: string | null; facBonus: number | null };

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
    && sameLegal(a.legal, b.legal) && (a.label ?? null) === (b.label ?? null)
    // однакова ставка може складатися з різних бонусів (25.35+1 vs 26.35+0) —
    // готівкова частина різна, такі вікна не зшиваємо
    && (a.facBonus ?? null) === (b.facBonus ?? null);
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
    const fbRaw = (src.extras as any)?.facBonus;
    return {
      rateNetto: src.rateNetto, rateBrutto: src.rateBrutto, section: src.section,
      isStudent: src.isStudent, under26: src.under26, label: seg?.segmentLabel ?? null, legal: legal ?? null,
      facBonus: typeof fbRaw === "number" ? fbRaw : null,
    };
  };
}

// вхід computeSegmented з батьківського рядка БД
function segParentInput(row: SegRow, rule?: PayoutRule | null) {
  return {
    city: row.city, factoryLabel: row.factoryLabel, firm: row.firm, factoryId: row.factoryId,
    ...(rule !== undefined ? { rule } : {}),
    hoursNotified: row.hoursNotified,
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
  const parentRule = await payoutRuleForRow(parent);
  // вшитий бонус сегмента: збережений у extras; легасі-сегменти без нього —
  // від поточного профілю (160-годинний гейт стажу — від місячної суми годин)
  const monthHours = Math.round(segs.reduce((a, s) => a + (s.hours ?? 0), 0) * 100) / 100;
  const segFacBonus = (s: SegRow): number | null => {
    const raw = (s.extras as any)?.facBonus;
    if (typeof raw === "number") return raw;
    if (!w || parent.factoryId == null || !hasCashBonus(parentRule)) return null;
    const stud26 = !!(s.isStudent && s.under26);
    return stud26 ? 0 : factoryBonusPerHour(w, parentRule, parent.periodMonth, monthHours);
  };
  const calc = computeSegmented(
    segParentInput(parent, parentRule),
    segs.map((s): SegmentCalcIn => {
      const raw = (s.extras as any)?.segLegal as string | undefined;
      return {
        hours: s.hours, rateNetto: s.rateNetto, rateBrutto: s.rateBrutto,
        isStudent: s.isStudent, under26: s.under26,
        // "" = явно без статусу; відсутній ключ (старі рядки) — поточний профіль
        legal: raw !== undefined ? (raw || null) : (w?.legalStatus ?? null),
        facBonus: segFacBonus(s),
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
export async function writeSegments(parent: SegRow, plan: NonNullable<Awaited<ReturnType<typeof planSegments>>>): Promise<void> {
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
      // який означав би «взяти поточний профіль»); manualHours — «липкі» години;
      // facBonus — вшитий бонус СВОГО вікна (завжди готівковий)
      extras: {
        segLegal: p.legal ?? "",
        ...(p.manualHours ? { manualHours: true } : {}),
        ...(p.facBonus != null && p.facBonus > 0 ? { facBonus: p.facBonus } : {}),
      },
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
    // очищення дати скидає прапорець (дзеркало PATCH /workers): без дати
    // не вважаємо пільговиком «до 26»
    patch.under26 = bd ? isUnder26(bd) : false;
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
  payoutRule?: PayoutRule | null, // правило konto/готівки фабрики на місяць рядка
): { set: Record<string, unknown>; diffs: RowDiff[]; merged: any } {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const merged: any = { ...row, extras: { ...(row.extras as Record<string, unknown>) }, hr: { ...(row.hr as Record<string, string>) } };
  const payRule = payoutRule !== undefined ? payoutRule : legacyPayoutRule(row.factoryId, row.factoryLabel);
  const isBonusFac = row.factoryId != null && hasCashBonus(payRule);
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
      // бонусні фабрики (Agram нал+стаж, LST нал): бонус поверх бази і в
      // extras.facBonus (розклад тримає його готівкою);
      // студент до 26 неоподаткований — нетто = брутто БЕЗ бонусів
      const b = stud26 ? (base.brutto ?? merged.rateBrutto ?? null) : (base.netto ?? KSIEG_STD_NETTO());
      const bonus = stud26 ? 0 : factoryBonusPerHour(w, payRule, row.periodMonth, row.hours);
      if (b != null) {
        merged.rateNetto = r2(b + bonus);
        if (bonus > 0) merged.extras.facBonus = bonus; else delete merged.extras.facBonus;
      }
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
    // рядок без ставок (доданий вручну, поки людина була «не оформлена»):
    // статусна зміна підставляє базову пару — без нетто computePayout лишає
    // «до виплати» порожнім і рядок після легалізації не оживає
    if (statusTouched && merged.rateBrutto == null && base.brutto != null) merged.rateBrutto = base.brutto;
    if (statusTouched && !stud26 && merged.rateNetto == null && base.netto != null) merged.rateNetto = base.netto;
  }
  // похідні: до виплати/брутто + місячний розклад konto/готівки за правилами
  const payout = computePayout(merged, row.city as any);
  if (payout != null) merged.doWyplaty = payout;
  if (merged.hours != null && merged.rateBrutto != null) merged.brutto = r2(merged.hours * merged.rateBrutto);
  if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
    applyLegalDefaults(merged, true, {
      profileLegal: (w.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, city: row.city, firm: row.firm,
      factoryId: row.factoryId, rule: payRule,
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
export async function profileChangeContext(workerId: number, body: Record<string, unknown>, from: string, sensitive: boolean) {
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
  const payoutRules = await PayoutRules.load();
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
    const rowPayoutRule = payoutRules.for(row.factoryId, row.factoryLabel, row.periodMonth);
    const { set, diffs, merged } = rowSetFromProfile(row, nextW, changed, sectionOf(row), ruleOf(row.factoryId, nextW.positionId), rowPayoutRule);
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
      const isBonusRow = row.factoryId != null && hasCashBonus(rowPayoutRule);
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
            const bonusW = stud26w ? 0 : factoryBonusPerHour(nextW, rowPayoutRule, row.periodMonth, row.hours);
            if (b != null) {
              st.rateNetto = r2o(b + bonusW);
              st.facBonus = bonusW > 0 ? bonusW : null;
            }
          } else if (stud26w) {
            st.rateNetto = st.rateBrutto ?? resolved.brutto ?? st.rateNetto; // неоподаткований: нетто = брутто
          } else if ((nextW.hourlyRateNetto ?? resolved.netto) != null) {
            st.rateNetto = nextW.hourlyRateNetto ?? resolved.netto;
          }
        }
        // вікно без ставок (рядок був «не оформлений»): статусна зміна
        // підставляє базову пару — інакше сегмент лишається без «до виплати»
        if (legalChanged || changed.has("birthDate")) {
          if (st.rateBrutto == null && resolved.brutto != null) st.rateBrutto = resolved.brutto;
          if (!stud26w && st.rateNetto == null && resolved.netto != null) st.rateNetto = resolved.netto;
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
          extras: { ...(row.extras as Record<string, unknown>) },
        };
        // вшитий бонус зшитого місяця — з єдиного вікна плану
        if (uniform.facBonus != null && uniform.facBonus > 0) m3.extras.facBonus = uniform.facBonus;
        else delete m3.extras.facBonus;
        const payout3 = computePayout(m3, row.city as any);
        if (payout3 != null) m3.doWyplaty = payout3;
        if (m3.hours != null && m3.rateBrutto != null) m3.brutto = Math.round(m3.hours * m3.rateBrutto * 100) / 100;
        if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
          applyLegalDefaults(m3, true, {
            profileLegal: (uniform.legal ?? null) as any, factoryLabel: row.factoryLabel, city: row.city, firm: row.firm,
            factoryId: row.factoryId, rule: rowPayoutRule,
            payoutPref: nextW.payoutPrefKind ? { kind: nextW.payoutPrefKind as any, value: nextW.payoutPrefValue ?? null } : null,
          });
        }
        const uSet: Record<string, unknown> = {};
        const uDiffs: RowDiff[] = [];
        if (JSON.stringify(m3.extras) !== JSON.stringify(row.extras)) uSet.extras = m3.extras;
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
          segParentInput(row, rowPayoutRule),
          plan.parts.map((p): SegmentCalcIn => ({
            hours: p.hours, rateNetto: p.rateNetto, rateBrutto: p.rateBrutto,
            isStudent: p.isStudent, under26: p.under26, legal: p.legal, facBonus: p.facBonus,
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
    const noteOut = await withSegments(
      serializeRow(u!.r, u!.workerName, canSensitive(req), u!.workerLegal, u!.prefKind ? { kind: u!.prefKind, value: u!.prefValue ?? null } : null),
      id, canSensitive(req), u!.workerLegal);
    await enrichFirms([noteOut]);
    return ok(res, noteOut);
  }
  if (isLocked(await monthLocks(row.periodMonth), row.city, row.factoryLabel))
    return fail(res, 409, "Фабрику затверджено — спершу розблокуй");
  const patchRule = await payoutRuleForRow(row);
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
    if (!parent) return ok(res, { ok: true });
    const parentOut = await withSegments(
      serializeRow(parent.r, parent.workerName, canSensitive(req), parent.workerLegal, parent.prefKind ? { kind: parent.prefKind, value: parent.prefValue ?? null } : null),
      parent.r.id, canSensitive(req), parent.workerLegal);
    await enrichFirms([parentOut]);
    return ok(res, parentOut);
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
        applyLegalDefaults(mergedZ, true, { profileLegal: profileLegal as any, factoryLabel: row.factoryLabel, payoutPref, city: row.city, firm: row.firm, factoryId: row.factoryId, rule: patchRule });
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
    applyLegalDefaults(merged, true, { profileLegal: profileLegal as any, factoryLabel: row.factoryLabel, payoutPref, city: row.city, firm: row.firm, factoryId: row.factoryId, rule: patchRule });
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
  const out = await withSegments(
    serializeRow(updated!.r, updated!.workerName, canSensitive(req), updated!.workerLegal, updated!.prefKind ? { kind: updated!.prefKind, value: updated!.prefValue ?? null } : null),
    id, canSensitive(req), updated!.workerLegal);
  await enrichFirms([out]);
  ok(res, out);
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
  // (Sushi&Food: ES + ESO). Вивід з фірм працівників був багом: разова
  // підміна/помилка профілю ділила вкладки одноконтрактних клієнтів
  // (BIMIZ, PREMIUM FRUITS — 08.2026). Вкладка ОДНА (рішення 08.2026 — раніше
  // ділилась суфіксами «… ESO» / «… EURO SUPORT»), фірма працівника пишеться
  // в svodni_rows.firm — веб/Excel малюють розділові рядки груп усередині
  // таблиці. firmSuffixFor лишився для матчингу legacy-рядків під старими
  // назвами вкладок (findSvodniRowForPair).
  const companiesAll = await db.select().from(companiesTable);
  const coNameById = new Map(companiesAll.map(c => [c.id, c.name]));
  const firmOf = (w0: typeof workers[number]): string | null => coNameById.get(w0.companyId ?? -1) ?? null;
  const firmSuffixFor = (fac: typeof facRows[number] | undefined, w0: typeof workers[number]): string => {
    if (!fac?.multiFirm) return "";
    const cn = firmOf(w0) ?? "";
    return cn === "ES" ? "EURO SUPORT" : cn.toUpperCase(); // як вкладки таблиці
  };
  const tabLabelFor = (fac: typeof facRows[number] | undefined): string => fac ? fac.name : "Без фабрики";
  // становіска: назва позиції працівника → секція рядка (для фабрик з посадами)
  const positions = await db.select().from(positionsTable);
  const posById = new Map(positions.map(p => [p.id, p.name]));
  const ruleOf = await loadRateRules();
  const payoutRules = await PayoutRules.load();

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

  // системне джерело відрахувань: зняття за хостел (вкладка «Хостели») → Hostel.
  // Залічки from-hours НЕ заповнює: виплачені аванси переносяться масовою дією
  // «У сводну» на сторінці Аванси (POST /svodni/apply-zaliczki, після звірки виплат).
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
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let created = 0, updated = 0, skippedNoRate = 0;
  // самозвірка після запису: що передали ↔ що реально лежить у сводній
  const expectedRows: { workerId: number; label: string; hours: number; name: string }[] = [];

  // 4) борги минулого місяця: рядок M−1 з мінусовою виплатою (зняли більше, ніж
  // зароблено) авто-переноситься В ТУ Ж колонку рядка M цієї пари — «черга
  // знять» DEBT_DEDUCTION_ORDER (недознятими вважаються останні). Повторний
  // прогін ідемпотентний: старий debtIn спершу віднімається, борг перечитується
  // з актуального рядка M−1. Джерело не змінюється (тільки маркер debtOut).
  const prevMonth = m! === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, "0")}`;
  const prevDebtRows = await db.select().from(svodniRowsTable).where(and(
    eq(svodniRowsTable.periodMonth, prevMonth), isNull(svodniRowsTable.segmentOf),
    sql`(${svodniRowsTable.doWyplaty} < 0 or jsonb_exists(${svodniRowsTable.extras}, 'debtOut'))`,
  ));
  const debtByPair = new Map<string, { row: typeof prevDebtRows[number]; carry: Record<string, number> | null; total: number }>();
  for (const prow of prevDebtRows) {
    if (prow.workerId == null || prow.factoryId == null) continue;
    const carry = debtCarryFromRow(prow as any, prow.city);
    const total = carry ? r2(Object.values(carry).reduce((a, b) => a + b, 0)) : 0;
    debtByPair.set(key2(prow.workerId, prow.factoryId), { row: prow, carry, total });
  }
  const debtCarried: { name: string; factoryLabel: string; amount: number }[] = [];
  const debtSettled = new Set<string>(); // пари, чий борг цим прогоном перенесено/знято в цілі
  // застосувати борг до колонок цілі: fresh-колонки (свіжі системні значення —
  // аванси/хостел) старого боргу не містять, тож віднімається він лише з решти
  const applyDebtCols = (
    cols: Record<string, number | null>, extrasObj: Record<string, unknown>,
    carry: Record<string, number> | null, fresh: Set<string>,
  ) => {
    const old = ((extrasObj.debtIn as { cols?: Record<string, number> } | undefined)?.cols) ?? {};
    for (const k of new Set([...Object.keys(old), ...Object.keys(carry ?? {})])) {
      const oldV = fresh.has(k) ? 0 : typeof old[k] === "number" ? old[k]! : 0;
      const newV = carry?.[k] ?? 0;
      if (k.startsWith("extras.")) {
        const ek = k.slice(7);
        const cur = typeof extrasObj[ek] === "number" ? (extrasObj[ek] as number) : 0;
        const next = r2(cur - oldV + newV);
        if (next !== 0) extrasObj[ek] = next; else delete extrasObj[ek];
      } else {
        const cur = typeof cols[k] === "number" ? (cols[k] as number) : 0;
        const next = r2(cur - oldV + newV);
        cols[k] = next !== 0 ? next : null;
      }
    }
    if (carry) extrasObj.debtIn = { from: prevMonth, cols: carry };
    else delete extrasObj.debtIn;
  };
  for (const pair of hoursByPair.values()) {
    const w = wById.get(pair.workerId);
    if (!w) continue;
    const fac = pair.factoryId != null ? facById.get(pair.factoryId) : undefined;
    const factoryLabel = tabLabelFor(fac);
    const rowFirm = fac?.multiFirm ? firmOf(w) : null; // фірма — лише на мульти-контрактних вкладках
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
    const pairRule = payoutRules.for(pair.factoryId, factoryLabel, month);
    const isBonusFac = pair.factoryId != null && hasCashBonus(pairRule);
    const stud26 = (w.isStudent || w.legalStatus === "student") && !!under26;
    const base = resolveBaseRates(w, rules, stud26);
    const bonus = stud26 ? 0 : factoryBonusPerHour(w, pairRule, month, r2(pair.hours));
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
          // потроненя: за błędy + inne (Białystok ROZLICZENIE) — у сводній одна колонка
          const potrSum = (ecx.potracenia ?? 0) + (ecx.innePotracenia ?? 0);
          ec = {
            rateBrutto: ecRates.brutto[idx]!,
            rateNetto: stud26 ? ecRates.brutto[idx]! : ecRates.netto[idx]!,
            nocneH: ecx.nocneH != null && ecx.nocneH > 0 ? r2(ecx.nocneH) : null,
            doplataNocna: stud26 ? ecRates.nightBrutto : ecRates.nightNetto,
            potracenia: potrSum !== 0 ? r2(potrSum) : null,
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
    const prev = findSvodniRowForPair(existing, {
      workerId: pair.workerId, factoryId: pair.factoryId, label: factoryLabel,
      firmSuffix: firmSuffixFor(fac, w), multiFirm: !!fac?.multiFirm,
    });
    // рядок знайдено по id під СТАРОЮ назвою вкладки — лок-фільтр вище звіряв
    // лише поточну назву фабрики, тож тут перевіряємо і фактичний label рядка
    if (prev && prev.factoryLabel !== factoryLabel && isLocked(locks, city, prev.factoryLabel)) { skippedLocked++; continue; }
    // самозвірка читає рядок під його фактичним label (вкладка не «переїжджає»)
    expectedRows.push({ workerId: pair.workerId, label: prev?.factoryLabel ?? factoryLabel, hours: r2(pair.hours), name: w.fullName });
    // борг цієї пари з минулого місяця (мінусова виплата M−1)
    const debtSrc = debtByPair.get(key2(pair.workerId, pair.factoryId));
    const markDebt = () => {
      debtSettled.add(key2(pair.workerId, pair.factoryId));
      if (debtSrc?.carry) debtCarried.push({ name: w.fullName, factoryLabel, amount: debtSrc.total });
    };
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
        const hosS = isMainPair(pair) ? hostelByWorker.get(pair.workerId) : undefined;
        // борг M−1 — місячний ввід на батькові (перерозкладе сегментний двигун)
        const segCols: Record<string, number | null> = {
          zaliczka: prev.zaliczka,
          zaliczkaBd: prev.zaliczkaBd,
          hostel: hosS != null ? r2(hosS) : prev.hostel,
          odziez: prev.odziez, dojazd: prev.dojazd, kara: prev.kara,
          komornik: prev.komornik, kaucja: prev.kaucja, potracenia: prev.potracenia,
        };
        const segExtras = { ...(prev.extras as Record<string, unknown>) };
        applyDebtCols(segCols, segExtras, debtSrc?.carry ?? null,
          new Set(hosS != null ? ["hostel"] : []));
        await db.update(svodniRowsTable).set({
          ...segCols, extras: segExtras,
          ...(fac?.multiFirm ? { firm: rowFirm } : {}),
        }).where(eq(svodniRowsTable.id, prev.id));
        await recomputeSegmentedParent(prev.id);
        if (debtSrc) markDebt();
        updated++;
        continue;
      }
      // повторне підтвердження: оновлюємо години + системний хостел (залічки
      // переносяться окремою масовою дією, тут не чіпаються), перераховуємо
      // формули; інші ручні правки (кари, odzież…) не затираються.
      // Бонусні фабрики (Agram/LST): ставка перечитується (галочки/дата могли змінитися)
      // Eurocash: файл фабрики авторитетний — ставки/нічні/потроненя перекриваються
      const hos = isMainPair(pair) ? hostelByWorker.get(pair.workerId) : undefined;
      const mergedExtras: Record<string, number | string> = { ...((prev.extras as Record<string, number | string>) ?? {}) };
      if (ec) {
        if (ec.nocneH != null) { mergedExtras.nocneH = ec.nocneH; mergedExtras.doplataNocna = ec.doplataNocna; }
        else { delete mergedExtras.nocneH; delete mergedExtras.doplataNocna; }
      }
      // бонусна фабрика: вшитий бонус синхронно зі свіжоперечитаною ставкою
      if (isBonusFac) {
        if (bonus > 0) mergedExtras.facBonus = bonus; else delete mergedExtras.facBonus;
      }
      // борг M−1 в ті ж колонки: свіжі системні значення (аванси/хостел,
      // Eurocash-потроненя) старого боргу не містять — віднімається він з решти
      const debtCols: Record<string, number | null> = {
        zaliczka: prev.zaliczka,
        zaliczkaBd: prev.zaliczkaBd,
        hostel: hos != null ? r2(hos) : prev.hostel,
        odziez: prev.odziez, dojazd: prev.dojazd, kara: prev.kara,
        komornik: prev.komornik, kaucja: prev.kaucja,
        potracenia: ec ? ec.potracenia : prev.potracenia,
      };
      const debtTouched = !!debtSrc?.carry || (prev.extras as any)?.debtIn != null;
      applyDebtCols(debtCols, mergedExtras as Record<string, unknown>, debtSrc?.carry ?? null,
        new Set([...(hos != null ? ["hostel"] : []), ...(ec ? ["potracenia"] : [])]));
      const merged: any = {
        ...prev, hours: r2(pair.hours),
        firm: fac?.multiFirm ? rowFirm : prev.firm,
        rateNetto: ec ? ec.rateNetto : isBonusFac ? bonusNetto() ?? prev.rateNetto : prev.rateNetto,
        rateBrutto: ec ? ec.rateBrutto : prev.rateBrutto,
        extras: mergedExtras,
        ...debtCols,
      };
      const payout = computePayout(merged, city as any);
      if (payout != null) merged.doWyplaty = payout;
      if (merged.hours != null && merged.rateBrutto != null) merged.brutto = r2(merged.hours * merged.rateBrutto);
      applyLegalDefaults(merged, true, { profileLegal: (w.legalStatus ?? null) as any, factoryLabel, city, payoutPref, firm: merged.firm, factoryId: pair.factoryId, rule: pairRule });
      const unregU = isUnregistered(w, r2(pair.hours));
      if (unregU) merged.extras = { ...merged.extras, zusStatus: "не оформлений" };
      await db.update(svodniRowsTable).set({
        hours: merged.hours, rateNetto: merged.rateNetto, zaliczka: merged.zaliczka, hostel: merged.hostel,
        firm: merged.firm,
        ...(ec || unregU || isBonusFac || debtTouched ? { extras: merged.extras } : {}),
        ...(ec ? { rateBrutto: merged.rateBrutto, potracenia: merged.potracenia } : {}),
        ...(debtTouched ? {
          zaliczkaBd: merged.zaliczkaBd, odziez: merged.odziez, dojazd: merged.dojazd,
          kara: merged.kara, komornik: merged.komornik, kaucja: merged.kaucja, potracenia: merged.potracenia,
        } : {}),
        doWyplaty: merged.doWyplaty, brutto: merged.brutto,
        hoursDeclared: merged.hoursDeclared, ksiegBrutto: merged.ksiegBrutto,
        ksiegNetto: merged.ksiegNetto, konto: merged.konto, gotowka: merged.gotowka,
        section: section ?? prev.section,
        manual: true, mismatch: null,
      }).where(eq(svodniRowsTable.id, prev.id));
      if (debtSrc) markDebt();
      updated++;
      continue;
    }
    const hr: Record<string, string> = {};
    if (w.birthDate) { const [yy, mm, dd] = w.birthDate.split("-"); hr.dataUrodzenia = `${dd}.${mm}.${yy}`; }
    const row: any = {
      periodMonth: month, city, firm: rowFirm, factoryLabel, factoryId: pair.factoryId,
      section, sortIdx: created, rawName: w.fullName, workerId: w.id, linkStatus: "confirmed",
      manual: true, // сайт — джерело: синк із Google цей рядок не перезаписує
      hoursNotified: w.notifyHours ?? null, hours: r2(pair.hours),
      // без статусу легалізації і без ставки (профіль+правила) — мінімалка
      // («як по освядченню»); розклад applyLegalDefaults і так віддасть готівкою.
      // Eurocash: пара від порогу продуктивності + нічні/потроненя з файлу фабрики
      rateBrutto: ec ? ec.rateBrutto : base.brutto ?? (w.legalStatus == null || (isBonusFac && !stud26) ? KSIEG_STD_BRUTTO() : null),
      rateNetto: ec ? ec.rateNetto : isBonusFac ? bonusNetto() : base.netto ?? (w.legalStatus == null ? KSIEG_STD_NETTO() : null),
      potracenia: ec ? ec.potracenia : null,
      zaliczka: null, // залічки переносяться масовою дією «У сводну» (apply-zaliczki)
      hostel: isMainPair(pair) && hostelByWorker.has(pair.workerId) ? r2(hostelByWorker.get(pair.workerId)!) : null,
      isStudent: w.isStudent, under26,
      extras: {
        ...(ec && ec.nocneH != null ? { nocneH: ec.nocneH, doplataNocna: ec.doplataNocna } : {}),
        // вшитий бонус (Agram/LST) — розклад тримає його готівкою
        ...(bonus > 0 ? { facBonus: bonus } : {}),
      },
      hr, sheetValues: {}, mismatch: null,
      doWyplaty: null, brutto: null,
    };
    if (row.rateNetto == null) skippedNoRate++;
    // борг M−1 — у ті ж колонки нового рядка
    if (debtSrc?.carry) {
      for (const [k, v] of Object.entries(debtSrc.carry)) {
        if (k.startsWith("extras.")) {
          const ek = k.slice(7);
          row.extras[ek] = r2((typeof row.extras[ek] === "number" ? row.extras[ek] : 0) + v);
        } else row[k] = r2((row[k] ?? 0) + v);
      }
      row.extras.debtIn = { from: prevMonth, cols: debtSrc.carry };
    }
    row.doWyplaty = computePayout(row, city as any);
    if (row.hours != null && row.rateBrutto != null) row.brutto = r2(row.hours * row.rateBrutto);
    applyLegalDefaults(row, true, { profileLegal: (w.legalStatus ?? null) as any, factoryLabel, city, payoutPref, firm: rowFirm, factoryId: pair.factoryId, rule: pairRule });
    if (isUnregistered(w, r2(pair.hours))) row.extras = { ...row.extras, zusStatus: "не оформлений" };
    await db.insert(svodniRowsTable).values(row);
    if (debtSrc) markDebt();
    created++;
  }
  // Маркери на джерелах боргу (M−1, best-effort: залочені не чіпаємо) + звіт
  // про борги в скоупі прогону, які перенести не вдалося (нема рядка пари в M)
  const prevLocks = await monthLocks(prevMonth);
  const debtUnmatched: { name: string; factoryLabel: string; amount: number }[] = [];
  for (const [k, d] of debtByPair) {
    const inScope = (onlyFactoryId == null || d.row.factoryId === onlyFactoryId)
      && (!onlyCity || d.row.city === onlyCity)
      && (!onlyWorkerIds || onlyWorkerIds.has(d.row.workerId!));
    if (!inScope) continue;
    const settled = debtSettled.has(k);
    if (!settled && d.carry) debtUnmatched.push({ name: d.row.rawName, factoryLabel: d.row.factoryLabel, amount: d.total });
    if (isLocked(prevLocks, d.row.city, d.row.factoryLabel)) continue;
    const ex = { ...(d.row.extras as Record<string, unknown>) };
    const curOut = ex.debtOut as { to?: string; amount?: number } | undefined;
    if (settled && d.carry) {
      if (curOut?.to === month && curOut?.amount === d.total) continue;
      ex.debtOut = { to: month, amount: d.total };
    } else if (!d.carry) {
      if (curOut === undefined) continue; // мінус зник — прибираємо застарілий маркер
      delete ex.debtOut;
    } else continue; // борг є, але не перенесено цим прогоном — маркер не чіпаємо
    await db.update(svodniRowsTable).set({ extras: ex }).where(eq(svodniRowsTable.id, d.row.id));
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
    verified: expectedRows.length, verifyMismatches, eurocashUnmatched, debtCarried, debtUnmatched,
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

// ── Транспорт: зняття за довіз → колонка Dojazd сводної ──────────────────────
// Кнопка «Перенести до сводної» на вкладці Транспорт → «Зняття за довіз»
// (загальна або на картці фабрики — тоді body.factoryId): суми
// transport_deductions місяця лягають у Dojazd рядка пари працівник+фабрика
// (матч — findSvodniRowForPair, як у from-hours) з перерахунком до виплати за
// тими самими правилами, що й ручна правка клітинки. Дві звірки: ПЕРЕД записом
// авто-рядки перевіряються проти ПОТОЧНИХ годин сводної (сводну перезаповнили
// після «Розрахувати» → 409 зі списком розбіжностей, нічого не пишеться;
// force=true — перенести як є); ПІСЛЯ запису — самозвірка: перечитуємо сводну
// і порівнюємо Dojazd з тим, що передали (verifyMismatches у відповіді).
// Залочені вкладки пропускаються; люди без рядка сводної — у відповіді.
router.post("/svodni/apply-transport-deductions", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const onlyFactoryId = req.body?.factoryId != null ? Number(req.body.factoryId) : null;
  const { transportDeductionsTable } = await import("@workspace/db");
  const deds = (await db.select().from(transportDeductionsTable)
    .where(eq(transportDeductionsTable.periodMonth, month)))
    .filter(d => onlyFactoryId == null || d.factoryId === onlyFactoryId);
  if (!deds.length) return fail(res, 400, "немає знять за довіз у цьому місяці");

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const unmatched: { workerName: string | null; factoryLabel: string | null; amount: number }[] = [];
  // сума по парі (працівник, фабрика); рядки без привʼязки до профілю — одразу в unmatched
  const byPair = new Map<string, { workerId: number; factoryId: number | null; amount: number; label: string | null }>();
  for (const d of deds) {
    if (d.workerId == null) { unmatched.push({ workerName: d.workerName, factoryLabel: d.factoryLabel, amount: d.amount }); continue; }
    const k = `${d.workerId}|${d.factoryId ?? 0}`;
    const cur = byPair.get(k) ?? byPair.set(k, { workerId: d.workerId, factoryId: d.factoryId, amount: 0, label: d.factoryLabel }).get(k)!;
    cur.amount = r2(cur.amount + d.amount);
  }

  const rows = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf)));
  const locks = await monthLocks(month);
  const workerIds = [...new Set([...byPair.values()].map(p => p.workerId))];
  const workers = workerIds.length ? await db.select().from(workersTable).where(inArray(workersTable.id, workerIds)) : [];
  const wById = new Map(workers.map(w => [w.id, w]));
  const facRows = await db.select().from(factoriesTable);
  const facById = new Map(facRows.map(f => [f.id, f]));
  const companiesAll = await db.select().from(companiesTable);
  const coNameById = new Map(companiesAll.map(c => [c.id, c.name]));
  // дзеркало from-hours: вкладка мульти-контрактної фабрики несе суфікс фірми
  const firmSuffixFor = (fac: typeof facRows[number] | undefined, w0: typeof workers[number]): string => {
    if (!fac?.multiFirm) return "";
    const cn = coNameById.get(w0.companyId ?? -1) ?? "";
    return cn === "ES" ? "EURO SUPORT" : cn.toUpperCase();
  };

  // ПЕРЕД-ЗВІРКА: авто-рядки знять проти ПОТОЧНИХ годин сводної. Сводну могли
  // перезаповнити після «Розрахувати» — тоді зміни/суми вже не сходяться:
  // 409 зі списком, нічого не пишемо (force=true — перенести як є).
  // Ручні рядки (manual/manual-edit) свідомо інші — не звіряються.
  const { factoryShiftHours } = await import("../bot/time");
  const svodniHoursByPair = new Map<string, number>();
  for (const r of rows) {
    if (r.workerId == null || r.factoryId == null || !(r.hours != null && r.hours > 0)) continue;
    const k = `${r.workerId}|${r.factoryId}`;
    svodniHoursByPair.set(k, r2((svodniHoursByPair.get(k) ?? 0) + r.hours));
  }
  if (!req.body?.force) {
    const stale: { workerName: string | null; factoryLabel: string | null; tripsCount: number | null; expectedShifts: number; amount: number; expectedAmount: number }[] = [];
    for (const d of deds) {
      if (d.sourceRef !== "auto" || d.workerId == null || d.factoryId == null) continue;
      const fac = facById.get(d.factoryId);
      if (!fac?.paidTransport || !((fac.transportFeePerShift ?? 0) > 0)) continue;
      const hours = svodniHoursByPair.get(`${d.workerId}|${d.factoryId}`) ?? 0;
      if (!(hours > 0)) continue; // пара без годин сводної — піде в unmatched, не блокуємо
      const shiftLen = factoryShiftHours(fac, "1" as any) || 8;
      const expectedShifts = Math.ceil(hours / shiftLen);
      const cap = fac.transportFeeMonthCap;
      const expectedAmount = r2(Math.min(expectedShifts * fac.transportFeePerShift!, cap != null && cap > 0 ? cap : Infinity));
      if ((d.tripsCount ?? 0) !== expectedShifts || r2(d.amount) !== expectedAmount) {
        stale.push({
          workerName: wById.get(d.workerId)?.fullName ?? d.workerName, factoryLabel: fac.name,
          tripsCount: d.tripsCount, expectedShifts, amount: d.amount, expectedAmount,
        });
      }
    }
    if (stale.length) {
      const preview = stale.slice(0, 5).map(s => `${s.workerName ?? "—"}: ${s.tripsCount ?? 0}→${s.expectedShifts} змін`).join(", ");
      return res.status(409).json({
        error: `Зняття розійшлися з поточною сводною (${stale.length}): ${preview}${stale.length > 5 ? "…" : ""}. Натисни «Розрахувати» і повтори перенесення.`,
        stale,
      });
    }
  }

  let updated = 0, skippedLocked = 0;
  // самозвірка після запису: що передали ↔ що реально лежить у сводній
  const expectedRows: { rowId: number; workerName: string; factoryLabel: string; amount: number | null }[] = [];
  for (const pair of byPair.values()) {
    const w = wById.get(pair.workerId);
    const fac = pair.factoryId != null ? facById.get(pair.factoryId) : undefined;
    // вкладка мульти-контрактної фабрики ОДНА (фірма — в рядку); firmSuffix
    // нижче — лише матчинг legacy-рядків під старими суфіксованими назвами
    const label = fac ? fac.name : pair.label ?? "";
    const row = w ? findSvodniRowForPair(rows, {
      workerId: pair.workerId, factoryId: pair.factoryId, label,
      firmSuffix: w && fac ? firmSuffixFor(fac, w) : "", multiFirm: !!fac?.multiFirm,
    }) : undefined;
    if (!row) { unmatched.push({ workerName: w?.fullName ?? null, factoryLabel: label || null, amount: pair.amount }); continue; }
    if (isLocked(locks, row.city, row.factoryLabel)) { skippedLocked++; continue; }
    // перенесений з M−1 борг у Dojazd (extras.debtIn) — не затирається авто-переносом
    const dojazdDebt = typeof (row.extras as any)?.debtIn?.cols?.dojazd === "number" ? (row.extras as any).debtIn.cols.dojazd as number : 0;
    const amount = pair.amount + dojazdDebt !== 0 ? r2(pair.amount + dojazdDebt) : null;

    // порізаний на сегменти рядок: Dojazd — місячний ввід на батькові,
    // гроші перерозкладе сегментний двигун
    const [segMark] = await db.select({ id: svodniRowsTable.id }).from(svodniRowsTable)
      .where(eq(svodniRowsTable.segmentOf, row.id)).limit(1);
    if (segMark) {
      await db.update(svodniRowsTable).set({ dojazd: amount, manual: true, mismatch: null })
        .where(eq(svodniRowsTable.id, row.id));
      await recomputeSegmentedParent(row.id);
      expectedRows.push({ rowId: row.id, workerName: w?.fullName ?? row.rawName, factoryLabel: row.factoryLabel, amount });
      updated++;
      continue;
    }

    // та сама послідовність, що й ручна правка клітинки Dojazd (PATCH rows/:id):
    // перерахунок до виплати → статусні правила księgowości → готівка
    const merged: any = { ...row, dojazd: amount };
    const set: Record<string, unknown> = { dojazd: amount, manual: true, mismatch: null };
    const payout = computePayout(merged, row.city as any);
    if (payout != null) { set.doWyplaty = payout; merged.doWyplaty = payout; }
    if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
      const payoutPref = w?.payoutPrefKind ? { kind: w.payoutPrefKind as "all_konto" | "hours" | "amount", value: w.payoutPrefValue ?? null } : null;
      applyLegalDefaults(merged, true, { profileLegal: (w?.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, payoutPref, city: row.city, firm: row.firm, factoryId: row.factoryId, rule: await payoutRuleForRow(row) });
      for (const k of ["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
        if (merged[k] !== row[k]) set[k] = merged[k];
      }
    }
    if (merged.ksiegNetto != null && merged.doWyplaty != null) {
      const doplata = typeof merged.extras?.doplataEs === "number" ? merged.extras.doplataEs : 0;
      set.gotowka = r2(merged.doWyplaty - merged.ksiegNetto + doplata);
    }
    await db.update(svodniRowsTable).set(set as any).where(eq(svodniRowsTable.id, row.id));
    expectedRows.push({ rowId: row.id, workerName: w?.fullName ?? row.rawName, factoryLabel: row.factoryLabel, amount });
    updated++;
  }
  // САМОЗВІРКА: перечитуємо записані рядки і порівнюємо Dojazd з переданим
  const verifyMismatches: { workerName: string; factoryLabel: string; expected: number | null; actual: number | null }[] = [];
  if (expectedRows.length) {
    const fresh = await db.select({ id: svodniRowsTable.id, dojazd: svodniRowsTable.dojazd })
      .from(svodniRowsTable).where(inArray(svodniRowsTable.id, expectedRows.map(e => e.rowId)));
    const freshById = new Map(fresh.map(f => [f.id, f.dojazd]));
    for (const e of expectedRows) {
      const actual = freshById.get(e.rowId) ?? null;
      if ((actual ?? 0) !== (e.amount ?? 0)) {
        verifyMismatches.push({ workerName: e.workerName, factoryLabel: e.factoryLabel, expected: e.amount, actual });
      }
    }
  }
  ok(res, { month, updated, verified: expectedRows.length, verifyMismatches, skippedLocked, unmatched });
});

// Перенесення знять за одяг у колонку Odzież сводної місяця. Джерело — реєстр
// одягу «до зняття» (price>0, не знято, не списано, не повернуто). Одяг не
// привʼязаний до фабрики, тож сума людини лягає в рядок її фабрики з
// НАЙБІЛЬШИМИ годинами місяця; залочені вкладки пропускаються. Після запису
// позиції позначаються deducted + deducted_month/amount (архів «що знято»).
router.post("/svodni/apply-clothing-deductions", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const { clothingItemsTable } = await import("@workspace/db");
  const items = await db.select().from(clothingItemsTable).where(and(
    eq(clothingItemsTable.deducted, false), eq(clothingItemsTable.writtenOff, false),
    isNull(clothingItemsTable.returnedAt), sql`${clothingItemsTable.price} is not null and ${clothingItemsTable.price} > 0`,
  ));
  if (!items.length) return fail(res, 400, "немає одягу до зняття");
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const unmatched: { workerName: string | null; amount: number }[] = [];
  const byWorker = new Map<number, { amount: number; itemIds: number[] }>();
  for (const it of items) {
    if (it.workerId == null) { unmatched.push({ workerName: it.workerName, amount: it.price! }); continue; }
    const cur = byWorker.get(it.workerId) ?? byWorker.set(it.workerId, { amount: 0, itemIds: [] }).get(it.workerId)!;
    cur.amount = r2(cur.amount + it.price!);
    cur.itemIds.push(it.id);
  }

  const rows = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf)));
  const locks = await monthLocks(month);
  const workerIds = [...byWorker.keys()];
  const workers = workerIds.length ? await db.select().from(workersTable).where(inArray(workersTable.id, workerIds)) : [];
  const wById = new Map(workers.map(w => [w.id, w]));

  let updated = 0, skippedLocked = 0;
  const markedItemIds: number[] = [];
  const expectedRows: { rowId: number; workerName: string; factoryLabel: string; amount: number | null }[] = [];
  for (const [workerId, agg] of byWorker) {
    const w = wById.get(workerId);
    // рядок «основної» фабрики: серед батьківських рядків людини в місяці —
    // з найбільшими годинами (нульові теж валідні, аби існував рядок)
    const mine = rows.filter(r => r.workerId === workerId);
    const row = mine.sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0))[0];
    if (!row) { unmatched.push({ workerName: w?.fullName ?? null, amount: agg.amount }); continue; }
    if (isLocked(locks, row.city, row.factoryLabel)) { skippedLocked++; continue; }
    // перенесений з M−1 борг в Odzież (extras.debtIn) — не затирається авто-переносом
    const odziezDebt = typeof (row.extras as any)?.debtIn?.cols?.odziez === "number" ? (row.extras as any).debtIn.cols.odziez as number : 0;
    const amount = agg.amount + odziezDebt !== 0 ? r2(agg.amount + odziezDebt) : null;

    // порізаний на сегменти рядок: Odzież — місячний ввід на батькові
    const [segMark] = await db.select({ id: svodniRowsTable.id }).from(svodniRowsTable)
      .where(eq(svodniRowsTable.segmentOf, row.id)).limit(1);
    if (segMark) {
      await db.update(svodniRowsTable).set({ odziez: amount, manual: true, mismatch: null })
        .where(eq(svodniRowsTable.id, row.id));
      await recomputeSegmentedParent(row.id);
    } else {
      // та сама послідовність, що й ручна правка клітинки Odzież:
      // перерахунок до виплати → статусні правила księgowości → готівка
      const merged: any = { ...row, odziez: amount };
      const set: Record<string, unknown> = { odziez: amount, manual: true, mismatch: null };
      const payout = computePayout(merged, row.city as any);
      if (payout != null) { set.doWyplaty = payout; merged.doWyplaty = payout; }
      if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
        const payoutPref = w?.payoutPrefKind ? { kind: w.payoutPrefKind as "all_konto" | "hours" | "amount", value: w.payoutPrefValue ?? null } : null;
        applyLegalDefaults(merged, true, { profileLegal: (w?.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, payoutPref, city: row.city, firm: row.firm, factoryId: row.factoryId, rule: await payoutRuleForRow(row) });
        for (const k of ["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
          if (merged[k] !== row[k]) set[k] = merged[k];
        }
      }
      if (merged.ksiegNetto != null && merged.doWyplaty != null) {
        const doplata = typeof merged.extras?.doplataEs === "number" ? merged.extras.doplataEs : 0;
        set.gotowka = r2(merged.doWyplaty - merged.ksiegNetto + doplata);
      }
      await db.update(svodniRowsTable).set(set as any).where(eq(svodniRowsTable.id, row.id));
    }
    expectedRows.push({ rowId: row.id, workerName: w?.fullName ?? row.rawName, factoryLabel: row.factoryLabel, amount });
    markedItemIds.push(...agg.itemIds);
    updated++;
  }
  // архів: перенесені позиції позначаються «знято» з місяцем і фактичною сумою
  if (markedItemIds.length) {
    await db.update(clothingItemsTable)
      .set({ deducted: true, deductedMonth: month, deductedAmount: sql`${clothingItemsTable.price}` })
      .where(inArray(clothingItemsTable.id, markedItemIds));
  }
  // САМОЗВІРКА: перечитуємо записані рядки і порівнюємо Odzież з переданим
  const verifyMismatches: { workerName: string; factoryLabel: string; expected: number | null; actual: number | null }[] = [];
  if (expectedRows.length) {
    const fresh = await db.select({ id: svodniRowsTable.id, odziez: svodniRowsTable.odziez })
      .from(svodniRowsTable).where(inArray(svodniRowsTable.id, expectedRows.map(e => e.rowId)));
    const freshById = new Map(fresh.map(f => [f.id, f.odziez]));
    for (const e of expectedRows) {
      const actual = freshById.get(e.rowId) ?? null;
      if ((actual ?? 0) !== (e.amount ?? 0)) {
        verifyMismatches.push({ workerName: e.workerName, factoryLabel: e.factoryLabel, expected: e.amount, actual });
      }
    }
  }
  ok(res, { month, updated, itemsMarked: markedItemIds.length, verified: expectedRows.length, verifyMismatches, skippedLocked, unmatched });
});

// Перенесення залічок за бадання у колонку Zaliczka BD сводної місяця.
// Джерело — worker_badania з deducted=false; body.ids — вибіркове перенесення
// (без ids — усі незняті). Сума людини лягає в рядок її фабрики з найбільшими
// годинами місяця; після запису записи позначаються deducted+дата+місяць.
router.post("/svodni/apply-badania-deductions", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const onlyIds: number[] | null = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  const { workerBadaniaTable } = await import("@workspace/db");
  const items = (await db.select().from(workerBadaniaTable).where(eq(workerBadaniaTable.deducted, false)))
    .filter(b => onlyIds == null || onlyIds.includes(b.id));
  if (!items.length) return fail(res, 400, "немає залічок за бадання до зняття");
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const byWorker = new Map<number, { amount: number; itemIds: number[] }>();
  for (const it of items) {
    const cur = byWorker.get(it.workerId) ?? byWorker.set(it.workerId, { amount: 0, itemIds: [] }).get(it.workerId)!;
    cur.amount = r2(cur.amount + it.amount);
    cur.itemIds.push(it.id);
  }

  const rows = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf)));
  const locks = await monthLocks(month);
  const workerIds = [...byWorker.keys()];
  const workers = workerIds.length ? await db.select().from(workersTable).where(inArray(workersTable.id, workerIds)) : [];
  const wById = new Map(workers.map(w => [w.id, w]));

  let updated = 0, skippedLocked = 0;
  const markedItemIds: number[] = [];
  const unmatched: { workerName: string | null; amount: number }[] = [];
  const expectedRows: { rowId: number; workerName: string; factoryLabel: string; amount: number | null }[] = [];
  for (const [workerId, agg] of byWorker) {
    const w = wById.get(workerId);
    // рядок «основної» фабрики: серед батьківських рядків людини в місяці —
    // з найбільшими годинами (як одяг: залічка не привʼязана до фабрики)
    const mine = rows.filter(r => r.workerId === workerId);
    const row = mine.sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0))[0];
    if (!row) { unmatched.push({ workerName: w?.fullName ?? null, amount: agg.amount }); continue; }
    if (isLocked(locks, row.city, row.factoryLabel)) { skippedLocked++; continue; }
    // ДОДАЄМО до наявного Zaliczka BD (там можуть жити старі ручні суми),
    // на відміну від системних колонок, які система переписує повністю
    const amount = r2((row.zaliczkaBd ?? 0) + agg.amount);

    // порізаний на сегменти рядок: місячний ввід на батькові
    const [segMark] = await db.select({ id: svodniRowsTable.id }).from(svodniRowsTable)
      .where(eq(svodniRowsTable.segmentOf, row.id)).limit(1);
    if (segMark) {
      await db.update(svodniRowsTable).set({ zaliczkaBd: amount, manual: true, mismatch: null })
        .where(eq(svodniRowsTable.id, row.id));
      await recomputeSegmentedParent(row.id);
    } else {
      // та сама послідовність, що й ручна правка клітинки Zaliczka BD
      const merged: any = { ...row, zaliczkaBd: amount };
      const set: Record<string, unknown> = { zaliczkaBd: amount, manual: true, mismatch: null };
      const payout = computePayout(merged, row.city as any);
      if (payout != null) { set.doWyplaty = payout; merged.doWyplaty = payout; }
      if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
        const payoutPref = w?.payoutPrefKind ? { kind: w.payoutPrefKind as "all_konto" | "hours" | "amount", value: w.payoutPrefValue ?? null } : null;
        applyLegalDefaults(merged, true, { profileLegal: (w?.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, payoutPref, city: row.city, firm: row.firm, factoryId: row.factoryId, rule: await payoutRuleForRow(row) });
        for (const k of ["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
          if (merged[k] !== row[k]) set[k] = merged[k];
        }
      }
      if (merged.ksiegNetto != null && merged.doWyplaty != null) {
        const doplata = typeof merged.extras?.doplataEs === "number" ? merged.extras.doplataEs : 0;
        set.gotowka = r2(merged.doWyplaty - merged.ksiegNetto + doplata);
      }
      await db.update(svodniRowsTable).set(set as any).where(eq(svodniRowsTable.id, row.id));
    }
    expectedRows.push({ rowId: row.id, workerName: w?.fullName ?? row.rawName, factoryLabel: row.factoryLabel, amount });
    markedItemIds.push(...agg.itemIds);
    updated++;
  }
  // перенесені записи — «знято» з датою і місяцем сводної
  if (markedItemIds.length) {
    await db.update(workerBadaniaTable)
      .set({ deducted: true, deductedAt: sql`CURRENT_DATE`, deductedMonth: month })
      .where(inArray(workerBadaniaTable.id, markedItemIds));
  }
  // САМОЗВІРКА: перечитуємо записані рядки і порівнюємо Zaliczka BD
  const verifyMismatches: { workerName: string; factoryLabel: string; expected: number | null; actual: number | null }[] = [];
  if (expectedRows.length) {
    const fresh = await db.select({ id: svodniRowsTable.id, zaliczkaBd: svodniRowsTable.zaliczkaBd })
      .from(svodniRowsTable).where(inArray(svodniRowsTable.id, expectedRows.map(e => e.rowId)));
    const freshById = new Map(fresh.map(f => [f.id, f.zaliczkaBd]));
    for (const e of expectedRows) {
      const actual = freshById.get(e.rowId) ?? null;
      if ((actual ?? 0) !== (e.amount ?? 0)) {
        verifyMismatches.push({ workerName: e.workerName, factoryLabel: e.factoryLabel, expected: e.amount, actual });
      }
    }
  }
  ok(res, { month, updated, itemsMarked: markedItemIds.length, verified: expectedRows.length, verifyMismatches, skippedLocked, unmatched });
});

// Відміна перенесеної залічки за бадання: віднімає суму з клітинки Zaliczka BD
// сводної місяця перенесення (рядок людини з найбільшими годинами, де є Zaliczka
// BD) з перерахунком до виплати, і повертає запис у «до зняття». Залочена
// вкладка — відмова (спершу зніми лок). Якщо рядка сводної вже нема (видалили) —
// лише знімається позначка, з чесним попередженням у відповіді.
router.post("/svodni/undo-badania-deduction", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const id = Number(req.body?.id);
  if (!Number.isFinite(id)) return fail(res, 400, "id обовʼязковий");
  const { workerBadaniaTable } = await import("@workspace/db");
  const [b] = await db.select().from(workerBadaniaTable).where(eq(workerBadaniaTable.id, id));
  if (!b) return fail(res, 404, "Не знайдено");
  if (!b.deducted) return fail(res, 400, "Запис і так не знятий");
  if (!b.deductedMonth) return fail(res, 400, "Знято вручну (без перенесення) — зніми позначку в профілі");
  const month = b.deductedMonth;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const rows = await db.select().from(svodniRowsTable).where(and(
    eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf),
    eq(svodniRowsTable.workerId, b.workerId),
  ));
  // куди переносили: рядок з найбільшими годинами серед тих, де є Zaliczka BD
  const row = rows.filter(r => (r.zaliczkaBd ?? 0) > 0).sort((a, x) => (x.hours ?? 0) - (a.hours ?? 0))[0];
  let subtracted: { factoryLabel: string; newValue: number | null } | null = null;
  if (row) {
    const locks = await monthLocks(month);
    if (isLocked(locks, row.city, row.factoryLabel)) {
      return fail(res, 409, `Вкладка «${row.factoryLabel}» (${month}) затверджена — спершу зніми лок, потім відміняй`);
    }
    const newBd = r2(Math.max(0, (row.zaliczkaBd ?? 0) - b.amount));
    const amount = newBd > 0 ? newBd : null;
    const [w] = await db.select().from(workersTable).where(eq(workersTable.id, b.workerId));
    const [segMark] = await db.select({ id: svodniRowsTable.id }).from(svodniRowsTable)
      .where(eq(svodniRowsTable.segmentOf, row.id)).limit(1);
    if (segMark) {
      await db.update(svodniRowsTable).set({ zaliczkaBd: amount, manual: true, mismatch: null })
        .where(eq(svodniRowsTable.id, row.id));
      await recomputeSegmentedParent(row.id);
    } else {
      const merged: any = { ...row, zaliczkaBd: amount };
      const set: Record<string, unknown> = { zaliczkaBd: amount, manual: true, mismatch: null };
      const payout = computePayout(merged, row.city as any);
      if (payout != null) { set.doWyplaty = payout; merged.doWyplaty = payout; }
      if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
        const payoutPref = w?.payoutPrefKind ? { kind: w.payoutPrefKind as "all_konto" | "hours" | "amount", value: w.payoutPrefValue ?? null } : null;
        applyLegalDefaults(merged, true, { profileLegal: (w?.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, payoutPref, city: row.city, firm: row.firm, factoryId: row.factoryId, rule: await payoutRuleForRow(row) });
        for (const k of ["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
          if (merged[k] !== row[k]) set[k] = merged[k];
        }
      }
      if (merged.ksiegNetto != null && merged.doWyplaty != null) {
        const doplata = typeof merged.extras?.doplataEs === "number" ? merged.extras.doplataEs : 0;
        set.gotowka = r2(merged.doWyplaty - merged.ksiegNetto + doplata);
      }
      await db.update(svodniRowsTable).set(set as any).where(eq(svodniRowsTable.id, row.id));
    }
    subtracted = { factoryLabel: row.factoryLabel, newValue: amount };
  }
  await db.update(workerBadaniaTable)
    .set({ deducted: false, deductedAt: null, deductedMonth: null })
    .where(eq(workerBadaniaTable.id, id));
  ok(res, {
    ok: true, month, subtracted,
    warning: subtracted ? null : "рядка сводної з Zaliczka BD не знайдено — позначку знято, суму віднімати нема звідки",
  });
});

// ─── Перенесення штрафів у колонку Kara сводної ──────────────────────────────
// Два джерела: ручний реєстр /penalties і штрафи за пропуски /absences
// (schedule_entries). Формат — як у бадань (Zaliczka BD): сума ДОДАЄТЬСЯ до
// наявної Kara (там можуть жити ручні/синковані суми), відміна віднімає своє.

// Запис клітинки місячного відрахування (Kara / Zaliczka) тим самим ланцюжком,
// що й ручна правка: сегментований рядок — місячний ввід на батькові з
// перерахунком сегментів; інакше computePayout → статусні правила księgowości → готівка.
type DeductionCol = "kara" | "zaliczka";
async function writeDeductionCell(
  row: typeof svodniRowsTable.$inferSelect,
  w: typeof workersTable.$inferSelect | undefined,
  col: DeductionCol,
  amount: number | null,
): Promise<void> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const [segMark] = await db.select({ id: svodniRowsTable.id }).from(svodniRowsTable)
    .where(eq(svodniRowsTable.segmentOf, row.id)).limit(1);
  if (segMark) {
    await db.update(svodniRowsTable).set({ [col]: amount, manual: true, mismatch: null })
      .where(eq(svodniRowsTable.id, row.id));
    await recomputeSegmentedParent(row.id);
    return;
  }
  const merged: any = { ...row, [col]: amount };
  const set: Record<string, unknown> = { [col]: amount, manual: true, mismatch: null };
  const payout = computePayout(merged, row.city as any);
  if (payout != null) { set.doWyplaty = payout; merged.doWyplaty = payout; }
  if (!OFFICE_TAB_RE.test(row.factoryLabel) && row.factoryLabel !== EXTRA_STUDENTS_LABEL) {
    const payoutPref = w?.payoutPrefKind ? { kind: w.payoutPrefKind as "all_konto" | "hours" | "amount", value: w.payoutPrefValue ?? null } : null;
    applyLegalDefaults(merged, true, { profileLegal: (w?.legalStatus ?? null) as any, factoryLabel: row.factoryLabel, payoutPref, city: row.city, firm: row.firm, factoryId: row.factoryId, rule: await payoutRuleForRow(row) });
    for (const k of ["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"] as const) {
      if (merged[k] !== row[k]) set[k] = merged[k];
    }
  }
  if (merged.ksiegNetto != null && merged.doWyplaty != null) {
    const doplata = typeof merged.extras?.doplataEs === "number" ? merged.extras.doplataEs : 0;
    set.gotowka = r2(merged.doWyplaty - merged.ksiegNetto + doplata);
  }
  await db.update(svodniRowsTable).set(set as any).where(eq(svodniRowsTable.id, row.id));
}

// Групи «працівник(+фабрика джерела) → сума» лягають у рядки сводної місяця:
// спершу рядок САМЕ цієї пари, нема — фолбек у рядок «основної» фабрики
// (найбільше годин), як аванси з factory_id. Групи обробляються послідовно
// (дві групи людини можуть влучити в той самий рядок — додаємо на свіже
// значення), локи пропускаються, наприкінці — самозвірка перечитуванням.
type DeductionGroup = { workerId: number; factoryId: number | null; amount: number; refs: { id: number; amount: number }[] };
async function applyDeductionGroups(month: string, col: DeductionCol, groups: DeductionGroup[]): Promise<{
  updated: number; skippedLocked: number;
  unmatched: { workerName: string | null; amount: number }[];
  landedRefs: { id: number; amount: number }[];
  verified: number;
  verifyMismatches: { workerName: string; factoryLabel: string; expected: number | null; actual: number | null }[];
}> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rows = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf)));
  const locks = await monthLocks(month);
  const workerIds = [...new Set(groups.map(g => g.workerId))];
  const workers = workerIds.length ? await db.select().from(workersTable).where(inArray(workersTable.id, workerIds)) : [];
  const wById = new Map(workers.map(w => [w.id, w]));
  const byHours = (a: typeof rows[number], b: typeof rows[number]) => (b.hours ?? 0) - (a.hours ?? 0);

  let updated = 0, skippedLocked = 0;
  const unmatched: { workerName: string | null; amount: number }[] = [];
  const landedRefs: { id: number; amount: number }[] = [];
  const expected = new Map<number, { workerName: string; factoryLabel: string; amount: number | null }>();
  for (const g of groups) {
    const w = wById.get(g.workerId);
    const mine = rows.filter(r => r.workerId === g.workerId);
    const row = (g.factoryId != null ? mine.filter(r => r.factoryId === g.factoryId).sort(byHours)[0] : undefined)
      ?? mine.sort(byHours)[0];
    if (!row) { unmatched.push({ workerName: w?.fullName ?? null, amount: g.amount }); continue; }
    if (isLocked(locks, row.city, row.factoryLabel)) { skippedLocked++; continue; }
    const amount = r2((row[col] ?? 0) + g.amount);
    await writeDeductionCell(row, w, col, amount);
    row[col] = amount; // свіже значення для наступних груп у той самий рядок
    expected.set(row.id, { workerName: w?.fullName ?? row.rawName, factoryLabel: row.factoryLabel, amount });
    landedRefs.push(...g.refs);
    updated++;
  }
  // САМОЗВІРКА: перечитуємо записані рядки і порівнюємо колонку з очікуваним
  const verifyMismatches: { workerName: string; factoryLabel: string; expected: number | null; actual: number | null }[] = [];
  if (expected.size) {
    const fresh = await db.select({ id: svodniRowsTable.id, kara: svodniRowsTable.kara, zaliczka: svodniRowsTable.zaliczka })
      .from(svodniRowsTable).where(inArray(svodniRowsTable.id, [...expected.keys()]));
    const freshById = new Map(fresh.map(f => [f.id, f[col]]));
    for (const [rowId, e] of expected) {
      const actual = freshById.get(rowId) ?? null;
      if ((actual ?? 0) !== (e.amount ?? 0)) {
        verifyMismatches.push({ workerName: e.workerName, factoryLabel: e.factoryLabel, expected: e.amount, actual });
      }
    }
  }
  return { updated, skippedLocked, unmatched, landedRefs, verified: expected.size, verifyMismatches };
}

// Відміна одного перенесення: віднімає суму з колонки рядка місяця перенесення
// (рядок пари, фолбек — з найбільшими годинами серед тих, де є значення).
// Залочена вкладка — 409; рядка вже нема — чесний warning.
async function subtractDeduction(month: string, col: DeductionCol, workerId: number, factoryId: number | null, amount: number): Promise<
  { error: string } | { subtracted: { factoryLabel: string; newValue: number | null } | null }
> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rows = await db.select().from(svodniRowsTable).where(and(
    eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf),
    eq(svodniRowsTable.workerId, workerId),
  ));
  const byHours = (a: typeof rows[number], b: typeof rows[number]) => (b.hours ?? 0) - (a.hours ?? 0);
  const withVal = rows.filter(r => (r[col] ?? 0) > 0);
  const row = (factoryId != null ? withVal.filter(r => r.factoryId === factoryId).sort(byHours)[0] : undefined)
    ?? withVal.sort(byHours)[0];
  if (!row) return { subtracted: null };
  const locks = await monthLocks(month);
  if (isLocked(locks, row.city, row.factoryLabel)) {
    return { error: `Вкладка «${row.factoryLabel}» (${month}) затверджена — спершу зніми лок, потім відміняй` };
  }
  const newVal = r2(Math.max(0, (row[col] ?? 0) - amount));
  const value = newVal > 0 ? newVal : null;
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  await writeDeductionCell(row, w, col, value);
  return { subtracted: { factoryLabel: row.factoryLabel, newValue: value } };
}

// Перенесення штрафів реєстру /penalties у Kara сводної місяця body.month.
// body.ids — вибіркове перенесення (без ids — усі незняті).
router.post("/svodni/apply-penalty-deductions", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const onlyIds: number[] | null = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  const items = (await db.select().from(penaltiesTable).where(eq(penaltiesTable.deducted, false)))
    .filter(p => onlyIds == null || onlyIds.includes(p.id));
  if (!items.length) return fail(res, 400, "немає штрафів до зняття");
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const key2 = (w: number, f: number | null) => `${w}|${f ?? 0}`;
  const byPair = new Map<string, DeductionGroup>();
  for (const p of items) {
    const k = key2(p.workerId, p.factoryId);
    const g = byPair.get(k) ?? byPair.set(k, { workerId: p.workerId, factoryId: p.factoryId, amount: 0, refs: [] }).get(k)!;
    g.amount = r2(g.amount + p.amount);
    g.refs.push({ id: p.id, amount: p.amount });
  }
  const result = await applyDeductionGroups(month, "kara", [...byPair.values()]);
  if (result.landedRefs.length) {
    await db.update(penaltiesTable)
      .set({ deducted: true, deductedAt: sql`CURRENT_DATE`, deductedMonth: month })
      .where(inArray(penaltiesTable.id, result.landedRefs.map(x => x.id)));
  }
  ok(res, {
    month, updated: result.updated, itemsMarked: result.landedRefs.length, verified: result.verified,
    verifyMismatches: result.verifyMismatches, skippedLocked: result.skippedLocked, unmatched: result.unmatched,
  });
});

// Відміна перенесеного штрафу реєстру: сума віднімається з Kara сводної
// місяця перенесення, запис повертається у «до зняття».
router.post("/svodni/undo-penalty-deduction", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const id = Number(req.body?.id);
  if (!Number.isFinite(id)) return fail(res, 400, "id обовʼязковий");
  const [p] = await db.select().from(penaltiesTable).where(eq(penaltiesTable.id, id));
  if (!p) return fail(res, 404, "Не знайдено");
  if (!p.deducted || !p.deductedMonth) return fail(res, 400, "Штраф не перенесений у сводну");
  const r = await subtractDeduction(p.deductedMonth, "kara", p.workerId, p.factoryId, p.amount);
  if ("error" in r) return fail(res, 409, r.error);
  await db.update(penaltiesTable)
    .set({ deducted: false, deductedAt: null, deductedMonth: null })
    .where(eq(penaltiesTable.id, id));
  ok(res, {
    ok: true, month: p.deductedMonth, subtracted: r.subtracted,
    warning: r.subtracted ? null : "рядка сводної з Kara не знайдено — позначку знято, суму віднімати нема звідки",
  });
});

// Перенесення штрафів за пропуски (/absences) у Kara сводної body.month.
// body.entryIds — обовʼязковий явний список пропусків (веб шле вибрані);
// беруться лише невиправдані незняті з ефективним штрафом > 0. Сума кожного
// пропуску фіксується в absence_deducted_amount — undo віднімає саме її.
router.post("/svodni/apply-absence-deductions", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const entryIds: number[] = Array.isArray(req.body?.entryIds)
    ? req.body.entryIds.map(Number).filter(Number.isFinite) : [];
  if (!entryIds.length) return fail(res, 400, "entryIds=[…] обовʼязково");
  const entries = (await db.select().from(scheduleEntriesTable).where(inArray(scheduleEntriesTable.id, entryIds)))
    .filter(e => e.status === "absent" && !e.absenceExcused && e.absenceDeductedMonth == null)
    .map(e => ({ ...e, penalty: absencePenaltyOf(e) }))
    .filter(e => e.penalty > 0);
  if (!entries.length) return fail(res, 400, "немає штрафів за пропуски до зняття");
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const key2 = (w: number, f: number | null) => `${w}|${f ?? 0}`;
  const byPair = new Map<string, DeductionGroup>();
  for (const e of entries) {
    const k = key2(e.workerId, e.factoryId);
    const g = byPair.get(k) ?? byPair.set(k, { workerId: e.workerId, factoryId: e.factoryId, amount: 0, refs: [] }).get(k)!;
    g.amount = r2(g.amount + e.penalty);
    g.refs.push({ id: e.id, amount: e.penalty });
  }
  const result = await applyDeductionGroups(month, "kara", [...byPair.values()]);
  for (const ref of result.landedRefs) {
    await db.update(scheduleEntriesTable)
      .set({ absenceDeductedMonth: month, absenceDeductedAt: sql`CURRENT_DATE`, absenceDeductedAmount: ref.amount })
      .where(eq(scheduleEntriesTable.id, ref.id));
  }
  ok(res, {
    month, updated: result.updated, itemsMarked: result.landedRefs.length, verified: result.verified,
    verifyMismatches: result.verifyMismatches, skippedLocked: result.skippedLocked, unmatched: result.unmatched,
  });
});

// Відміна перенесеного штрафу за пропуск: віднімає зафіксовану суму з Kara
// сводної місяця перенесення, пропуск повертається у «до зняття».
router.post("/svodni/undo-absence-deduction", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const entryId = Number(req.body?.entryId);
  if (!Number.isFinite(entryId)) return fail(res, 400, "entryId обовʼязковий");
  const [e] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId));
  if (!e) return fail(res, 404, "Не знайдено");
  if (!e.absenceDeductedMonth) return fail(res, 400, "Штраф не перенесений у сводну");
  const amount = e.absenceDeductedAmount ?? absencePenaltyOf(e);
  const r = await subtractDeduction(e.absenceDeductedMonth, "kara", e.workerId, e.factoryId, amount);
  if ("error" in r) return fail(res, 409, r.error);
  await db.update(scheduleEntriesTable)
    .set({ absenceDeductedMonth: null, absenceDeductedAt: null, absenceDeductedAmount: null })
    .where(eq(scheduleEntriesTable.id, entryId));
  ok(res, {
    ok: true, month: e.absenceDeductedMonth, subtracted: r.subtracted,
    warning: r.subtracted ? null : "рядка сводної з Kara не знайдено — позначку знято, суму віднімати нема звідки",
  });
});

// ─── Перенесення виплачених залічок у колонку Zaliczka сводної ────────────────
// Масова дія ПІСЛЯ звірки виплат (сторінка Аванси → «У сводну»): from-hours
// залічки НЕ заповнює. Джерело — виплачені аванси без svodni_month; body.ids —
// вибіркове перенесення. Аванс із фабрикою запиту лягає в рядок цієї фабрики
// (нема в місяці — фолбек у рядок з найбільшими годинами); суми ДОДАЮТЬСЯ до
// наявної Zaliczka (там можуть жити ручні/синковані значення). Після запису
// аванси позначаються svodni_month+датою; локи пропускаються, самозвірка як у бадань.
router.post("/svodni/apply-zaliczki", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const onlyIds: number[] | null = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  const items = (await db.select().from(advanceRequestsTable)
    .where(and(eq(advanceRequestsTable.status, "paid"), isNull(advanceRequestsTable.svodniMonth))))
    .filter(a => onlyIds == null || onlyIds.includes(a.id));
  if (!items.length) return fail(res, 400, "немає виплачених залічок до перенесення");
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // група на аванс: applyDeductionGroups сам агрегує послідовно у свіжі рядки
  const groups: DeductionGroup[] = items.map(a => ({
    workerId: a.workerId, factoryId: a.factoryId, amount: r2(a.amount), refs: [{ id: a.id, amount: a.amount }],
  }));
  const result = await applyDeductionGroups(month, "zaliczka", groups);
  const markedIds = result.landedRefs.map(r => r.id);
  if (markedIds.length) {
    await db.update(advanceRequestsTable)
      .set({ svodniMonth: month, svodniAppliedAt: sql`CURRENT_DATE` })
      .where(inArray(advanceRequestsTable.id, markedIds));
  }
  ok(res, {
    month, updated: result.updated, itemsMarked: markedIds.length,
    verified: result.verified, verifyMismatches: result.verifyMismatches,
    skippedLocked: result.skippedLocked, unmatched: result.unmatched,
  });
});

// Відміна перенесеної залічки: віднімає суму з клітинки Zaliczka сводної місяця
// перенесення і знімає позначку з авансу (сам аванс лишається виплаченим).
router.post("/svodni/undo-zaliczka", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const id = Number(req.body?.id);
  if (!Number.isFinite(id)) return fail(res, 400, "id обовʼязковий");
  const [a] = await db.select().from(advanceRequestsTable).where(eq(advanceRequestsTable.id, id));
  if (!a) return fail(res, 404, "Не знайдено");
  if (!a.svodniMonth) return fail(res, 400, "Аванс не перенесений у сводну");
  const r = await subtractDeduction(a.svodniMonth, "zaliczka", a.workerId, a.factoryId, a.amount);
  if ("error" in r) return fail(res, 409, r.error);
  await db.update(advanceRequestsTable)
    .set({ svodniMonth: null, svodniAppliedAt: null })
    .where(eq(advanceRequestsTable.id, id));
  ok(res, {
    month: a.svodniMonth, subtracted: r.subtracted,
    warning: r.subtracted ? null : "рядка сводної з Zaliczka не знайдено — позначку знято, суму віднімати нема звідки",
  });
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
  { key: "name", header: "Nazwisko i imię", get: r => nameCaps(r.workerName ?? r.rawName) },
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
  // мульти-контрактна вкладка (Sushi&Food): рядки різних фірм в одному аркуші,
  // розділені жирним рядком фірми (як старі суфіксовані вкладки, лише разом)
  const firmDisplay = (f: string) => (f === "ES" ? "EURO SUPORT" : f.toLocaleUpperCase("pl-PL"));
  for (const [label, list] of byFactory) {
    // назва вкладки: обрізаємо заборонені символи Excel і 31 символ ліміту
    const ws = wb.addWorksheet(label.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
    ws.addRow(["Lp", ...cols.map(c => c.header)]).font = { bold: true };
    const firms = new Map<string, typeof list>();
    for (const r of list) (firms.get(r.firm ?? "") ?? firms.set(r.firm ?? "", []).get(r.firm ?? "")!).push(r);
    const firmKeys = [...firms.keys()]
      .sort((a, b) => (a === "" ? 1 : b === "" ? -1 : collator.compare(firmDisplay(a), firmDisplay(b))));
    const splitByFirm = firmKeys.filter(f => f !== "").length > 1;
    let lp = 1;
    for (const fk of splitByFirm ? firmKeys : [""]) {
      const firmList = splitByFirm ? firms.get(fk)! : list;
      if (splitByFirm && fk) {
        const row = ws.addRow([firmDisplay(fk)]);
        row.font = { bold: true, size: 12 };
        ws.mergeCells(row.number, 1, row.number, cols.length + 1);
      }
      // секції-становіска, всередині — за алфавітом; без секції — в кінець
      const sections = new Map<string, typeof firmList>();
      for (const r of firmList) (sections.get(r.section ?? "") ?? sections.set(r.section ?? "", []).get(r.section ?? "")!).push(r);
      const sectionKeys = [...sections.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : collator.compare(a, b)));
      for (const sec of sectionKeys) {
        if (sec && sections.size > 1) {
          const row = ws.addRow([sec]);
          row.font = { bold: true };
          ws.mergeCells(row.number, 1, row.number, cols.length + 1);
        }
        const people = sections.get(sec)!.sort((a, b) => collator.compare(String(a.workerName ?? a.rawName), String(b.workerName ?? b.rawName)));
        for (const r of people) ws.addRow([lp++, ...cols.map(c => c.get(r) ?? "")]);
      }
    }
    // сумарний рядок по числових колонках; мінусова виплата — борг людини
    // (переноситься в наступний місяць), виплатні колонки Razem не зменшує
    const XLS_POS_ONLY = new Set(["doWyplaty", "gotowka", "konto", "ksiegNetto"]);
    const sums = cols.map(c => list.reduce((a, r) => {
      const v = c.get(r);
      if (typeof v !== "number") return a;
      return a + (XLS_POS_ONLY.has(c.key) ? Math.max(0, v) : v);
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

// ── Лісти до Gratyfikant nexo (кнопка Gratyfikant на /svodni, svodniSensitive) ──
// Формат файлу і критерії — services/gratyfikantExport.ts. Превʼю віддає людей
// з сумами і попередженнями (без PESEL / умова скінчилась / нема / інша фірма —
// знімок умов живе в gratyfikant_umowy, імпорт у Налаштуваннях). Модалка дає
// зняти галочки з непотрібних і передає вибрані row-id у GET-скачування.
async function gratyfikantScope(req: AuthedRequest, res: any) {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) { fail(res, 400, "month=YYYY-MM required"); return null; }
  const firm = String(req.query.firm ?? "").trim();
  if (!firm) { fail(res, 400, "firm required"); return null; }
  const factoryLabels = String(req.query.factories ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const city = String(req.query.city ?? "").trim() || null;

  const rows = await db.select({
    id: svodniRowsTable.id, rawName: svodniRowsTable.rawName, city: svodniRowsTable.city,
    factoryLabel: svodniRowsTable.factoryLabel, factoryId: svodniRowsTable.factoryId,
    firm: svodniRowsTable.firm, ksiegBrutto: svodniRowsTable.ksiegBrutto,
    konto: svodniRowsTable.konto, segmentOf: svodniRowsTable.segmentOf,
    workerId: svodniRowsTable.workerId, workerName: workersTable.fullName,
    gratyfikantName: workersTable.gratyfikantName, pesel: workersTable.pesel,
  }).from(svodniRowsTable)
    .leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
    .where(and(eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf)));
  await enrichFirms(rows as unknown as Record<string, unknown>[]);
  const scoped = rows.filter(r => !city || r.city === city);
  return { month, firm, factoryLabels, city, rows: scoped };
}

router.get("/svodni/gratyfikant-preview", requireCap("svodniSensitive"), async (req: AuthedRequest, res) => {
  const scope = await gratyfikantScope(req, res);
  if (!scope) return;
  const { month, firm, factoryLabels, rows } = scope;
  const records = listaRecords(rows, { firm, payDate: defaultPayDate(month), factoryLabels });
  const byId = new Map(rows.map(r => [r.id, r]));
  // знімок умов для попереджень (по привʼязаних працівниках скоупу)
  const workerIds = [...new Set(records.map(r => byId.get(r.rowId)?.workerId).filter((x): x is number => x != null))];
  const umowy = workerIds.length
    ? await db.select().from(gratyfikantUmowyTable).where(inArray(gratyfikantUmowyTable.workerId, workerIds))
    : [];
  const byWorker = new Map<number, { firm: string; od: string | null; do: string | null }[]>();
  for (const u of umowy) {
    (byWorker.get(u.workerId!) ?? byWorker.set(u.workerId!, []).get(u.workerId!)!)
      .push({ firm: u.firm, od: u.odDnia, do: u.doDnia });
  }
  const anyUmowy = (await db.select({ id: gratyfikantUmowyTable.id }).from(gratyfikantUmowyTable).limit(1)).length > 0;
  const out = records.map(r => {
    const row = byId.get(r.rowId)!;
    const warnings: string[] = [];
    if (!r.pesel) warnings.push("no_pesel");
    if (row.workerId == null) warnings.push("unlinked");
    else if (anyUmowy) {
      const st = umowaStatusFor(month, firm, byWorker.get(row.workerId) ?? []);
      if (st !== "ok") warnings.push(`umowa_${st}`);
    }
    return { rowId: r.rowId, name: r.name, pesel: r.pesel, factoryLabel: row.factoryLabel, kwota: r.kwota, warnings };
  });
  ok(res, {
    month, firm, payDate: defaultPayDate(month), umowySnapshot: anyUmowy,
    rows: out,
    totals: { count: out.length, sum: Math.round(out.reduce((a, r) => a + r.kwota, 0) * 100) / 100 },
  });
});

router.get("/svodni/gratyfikant", requireCap("svodniSensitive"), async (req: AuthedRequest, res) => {
  const scope = await gratyfikantScope(req, res);
  if (!scope) return;
  const { month, firm, factoryLabels, rows } = scope;
  const payDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.payDate ?? ""))
    ? String(req.query.payDate) : defaultPayDate(month);
  const wanted = String(req.query.rows ?? "").split(",").map(s => Number(s)).filter(n => Number.isFinite(n) && n > 0);
  let records = listaRecords(rows, { firm, payDate, factoryLabels });
  if (wanted.length) {
    const set = new Set(wanted);
    records = records.filter(r => set.has(r.rowId));
  }
  if (!records.length) return fail(res, 404, "немає рядків за вибором");

  // без заголовка — формат, відпрацьований з księgową (імʼя | PESEL | дата | сума)
  const buffer = await listaXlsxBuffer(records);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`Naliczenia ${firm} ${month}.xlsx`)}"`);
  res.send(buffer);
});

// застосувати ставки/студент/до-26 місяця до профілів працівників (фінансова дія)
router.post("/svodni/apply-rates", requireCap("viewFinance"), async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  ok(res, await applyRatesFromSvodni(month));
});

export default router;

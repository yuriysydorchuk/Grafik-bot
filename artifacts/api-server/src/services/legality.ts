// Движок легальності працівника (модуль «Легалізація», фаза 1, 02.09.2026).
// ЧИСТА функція без БД: вхід — факти працівника, документи (evidence), версійовані
// правила (legal_rules) і сьогоднішня дата; вихід — юридичний стан по двох осях
// (перебування / праця) + пропозиція для легасі-поля.
//
// ІНВАРІАНТ: цей модуль НІЧОГО не пише і не імпортується payroll-кодом
// (services/svodni.ts, routes/svodni.ts, svodniSync.ts, hoursRows.ts, lib/payroll.ts,
// admin-api.ts /hours). workers.legal_status / is_student / under_26 / notify_hours
// лишаються ручним входом listy płac; тут вони лише читаються для порівняння
// (deriveLegacy) і контрольних підказок (payrollHints). Гард — legality.guard.test.ts.

export type LegalityStatus = "legal" | "pending" | "expiring" | "illegal" | "unknown";
export type Axis = "stay" | "work";
export type PayrollClass = "A_cash" | "B_student" | "C_registered" | "N_none";
export type ReasonSeverity = "info" | "warn" | "block";

export interface LegalityWorker {
  id: number;
  nationality: string | null;
  birthDate: string | null;           // YYYY-MM-DD
  companyId: number | null;           // фірма-роботодавець (workers.company_id)
  employmentStartDate: string | null;
  /** з якої дати людина в ПОТОЧНІЙ фірмі: max(employment_start_date, останній journal companyId) — рахує legalityRecompute */
  employerSince?: string | null;
  isStudent: boolean;
  legalStatus: string | null;         // легасі-поле — лише для порівняння
  notifyHours: number | null;
  factoryId?: number | null;          // основна фабрика (workers.factory_id)
}

// Умова з модуля підпису (contracts): для осі «умова». hasUmowa — у пакеті є
// документ виду umowa (сталий пакет ZUS/PPK без umowy умовою не є).
export interface LegalityContract {
  id: number;
  factoryId: number | null;
  companyId: number | null;           // наша фірма в умові; null у старих записах = не звіряємо
  status: string;                     // draft | … | worker_signed | signed | cancelled | superseded | expired
  dateFrom: string | null;
  dateTo: string | null;
  hasUmowa: boolean;
}
// Роботодавець = фабрика працівника (основна або активна додаткова) + наша фірма на ній
// (рішення власника 05.09.2026): умова — на кожну фабрику від її фірми; підстава праці —
// на кожну фірму (документ на цю фірму або незалежний від роботодавця).
export interface LegalityEmployer { factoryId: number; factoryName: string | null; companyId: number | null; companyName: string | null; primary: boolean }

export interface LegalityDocument {
  id: number;
  typeCode: string | null;
  category: string;                   // identity | stay | work | payroll | medical | other
  status: "present" | "pending" | "expired" | "missing";
  hasExpiry: boolean;
  grantsStay: boolean;
  grantsWork: boolean;
  requiresEmployerMatch: boolean;
  validFrom: string | null;
  expiresAt: string | null;
  renewalLeadDays: number | null;
  appliesToNationalities: string[] | null;
  employerCompanyId: number | null;
  caseStatus: string | null;          // to_submit | submitted | in_progress | decision_positive | decision_negative | withdrawn
  submittedAt: string | null;
  verifiedAt: string | null;
  replacesDocumentId: number | null;
}

export interface LegalRuleInput {
  code: string;
  kind: string;                       // basis_by_nationality | requirement | obligation | precedence | global
  axis: Axis | "both" | null;
  conditions: Record<string, unknown>;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  isActive?: boolean;
  verifiedAt: string | Date | null;
}

export interface LegalityFacts {
  /** громадянство з паспорта (MRZ анкети) у кодах каталогу; null = анкети/скану нема */
  passportNationality?: string | null;
  /** true = worker.nationality порожнє, взято з паспорта (loader) */
  nationalityFromPassport?: boolean;
  hoursThisMonth?: number | null;
  /** зовнішній факт подання powiadomienia (напр. з праці.gov.pl), якщо документа ще нема */
  notificationSubmittedAt?: string | null;
  /** фірма останніх рядків сводної (мультифірмові вкладки) — для employer_ambiguous */
  lastSvodniCompanyId?: number | null;
  /** фабрики зі змінами в графіку за останні ~30 днів — підказка «зміни на фабриці поза списком» */
  scheduleFactories?: { factoryId: number; name: string | null }[];
}

export interface LegalityInput {
  today: string;                      // YYYY-MM-DD (Warsaw)
  worker: LegalityWorker;
  documents: LegalityDocument[];
  rules: LegalRuleInput[];
  facts?: LegalityFacts;
  contracts?: LegalityContract[];     // модуль підпису; відсутнє = не завантажено → вісь «умова» unknown
  employers?: LegalityEmployer[];     // фабрики працівника з фірмами; відсутнє = лише фірма профілю (старі виклики/юніти)
}

export interface Reason { code: string; axis: Axis | "contract" | "overall"; severity: ReasonSeverity; params?: Record<string, unknown> }
export interface AxisResult {
  status: LegalityStatus;
  basisDocId: number | null;
  basisRuleCode: string | null;
  expiresAt: string | null;
  reasons: Reason[];
}
export interface Obligation { code: string; dueAt: string; overdue: boolean; satisfied: boolean; params?: Record<string, unknown> }

export interface LegacyDerivation {
  derivedLegalStatus: string | null;
  derivedPayrollClass: PayrollClass | null;
  currentPayrollClass: PayrollClass;
  legacyMappingRequiresReview: boolean;
  legacyMismatchKind: "none" | "within_class" | "cross_class" | "no_proposal";
  evidence: { kind: "document" | "nationality" | "case"; id?: number; rule?: string; code?: string } | null;
}

export interface PayrollHints {
  studentByProfile: boolean;          // = stud26Of: (is_student || legal_status=student) && вік < 26
  studentCertMissingOrExpired: boolean;
  notifyHoursWithoutBasis: boolean;
  hoursExceedNotify: boolean | null;
  workBasisMissing: boolean;          // легасі каже «оформлений» (клас C), а документа-підстави праці нема
}

export interface LegalityResult {
  stay: AxisResult;
  work: AxisResult;
  contract: AxisResult;               // чинна умова на кожну фабрику (basisDocId = id умови-підстави основної фабрики)
  overall: LegalityStatus;
  reviewRequired: boolean;
  reasons: Reason[];
  nextExpiry: { docId: number; typeCode: string | null; date: string; daysLeft: number } | null;
  requiredMissing: string[];          // коди типів або псевдо-коди stay_basis | work_basis
  obligations: Obligation[];
  legacy: LegacyDerivation;
  payrollHints: PayrollHints;
}

// ─── Каталоги ────────────────────────────────────────────────────────────────
export const LEGAL_STATUSES_CANON = ["student", "dyplom", "powiadomienie", "zus", "oczekuje", "karta_pobytu", "staly_pobyt", "polak"] as const;
export type LegacyStatus = (typeof LEGAL_STATUSES_CANON)[number];

// Дзеркало services/svodni.ts normalizeProfileLegal (тест legality.test.ts звіряє обидві).
// Не імпортуємо svodni.ts, щоб движок лишався без БД-залежностей.
export function normalizeLegacyStatus(status: string | null | undefined): LegacyStatus | null {
  const s = String(status ?? "").trim();
  if (!s) return null;
  if ((LEGAL_STATUSES_CANON as readonly string[]).includes(s)) return s as LegacyStatus;
  switch (s) {
    case "student_do26": case "student_po26": case "do26": return "student";
    case "oswiadczenie": return "powiadomienie";
    case "zezwolenie": return "zus";
    case "nieoformiony": return "oczekuje";
    default: return null;
  }
}

// Payroll-клас значення legal_status (з коду applyLegalDefaults/computeSegmented/ksiegRatesOf):
// oczekuje → все готівкою; student → податковий клас; NULL → без статусу; решта — «оформлений».
export function payrollClassOf(status: string | null | undefined): PayrollClass {
  const s = normalizeLegacyStatus(status);
  if (s == null) return "A_cash"; // без статусу = не зголошений (уточнення власника 04.09.2026)
  if (s === "oczekuje") return "A_cash";
  if (s === "student") return "B_student";
  return "C_registered";
}

export const EU_NATIONALITIES = new Set(["poland", "romania", "eu_other"]);
import { docTypeStatus, precedenceOf, legacyStatusInfo, resolveStatusMap, DEFAULT_STATUS_MAP, type ResolvedStatusMap } from "./legalStatusMap";
export const UA_NATIONALITIES = new Set(["ukraine"]);

/** true/false — відомо; null — національність невідома */
export function nationalityMatches(groups: string[] | null | undefined, nationality: string | null): boolean | null {
  if (!groups || groups.length === 0) return true;
  if (!nationality) return null;
  for (const g of groups) {
    if (g === nationality) return true;
    if (g === "eu" && EU_NATIONALITIES.has(nationality)) return true;
    if (g === "ua" && UA_NATIONALITIES.has(nationality)) return true;
    if (g === "non_eu" && !EU_NATIONALITIES.has(nationality)) return true;
  }
  return false;
}

// ─── Дати (рядками, без toISOString — правило проєкту) ───────────────────────
const dayMs = 86400000;
const toUtc = (d: string): number => {
  const [y, m, dd] = d.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, dd ?? 1);
};
export const daysBetween = (from: string, to: string): number => Math.round((toUtc(to) - toUtc(from)) / dayMs);
export function addDaysStr(d: string, n: number): string {
  const t = new Date(toUtc(d) + n * dayMs);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
// Дзеркало services/svodniSync.ts isUnder26: день 26-річчя вже НЕ «до 26».
export function isUnderAgeAt(birthDate: string | null, at: string, maxAge: number): boolean | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ay, am, ad] = at.split("-").map(Number);
  const age = ay! - by! - ((am! < bm!) || (am === bm && ad! < bd!) ? 1 : 0);
  return age < maxAge;
}
export const isUnder26At = (birthDate: string | null, at: string): boolean | null => isUnderAgeAt(birthDate, at, 26);

// ─── Правила ─────────────────────────────────────────────────────────────────
export function activeRules(rules: LegalRuleInput[], today: string): LegalRuleInput[] {
  return rules.filter(r =>
    r.isActive !== false
    && (!r.effectiveFrom || r.effectiveFrom <= today)
    && (!r.effectiveTo || r.effectiveTo > today),
  );
}

interface Globals {
  defaultLeadDays: number;
  unverifiedCountsAsBasis: boolean;
  ukrStatusEnd: string | null;
  ukrRuleVerified: boolean;
  statusMap: ResolvedStatusMap; // мапа виплат — правило payroll.status_map або дефолти з коду
}
const DEFAULT_GLOBALS: Globals = { defaultLeadDays: 30, unverifiedCountsAsBasis: false, ukrStatusEnd: null, ukrRuleVerified: false, statusMap: DEFAULT_STATUS_MAP };
function readGlobals(rules: LegalRuleInput[]): Globals {
  const g: Globals = { ...DEFAULT_GLOBALS };
  for (const r of rules) {
    if (r.code === "payroll.status_map" && r.conditions && typeof r.conditions === "object") g.statusMap = resolveStatusMap(r.conditions as Record<string, unknown>);
    if (r.code === "defaults.lead_days" && typeof r.conditions.defaultLeadDays === "number") g.defaultLeadDays = r.conditions.defaultLeadDays as number;
    if (r.code === "defaults.evidence" && typeof r.conditions.unverifiedCountsAsBasis === "boolean") g.unverifiedCountsAsBasis = r.conditions.unverifiedCountsAsBasis as boolean;
    if (r.code === "global.ukr_status_end" && typeof r.conditions.date === "string") { g.ukrStatusEnd = r.conditions.date as string; g.ukrRuleVerified = !!r.verifiedAt; }
  }
  return g;
}

const SEVERITY_RANK: Record<LegalityStatus, number> = { legal: 0, pending: 1, expiring: 2, unknown: 3, illegal: 4 };
const worst = (a: LegalityStatus, b: LegalityStatus): LegalityStatus => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

const isCaseOpen = (d: LegalityDocument) => d.caseStatus === "submitted" || d.caseStatus === "in_progress";
const CASE_WORK_TYPES = new Set(["zezwolenie_jednolite", "zezwolenie_a", "oswiadczenie"]);

// ─── Основний розрахунок ──────────────────────────────────────────────────────
export function computeLegality(input: LegalityInput): LegalityResult {
  const { today, worker, documents } = input;
  const rules = activeRules(input.rules, today);
  const g = readGlobals(rules);
  const reasons: Reason[] = [];
  let review = false;
  const flag = (r: Reason, needsReview = false) => { reasons.push(r); if (needsReview) review = true; };

  if (!worker.nationality) flag({ code: "nationality_unknown", axis: "overall", severity: "warn" }, true);
  else if (input.facts?.nationalityFromPassport) flag({ code: "nationality_from_passport", axis: "overall", severity: "info", params: { nationality: worker.nationality } });
  // профіль каже одне громадянство, паспорт — інше: не вирішуємо самі, лише review
  else if (input.facts?.passportNationality && input.facts.passportNationality !== worker.nationality) {
    flag({ code: "nationality_conflict", axis: "overall", severity: "warn", params: { profile: worker.nationality, passport: input.facts.passportNationality } }, true);
  }

  // ефективна дата закінчення документа (status_ukr → глобальна дата)
  const effExpiry = (d: LegalityDocument): string | null => {
    if (d.expiresAt) return d.expiresAt;
    if (d.typeCode === "status_ukr") return g.ukrStatusEnd;
    return null;
  };
  const isValidAt = (d: LegalityDocument, at: string): boolean => {
    if (d.status !== "present") return false;
    if (d.validFrom && d.validFrom > at) return false;
    const e = effExpiry(d);
    return !e || e >= at;
  };
  // Роботодавці: фірми фабрик працівника; без списку — фірма профілю (старі виклики).
  // Документ, привʼязаний до роботодавця, рахується для фірми, на яку виданий:
  // "ok" — для цієї фірми; "other" — на іншу НАШУ фірму зі списку (не помилка, просто
  // інший роботодавець); "mismatch" — на фірму поза списком роботодавців.
  const employers = input.employers ?? [];
  const employerCompanies: (number | null)[] = employers.length
    ? [...new Set(employers.map(e => e.companyId ?? worker.companyId))]
    : [worker.companyId];
  const primaryCompany = employers.find(e => e.primary)?.companyId ?? worker.companyId;
  const companyNameOf = (cid: number | null) => employers.find(e => (e.companyId ?? worker.companyId) === cid)?.companyName ?? (cid == null ? "—" : `#${cid}`);
  const employerOk = (d: LegalityDocument, forCompany: number | null): "ok" | "unknown" | "other" | "mismatch" => {
    if (!d.requiresEmployerMatch) return "ok";
    if (d.employerCompanyId == null) return "unknown";
    if (d.employerCompanyId === forCompany) return "ok";
    return employerCompanies.includes(d.employerCompanyId) ? "other" : "mismatch";
  };

  // повідомлення про мismatch/unknown роботодавця — раз на документ, не на вісь
  const employerFlagged = new Set<number>();

  // forCompany — фірма, для якої шукаємо підставу; collect — чи писати причини в загальний список
  // (для не-основних роботодавців осі «праця» причини зводяться до однієї «бракує для фірми X»)
  const evalAxis = (axis: Axis, forCompany: number | null = primaryCompany, collect = true): AxisResult => {
    const out: AxisResult = { status: "unknown", basisDocId: null, basisRuleCode: null, expiresAt: null, reasons: [] };
    const push = (r: Omit<Reason, "axis">, needsReview = false) => { const rr = { ...r, axis }; out.reasons.push(rr); if (collect) flag(rr, needsReview); };

    // 1) підстава за громадянством
    for (const r of rules) {
      if (r.kind !== "basis_by_nationality" || !(r.axis === axis || r.axis === "both")) continue;
      const nats = Array.isArray(r.conditions.nationalities) ? (r.conditions.nationalities as string[]) : null;
      if (nationalityMatches(nats, worker.nationality) === true) {
        out.status = "legal"; out.basisRuleCode = r.code;
        if (!r.verifiedAt) push({ code: "rule_unverified", severity: "warn", params: { rule: r.code } }, true);
        return out;
      }
    }

    // 2) документи-підстави
    const grants = (d: LegalityDocument) => (axis === "stay" ? d.grantsStay : d.grantsWork);
    const usable: { d: LegalityDocument; exp: string | null; review: boolean }[] = [];
    const expired: LegalityDocument[] = [];
    let hadMismatch = false;
    for (const d of documents) {
      if (!grants(d)) continue;
      if (d.status === "pending") {
        if (!g.unverifiedCountsAsBasis) { push({ code: "evidence_unverified", severity: "info", params: { docId: d.id, typeCode: d.typeCode } }); continue; }
      } else if (d.status !== "present") continue;
      const emp = employerOk(d, forCompany);
      if (emp === "other") continue; // документ іншого нашого роботодавця — рахується в його прогоні
      if (emp === "mismatch") {
        hadMismatch = true;
        if (!employerFlagged.has(d.id)) { employerFlagged.add(d.id); push({ code: "employer_mismatch", severity: "block", params: { docId: d.id, typeCode: d.typeCode, employerCompanyId: d.employerCompanyId } }); }
        continue;
      }
      if (d.validFrom && d.validFrom > today) { push({ code: "not_yet_valid", severity: "info", params: { docId: d.id, validFrom: d.validFrom } }); continue; }
      const exp = effExpiry(d);
      if (exp && exp < today) { expired.push(d); continue; }
      let needsReview = false;
      if (d.status === "pending") { needsReview = true; push({ code: "evidence_unverified", severity: "warn", params: { docId: d.id } }, true); }
      if (emp === "unknown" && !employerFlagged.has(d.id)) { employerFlagged.add(d.id); needsReview = true; push({ code: "employer_unknown", severity: "warn", params: { docId: d.id, typeCode: d.typeCode } }, true); }
      if (!exp && d.hasExpiry) { needsReview = true; push({ code: "expiry_missing", severity: "warn", params: { docId: d.id, typeCode: d.typeCode } }, true); }
      if (d.typeCode === "status_ukr" && !g.ukrRuleVerified) { needsReview = true; push({ code: "rule_unverified", severity: "warn", params: { rule: "global.ukr_status_end" } }, true); }
      if (d.appliesToNationalities && nationalityMatches(d.appliesToNationalities, worker.nationality) === false) {
        push({ code: "doc_nationality_mismatch", severity: "warn", params: { docId: d.id, typeCode: d.typeCode } }, true);
      }
      usable.push({ d, exp, review: needsReview });
    }
    if (usable.length) {
      // найпізніший строк; без строку = безстроковий → найкращий
      usable.sort((a, b) => (a.exp == null ? 1 : b.exp == null ? -1 : a.exp < b.exp ? 1 : a.exp > b.exp ? -1 : 0));
      const pick = usable[0]!;
      out.basisDocId = pick.d.id; out.expiresAt = pick.exp;
      const lead = pick.d.renewalLeadDays ?? g.defaultLeadDays;
      if (pick.exp && daysBetween(today, pick.exp) <= lead) {
        out.status = "expiring";
        push({ code: "basis_expiring", severity: "warn", params: { docId: pick.d.id, typeCode: pick.d.typeCode, expiresAt: pick.exp, daysLeft: daysBetween(today, pick.exp) } });
      } else out.status = "legal";
      return out;
    }

    // 3) справа в toku
    const caseDocs = documents.filter(d => d.status !== "missing" && isCaseOpen(d)
      && (axis === "stay" ? (d.category === "stay" || d.grantsStay) : (d.grantsWork || CASE_WORK_TYPES.has(d.typeCode ?? "") || d.category === "stay")));
    if (caseDocs.length) {
      const c = caseDocs[0]!;
      if (axis === "stay") {
        out.status = "pending"; out.basisDocId = c.id;
        push({ code: "case_in_progress", severity: "info", params: { docId: c.id, caseStatus: c.caseStatus, submittedAt: c.submittedAt } });
        return out;
      }
      // work: precedence — право на працю мало існувати безпосередньо перед поданням
      const precedence = rules.find(r => r.kind === "precedence" && r.code === "precedence.work_during_case");
      const requiresPrior = precedence ? precedence.conditions.requiresPriorWorkBasis !== false : true;
      const at = c.submittedAt ?? today;
      const hadPrior = documents.some(d => d.grantsWork && d.id !== c.id && employerOk(d, primaryCompany) !== "mismatch"
        && (!d.validFrom || d.validFrom <= at) && (() => { const e = effExpiry(d); return !e || e >= at; })() && (d.status === "present" || d.status === "expired"));
      if (!requiresPrior || hadPrior) {
        out.status = "pending"; out.basisDocId = c.id;
        push({ code: "case_in_progress", severity: "info", params: { docId: c.id, caseStatus: c.caseStatus, submittedAt: c.submittedAt } });
        if (precedence && !precedence.verifiedAt) push({ code: "rule_unverified", severity: "warn", params: { rule: precedence.code } }, true);
      } else {
        out.status = "unknown"; out.basisDocId = c.id;
        push({ code: "work_during_case_uncertain", severity: "warn", params: { docId: c.id, submittedAt: c.submittedAt } }, true);
      }
      return out;
    }

    // 4) лише прострочені / невідповідний роботодавець → illegal
    if (expired.length || hadMismatch) {
      out.status = "illegal";
      if (expired.length) {
        const last = expired.sort((a, b) => ((effExpiry(a) ?? "") < (effExpiry(b) ?? "") ? 1 : -1))[0]!;
        out.basisDocId = last.id; out.expiresAt = effExpiry(last);
        push({ code: "basis_expired", severity: "block", params: { docId: last.id, typeCode: last.typeCode, expiresAt: effExpiry(last) } });
      }
      return out;
    }

    // 5) нічого — unknown
    push({ code: "no_basis", severity: "warn" }, worker.nationality == null);
    return out;
  };

  const stay = evalAxis("stay");
  // праця — на кожного роботодавця: основна фірма дає підставу/причини осі, решта фірм
  // додають лише «бракує підстави праці для фірми X», якщо для них підстави нема
  const work = evalAxis("work");
  for (const cid of employerCompanies) {
    if (cid === primaryCompany) continue;
    const r = evalAxis("work", cid, false);
    if (r.status === "legal" || r.status === "expiring") continue;
    work.status = worst(work.status, r.status === "unknown" ? "illegal" : r.status);
    flag({ code: "work_basis_missing_for_company", axis: "work", severity: "block", params: { companyId: cid, company: companyNameOf(cid) } }, false);
  }
  // головна фірма профілю (виплати/сводна) має бути одним із роботодавців
  if (employers.length && worker.companyId != null && !employerCompanies.includes(worker.companyId)) {
    flag({ code: "main_company_not_employer", axis: "overall", severity: "warn", params: { companyId: worker.companyId } }, true);
  }

  // ── обов'язки роботодавця (powiadomienie ≤ N днів) ──
  const obligations: Obligation[] = [];
  const employerSince = worker.employerSince ?? worker.employmentStartDate ?? null;
  for (const r of rules) {
    if (r.kind !== "obligation") continue;
    const nats = Array.isArray(r.conditions.nationalities) ? (r.conditions.nationalities as string[]) : null;
    if (nationalityMatches(nats, worker.nationality) !== true) continue;
    // обов'язок актуальний лише коли праця тримається на цьому документі (не на іншій підставі)
    const docCode = String(r.conditions.docCode ?? "");
    const days = typeof r.conditions.days === "number" ? (r.conditions.days as number) : 7;
    const hard = r.conditions.hard === true;
    if (!employerSince) { flag({ code: "employment_start_unknown", axis: "work", severity: "info", params: { rule: r.code } }); continue; }
    const dueAt = addDaysStr(employerSince, days);
    const doc = documents.find(d => d.typeCode === docCode && d.status !== "missing" && employerOk(d, primaryCompany) === "ok");
    const submittedAt = doc?.submittedAt ?? doc?.validFrom ?? input.facts?.notificationSubmittedAt ?? null;
    const satisfied = !!doc || !!input.facts?.notificationSubmittedAt;
    const overdue = !satisfied && today > dueAt;
    const late = satisfied && !!submittedAt && submittedAt > dueAt;
    obligations.push({ code: r.code, dueAt, overdue, satisfied, params: { docCode, days, submittedAt, hard, late } });
    // якщо праця вже тримається на іншій верифікованій підставі (student/dyplom/stały…) — обов'язок інформаційний
    const workOnOtherBasis = work.status === "legal" && work.basisDocId != null
      && documents.find(d => d.id === work.basisDocId)?.typeCode !== docCode;
    if (overdue && !workOnOtherBasis) {
      if (hard) { work.status = "illegal"; flag({ code: "notification_overdue", axis: "work", severity: "block", params: { rule: r.code, dueAt } }); }
      else flag({ code: "notification_overdue", axis: "work", severity: "warn", params: { rule: r.code, dueAt } }, true);
      if (!r.verifiedAt) flag({ code: "rule_unverified", axis: "work", severity: "warn", params: { rule: r.code } }, true);
    } else if (late) {
      flag({ code: "notification_late", axis: "work", severity: "warn", params: { rule: r.code, dueAt, submittedAt } }, true);
    }
  }

  // ── неоднозначність роботодавця ──
  const employerIds = new Set(documents.filter(d => d.status === "present" && d.requiresEmployerMatch && d.employerCompanyId != null).map(d => d.employerCompanyId!));
  if (employerIds.size > 1) flag({ code: "employer_ambiguous", axis: "overall", severity: "warn", params: { employers: [...employerIds] } }, true);
  if (input.facts?.lastSvodniCompanyId != null && worker.companyId != null && input.facts.lastSvodniCompanyId !== worker.companyId) {
    flag({ code: "employer_ambiguous", axis: "overall", severity: "warn", params: { lastSvodniCompanyId: input.facts.lastSvodniCompanyId } }, true);
  }

  // ── обов'язкові відсутні ──
  const requiredMissing: string[] = [];
  const natForReq = worker.nationality;
  for (const r of rules) {
    if (r.kind !== "requirement") continue;
    const nats = Array.isArray(r.conditions.nationalities) ? (r.conditions.nationalities as string[]) : null;
    const m = nationalityMatches(nats, natForReq);
    if (m === false) continue; // null (невідома) → вимога застосовується з попередженням
    const anyOf = Array.isArray(r.conditions.anyOf) ? (r.conditions.anyOf as string[]) : null;
    if (anyOf) {
      if (!documents.some(d => d.typeCode && anyOf.includes(d.typeCode) && (d.status === "present" || d.status === "pending"))) requiredMissing.push(anyOf[0]!);
      continue;
    }
    const cat = String(r.conditions.category ?? "");
    if (cat === "stay" && stay.status === "unknown" && stay.basisDocId == null) requiredMissing.push("stay_basis");
    if (cat === "work" && work.status === "unknown" && work.basisDocId == null) requiredMissing.push("work_basis");
  }

  // ── найближчий строк (усі present документи, включно з identity/medical) ──
  let nextExpiry: LegalityResult["nextExpiry"] = null;
  for (const d of documents) {
    if (d.status !== "present") continue;
    const e = effExpiry(d);
    if (!e || e < today) continue;
    if (!nextExpiry || e < nextExpiry.date) nextExpiry = { docId: d.id, typeCode: d.typeCode, date: e, daysLeft: daysBetween(today, e) };
  }

  // ── вісь «умова»: чинний підписаний пакет на кожну фабрику (або BIURO для офісу) ──
  const contract = computeContractAxis(input, g);
  for (const r of contract.reasons) flag(r, r.code === "schedule_outside_factories");

  // Вісь «умова» тягне overall лише коли є що звіряти: unknown (немає даних про умови
  // або фабрики в профілі) — це прогалина даних з власною причиною, не юридичний дефект
  const overall = contract.status !== "unknown" ? worst(worst(stay.status, work.status), contract.status) : worst(stay.status, work.status);

  const legacy = deriveLegacy({ stay, work }, worker, documents, today, g, employerCompanies);
  if (legacy.legacyMappingRequiresReview) review = true;
  // Порожній профіль (жодного документа) — це «немає даних», а не «потребує перевірки»:
  // перевіряти нема чого, reviewRequired на 400 людей без документів був би шумом.
  if (documents.length === 0 && worst(stay.status, work.status) === "unknown") review = false;

  // ── контрольні підказки (НЕ вхід payroll) ──
  const under26 = isUnder26At(worker.birthDate, today);
  const studentByLegacy = worker.isStudent || normalizeLegacyStatus(worker.legalStatus) === "student";
  const studentCert = documents.find(d => d.typeCode === "student_cert" && isValidAt(d, today));
  const workDocBasis = documents.some(d => d.typeCode && ["oswiadczenie", "powiadomienie_ua", "zezwolenie_a", "zezwolenie_jednolite"].includes(d.typeCode) && isValidAt(d, today) && employerOk(d, primaryCompany) === "ok");
  const payrollHints: PayrollHints = {
    studentByProfile: !!(studentByLegacy && under26 === true),
    studentCertMissingOrExpired: !!studentByLegacy && !studentCert,
    notifyHoursWithoutBasis: (worker.notifyHours ?? 0) > 0 && !workDocBasis,
    hoursExceedNotify: input.facts?.hoursThisMonth != null && worker.notifyHours != null ? input.facts.hoursThisMonth > worker.notifyHours : null,
    workBasisMissing: payrollClassOf(worker.legalStatus) === "C_registered" && work.basisDocId == null && work.basisRuleCode == null,
  };

  return { stay, work, contract, overall, reviewRequired: review, reasons, nextExpiry, requiredMissing, obligations, legacy, payrollHints };
}

// ─── Вісь «умова» (рішення власника 04–05.09.2026) ────────────────────────────
// Оформлений = перебування + праця + чинна умова на КОЖНОГО роботодавця
// (фабрика працівника + наша фірма на ній; офіс — фабрика з is_office, як усі).
// Чинна = status signed, dateTo не в минулому (без дати — чинна, дати дописують
// постфактум), фірма умови = фірма роботодавця (умова без фірми — старий запис,
// не звіряємо). worker_signed = чекає підпису компанії → pending. Найгірша
// фабрика визначає статус осі; причини — по фабриках. Без фабрики в профілі —
// червоне: посади без фабрики не буває.
const CONTRACT_VALID = new Set(["signed"]);
const CONTRACT_PENDING = new Set(["worker_signed"]);
export function computeContractAxis(input: LegalityInput, g: Globals): AxisResult {
  const { today, worker } = input;
  const reasons: Reason[] = [];
  const push = (code: string, severity: ReasonSeverity, params?: Record<string, unknown>) => reasons.push({ code, axis: "contract", severity, params });
  if (!input.contracts) return { status: "unknown", basisDocId: null, basisRuleCode: null, expiresAt: null, reasons };

  const employers = input.employers ?? [];
  if (!employers.length) {
    push("no_factory", "block");
    return { status: "illegal", basisDocId: null, basisRuleCode: null, expiresAt: null, reasons };
  }

  let status: LegalityStatus = "legal";
  let basisDocId: number | null = null;
  let expiresAt: string | null = null;
  for (const e of employers) {
    const fname = e.factoryName ?? `#${e.factoryId}`;
    const cid = e.companyId ?? worker.companyId;
    const onFactory = input.contracts.filter(c => c.factoryId === e.factoryId);
    const mine = onFactory.filter(c => c.companyId == null || cid == null || c.companyId === cid);
    const live = mine.filter(c => (CONTRACT_VALID.has(c.status) || CONTRACT_PENDING.has(c.status)) && (!c.dateTo || c.dateTo >= today) && (!c.dateFrom || c.dateFrom <= today || CONTRACT_PENDING.has(c.status)));
    // найкраща: signed > worker_signed; далі — найпізніша dateTo (безстрокова найкраща)
    live.sort((a, b) => (CONTRACT_VALID.has(b.status) ? 1 : 0) - (CONTRACT_VALID.has(a.status) ? 1 : 0) || (a.dateTo == null ? -1 : b.dateTo == null ? 1 : b.dateTo.localeCompare(a.dateTo)));
    const best = live[0];
    if (!best) {
      const expired = mine.filter(c => CONTRACT_VALID.has(c.status) && c.dateTo && c.dateTo < today).sort((a, b) => b.dateTo!.localeCompare(a.dateTo!))[0];
      const otherFirm = onFactory.find(c => CONTRACT_VALID.has(c.status) && (!c.dateTo || c.dateTo >= today) && c.companyId != null && cid != null && c.companyId !== cid);
      if (expired) push("contract_expired", "block", { factoryId: e.factoryId, factory: fname, expiresAt: expired.dateTo, contractId: expired.id });
      else if (otherFirm) push("contract_wrong_company", "block", { factoryId: e.factoryId, factory: fname, company: e.companyName ?? `#${cid}`, contractCompanyId: otherFirm.companyId, contractId: otherFirm.id });
      else push("contract_missing", "block", { factoryId: e.factoryId, factory: fname, company: e.companyName ?? null });
      status = "illegal";
      continue;
    }
    if (CONTRACT_PENDING.has(best.status)) {
      push("contract_awaiting_company", "warn", { factoryId: e.factoryId, factory: fname, contractId: best.id });
      if (status !== "illegal") status = "pending";
    } else if (best.dateTo && daysBetween(today, best.dateTo) <= g.defaultLeadDays) {
      push("contract_expiring", "warn", { factoryId: e.factoryId, factory: fname, expiresAt: best.dateTo, daysLeft: daysBetween(today, best.dateTo), contractId: best.id });
      if (status === "legal") status = "expiring";
    }
    if (e.primary || basisDocId == null) basisDocId = best.id;
    if (best.dateTo && (!expiresAt || best.dateTo < expiresAt)) expiresAt = best.dateTo;
  }

  // зміни в графіку на фабриці поза списком — підказка офісу (не міняє статус)
  for (const sf of input.facts?.scheduleFactories ?? []) {
    if (!employers.some(e => e.factoryId === sf.factoryId)) push("schedule_outside_factories", "warn", { factoryId: sf.factoryId, factory: sf.name ?? `#${sf.factoryId}` });
  }
  return { status, basisDocId, basisRuleCode: null, expiresAt, reasons };
}

// ─── Legacy-адаптер (§4.2 плану): лише доведені існуючою логікою мапи ────────
// Доказ — regex у services/svodni.ts legalStatusOf / normalizeProfileLegal:
//   POLAK → polak; STALY POBYT → staly_pobyt; KARTA POBYTU|DECYZJA → karta_pobytu;
//   DYPLOM → dyplom; POWIADOMIENIE (+ легасі oswiadczenie) → powiadomienie;
//   ZEZWOLEN → zus; STUDENT → student; NIE ZGLOSZON|CZEKAMY → oczekuje.
// Усе інше (rezydent, лише status_ukr, кілька підстав) → null + review.
export function deriveLegacy(
  axes: { stay: AxisResult; work: AxisResult },
  worker: LegalityWorker,
  documents: LegalityDocument[],
  today: string,
  globals?: Globals,
  employerCompanies: (number | null)[] = [worker.companyId],
): LegacyDerivation {
  const g = globals ?? DEFAULT_GLOBALS;
  const map = g.statusMap;
  const manualOnly = (s: LegacyStatus | null) => !!s && legacyStatusInfo(s, map).manualOnly;
  const current = normalizeLegacyStatus(worker.legalStatus);
  const currentClass = payrollClassOf(worker.legalStatus);
  const valid = (d: LegalityDocument) => d.status === "present" && (!d.validFrom || d.validFrom <= today)
    && (() => { const e = d.expiresAt ?? (d.typeCode === "status_ukr" ? g.ukrStatusEnd : null); return !e || e >= today; })();
  // документ на будь-якого з наших роботодавців працівника — підстава для статусу
  const empOk = (d: LegalityDocument) => !d.requiresEmployerMatch || (d.employerCompanyId != null && employerCompanies.includes(d.employerCompanyId));

  type Cand = { status: LegacyStatus | null; cls: PayrollClass; review: boolean; evidence: LegacyDerivation["evidence"] };
  const cands: Cand[] = [];
  if (axes.stay.basisRuleCode === "stay.pl_citizen" || axes.work.basisRuleCode === "stay.pl_citizen") {
    cands.push({ status: "polak", cls: "C_registered", review: false, evidence: { kind: "nationality", rule: "stay.pl_citizen" } });
  }
  let ukrOnly = false;
  // Тип документа → статус/група — з мапи services/legalStatusMap.ts (спільний
  // словник з вкладкою Налаштувань). Справа (stay_case_certificate) — не кандидат,
  // а фолбек через axes.work нижче; status_ukr — лише побут.
  for (const d of documents) {
    if (!valid(d) || !d.typeCode) continue;
    const ev = { kind: "document" as const, id: d.id, code: d.typeCode };
    if (d.typeCode === "status_ukr") { ukrOnly = true; continue; }
    if (d.typeCode === "stay_case_certificate") continue;
    if (d.typeCode === "student_cert") {
      // студент для виплат: довідка будь-якої форми + вік до studentMaxAge (26) за датою
      // народження; без дати — пропозиція з review; старший — довідка на групу не впливає
      if (manualOnly("student")) continue;
      const young = isUnderAgeAt(worker.birthDate, today, map.studentMaxAge);
      if (young === false) continue;
      cands.push({ status: "student", cls: legacyStatusInfo("student", map).group, review: young === null, evidence: ev });
      continue;
    }
    const m = docTypeStatus(d.typeCode, map);
    if (!m) continue;
    if (m.requiresEmployerMatch && !empOk(d)) continue;
    if (manualOnly(m.status)) continue;
    cands.push({ status: m.status, cls: m.group, review: m.review, evidence: ev });
  }
  const finish = (c: Cand | null, kindOverride?: LegacyDerivation["legacyMismatchKind"]): LegacyDerivation => {
    if (!c || c.status == null) {
      return {
        derivedLegalStatus: null, derivedPayrollClass: c?.cls ?? null, currentPayrollClass: currentClass,
        legacyMappingRequiresReview: !!c?.review,
        legacyMismatchKind: kindOverride ?? "no_proposal", evidence: c?.evidence ?? null,
      };
    }
    // та сама група виплат = гроші без змін (у т.ч. NULL ↔ oczekuje — обидва група A)
    const kind: LegacyDerivation["legacyMismatchKind"] = c.status === current ? "none" : c.cls === currentClass ? "within_class" : "cross_class";
    return { derivedLegalStatus: c.status, derivedPayrollClass: c.cls, currentPayrollClass: currentClass, legacyMappingRequiresReview: c.review, legacyMismatchKind: kind, evidence: c.evidence };
  };

  // студент до 26 — сильніший за будь-яку C-підставу: усе на konto (уточнення власника 04.09.2026)
  const student = cands.find(c => c.status === "student");
  if (student) return finish(student);

  const proposals = cands.filter(c => c.status != null);
  const distinct = new Set(proposals.map(c => c.status));
  if (distinct.size > 1) {
    // кілька різних підстав однієї групи C — гроші однакові, беремо сильнішу за
    // пріоритетом мапи (рішення власника 04.09.2026: детермінований статус, без review);
    // різні групи (напр. C + student) — пріоритету немає → null + review
    const allC = proposals.every(c => c.cls === "C_registered");
    if (allC) return finish([...proposals].sort((a, b) => precedenceOf(a.status, map) - precedenceOf(b.status, map))[0]!);
    return finish({ status: null, cls: null as unknown as PayrollClass, review: true, evidence: null }, "no_proposal");
  }
  if (proposals.length === 1) return finish(proposals[0]!);
  if (cands.length) return finish(cands[0]!); // лише rezydent → null + review
  if (ukrOnly) return finish({ status: null, cls: "C_registered", review: true, evidence: { kind: "document", code: "status_ukr" } });
  // справа в toku без жодної робочої підстави → oczekuje (клас A, завжди review)
  if (axes.work.status === "pending" || (axes.work.status === "unknown" && axes.work.basisDocId != null)) {
    return finish({ status: "oczekuje", cls: "A_cash", review: true, evidence: { kind: "case", id: axes.work.basisDocId ?? undefined } });
  }
  // ані статусу, ані чинних документів → не зголошений, усе готівкою (уточнення власника 04.09.2026);
  // зі старим статусом і без документів — пропозиції немає, резолвер бере старий блок
  if (current == null && !documents.some(d => valid(d))) {
    return finish({ status: "oczekuje", cls: "A_cash", review: false, evidence: null });
  }
  return finish(null);
}

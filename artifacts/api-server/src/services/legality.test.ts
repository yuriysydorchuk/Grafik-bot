// Юніти движка легальності (звіт фази 0, §7.1 L1–L35). Чиста функція, без БД.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLegality, normalizeLegacyStatus, payrollClassOf, isUnder26At, daysBetween, addDaysStr, nationalityMatches,
  type LegalityDocument, type LegalityWorker, type LegalRuleInput, type LegalityInput,
} from "./legality.ts";
import { DOCUMENT_TYPE_SEED, LEGAL_RULE_SEED } from "./legalizationCatalog.ts";
import { normalizeProfileLegal, LEGAL_STATUSES } from "./svodni.ts";

const TODAY = "2026-09-02";
const rules = (over: Partial<Record<string, Partial<LegalRuleInput>>> = {}, drop: string[] = []): LegalRuleInput[] =>
  LEGAL_RULE_SEED.filter(r => !drop.includes(r.code)).map(r => ({
    code: r.code, kind: r.kind, axis: r.axis, conditions: r.conditions, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
    verifiedAt: r.verified ? "2026-09-02T00:00:00Z" : null, ...(over[r.code] ?? {}),
  }));

let nextId = 1;
const doc = (code: string, over: Partial<LegalityDocument> = {}): LegalityDocument => {
  const t = DOCUMENT_TYPE_SEED.find(x => x.code === code)!;
  return {
    id: nextId++, typeCode: t.code, category: t.category, status: "present", hasExpiry: t.hasExpiry,
    grantsStay: t.grantsStay, grantsWork: t.grantsWork, requiresEmployerMatch: t.requiresEmployerMatch,
    validFrom: null, expiresAt: null, renewalLeadDays: t.renewalLeadDays, appliesToNationalities: t.appliesToNationalities,
    employerCompanyId: null, caseStatus: null, submittedAt: null, verifiedAt: "2026-08-01T00:00:00Z", replacesDocumentId: null, ...over,
  };
};
const worker = (over: Partial<LegalityWorker> = {}): LegalityWorker => ({
  id: 1, nationality: "ukraine", birthDate: "1990-05-05", companyId: 1, employmentStartDate: "2026-01-10", employerSince: null,
  isStudent: false, legalStatus: null, notifyHours: null, ...over,
});
const run = (w: Partial<LegalityWorker>, docs: LegalityDocument[], extra: Partial<LegalityInput> = {}) =>
  computeLegality({ today: TODAY, worker: worker(w), documents: docs, rules: rules(), ...extra });
const has = (r: { reasons: { code: string }[] }, code: string) => r.reasons.some(x => x.code === code);

// ── хелпери ──
test("normalizeLegacyStatus дзеркалить svodni.normalizeProfileLegal", () => {
  for (const s of [...LEGAL_STATUSES, "student_do26", "student_po26", "do26", "oswiadczenie", "zezwolenie", "nieoformiony", "", null, "garbage"]) {
    assert.equal(normalizeLegacyStatus(s), normalizeProfileLegal(s), `розійшлись на "${s}"`);
  }
});
test("payrollClassOf: A=oczekuje, B=student, N=NULL, решта C", () => {
  assert.equal(payrollClassOf("oczekuje"), "A_cash"); assert.equal(payrollClassOf("nieoformiony"), "A_cash");
  assert.equal(payrollClassOf("student"), "B_student"); assert.equal(payrollClassOf("do26"), "B_student");
  assert.equal(payrollClassOf(null), "N_none"); assert.equal(payrollClassOf("garbage"), "N_none");
  for (const s of ["dyplom", "powiadomienie", "zus", "karta_pobytu", "staly_pobyt", "polak", "zezwolenie", "oswiadczenie"]) assert.equal(payrollClassOf(s), "C_registered", s);
});
test("дати: daysBetween/addDaysStr/isUnder26At (26-річчя вже НЕ до 26)", () => {
  assert.equal(daysBetween("2026-09-02", "2026-09-12"), 10);
  assert.equal(addDaysStr("2026-08-28", 7), "2026-09-04");
  assert.equal(isUnder26At("2000-09-02", "2026-09-02"), false);
  assert.equal(isUnder26At("2000-09-03", "2026-09-02"), true);
  assert.equal(isUnder26At(null, TODAY), null);
});
test("nationalityMatches: групи eu/ua/non_eu, невідома → null", () => {
  assert.equal(nationalityMatches(["eu"], "romania"), true);
  assert.equal(nationalityMatches(["eu"], "eu_other"), true);
  assert.equal(nationalityMatches(["non_eu"], "poland"), false);
  assert.equal(nationalityMatches(["ua"], "ukraine"), true);
  assert.equal(nationalityMatches(null, null), true);
  assert.equal(nationalityMatches(["ua"], null), null);
});

// ── L1–L3: громадянство ──
test("L1 PL без документів → legal/legal, підстава stay.pl_citizen, derived polak", () => {
  const r = run({ nationality: "poland" }, []);
  assert.equal(r.stay.status, "legal"); assert.equal(r.work.status, "legal");
  assert.equal(r.stay.basisRuleCode, "stay.pl_citizen");
  assert.equal(r.legacy.derivedLegalStatus, "polak");
  assert.equal(r.legacy.evidence?.kind, "nationality");
  assert.equal(r.legacy.legacyMismatchKind, "cross_class"); // ручне NULL (клас N) vs C
  assert.equal(r.legacy.legacyMappingRequiresReview, false);
});
test("L2 romania (EU) → legal/legal без документів", () => {
  const r = run({ nationality: "romania" }, []);
  assert.equal(r.overall, "legal");
});
test("L3 africa без документів → unknown/unknown, requiredMissing", () => {
  const r = run({ nationality: "africa" }, []);
  assert.equal(r.stay.status, "unknown"); assert.equal(r.work.status, "unknown");
  assert.deepEqual(r.requiredMissing, ["passport", "stay_basis", "work_basis"]);
  assert.equal(r.legacy.derivedLegalStatus, null);
  assert.equal(r.legacy.legacyMismatchKind, "no_proposal");
});

// ── L4–L7: UA, роботодавець ──
test("L4 UA + status_ukr + powiadomienie на нашу фірму → legal/legal, nextExpiry = глобальна дата UKR", () => {
  const r = run({ employmentStartDate: "2026-08-01" }, [
    doc("status_ukr"), doc("powiadomienie_ua", { employerCompanyId: 1, submittedAt: "2026-08-03" }),
  ]);
  assert.equal(r.stay.status, "legal"); assert.equal(r.stay.expiresAt, "2027-03-04");
  assert.equal(r.work.status, "legal");
  assert.equal(r.nextExpiry?.date, "2027-03-04");
  assert.equal(r.obligations[0]?.satisfied, true); assert.equal(r.obligations[0]?.overdue, false);
  assert.equal(r.legacy.derivedLegalStatus, "powiadomienie");
  assert.equal(r.reviewRequired, false);
});
test("L5 UA + oświadczenie на іншу фірму → work illegal employer_mismatch", () => {
  const r = run({ companyId: 1 }, [doc("status_ukr"), doc("oswiadczenie", { employerCompanyId: 2, expiresAt: "2027-12-31" })]);
  assert.equal(r.work.status, "illegal"); assert.ok(has(r.work, "employer_mismatch"));
  assert.equal(r.stay.status, "legal");
  assert.equal(r.legacy.derivedLegalStatus, null);
});
test("L6 oświadczenie без employer_company_id → work legal + reviewRequired employer_unknown", () => {
  const r = run({}, [doc("status_ukr"), doc("oswiadczenie", { employerCompanyId: null, expiresAt: "2027-12-31" })]);
  assert.equal(r.work.status, "legal"); assert.equal(r.reviewRequired, true); assert.ok(has(r, "employer_unknown"));
});
test("L7/L33 зміна company_id після видачі → mismatch; obligation від employerSince", () => {
  const r = run({ companyId: 2, employerSince: "2026-08-28" }, [doc("status_ukr"), doc("oswiadczenie", { employerCompanyId: 1, expiresAt: "2027-12-31" })]);
  assert.equal(r.work.status, "illegal"); assert.ok(has(r.work, "employer_mismatch"));
  assert.equal(r.obligations[0]?.dueAt, "2026-09-04"); assert.equal(r.obligations[0]?.overdue, false);
});

// ── L8–L9: строки ──
test("L8 student_cert спливає через 10 днів (lead 30) → work expiring", () => {
  const r = run({ nationality: "georgia" }, [doc("trc", { expiresAt: "2027-06-01" }), doc("student_cert", { expiresAt: addDaysStr(TODAY, 10) })]);
  assert.equal(r.work.status, "expiring"); assert.ok(has(r.work, "basis_expiring"));
  assert.equal(r.nextExpiry?.daysLeft, 10);
});
test("L9 student_cert прострочене, інших підстав нема → work illegal basis_expired; stay лишається legal", () => {
  const r = run({ nationality: "georgia" }, [doc("trc", { expiresAt: "2027-06-01" }), doc("student_cert", { expiresAt: "2026-08-01" })]);
  assert.equal(r.work.status, "illegal"); assert.ok(has(r.work, "basis_expired"));
  assert.equal(r.stay.status, "legal"); assert.equal(r.overall, "illegal");
});

// ── L10–L12: справи ──
test("L10 TRC чинна + справа на продовження → stay legal до дати TRC, потім pending", () => {
  const docs = [doc("trc", { expiresAt: "2026-12-31" }), doc("stay_case_certificate", { caseStatus: "submitted", submittedAt: "2026-08-15" })];
  const before = run({ nationality: "georgia" }, docs);
  assert.equal(before.stay.status, "legal"); assert.equal(before.stay.basisDocId, docs[0]!.id);
  const after = computeLegality({ today: "2027-01-15", worker: worker({ nationality: "georgia" }), documents: docs, rules: rules() });
  assert.equal(after.stay.status, "pending"); assert.equal(after.stay.basisDocId, docs[1]!.id);
});
test("L11 справа submitted, до подання не було work-підстави → work unknown + review work_during_case_uncertain", () => {
  const r = run({ nationality: "georgia" }, [doc("stay_case_certificate", { caseStatus: "submitted", submittedAt: "2026-08-15" })]);
  assert.equal(r.stay.status, "pending");
  assert.equal(r.work.status, "unknown"); assert.ok(has(r.work, "work_during_case_uncertain")); assert.equal(r.reviewRequired, true);
});
test("L11b справа submitted + oświadczenie, чинне на дату подання, нині прострочене → work pending", () => {
  const r = run({}, [
    doc("stay_case_certificate", { caseStatus: "submitted", submittedAt: "2026-08-15" }),
    doc("oswiadczenie", { employerCompanyId: 1, validFrom: "2024-09-01", expiresAt: "2026-08-31" }),
  ]);
  assert.equal(r.work.status, "pending"); assert.ok(has(r.work, "case_in_progress"));
});
test("L12 decision_negative при чинній TRC → TRC далі підстава", () => {
  const r = run({ nationality: "georgia" }, [doc("trc", { expiresAt: "2027-06-01" }), doc("trc", { caseStatus: "decision_negative", status: "pending", expiresAt: null })]);
  assert.equal(r.stay.status, "legal");
});

// ── L13–L16: evidence і правила ──
test("L13 pending-аплоуд без верифікації → НЕ підстава (D4); з unverifiedCountsAsBasis=true → legal + review", () => {
  const docs = [doc("status_ukr"), doc("powiadomienie_ua", { employerCompanyId: 1, status: "pending", verifiedAt: null })];
  const strict = run({}, docs);
  assert.equal(strict.work.status, "unknown"); assert.ok(has(strict, "evidence_unverified"));
  const lenient = computeLegality({ today: TODAY, worker: worker(), documents: docs, rules: rules({ "defaults.evidence": { conditions: { unverifiedCountsAsBasis: true } } }) });
  assert.equal(lenient.work.status, "legal"); assert.equal(lenient.reviewRequired, true);
});
test("L14 правило без verified_at → reviewRequired rule_unverified", () => {
  const r = computeLegality({ today: TODAY, worker: worker({ nationality: "romania" }), documents: [], rules: rules({ "stay.eu_citizen": { verifiedAt: null } }) });
  assert.equal(r.overall, "legal"); assert.equal(r.reviewRequired, true); assert.ok(has(r, "rule_unverified"));
});
test("L15 два чинних stay-документи → береться пізніший", () => {
  const docs = [doc("visa_d", { expiresAt: "2026-10-01" }), doc("trc", { expiresAt: "2027-06-01" })];
  const r = run({ nationality: "georgia" }, docs);
  assert.equal(r.stay.basisDocId, docs[1]!.id); assert.equal(r.stay.status, "legal");
});
test("L16b гуманітарні підстави: wiza humanitarna BY → stay+work legal без роботодавця; legacy без пропозиції + review", () => {
  const docs = [doc("humanitarian_visa", { validFrom: "2026-01-01", expiresAt: "2027-01-01" })];
  const r = run({ nationality: "belarus" }, docs);
  assert.equal(r.stay.status, "legal"); assert.equal(r.work.status, "legal"); assert.equal(r.work.basisDocId, docs[0]!.id);
  assert.equal(r.legacy.derivedLegalStatus, null); assert.equal(r.legacy.legacyMappingRequiresReview, true);
  const r2 = run({ nationality: "georgia" }, [doc("refugee_status", { expiresAt: "2028-01-01" })]);
  assert.equal(r2.overall, "legal");
  // wiza humanitarna — лише для громадян BY: для UA документ рахується, але з попередженням
  const r3 = run({ nationality: "ukraine" }, [doc("humanitarian_visa", { expiresAt: "2027-01-01" })]);
  assert.ok(has(r3, "doc_nationality_mismatch"));
});
test("L16 has_expiry тип без дати → legal + review expiry_missing", () => {
  const r = run({ nationality: "georgia" }, [doc("trc", { expiresAt: null })]);
  assert.equal(r.stay.status, "legal"); assert.ok(has(r, "expiry_missing")); assert.equal(r.reviewRequired, true);
});

// ── L17–L18: обов'язок powiadomienia ──
test("L17 UA, 13 днів без powiadomienia, hard:false → obligation overdue, лише warn + review", () => {
  const r = run({ employmentStartDate: "2026-08-20" }, [doc("status_ukr")]);
  assert.equal(r.obligations[0]?.overdue, true);
  assert.ok(has(r, "notification_overdue")); assert.equal(r.reasons.find(x => x.code === "notification_overdue")?.severity, "warn");
  assert.equal(r.work.status, "unknown"); assert.equal(r.reviewRequired, true);
});
test("L18 те саме, hard:true → work illegal (block)", () => {
  const r = computeLegality({
    today: TODAY, worker: worker({ employmentStartDate: "2026-08-20" }), documents: [doc("status_ukr")],
    rules: rules({ "obligation.ua_notification": { conditions: { nationalities: ["ua"], days: 7, docCode: "powiadomienie_ua", hard: true } } }),
  });
  assert.equal(r.work.status, "illegal"); assert.equal(r.reasons.find(x => x.code === "notification_overdue")?.severity, "block");
});
test("L17b працює на іншій підставі (dyplom) → прострочене powiadomienie лише інформаційне", () => {
  const r = run({ employmentStartDate: "2026-08-20" }, [doc("status_ukr"), doc("diploma")]);
  assert.equal(r.work.status, "legal");
});

// ── L19–L21 ──
test("L19 notify_hours 100, годин 120 → payrollHints, ніколи не блок", () => {
  const r = run({ notifyHours: 100 }, [doc("status_ukr")], { facts: { hoursThisMonth: 120 } });
  assert.equal(r.payrollHints.hoursExceedNotify, true); assert.equal(r.payrollHints.notifyHoursWithoutBasis, true);
  assert.notEqual(r.work.status, "illegal");
});
test("L20 overall = найгірший: stay legal + work unknown → unknown", () => {
  const r = run({}, [doc("status_ukr")]);
  assert.equal(r.stay.status, "legal"); assert.equal(r.work.status, "unknown"); assert.equal(r.overall, "unknown");
});
test("L21 межа: expiresAt === today → чинний (expiring, не illegal); завтра → illegal", () => {
  const docs = [doc("trc", { expiresAt: TODAY })];
  assert.equal(run({ nationality: "georgia" }, docs).stay.status, "expiring");
  assert.equal(computeLegality({ today: addDaysStr(TODAY, 1), worker: worker({ nationality: "georgia" }), documents: docs, rules: rules() }).stay.status, "illegal");
});

// ── L22–L32: legacy-адаптер ──
test("L22/L31 ручний zus + TRC → derived karta_pobytu, within_class", () => {
  const r = run({ nationality: "georgia", legalStatus: "zus" }, [doc("trc", { expiresAt: "2027-06-01" })]);
  assert.equal(r.legacy.derivedLegalStatus, "karta_pobytu"); assert.equal(r.legacy.legacyMismatchKind, "within_class");
  assert.equal(r.legacy.legacyMappingRequiresReview, false);
  assert.equal(r.payrollHints.workBasisMissing, true, "TRC без work-документа → підказка");
});
test("L23 ручний oczekuje + справа без підстави → derived oczekuje, kind none, review завжди", () => {
  const r = run({ nationality: "georgia", legalStatus: "oczekuje" }, [doc("stay_case_certificate", { caseStatus: "submitted", submittedAt: "2026-08-15" })]);
  assert.equal(r.legacy.derivedLegalStatus, "oczekuje"); assert.equal(r.legacy.legacyMismatchKind, "none");
  assert.equal(r.legacy.legacyMappingRequiresReview, true); assert.equal(r.legacy.derivedPayrollClass, "A_cash");
});
test("L24 правило з effective_to у минулому ігнорується", () => {
  const r = computeLegality({ today: TODAY, worker: worker({ nationality: "romania" }), documents: [], rules: rules({ "stay.eu_citizen": { effectiveTo: "2020-01-01" } }) });
  assert.equal(r.stay.status, "unknown");
});
test("L25 oświadczenie → powiadomienie (НЕ zus)", () => {
  const r = run({}, [doc("status_ukr"), doc("oswiadczenie", { employerCompanyId: 1, expiresAt: "2027-12-31" })]);
  assert.equal(r.legacy.derivedLegalStatus, "powiadomienie");
});
test("L26 zezwolenie_a → zus", () => {
  const r = run({ nationality: "georgia" }, [doc("trc", { expiresAt: "2027-06-01" }), doc("zezwolenie_a", { employerCompanyId: 1, expiresAt: "2027-06-01" })]);
  assert.equal(r.legacy.derivedLegalStatus, null, "TRC + zezwolenie_a — дві різні C-підстави → null");
  const only = run({ nationality: "georgia" }, [doc("zezwolenie_a", { employerCompanyId: 1, expiresAt: "2027-06-01" })]);
  assert.equal(only.legacy.derivedLegalStatus, "zus");
});
test("L27 rezydent_ue → null + review, клас C", () => {
  const r = run({ nationality: "georgia" }, [doc("rezydent_ue", { expiresAt: "2030-01-01" })]);
  assert.equal(r.overall, "legal");
  assert.equal(r.legacy.derivedLegalStatus, null); assert.equal(r.legacy.legacyMappingRequiresReview, true);
  assert.equal(r.legacy.derivedPayrollClass, "C_registered");
});
test("L28 лише status_ukr → null + review", () => {
  const r = run({}, [doc("status_ukr")]);
  assert.equal(r.legacy.derivedLegalStatus, null); assert.equal(r.legacy.legacyMappingRequiresReview, true);
});
test("L29 student_cert → student як пропозиція, review завжди, клас B", () => {
  const r = run({ nationality: "georgia", legalStatus: "zus" }, [doc("trc", { expiresAt: "2027-06-01" }), doc("student_cert", { expiresAt: "2027-02-28" })]);
  // TRC (karta_pobytu) + student_cert (student) — два кандидати різних класів → null + review
  assert.equal(r.legacy.derivedLegalStatus, null); assert.equal(r.legacy.legacyMappingRequiresReview, true);
  const only = run({ nationality: "georgia", legalStatus: "zus" }, [doc("student_cert", { expiresAt: "2027-02-28" })]);
  assert.equal(only.legacy.derivedLegalStatus, "student"); assert.equal(only.legacy.derivedPayrollClass, "B_student");
  assert.equal(only.legacy.legacyMappingRequiresReview, true); assert.equal(only.legacy.legacyMismatchKind, "cross_class");
});
test("L30 work pending без підстави, ручний zus → oczekuje, review, cross_class", () => {
  const r = run({ nationality: "georgia", legalStatus: "zus" }, [doc("stay_case_certificate", { caseStatus: "submitted", submittedAt: "2026-08-15" })]);
  assert.equal(r.legacy.derivedLegalStatus, "oczekuje"); assert.equal(r.legacy.legacyMismatchKind, "cross_class");
  assert.equal(r.legacy.legacyMappingRequiresReview, true);
});
test("L32 TRC + diploma (два C) → null; ручний zus → within_class, ручний NULL → no_proposal", () => {
  const docs = [doc("trc", { expiresAt: "2027-06-01" }), doc("diploma")];
  assert.equal(run({ nationality: "georgia", legalStatus: "zus" }, docs).legacy.legacyMismatchKind, "within_class");
  assert.equal(run({ nationality: "georgia", legalStatus: null }, docs).legacy.legacyMismatchKind, "no_proposal");
});

// ── L34–L35: кілька фірм ──
test("L34 present документи на дві наші фірми → employer_ambiguous + review, але не illegal", () => {
  const r = run({ companyId: 1 }, [
    doc("status_ukr"), doc("powiadomienie_ua", { employerCompanyId: 1 }), doc("powiadomienie_ua", { employerCompanyId: 2 }),
  ]);
  assert.equal(r.work.status, "legal"); assert.ok(has(r, "employer_ambiguous")); assert.equal(r.reviewRequired, true);
});
test("L35 employer-незалежна підстава (stały pobyt) не реагує на зміну фірми", () => {
  const r = run({ nationality: "georgia", companyId: 2, employerSince: "2026-08-28" }, [doc("karta_stalego_pobytu", { expiresAt: "2035-01-01" })]);
  assert.equal(r.stay.status, "legal"); assert.equal(r.work.status, "legal"); assert.equal(r.legacy.derivedLegalStatus, "staly_pobyt");
});
test("payrollHints.studentByProfile дзеркалить stud26Of; studentCertMissingOrExpired", () => {
  const r = run({ legalStatus: "student", birthDate: "2003-01-01" }, [doc("status_ukr")]);
  assert.equal(r.payrollHints.studentByProfile, true); assert.equal(r.payrollHints.studentCertMissingOrExpired, true);
  const old = run({ isStudent: true, birthDate: "1990-01-01" }, [doc("status_ukr"), doc("student_cert", { expiresAt: "2027-02-28" })]);
  assert.equal(old.payrollHints.studentByProfile, false); assert.equal(old.payrollHints.studentCertMissingOrExpired, false);
});
test("громадянство з паспорта: профіль порожній → info; профіль ≠ паспорт → nationality_conflict + review", () => {
  const fromPassport = run({ nationality: "poland" }, [], { facts: { passportNationality: "poland", nationalityFromPassport: true } });
  assert.equal(fromPassport.overall, "legal"); assert.ok(has(fromPassport, "nationality_from_passport")); assert.equal(fromPassport.reviewRequired, false);
  const conflict = run({ nationality: "ukraine" }, [doc("status_ukr")], { facts: { passportNationality: "poland" } });
  assert.ok(has(conflict, "nationality_conflict")); assert.equal(conflict.reviewRequired, true);
  assert.equal(conflict.stay.status, "legal", "рахуємо за профілем, не за паспортом — конфлікт лише підсвічуємо");
});

test("nationality невідома → причина + вимоги застосовуються; без жодного документа reviewRequired=false (немає даних ≠ потребує перевірки)", () => {
  const r = run({ nationality: null }, []);
  assert.ok(has(r, "nationality_unknown")); assert.equal(r.reviewRequired, false);
  assert.ok(r.requiredMissing.includes("stay_basis"));
  const withDoc = run({ nationality: null }, [doc("trc", { expiresAt: "2027-06-01" })]);
  assert.equal(withDoc.reviewRequired, true, "є документ → невідоме громадянство вже треба перевірити");
});

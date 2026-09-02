// Каталог сіду модуля легалізації — БЕЗ залежності від БД (використовують чисті
// юніт-тести движка і ensureDocumentType). TS-дзеркало
// deploy/migrations/2026-09-03-legalization-seed.sql: джерело правди для проду —
// SQL; при зміні одного — оновити друге (legalization.integration.test.ts звіряє
// коди з реальною БД).

export interface DocTypeSeed {
  code: string; name: string; required: boolean; hasExpiry: boolean; sortOrder: number; icon: string | null;
  category: "identity" | "stay" | "work" | "payroll" | "medical" | "other";
  grantsStay: boolean; grantsWork: boolean; requiresEmployerMatch: boolean;
  defaultValidityDays: number | null; renewalLeadDays: number | null; appliesToNationalities: string[] | null;
}
const T = (code: string, name: string, category: DocTypeSeed["category"], sortOrder: number, icon: string | null, o: Partial<DocTypeSeed> = {}): DocTypeSeed => ({
  code, name, category, sortOrder, icon, required: false, hasExpiry: false, grantsStay: false, grantsWork: false, requiresEmployerMatch: false,
  defaultValidityDays: null, renewalLeadDays: null, appliesToNationalities: null, ...o,
});

export const DOCUMENT_TYPE_SEED: DocTypeSeed[] = [
  T("passport", "Paszport", "identity", 10, "passport", { required: true, hasExpiry: true, renewalLeadDays: 90 }),
  T("id_card_pl", "Dowód osobisty (PL)", "identity", 20, "passport", { hasExpiry: true, renewalLeadDays: 90, appliesToNationalities: ["poland"] }),
  T("id_card_eu", "Dowód tożsamości UE/EOG", "identity", 30, "passport", { hasExpiry: true, renewalLeadDays: 90, appliesToNationalities: ["eu"] }),
  T("visa_d", "Wiza krajowa (D)", "stay", 100, "residence_card", { hasExpiry: true, grantsStay: true, renewalLeadDays: 30, appliesToNationalities: ["non_eu"] }),
  T("visa_c", "Wiza Schengen (C)", "stay", 110, "residence_card", { hasExpiry: true, grantsStay: true, renewalLeadDays: 14, appliesToNationalities: ["non_eu"] }),
  T("visa_free", "Ruch bezwizowy (data „do” wpisywana ręcznie)", "stay", 120, "residence_card", { hasExpiry: true, grantsStay: true, defaultValidityDays: 90, renewalLeadDays: 14, appliesToNationalities: ["non_eu"] }),
  T("trc", "Karta pobytu czasowego", "stay", 130, "residence_card", { hasExpiry: true, grantsStay: true, renewalLeadDays: 60, appliesToNationalities: ["non_eu"] }),
  T("zezwolenie_jednolite", "Zezwolenie jednolite na pobyt czasowy i pracę", "stay", 140, "decision", { hasExpiry: true, grantsStay: true, grantsWork: true, requiresEmployerMatch: true, renewalLeadDays: 60, appliesToNationalities: ["non_eu"] }),
  T("karta_stalego_pobytu", "Karta stałego pobytu", "stay", 150, "residence_card", { hasExpiry: true, grantsStay: true, grantsWork: true, renewalLeadDays: 90, appliesToNationalities: ["non_eu"] }),
  T("rezydent_ue", "Karta rezydenta długoterminowego UE", "stay", 160, "residence_card", { hasExpiry: true, grantsStay: true, grantsWork: true, renewalLeadDays: 90, appliesToNationalities: ["non_eu"] }),
  T("stay_case_certificate", "Zaświadczenie o złożeniu wniosku (dawniej stempel)", "stay", 170, "decision", { appliesToNationalities: ["non_eu"] }),
  T("status_ukr", "Status UKR (PESEL UKR, specustawa)", "stay", 180, "residence_card", { grantsStay: true, renewalLeadDays: 90, appliesToNationalities: ["ua"] }),
  T("karta_polaka", "Karta Polaka", "work", 190, "karta_polaka", { hasExpiry: true, grantsWork: true, renewalLeadDays: 90, appliesToNationalities: ["non_eu"] }),
  T("oswiadczenie", "Oświadczenie o powierzeniu wykonywania pracy", "work", 200, "permit", { hasExpiry: true, grantsWork: true, requiresEmployerMatch: true, defaultValidityDays: 730, renewalLeadDays: 30, appliesToNationalities: ["ukraine", "belarus", "moldova"] }),
  T("zezwolenie_a", "Zezwolenie na pracę typ A", "work", 210, "permit", { hasExpiry: true, grantsWork: true, requiresEmployerMatch: true, renewalLeadDays: 60, appliesToNationalities: ["non_eu"] }),
  T("powiadomienie_ua", "Powiadomienie o powierzeniu pracy obywatelowi UA", "work", 220, "notification", { grantsWork: true, requiresEmployerMatch: true, appliesToNationalities: ["ua"] }),
  T("student_cert", "Zaświadczenie studenta (studia stacjonarne)", "work", 230, "student", { hasExpiry: true, grantsWork: true, renewalLeadDays: 30 }),
  T("diploma", "Dyplom ukończenia studiów stacjonarnych w PL", "work", 240, "student", { grantsWork: true }),
  T("umowa_zlecenie", "Umowa zlecenie", "payroll", 300, "contract", { hasExpiry: true, renewalLeadDays: 30 }),
  T("oswiadczenie_podatkowe", "Oświadczenie do celów podatkowych (PIT-2 / do 26)", "payroll", 310, "contract"),
  T("medical_exam", "Badania lekarskie", "medical", 400, "medical", { hasExpiry: true, renewalLeadDays: 30 }),
  T("sanepid", "Książeczka sanepidowska", "medical", 410, "medical", { hasExpiry: true, renewalLeadDays: 30 }),
  T("bhp", "Szkolenie BHP", "medical", 420, "medical"),
  T("other", "Inny dokument", "other", 900, null),
];

export interface LegalRuleSeed {
  code: string; kind: string; axis: "stay" | "work" | "both" | null; conditions: Record<string, unknown>;
  effectiveFrom: string; effectiveTo: string | null; source: string | null; verified: boolean; note: string | null;
}
export const LEGAL_RULE_SEED: LegalRuleSeed[] = [
  { code: "stay.pl_citizen", kind: "basis_by_nationality", axis: "both", conditions: { nationalities: ["poland"] }, effectiveFrom: "2000-01-01", effectiveTo: null, source: "Obywatelstwo PL", verified: true, note: null },
  { code: "stay.eu_citizen", kind: "basis_by_nationality", axis: "both", conditions: { nationalities: ["eu"] }, effectiveFrom: "2004-05-01", effectiveTo: null, source: "psz.praca.gov.pl praca-bez-zezwolenia", verified: true, note: null },
  { code: "global.ukr_status_end", kind: "global", axis: "stay", conditions: { date: "2027-03-04" }, effectiveFrom: "2026-03-05", effectiveTo: null, source: "Ustawa z 23.01.2026", verified: true, note: null },
  { code: "obligation.ua_notification", kind: "obligation", axis: "work", conditions: { nationalities: ["ua"], days: 7, docCode: "powiadomienie_ua", hard: false }, effectiveFrom: "2025-06-01", effectiveTo: null, source: "zielonalinia.gov.pl", verified: true, note: null },
  { code: "precedence.work_during_case", kind: "precedence", axis: "work", conditions: { requiresPriorWorkBasis: true }, effectiveFrom: "2000-01-01", effectiveTo: null, source: "biznes.gov.pl/pl/portal/004330", verified: true, note: null },
  { code: "requirement.identity", kind: "requirement", axis: null, conditions: { category: "identity", anyOf: ["passport", "id_card_pl", "id_card_eu"] }, effectiveFrom: "2000-01-01", effectiveTo: null, source: null, verified: true, note: null },
  { code: "requirement.stay_non_eu", kind: "requirement", axis: "stay", conditions: { nationalities: ["non_eu"], category: "stay" }, effectiveFrom: "2000-01-01", effectiveTo: null, source: null, verified: true, note: null },
  { code: "requirement.work_non_eu", kind: "requirement", axis: "work", conditions: { nationalities: ["non_eu"], category: "work" }, effectiveFrom: "2000-01-01", effectiveTo: null, source: null, verified: true, note: null },
  { code: "defaults.lead_days", kind: "global", axis: null, conditions: { documents: [60, 30, 14, 7, 0], cases: 30, ukr: [90, 30], defaultLeadDays: 30 }, effectiveFrom: "2026-09-02", effectiveTo: null, source: "Рішення власника D8", verified: true, note: null },
  { code: "defaults.evidence", kind: "global", axis: null, conditions: { unverifiedCountsAsBasis: false }, effectiveFrom: "2026-09-02", effectiveTo: null, source: "Рішення власника D4", verified: true, note: null },
];

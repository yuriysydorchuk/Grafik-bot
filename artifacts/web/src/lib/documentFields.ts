// Типоспецифічні поля документів працівника (профіль → «Документи»). Кожен тип
// каталогу легалізації (document_types.code, services/legalizationCatalog.ts)
// має власний набір полів модалки замість одного спільного блоку «Легалізація»
// (відгук власника 03.09.2026: «у кожного документа свої специфічні дані»).
import type { DocumentType } from "./api";

export type DocFieldKey =
  | "number" | "validFrom" | "expiresAt" | "issuedAt" | "issuer"
  | "employerCompanyId" | "caseStatus" | "submittedAt" | "caseNumber" | "decisionAt"
  | "laborMarketAccess";

export interface DocField {
  key: DocFieldKey;
  label: string;
  required?: boolean;
  kind: "text" | "date" | "company" | "caseStatus" | "boolean";
  hint?: string;
  // "ukrEnd" — значення читається з LegalizationGlobals.ukrStatusEnd, поле read-only й НЕ шлеться на сервер;
  // "plus730" — якщо порожнє, підставляється validFrom + 730 днів при зміні validFrom (oświadczenie).
  auto?: "ukrEnd" | "plus730";
}

const F = (key: DocFieldKey, label: string, kind: DocField["kind"], o: Partial<DocField> = {}): DocField => ({ key, label, kind, ...o });

// код типу → поля модалки, у порядку показу. Дзеркалить DOCUMENT_TYPE_SEED
// (services/legalizationCatalog.ts) — лише ті коди, де є специфічні поля.
export const DOC_FIELD_SPEC: Record<string, DocField[]> = {
  passport: [
    F("number", "Номер паспорта", "text", { required: true }),
    F("expiresAt", "Дійсний до", "date", { required: true }),
    F("issuedAt", "Дата видачі", "date"),
    F("issuer", "Країна видачі", "text"),
  ],
  id_card_pl: [
    F("number", "Номер", "text", { required: true }),
    F("expiresAt", "Дійсний до", "date", { required: true }),
  ],
  id_card_eu: [
    F("number", "Номер", "text", { required: true }),
    F("expiresAt", "Дійсний до", "date", { required: true }),
  ],
  visa_d: [
    F("number", "Номер", "text"),
    F("validFrom", "Від", "date", { required: true }),
    F("expiresAt", "До", "date", { required: true }),
    F("issuer", "Консульство", "text"),
  ],
  visa_c: [
    F("number", "Номер", "text"),
    F("validFrom", "Від", "date", { required: true }),
    F("expiresAt", "До", "date", { required: true }),
    F("issuer", "Консульство", "text"),
  ],
  visa_free: [
    F("validFrom", "В'їзд", "date"),
    F("expiresAt", "До (90/180)", "date", { required: true }),
  ],
  trc: [
    F("number", "Номер карти", "text", { required: true }),
    F("expiresAt", "Дійсна до", "date", { required: true }),
    F("laborMarketAccess", "Z dostępem do rynku pracy — дає й право на працю", "boolean"),
  ],
  zezwolenie_jednolite: [
    F("number", "Номер", "text", { required: true }),
    F("employerCompanyId", "Роботодавець", "company", { required: true }),
    F("validFrom", "Чинний з", "date"),
    F("expiresAt", "Дійсний до", "date", { required: true }),
  ],
  karta_stalego_pobytu: [
    F("number", "Номер", "text", { required: true }),
    F("expiresAt", "Карта дійсна до", "date", { required: true }),
  ],
  rezydent_ue: [
    F("number", "Номер", "text", { required: true }),
    F("expiresAt", "Карта дійсна до", "date", { required: true }),
  ],
  stay_case_certificate: [
    F("submittedAt", "Подано", "date", { required: true }),
    F("caseStatus", "Статус справи", "caseStatus", { required: true }),
    F("caseNumber", "№ справи", "text"),
    F("issuer", "Urząd Wojewódzki", "text"),
    F("decisionAt", "Рішення", "date"),
  ],
  status_ukr: [
    F("number", "PESEL UKR", "text", { required: true }),
    F("expiresAt", "Дійсний до", "date", { auto: "ukrEnd", hint: "дата з правила global.ukr_status_end" }),
  ],
  karta_polaka: [
    F("number", "Номер", "text", { required: true }),
    F("expiresAt", "Дійсний до", "date", { required: true }),
  ],
  oswiadczenie: [
    F("number", "Номер oświadczenia", "text", { required: true }),
    F("employerCompanyId", "Роботодавець", "company", { required: true }),
    F("validFrom", "Від", "date", { required: true }),
    F("expiresAt", "До", "date", { required: true, auto: "plus730" }),
    F("issuer", "PUP", "text", { required: true }),
  ],
  zezwolenie_a: [
    F("number", "Номер", "text", { required: true }),
    F("employerCompanyId", "Роботодавець", "company", { required: true }),
    F("validFrom", "Чинний з", "date", { required: true }),
    F("expiresAt", "Дійсний до", "date", { required: true }),
    F("issuer", "Wojewoda", "text"),
  ],
  powiadomienie_ua: [
    F("employerCompanyId", "Роботодавець", "company", { required: true }),
    F("validFrom", "Праця від", "date", { required: true }),
    F("expiresAt", "Праця до", "date"),
    F("submittedAt", "Подано на praca.gov.pl", "date", { required: true }),
    F("number", "№ повідомлення", "text"),
  ],
  student_cert: [
    F("issuer", "Навчальний заклад", "text", { required: true }),
    F("validFrom", "З", "date"),
    F("expiresAt", "До (кінець семестру)", "date", { required: true }),
  ],
  diploma: [
    F("issuer", "Навчальний заклад", "text", { required: true }),
    F("issuedAt", "Дата видачі", "date"),
  ],
  medical_exam: [
    F("issuedAt", "Дата badań", "date", { required: true }),
    F("expiresAt", "Дійсні до", "date", { required: true }),
  ],
  sanepid: [
    F("expiresAt", "Дійсна до", "date", { required: true }),
  ],
  bhp: [
    F("issuedAt", "Дата шкільонного", "date", { required: true }),
  ],
  other: [
    F("number", "Номер", "text"),
    F("expiresAt", "Дійсний до", "date"),
  ],
};

// Дефолт для кастомних типів (без code або невідомий у каталозі).
const DEFAULT_FIELDS: DocField[] = [
  F("number", "Номер", "text"),
  F("issuer", "Видав", "text"),
  F("expiresAt", "Дійсний до", "date"),
];

export function fieldsFor(type: DocumentType | null): DocField[] {
  if (!type?.code) return DEFAULT_FIELDS;
  return DOC_FIELD_SPEC[type.code] ?? DEFAULT_FIELDS;
}

// ── Громадянство ↔ тип документа ────────────────────────────────────────────
// document_types.applies_to_nationalities містить або прямі коди країн
// (lib/nationality.tsx), або групи ua/eu/non_eu (як у services/legalizationCatalog.ts
// та lib/legality.ts NAT_GROUP_LABEL). EU-група — рішення 02.09.2026: poland|romania|eu_other.
const EU_NATIONALITIES = new Set(["poland", "romania", "eu_other"]);

export const isEuNationality = (nationality?: string | null): boolean => !!nationality && EU_NATIONALITIES.has(nationality);

function matchesGroup(nationality: string | null | undefined, group: string): boolean {
  if (group === "eu") return isEuNationality(nationality);
  if (group === "ua") return nationality === "ukraine";
  if (group === "non_eu") return !!nationality && !isEuNationality(nationality);
  return nationality === group; // прямий код країни
}

// Чи підходить тип документа громадянству працівника. null nationality або
// порожній appliesToNationalities → підходить усім.
export function typeMatchesNationality(type: DocumentType, nationality: string | null | undefined): boolean {
  if (!nationality) return true;
  if (!type.appliesToNationalities?.length) return true;
  return type.appliesToNationalities.some(g => matchesGroup(nationality, g));
}

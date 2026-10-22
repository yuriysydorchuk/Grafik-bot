/**
 * Журнал змін анкети (20.10.2026, власник: «щоб можна було міняти анкету, але щоб історія
 * зберігалася — хто міняв і з чого на що»). Кожна зміна поля анкети — рядок worker_changes
 * з полем `q.<ключ>` (ключ = поле workerQuestionnairesTable; ім'я/по-батькові/прізвище, що
 * правляться з анкети, — теж під префіксом). adminId NULL = зробив сам працівник (лінк анкети).
 *
 * Префікс `q.` тримає записи ПОЗА сводною: ревʼю розлоку й «застарілий лок» їх пропускають
 * (svodni.ts), «Видалити зміну» не відкочує (анкета правиться в анкеті), а історія профілю
 * віддає їх лише з cap workerDocs — значення тут персональні (паспорт, IBAN, адреси).
 */
import { db, workerChangesTable } from "@workspace/db";
import { logger } from "../lib/logger";

export const Q_PREFIX = "q.";
export const isQuestionnaireField = (field: string): boolean => field.startsWith(Q_PREFIX);

// Поля, які журналяться (технічні — updatedAt/submittedAt/ocrRaw/consents* — ні)
const JOURNALED = new Set([
  "status", "payoutMethod",
  "firstName", "middleName", "lastName",
  "passportNumber", "passportCountry", "passportIssuedAt", "passportExpiresAt", "birthPlace", "sex", "citizenship",
  "addressRegistered", "addressPl", "postalCode", "city", "motherName", "fatherName", "bankName", "bankIban",
  "phone", "email", "taxOffice", "nfzBranch", "schoolName", "seriaINumerDowodu",
  "emergencyContact", "otherEmploymentNote", "nip", "taxOfficeAddress",
  "regWojewodztwo", "regPowiat", "regGmina", "regMiejscowosc", "regUlica", "regNumerDomu", "regKodPocztowy",
  "zamWojewodztwo", "zamPowiat", "zamGmina", "zamMiejscowosc", "zamUlica", "zamNumerDomu", "zamKodPocztowy",
]);
// bool-колонки анкети NOT NULL default false: null (рядка ще не було) ≡ false
const BOOLS = new Set([
  "isStudent", "hasOtherEmployment", "isRegisteredUnemployed", "waivesTaxAdvance", "pit0",
  "ankietaInnyPracodawca", "ankietaEmeryt", "ankietaRencista", "ankietaNiepelnosprawnosc", "ankietaSkladkaChorobowa",
]);

const norm = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
};

/**
 * Пише в журнал поля `patch`, що відрізняються від `before`. `onlyOverwrites` — лише заміна
 * вже наявного значення (перше заповнення анкети працівником чи OCR-чернетка — не «зміна»,
 * інакше одна подача анкети давала б ~40 рядків історії).
 */
export async function journalQuestionnaire(
  workerId: number, before: Record<string, unknown> | null | undefined, patch: Record<string, unknown>,
  adminId: number | null, opts: { onlyOverwrites?: boolean } = {},
): Promise<void> {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  const rows = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(JOURNALED.has(k) || BOOLS.has(k)) || v === undefined) continue;
    const bool = BOOLS.has(k);
    const oldV = bool ? String(!!before?.[k]) : norm(before?.[k]);
    const newV = bool ? String(!!v) : norm(v);
    if (oldV === newV) continue;
    // галочка до першої подачі, що досі false, — дефолт (рядок створює крок скану), не вписана
    // людиною; true до подачі поставив офіс — його зняття працівником журналимо
    if (opts.onlyOverwrites && (bool ? !before?.submittedAt && !before?.[k] : oldV == null)) continue;
    rows.push({ workerId, field: `${Q_PREFIX}${k}`, oldValue: oldV, newValue: newV, effectiveDate: today, adminId });
  }
  if (!rows.length) return;
  await db.insert(workerChangesTable).values(rows)
    .catch(err => logger.error({ err, workerId }, "questionnaire journal failed"));
}

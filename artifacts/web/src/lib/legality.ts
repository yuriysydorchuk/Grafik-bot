// Легалізація за документами — спільні лейбли/кольори для профілю, /workers,
// /legalization і дашборду. Усі рядки — укр-ключі для t(); класи Tailwind —
// літерали (v4 не бачить динамічних). Кольори за рішенням фази 0: rose = illegal,
// amber = unknown, yellow = expiring, green = legal, blue = pending.
import type { LegalityStatus, LegalityReason, CaseStatus, DocCategory } from "./api";

export const LEGALITY_STATUSES: LegalityStatus[] = ["legal", "pending", "expiring", "illegal", "unknown"];

export const LEGALITY_LABEL: Record<LegalityStatus, string> = {
  legal: "Легально", pending: "Справа в toku", expiring: "Спливає", illegal: "Без підстави", unknown: "Немає даних",
};
// бейдж: фон/текст/кільце (світлий + темна тема через CSS-змінні палітри)
export const LEGALITY_BADGE: Record<LegalityStatus, string> = {
  legal: "bg-green-100 text-green-700 ring-green-200",
  pending: "bg-blue-100 text-blue-700 ring-blue-200",
  expiring: "bg-yellow-100 text-yellow-700 ring-yellow-200",
  illegal: "bg-rose-100 text-rose-700 ring-rose-200",
  unknown: "bg-amber-100 text-amber-700 ring-amber-200",
};
// крапка-світлофор
export const LEGALITY_DOT: Record<LegalityStatus, string> = {
  legal: "bg-green-500", pending: "bg-blue-500", expiring: "bg-yellow-500", illegal: "bg-rose-500", unknown: "bg-amber-500",
};
// підсвітка рядка таблиці
export const LEGALITY_ROW: Record<LegalityStatus, string> = {
  legal: "", pending: "bg-blue-50", expiring: "bg-yellow-50", illegal: "bg-rose-50", unknown: "bg-amber-50",
};

export const AXIS_LABEL = { stay: "Перебування", work: "Праця", contract: "Умова", overall: "Загалом" } as const;

// Статус справи (stay_case_certificate). Для движка легальності є лише два стани:
// справа ВІДКРИТА (submitted, in_progress → дає право на перебування) і ЗАКРИТА (решта →
// права не дає). Пари «Подано/Розглядається» і «Відмова/Відкликано» — інформаційні
// відтінки одного стану; підказки нижче кажуть це людині прямо (запит власника 10.09.2026).
export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  to_submit: "Ще не подано", submitted: "Подано", in_progress: "Розглядається",
  decision_positive: "Позитивне рішення", decision_negative: "Відмова", withdrawn: "Відкликано",
};
export const CASE_STATUS_HINT: Record<CaseStatus, string> = {
  to_submit: "права на перебування не дає",
  submitted: "дає право на перебування, поки триває розгляд (те саме, що «Розглядається»)",
  in_progress: "дає право на перебування, поки триває розгляд (те саме, що «Подано»)",
  decision_positive: "справа закрита; отриману карту додайте окремим документом",
  decision_negative: "справа закрита, права не дає (те саме, що «Відкликано»)",
  withdrawn: "справа закрита, права не дає (те саме, що «Відмова»)",
};

export const DOC_CATEGORY_LABEL: Record<DocCategory, string> = {
  identity: "Посвідчення особи", stay: "Перебування", work: "Праця", payroll: "Кадри/ЗП", medical: "Медичні", other: "Інше",
};

export const NAT_GROUP_LABEL: Record<string, string> = { ua: "Громадяни України", eu: "ЄС/ЄЕЗ", non_eu: "Поза ЄС" };

export const MISMATCH_LABEL: Record<string, string> = {
  none: "збігається", within_class: "збігається за класом (гроші без змін)", cross_class: "змінить listę płac", no_proposal: "немає пропозиції",
};

export const REQUIRED_MISSING_LABEL: Record<string, string> = {
  passport: "документ, що підтверджує особу (паспорт або ID)", stay_basis: "документ на право перебування", work_basis: "документ на право працювати",
};

// Причини движка → людською мовою. {param} підставляються з reason.params.
export const REASON_LABEL: Record<string, string> = {
  nationality_unknown: "Не вказано громадянство — вимоги застосовано як для не-ЄС",
  nationality_from_passport: "Громадянство взято з паспорта (анкета): {nationality} — у профілі поле порожнє",
  nationality_conflict: "Громадянство в профілі ({profile}) не збігається з паспортом ({passport})",
  rule_unverified: "Правило {rule} ще не підтверджене — результат потребує перевірки",
  evidence_unverified: "Документ надіслано працівником, офіс ще не перевірив — підставою не рахується",
  employer_mismatch: "Документ видано на іншу фірму, ніж роботодавець працівника",
  employer_unknown: "Не вказано, на яку фірму видано документ",
  employer_ambiguous: "Документи на різні фірми одночасно — незрозуміло, яка umowa діє",
  not_yet_valid: "Документ ще не набув чинності (з {validFrom})",
  expiry_missing: "У документа зі строком не вказано дату закінчення",
  doc_nationality_mismatch: "Тип документа не відповідає громадянству",
  basis_expiring: "Документ, що дає це право, спливає {expiresAt} (за {daysLeft} дн.)",
  basis_expired: "Документ, що давав це право, прострочений ({expiresAt}), іншого чинного немає",
  case_in_progress: "Справу подано ({submittedAt}), чекаємо рішення — право на перебування є",
  work_during_case_uncertain: "Справу подано, але до подання не було права працювати — працювати під час розгляду можна не напевно",
  no_basis: "Немає документа, який дає це право",
  employment_start_unknown: "Не вказано дату початку праці — строк повідомлення не рахується",
  notification_overdue: "Прострочено повідомлення про працю (термін {dueAt})",
  notification_late: "Повідомлення подано із запізненням (термін {dueAt}, подано {submittedAt})",
  // вісь «умова»
  contract_missing: "Немає чинної умови на {factory}",
  contract_expired: "Умова на {factory} закінчилась {expiresAt}",
  contract_expiring: "Умова на {factory} спливає {expiresAt} (за {daysLeft} дн.)",
  contract_awaiting_company: "Умову на {factory} підписав працівник, чекає підпису компанії",
  contract_wrong_company: "Умова на {factory} від іншої нашої фірми — роботодавець там {company}",
  no_factory: "У профілі немає фабрики — без фабрики посади не буває (для офісу — фабрика «Biuro»)",
  schedule_outside_factories: "Зміни в графіку на {factory}, якої немає в списку фабрик працівника",
  work_basis_missing_for_company: "Немає документа на право працювати для фірми {company} (документ на цю фірму або документ, що не привʼязаний до фірми)",
  main_company_not_employer: "Фірма в профілі не збігається з жодним роботодавцем зі списку фабрик",
};

export function reasonText(t: (s: string, p?: Record<string, string | number>) => string, r: LegalityReason): string {
  const tpl = REASON_LABEL[r.code] ?? r.code;
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(r.params ?? {})) params[k] = v == null ? "—" : Array.isArray(v) ? v.join(", ") : String(v);
  return t(tpl, params);
}

export const daysUntil = (date: string | null | undefined, today = new Date().toLocaleDateString("sv-SE")): number | null => {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number); const [ty, tm, td] = today.split("-").map(Number);
  return Math.round((Date.UTC(y!, m! - 1, d!) - Date.UTC(ty!, tm! - 1, td!)) / 86400000);
};

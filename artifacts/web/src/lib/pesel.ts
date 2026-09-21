// Звірка даних профілю з PESEL (рішення власника 21.09.2026): PESEL кодує дату
// народження і стать, тож він — арбітр між профілем/анкетою і зовнішніми джерелами
// (HRappka, nexo). Кожен рядок профілю, що не збігається з PESEL, підсвічується
// червоно з підказкою «за PESEL: …». Самі формули — у questionnaireRules.ts
// (побайтова копія серверного файлу, там і тести).
import { peselBirthDate, peselChecksumOk, peselSex } from "./questionnaireRules";

export type PeselCheck = {
  present: boolean;          // PESEL є (11 цифр)
  invalid: boolean;          // контрольна сума не сходиться — решту не порівнюємо
  birthDate: string | null;  // YYYY-MM-DD з PESEL
  sex: "M" | "F" | null;
  birthMismatch: boolean;    // профільна дата є і відрізняється
  genderMismatch: boolean;   // профільна стать є і відрізняється
};

// gender приймає обидві нотації: профіль (male|female) і анкета (M|F)
export function normalizeSex(g: string | null | undefined): "M" | "F" | null {
  if (!g) return null;
  const s = g.toUpperCase();
  return s === "M" || s === "MALE" ? "M" : s === "F" || s === "FEMALE" ? "F" : null;
}

export function peselCheck(pesel: string | null | undefined, birthDate: string | null | undefined, gender: string | null | undefined): PeselCheck {
  const p = (pesel ?? "").replace(/\s/g, "");
  const present = /^\d{11}$/.test(p);
  if (!present) return { present: false, invalid: false, birthDate: null, sex: null, birthMismatch: false, genderMismatch: false };
  const invalid = !peselChecksumOk(p);
  const bd = invalid ? null : peselBirthDate(p);
  const sx = invalid ? null : peselSex(p);
  const g = normalizeSex(gender);
  return {
    present, invalid, birthDate: bd, sex: sx,
    birthMismatch: !!bd && !!birthDate && bd !== birthDate,
    genderMismatch: !!sx && !!g && sx !== g,
  };
}

export const fmtPeselDate = (iso: string | null): string => (iso ? new Date(iso + "T00:00:00").toLocaleDateString("uk-UA") : "");

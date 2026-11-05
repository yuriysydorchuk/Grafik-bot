// Довідник KZiS (коди zawodów для поля 3.3 форми PSZ-PPWPU) — зголошення #26, 05.11.2026.
// Раніше сервер перевіряв лише «6 цифр»: помилка в одній цифрі давала неіснуючий або чужий zawód,
// і це спливало вже на praca.gov.pl. Тепер новий код мусить бути з чинної класифікації (lib/kzisData.ts).
// Уже збережені коди старої класифікації не блокуємо: перевіряється лише ЗМІНЕНЕ значення.
import { KZIS_CODES, KZIS_VERSION } from "./kzisData";

const BY_CODE = new Map<string, string>(KZIS_CODES.map(([c, n]) => [c, n]));
export const kzisName = (code: string | null | undefined): string | null => (code ? BY_CODE.get(code) ?? null : null);
export const isKzisCode = (code: string): boolean => BY_CODE.has(code);
export { KZIS_CODES, KZIS_VERSION };

/**
 * Нормалізація й перевірка коду з форми: порожньо → null; не 6 цифр або нема в класифікації → Error
 * (текст для 400). `current` — значення, що вже лежить у БД: його дозволено «зберегти ще раз» без перевірки
 * (форма шле всі поля; код старої класифікації не має блокувати збереження сусідніх полів).
 */
export function parseKzis(value: unknown, current?: string | null): string | null {
  const k = String(value ?? "").trim();
  if (!k) return null;
  if (!/^\d{6}$/.test(k)) throw new Error("Код KZiS — рівно 6 цифр");
  if (k !== (current ?? null) && !isKzisCode(k)) throw new Error(`Коду ${k} немає в класифікації zawodów KZiS ${KZIS_VERSION} — виберіть код з довідника`);
  return k;
}

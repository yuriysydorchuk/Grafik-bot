import { db, workersTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { randomInviteCode } from "./invite";

// Реферальний код «приведи друга» (17.09.2026): ES-XXXXX — 5 символів Crockford base32
// (без I/L/O/U, читається по телефону), ~33 млн комбінацій — чужий код не вгадати,
// на відміну від порядкового worker_code (бонус пішов би не тому). Це НЕ секрет
// привʼязки (invite_code): його пишуть у повідомленнях і називають уголос в офісі.
export const REFERRAL_PREFIX = "ES-";

export const randomReferralCode = (): string => REFERRAL_PREFIX + randomInviteCode(5);

// Нормалізація введеного вручну коду (по телефону/в офісі/у deep-link): пробіли,
// регістр, з префіксом чи без. Порожній рядок = не код.
export function normalizeReferralCode(raw: string): string {
  let s = raw.toUpperCase().replace(/[\s_]/g, "");
  // Префікс знімаємо лише як префікс: «ES-…» завжди, голе «ES…» — тільки коли решта має
  // довжину коду (5, або 8 у фолбеку). Інакше код ES-ES123, введений як «ES123», втратив би «ES».
  if (s.startsWith("ES-")) s = s.slice(3);
  else if (s.startsWith("ES") && (s.length === 7 || s.length === 10)) s = s.slice(2);
  return s ? REFERRAL_PREFIX + s : "";
}

// Наявний код або новий унікальний. Видача лінива, бо профілі створюються в багатьох
// місцях (веб, бот-реєстрація, скан паспорта, імпорт годин, Sheets-синк).
export async function ensureReferralCode(workerId: number): Promise<string> {
  const [w] = await db.select({ code: workersTable.referralCode }).from(workersTable).where(eq(workersTable.id, workerId));
  if (w?.code) return w.code;
  let code: string | undefined;
  for (let i = 0; i < 50 && !code; i++) {
    const c = randomReferralCode();
    if ((await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.referralCode, c))).length === 0) code = c;
  }
  code = code ?? REFERRAL_PREFIX + randomInviteCode(8);
  // Пишемо лише якщо код досі порожній і перечитуємо: два паралельні виклики (дабл-тап у боті)
  // інакше видали б різні коди, і перший з них став би недійсним.
  await db.update(workersTable).set({ referralCode: code })
    .where(and(eq(workersTable.id, workerId), isNull(workersTable.referralCode)));
  const [after] = await db.select({ code: workersTable.referralCode }).from(workersTable).where(eq(workersTable.id, workerId));
  return after?.code ?? code;
}

// Deep-link ?start=ref<код>. Telegram допускає в start лише [A-Za-z0-9_-] (до 64 симв.) — «ES-» проходить.
export function referralLink(code: string, botUsername?: string): string {
  const username = botUsername || process.env.TELEGRAM_BOT_USERNAME || "";
  return username ? `https://t.me/${username}?start=ref${code}` : `?start=ref${code}`;
}

export async function findWorkerByReferralCode(raw: string) {
  const code = normalizeReferralCode(raw);
  if (!code) return undefined;
  return (await db.select().from(workersTable).where(eq(workersTable.referralCode, code)))[0];
}

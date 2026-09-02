// Автопереклад тіла шаблону (§2.2 плану worker-docs-signing): PL — канонічна
// мова бібліотеки, при зміні PL-тексту решта мов (en/es/ru/uk) перегенеровуються
// через Google Cloud Translation API (той самий сервісний ключ і GCP-проєкт,
// що вже під Document AI — лише додатково увімкнена Translation API). Мова,
// позначена вручну відредагованою (langIsManual), автоперекладом НЕ чіпається.
import { google } from "googleapis";
import crypto from "node:crypto";
import { logger } from "../lib/logger";

export const translateConfigured = (): boolean => !!process.env.GOOGLE_DOCAI_KEY_FILE;

export const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

// {%Плейсхолдер%} підміняється нейтральним токеном перед перекладом і
// повертається назад незмінним — інакше перекладач намагається перекласти
// польські слова всередині назви плейсхолдера.
const PLACEHOLDER_RE = /\{%[^%]+%\}/g;
function protect(html: string): { protected: string; tokens: string[] } {
  const tokens: string[] = [];
  const protectedHtml = html.replace(PLACEHOLDER_RE, m => {
    tokens.push(m);
    return `<span translate="no">§${tokens.length - 1}§</span>`;
  });
  return { protected: protectedHtml, tokens };
}
function restore(html: string, tokens: string[]): string {
  return html.replace(/<span translate="no">§(\d+)§<\/span>/g, (_m, i) => tokens[Number(i)] ?? "");
}

const TARGET_LANG_CODE: Record<string, string> = { en: "en", es: "es", ru: "ru", uk: "uk" };

export async function translateHtml(html: string, targetLang: "en" | "es" | "ru" | "uk", sourceLang = "pl"): Promise<string> {
  const keyFile = process.env.GOOGLE_DOCAI_KEY_FILE;
  if (!keyFile) throw new Error("Автопереклад не налаштований на цьому сервері (GOOGLE_DOCAI_KEY_FILE)");
  const { protected: safe, tokens } = protect(html);

  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const res: any = await client.request({
    url: "https://translation.googleapis.com/language/translate/v2",
    method: "POST",
    data: { q: safe, source: sourceLang, target: TARGET_LANG_CODE[targetLang], format: "html" },
  });
  const translated = res.data?.data?.translations?.[0]?.translatedText;
  if (typeof translated !== "string") throw new Error("Translation API не повернув результат");
  logger.info({ targetLang, chars: html.length }, "template body auto-translated");
  return restore(translated, tokens);
}

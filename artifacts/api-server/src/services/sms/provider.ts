// Адаптери SMS-провайдерів (SMSAPI.pl, SMS-Fly.pl) за одним інтерфейсом.
// Ключі — лише з env (як KSEF_TOKEN_*): SMS_SMSAPI_TOKEN, SMS_SMSFLY_KEY (+ SMS_SMSFLY_URL),
// SMS_SENDER (підпис), SMS_LINK_BASE (короткий домен лінків; фолбек WEB_APP_URL).
// Тести підміняють провайдера через setSmsProviderForTests().
import { logger } from "../../lib/logger";

export type SmsProviderName = "smsapi" | "smsfly";
export type SendItem = { recipientId: number; phone: string; text: string; from: string };
export type SendResult = { recipientId: number; ok: boolean; msgId?: string; parts?: number; error?: string };
export type StatusResult = { msgId: string; status: "delivered" | "failed" | "pending"; reason?: string };

export interface SmsProvider {
  readonly name: SmsProviderName;
  configured(): boolean;
  send(items: SendItem[]): Promise<SendResult[]>;
  status(msgIds: string[]): Promise<StatusResult[]>;
  // орієнтовна ціна за частину (для оцінки витрат у панелі), zł без VAT
  price(phone: string): number;
}

export const SMS_SENDER = (): string => process.env.SMS_SENDER || "EuroSupport";
export const smsLinkBase = (): string => (process.env.SMS_LINK_BASE || process.env.WEB_APP_URL || "").replace(/\/$/, "");
export const smsConfigured = (name: SmsProviderName): boolean => getSmsProvider(name).configured();

const priceFor = (pl: number, ua: number, other: number) => (phone: string) => phone.startsWith("+48") ? pl : phone.startsWith("+380") ? ua : other;

// ── SMSAPI.pl (https://www.smsapi.pl/docs) ─────────────────────────────────
// POST https://api.smsapi.pl/sms.do, Bearer token; персоналізований текст = запит на номер.
const SMSAPI_URL = process.env.SMS_SMSAPI_URL || "https://api.smsapi.pl/sms.do";
const smsapi: SmsProvider = {
  name: "smsapi",
  configured: () => !!process.env.SMS_SMSAPI_TOKEN,
  price: priceFor(0.10, 0.85, 0.35),
  async send(items) {
    const token = process.env.SMS_SMSAPI_TOKEN;
    if (!token) throw new Error("SMSAPI не налаштований (SMS_SMSAPI_TOKEN)");
    const out: SendResult[] = [];
    for (const it of items) {
      const body = new URLSearchParams({ to: it.phone.replace(/^\+/, ""), message: it.text, from: it.from, encoding: "utf-8", format: "json", details: "1", idx: String(it.recipientId) });
      try {
        const res = await fetch(SMSAPI_URL, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
        const data: any = await res.json().catch(() => ({}));
        const first = data?.list?.[0];
        if (res.ok && first?.id && !data?.error) out.push({ recipientId: it.recipientId, ok: true, msgId: String(first.id), parts: Number(first.parts) || undefined });
        else out.push({ recipientId: it.recipientId, ok: false, error: `${data?.error ?? res.status}: ${data?.message ?? data?.invalid_numbers?.[0]?.message ?? "помилка SMSAPI"}` });
      } catch (e: any) {
        out.push({ recipientId: it.recipientId, ok: false, error: e?.message ?? String(e) });
      }
    }
    return out;

    async function sendOne(it: SendItem, retries = 2): Promise<any> {
      try {
        return await smsflyCall("SENDMESSAGE", { recipient: it.phone.replace(/^\+/, ""), channels: ["sms"], sms: { source: it.from, ttl: 86400, text: it.text } });
      } catch (e: any) {
        if (retries > 0 && String(e?.message ?? "").includes("429")) { await sleep(1500); return sendOne(it, retries - 1); }
        throw e;
      }
    }
  },
  async status(msgIds) {
    const token = process.env.SMS_SMSAPI_TOKEN;
    if (!token || !msgIds.length) return [];
    const res = await fetch(`${SMSAPI_URL}?status=${encodeURIComponent(msgIds.join(","))}&format=json`, { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await res.json().catch(() => ({}));
    const list: any[] = data?.list ?? [];
    return list.map((r) => {
      const code = Number(r.status_code ?? r.status);
      const name = String(r.status_name ?? r.status ?? "").toUpperCase();
      const delivered = code === 404 || name === "DELIVERED";
      const failed = [402, 405, 406, 407, 412].includes(code) || ["EXPIRED", "UNDELIVERED", "FAILED", "REJECTED", "STOP"].includes(name);
      return { msgId: String(r.id), status: delivered ? "delivered" : failed ? "failed" : "pending", reason: failed ? (r.status_name ?? String(code)) : undefined } as StatusResult;
    });
  },
};

// ── SMS-Fly.pl (API v2, JSON) ──────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SMSFLY_URL = () => process.env.SMS_SMSFLY_URL || "https://sms-fly.pl/api/v2/api.php";
async function smsflyCall(action: string, data: unknown): Promise<any> {
  const key = process.env.SMS_SMSFLY_KEY;
  if (!key) throw new Error("SMS-Fly не налаштований (SMS_SMSFLY_KEY)");
  const res = await fetch(SMSFLY_URL(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth: { key }, action, data }) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === 0 || json?.success === false) throw new Error(`SMS-Fly ${action}: ${json?.error?.description ?? json?.error?.code ?? res.status}`);
  return json?.data ?? json;
}
const smsfly: SmsProvider = {
  name: "smsfly",
  configured: () => !!process.env.SMS_SMSFLY_KEY,
  price: priceFor(0.069, 0.64, 0.4),
  async send(items) {
    const out: SendResult[] = [];
    // SMS-Fly лімітує частоту: батч 1000 без пауз дав 429 на 244 повідомленнях (23.09.2026).
    // Тримаємо ~5 SMS/с і на 429 чекаємо довше й пробуємо ще раз — інакше людина просто не отримає SMS.
    for (const it of items) {
      if (out.length) await sleep(200);
      try {
        const d = await sendOne(it);
        const id = d?.messageID ?? d?.messageId ?? d?.id;
        if (id) out.push({ recipientId: it.recipientId, ok: true, msgId: String(id) });
        else out.push({ recipientId: it.recipientId, ok: false, error: "SMS-Fly: відповідь без messageID" });
      } catch (e: any) {
        out.push({ recipientId: it.recipientId, ok: false, error: e?.message ?? String(e) });
      }
    }
    return out;

    // на 429 (ліміт частоти) чекаємо довше й пробуємо ще раз — інакше людина просто не отримає SMS
    async function sendOne(it: SendItem, retries = 2): Promise<any> {
      try {
        return await smsflyCall("SENDMESSAGE", { recipient: it.phone.replace(/^\+/, ""), channels: ["sms"], sms: { source: it.from, ttl: 86400, text: it.text } });
      } catch (e: any) {
        if (retries > 0 && String(e?.message ?? "").includes("429")) { await sleep(1500); return sendOne(it, retries - 1); }
        throw e;
      }
    }
  },
  async status(msgIds) {
    const out: StatusResult[] = [];
    // SMS-Fly має лише по-одному GETMESSAGESTATUS і лімітує частоту: по 10 паралельно давало 429
    // і статуси не підтягувались (перша хвиля 23.09.2026) → по 3 з паузою і однією повторною спробою.
    let rateLimited = 0;
    for (let i = 0; i < msgIds.length; i += 3) {
      await Promise.all(msgIds.slice(i, i + 3).map((id) => one(id)));
      if (i + 3 < msgIds.length) await sleep(250);
    }
    if (rateLimited) logger.warn({ rateLimited, total: msgIds.length }, "SMS-Fly status: ліміт частоти, статуси доберуться наступним прогоном");
    return out;
    async function one(id: string, retry = true): Promise<void> {
      try {
        const d = await smsflyCall("GETMESSAGESTATUS", { messageID: id });
        // SMS-Fly віддає SMPP-коди (перевірено 21.09.2026 на живому SMS: "DELIVRD"), не повні слова
        const st = String(d?.sms?.status ?? d?.status ?? "").toUpperCase();
        const delivered = st === "DELIVRD" || st === "DELIVERED";
        const failed = ["UNDELIV", "UNDELIVERED", "EXPIRED", "REJECTD", "REJECTED", "DELETED", "ERROR", "FAILED", "INVALID"].includes(st);
        out.push({ msgId: id, status: delivered ? "delivered" : failed ? "failed" : "pending", reason: st || undefined });
      } catch (e: any) {
        if (String(e?.message ?? "").includes("429")) {
          rateLimited++;
          if (retry) { await sleep(1500); return one(id, false); }
          return; // доберемо наступним прогоном крона
        }
        logger.warn({ err: e, id }, "SMS-Fly status failed");
      }
    }
  },
};

let override: SmsProvider | null = null;
export function setSmsProviderForTests(p: SmsProvider | null): void { override = p; }
export function getSmsProvider(name: SmsProviderName): SmsProvider {
  if (override) return override;
  return name === "smsfly" ? smsfly : smsapi;
}

// Telegram Mini App initData verification (official scheme):
// secret = HMAC_SHA256(key="WebAppData", msg=botToken);
// check  = HMAC_SHA256(key=secret, msg=data_check_string) — hex must equal the `hash` field.
// data_check_string = all fields except `hash`, sorted, joined as "key=value" with "\n".
import { createHmac, timingSafeEqual } from "node:crypto";

export type WebAppUser = { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string };

const MAX_AGE_SEC = 10 * 60; // initData is minted at Mini App open — anything older is a replay

export function verifyWebAppInitData(initData: string, botToken: string, nowMs = Date.now()): { user: WebAppUser } | null {
  if (!initData || !botToken) return null;
  let params: URLSearchParams;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;

  const pairs: string[] = [];
  for (const [k, v] of params.entries()) if (k !== "hash") pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const check = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  const a = Buffer.from(check, "hex"), b = Buffer.from(hash.toLowerCase(), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || Math.abs(nowMs / 1000 - authDate) > MAX_AGE_SEC) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "") as WebAppUser;
    if (!user || typeof user.id !== "number") return null;
    return { user };
  } catch { return null; }
}

// Test helper mirror: build a signed initData string the way Telegram does.
// Kept here (not in the test) so the signing and verifying halves can't drift apart silently.
export function signWebAppInitData(fields: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  const qs = new URLSearchParams(fields);
  qs.set("hash", hash);
  return qs.toString();
}

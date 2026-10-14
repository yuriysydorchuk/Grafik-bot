// Симетричне шифрування секретів у БД (12.10.2026): паролі profilu zaufanego для робота
// praca.gov.pl. AES-256-GCM, ключ = SHA-256 від env PZ_SECRET (окремий від SESSION_SECRET,
// щоб ротація сесій не ламала збережені секрети). Формат: `v1.<iv>.<tag>.<ct>` (base64url).
// Без PZ_SECRET функція недоступна — API повертає `ready:false`, нічого не зберігається.
import crypto from "node:crypto";

const ENV = "PZ_SECRET";
let keyCache: Buffer | null | undefined;

function key(): Buffer | null {
  if (keyCache !== undefined) return keyCache;
  const raw = process.env[ENV]?.trim();
  keyCache = raw && raw.length >= 16 ? crypto.createHash("sha256").update(raw, "utf8").digest() : null;
  return keyCache;
}

export const isSecretBoxReady = (): boolean => key() !== null;

export function sealSecret(plain: string): string {
  const k = key();
  if (!k) throw new Error(`${ENV} не задано — шифрування секретів вимкнене`);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function openSecret(sealed: string): string {
  const k = key();
  if (!k) throw new Error(`${ENV} не задано — шифрування секретів вимкнене`);
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Невідомий формат секрету");
  const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

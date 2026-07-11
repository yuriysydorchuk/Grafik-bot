import { randomBytes } from "node:crypto";

// Crockford base32 alphabet (no I, L, O, U — avoids visual ambiguity when read/typed).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Cryptographically-strong, unguessable invite token used as the ?start= secret for
// Telegram binding (workers/drivers/admins). Default 12 chars ≈ 60 bits of entropy —
// not enumerable, unlike the sequential worker_code it replaces. 256 % 32 == 0, so
// masking each byte with 31 is unbiased.
export function randomInviteCode(length = 12): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! & 31];
  return out;
}

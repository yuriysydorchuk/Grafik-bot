import { randomBytes } from "node:crypto";
import { db, workersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

// Returns the worker's existing invite code, or mints+persists a fresh unique one.
// Shared by GET /workers/:id/invite (admin-api.ts) and the passport-scan bot flow
// (office scans a brand-new candidate and needs the link right away).
export async function ensureWorkerInviteCode(workerId: number): Promise<string> {
  const [w] = await db.select({ inviteCode: workersTable.inviteCode }).from(workersTable).where(eq(workersTable.id, workerId));
  let invite = w?.inviteCode;
  if (!invite) {
    for (let i = 0; i < 50; i++) {
      const c = randomInviteCode();
      if ((await db.select().from(workersTable).where(eq(workersTable.inviteCode, c))).length === 0) { invite = c; break; }
    }
    invite = invite ?? randomInviteCode(16);
    await db.update(workersTable).set({ inviteCode: invite }).where(eq(workersTable.id, workerId));
  }
  return invite;
}

export const workerInviteLink = (inviteCode: string): string => {
  const username = process.env.TELEGRAM_BOT_USERNAME || "";
  return username ? `https://t.me/${username}?start=emp${inviteCode}` : `?start=emp${inviteCode}`;
};

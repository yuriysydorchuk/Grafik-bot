// Разово: повторний прогін «Години підтверджені → до сводної» через живий API
// (тимчасова owner-сесія, одразу ревокається).
import { db, pool, adminsTable, adminSessionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { createToken, SESSION_COOKIE } from "./src/lib/auth.ts";

const MONTH = process.argv[2] ?? "2026-05";
const [admin] = await db.select().from(adminsTable).where(eq(adminsTable.isMain, true));
const [sess] = await db.insert(adminSessionsTable).values({
  id: randomBytes(24).toString("base64url"), adminId: admin.id, userAgent: "refresh-from-hours", ip: "127.0.0.1",
}).returning();
const token = createToken(admin.id, admin.name, admin.role, admin.tokenVersion ?? 0, sess.id);
const r = await fetch("http://localhost:8080/api/svodni/from-hours", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Requested-With": "grafik", Cookie: `${SESSION_COOKIE}=${token}` },
  body: JSON.stringify({ month: MONTH }),
});
console.log("from-hours:", r.status, JSON.stringify(await r.json()));
const agg = await db.execute(sql`
  SELECT round(sum(zaliczka)::numeric,2) AS zaliczka, round(sum(hostel)::numeric,2) AS hostel,
         round(sum(do_wyplaty)::numeric,2) AS pay, round(sum(konto)::numeric,2) AS konto,
         round(sum(gotowka)::numeric,2) AS gotowka
  FROM svodni_rows WHERE period_month=${MONTH}`);
console.log(MONTH, JSON.stringify(agg.rows[0]));
await db.update(adminSessionsTable).set({ revokedAt: new Date() }).where(eq(adminSessionsTable.id, sess.id));
await pool.end();

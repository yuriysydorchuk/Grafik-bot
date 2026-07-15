// Разово: перезастосувати статусні правила до сайтових рядків місяця
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { applyLegalDefaults } from "./src/services/svodni.ts";

const MONTH = process.argv[2] ?? "2026-05";
const rows = await db.select({ r: svodniRowsTable, ls: workersTable.legalStatus })
  .from(svodniRowsTable).leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
  .where(eq(svodniRowsTable.periodMonth, MONTH));
let n = 0;
for (const { r, ls } of rows) {
  const merged = { ...r };
  applyLegalDefaults(merged, true, ls ?? null);
  const changed = ["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"]
    .filter(k => merged[k] !== r[k]);
  if (!changed.length) continue;
  await db.update(svodniRowsTable).set(Object.fromEntries(changed.map(k => [k, merged[k]])))
    .where(eq(svodniRowsTable.id, r.id));
  n++;
}
console.log(`${MONTH}: перераховано рядків ${n} з ${rows.length}`);
await pool.end();

// Разово: злиття дублікатних профілів (затверджено власником).
// Аргументи: пари keep:drop, напр. `node ... merge-dup-workers.mjs 10:110 153:124`
import { db, pool, workersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { mergeWorkers } from "./src/services/workerMerge.ts";

for (const arg of process.argv.slice(2)) {
  const [keepId, dropId] = arg.split(":").map(Number);
  if (!keepId || !dropId) { console.log(arg, "— формат keep:drop"); continue; }
  const [drop] = await db.select().from(workersTable).where(eq(workersTable.id, dropId));
  const name = drop?.fullName ?? "?";
  const r = await mergeWorkers(keepId, dropId);
  console.log(`${name}: №${dropId} → №${keepId}:`, r.ok ? "обʼєднано" : r.error);
}
await pool.end();

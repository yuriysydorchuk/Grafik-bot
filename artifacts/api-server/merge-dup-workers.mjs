// Разово: злиття порожніх fired-дублікатів з активними двійниками (затверджено власником).
import { db, pool, workersTable } from "@workspace/db";
import { mergeWorkers } from "./src/services/workerMerge.ts";

const all = await db.select().from(workersTable);
const nk = (s) => s.toUpperCase().replace(/[^A-Z]/g, "");
for (const dropId of process.argv.slice(2).map(Number)) {
  const drop = all.find(w => w.id === dropId);
  if (!drop) { console.log(dropId, "— не знайдено (можливо, вже злитий)"); continue; }
  const twin = all.find(w => w.id !== dropId && w.isActive && nk(w.fullName) === nk(drop.fullName));
  if (!twin) { console.log(dropId, drop.fullName, "— активного двійника немає, пропускаю"); continue; }
  const r = await mergeWorkers(twin.id, dropId);
  console.log(`${drop.fullName}: №${dropId} → №${twin.id} (${twin.workerCode}):`, r.ok ? "обʼєднано" : r.error);
}
await pool.end();

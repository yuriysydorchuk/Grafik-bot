// Виправлення: год. повідомлення лодзьким — ЛИШЕ зі справжньої таблички
// евіденції (Ew.); псевдо-евіденція з ES/ESO-вкладок скидається.
// Заодно AUNDE Dopłata ES → травневі рядки (готівка = ... + doplata).
import { readFileSync } from "node:fs";
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { parseLodzFullTab } from "./src/services/svodni.ts";
import { matchSvodniName, dedupeWorkers } from "./src/services/svodniSync.ts";
import { cleanName } from "./src/services/payrollSummaries.ts";

const DIR = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/grids";
const SKIP = /GODZIN.*MIES|TOTAL.*MIES|MAILE|WORK ?LIST|NOTATKA|^OFFICE|^ОФИС/i;
const r2 = (n) => Math.round(n * 100) / 100;
const workers = dedupeWorkers(await db.select().from(workersTable));

// 1) зібрати справжні Ew-години і doplataEs з оригіналу
const ewByWorker = new Map();
const doplataByWorker = new Map();
const lodzWorkerIds = new Set();
for (const name of ["lodz-es-2026-05", "lodz-eso-2026-05", "lodz-klinex-2026-05"]) {
  const g = new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${name}.json`, "utf8"))));
  for (const [t, rws] of g) {
    if (SKIP.test(t.trim())) continue;
    const p = parseLodzFullTab(t, rws);
    if (!p) continue;
    for (const src of p.rows) {
      const w = matchSvodniName(cleanName(src.rawName), workers);
      if (!w) continue;
      lodzWorkerIds.add(w.id);
      if (typeof src.extras.ewH === "number" && src.extras.ewH > 0) ewByWorker.set(w.id, r2(src.extras.ewH));
      if (typeof src.extras.doplataEs === "number" && src.extras.doplataEs > 0) doplataByWorker.set(w.id, r2(src.extras.doplataEs));
    }
  }
}
// 2) скинути псевдо-евіденцію (лодзькі без справжнього Ew)
const toReset = [...lodzWorkerIds].filter(id => !ewByWorker.has(id));
if (toReset.length) {
  await db.update(workersTable).set({ notifyHours: null }).where(inArray(workersTable.id, toReset));
  await db.update(svodniRowsTable).set({ hoursNotified: null })
    .where(and(eq(svodniRowsTable.periodMonth, "2026-05"), inArray(svodniRowsTable.workerId, toReset)));
}
// 3) сет справжніх Ew-годин
let setN = 0;
for (const [wid, ew] of ewByWorker) {
  await db.update(workersTable).set({ notifyHours: ew }).where(eq(workersTable.id, wid));
  await db.update(svodniRowsTable).set({ hoursNotified: ew })
    .where(and(eq(svodniRowsTable.periodMonth, "2026-05"), eq(svodniRowsTable.workerId, wid)));
  setN++;
}
// 4) doplataEs у травневі рядки (AUNDE)
let dopl = 0;
for (const [wid, d] of doplataByWorker) {
  const rows = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.periodMonth, "2026-05"), eq(svodniRowsTable.workerId, wid)));
  for (const r of rows) {
    await db.update(svodniRowsTable).set({ extras: { ...(r.extras ?? {}), doplataEs: d } })
      .where(eq(svodniRowsTable.id, r.id));
    dopl++;
  }
}
console.log(`скинуто псевдо-евіденцій: ${toReset.length}; справжніх Ew: ${setN}; doplataEs: ${dopl}`);
await pool.end();

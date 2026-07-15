// Разово: форми легалізації лодзьких (і всіх, де профіль порожній) з колонки
// Księgowość оригінальної травневої таблиці → профілі; потім перерахунок травня.
import { readFileSync } from "node:fs";
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { eq, isNull, and } from "drizzle-orm";
import { parseLublinTab, parseLodzFullTab, legalStatusOf, applyLegalDefaults, computePayout } from "./src/services/svodni.ts";
import { matchSvodniName, dedupeWorkers } from "./src/services/svodniSync.ts";
import { cleanName } from "./src/services/payrollSummaries.ts";

const DIR = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/grids";
const SKIP = /GODZIN.*MIES|TOTAL.*MIES|MAILE|WORK ?LIST|NOTATKA|^OFFICE|^ОФИС/i;
const workers = dedupeWorkers(await db.select().from(workersTable));

let setStatus = 0;
for (const [name, kind] of [["lublin-2026-05","L"],["poznan-2026-05","L"],["lodz-es-2026-05","Ł"],["lodz-eso-2026-05","Ł"],["lodz-klinex-2026-05","Ł"]]) {
  const g = new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${name}.json`, "utf8"))));
  for (const [t, rows] of g) {
    if (SKIP.test(t.trim())) continue;
    const p = kind === "Ł" ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!p) continue;
    for (const src of p.rows) {
      const ls = legalStatusOf(src.extras?.zusStatus);
      if (!ls) continue;
      const w = matchSvodniName(cleanName(src.rawName), workers);
      if (!w || w.legalStatus) continue; // заповнюємо лише порожні профілі
      await db.update(workersTable).set({ legalStatus: ls, ...(ls === "student" ? { isStudent: true } : {}) })
        .where(eq(workersTable.id, w.id));
      w.legalStatus = ls;
      setStatus++;
    }
  }
}
console.log(`профілів отримали форму легалізації: ${setStatus}`);

// перерахунок травневих рядків із новими статусами
const wAll = await db.select().from(workersTable);
const wById = new Map(wAll.map(w => [w.id, w]));
const rows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.periodMonth, "2026-05"));
let recalc = 0;
for (const r of rows) {
  const merged = { ...r };
  applyLegalDefaults(merged, true, r.workerId ? wById.get(r.workerId)?.legalStatus ?? null : null);
  const changed = ["hoursDeclared", "ksiegBrutto", "ksiegNetto", "konto", "gotowka"].filter(k => merged[k] !== r[k]);
  if (!changed.length) continue;
  await db.update(svodniRowsTable).set(Object.fromEntries(changed.map(k => [k, merged[k]])))
    .where(eq(svodniRowsTable.id, r.id));
  recalc++;
}
console.log(`перераховано травневих рядків: ${recalc}`);
const { sql } = await import("drizzle-orm");
const agg = await db.execute(sql`SELECT round(sum(konto)::numeric,2) AS конто, round(sum(gotowka)::numeric,2) AS готівка FROM svodni_rows WHERE period_month='2026-05'`);
console.log(JSON.stringify(agg.rows[0]));
await pool.end();

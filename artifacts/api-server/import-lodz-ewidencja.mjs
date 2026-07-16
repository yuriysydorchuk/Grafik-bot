// Разово: лодзькі год. повідомлення (oświadczenie) — з таблички евіденції (Ew./
// NA KONTO h) оригінальної травневої таблиці → профілі + травневі рядки сводної.
import { readFileSync } from "node:fs";
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { parseLodzFullTab } from "./src/services/svodni.ts";
import { matchSvodniName, dedupeWorkers } from "./src/services/svodniSync.ts";
import { cleanName } from "./src/services/payrollSummaries.ts";

const DIR = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/grids";
const SKIP = /GODZIN.*MIES|TOTAL.*MIES|MAILE|WORK ?LIST|NOTATKA|^OFFICE|^ОФИС/i;
const r2 = (n) => Math.round(n * 100) / 100;
const workers = dedupeWorkers(await db.select().from(workersTable));

let profiles = 0, rows = 0;
for (const name of ["lodz-es-2026-05", "lodz-eso-2026-05", "lodz-klinex-2026-05"]) {
  const g = new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${name}.json`, "utf8"))));
  for (const [t, rws] of g) {
    if (SKIP.test(t.trim())) continue;
    const p = parseLodzFullTab(t, rws);
    if (!p) continue;
    for (const src of p.rows) {
      // евіденція: Ew.-години (Klinex/AUNDE) або NA KONTO "h" (ES/ESO)
      const ew = src.hoursDeclared;
      if (ew == null || ew <= 0) continue;
      const w = matchSvodniName(cleanName(src.rawName), workers);
      if (!w) continue;
      await db.update(workersTable).set({ notifyHours: r2(ew) }).where(eq(workersTable.id, w.id));
      profiles++;
      const upd = await db.update(svodniRowsTable).set({ hoursNotified: r2(ew) })
        .where(and(eq(svodniRowsTable.periodMonth, "2026-05"), eq(svodniRowsTable.workerId, w.id)))
        .returning({ id: svodniRowsTable.id });
      rows += upd.length;
    }
  }
}
console.log(`профілів з евіденцією: ${profiles}; травневих рядків оновлено: ${rows}`);
await pool.end();

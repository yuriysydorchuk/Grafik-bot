// Разово: офіційні години з файлів «ewidencja 05.2026» (Лодзь, 3 фірми) →
// профілі (год. у повідомленні) + травневі рядки сводної. Ліва «godziny»
// евіденції — офіційні години місяця; права частина — реальні.
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { readSourceGrids } from "./src/services/svodniFetch.ts";
import { matchSvodniName, dedupeWorkers } from "./src/services/svodniSync.ts";
import { norm, num, cell, cleanName } from "./src/services/payrollSummaries.ts";

const FILES = [
  { firm: "ESO", kind: "gsheet", spreadsheetId: "1zWIdLPKzEF2gPgYmfdi4AajHmyh5Pb1fyCMuPtA93fY" },
  { firm: "Klinex", kind: "xlsx", spreadsheetId: "1aMmA7Q53NGzBMliI0FeF1E4jzPv_lDjL" },
  { firm: "ES", kind: "xlsx", spreadsheetId: "1neECM2DpzVn-BMPlmwSmRXNmGRRMI2a8" },
];
const r2 = (n) => Math.round(n * 100) / 100;
const workers = dedupeWorkers(await db.select().from(workersTable));

let profiles = 0, rows = 0, unmatched = [];
for (const f of FILES) {
  const { grids } = await readSourceGrids({ id: 0, kind: f.kind, spreadsheetId: f.spreadsheetId });
  for (const [tab, g] of grids) {
    const header = (g[0] ?? []).map(c => norm(String(c ?? "")));
    const nameCol = header.findIndex(h => /IMIE|NAZWISKO/.test(h));
    const godzCol = header.findIndex(h => /^GODZINY$/.test(h));
    if (nameCol !== 0 || godzCol < 0) continue; // не та вкладка (Лист2 — PESEL)
    console.log(`  ${f.firm} / ${tab}: рядків ${g.length - 1}`);
    for (let i = 1; i < g.length; i++) {
      const name = cell(g[i], nameCol);
      if (!name) continue;
      const godz = num(g[i]?.[godzCol]);
      if (godz == null || godz <= 0) continue;
      const w = matchSvodniName(cleanName(name), workers);
      if (!w) { unmatched.push(`${name} (${f.firm})`); continue; }
      await db.update(workersTable).set({ notifyHours: r2(godz) }).where(eq(workersTable.id, w.id));
      profiles++;
      const upd = await db.update(svodniRowsTable).set({ hoursNotified: r2(godz) })
        .where(and(eq(svodniRowsTable.periodMonth, "2026-05"), eq(svodniRowsTable.workerId, w.id)))
        .returning({ id: svodniRowsTable.id });
      rows += upd.length;
    }
    break; // перша підходяща вкладка книги
  }
}
console.log(`профілів: ${profiles}; травневих рядків: ${rows}; не зматчено: ${unmatched.length}`);
for (const u of unmatched) console.log("  ?", u);
await pool.end();

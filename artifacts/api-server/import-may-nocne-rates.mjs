// Разово: нічні години/доплата і ТРАВНЕВІ ставки з оригінальної таблиці →
// сайтова сводна травня (лише рядки сводної, профілі НЕ чіпаємо) + формули.
import { readFileSync } from "node:fs";
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { parseLublinTab, parseLodzFullTab, computePayout, applyLegalDefaults } from "./src/services/svodni.ts";
import { matchSvodniName, dedupeWorkers } from "./src/services/svodniSync.ts";
import { key, cleanName } from "./src/services/payrollSummaries.ts";

const MONTH = "2026-05";
const DIR = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/grids";
const SKIP = /GODZIN.*MIES|TOTAL.*MIES|MAILE|WORK ?LIST|NOTATKA|^OFFICE|^ОФИС/i;
const r2 = (n) => Math.round(n * 100) / 100;

const workers = dedupeWorkers(await db.select().from(workersTable));
const wById = new Map(workers.map(w => [w.id, w]));
const siteRows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.periodMonth, MONTH));
const rowsByWorker = new Map();
for (const r of siteRows) {
  if (r.workerId == null) continue;
  (rowsByWorker.get(r.workerId) ?? rowsByWorker.set(r.workerId, []).get(r.workerId)).push(r);
}

let nocne = 0, rates = 0;
for (const [name, kind] of [["lublin-2026-05","L"],["poznan-2026-05","L"],["lodz-es-2026-05","Ł"],["lodz-eso-2026-05","Ł"],["lodz-klinex-2026-05","Ł"]]) {
  const g = new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${name}.json`, "utf8"))));
  for (const [t, rows] of g) {
    if (SKIP.test(t.trim())) continue;
    const p = kind === "Ł" ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!p) continue;
    for (const src of p.rows) {
      const srcNocne = typeof src.extras.nocneH === "number" ? src.extras.nocneH : 0;
      const srcDopl = typeof src.extras.doplataNocna === "number" ? src.extras.doplataNocna : 0;
      const w = matchSvodniName(cleanName(src.rawName), workers);
      const targets = w ? rowsByWorker.get(w.id) ?? [] : [];
      const target = targets.length > 1
        ? targets.find(x => key(x.factoryLabel) === key(t) || key(t).startsWith(key(x.factoryLabel)) || key(x.factoryLabel).startsWith(key(t))) ?? targets[0]
        : targets[0];
      if (!target) continue;
      const rateFix = (src.rateBrutto != null && src.rateBrutto !== target.rateBrutto)
        || (src.rateNetto != null && src.rateNetto !== target.rateNetto);
      if (!(srcNocne > 0) && !rateFix) continue;
      const merged = { ...target };
      const extras = { ...(merged.extras ?? {}) };
      if (srcNocne > 0) { extras.nocneH = r2(srcNocne); if (srcDopl > 0) extras.doplataNocna = r2(srcDopl); nocne++; }
      merged.extras = extras;
      if (rateFix) {
        if (src.rateBrutto != null) merged.rateBrutto = src.rateBrutto;
        if (src.rateNetto != null) merged.rateNetto = src.rateNetto;
        rates++;
      }
      const payout = computePayout(merged, target.city);
      if (payout != null) merged.doWyplaty = payout;
      if (merged.hours != null && merged.rateBrutto != null) merged.brutto = r2(merged.hours * merged.rateBrutto);
      applyLegalDefaults(merged, true, wById.get(target.workerId)?.legalStatus ?? null);
      // ВАЖЛИВО: пишемо напряму в рядок сводної — syncWorkerProfile не викликається,
      // профілі працівників лишаються з актуальними (новішими) ставками
      await db.update(svodniRowsTable).set({
        rateBrutto: merged.rateBrutto, rateNetto: merged.rateNetto, brutto: merged.brutto,
        extras: merged.extras, doWyplaty: merged.doWyplaty,
        hoursDeclared: merged.hoursDeclared, ksiegBrutto: merged.ksiegBrutto,
        ksiegNetto: merged.ksiegNetto, konto: merged.konto, gotowka: merged.gotowka,
        manual: true, mismatch: null,
      }).where(eq(svodniRowsTable.id, target.id));
    }
  }
}
console.log(`нічні вписано: ${nocne} рядків; ставки виправлено (лише в таблиці): ${rates}`);
const { sql } = await import("drizzle-orm");
const agg = await db.execute(sql`
  SELECT round(sum((extras->>'nocneH')::real * (extras->>'doplataNocna')::real)::numeric,2) AS нічні_сума,
         round(sum(do_wyplaty)::numeric,2) AS до_виплати, round(sum(konto)::numeric,2) AS конто,
         round(sum(gotowka)::numeric,2) AS готівка
  FROM svodni_rows WHERE period_month=${MONTH}`);
console.log(JSON.stringify(agg.rows[0]));
await pool.end();

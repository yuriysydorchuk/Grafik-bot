// Тотал «До виплати» по людях: сайт vs оригінал, |Δ| ≥ 1 zł
import { readFileSync } from "node:fs";
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { parseLublinTab, parseLodzFullTab, overlayGotowka, applyLegalDefaults } from "./src/services/svodni.ts";
import { gotowkaRowsForMonth } from "./src/services/svodniSync.ts";
import { key, cleanName } from "./src/services/payrollSummaries.ts";

const DIR = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/grids";
const G = (n) => new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${n}.json`, "utf8"))));
const SKIP = /GODZIN.*MIES|TOTAL.*MIES|MAILE|WORK ?LIST|NOTATKA|^OFFICE|^ОФИС/i;
const r2 = (n) => Math.round(n * 100) / 100;

const orig = new Map();
const add = (m, k, name, pay, hours, fac) => {
  const o = m.get(k) ?? m.set(k, { name, pay: 0, hours: 0, fac: new Set() }).get(k);
  o.pay += pay; o.hours += hours; o.fac.add(fac);
};
const JOBS = [
  { name: "lublin-2026-05" }, { name: "poznan-2026-05" },
  { name: "lodz-es-2026-05", gotowka: "gotowka-es" },
  { name: "lodz-eso-2026-05", gotowka: "gotowka-eso" },
  { name: "lodz-klinex-2026-05", gotowka: "gotowka-klinex" },
];
for (const j of JOBS) {
  const grids = G(j.name);
  const got = j.gotowka ? gotowkaRowsForMonth(G(j.gotowka), "2026-05") : [];
  for (const [t, rows] of grids) {
    if (SKIP.test(t.trim())) continue;
    const parsed = j.name.startsWith("lodz") ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!parsed) continue;
    if (got.length) overlayGotowka(parsed, got.filter(g => key(g.factory) === key(t) || key(t).startsWith(key(g.factory))));
    for (const r of parsed.rows) {
      const k = key(cleanName(r.rawName));
      if (!k || r.doWyplaty == null) continue;
      add(orig, k, r.rawName, r.doWyplaty, r.hours ?? 0, t);
    }
  }
}
const site = new Map();
const rows = await db.select({ r: svodniRowsTable, name: workersTable.fullName })
  .from(svodniRowsTable).leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
  .where(eq(svodniRowsTable.periodMonth, "2026-05"));
for (const { r, name } of rows) {
  const k = key(cleanName(name ?? r.rawName));
  if (r.doWyplaty == null) continue;
  add(site, k, name ?? r.rawName, r.doWyplaty, r.hours ?? 0, r.factoryLabel);
}

// точний матч по ключу; решту — по перетину токенів імені (≥2 спільних)
const toks = (s) => new Set(s.toUpperCase().replace(/[^A-ZĄĘÓŁŚŻŹĆŃ ]/gi, " ").split(/\s+/).filter(x => x.length >= 3));
const pairs = [];
const usedO = new Set(), usedS = new Set();
for (const [k, s] of site) if (orig.has(k)) { pairs.push([orig.get(k), s]); usedO.add(k); usedS.add(k); }
const oLeft = [...orig.entries()].filter(([k]) => !usedO.has(k));
const sLeft = [...site.entries()].filter(([k]) => !usedS.has(k));
for (const [sk, s] of sLeft) {
  const st = toks(s.name);
  let best = null, bestN = 0;
  for (const [ok, o] of oLeft) {
    if (usedO.has(ok)) continue;
    const n = [...toks(o.name)].filter(x => st.has(x)).length;
    if (n > bestN) { bestN = n; best = [ok, o]; }
  }
  if (best && bestN >= 2) { pairs.push([best[1], s]); usedO.add(best[0]); usedS.add(sk); }
  else pairs.push([null, s]);
}
for (const [ok, o] of oLeft) if (!usedO.has(ok)) pairs.push([o, null]);

const diffs = pairs
  .map(([o, s]) => ({ name: (s ?? o).name, o, s, d: r2((s?.pay ?? 0) - (o?.pay ?? 0)) }))
  .filter(x => Math.abs(x.d) >= 1)
  .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
console.log(`Людей: ориг ${[...orig.values()].filter(o => o.pay !== 0).length} / сайт ${site.size}; пар ${pairs.length}; з Δ≥1zł: ${diffs.length}\n`);
for (const x of diffs) {
  const of = x.o ? [...x.o.fac].join(",") : "—";
  console.log(`${x.name}: Δ ${x.d} zł (сайт ${r2(x.s?.pay ?? 0)} [${x.s ? [...x.s.fac].join(",") : "нема"}] vs ориг ${r2(x.o?.pay ?? 0)} [${of}]; год ${r2(x.s?.hours ?? 0)} vs ${r2(x.o?.hours ?? 0)})`);
}
await pool.end();

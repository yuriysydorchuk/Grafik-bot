// Порівняння: сайтова сводна травня (з обліку годин) vs оригінальна (Google).
// Оригінал парситься з кешованих сіток У ПАМʼЯТІ — БД не чіпаємо.
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

// ── оригінал: агрегат по людині ──────────────────────────────────────────────
const orig = new Map(); // key(name) → {name, hours, pay, konto, gotowka, rateN, factories}
function addOrig(row, factory) {
  const k = key(cleanName(row.rawName));
  if (!k) return;
  const o = orig.get(k) ?? orig.set(k, { name: row.rawName, hours: 0, pay: 0, konto: 0, gotowka: 0, rateN: null, factories: new Set() }).get(k);
  o.hours += row.hours ?? 0;
  o.pay += row.doWyplaty ?? 0;
  o.konto += row.konto ?? row.ksiegNetto ?? 0;
  o.gotowka += row.gotowka ?? 0;
  if (row.rateNetto != null) o.rateN = row.rateNetto;
  o.factories.add(factory);
}
const JOBS = [
  { name: "lublin-2026-05", city: "Люблін" },
  { name: "poznan-2026-05", city: "Познань" },
  { name: "lodz-es-2026-05", city: "Лодзь", gotowka: "gotowka-es" },
  { name: "lodz-eso-2026-05", city: "Лодзь", gotowka: "gotowka-eso" },
  { name: "lodz-klinex-2026-05", city: "Лодзь", gotowka: "gotowka-klinex" },
];
for (const j of JOBS) {
  const grids = G(j.name);
  const got = j.gotowka ? gotowkaRowsForMonth(G(j.gotowka), "2026-05") : [];
  for (const [t, rows] of grids) {
    if (SKIP.test(t.trim())) continue;
    const parsed = j.city === "Лодзь" ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!parsed) continue;
    if (got.length) overlayGotowka(parsed, got.filter(g => key(g.factory) === key(t) || key(t).startsWith(key(g.factory))));
    for (const r of parsed.rows) { applyLegalDefaults(r, false, { factoryLabel: t }); addOrig(r, t); }
  }
}

// ── сайтова сводна ───────────────────────────────────────────────────────────
const site = new Map();
const rows = await db.select({ r: svodniRowsTable, name: workersTable.fullName })
  .from(svodniRowsTable).leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
  .where(eq(svodniRowsTable.periodMonth, "2026-05"));
for (const { r, name } of rows) {
  const k = key(cleanName(name ?? r.rawName));
  const o = site.get(k) ?? site.set(k, { name: name ?? r.rawName, hours: 0, pay: 0, konto: 0, gotowka: 0, rateN: null, factories: new Set() }).get(k);
  o.hours += r.hours ?? 0;
  o.pay += r.doWyplaty ?? 0;
  o.konto += r.konto ?? r.ksiegNetto ?? 0;
  o.gotowka += r.gotowka ?? 0;
  if (r.rateNetto != null) o.rateN = r.rateNetto;
  o.factories.add(r.factoryLabel);
}

// ── порівняння ───────────────────────────────────────────────────────────────
const sum = (m, f) => r2([...m.values()].reduce((a, x) => a + f(x), 0));
console.log("═══ ПІДСУМКИ ═══");
console.log(`оригінал (Google):  людей ${orig.size}, годин ${sum(orig, x => x.hours)}, до виплати ${sum(orig, x => x.pay)}, конто ${sum(orig, x => x.konto)}, готівка ${sum(orig, x => x.gotowka)}`);
console.log(`сайт (з обліку):    людей ${site.size}, годин ${sum(site, x => x.hours)}, до виплати ${sum(site, x => x.pay)}, конто ${sum(site, x => x.konto)}, готівка ${sum(site, x => x.gotowka)}`);

const onlyOrig = [...orig.entries()].filter(([k]) => !site.has(k));
const onlySite = [...site.entries()].filter(([k]) => !orig.has(k));
console.log(`\n═══ ЛИШЕ В ОРИГІНАЛІ (${onlyOrig.length}) — сумарно годин ${r2(onlyOrig.reduce((a, [, x]) => a + x.hours, 0))}, виплат ${r2(onlyOrig.reduce((a, [, x]) => a + x.pay, 0))} ═══`);
for (const [, x] of onlyOrig.sort((a, b) => b[1].pay - a[1].pay).slice(0, 10))
  console.log(`  ${x.name} — ${r2(x.hours)} год, ${r2(x.pay)} zł (${[...x.factories].join(",")})`);
if (onlyOrig.length > 10) console.log(`  … і ще ${onlyOrig.length - 10}`);
console.log(`\n═══ ЛИШЕ НА САЙТІ (${onlySite.length}) ═══`);
for (const [, x] of onlySite.sort((a, b) => b[1].pay - a[1].pay).slice(0, 10))
  console.log(`  ${x.name} — ${r2(x.hours)} год, ${r2(x.pay)} zł (${[...x.factories].join(",")})`);
if (onlySite.length > 10) console.log(`  … і ще ${onlySite.length - 10}`);

const both = [...orig.keys()].filter(k => site.has(k));
const diffs = both.map(k => {
  const o = orig.get(k), s = site.get(k);
  return { name: o.name, dHours: r2(s.hours - o.hours), dPay: r2(s.pay - o.pay), dKonto: r2(s.konto - o.konto), dGot: r2(s.gotowka - o.gotowka), dRate: o.rateN != null && s.rateN != null ? r2(s.rateN - o.rateN) : null, o, s };
});
const okCount = diffs.filter(d => Math.abs(d.dHours) < 0.5 && Math.abs(d.dPay) < 1).length;
console.log(`\n═══ СПІЛЬНІ: ${both.length}; повністю зійшлись (год ±0.5, виплата ±1 zł): ${okCount} ═══`);
console.log("\n— Топ розбіжностей по «До виплати» (сайт − оригінал):");
for (const d of diffs.filter(d => Math.abs(d.dPay) >= 1).sort((a, b) => Math.abs(b.dPay) - Math.abs(a.dPay)).slice(0, 15))
  console.log(`  ${d.name}: Δвиплата ${d.dPay} zł (Δгод ${d.dHours}, Δставка ${d.dRate ?? "—"}; сайт ${r2(d.s.pay)} vs ориг ${r2(d.o.pay)})`);
console.log("\n— Топ розбіжностей по годинах:");
for (const d of diffs.filter(d => Math.abs(d.dHours) >= 0.5).sort((a, b) => Math.abs(b.dHours) - Math.abs(a.dHours)).slice(0, 10))
  console.log(`  ${d.name}: Δгод ${d.dHours} (сайт ${r2(d.s.hours)} vs ориг ${r2(d.o.hours)})`);
console.log("\n— Розбіжності конто/готівка (при однакових виплатах ±1):");
for (const d of diffs.filter(d => Math.abs(d.dPay) < 1 && (Math.abs(d.dKonto) >= 1 || Math.abs(d.dGot) >= 1)).sort((a, b) => Math.abs(b.dKonto) - Math.abs(a.dKonto)).slice(0, 10))
  console.log(`  ${d.name}: Δконто ${d.dKonto}, Δготівка ${d.dGot} (сайт ${r2(d.s.konto)}/${r2(d.s.gotowka)} vs ориг ${r2(d.o.konto)}/${r2(d.o.gotowka)})`);
await pool.end();

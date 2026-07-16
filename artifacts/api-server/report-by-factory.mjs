// Звіт по фабриках: тотал ЗП / на карту / готівка — сайтова сводна травня vs
// оригінальна таблиця (той самий парсер-пайплайн, у памʼяті).
import { readFileSync } from "node:fs";
import { db, pool, svodniRowsTable, factoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { parseLublinTab, parseLodzFullTab, overlayGotowka, applyLegalDefaults } from "./src/services/svodni.ts";
import { gotowkaRowsForMonth } from "./src/services/svodniSync.ts";
import { key } from "./src/services/payrollSummaries.ts";

const DIR = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/grids";
const G = (n) => new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${n}.json`, "utf8"))));
const SKIP = /GODZIN.*MIES|TOTAL.*MIES|MAILE|WORK ?LIST|NOTATKA|^OFFICE|^ОФИС/i;
const r2 = (n) => Math.round(n * 100) / 100;
const ALIAS = { DEZYNFEKCJA: "SERWISPLUS", ALLMIZ: "ALMIZ" };

// довідник фабрик → мапа "вкладка оригіналу" → назва фабрики сайту
const factories = await db.select().from(factoriesTable);
const facName = (label) => {
  const k = ALIAS[key(label)] ?? key(label);
  const f = factories.find(x => key(x.name) === k) ?? factories.find(x => key(x.name).startsWith(k) || k.startsWith(key(x.name)));
  return f?.name ?? label;
};

const agg = () => ({ pay: 0, konto: 0, got: 0, n: 0 });
const addTo = (m, label, row) => {
  const a = m.get(label) ?? m.set(label, agg()).get(label);
  a.pay += row.doWyplaty ?? 0;
  a.konto += row.konto ?? row.ksiegNetto ?? 0;
  a.got += row.gotowka ?? 0;
  a.n++;
};

// оригінал
const orig = new Map();
const JOBS = [
  ["lublin-2026-05", "L", null], ["poznan-2026-05", "L", null],
  ["lodz-es-2026-05", "Ł", "gotowka-es"], ["lodz-eso-2026-05", "Ł", "gotowka-eso"], ["lodz-klinex-2026-05", "Ł", "gotowka-klinex"],
];
for (const [name, kind, got] of JOBS) {
  const gotRows = got ? gotowkaRowsForMonth(G(got), "2026-05") : [];
  for (const [t, rows] of G(name)) {
    if (SKIP.test(t.trim())) continue;
    const p = kind === "Ł" ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!p) continue;
    if (gotRows.length) overlayGotowka(p, gotRows.filter(g => key(g.factory) === key(t) || key(t).startsWith(key(g.factory))));
    for (const r of p.rows) { applyLegalDefaults(r, false, { factoryLabel: t }); addTo(orig, facName(t), r); }
  }
}
// сайт
const site = new Map();
for (const r of await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.periodMonth, "2026-05"))) {
  addTo(site, r.factoryLabel, r);
}

const labels = [...new Set([...orig.keys(), ...site.keys()])].sort();
const fmt = (v) => String(r2(v)).padStart(10);
const d = (a, b) => { const x = r2(a - b); return Math.abs(x) < 1 ? "     ok" : String(x).padStart(9); };
console.log("фабрика".padEnd(22), "| САЙТ: зп / карта / готівка".padEnd(38), "| ОРИГ: зп / карта / готівка".padEnd(38), "| Δзп / Δкарта / Δготівка");
for (const l of labels) {
  const s = site.get(l) ?? agg(), o = orig.get(l) ?? agg();
  console.log(
    l.slice(0, 21).padEnd(22),
    `|${fmt(s.pay)} ${fmt(s.konto)} ${fmt(s.got)}  `,
    `|${fmt(o.pay)} ${fmt(o.konto)} ${fmt(o.got)}  `,
    `|${d(s.pay, o.pay)} ${d(s.konto, o.konto)} ${d(s.got, o.got)}`,
  );
}
const ts = [...site.values()].reduce((a, x) => ({ pay: a.pay + x.pay, konto: a.konto + x.konto, got: a.got + x.got }), { pay: 0, konto: 0, got: 0 });
const to = [...orig.values()].reduce((a, x) => ({ pay: a.pay + x.pay, konto: a.konto + x.konto, got: a.got + x.got }), { pay: 0, konto: 0, got: 0 });
console.log("РАЗОМ".padEnd(22), `|${fmt(ts.pay)} ${fmt(ts.konto)} ${fmt(ts.got)}  `, `|${fmt(to.pay)} ${fmt(to.konto)} ${fmt(to.got)}  `, `|${d(ts.pay, to.pay)} ${d(ts.konto, to.konto)} ${d(ts.got, to.got)}`);
await pool.end();

// Легальність «за місяць сводної» (рішення власника 20.09.2026, кейс Svyrydiuk 08.2026): статус
// для виплат у рядку сводної місяця M рахується станом на кінець M (документи перебування/праці
// чинні тоді), а вісь «умова» зелена, якщо підписана умова перекриває хоч один день M — умова,
// що закінчилась 21.08, не робить серпень «не зголошеним». Для поточного/майбутнього місяця —
// як звичайно, на сьогодні.
//
// Це САНКЦІОНОВАНИЙ міст payroll-коду до движка (routes/svodni.ts, services/svodniSync.ts
// імпортують лише цей модуль): він нічого не пише — ні в worker_legality, ні в workers.legal_status
// (payroll-інваріант, legality.guard.test.ts), повертає ту ж форму, що кеш (LegalityCacheLike).
import { loadLegalityInput, loadLegalRules } from "./legalityRecompute";
import { computeLegality, type LegalityEmployer } from "./legality";
import { db, factoriesTable, companiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { warsawToday } from "./tasks";
import type { LegalityCacheLike } from "./effectiveStatus";
import { logger } from "../lib/logger";

export function monthWindow(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate(); // день 0 наступного місяця = останній день M
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

// factoryId (рішення власника 01.10.2026): статус рядка сводної — по ФАБРИЦІ рядка. Движок
// звіряє лише цього роботодавця (умова на цю фабрику, обовʼязки її фірми); перебування і
// документи — як завжди. Фабрики нема в профілі (людина в графіку чужої фабрики) — беремо її з
// довідника з фірмою фабрики: умови на неї нема → неоформлений. Ручний статус — фолбек, однаковий
// для всіх рядків людини (на старі ручні статуси вибір фабрики не впливає).
export type MonthLegality = LegalityCacheLike & { contract: string };
export async function legalityForMonth(workerId: number, month: string, rules = loadLegalRules(), factoryId?: number | null): Promise<MonthLegality | null> {
  const win = monthWindow(month);
  const today = warsawToday();
  const asOf = win.to < today ? win.to : today; // минулий місяць — на його кінець; поточний — на сьогодні
  const input = await loadLegalityInput(workerId, asOf, await rules);
  if (!input) return null;
  input.window = win;
  if (factoryId != null && input.employers) {
    const mine = input.employers.find(e => e.factoryId === factoryId);
    input.employers = mine ? [{ ...mine, primary: true }] : [await employerFromFactory(factoryId)];
    if (input.facts) input.facts = { ...input.facts, scheduleFactories: [] }; // підказка «зміни поза фабриками» тут не до речі
  }
  const r = computeLegality(input);
  return { overall: r.overall, derivedLegalStatus: r.legacy.derivedLegalStatus, legacyMismatchKind: r.legacy.legacyMismatchKind, contract: r.contract.status };
}

// Профіль: статус для виплат по кожній фабриці людини за поточний місяць (те, що потрапить у
// рядки сводної). Одна фабрика — порожньо (загальний статус і так той самий).
export async function payrollByFactory(workerId: number): Promise<{ factoryId: number; factoryName: string | null; companyName: string | null; status: string | null; source: string; contract: string }[]> {
  const { loadWorkerEmployers } = await import("./legalityRecompute");
  const { resolveEffectiveLegal } = await import("./effectiveStatus");
  const { workersTable } = await import("@workspace/db");
  const [w] = await db.select({ id: workersTable.id, factoryId: workersTable.factoryId, legalStatus: workersTable.legalStatus }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return [];
  const employers = await loadWorkerEmployers(w, warsawToday());
  if (employers.length < 2) return [];
  const month = warsawToday().slice(0, 7);
  const rules = loadLegalRules();
  const out = [];
  for (const e of employers) {
    const c = await legalityForMonth(workerId, month, rules, e.factoryId);
    const eff = resolveEffectiveLegal(w, c);
    out.push({ factoryId: e.factoryId, factoryName: e.factoryName, companyName: e.companyName, status: eff.status, source: eff.source, contract: c?.contract ?? "unknown" });
  }
  return out;
}

async function employerFromFactory(factoryId: number): Promise<LegalityEmployer> {
  const [f] = await db.select({ id: factoriesTable.id, name: factoriesTable.name, companyId: factoriesTable.companyId, companyName: companiesTable.name })
    .from(factoriesTable).leftJoin(companiesTable, eq(factoriesTable.companyId, companiesTable.id)).where(eq(factoriesTable.id, factoryId));
  return { factoryId, factoryName: f?.name ?? null, companyId: f?.companyId ?? null, companyName: f?.companyName ?? null, primary: true };
}

// Пари людина×фабрика → кеш-подібний зріз по рядку сводної. Ключ — pairKey(workerId, factoryId);
// factoryId null (вкладка без фабрики в довіднику) — звичайний статус людини.
export const pairKey = (workerId: number, factoryId: number | null | undefined) => `${workerId}|${factoryId ?? ""}`;
export async function loadLegalityCacheForMonthByFactory(pairs: { workerId: number; factoryId: number | null }[], month: string): Promise<Map<string, LegalityCacheLike>> {
  const out = new Map<string, LegalityCacheLike>();
  if (!/^\d{4}-\d{2}$/.test(month)) return out;
  const rules = loadLegalRules();
  const seen = new Set<string>();
  for (const p of pairs) {
    if (!Number.isFinite(p.workerId)) continue;
    const k = pairKey(p.workerId, p.factoryId);
    if (seen.has(k)) continue; seen.add(k);
    try { const c = await legalityForMonth(p.workerId, month, rules, p.factoryId); if (c) out.set(k, c); }
    catch (e: any) { logger.warn({ err: e?.message, workerId: p.workerId, factoryId: p.factoryId, month }, "legality for month/factory failed"); }
  }
  return out;
}

// Дзеркало effectiveStatus.loadLegalityCache, але за місяць: Map workerId → кеш-подібний зріз.
export async function loadLegalityCacheForMonth(workerIds: number[], month: string): Promise<Map<number, LegalityCacheLike>> {
  const out = new Map<number, LegalityCacheLike>();
  const ids = [...new Set(workerIds)].filter(id => Number.isFinite(id));
  if (!ids.length || !/^\d{4}-\d{2}$/.test(month)) return out;
  const rules = loadLegalRules();
  for (const id of ids) {
    try { const c = await legalityForMonth(id, month, rules); if (c) out.set(id, c); }
    catch (e: any) { logger.warn({ err: e?.message, workerId: id, month }, "legality for month failed"); }
  }
  return out;
}

// Лінивий кеш по парах для імпорту сводної (вкладок багато, людей — сотні: рахуємо лише те, що трапилось).
export function legalityPairMemo(month: string) {
  const memo = new Map<string, Promise<MonthLegality | null>>();
  const rules = loadLegalRules();
  return (workerId: number, factoryId: number | null | undefined): Promise<MonthLegality | null> => {
    const k = pairKey(workerId, factoryId);
    let p = memo.get(k);
    if (!p) {
      p = legalityForMonth(workerId, month, rules, factoryId ?? null).catch((e: any) => { logger.warn({ err: e?.message, workerId, factoryId, month }, "legality for month/factory failed"); return null; });
      memo.set(k, p);
    }
    return p;
  };
}

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
import { computeLegality } from "./legality";
import { warsawToday } from "./tasks";
import type { LegalityCacheLike } from "./effectiveStatus";
import { logger } from "../lib/logger";

export function monthWindow(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate(); // день 0 наступного місяця = останній день M
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export async function legalityForMonth(workerId: number, month: string, rules = loadLegalRules()): Promise<LegalityCacheLike | null> {
  const win = monthWindow(month);
  const today = warsawToday();
  const asOf = win.to < today ? win.to : today; // минулий місяць — на його кінець; поточний — на сьогодні
  const input = await loadLegalityInput(workerId, asOf, await rules);
  if (!input) return null;
  input.window = win;
  const r = computeLegality(input);
  return { overall: r.overall, derivedLegalStatus: r.legacy.derivedLegalStatus, legacyMismatchKind: r.legacy.legacyMismatchKind };
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

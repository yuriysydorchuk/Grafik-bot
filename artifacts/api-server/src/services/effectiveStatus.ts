// Ефективний статус легалізації для виплат — рішення власника 06.09.2026.
//
// Правило: якщо людина ПОВНІСТЮ оформлена за новими даними (перебування + праця +
// чинна умова зелені або спливають) і движок має однозначну пропозицію статусу —
// група виплат береться з документів (source=documents). Інакше — старе ручне поле
// «Форма легалізації» (manual); порожнє = «не зголошений» (none, група A).
//
// Цей модуль — ЄДИНА точка, через яку payroll-код (сводна, облік годин, список
// працівників) дізнається статус. Він НЕ імпортує движок (гард legality.guard.test.ts):
// читає лише кеш worker_legality, який движок заповнює після перерахунку.
// workers.legal_status лишається ручним і движком не пишеться (payroll-інваріант).
import { db, workerLegalityTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { normalizeProfileLegal } from "./svodni";

export type EffectiveSource = "documents" | "manual" | "none";
export interface EffectiveLegal { status: string | null; source: EffectiveSource }
export interface LegalityCacheLike { overall: string; derivedLegalStatus: string | null; legacyMismatchKind: string }

const FULLY_LEGAL = new Set(["legal", "expiring"]);

export function resolveEffectiveLegal(worker: { legalStatus: string | null }, cache: LegalityCacheLike | null | undefined): EffectiveLegal {
  if (cache && FULLY_LEGAL.has(cache.overall) && cache.derivedLegalStatus && cache.legacyMismatchKind !== "no_proposal") {
    const s = normalizeProfileLegal(cache.derivedLegalStatus) ?? cache.derivedLegalStatus;
    return { status: s, source: "documents" };
  }
  const manual = normalizeProfileLegal(worker.legalStatus) ?? null;
  return manual ? { status: manual, source: "manual" } : { status: null, source: "none" };
}

// Студент для виплат: за документами — лише коли статус із документів «student»
// (довідка + вік до 26 уже враховані движком); вручну — старий канон
// (чекбокс is_student АБО legal_status='student').
export function effectiveStudent(worker: { isStudent: boolean | null; legalStatus: string | null }, eff: EffectiveLegal): boolean {
  if (eff.source === "documents") return eff.status === "student";
  return !!(worker.isStudent || normalizeProfileLegal(worker.legalStatus) === "student");
}

// «Ефективний вигляд» профілю для payroll-коду: legalStatus/isStudent підмінені
// ефективними, решта полів — як є. Payroll-хелпери (resolveBaseRates, applyLegalDefaults,
// stud26Of…) далі читають w.legalStatus/w.isStudent і не знають про джерело.
export type WithEffective<W> = W & { legalSource: EffectiveSource; manualLegalStatus: string | null };
export function effectiveView<W extends { legalStatus: string | null; isStudent: boolean | null }>(w: W, cache: LegalityCacheLike | null | undefined): WithEffective<W> {
  const eff = resolveEffectiveLegal(w, cache);
  return { ...w, manualLegalStatus: w.legalStatus, legalStatus: eff.status, isStudent: effectiveStudent(w, eff), legalSource: eff.source };
}

export async function loadLegalityCache(workerIds: number[]): Promise<Map<number, LegalityCacheLike>> {
  const ids = [...new Set(workerIds)].filter(id => Number.isFinite(id));
  if (!ids.length) return new Map();
  const rows = await db.select({
    workerId: workerLegalityTable.workerId, overall: workerLegalityTable.overall,
    derivedLegalStatus: workerLegalityTable.derivedLegalStatus, legacyMismatchKind: workerLegalityTable.legacyMismatchKind,
  }).from(workerLegalityTable).where(inArray(workerLegalityTable.workerId, ids));
  return new Map(rows.map(r => [r.workerId, { overall: r.overall, derivedLegalStatus: r.derivedLegalStatus, legacyMismatchKind: r.legacyMismatchKind }]));
}

export async function effectiveViewOf<W extends { id: number; legalStatus: string | null; isStudent: boolean | null }>(w: W): Promise<WithEffective<W>> {
  const cache = await loadLegalityCache([w.id]);
  return effectiveView(w, cache.get(w.id));
}

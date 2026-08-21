// Штрафи за пропуски змін — спільний канон для /absences (admin-api) і
// перенесення в Kara сводної (routes/svodni).
// Стандартний штраф за пропуск, zł (override per-пропуск — schedule_entries.absence_penalty)
export const DEFAULT_ABSENCE_PENALTY = 200;

// Ефективний штраф пропуску: виправданий = 0, інакше override ?? стандарт.
export const absencePenaltyOf = (e: { absenceExcused: boolean | null; absencePenalty: number | null }) =>
  e.absenceExcused ? 0 : (e.absencePenalty ?? DEFAULT_ABSENCE_PENALTY);

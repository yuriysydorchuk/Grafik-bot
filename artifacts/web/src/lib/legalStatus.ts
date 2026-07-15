// Форма легалізації працівника — канонічні статуси.
// Дзеркало каталогу LEGAL_STATUSES у api-server/src/services/svodni.ts — тримати синхронними.
// Вік («до 26 / після») — окрема властивість профілю (дата народження / under26),
// НЕ форма легалізації, тому тут його немає.
export const LEGAL_STATUSES = ["student", "dyplom", "powiadomienie", "zus", "oczekuje", "karta_pobytu", "staly_pobyt", "polak"] as const;
export type LegalStatus = (typeof LEGAL_STATUSES)[number];

// повна назва (профіль) + компактний бейдж для сводної (класи — літерали, Tailwind v4)
export const LEGAL_LABEL: Record<LegalStatus, string> = {
  student: "Студент",
  dyplom: "Диплом",
  powiadomienie: "Powiadomienie (зголошений повідомленням)",
  zus: "Повний ZUS (zgłoszony)",
  oczekuje: "Не зголошений (чекає дозвіл)",
  karta_pobytu: "Decyzja Karty Pobytu",
  staly_pobyt: "Stały pobyt",
  polak: "Поляк / Полька",
};
export const LEGAL_BADGE: Record<LegalStatus, { short: string; cls: string } | null> = {
  student: { short: "STUD", cls: "bg-sky-50 text-sky-700" },
  dyplom: { short: "DYP", cls: "bg-violet-50 text-violet-700" },
  powiadomienie: { short: "POW", cls: "bg-emerald-50 text-emerald-700" },
  zus: null, // стандартний випадок — без бейджа
  oczekuje: { short: "NZ", cls: "bg-rose-50 text-rose-700" },
  karta_pobytu: { short: "KP", cls: "bg-slate-100 text-slate-600" },
  staly_pobyt: { short: "SP", cls: "bg-slate-100 text-slate-600" },
  polak: { short: "PL", cls: "bg-slate-100 text-slate-600" },
};

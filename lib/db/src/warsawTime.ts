// Єдина конвенція часу в БД: колонки `timestamp` (без пояса) зберігають НАСТІННИЙ час
// Europe/Warsaw (рішення власника 09.10.2026 «у нас стандартно час по Варшаві»).
//
// Чому це тут: Drizzle за замовчуванням пише JS Date як toISOString() (UTC-настінний) і
// читає збережене як UTC, тоді як DB-дефолти now()/defaultNow() пишуть настінний час сесії
// (Europe/Berlin на проді = Warsaw). Результат — у одній таблиці created_at (БД) і
// updated_at (JS) лежали в різних поясах, різниця 1–2 год (інцидент hire_zus 09.10.2026:
// «документ внесено після задачі» спрацьовувало з 2-год лагом). Тут мапінг обох напрямків
// перевизначається на Warsaw-настінний для КОЖНОЇ timestamp-колонки схеми, а сесія Postgres
// примусово ставиться в Europe/Warsaw (lib/db/src/index.ts), тож now() у SQL, DB-дефолти,
// JS-дати через Drizzle і сирі Date-параметри (pg серіалізує з локальним офсетом процесу,
// TZ процесу теж Warsaw — artifacts/api-server/src/index.ts) — усе в одному поясі.
// Колонки `timestamp with time zone` не чіпаються (їх 2, Drizzle мапить коректно).
import { is, getTableColumns, Table } from "drizzle-orm";
import { PgTimestamp } from "drizzle-orm/pg-core";

export const DB_TIME_ZONE = "Europe/Warsaw";

const DTF = new Intl.DateTimeFormat("en-US", {
  timeZone: DB_TIME_ZONE, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

// Поля настінного часу в Europe/Warsaw для моменту `d` (без мілісекунд).
function wallParts(d: Date): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const part of DTF.formatToParts(d)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

// Офсет пояса (мс) для моменту `t`: настінний-як-UTC мінус сам момент.
function offsetAt(t: number): number {
  const w = wallParts(new Date(t));
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(t / 1000) * 1000;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Момент → настінний рядок Europe/Warsaw `YYYY-MM-DD HH:mm:ss.SSS` (формат, який приймає `timestamp`). */
export function toWarsawWall(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new RangeError("Invalid Date");
  const w = wallParts(d);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/**
 * Настінний рядок Postgres (`YYYY-MM-DD HH:mm:ss[.ffffff]`, також з `T`; БЕЗ суфікса пояса —
 * `timestamp` його не зберігає) → момент, трактуючи рядок як Europe/Warsaw. Переходи DST: неіснуюча година весни
 * (02:30 29.03) зсувається вперед, двозначна осіння (02:30 25.10) — перша, літня (ранніший момент).
 */
export function fromWarsawWall(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/.exec(value);
  if (!m) return new Date(value); // є суфікс пояса (Z/+02) чи інший формат — хай JS розбирає як уміє
  const ms = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0; // мікросекунди ВІДКИДАЄМО (округлення .999999 перекидало секунду)
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), ms);
  // Кандидати — офсети до й після цього настінного часу (±3 год покриває будь-який перехід DST);
  // валідний той, що відтворює себе; двозначна осіння година → ранніший момент (літній офсет);
  // неіснуюча весняна → офсет «до переходу» (02:30 → 03:30 CEST).
  const offs = [...new Set([offsetAt(naive - 3 * 3600_000), offsetAt(naive + 3 * 3600_000)])];
  const valid = offs.map(off => naive - off).filter(t => offsetAt(t) === naive - t);
  return new Date(valid.length ? Math.min(...valid) : naive - offs[0]!);
}

/**
 * Перевизначає мапінг усіх `timestamp` (без пояса) колонок переданих таблиць на
 * Warsaw-настінний. Викликається один раз при створенні клієнта (lib/db/src/index.ts).
 * mapToDriverValue у Drizzle — instance-поле (стрілка), тож патчити треба інстанси, не прототип.
 */
export function applyWarsawTimestamps(tables: Record<string, unknown>): number {
  let n = 0;
  for (const t of Object.values(tables)) {
    if (!is(t, Table)) continue; // `_` у Table — лише тип, runtime-перевірка тільки через is()
    const cols = getTableColumns(t) as Record<string, unknown>;
    for (const col of Object.values(cols)) {
      if (!is(col, PgTimestamp) || (col as PgTimestamp<any>).withTimezone) continue;
      const c = col as PgTimestamp<any> & { mapToDriverValue: (v: Date) => string; mapFromDriverValue: (v: unknown) => Date };
      c.mapToDriverValue = (v: Date) => toWarsawWall(v);
      c.mapFromDriverValue = (v: unknown) => (typeof v === "string" ? fromWarsawWall(v) : (v as Date));
      n++;
    }
  }
  return n;
}

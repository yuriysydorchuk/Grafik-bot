// Звірка «полів-двійників» — сторож канону джерел правди:
//   • вік: workers.birth_date — канон, прапорець under26 — лише фолбек без дати;
//   • студент: legal_status="student" АБО чекбокс is_student;
//   • місто фабрики: factories.city (далі історія сводних → регіони «Зарплат»).
// Дрейф (прапорець суперечить даті, студент без дати, активна фабрика без міста)
// не ламає розрахунки одразу, але тихо розсинхронізовує сторінки — тому його
// показує дашборд («Потребує уваги») і щоденний cron-алерт у бот.
import { db, workersTable, factoriesTable } from "@workspace/db";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { isUnder26 } from "./svodniSync";

export interface DataDrift {
  /** прапорець «до 26» суперечить віку з дати народження (активні) */
  under26Drift: { id: number; fullName: string }[];
  /** студент (чекбокс або legal_status) без дати народження (активні) */
  studentNoBirthDate: { id: number; fullName: string }[];
  /** фабрика з активними працівниками, але без міста в профілі */
  factoryNoCity: { id: number; name: string }[];
}

export async function findDataDrift(): Promise<DataDrift> {
  const withBirth = await db.select({ id: workersTable.id, fullName: workersTable.fullName, birthDate: workersTable.birthDate, under26: workersTable.under26 })
    .from(workersTable).where(and(eq(workersTable.isActive, true), isNotNull(workersTable.birthDate)));
  const under26Drift = withBirth
    .filter(w => isUnder26(String(w.birthDate)) !== !!w.under26)
    .map(w => ({ id: w.id, fullName: w.fullName }));

  const studentNoBirthDate = (await db.select({ id: workersTable.id, fullName: workersTable.fullName })
    .from(workersTable)
    .where(and(
      eq(workersTable.isActive, true), sql`${workersTable.birthDate} IS NULL`,
      or(eq(workersTable.isStudent, true), eq(workersTable.legalStatus, "student")),
    )));

  // «жива» фабрика = має хоч одного активного працівника (таблиця factories
  // не має is_active; мертві/тестові рядки без людей не шумлять в алерті)
  const factoryNoCity = (await db.select({ id: factoriesTable.id, name: factoriesTable.name })
    .from(factoriesTable)
    .where(and(
      sql`COALESCE(TRIM(${factoriesTable.city}), '') = ''`,
      sql`EXISTS (SELECT 1 FROM ${workersTable} w WHERE w.factory_id = ${factoriesTable.id} AND w.is_active)`,
    )));

  return { under26Drift, studentNoBirthDate, factoryNoCity };
}

export const driftTotal = (d: DataDrift): number =>
  d.under26Drift.length + d.studentNoBirthDate.length + d.factoryNoCity.length;

/** Короткий текст для алерта в бот; null — коли дрейфу нема. */
export function driftSummary(d: DataDrift): string | null {
  if (!driftTotal(d)) return null;
  const names = (xs: { fullName?: string; name?: string }[]) =>
    xs.slice(0, 5).map(x => x.fullName ?? x.name).join(", ") + (xs.length > 5 ? ` +${xs.length - 5}` : "");
  const parts: string[] = [];
  if (d.under26Drift.length) parts.push(`прапорець «до 26» суперечить даті народження (${d.under26Drift.length}): ${names(d.under26Drift)}`);
  if (d.studentNoBirthDate.length) parts.push(`студенти без дати народження (${d.studentNoBirthDate.length}): ${names(d.studentNoBirthDate)}`);
  if (d.factoryNoCity.length) parts.push(`фабрики без міста (${d.factoryNoCity.length}): ${names(d.factoryNoCity)}`);
  return parts.join(" · ");
}

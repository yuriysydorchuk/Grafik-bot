import { db, workersTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// Наступний вільний публічний номер працівника (worker_code) — продовження
// числової послідовності. Показовий ідентифікатор, НЕ секрет привʼязки Telegram.
export async function nextWorkerCode(): Promise<string> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${workersTable.workerCode}::int), 0)` })
    .from(workersTable)
    .where(sql`${workersTable.workerCode} ~ '^[0-9]+$'`);
  return String((row?.max ?? 0) + 1).padStart(5, "0");
}

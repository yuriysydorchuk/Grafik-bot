import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";
import { applyWarsawTimestamps, DB_TIME_ZONE } from "./warsawTime.ts";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Сесія Postgres завжди в Europe/Warsaw (now()/defaultNow() = варшавський настінний час),
// усі `timestamp`-колонки мапляться в тому ж поясі — див. warsawTime.ts.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c timezone=${DB_TIME_ZONE}` });
applyWarsawTimestamps(schema);
export const db = drizzle(pool, { schema });

export * from "./schema/index.ts";
export { DB_TIME_ZONE, toWarsawWall, fromWarsawWall } from "./warsawTime.ts";

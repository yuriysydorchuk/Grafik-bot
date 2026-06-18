import { db } from "@workspace/db";
import { userStatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export type PendingState = { action: string; data: Record<string, any> };

// In-memory cache (fast, sync API) with write-through persistence to DB.
// Persistence lets conversation state survive bot restarts/deploys.
const pending = new Map<string, PendingState>();

// Load all persisted states into the cache at startup.
export async function loadStates(): Promise<void> {
  try {
    const rows = await db.select().from(userStatesTable);
    for (const r of rows) {
      pending.set(r.telegramId, { action: r.action, data: (r.data ?? {}) as Record<string, any> });
    }
    logger.info({ count: rows.length }, "Loaded persisted conversation states");
  } catch (e) {
    logger.error({ err: e }, "Failed to load persisted states (continuing with empty cache)");
  }
}

export const setState = (id: string, action: string, data: Record<string, any> = {}) => {
  pending.set(id, { action, data });
  // Write-through (fire-and-forget); cache is the source of truth at runtime
  db.insert(userStatesTable)
    .values({ telegramId: id, action, data, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userStatesTable.telegramId, set: { action, data, updatedAt: new Date() } })
    .catch((e) => logger.error({ err: e, id, action }, "Failed to persist state"));
};

export const getState = (id: string) => pending.get(id);

export const clearState = (id: string) => {
  pending.delete(id);
  db.delete(userStatesTable).where(eq(userStatesTable.telegramId, id))
    .catch((e) => logger.error({ err: e, id }, "Failed to clear persisted state"));
};

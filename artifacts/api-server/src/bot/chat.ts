import { db } from "@workspace/db";
import { botMessagesTable, workersTable } from "@workspace/db";
import { eq, inArray, lt } from "drizzle-orm";
import { bot } from "./instance";
import { logger } from "../lib/logger";

// Telegram only lets a bot delete messages younger than 48h.
const DELETABLE_MS = 48 * 60 * 60 * 1000;

// Record a message (sent or received) in a private chat for later bulk deletion.
export function recordBotMessage(chatId: string, messageId: number): void {
  // fire-and-forget; never block the bot on bookkeeping
  db.insert(botMessagesTable).values({ chatId, messageId }).catch(() => {});
}

// Delete all tracked messages (< 48h) for the given chats (default: all active workers).
// Returns how many messages were deleted and for how many chats.
export async function clearRecentChats(chatIds?: string[]): Promise<{ deleted: number; chats: number; skippedOld: number }> {
  let targets = chatIds;
  if (!targets) {
    const workers = await db.select({ tid: workersTable.telegramId }).from(workersTable)
      .where(eq(workersTable.isActive, true));
    targets = workers.map(w => w.tid).filter((t): t is string => !!t);
  }
  if (targets.length === 0) return { deleted: 0, chats: 0, skippedOld: 0 };

  const cutoff = new Date(Date.now() - DELETABLE_MS);
  let deleted = 0, skippedOld = 0;
  const touched = new Set<string>();

  const rows = await db.select().from(botMessagesTable).where(inArray(botMessagesTable.chatId, targets));
  for (const r of rows) {
    if (r.createdAt.getTime() < cutoff.getTime()) { skippedOld++; continue; }
    try {
      await bot.telegram.deleteMessage(r.chatId, r.messageId);
      deleted++;
      touched.add(r.chatId);
    } catch { /* already gone / too old / blocked — ignore */ }
    // remove the row regardless (it's either gone now or undeletable)
    await db.delete(botMessagesTable).where(eq(botMessagesTable.id, r.id)).catch(() => {});
  }
  return { deleted, chats: touched.size, skippedOld };
}

// Housekeeping: drop tracking rows older than 48h (they can never be deleted anyway).
export async function pruneOldMessageRows(): Promise<void> {
  const cutoff = new Date(Date.now() - DELETABLE_MS);
  await db.delete(botMessagesTable).where(lt(botMessagesTable.createdAt, cutoff)).catch(() => {});
}

// One-time monkeypatch: capture every outgoing sendMessage (incl. ctx.reply, which
// routes through telegram.sendMessage) so we can later delete it.
let patched = false;
export function installChatTracking(): void {
  if (patched) return;
  patched = true;
  const orig = bot.telegram.sendMessage.bind(bot.telegram);
  bot.telegram.sendMessage = (async (chatId: any, text: any, extra: any) => {
    const m = await orig(chatId, text, extra);
    try {
      const cid = String(chatId);
      // only private chats (worker/driver/admin DMs) — they're numeric ids, not @channels
      if (/^-?\d+$/.test(cid)) recordBotMessage(cid, (m as any).message_id);
    } catch { /* ignore */ }
    return m;
  }) as typeof bot.telegram.sendMessage;
  logger.info("Chat tracking installed");
}

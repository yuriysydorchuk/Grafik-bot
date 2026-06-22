import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { db, funnelsTable, candidatesTable, type FunnelStage } from "@workspace/db";
import { logger } from "../lib/logger";

// Canonical stages of the built-in referral funnel. The KEYS are load-bearing —
// convert/bonus logic depends on "hired"; the bot creates referral candidates at
// "new". Labels/colours are cosmetic (the web Kanban renders them).
const REFERRAL_STAGES: FunnelStage[] = [
  { key: "new", color: "blue", label: "🆕 Нові заявки" },
  { key: "contacted", color: "amber", label: "📞 Зв'язалися" },
  { key: "interview", color: "violet", label: "🤝 Співбесіда" },
  { key: "hired", color: "emerald", label: "✅ Працюють" },
  { key: "rejected", color: "slate", label: "❌ Відмова" },
];

// The referral funnel is built-in and must always exist — otherwise referral
// candidates land with funnel_id = null and never show on the recruitment board.
// Find it, or create it (idempotent). Returns its id.
export async function ensureReferralFunnel(): Promise<number> {
  const existing = (await db.select({ id: funnelsTable.id }).from(funnelsTable).where(eq(funnelsTable.kind, "referral")))[0];
  if (existing) return existing.id;
  const [created] = await db.insert(funnelsTable)
    .values({ name: "Реферали", kind: "referral", stages: REFERRAL_STAGES, sortOrder: 0 })
    .returning({ id: funnelsTable.id });
  logger.info({ funnelId: created!.id }, "Created built-in referral funnel");
  return created!.id;
}

// Self-heal: referral candidates created before the funnel existed (or before the
// bot set funnel_id) have funnel_id = null and never appear on the board. Attach
// them to the referral funnel. Idempotent — does nothing once none are orphaned.
export async function backfillOrphanReferralCandidates(funnelId: number): Promise<number> {
  const fixed = await db.update(candidatesTable)
    .set({ funnelId })
    .where(and(isNull(candidatesTable.funnelId), isNotNull(candidatesTable.referrerWorkerId)))
    .returning({ id: candidatesTable.id });
  if (fixed.length) logger.info({ count: fixed.length }, "Backfilled orphan referral candidates into referral funnel");
  return fixed.length;
}

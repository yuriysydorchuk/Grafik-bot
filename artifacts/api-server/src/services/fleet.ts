// Автопарк: сплив страховки (UBEZP) і техогляду (TO).
// Список використовують сторінка «Автопарк» (GET /fleet/alerts) і щотижневий крон,
// який шле нагадування головному водієві та головному адміну в бот.
import { db } from "@workspace/db";
import { vehiclesTable, driversTable, adminsTable } from "@workspace/db";
import { and, eq, isNotNull, lte, or } from "drizzle-orm";
import { warsawDateStr } from "../bot/time";
import { logger } from "../lib/logger";

// YYYY-MM-DD + N днів (рядкова арифметика — без toISOString, прод у Europe/Berlin)
export function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export type FleetExpiryRow = {
  id: number; plate: string; brandModel: string | null; city: string | null;
  insuranceUntil: string | null; inspectionUntil: string | null;
  insuranceExpired: boolean; insuranceSoon: boolean;
  inspectionExpired: boolean; inspectionSoon: boolean;
};

export async function fleetExpiryList(days: number): Promise<FleetExpiryRow[]> {
  const today = warsawDateStr();
  const limit = addDaysStr(today, days);
  const rows = await db.select().from(vehiclesTable)
    .where(and(
      eq(vehiclesTable.isActive, true), eq(vehiclesTable.status, "active"),
      or(
        and(isNotNull(vehiclesTable.insuranceUntil), lte(vehiclesTable.insuranceUntil, limit)),
        and(isNotNull(vehiclesTable.inspectionUntil), lte(vehiclesTable.inspectionUntil, limit)),
      ),
    ))
    .orderBy(vehiclesTable.plate);
  return rows.map((v) => ({
    id: v.id, plate: v.plate, brandModel: v.brandModel, city: v.city,
    insuranceUntil: v.insuranceUntil, inspectionUntil: v.inspectionUntil,
    insuranceExpired: v.insuranceUntil != null && v.insuranceUntil < today,
    insuranceSoon: v.insuranceUntil != null && v.insuranceUntil >= today && v.insuranceUntil <= limit,
    inspectionExpired: v.inspectionUntil != null && v.inspectionUntil < today,
    inspectionSoon: v.inspectionUntil != null && v.inspectionUntil >= today && v.inspectionUntil <= limit,
  })).filter((v) => v.insuranceExpired || v.insuranceSoon || v.inspectionExpired || v.inspectionSoon);
}

const dmy = (d: string | null) => (d ? d.split("-").reverse().join(".") : "—");

// Щотижневе нагадування (пн 08:00 Warsaw): головному водієві + головному адміну.
// Best-effort: помилки відправки не валять крон.
export async function notifyFleetExpiry(): Promise<void> {
  const rows = await fleetExpiryList(30);
  if (!rows.length) return;
  const lines = rows.map((v) => {
    const parts: string[] = [];
    if (v.insuranceExpired) parts.push(`❌ страховка збігла ${dmy(v.insuranceUntil)}`);
    else if (v.insuranceSoon) parts.push(`⚠️ страховка до ${dmy(v.insuranceUntil)}`);
    if (v.inspectionExpired) parts.push(`❌ техогляд збіг ${dmy(v.inspectionUntil)}`);
    else if (v.inspectionSoon) parts.push(`⚠️ техогляд до ${dmy(v.inspectionUntil)}`);
    return `🚙 ${v.brandModel ?? ""} ${v.plate}${v.city ? ` (${v.city})` : ""}\n   ${parts.join(" · ")}`;
  });
  const msg = `📋 Документи авто — потребують уваги:\n\n${lines.join("\n")}`;

  const { bot } = await import("../bot");
  const heads = await db.select().from(driversTable)
    .where(and(eq(driversTable.isHeadDriver, true), eq(driversTable.isActive, true)));
  const mains = await db.select().from(adminsTable).where(eq(adminsTable.isMain, true));
  const chatIds = new Set<string>();
  for (const h of heads) if (h.telegramId) chatIds.add(String(h.telegramId));
  for (const a of mains) if (a.telegramId) chatIds.add(String(a.telegramId));
  for (const chatId of chatIds) {
    try { await bot.telegram.sendMessage(chatId, msg); }
    catch (e: any) { logger.warn({ err: e?.message, chatId }, "fleet expiry alert send failed"); }
  }
  logger.info({ vehicles: rows.length, recipients: chatIds.size }, "Fleet expiry alert sent");
}

// Налаштування сводних: мінімальна ставка року (księgowa пара нетто/брутто).
// Зберігається в settings (key = ksieg_min_rates), кешується в services/svodni
// через setKsiegStd — формули беруть її синхронно.
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { setKsiegStd, KSIEG_STD_NETTO, KSIEG_STD_BRUTTO } from "./svodni";
import { logger } from "../lib/logger";

const KEY = "ksieg_min_rates";

export async function loadKsiegMinRates(): Promise<void> {
  try {
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, KEY));
    if (!row) return;
    const v = JSON.parse(row.value);
    setKsiegStd(Number(v.netto), Number(v.brutto));
  } catch (err) {
    logger.warn({ err }, "ksieg min rates load failed — using defaults");
  }
}

export async function saveKsiegMinRates(netto: number, brutto: number): Promise<void> {
  setKsiegStd(netto, brutto);
  const value = JSON.stringify({ netto: KSIEG_STD_NETTO(), brutto: KSIEG_STD_BRUTTO() });
  await db.insert(settingsTable).values({ key: KEY, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
}

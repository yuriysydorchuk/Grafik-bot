// Строки легалізації для підсвітки в UI — єдине джерело: правило defaults.lead_days
// (GET /legalization/globals): warn = жовта зона (типово 24 дн.), urgent = червона (7 дн.).
import { useQuery } from "@tanstack/react-query";
import { get, type LegalizationGlobals } from "./api";

export interface LeadDays { warn: number; urgent: number }
export const DEFAULT_LEAD_DAYS: LeadDays = { warn: 24, urgent: 7 };

// кеш для чистих хелперів поза React (docTone у профілі) — оновлюється кожним useLeadDays
export let leadDaysCache: LeadDays = DEFAULT_LEAD_DAYS;
export function useLeadDays(): LeadDays {
  const { data } = useQuery<LegalizationGlobals>({ queryKey: ["legalization-globals"], queryFn: () => get("/legalization/globals"), staleTime: 5 * 60_000 });
  const ld = { warn: data?.defaultLeadDays ?? DEFAULT_LEAD_DAYS.warn, urgent: data?.urgentDays ?? DEFAULT_LEAD_DAYS.urgent };
  leadDaysCache = ld;
  return ld;
}

// Тон за днями до строку: минуло або червона зона → rose, жовта → amber, інакше null
export type ExpiryTone = "rose" | "amber" | null;
export function expiryTone(daysLeft: number | null | undefined, ld: LeadDays = DEFAULT_LEAD_DAYS): ExpiryTone {
  if (daysLeft == null) return null;
  if (daysLeft <= ld.urgent) return "rose";
  if (daysLeft <= ld.warn) return "amber";
  return null;
}
export const expiryTextCls = (tone: ExpiryTone, fallback = "text-slate-500") => tone === "rose" ? "font-medium text-rose-600" : tone === "amber" ? "font-medium text-amber-600" : fallback;

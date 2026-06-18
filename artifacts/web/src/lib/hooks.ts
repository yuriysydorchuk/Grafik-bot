import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type WeekRow, type Me } from "./api";
import { weekOptions as genericWeeks, weekLabel } from "./dates";

// Persist a piece of UI state (e.g. selected factory) across pages/reloads
export function usePersisted<T extends string>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => (localStorage.getItem(key) as T) || initial);
  const set = (val: T) => { localStorage.setItem(key, val); setV(val); };
  return [v, set] as const;
}

// Current logged-in user (cached; App already fetches it)
export function useMe() {
  return useQuery<Me>({ queryKey: ["me"], queryFn: () => get("/auth/me"), staleTime: 60_000 }).data;
}

// Week dropdown options: real DB weeks (with status + entry count) merged with
// a few generic upcoming/past weeks. Also returns the best default (newest week with data).
export function useWeekOptions() {
  const { data: weeks = [] } = useQuery<WeekRow[]>({ queryKey: ["weeks"], queryFn: () => get("/weeks") });
  const map = new Map<string, { value: string; label: string; entries: number; status?: string }>();
  for (const g of genericWeeks()) map.set(g.value, { value: g.value, label: g.label, entries: 0 });
  for (const w of weeks) {
    const tag = w.status === "approved" ? " ✓ затв." : w.status === "draft" ? " • чернетка" : "";
    map.set(w.weekStart, { value: w.weekStart, label: `${weekLabel(w.weekStart)}${tag} (${w.entries})`, entries: w.entries, status: w.status });
  }
  const options = [...map.values()].sort((a, b) => b.value.localeCompare(a.value));
  const withData = weeks.filter(w => w.entries > 0).sort((a, b) => (a.status === "approved" ? -1 : 1) - (b.status === "approved" ? -1 : 1) || b.weekStart.localeCompare(a.weekStart));
  const defaultWeek = withData[0]?.weekStart ?? options[0]?.value ?? "";
  return { options, defaultWeek, weeks };
}

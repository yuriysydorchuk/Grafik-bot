import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radio, Truck, Clock } from "lucide-react";
import { get, DAYS, DAY_UK, type DayCode } from "../lib/api";
import { Card, Badge } from "./ui";
import { useT, type TFn } from "../lib/i18n";

const dateOf = (weekStart: string, day: DayCode) => {
  const d = new Date(weekStart + "T00:00:00");
  d.setDate(d.getDate() + Math.max(0, DAYS.indexOf(day)));
  return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
};

interface LiveWorker { workerId: number; name: string; status: string; enRoute: boolean; pickedUpBy: string | null }
interface LiveShift {
  factoryId: number; factory: string; shift: number; start: string | null; end: string | null;
  startMin: number | null; endMin: number | null;
  drivers: { id: number; name: string | null }[]; workers: LiveWorker[];
  present: number; absent: number; total: number; enRoute: boolean;
}
interface Live {
  weekStart: string; day: DayCode; nowMin: number; hasSchedule: boolean;
  shifts: LiveShift[]; drivers: { id: number; name: string }[];
}

const fmtDur = (mins: number, t: TFn) => {
  const m = Math.max(0, Math.round(mins));
  return `${Math.floor(m / 60)} ${t("год")} ${m % 60} ${t("хв")}`;
};

// Boarding happens BEFORE the shift starts (the driver brings workers to the factory).
// So "waiting for boarding" only makes sense before start; once the shift has started the
// driver can no longer board — if still nobody is confirmed, that's a problem.
function shiftPhase(s: LiveShift, curMin: number, t: TFn): { label: string; color: string; bar: string; pct: number } {
  if (s.startMin == null || s.endMin == null) return { label: "—", color: "text-slate-400", bar: "bg-slate-300", pct: 0 };
  let cur = curMin, start = s.startMin, end = s.endMin;
  if (end <= start) end += 1440;            // overnight shift ends next day
  // Only treat "now" as next-day if we're genuinely in the post-midnight tail of an
  // OVERNIGHT shift. (A normal daytime shift later today must stay "before start".)
  if (end > 1440 && cur < start && cur + 1440 <= end) cur += 1440;
  // ── Before start: the boarding window ──
  if (cur < start) {
    const toStart = `${t("до початку")} ${fmtDur(start - cur, t)}`;
    if (s.present > 0) return { label: `${t("забрано")} ${s.present} · ${toStart}`, color: "text-emerald-600", bar: "bg-emerald-500", pct: 0 };
    return { label: `${t("очікує посадки")} · ${toStart}`, color: "text-amber-600", bar: "bg-amber-400", pct: 0 };
  }
  if (cur >= end) return { label: t("зміна завершена"), color: "text-slate-400", bar: "bg-slate-300", pct: 100 };
  // ── After start: boarding window closed ──
  const pct = Math.round(((cur - start) / (end - start)) * 100);
  const left = `${t("до кінця")} ${fmtDur(end - cur, t)}`;
  if (s.present > 0) return { label: `${t("на зміні")} ${fmtDur(cur - start, t)} · ${left}`, color: "text-emerald-600", bar: "bg-emerald-500", pct };
  return { label: `${t("посадку не підтверджено")} · ${left}`, color: "text-rose-600", bar: "bg-rose-400", pct };
}

const statusChip = (w: LiveWorker) =>
  w.status === "present" ? <Badge color="green">🟢 {w.name}{w.pickedUpBy ? ` · 🚗${w.pickedUpBy}` : ""}</Badge>
  : w.status === "absent" ? <Badge color="rose">🔴 {w.name}</Badge>
  : w.enRoute ? <Badge color="amber">🟡 {w.name}</Badge>
  : <Badge color="slate">{w.name}</Badge>;

export function LiveShifts() {
  const t = useT();
  const { data } = useQuery<Live>({ queryKey: ["live"], queryFn: () => get("/live"), refetchInterval: 30000 });

  // local clock tick so timers advance between fetches
  const loadedRef = useRef(Date.now());
  const [, setTick] = useState(0);
  useEffect(() => { loadedRef.current = Date.now(); }, [data?.nowMin]);
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 1000); return () => clearInterval(t); }, []);
  const curMin = (data?.nowMin ?? 0) + (Date.now() - loadedRef.current) / 60000;

  if (!data) return null;

  return (
    <Card className="mb-6 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Radio className="h-4 w-4 text-red-600" />
        <h3 className="text-sm font-semibold text-slate-700">{t("Лайв зміни")}</h3>
        <span className="text-xs font-medium text-slate-400">{DAY_UK[data.day]} {dateOf(data.weekStart, data.day)}</span>
        <span className="flex h-2 w-2 animate-pulse rounded-full bg-red-500" />
      </div>
      {!data.shifts.length ? (
        <div className="py-6 text-center text-sm text-slate-400">
          {data.hasSchedule ? t("Сьогодні немає змін у графіку") : t("Немає затвердженого графіку на поточний тиждень")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.shifts.map(s => {
            const ph = shiftPhase(s, curMin, t);
            return (
              <div key={`${s.factoryId}-${s.shift}`} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-slate-800">{s.factory}</div>
                    <div className="text-xs text-slate-400">{DAY_UK[data.day]} {dateOf(data.weekStart, data.day)}</div>
                  </div>
                  <Badge color="slate">{s.shift} {t("зм")} {s.start && s.end ? `· ${s.start}–${s.end}` : ""}</Badge>
                </div>
                <div className={`mt-1 flex items-center gap-1.5 text-xs font-medium ${ph.color}`}>
                  <Clock className="h-3.5 w-3.5" /> {ph.label}
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${ph.bar}`} style={{ width: `${ph.pct}%` }} />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.workers.map(w => <span key={w.workerId}>{statusChip(w)}</span>)}
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                  <span>🟢 {s.present} · 🔴 {s.absent} · {t("усього")} {s.total}</span>
                </div>
                <div className="mt-2 flex items-center gap-1.5 border-t border-slate-100 pt-2 text-xs">
                  <Truck className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="text-slate-600">{s.drivers.map(d => d.name).filter(Boolean).join(", ") || t("водій не призначений")}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

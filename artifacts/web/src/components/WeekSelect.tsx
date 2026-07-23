import { useQuery } from "@tanstack/react-query";
import { get, type WeekRow } from "../lib/api";
import { upcomingWeeks, weekLabel, isoWeek } from "../lib/dates";
import { cn, Select } from "./ui";
import { useT } from "../lib/i18n";

// Week picker: the 3 nearest weeks as buttons (current is the default) + an "Архів"
// dropdown for older weeks that have data. Each entry shows ISO week № and Mon–Sun dates.
// `limit` trims the button row, `showArchive={false}` hides the dropdown — the Telegram
// Mini App shows a slimmed-down picker (this week + next, no archive).
export function WeekSelect({ value, onChange, className, limit, showArchive = true }: {
  value: string; onChange: (v: string) => void; className?: string; limit?: number; showArchive?: boolean;
}) {
  const t = useT();
  const { data: weeks = [] } = useQuery<WeekRow[]>({ queryKey: ["weeks"], queryFn: () => get("/weeks") });
  const statusOf = (ws: string) => weeks.find(w => w.weekStart === ws)?.status;
  const statusDot = (ws: string) => {
    const s = statusOf(ws);
    return s === "approved" ? "bg-emerald-500" : s === "draft" ? "bg-amber-500" : "bg-slate-300";
  };
  const statusWord = (ws: string) => {
    const s = statusOf(ws);
    return s === "approved" ? ` · ✓ ${t("затв.")}` : s === "draft" ? ` · ${t("чернетка")}` : "";
  };

  const upcoming = limit ? upcomingWeeks().slice(0, limit) : upcomingWeeks();
  const upValues = new Set(upcoming.map(u => u.value));
  const archive = weeks.filter(w => w.entries > 0 && !upValues.has(w.weekStart)).sort((a, b) => b.weekStart.localeCompare(a.weekStart));

  // make sure a currently-selected archived week is shown even if it has no entries
  const valueIsArchived = !!value && !upValues.has(value);
  if (valueIsArchived && !archive.some(a => a.weekStart === value)) {
    archive.unshift({ id: -1, weekStart: value, status: statusOf(value) ?? "", label: "", entries: 0 } as WeekRow);
  }

  return (
    <div className={cn("flex flex-wrap items-stretch gap-2", className)}>
      {upcoming.map(u => {
        const active = value === u.value;
        return (
          <button key={u.value} type="button" onClick={() => onChange(u.value)}
            className={cn(
              "flex min-w-[148px] flex-col items-start rounded-xl border px-3.5 py-2 text-left transition",
              active ? "border-red-500 bg-red-50 ring-1 ring-red-200" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
            )}>
            <span className={cn("text-[11px] font-semibold uppercase tracking-wide", active ? "text-red-600" : "text-slate-400")}>{t(u.rel)}</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-sm font-bold text-slate-800">
              {t("Тиждень")} {u.num}
              <span className={cn("h-1.5 w-1.5 rounded-full", statusDot(u.value))} />
            </span>
            <span className="text-xs text-slate-400">{u.label}</span>
          </button>
        );
      })}

      {showArchive && archive.length > 0 && (
        <div className="flex flex-col justify-center">
          <span className="mb-0.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t("Архів")}</span>
          <Select
            className={cn("w-56", valueIsArchived ? "border-red-500 ring-1 ring-red-200" : "")}
            value={valueIsArchived ? value : ""}
            onChange={e => { if (e.target.value) onChange(e.target.value); }}>
            <option value="">{t("Обрати з архіву ({n})…", { n: archive.length })}</option>
            {archive.map(w => (
              <option key={w.weekStart} value={w.weekStart}>
                {t("Тиждень")} {isoWeek(w.weekStart)} · {weekLabel(w.weekStart)}{statusWord(w.weekStart)}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}

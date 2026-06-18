// Local YYYY-MM-DD (never UTC — avoids off-by-one near midnight / across timezones)
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Monday (YYYY-MM-DD) of the week containing `d`
export function mondayOf(d: Date): string {
  const x = new Date(d);
  const day = x.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return ymd(x);
}

// A list of selectable week-Mondays: a few past + current + a few future
export function weekOptions(pastWeeks = 4, futureWeeks = 4): { value: string; label: string }[] {
  const base = new Date(mondayOf(new Date()) + "T00:00:00");
  const out: { value: string; label: string }[] = [];
  for (let i = -pastWeeks; i <= futureWeeks; i++) {
    const m = new Date(base); m.setDate(base.getDate() + i * 7);
    const v = ymd(m);
    out.push({ value: v, label: weekLabel(v) + (i === 0 ? " (поточний)" : i === 1 ? " (наступний)" : "") });
  }
  return out.reverse();
}

export function weekLabel(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00");
  const end = new Date(d); end.setDate(d.getDate() + 6);
  const f = (x: Date) => x.toLocaleDateString("uk-UA", { day: "numeric", month: "numeric" });
  return `${f(d)} – ${f(end)}`;
}

// Last `n` months (current first) as { value: "YYYY-MM", label: "червень 2026" }
export function monthOptions(locale = "uk-UA", n = 6): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({
      value: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`,
      label: m.toLocaleDateString(locale, { month: "long", year: "numeric" }),
    });
  }
  return out;
}

// Date (dd.MM) of a given day within a week (offset 0 = Monday … 6 = Sunday)
export function dayDate(weekStart: string, offset: number): string {
  const d = new Date(weekStart + "T00:00:00");
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
}

// ISO-8601 week number for a Monday date
export function isoWeek(weekStart: string): number {
  const d = new Date(weekStart + "T00:00:00");
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  return 1 + Math.round((firstThursday - target.valueOf()) / 604800000);
}

// Current Monday + the next two Mondays (max 2 weeks ahead)
export function upcomingWeeks(): { value: string; num: number; label: string; rel: string }[] {
  const base = new Date(mondayOf(new Date()) + "T00:00:00");
  const rels = ["Цей тиждень", "Наступний", "Через тиждень"];
  return [0, 1, 2].map(i => {
    const m = new Date(base); m.setDate(base.getDate() + i * 7);
    const v = ymd(m);
    return { value: v, num: isoWeek(v), label: weekLabel(v), rel: rels[i]! };
  });
}

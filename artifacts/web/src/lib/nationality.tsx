// Національності працівників: прапорець біля імені (профіль, довози, сводна).
// Регіони позначаються репрезентативним прапором (рішення 12.08.2026).
// Дзеркало серверного списку NATIONALITIES в routes/admin-api.ts.
export const NATIONALITIES: { value: string; label: string; flag: string }[] = [
  { value: "ukraine", label: "Україна", flag: "🇺🇦" },
  { value: "belarus", label: "Білорусь", flag: "🇧🇾" },
  { value: "poland", label: "Польща", flag: "🇵🇱" },
  { value: "moldova", label: "Молдова", flag: "🇲🇩" },
  { value: "romania", label: "Румунія", flag: "🇷🇴" },
  { value: "georgia", label: "Грузія", flag: "🇬🇪" },
  { value: "azerbaijan", label: "Азербайджан", flag: "🇦🇿" },
  { value: "turkey", label: "Туреччина", flag: "🇹🇷" },
  { value: "africa", label: "Африка", flag: "🇿🇼" },
  { value: "latin_america", label: "Латинська Америка", flag: "🇨🇴" },
  { value: "central_asia", label: "Центральна Азія", flag: "🇰🇿" },
  { value: "south_asia", label: "Південна Азія", flag: "🇮🇳" },
];

export const natLabel = (v?: string | null): string | null =>
  NATIONALITIES.find(n => n.value === v)?.label ?? null;

// Прапорець з підказкою; null-національність не рендериться зовсім
export function NatFlag({ value, className }: { value?: string | null; className?: string }) {
  const n = NATIONALITIES.find(x => x.value === value);
  if (!n) return null;
  return <span title={n.label} className={className ?? "cursor-default"}>{n.flag}</span>;
}

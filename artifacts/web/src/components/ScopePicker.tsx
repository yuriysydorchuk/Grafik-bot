// Вибір доступу адміна по містах/фабриках (01.10.2026). Порожній вибір = усі міста.
// Місто бере всі свої фабрики (і нові в майбутньому) — фабрики міста тоді лише показуються
// відміченими; окремі фабрики — для точкового доступу поза цілим містом.
import { useQuery } from "@tanstack/react-query";
import { get, type Factory } from "../lib/api";
import { useT } from "../lib/i18n";

export type ScopeValue = { cities: string[]; factoryIds: number[] };

const cityKey = (c: string) => c.trim().toLocaleLowerCase("pl");

export function ScopePicker({ value, onChange, allowAll = true }: { value: ScopeValue; onChange: (v: ScopeValue) => void; allowAll?: boolean }) {
  const t = useT();
  // /factories для адміна зі скоупом сервер уже обрізає до його фабрик — пікер делегата сам звужений
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  // фабрики без міста — окрема група без галочки «усе місто» (міста як такого нема)
  const byCity = new Map<string, { label: string; items: Factory[]; noCity: boolean }>();
  for (const f of factories) {
    const city = (f.city ?? "").trim();
    const label = city || t("Без міста");
    const k = city ? cityKey(city) : "";
    (byCity.get(k) ?? byCity.set(k, { label, items: [], noCity: !city }).get(k)!).items.push(f);
  }
  const groups = [...byCity.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label, "pl"));
  const citySet = new Set(value.cities.map(cityKey));
  const toggleCity = (label: string) => {
    const k = cityKey(label);
    const cities = citySet.has(k) ? value.cities.filter(c => cityKey(c) !== k) : [...value.cities, label];
    // фабрики міста, відмічені окремо, поглинає місто
    const inCity = new Set(byCity.get(k)?.items.map(f => f.id) ?? []);
    onChange({ cities, factoryIds: value.factoryIds.filter(id => !inCity.has(id)) });
  };
  const toggleFactory = (id: number) => onChange({
    ...value, factoryIds: value.factoryIds.includes(id) ? value.factoryIds.filter(x => x !== id) : [...value.factoryIds, id],
  });
  const empty = !value.cities.length && !value.factoryIds.length;

  return (
    <div className="space-y-2">
      <p className={empty ? (allowAll ? "text-xs text-slate-500" : "text-xs text-rose-600") : "text-xs text-slate-500"}>
        {empty ? (allowAll ? t("Нічого не обрано — доступ до всіх міст і фабрик.") : t("Оберіть місто або фабрики.")) : t("Доступ лише до обраних міст і фабрик (і їхніх працівників).")}
      </p>
      <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-2">
        {groups.map(([k, g]) => {
          const cityOn = citySet.has(k);
          return (
            <div key={k}>
              {g.noCity ? (
                <div className="text-sm font-medium text-slate-500">{g.label}</div>
              ) : (
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                  <input type="checkbox" checked={cityOn} onChange={() => toggleCity(g.label)} />
                  📍 {g.label} <span className="text-xs font-normal text-slate-400">({t("усе місто")})</span>
                </label>
              )}
              <div className="ml-6 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {g.items.map(f => (
                  <label key={f.id} className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                    <input type="checkbox" disabled={cityOn} checked={cityOn || value.factoryIds.includes(f.id)} onChange={() => toggleFactory(f.id)} />
                    {f.name}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {!groups.length && <p className="text-xs text-slate-400">{t("Немає фабрик")}</p>}
      </div>
    </div>
  );
}

// Короткий підпис скоупу для таблиць: «📍 Познань · 2 фабрики» / «усі міста».
export function scopeSummary(cities: string[], factoryIds: number[], t: (s: string, p?: Record<string, string | number>) => string): string {
  if (!cities.length && !factoryIds.length) return t("усі міста");
  const parts = [...cities.map(c => `📍 ${c}`)];
  if (factoryIds.length) parts.push(t("фабрик: {n}", { n: factoryIds.length }));
  return parts.join(" · ");
}

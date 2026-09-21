// Спільне поле пошуку для списків (рішення власника 21.09.2026 «фільтри кругом, де можна»):
// іконка, очищення хрестиком, ширина під тулбар. Значення тримає сторінка — зазвичай через
// useSessionState (lib/nav.ts), щоб фільтр пережив перехід у профіль і повернення.
import { Search, X } from "lucide-react";
import { useT } from "../lib/i18n";
import { cn } from "./ui";

export function SearchBox({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const t = useT();
  return (
    <div className={cn("relative", className ?? "w-56")}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder ?? t("Пошук за іменем")}
        className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-7 text-sm text-slate-800 placeholder:text-slate-400 focus:border-red-300 focus:outline-none" />
      {value && (
        <button type="button" onClick={() => onChange("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600" title={t("Очистити")}>
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// Збіг рядка з запитом: без регістру й діакритики (Kowalski = kowalski = Kowalśki), кілька слів — усі мають зустрітись.
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export function matchesQuery(q: string, ...fields: (string | number | null | undefined)[]): boolean {
  const words = fold(q.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(fields.filter(v => v != null && v !== "").map(String).join(" "));
  return words.every(w => hay.includes(w));
}

// Клікабельний заголовок таблиці зі стрілкою сортування (список фактур тощо).
// Перший клік — за замовчуванням напрямок колонки, повторний — обернений.
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

export interface SortState<K extends string> { key: K; dir: "asc" | "desc" }

export function toggleSort<K extends string>(s: SortState<K>, k: K, defaultDir: "asc" | "desc" = "asc"): SortState<K> {
  if (s.key !== k) return { key: k, dir: defaultDir };
  return { key: k, dir: s.dir === "asc" ? "desc" : "asc" };
}

// сама кнопка — коли в одному <th> треба два сортування (напр. «Оплата / Термін»)
export function SortBtn<K extends string>({ label, k, sort, onSort, title }: {
  label: string; k: K; sort: SortState<K>; onSort: (k: K) => void; title?: string;
}) {
  const active = sort.key === k;
  return (
    <button type="button" onClick={() => onSort(k)} title={title}
      className={`group inline-flex items-center gap-0.5 uppercase hover:text-slate-600 ${active ? "text-slate-700" : ""}`}>
      {label}
      {active
        ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
        : <ArrowUpDown className="h-3 w-3 opacity-0 group-hover:opacity-50" />}
    </button>
  );
}

export function SortTh<K extends string>({ label, k, sort, onSort, align = "left", className = "", title }: {
  label: string; k: K; sort: SortState<K>; onSort: (k: K) => void;
  align?: "left" | "right" | "center"; className?: string; title?: string;
}) {
  return (
    <th className={`${align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"} ${className}`}>
      <SortBtn label={label} k={k} sort={sort} onSort={onSort} title={title} />
    </th>
  );
}

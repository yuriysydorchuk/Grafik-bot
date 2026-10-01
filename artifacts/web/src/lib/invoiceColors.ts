// Палітра кольорових позначок рядків фактур (кшєнгова виділяє рядки «для себе»).
// Дзеркало ключів: artifacts/api-server/src/lib/invoiceColors.ts — тримати синхронно.
// Класи виписані буквально (Tailwind v4 сканує код, динамічні рядки не бачить);
// шкали *-100/*-400 перетемнюються у dark через CSS-змінні.
export const INVOICE_COLORS = [
  { key: "yellow", label: "Жовтий",     row: "bg-yellow-100",  dot: "bg-yellow-400" },
  { key: "green",  label: "Зелений",    row: "bg-green-100",   dot: "bg-green-500" },
  { key: "blue",   label: "Синій",      row: "bg-sky-100",     dot: "bg-sky-500" },
  { key: "red",    label: "Червоний",   row: "bg-red-100",     dot: "bg-red-500" },
  { key: "purple", label: "Фіолетовий", row: "bg-violet-100",  dot: "bg-violet-500" },
  { key: "orange", label: "Помаранчевий", row: "bg-orange-100", dot: "bg-orange-500" },
  { key: "gray",   label: "Сірий",      row: "bg-slate-200",   dot: "bg-slate-500" },
] as const;
export type InvoiceColor = (typeof INVOICE_COLORS)[number]["key"];
export const colorMeta = (key: string | null | undefined) => INVOICE_COLORS.find(c => c.key === key) ?? null;
export const rowColorClass = (key: string | null | undefined) => colorMeta(key)?.row ?? "";

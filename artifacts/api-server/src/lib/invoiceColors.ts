// Палітра кольорових позначок рядків фактур (/cost-invoices, спшедажові).
// Дзеркало: artifacts/web/src/lib/invoiceColors.ts (там ще класи Tailwind) — тримати синхронно.
export const INVOICE_COLORS = ["yellow", "green", "blue", "red", "purple", "orange", "gray"] as const;
export type InvoiceColor = (typeof INVOICE_COLORS)[number];
/** Валідація поля `color` з PATCH-тіла: undefined = не чіпати, null/"" = зняти, інакше — лише ключ палітри. */
export function parseColor(v: unknown): { skip: true } | { skip?: false; value: InvoiceColor | null; err?: string } {
  if (v === undefined) return { skip: true };
  if (v === null || v === "") return { value: null };
  const s = String(v);
  return (INVOICE_COLORS as readonly string[]).includes(s) ? { value: s as InvoiceColor } : { value: null, err: `color: one of ${INVOICE_COLORS.join("|")} or null` };
}

// Expense categories — shared by Витяги (/bank), Кешфлоу (/cashflow) і Каса (/cash).
// Categories are owner-editable rows in the DB (expense_categories, keys mirror
// bank_transactions.manual_category); the hook loads them once per session.
// Static labels remain only for virtual keys that never live in the table.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

export interface ExpenseCat { id: number; key: string; label: string; pattern: string | null; sortOrder: number; txCount?: number }

export const OWNER_OPTIONS: { value: string; label: string }[] = [
  { value: "owner_roman", label: "Особисте — Сидорчук Роман" },
  { value: "owner_tetiana", label: "Особисте — Сидорчук Тетяна" },
  { value: "owner_yuriy", label: "Особисте — Сидорчук Юрій" },
];

// cash-only pseudo-categories (internal moves, excluded from expenses)
export const CASH_ONLY_LABELS: Record<string, string> = {
  deposit: "Вплата на рахунок",
  transfer: "Переміщення",
};

// Категорії каси — окремий довідник (cash_categories, CRUD на /cash): видатки
// (зарплатна сімʼя несе city/payroll — по них іде звірка зі сводною) і приходи
// ('card' = знято з карти). Ендпойнт під page-гейтом /cash — доступний кадровій.
export interface CashCat {
  id: number; flow: "in" | "out"; key: string; label: string;
  city: string | null; payroll: string | null; requiresDesc: boolean; sortOrder: number; usedCount?: number;
}

export function useCashCats() {
  const q = useQuery<{ categories: CashCat[] }>({
    queryKey: ["cash-cats"], queryFn: () => get("/cash/categories"), staleTime: 60_000,
  });
  const cats = q.data?.categories ?? [];
  const outCats = useMemo(() => cats.filter(c => c.flow === "out"), [cats]);
  const inCats = useMemo(() => cats.filter(c => c.flow === "in"), [cats]);
  const labels = useMemo(() => {
    const m: Record<string, string> = { ...CASH_ONLY_LABELS };
    for (const c of cats) m[c.key] = c.label;
    return m;
  }, [cats]);
  const label = (key: string) => labels[key] ?? key;
  const byKey = (key: string) => cats.find(c => c.key === key);
  return { cats, outCats, inCats, labels, label, byKey };
}

export function useCats() {
  const q = useQuery<{ categories: ExpenseCat[]; otherCount: number }>({
    queryKey: ["bank-cats"], queryFn: () => get("/bank/categories"), staleTime: 60_000,
  });
  const cats = q.data?.categories ?? [];
  const labels = useMemo(() => {
    const m: Record<string, string> = { other: "Інше", ...CASH_ONLY_LABELS };
    for (const c of cats) m[c.key] = c.label;
    for (const o of OWNER_OPTIONS) m[o.value] = o.label;
    return m;
  }, [cats]);
  // dropdown options: filterOptions — expense categories only; recatOptions — + owners'
  const filterOptions = useMemo(() => [
    ...cats.map(c => ({ value: c.key, label: c.label })),
    { value: "other", label: "Інше" },
  ], [cats]);
  const recatOptions = useMemo(() => [...filterOptions, ...OWNER_OPTIONS], [filterOptions]);
  const label = (key: string) => labels[key] ?? key;
  return { cats, otherCount: q.data?.otherCount ?? 0, labels, filterOptions, recatOptions, label };
}

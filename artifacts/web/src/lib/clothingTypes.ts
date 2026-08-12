// Типи одягу: довідник clothing_types (CRUD — вкладка «Магазин» → «Типи»).
// key живе в item_type складу/видач; підписи читаються звідси, фолбек — базові.
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

export type ClothingType = { id: number; key: string; label: string; sortOrder: number; isActive: boolean };

export const CLOTHING_TYPE_FALLBACK: Record<string, string> = {
  boots: "Взуття", coverall: "Комбінезон", jacket: "Куртка", hat: "Шапка", tshirt: "Футболка", set: "Комплект", other: "Інше",
};

export function useClothingTypes() {
  const { data: types = [] } = useQuery<ClothingType[]>({
    queryKey: ["clothing-types"], queryFn: () => get("/clothing/types"),
  });
  const labelOf = (key: string): string =>
    types.find(t => t.key === key)?.label ?? CLOTHING_TYPE_FALLBACK[key] ?? key;
  return { types, active: types.filter(t => t.isActive), labelOf };
}

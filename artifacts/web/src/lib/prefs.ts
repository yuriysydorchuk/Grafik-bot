import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post, type Me } from "./api";
import { useMe } from "./hooks";

// Персональний порядок вкладок (міста/фабрики) — живе в admins.web_prefs на
// сервері, тож їде за користувачем між браузерами/пристроями. Запис
// оптимістичний: спершу кеш ["me"], потім POST (помилку ковтаємо — порядок
// не критичний, наступний drag перепише).
export function useOrderPref(key: string): [string[], (next: string[]) => void] {
  const qc = useQueryClient();
  const me = useMe();
  const raw = me?.prefs?.[key];
  const order = Array.isArray(raw) ? (raw as string[]) : [];
  const save = useCallback((next: string[]) => {
    qc.setQueryData<Me>(["me"], m => m ? { ...m, prefs: { ...(m.prefs ?? {}), [key]: next } } : m);
    post("/auth/web-prefs", { key, value: next }).catch(() => { /* best-effort */ });
  }, [key, qc]);
  return [order, save];
}

// Відсортувати за збереженим порядком: відомі ключі — за своїм індексом,
// нові/невідомі — в кінець у поточному (дефолтному) порядку.
export function orderBy<T>(items: T[], keyOf: (x: T) => string, order: string[]): T[] {
  if (!order.length) return items;
  const idx = new Map(order.map((k, i) => [k, i]));
  return items
    .map((x, i) => [x, idx.get(keyOf(x)) ?? order.length + i] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([x]) => x);
}

// Нативний HTML5 drag-and-drop по кнопках-вкладках: перетягнув одну на іншу —
// зберігся ПОВНИЙ видимий порядок (матеріалізує і ще не збережені ключі).
export function useDragOrder(displayed: string[], save: (next: string[]) => void) {
  const dragKey = useRef<string | null>(null);
  return (key: string) => ({
    draggable: true,
    onDragStart: () => { dragKey.current = key; },
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragKey.current;
      dragKey.current = null;
      if (!from || from === key) return;
      const list = [...displayed];
      const i = list.indexOf(from), j = list.indexOf(key);
      if (i < 0 || j < 0) return;
      list.splice(j, 0, ...list.splice(i, 1));
      save(list);
    },
  });
}

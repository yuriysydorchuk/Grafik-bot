// Навігація «назад у те саме місце» (рішення власника 21.09.2026): панель — SPA (wouter),
// тож «назад» має повертати на попередню сторінку панелі з тим самим скролом, а не на
// фіксований маршрут. Стек відвіданих шляхів і позиції скролу — у sessionStorage (на вкладку).
//   useNavTracking() — один раз у Layout: веде стек, зберігає/відновлює скрол;
//   useBack(fallback) — кнопки «← Назад/До …»: history.back(), якщо є куди, інакше fallback;
//   useSessionState(key, init) — фільтри списків, що переживають перехід і повернення.
import { useEffect, useState } from "react";
import { useLocation } from "wouter";

const STACK = "nav.stack";
const SCROLL = "nav.scroll";
const read = <T,>(k: string, d: T): T => { try { const v = sessionStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* приватний режим тощо */ } };

// стан — на рівні модуля: Layout може перемонтовуватись між маршрутами, ref не пережив би переходу
let currentLoc: string | null = null;
let popping = false;
let listeners = false;
const liveScroll: Record<string, number> = {}; // скрол поточної сторінки в реальному часі: після переходу
// новий контент коротший і window.scrollY уже «затиснуто» в 0 — читати його в ефекті пізно

export function useNavTracking() {
  const [loc] = useLocation();
  useEffect(() => {
    if (listeners) return;
    listeners = true;
    window.addEventListener("popstate", () => { popping = true; });
    window.addEventListener("scroll", () => { if (currentLoc != null) liveScroll[currentLoc] = window.scrollY; }, { passive: true });
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual"; // відновлюємо самі
  }, []);
  useEffect(() => {
    const stack = read<string[]>(STACK, []);
    const scroll = read<Record<string, number>>(SCROLL, {});
    const prevLoc = currentLoc;
    if (prevLoc != null && prevLoc !== loc) scroll[prevLoc] = liveScroll[prevLoc] ?? 0;
    // «назад»: popstate АБО повернення на передостанній шлях стеку (кнопка браузера, коли слухач спізнився)
    const isPop = popping || (stack.length >= 2 && stack[stack.length - 2] === loc && prevLoc === stack[stack.length - 1]);
    popping = false;
    if (isPop) {
      if (stack[stack.length - 1] !== loc) stack.pop();
      // сторінка домальовується асинхронно (react-query) — кілька спроб відновити скрол
      const y = scroll[loc] ?? 0;
      for (const ms of [0, 150, 400, 800, 1500]) setTimeout(() => { if (Math.abs(window.scrollY - y) > 4) window.scrollTo(0, y); }, ms);
    } else {
      if (stack[stack.length - 1] !== loc) stack.push(loc);
      if (prevLoc != null && prevLoc !== loc) window.scrollTo(0, 0); // новий перехід — з верху сторінки
    }
    write(STACK, stack.slice(-50)); write(SCROLL, scroll);
    currentLoc = loc;
    liveScroll[loc] = window.scrollY;
  }, [loc]);
}

/** «Назад»: попередня сторінка панелі (з відновленим скролом), а без історії — fallback. */
export function useBack(fallback: string): () => void {
  const [, navigate] = useLocation();
  return () => {
    const stack = read<string[]>(STACK, []);
    if (stack.length >= 2) { popping = true; window.history.back(); }
    else navigate(fallback);
  };
}

/** useState, що переживає перехід на іншу сторінку й повернення (sessionStorage, на вкладку). */
export function useSessionState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => read<T>(`ss.${key}`, initial));
  useEffect(() => { write(`ss.${key}`, v); }, [key, v]);
  return [v, setV];
}

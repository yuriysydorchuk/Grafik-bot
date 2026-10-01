// Перегляд фото з зумом (01.10.2026): довідки до пропусків, документи працівника,
// скани фактур — на телефоні/ноуті дрібний текст без збільшення не читається.
// Колесо миші / щипок (pointer events, два пальці) — зум навколо курсора, тягнути —
// панорамування, подвійний клік — 2.5× ↔ 1×, кнопки +/−/1:1. Без залежностей.
import { useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { useT } from "../lib/i18n";

const MIN = 1, MAX = 8;

export function ZoomImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const stateRef = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; mid: { x: number; y: number }; x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const apply = (next: { scale: number; x: number; y: number }) => {
    const s = Math.min(MAX, Math.max(MIN, next.scale));
    const st = s === 1 ? { scale: 1, x: 0, y: 0 } : { scale: s, x: next.x, y: next.y };
    stateRef.current = st; setScale(st.scale); setPos({ x: st.x, y: st.y });
  };
  // зум навколо точки (cx, cy) у координатах контейнера
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const { scale: s0, x, y } = stateRef.current;
    const s1 = Math.min(MAX, Math.max(MIN, s0 * factor));
    const k = s1 / s0;
    apply({ scale: s1, x: cx - (cx - x) * k, y: cy - (cy - y) * k });
  };
  const center = () => { const r = boxRef.current?.getBoundingClientRect(); return { cx: (r?.width ?? 0) / 2, cy: (r?.height ?? 0) / 2 }; };

  useEffect(() => { apply({ scale: 1, x: 0, y: 0 }); }, [src]);
  // wheel — non-passive, щоб зупинити скрол модалки під час зуму
  useEffect(() => {
    const el = boxRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = boxRef.current!.getBoundingClientRect();
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), scale: stateRef.current.scale,
        mid: { x: (a!.x + b!.x) / 2 - r.left, y: (a!.y + b!.y) / 2 - r.top }, x: stateRef.current.x, y: stateRef.current.y };
      drag.current = null;
    } else if (pointers.current.size === 1) {
      drag.current = { x: e.clientX, y: e.clientY, px: stateRef.current.x, py: stateRef.current.y };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const g = gesture.current;
      const s1 = Math.min(MAX, Math.max(MIN, g.scale * Math.hypot(a!.x - b!.x, a!.y - b!.y) / g.dist));
      const k = s1 / g.scale;
      apply({ scale: s1, x: g.mid.x - (g.mid.x - g.x) * k, y: g.mid.y - (g.mid.y - g.y) * k });
    } else if (drag.current && stateRef.current.scale > 1) {
      apply({ scale: stateRef.current.scale, x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) });
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 0) drag.current = null;
    // після щипка лишився один палець — одразу панорамуємо ним (ревʼю codex 02.10.2026)
    if (pointers.current.size === 1) { const [r] = [...pointers.current.values()]; drag.current = { x: r!.x, y: r!.y, px: stateRef.current.x, py: stateRef.current.y }; }
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    if (stateRef.current.scale > 1) apply({ scale: 1, x: 0, y: 0 });
    else zoomAt(2.5, e.clientX - r.left, e.clientY - r.top);
  };

  const btn = "rounded-md bg-slate-900/60 p-1.5 text-white hover:bg-slate-900/80 disabled:opacity-40";
  return (
    <div ref={boxRef} className={`relative select-none overflow-hidden ${className ?? "h-[70vh]"}`}
      style={{ touchAction: "none", cursor: scale > 1 ? "grab" : "zoom-in" }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={onDoubleClick}>
      {/* transform — на обгортці розміром з контейнер: origin 0 0 збігається з кутом контейнера,
          в якому рахуються координати курсора/щипка (картинка всередині центрована object-contain) */}
      <div className="absolute inset-0"
        style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`, transformOrigin: "0 0", transition: drag.current || gesture.current ? "none" : "transform 80ms" }}>
        <img src={src} alt={alt ?? ""} draggable={false} className="pointer-events-none h-full w-full object-contain" />
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-1" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
        <button type="button" className={btn} title={t("Зменшити")} disabled={scale <= MIN} onClick={() => { const { cx, cy } = center(); zoomAt(1 / 1.5, cx, cy); }}><ZoomOut className="h-4 w-4" /></button>
        <span className="rounded-md bg-slate-900/60 px-1.5 py-1 text-xs tabular-nums text-white">{Math.round(scale * 100)}%</span>
        <button type="button" className={btn} title={t("Збільшити")} disabled={scale >= MAX} onClick={() => { const { cx, cy } = center(); zoomAt(1.5, cx, cy); }}><ZoomIn className="h-4 w-4" /></button>
        <button type="button" className={btn} title={t("Скинути масштаб")} disabled={scale === 1} onClick={() => apply({ scale: 1, x: 0, y: 0 })}><Maximize2 className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

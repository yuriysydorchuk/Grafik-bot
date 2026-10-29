// Анотатор скріншота для зголошень: рамка, стрілка, замазка (пікселізація — незворотна,
// на сервер іде лише сплющений PNG), текст, скасувати. Canvas у координатах зображення,
// масштаб до контейнера — лише CSS.
import { useEffect, useRef, useState } from "react";
import { Square, MoveUpRight, Grid2x2, Type, Undo2, Check, Crop } from "lucide-react";
import { Modal, Button, cn } from "./ui";
import { useT } from "../lib/i18n";

type Tool = "rect" | "arrow" | "blur" | "text" | "crop";
type Shape = { tool: Tool; x1: number; y1: number; x2: number; y2: number; text?: string };

export function FeedbackAnnotator({ src, open, onClose, onDone }: {
  src: string | null; open: boolean; onClose: () => void;
  onDone: (blob: Blob, meta: { annotations: number; blurred: boolean; width: number; height: number }) => void;
}) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("rect");
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [pendingText, setPendingText] = useState<{ x: number; y: number } | null>(null);
  const [textVal, setTextVal] = useState("");
  const [ready, setReady] = useState(false);
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null); // обрізання застосовується при «Готово»

  useEffect(() => {
    if (!open || !src) return;
    setShapes([]); setDraft(null); setPendingText(null); setReady(false); setCrop(null);
    const img = new Image();
    img.onload = () => { imgRef.current = img; const c = canvasRef.current; if (c) { c.width = img.naturalWidth; c.height = img.naturalHeight; } setReady(true); };
    img.src = src;
  }, [open, src]);

  useEffect(() => { draw(); }); // перемальовка на кожну зміну стану

  function draw(target?: HTMLCanvasElement, withCrop = true) {
    const c = target ?? canvasRef.current, img = imgRef.current;
    if (!c || !img || !ready) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    const all = draft ? [...shapes, draft] : shapes;
    const lw = Math.max(2, Math.round(c.width / 500));
    for (const s of all) {
      if (s.tool === "crop") continue;
      const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2), w = Math.abs(s.x2 - s.x1), h = Math.abs(s.y2 - s.y1);
      if (s.tool === "blur") {
        if (w < 2 || h < 2) continue;
        const block = Math.max(8, Math.round(c.width / 120));
        const tmp = document.createElement("canvas"); tmp.width = Math.max(1, Math.ceil(w / block)); tmp.height = Math.max(1, Math.ceil(h / block));
        const tctx = tmp.getContext("2d")!; tctx.imageSmoothingEnabled = true;
        tctx.drawImage(c, x, y, w, h, 0, 0, tmp.width, tmp.height);
        ctx.imageSmoothingEnabled = false; ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h); ctx.imageSmoothingEnabled = true;
        ctx.strokeStyle = "rgba(100,116,139,.8)"; ctx.setLineDash([6, 4]); ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
      } else if (s.tool === "rect") {
        ctx.strokeStyle = "#dc2626"; ctx.lineWidth = lw; ctx.strokeRect(x, y, w, h);
      } else if (s.tool === "arrow") {
        ctx.strokeStyle = "#dc2626"; ctx.fillStyle = "#dc2626"; ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), hl = lw * 5;
        ctx.beginPath(); ctx.moveTo(s.x2, s.y2); ctx.lineTo(s.x2 - hl * Math.cos(a - 0.4), s.y2 - hl * Math.sin(a - 0.4)); ctx.lineTo(s.x2 - hl * Math.cos(a + 0.4), s.y2 - hl * Math.sin(a + 0.4)); ctx.closePath(); ctx.fill();
      } else if (s.tool === "text" && s.text) {
        const fs = Math.max(14, Math.round(c.width / 70));
        ctx.font = `600 ${fs}px system-ui, sans-serif`;
        const m = ctx.measureText(s.text);
        ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fillRect(s.x1 - 4, s.y1 - fs, m.width + 8, fs + 8);
        ctx.fillStyle = "#dc2626"; ctx.fillText(s.text, s.x1, s.y1);
      }
    }
    // рамка обрізання: затемнення поза областю (саме обрізання — при «Готово»)
    const cr = draft?.tool === "crop" ? { x: Math.min(draft.x1, draft.x2), y: Math.min(draft.y1, draft.y2), w: Math.abs(draft.x2 - draft.x1), h: Math.abs(draft.y2 - draft.y1) } : crop;
    if (withCrop && cr && cr.w > 2 && cr.h > 2) {
      ctx.fillStyle = "rgba(15,23,42,.45)";
      ctx.fillRect(0, 0, c.width, cr.y); ctx.fillRect(0, cr.y + cr.h, c.width, c.height - cr.y - cr.h);
      ctx.fillRect(0, cr.y, cr.x, cr.h); ctx.fillRect(cr.x + cr.w, cr.y, c.width - cr.x - cr.w, cr.h);
      ctx.strokeStyle = "#fff"; ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeRect(cr.x, cr.y, cr.w, cr.h); ctx.setLineDash([]);
    }
  }

  const toImg = (e: React.PointerEvent) => {
    const c = canvasRef.current!; const r = c.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * (c.width / r.width)), y: Math.round((e.clientY - r.top) * (c.height / r.height)) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (!ready) return;
    const p = toImg(e);
    if (tool === "text") { setPendingText(p); setTextVal(""); return; }
    (e.target as Element).setPointerCapture(e.pointerId);
    setDraft({ tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };
  const onMove = (e: React.PointerEvent) => { if (draft) { const p = toImg(e); setDraft({ ...draft, x2: p.x, y2: p.y }); } };
  const onUp = () => {
    if (!draft) return;
    const big = Math.abs(draft.x2 - draft.x1) > 3 || Math.abs(draft.y2 - draft.y1) > 3;
    if (draft.tool === "crop") { if (big) setCrop({ x: Math.min(draft.x1, draft.x2), y: Math.min(draft.y1, draft.y2), w: Math.abs(draft.x2 - draft.x1), h: Math.abs(draft.y2 - draft.y1) }); }
    else if (big) setShapes(s => [...s, draft]);
    setDraft(null);
  };
  const commitText = () => { if (pendingText && textVal.trim()) setShapes(s => [...s, { tool: "text", x1: pendingText.x, y1: pendingText.y, x2: pendingText.x, y2: pendingText.y, text: textVal.trim() }]); setPendingText(null); };
  const finish = () => {
    const c = canvasRef.current; if (!c) return;
    // сплющити на чистий канвас (без затемнення обрізання), за потреби вирізати область
    const clean = document.createElement("canvas"); clean.width = c.width; clean.height = c.height;
    draw(clean, false);
    let out = clean;
    if (crop && crop.w > 2 && crop.h > 2) {
      const tmp = document.createElement("canvas"); tmp.width = Math.round(crop.w); tmp.height = Math.round(crop.h);
      tmp.getContext("2d")!.drawImage(clean, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      out = tmp;
    }
    out.toBlob(b => { if (b) onDone(b, { annotations: shapes.length + (crop ? 1 : 0), blurred: shapes.some(s => s.tool === "blur"), width: out.width, height: out.height }); }, "image/png");
  };

  const tools: { id: Tool; icon: React.ReactNode; label: string }[] = [
    { id: "rect", icon: <Square className="h-4 w-4" />, label: t("Рамка") }, { id: "arrow", icon: <MoveUpRight className="h-4 w-4" />, label: t("Стрілка") },
    { id: "blur", icon: <Grid2x2 className="h-4 w-4" />, label: t("Замазати") }, { id: "text", icon: <Type className="h-4 w-4" />, label: t("Текст") },
    { id: "crop", icon: <Crop className="h-4 w-4" />, label: t("Обрізати") },
  ];
  // текстове поле над канвасом (без prompt())
  const textPos = pendingText && canvasRef.current ? (() => { const c = canvasRef.current!; const r = c.getBoundingClientRect(); const pr = c.parentElement!.getBoundingClientRect(); return { left: (pendingText.x / c.width) * r.width + (r.left - pr.left), top: (pendingText.y / c.height) * r.height + (r.top - pr.top) }; })() : null;

  return (
    <Modal open={open} onClose={onClose} title={t("Скріншот: позначте, що не так")} size="xl">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {tools.map(x => (
          <button key={x.id} onClick={() => setTool(x.id)} className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium", tool === x.id ? "border-red-600 bg-red-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}>{x.icon}{x.label}</button>
        ))}
        <button onClick={() => (crop ? setCrop(null) : setShapes(s => s.slice(0, -1)))} disabled={!shapes.length && !crop} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Undo2 className="h-4 w-4" />{t("Скасувати")}</button>
        <span className="ml-auto text-xs text-slate-400">{t("Замазка незворотна — сховайте персональні дані й суми")}</span>
        <Button onClick={finish} disabled={!ready}><Check className="h-4 w-4" />{t("Готово")}</Button>
      </div>
      <div className="relative max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-slate-100">
        <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} className="block max-w-full cursor-crosshair select-none" style={{ touchAction: "none" }} />
        {textPos && (
          <input autoFocus value={textVal} onChange={e => setTextVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") commitText(); if (e.key === "Escape") setPendingText(null); }} onBlur={commitText}
            placeholder={t("Підпис…")} className="absolute z-10 rounded border border-red-500 bg-white px-1.5 py-0.5 text-sm text-red-700 shadow" style={{ left: textPos.left, top: textPos.top }} />
        )}
      </div>
    </Modal>
  );
}

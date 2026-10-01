// Кольорова крапка в рядку фактури: клік — палітра, вибір — PATCH {color}.
// Один відкритий пікер на сторінку (стан живе у батька через openKey/onOpen).
import { useEffect, useRef } from "react";
import { INVOICE_COLORS, colorMeta } from "../lib/invoiceColors";
import { useT } from "../lib/i18n";

export function InvoiceColorPicker({ value, open, onOpen, onPick }: {
  value: string | null; open: boolean; onOpen: (open: boolean) => void; onPick: (color: string | null) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onOpen]);
  const meta = colorMeta(value);
  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => onOpen(!open)}
        title={meta ? `${t("Колір рядка")}: ${t(meta.label)} · ${t("клік — змінити")}` : t("Виділити рядок кольором")}
        className={`h-4 w-4 rounded-full border transition ${meta ? `${meta.dot} border-transparent` : "border-slate-300 bg-transparent hover:border-slate-500"}`} />
      {open && (
        <div className="absolute left-0 top-5 z-40 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
          {INVOICE_COLORS.map(c => (
            <button key={c.key} type="button" title={t(c.label)} onClick={() => { onPick(c.key); onOpen(false); }}
              className={`h-5 w-5 rounded-full ${c.dot} ${value === c.key ? "ring-2 ring-slate-700 ring-offset-1" : "hover:scale-110"}`} />
          ))}
          <button type="button" title={t("без кольору")} onClick={() => { onPick(null); onOpen(false); }}
            className="ml-0.5 h-5 w-5 rounded-full border border-slate-300 text-[10px] leading-none text-slate-400 hover:border-slate-500 hover:text-slate-600">×</button>
        </div>
      )}
    </div>
  );
}

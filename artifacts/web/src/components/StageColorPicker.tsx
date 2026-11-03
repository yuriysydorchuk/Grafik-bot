// Вибір кольору з палітри STAGE_COLORS кружечками (посади, етапи воронок) — замість <select> із сирими
// ключами «slate/amber…», які нічого не казали (зголошення #12, 03.11.2026).
import { useEffect, useRef, useState } from "react";
import { STAGE_COLORS, dotClass } from "../lib/colors";
import { useT } from "../lib/i18n";

export function StageColorPicker({ value, onChange, disabled }: { value: string; onChange: (color: string) => void; disabled?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block shrink-0">
      <button type="button" disabled={disabled} onClick={() => setOpen(o => !o)} title={t("Колір — клік, щоб змінити")}
        aria-haspopup="listbox" aria-expanded={open} aria-label={`${t("Колір")}: ${value}`}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 hover:border-slate-400 disabled:opacity-50">
        <span className={`h-5 w-5 rounded-full ${dotClass(value)}`} />
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 text-slate-400" fill="currentColor" aria-hidden><path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
      </button>
      {open && (
        <div role="listbox" aria-label={t("Колір")} className="absolute right-0 top-10 z-40 grid w-max grid-cols-7 gap-1.5 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          {STAGE_COLORS.map(c => (
            <button key={c} type="button" title={c} role="option" aria-selected={value === c} aria-label={c} onClick={() => { onChange(c); setOpen(false); }}
              className={`h-6 w-6 rounded-full ${dotClass(c)} ${value === c ? "ring-2 ring-slate-700 ring-offset-2" : "hover:scale-110"}`} />
          ))}
        </div>
      )}
    </div>
  );
}

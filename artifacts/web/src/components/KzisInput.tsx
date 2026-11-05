// Пікер коду zawodu KZiS: «код · назва» з пошуком (зголошення #26, 05.11.2026). Раніше код вписували
// руками шістьма цифрами — помилка в одній цифрі давала чужий або неіснуючий zawód, і це спливало
// аж на praca.gov.pl. Тепер значення береться ЛИШЕ з довідника (GET /reference/kzis — офіційна
// класифікація KZiS, lib/kzisData.ts на сервері; сервер перевіряє так само): вибір зі списку або
// точний код із шести цифр, який у довіднику є. Усе інше при виході з поля відкочується.
// Список — у порталі з position: fixed: поле стоїть у таблицях і модалках з overflow.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { get } from "../lib/api";
import { useT } from "../lib/i18n";
import { cn } from "./ui";

type KzisRef = { version: string; codes: [string, string][] };
export function useKzis() {
  return useQuery<KzisRef>({ queryKey: ["kzis"], queryFn: () => get("/reference/kzis"), staleTime: Infinity, gcTime: Infinity });
}
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L").toLowerCase();
const MAX = 40;

export function KzisInput({ value, onCommit, placeholder, className, showName = true }: {
  value: string | null | undefined;
  onCommit: (code: string) => void;      // "" — очистити
  placeholder?: string; className?: string;
  showName?: boolean;                    // підпис «назва zawodu» під полем (у тісних таблицях — лише підказкою title)
}) {
  const t = useT();
  const { data } = useKzis();
  const cur = value ?? "";
  const [q, setQ] = useState(cur);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setQ(cur); }, [cur]);

  const index = useMemo(() => (data?.codes ?? []).map(([code, name]) => ({ code, name, n: norm(name) })), [data]);
  const nameOf = useMemo(() => new Map((data?.codes ?? []).map(([c, n]) => [c, n])), [data]);
  const matches = useMemo(() => {
    const s = q.trim();
    if (!s || !index.length) return [];
    if (/^\d+$/.test(s)) return index.filter(x => x.code.startsWith(s)).slice(0, MAX);
    const words = norm(s).split(/\s+/).filter(Boolean);
    return index.filter(x => words.every(w => x.n.includes(w))).slice(0, MAX);
  }, [q, index]);
  useEffect(() => { setHi(0); }, [q]);

  const place = () => { const r = ref.current?.getBoundingClientRect(); if (!r) return; const width = Math.max(r.width, 340); setRect({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 2, width }); }; // не вилазити за правий край
  useEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);

  const commit = (code: string) => { setOpen(false); setQ(code); if (code !== cur) onCommit(code); };
  const onBlur = () => {
    setOpen(false);
    const s = q.trim();
    if (s === cur) return;
    if (!s) return commit("");
    if (/^\d{6}$/.test(s) && (!data || nameOf.has(s))) return commit(s); // довідник ще не завантажився — вирішить сервер
    setQ(cur);
    toast.error(t("Код KZiS — лише з довідника: виберіть zawód зі списку"));
  };
  const name = cur ? nameOf.get(cur) : null;
  const unknown = !!cur && !!data && !name;
  return (
    <span className="inline-flex min-w-0 flex-col">
      <input ref={ref} value={q} placeholder={placeholder ?? t("код або назва zawodu")}
        title={name ? `${cur} · ${name}` : unknown ? t("Коду немає в класифікації KZiS {v} — виберіть зі списку", { v: data!.version }) : t("Kod zawodu KZiS — почніть вводити код або назву")}
        onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={onBlur}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi(h => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
          else if (e.key === "Enter" && open && matches[hi]) { e.preventDefault(); commit(matches[hi]!.code); }
          else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); setQ(cur); }
        }}
        className={cn("rounded-md border bg-white px-2 py-1 font-mono text-sm text-slate-800 outline-none placeholder:font-sans placeholder:text-slate-300 focus:border-red-400",
          unknown ? "border-amber-400 bg-amber-50" : "border-slate-200", className)} />
      {showName && (name || unknown) && <span className={cn("mt-0.5 truncate text-[11px]", unknown ? "font-medium text-amber-700" : "text-slate-500")}>{name ?? t("немає в KZiS {v}", { v: data!.version })}</span>}
      {open && rect && matches.length > 0 && createPortal(
        <ul className="fixed z-[90] max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-xl" style={{ left: rect.left, top: rect.top, width: rect.width }}>
          {matches.map((m, i) => (
            <li key={m.code}>
              {/* onMouseDown — раніше за blur поля, інакше вибір губиться */}
              <button type="button" onMouseDown={e => { e.preventDefault(); commit(m.code); }} onMouseEnter={() => setHi(i)}
                className={cn("flex w-full items-baseline gap-2 px-2.5 py-1 text-left", i === hi ? "bg-red-50" : "hover:bg-slate-50")}>
                <span className="shrink-0 font-mono text-slate-800">{m.code}</span><span className="text-slate-600">{m.name}</span>
              </button>
            </li>
          ))}
          {matches.length === MAX && <li className="px-2.5 py-1 text-[11px] text-slate-400">{t("…уточніть запит, щоб побачити решту")}</li>}
        </ul>, document.body)}
    </span>
  );
}

// Загальний пошук по панелі (рішення власника 21.09.2026): поле в шапці + Ctrl/⌘+K.
// Один запит GET /search?q= → працівники, кандидати, водії, фабрики, хостели, відкриті
// задачі (лише групи, доступні ролі — фільтрує сервер). Enter/клік — перехід; для
// сторінок без картки (водії, фабрики, кандидати, хостели) заздалегідь кладемо запит у
// їхній збережений фільтр пошуку (lib/nav.ts useSessionState, ключ `<сторінка>.q`).
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Search, User, UserPlus, Car, Factory, Home, ListTodo, LayoutGrid, Zap } from "lucide-react";
import { get } from "../lib/api";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";
import { catalogFor } from "../lib/searchCatalog";
import { matchesQuery } from "./SearchBox";
import { cn } from "./ui";

type Hit = { kind: "worker" | "candidate" | "driver" | "factory" | "hostel" | "task" | "section" | "action"; id: number | string; title: string; subtitle: string | null; href: string; inactive?: boolean };
const ICON: Record<Hit["kind"], any> = { worker: User, candidate: UserPlus, driver: Car, factory: Factory, hostel: Home, task: ListTodo, section: LayoutGrid, action: Zap };
const KIND_LABEL: Record<Hit["kind"], string> = { worker: "працівник", candidate: "кандидат", driver: "водій", factory: "фабрика", hostel: "хостел", task: "задача", section: "розділ", action: "дія" };
// сторінка без картки → її поле пошуку заповниться шуканим (ключі = useSessionState у сторінках)
const SEED_KEY: Partial<Record<Hit["kind"], string>> = { driver: "drivers.q", factory: "factories.q", candidate: "recruitment.q", hostel: "hostels.q" };

export function GlobalSearch({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const [, navigate] = useLocation();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(true); }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); else { setQ(""); setHits([]); setSel(0); } }, [open]);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setHits([]); setLoading(false); return; }
    const my = ++seq.current;
    setLoading(true);
    const id = setTimeout(() => {
      get<{ hits: Hit[] }>(`/search?q=${encodeURIComponent(s)}`)
        .then(r => { if (my === seq.current) { setHits(r.hits); setSel(0); } })
        .catch(() => { if (my === seq.current) setHits([]); })
        .finally(() => { if (my === seq.current) setLoading(false); });
    }, 200);
    return () => clearTimeout(id);
  }, [q]);

  // розділи/дії панелі — з локального каталогу (lib/searchCatalog.ts), одразу, без запиту
  const local: Hit[] = q.trim().length >= 2
    ? catalogFor(me, q.trim(), matchesQuery).map(e => ({ kind: e.kind, id: e.href, title: e.label, subtitle: e.kind === "action" ? e.href.split("?")[0]! : null, href: e.href }))
    : [];
  const items: Hit[] = [...local, ...hits];
  const go = (h: Hit) => {
    const key = SEED_KEY[h.kind];
    if (key) { try { sessionStorage.setItem(`ss.${key}`, JSON.stringify(h.title)); } catch { /* ignore */ } }
    setOpen(false);
    navigate(h.href);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(s + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && items[sel]) { e.preventDefault(); go(items[sel]!); }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={t("Пошук по панелі (Ctrl+K)")}
        className={cn("inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700", compact ? "p-1.5" : "px-2.5 py-1.5 text-sm")}>
        <Search className="h-4 w-4" />
        {!compact && <><span className="hidden lg:inline">{t("Пошук…")}</span><kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1 text-[10px] text-slate-400 lg:inline">Ctrl K</kbd></>}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh]" onClick={() => setOpen(false)}>
          <div className="w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-slate-200 px-3">
              <Search className="h-4 w-4 text-slate-400" />
              <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
                placeholder={t("Працівник, кандидат, водій, фабрика, хостел, задача…")}
                className="w-full bg-transparent py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
              {loading && <span className="text-xs text-slate-400">…</span>}
            </div>
            <div className="max-h-[60vh] overflow-y-auto py-1">
              {q.trim().length < 2 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">{t("Введіть щонайменше 2 символи — ім'я, код, PESEL, телефон, назву")}</p>
              ) : !loading && !items.length ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">{t("Нічого не знайдено")}</p>
              ) : items.map((h, i) => {
                const Icon = ICON[h.kind];
                return (
                  <button key={`${h.kind}:${h.id}`} type="button" onMouseEnter={() => setSel(i)} onClick={() => go(h)}
                    className={cn("flex w-full items-center gap-3 px-4 py-2 text-left text-sm", i === sel ? "bg-red-50" : "hover:bg-slate-50")}>
                    <Icon className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate font-medium", h.inactive ? "text-slate-400 line-through" : "text-slate-800")}>{h.title}</span>
                      {h.subtitle && <span className="block truncate text-xs text-slate-400">{h.subtitle}</span>}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-400">{t(KIND_LABEL[h.kind])}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

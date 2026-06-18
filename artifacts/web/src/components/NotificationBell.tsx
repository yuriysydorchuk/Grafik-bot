import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Check } from "lucide-react";
import { get, post } from "../lib/api";
import { cn } from "./ui";
import { useT, type TFn } from "../lib/i18n";

interface Notif { id: number; type: string; title: string; body: string | null; createdAt: string; read: boolean }

// Where each notification type takes you when clicked
const routeForType = (type: string): string | null =>
  type === "cancellation" || type === "no_show" ? "/absences"
  : type === "hours_correction" ? "/hours"
  : null;

const timeAgo = (iso: string, t: TFn) => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return t("щойно");
  if (m < 60) return t("{n} хв тому", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("{n} год тому", { n: h });
  return new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
};

export function NotificationBell() {
  const t = useT();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data = [] } = useQuery<Notif[]>({
    queryKey: ["notifications"], queryFn: () => get("/notifications"), refetchInterval: 30000,
  });
  // Only unread/unresolved notifications are shown — read ones disappear from the bell
  const items = data.filter(n => !n.read);
  const unread = items.length;
  const markRead = useMutation({
    mutationFn: (id?: number) => post("/notifications/read", id ? { id } : { id: "all" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const openNotif = (n: Notif) => {
    markRead.mutate(n.id);
    setOpen(false);
    const route = routeForType(n.type);
    if (route) navigate(route);
  };

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)} className="relative rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700">
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <span className="text-sm font-semibold text-slate-700">{t("Сповіщення")}</span>
            {unread > 0 && (
              <button onClick={() => markRead.mutate(undefined)} className="flex items-center gap-1 text-xs text-red-600 hover:underline">
                <Check className="h-3.5 w-3.5" /> {t("Прочитати всі")}
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!items.length ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">{t("Немає нових сповіщень")}</div>
            ) : items.map(n => (
              <button key={n.id} onClick={() => openNotif(n)}
                className="flex w-full flex-col items-start gap-0.5 border-b border-slate-50 bg-red-50/40 px-4 py-2.5 text-left transition hover:bg-red-50">
                <div className="flex w-full items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                  <span className="text-sm font-semibold text-slate-800">{n.title}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-slate-400">{timeAgo(n.createdAt, t)}</span>
                </div>
                {n.body && <span className="whitespace-pre-line pl-4 text-xs text-slate-500">{n.body}</span>}
                {routeForType(n.type) && <span className="pl-4 text-[11px] font-medium text-red-600">{t("Перейти →")}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, useEffect } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { X, Loader2, Inbox } from "lucide-react";

export const cn = (...a: any[]) => twMerge(clsx(a));

type Variant = "primary" | "secondary" | "danger" | "ghost" | "success";
const variants: Record<Variant, string> = {
  primary: "bg-red-600 text-white shadow-sm hover:bg-red-700 focus-visible:ring-red-300 disabled:bg-red-300",
  secondary: "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 focus-visible:ring-slate-300",
  danger: "bg-rose-600 text-white shadow-sm hover:bg-rose-700 focus-visible:ring-rose-300 disabled:bg-rose-300",
  success: "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 focus-visible:ring-emerald-300 disabled:bg-emerald-300",
  ghost: "text-slate-600 hover:bg-slate-100 focus-visible:ring-slate-300",
};

export function Button({
  variant = "primary", loading, className, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      className={cn("inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70 disabled:active:scale-100", variants[variant], className)}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition-colors hover:border-slate-400 focus:border-red-500 focus:ring-2 focus:ring-red-100", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn("w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition-colors hover:border-slate-400 focus:border-red-500 focus:ring-2 focus:ring-red-100", className)} {...rest}>
      {children}
    </select>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-slate-500">{children}</label>;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-slate-200 bg-white shadow-sm", className)}>{children}</div>;
}

export function Badge({ children, color = "slate" }: { children: ReactNode; color?: "slate" | "green" | "amber" | "blue" | "rose" | "red" }) {
  const map: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 ring-slate-200",
    green: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    amber: "bg-amber-100 text-amber-700 ring-amber-200",
    blue: "bg-sky-100 text-sky-700 ring-sky-200",
    rose: "bg-rose-100 text-rose-700 ring-rose-200",
    red: "bg-red-100 text-red-700 ring-red-200",
  };
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", map[color])}>{children}</span>;
}

export function Spinner() {
  return <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-slate-400">
      <Inbox className="h-8 w-8 text-slate-300" />
      {children}
    </div>
  );
}

export function Modal({ open, onClose, title, children, size = "md" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; size?: "md" | "lg" | "xl" }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  const maxW = size === "xl" ? "max-w-4xl" : size === "lg" ? "max-w-2xl" : "max-w-md";
  // xl modals are real "work surfaces" (e.g. driver assignments) — go full-screen on phones
  const overlay = size === "xl" ? "p-0 sm:p-4 sm:pt-20" : "p-4 pt-20";
  const panel = size === "xl" ? "min-h-dvh rounded-none sm:min-h-0 sm:rounded-2xl" : "rounded-2xl";
  return (
    <div className={`fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 ${overlay} backdrop-blur-[2px] animate-fade-in`} onClick={onClose}>
      <div className={`w-full ${maxW} ${panel} bg-white shadow-xl ring-1 ring-slate-900/5 animate-pop-in`} onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-3.5">
          <h3 className="text-base font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="px-4 py-4 sm:px-5">{children}</div>
      </div>
    </div>
  );
}

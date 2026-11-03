// Кнопки копіювання біля даних працівника (зголошення #14, 03.11.2026): клік по даних більше не
// відкриває редагування випадково — копіює; редагування — олівцем / подвійним кліком.
import type { InputHTMLAttributes } from "react";
import { Copy } from "lucide-react";
import { Input, cn } from "./ui";
import { useT } from "../lib/i18n";
import { copyText, dateForCopy } from "../lib/clipboard";

export function CopyBtn({ value, className, title }: { value: string | null | undefined; className?: string; title?: string }) {
  const t = useT();
  if (!value) return null;
  return (
    <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); void copyText(value, t); }}
      title={title ?? t("Копіювати")} aria-label={t("Копіювати")}
      className={cn("inline-flex shrink-0 items-center justify-center rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700", className)}>
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}

// Input анкети з кнопкою копіювання всередині справа; дати копіюються як ДД.ММ.РРРР
export function CopyInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const raw = rest.value == null ? "" : String(rest.value);
  const value = rest.type === "date" ? dateForCopy(raw) : raw.trim();
  return (
    <div className="relative">
      <Input {...rest} className={cn(value ? (rest.type === "date" ? "pr-16" : "pr-9") : undefined, className)} />
      {value && <CopyBtn value={value} className={cn("absolute top-1/2 -translate-y-1/2", rest.type === "date" ? "right-9" : "right-1.5")} />}
    </div>
  );
}

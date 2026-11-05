// Повернення звільненого: «новий найм» чи «звільнили помилково» (зголошення #19, рішення власника
// 05.11.2026 — питаємо щоразу, типового вибору немає). Новий найм: перший робочий день і обовʼязки
// роботодавця (powiadomienie для UA) рахуються заново. Помилкове звільнення: людина роботу не
// припиняла — перший день і подане powiadomienie лишаються чинними, умови, закриті звільненням,
// відкриваються назад, задачі та ще не надіслані документи звільнення скасовуються.
import { useT } from "../lib/i18n";
import { cn } from "./ui";

export type RestoreKind = "rehire" | "mistaken";
export function RestoreKindChoice({ value, onChange }: { value: RestoreKind | null; onChange: (v: RestoreKind) => void }) {
  const t = useT();
  const opt = (k: RestoreKind, title: string, hint: string) => (
    <button type="button" onClick={() => onChange(k)}
      className={cn("rounded-xl border px-3 py-2 text-left transition", value === k ? "border-red-400 bg-red-50 ring-1 ring-red-200" : "border-slate-200 bg-white hover:bg-slate-50")}>
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <span className={cn("h-3.5 w-3.5 shrink-0 rounded-full border", value === k ? "border-red-500 bg-red-500 ring-2 ring-inset ring-white" : "border-slate-300")} />{title}
      </div>
      <div className="mt-0.5 pl-5 text-xs text-slate-500">{hint}</div>
    </button>
  );
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-600">{t("Чому повертаємо?")}</div>
      <div className="grid gap-2">
        {opt("rehire", t("Новий найм — людина йшла й повертається"), t("Перший робочий день і powiadomienie рахуються заново; потрібні нова умова й зголошення."))}
        {opt("mistaken", t("Звільнили помилково — людина не припиняла роботу"), t("Перший день і подане powiadomienie лишаються чинними; умови, закриті звільненням, відкриються назад, задачі й ненадіслані документи звільнення скасуються."))}
      </div>
    </div>
  );
}

// Що відкотилось після «звільнили помилково» — текст для тосту
export type FireUndo = { contractsReopened: number; contractsLeftClosed: number; tasksCancelled: number; docsCancelled: number; docsAlreadySent: number };
export function fireUndoText(t: (s: string, p?: any) => string, u: FireUndo | null | undefined): { ok: string | null; warn: string | null } {
  if (!u) return { ok: null, warn: null };
  const ok = [u.contractsReopened && t("умов відкрито назад: {n}", { n: u.contractsReopened }), u.tasksCancelled && t("задач звільнення скасовано: {n}", { n: u.tasksCancelled }), u.docsCancelled && t("документів скасовано: {n}", { n: u.docsCancelled })].filter(Boolean).join(" · ");
  const warn = [u.contractsLeftClosed && t("умов лишилось закритими датою звільнення: {n} — виправте дату кінця в умовах", { n: u.contractsLeftClosed }), u.docsAlreadySent && t("документів звільнення вже надіслано/підписано: {n} — перевірте їх в умовах", { n: u.docsAlreadySent })].filter(Boolean).join(" · ");
  return { ok: ok || null, warn: warn || null };
}

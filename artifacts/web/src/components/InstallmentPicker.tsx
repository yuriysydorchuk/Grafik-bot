// Вибір схеми зняття залічки (бадання/одяг): зразу · 2 місяці · 3 місяці ·
// частинами (N вручну). При N>1 — перший місяць і превʼю сум по місяцях.
// Значення йде в body як { parts, firstMonth } (api-server/lib/installments.ts).
import { useEffect, useState } from "react";
import { Input, Label, Select } from "./ui";
import { useT } from "../lib/i18n";
import { MAX_PARTS, curMonthWarsaw, monthPlus, splitAmount, type InstallmentPlan } from "../lib/installments";

export const defaultPlan = (): InstallmentPlan => ({ parts: 1, firstMonth: curMonthWarsaw() });

export function InstallmentPicker({ value, onChange, amount, compact }: {
  value: InstallmentPlan; onChange: (v: InstallmentPlan) => void; amount: number; compact?: boolean;
}) {
  const t = useT();
  // Режим — локальний стан (не виводиться з parts): інакше ввід «2» чи «3» у полі
  // кількості перемикав би режим і поле зникало. Чернетка кількості — рядок, щоб
  // можна було стерти й набрати число; у план іде лише валідне 2..MAX_PARTS.
  const [mode, setMode] = useState<"1" | "2" | "3" | "custom">(
    value.parts === 1 ? "1" : value.parts === 2 ? "2" : value.parts === 3 ? "3" : "custom");
  const [draft, setDraft] = useState(String(value.parts));
  useEffect(() => { if (value.parts === 1 && mode !== "1") { setMode("1"); setDraft("1"); } }, [value.parts]); // скидання форми ззовні
  const preview = value.parts > 1 && amount > 0
    ? splitAmount(amount, value.parts).map((a, i) => `${monthPlus(value.firstMonth, i).slice(5, 7)}/${monthPlus(value.firstMonth, i).slice(2, 4)}: ${a.toFixed(2)}`).join(" · ")
    : null;
  const small = compact ? "px-1 py-0.5 text-xs" : "";
  const draftN = Number(draft);
  const draftBad = mode === "custom" && !(Number.isInteger(draftN) && draftN >= 2 && draftN <= MAX_PARTS);
  return (
    <div className={compact ? "flex flex-wrap items-center gap-1" : "space-y-2"}>
      <div className={compact ? "flex flex-wrap items-center gap-1" : "grid grid-cols-2 gap-3"}>
        <div>
          {!compact && <Label>{t("Як знімати")}</Label>}
          <Select value={mode} className={small} title={t("Як знімати")}
            onChange={e => {
              const v = e.target.value as typeof mode;
              setMode(v);
              if (v === "custom") { const n = value.parts >= 2 ? value.parts : 4; setDraft(String(n)); onChange({ ...value, parts: n }); }
              else onChange({ ...value, parts: Number(v) });
            }}>
            <option value="1">{t("зняти зразу")}</option>
            <option value="2">{t("на 2 місяці")}</option>
            <option value="3">{t("на 3 місяці")}</option>
            <option value="custom">{t("частинами…")}</option>
          </Select>
        </div>
        {mode === "custom" && (
          <div>
            {!compact && <Label>{t("Кількість частин")}</Label>}
            <Input type="number" min={2} max={MAX_PARTS} step={1} value={draft} title={t("Кількість частин")}
              className={`${compact ? `w-16 ${small}` : ""} ${draftBad ? "border-rose-400" : ""}`}
              onChange={e => {
                setDraft(e.target.value);
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 2 && n <= MAX_PARTS) onChange({ ...value, parts: n });
              }}
              onBlur={() => { if (draftBad) setDraft(String(value.parts)); }} />
          </div>
        )}
        {value.parts > 1 && (
          <div>
            {!compact && <Label>{t("Перший місяць")}</Label>}
            <Input type="month" value={value.firstMonth} className={compact ? `w-36 ${small}` : ""} title={t("Перший місяць")}
              onChange={e => /^\d{4}-\d{2}$/.test(e.target.value) && onChange({ ...value, firstMonth: e.target.value })} />
          </div>
        )}
      </div>
      {draftBad && <p className="text-xs text-rose-500">{t("Кількість частин — від 2 до {n}", { n: MAX_PARTS })}</p>}
      {preview && <p className="text-xs text-slate-500">{preview}</p>}
    </div>
  );
}

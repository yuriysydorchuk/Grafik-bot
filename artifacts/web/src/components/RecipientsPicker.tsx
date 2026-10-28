// Отримувачі листа клієнту (спільний пікер для /hours: лист про розбіжності, зеставєння —
// місяць і тиждень тижневої фабрики). Винесено з Hours.tsx 28.10.2026.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type EmailRecipient } from "../lib/api";
import { Input, Label } from "./ui";
import { useT } from "../lib/i18n";

// Отримувачі листа: база email-ів фабрики (налаштування фабрики → «Отримувачі
// графіку») чекбоксами — типово всі відмічені — плюс поле «інші адреси» через кому.
// Значення = плоский список адрес, що піде в `to`.
export function RecipientsPicker({ factoryId, value, onChange }: { factoryId: number; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  const { data: factories = [] } = useQuery<{ id: number; emailRecipients?: EmailRecipient[]; clientEmail?: string | null }[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const base = useMemo(() => {
    const f = factories.find(x => x.id === factoryId);
    // legacy-фабрика (без рядків у factory_email_recipients) приходить одним
    // записом «a@b.pl, c@d.pl» — ріжемо кожен запис по роздільниках
    const src = f?.emailRecipients?.length ? f.emailRecipients : [{ email: f?.clientEmail ?? "", name: null as string | null }];
    const seen = new Set<string>();
    return src.flatMap(r => r.email.split(/[,;]/).map(s => s.trim()).filter(Boolean).map(email => ({ email, name: r.name })))
      .filter(r => !seen.has(r.email) && seen.add(r.email));
  }, [factories, factoryId]);
  const [extra, setExtra] = useState("");
  const [checked, setChecked] = useState<Set<string> | null>(null); // null = ще не ініціалізовано з бази
  const sel = checked ?? new Set(base.map(r => r.email));
  const extraList = useMemo(() => extra.split(/[,;]/).map(s => s.trim()).filter(Boolean), [extra]);
  const combined = useMemo(() => [...new Set([...base.filter(r => sel.has(r.email)).map(r => r.email), ...extraList])], [base, sel, extraList]);
  const combinedKey = combined.join("|");
  const valueKey = value.join("|");
  useEffect(() => { if (combinedKey !== valueKey) onChange(combined); }, [combinedKey, valueKey, combined, onChange]);
  const toggle = (email: string) => setChecked(() => { const n = new Set(sel); n.has(email) ? n.delete(email) : n.add(email); return n; });
  return (
    <div>
      <Label>{t("Кому (адреси фабрики)")}</Label>
      {base.length ? (
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {base.map(r => (
            <label key={r.email} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
              <input type="checkbox" checked={sel.has(r.email)} onChange={() => toggle(r.email)} className="accent-red-600" />
              <span className="min-w-0 truncate text-slate-700" title={r.email}>{r.name ? <><span className="font-medium">{r.name}</span> · </> : null}{r.email}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-xs text-amber-700">{t("У налаштуваннях фабрики немає email-адрес — впишіть адресу нижче.")}</div>
      )}
      <Input value={extra} onChange={e => setExtra(e.target.value)} placeholder={t("інші адреси через кому")} className="mt-1.5" />
      {combined.length > 0 && <div className="mt-1 text-xs text-slate-400">{t("Піде на {n} адрес(и): {list}", { n: combined.length, list: combined.join(", ") })}</div>}
    </div>
  );
}


import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { post } from "../lib/api";
import { Button, Modal, Spinner } from "./ui";
import { useT } from "../lib/i18n";
import { LEGAL_LABEL, type LegalStatus } from "../lib/legalStatus";

// ─── Зміни профілю з датою набуття: модалка «Діє з + превʼю» ─────────────────
// Спільна для профілю працівника (WorkerDetail) і модалки редагування
// (WorkerModal): свод-релевантні поля йдуть через dry-run /svodni/profile-impact
// і застосовуються /svodni/profile-apply (профіль + журнал + вибрані рядки).

export const PAYOUT_PREF_LABEL: Record<string, string> = {
  all_konto: "Все на конто", hours: "N годин на конто", amount: "Сума на конто",
};
export type RequestChange = ((changes: Record<string, unknown>, title: string, from?: string) => void) | undefined;

// Людські назви полів журналу/дифів (укр-рядок-як-ключ для t())
export const CHANGE_FIELD_LABEL: Record<string, string> = {
  factoryId: "Фабрика", positionId: "Посада", legalStatus: "Форма легалізації",
  birthDate: "Дата народження", notifyHours: "Год. у повідомленні",
  employmentStartDate: "Дата працевлаштування", agramStazBonus: "Бонус Agram: стаж",
  agramCashBonus: "Бонус Agram: нал", hourlyRate: "Ставка брутто", hourlyRateNetto: "Ставка нетто",
  isStudent: "Студент", payoutPrefKind: "Побажання по виплаті", payoutPrefValue: "Значення побажання",
  fired: "Звільнення", restored: "Поновлення", nationality: "Національність",
};
export const DIFF_KEY_LABEL: Record<string, string> = {
  hoursNotified: "Год. повід.", rateBrutto: "Ставка брутто", rateNetto: "Ставка нетто",
  isStudent: "Студент", under26: "До 26", section: "Секція", doWyplaty: "До виплати",
  brutto: "Brutto", hoursDeclared: "Год. księg.", ksiegBrutto: "Księg. brutto",
  ksiegNetto: "Księg. netto", konto: "Конто", gotowka: "Готівка",
  zusStatus: "Księgowość (текст)", dataUrodzenia: "Дата народження",
};
// На що поле впливає в системі (місця-споживачі) — показується в превʼю зміни,
// щоб було видно наслідки за межами конкретних рядків сводної
const FIELD_IMPACTS: Record<string, string[]> = {
  legalStatus: ["Розклад konto/готівка у сводних", "Księgowa ставка (нижча зі ставок)", "Фінанси: розрахунок ЗП"],
  birthDate: ["Пільга «до 26» (податки)", "Розклад konto/готівка у сводних", "Фінанси: розрахунок ЗП"],
  notifyHours: ["Ліміт декларованих годин → konto/готівка у сводних"],
  hourlyRate: ["Ставка в сводних і нових місяцях", "Фінанси: розрахунок ЗП", "Excel-сводна"],
  hourlyRateNetto: ["Ставка в сводних і нових місяцях", "Фінанси: розрахунок ЗП", "Excel-сводна"],
  agramStazBonus: ["Ставка нетто Agram (бонус вшивається у ставку)"],
  agramCashBonus: ["Ставка нетто Agram (бонус вшивається у ставку)"],
  employmentStartDate: ["Ярус стаж-бонусу Agram (+1 від 1 міс, +1.5 від 6)"],
  payoutPrefKind: ["Пріоритетний розклад konto/готівка (понад правила)"],
  payoutPrefValue: ["Пріоритетний розклад konto/готівка (понад правила)"],
  positionId: ["Секція в сводній", "Генерація графіка (вимоги посад)", "Excel-графік клієнту"],
  isStudent: ["Розклад konto/готівка у сводних", "Фінанси: розрахунок ЗП"],
};
const MONEY_KEYS: { key: string; label: string }[] = [
  { key: "doWyplaty", label: "До виплати" },
  { key: "konto", label: "Конто" },
  { key: "gotowka", label: "Готівка" },
];
export const fmtVal = (v: unknown, t: (s: string) => string): string =>
  v == null || v === "" ? "—"
  : v === true || v === "true" ? "✓"
  : v === false || v === "false" ? "✕"
  : LEGAL_LABEL[v as LegalStatus] ? t(LEGAL_LABEL[v as LegalStatus])
  : PAYOUT_PREF_LABEL[v as string] ? t(PAYOUT_PREF_LABEL[v as string]!)
  : String(v);
const todayStr = () => new Date().toLocaleDateString("sv-SE");

export type ImpactItem = {
  rowId: number; month: string; city: string; factoryLabel: string; locked: boolean;
  hours: number | null; merge?: boolean; diffs: { key: string; from: unknown; to: unknown }[];
  // план порізки місяця на сегменти (зміна з середини місяця): кожен сегмент
  // рахується за правилами свого статусу
  split?: {
    from: string; to: string; hours: number; rateNetto: number | null; label: string | null;
    legal: string | null; doWyplaty: number | null; konto?: number | null; gotowka?: number | null;
  }[];
};
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
// кольори сегментів у превʼю порізки — ті самі, що в таблиці сводної
const SPLIT_TEXT = ["text-violet-700", "text-sky-700", "text-teal-700", "text-rose-700"];
const SPLIT_DOT = ["bg-violet-400", "bg-sky-400", "bg-teal-400", "bg-rose-400"];

// Модалка «зміна від дати»: питає дату набуття, показує що зачепить у сводних
// (dry-run /svodni/profile-impact) і застосовує вибране (/svodni/profile-apply)
export function ProfileChangeModal({ workerId, changes, title, initialFrom, onClose }: {
  workerId: number; changes: Record<string, unknown>; title: string; initialFrom?: string; onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [fromDraft, setFromDraft] = useState(initialFrom ?? todayStr());
  // Дата народження — факт, а не зміна умов «з дати»: питання «Діє з» не
  // ставимо, зміна діє від самої дати народження (покриває всі місяці сводних;
  // очищення дати — теж по всіх, тому рання константа)
  const birthOnly = Object.keys(changes).length === 1 && "birthDate" in changes;
  const from = birthOnly ? ((changes.birthDate as string | null) || "1900-01-01") : fromDraft;
  const [deselected, setDeselected] = useState<Set<number>>(new Set());
  const { data, isFetching, isError, error } = useQuery<{ items: ImpactItem[]; checkedRows: number; workerMonths: string[] }>({
    queryKey: ["profile-impact", workerId, JSON.stringify(changes), from],
    queryFn: () => post("/svodni/profile-impact", { workerId, changes, from }),
  });
  const items = data?.items ?? [];
  const selectable = items.filter(i => !i.locked);
  const selectedIds = selectable.filter(i => !deselected.has(i.rowId)).map(i => i.rowId);
  const lockedItems = items.filter(i => i.locked);
  const apply = useMutation({
    mutationFn: (rowIds: number[]) => post<{ applied: number }>("/svodni/profile-apply", { workerId, changes, from, rowIds }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["worker"] });
      qc.invalidateQueries({ queryKey: ["worker-changes"] });
      qc.invalidateQueries({ queryKey: ["workers"] });
      qc.invalidateQueries({ queryKey: ["svodni"] });
      toast.success(r.applied ? t("Застосовано: профіль + {n} рядків сводної", { n: r.applied }) : t("Збережено в профіль"));
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const changesSummary = Object.entries(changes)
    .map(([k, v]) => `${t(CHANGE_FIELD_LABEL[k] ?? k)} → ${fmtVal(v, t)}`).join("; ");
  // місця-споживачі поля + сумарний грошовий ефект по вибраних рядках
  const consumers = [...new Set(Object.keys(changes).flatMap(k => FIELD_IMPACTS[k] ?? []))];
  const selectedItems = items.filter(i => !i.locked && !deselected.has(i.rowId));
  const totals = MONEY_KEYS.map(({ key, label }) => ({
    label,
    delta: Math.round(selectedItems.reduce((a, it) => {
      const d = it.diffs.find(d => d.key === key);
      return a + (d ? (Number(d.to) || 0) - (Number(d.from) || 0) : 0);
    }, 0) * 100) / 100,
  })).filter(x => x.delta !== 0);
  return (
    <Modal open title={t("Зміна: {what}", { what: title })} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="rounded-lg bg-slate-50 px-3 py-2 font-medium text-slate-700">{changesSummary}</div>
        {consumers.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold uppercase tracking-wide text-slate-400">{t("Впливає на")}:</span>
            {consumers.map(c => (
              <span key={c} className="rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-700">{t(c)}</span>
            ))}
          </div>
        )}
        {birthOnly ? (
          <div className="text-xs text-slate-400">{t("Дата народження — факт: діє одразу по всіх місяцях, дату набуття не питаємо.")}</div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500">{t("Діє з")}</span>
            <input type="date" value={fromDraft} onChange={e => setFromDraft(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-red-400 focus:outline-none" />
          </div>
        )}
        {/* зведене попередження: частина зачеплених сводних затверджена — їхні
            цифри зараз не зміняться; при розблокуванні зміна випливе в ревʼю */}
        {lockedItems.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {t("Рядків у затверджених сводних: {n} — їхні цифри зараз НЕ зміняться. При розблокуванні сводної система запропонує прийняти або відхилити цю зміну.", { n: lockedItems.length })}
            </span>
          </div>
        )}
        {isError ? (
          <div className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700">
            {t("Не вдалося завантажити превʼю впливу")}: {(error as any)?.message ?? ""}
          </div>
        ) : isFetching ? <Spinner /> : !items.length ? (
          <div className="space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-slate-500">
            {(data?.checkedRows ?? 0) > 0 ? (
              <div>{t("Перевірено рядків сводних: {n} — ця зміна їхніх цифр не міняє (значення й так збігаються). Оновиться профіль.", { n: data!.checkedRows })}</div>
            ) : (
              <>
                <div>{t("Від {date} рядків сводної в цієї людини нема — оновиться лише профіль (нові місяці порахуються вже по-новому).", { date: from })}</div>
                {(data?.workerMonths?.length ?? 0) > 0 && (
                  <div className="text-xs">
                    {t("Наявні сводні: {months}. Якщо зміна діє заднім числом — обери ранішу дату.", { months: data!.workerMonths.join(", ") })}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Зачепить у сводних")}</div>
            {items.map(it => (
              <label key={it.rowId} className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 ${it.locked ? "border-slate-100 bg-slate-50 opacity-70" : "cursor-pointer border-slate-200 hover:bg-slate-50"}`}>
                <input type="checkbox" className="mt-0.5" disabled={it.locked}
                  checked={!it.locked && !deselected.has(it.rowId)}
                  onChange={e => setDeselected(prev => {
                    const n = new Set(prev);
                    e.target.checked ? n.delete(it.rowId) : n.add(it.rowId);
                    return n;
                  })} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-medium text-slate-700">
                    {it.month} · {t(it.city)} · {it.factoryLabel}
                    {it.locked && <span className="flex items-center gap-0.5 rounded bg-amber-50 px-1 text-[10px] font-semibold text-amber-700"><Lock className="h-3 w-3" /> {t("затверджено — не зміниться")}</span>}
                  </span>
                  {it.merge && (
                    <span className="mt-0.5 block text-xs font-medium text-teal-700">
                      🪡 {t("умови вирівнялись по всьому місяцю — сегменти зіллються в один рядок")}
                    </span>
                  )}
                  {it.split && (
                    <span className="mt-1 block space-y-0.5 text-xs">
                      <span className="block font-semibold text-violet-700">🧩 {t("місяць поріжеться на сегменти")}:</span>
                      {it.split.map((s, i) => (
                        <span key={i} className="flex items-center gap-1.5 pl-4 text-slate-600">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${SPLIT_DOT[i % SPLIT_DOT.length]}`} />
                          <span>
                            <span className={`font-semibold ${SPLIT_TEXT[i % SPLIT_TEXT.length]}`}>{ddmm(s.from)}–{ddmm(s.to)}</span>
                            {": "}{s.hours} {t("год")}{s.rateNetto != null ? ` × ${s.rateNetto} zł` : ""}
                            {s.doWyplaty != null ? ` → ${t("до виплати")} ${s.doWyplaty}` : ""}
                            {s.konto != null ? ` (${t("конто")} ${s.konto} / ${t("готівка")} ${s.gotowka ?? 0})` : ""}
                            {s.label ? ` · ${s.label}` : ""}
                          </span>
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {it.diffs.map(d => `${t(DIFF_KEY_LABEL[d.key] ?? d.key)}: ${fmtVal(d.from, t)} → ${fmtVal(d.to, t)}`).join(" · ")}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        {totals.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50/70 px-3 py-2 text-xs">
            <span className="font-semibold uppercase tracking-wide text-amber-700">{t("Сумарно по вибраних")}:</span>
            {totals.map(x => (
              <span key={x.label} className={`font-semibold ${x.delta > 0 ? "text-emerald-700" : "text-rose-700"}`}>
                {t(x.label)}: {x.delta > 0 ? "+" : ""}{x.delta} zł
              </span>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          {/* без превʼю не застосовуємо: помилка/фетч — наслідки невідомі */}
          {!isError && !isFetching && (
            <Button variant="secondary" loading={apply.isPending} onClick={() => apply.mutate([])}>{t("Лише профіль")}</Button>
          )}
          {selectedIds.length > 0 && (
            <Button loading={apply.isPending} onClick={() => apply.mutate(selectedIds)}>
              {t("Застосувати ({n})", { n: selectedIds.length })}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

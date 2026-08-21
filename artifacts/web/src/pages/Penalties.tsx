// «Штрафи» — штрафи з ЗП за місяць: місто → фабрика → працівники і суми.
// Ручний реєстр штрафів з зарплати + перенесення у колонку Kara сводної
// (формат як «Бадання до зняття» в Авансах: чекбокси → вибір місяця →
// перенести; перенесений рядок — бейдж «сводна YYYY-MM» + відміна).
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Gavel, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Button, Input, Modal, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { monthOptions } from "../lib/dates";
import { useT } from "../lib/i18n";

type PenaltyRow = {
  id: number; workerId: number; workerName: string | null; city: string | null;
  factoryId: number | null; factoryLabel: string | null; amount: number; note: string | null;
  deducted: boolean; deductedAt: string | null; deductedMonth: string | null;
};
type Data = { month: string; months: string[]; rows: PenaltyRow[] };
type ApplyResp = {
  updated: number; itemsMarked: number; verified: number;
  verifyMismatches: { workerName: string; expected: number | null; actual: number | null }[];
  skippedLocked: number; unmatched: { workerName: string | null; amount: number }[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export default function Penalties() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const months = useMemo(() => monthOptions(), []);
  const [month, setMonth] = useState(months[0]!.value);
  const [adding, setAdding] = useState(false);
  const { data, isFetching } = useQuery<Data>({ queryKey: ["penalties", month], queryFn: () => get(`/penalties?month=${month}`) });
  // Фільтри «зверху»: місто/фабрика звужують картки, підсумки і перенесення в сводну
  const [cityF, setCityF] = useState("");  // "" = всі міста
  const [facF, setFacF] = useState("");    // "" = всі фабрики
  const cities = useMemo(() =>
    [...new Set((data?.rows ?? []).map(r => r.city).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, "pl")), [data]);
  const factoryOpts = useMemo(() =>
    [...new Set((data?.rows ?? []).filter(r => !cityF || r.city === cityF).map(r => r.factoryLabel).filter((f): f is string => !!f))].sort((a, b) => a.localeCompare(b, "pl")), [data, cityF]);
  const rows = useMemo(() => (data?.rows ?? []).filter(r =>
    (!cityF || r.city === cityF) && (!facF || r.factoryLabel === facF)), [data, cityF, facF]);
  const remove = useMutation({
    mutationFn: (id: number) => del(`/penalties/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["penalties"] }),
    onError: (e: any) => toast.error(e.message),
  });
  const edit = useMutation({
    mutationFn: (p: { id: number; amount: number }) => patch(`/penalties/${p.id}`, { amount: p.amount }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["penalties"] }),
    onError: (e: any) => toast.error(e.message),
  });

  // ── Перенесення у Kara сводної ─────────────────────────────────────────────
  const pending = useMemo(() => rows.filter(r => !r.deducted), [rows]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  // типово вибрані всі незняті — «перенести всі» це просто кнопка без зняття галочок
  useEffect(() => { setSel(new Set(pending.map(r => r.id))); }, [pending]);
  const toggle = (id: number) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = pending.length > 0 && sel.size === pending.length;
  const selSum = r2(pending.filter(r => sel.has(r.id)).reduce((a, r) => a + r.amount, 0));
  // місяці на вибір — РЕАЛЬНІ місяці сводних (щоб перенесення цілило в наявну
  // вкладку); місяць сторінки завжди в списку як фолбек і є дефолтом
  const { data: svodniMonths } = useQuery<{ months: string[] }>({
    queryKey: ["svodni-months"], queryFn: () => get("/svodni/months"),
  });
  const [target, setTarget] = useState(month);
  useEffect(() => { setTarget(month); }, [month]);
  const targetMonths = useMemo(
    () => [...new Set([month, ...(svodniMonths?.months ?? [])])].sort().reverse(),
    [month, svodniMonths]);
  const apply = useMutation({
    mutationFn: () => post<ApplyResp>("/svodni/apply-penalty-deductions", { month: target, ids: [...sel] }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["penalties"] });
      const parts = [`${t("оновлено рядків")}: ${d.updated}`, `${t("позицій знято")}: ${d.itemsMarked}`, `${t("звірено")}: ${d.verified - d.verifyMismatches.length}/${d.verified} ✓`];
      if (d.skippedLocked) parts.push(`${t("пропущено затверджених")}: ${d.skippedLocked}`);
      toast.success(t("Перенесено до сводної"), { description: parts.join(", ") });
      if (d.verifyMismatches.length) {
        toast.error(`${t("Самозвірка не зійшлася")}: ${d.verifyMismatches.length}`, {
          description: d.verifyMismatches.slice(0, 6).map(v => `${v.workerName}: ${v.expected ?? 0} ≠ ${v.actual ?? 0}`).join(", "), duration: 15000,
        });
      }
      if (d.unmatched.length) {
        toast.warning(`${t("Без рядка сводної")}: ${d.unmatched.length}`, {
          description: d.unmatched.slice(0, 6).map(u => u.workerName ?? "—").join(", ") + (d.unmatched.length > 6 ? "…" : ""), duration: 12000,
        });
      }
    },
    onError: (e: any) => toast.error(e.message),
  });
  const undo = useMutation({
    mutationFn: (id: number) => post<{ month: string; subtracted: { factoryLabel: string; newValue: number | null } | null; warning: string | null }>("/svodni/undo-penalty-deduction", { id }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["penalties"] });
      if (d.warning) toast.warning(t("Відмінено з попередженням"), { description: d.warning, duration: 12000 });
      else toast.success(t("Відмінено"), { description: `${d.subtracted!.factoryLabel} (${d.month}): Kara → ${d.subtracted!.newValue ?? 0} zł` });
    },
    onError: (e: any) => toast.error(e.message),
  });

  // місто → фабрика → рядки
  const groups = useMemo(() => {
    const byCity = new Map<string, Map<string, PenaltyRow[]>>();
    for (const r of rows) {
      const c = r.city ?? "—";
      const f = r.factoryLabel ?? t("Без фабрики");
      const m = byCity.get(c) ?? byCity.set(c, new Map()).get(c)!;
      (m.get(f) ?? m.set(f, []).get(f)!).push(r);
    }
    return [...byCity.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, t]);
  const total = r2(rows.reduce((a, r) => a + r.amount, 0));

  return (
    <>
      <PageHeader title={t("Штрафи")} subtitle={t("Штрафи з зарплати — ручний реєстр по місяцях")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        <Select value={cityF} onChange={e => { setCityF(e.target.value); setFacF(""); }} className="w-40">
          <option value="">{t("Всі міста")}</option>
          {cities.map(c => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select value={facF} onChange={e => setFacF(e.target.value)} className="w-48">
          <option value="">{t("Всі фабрики")}</option>
          {factoryOpts.map(f => <option key={f} value={f}>{f}</option>)}
        </Select>
        {data && <Badge color="green">{t("Знято разом:")} {total.toFixed(2)} zł</Badge>}
        {data && <Badge color="slate">{rows.length} {t("ос.")}</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {pending.length > 0 && (
            <>
              <Select value={target} onChange={e => setTarget(e.target.value)} className="w-36" title={t("Місяць сводної")}>
                {targetMonths.map(m => <option key={m} value={m}>{m}</option>)}
              </Select>
              <Button loading={apply.isPending} disabled={!sel.size}
                onClick={async () => { if (await confirm({ title: t("Перенести штрафи до сводної?"), message: t("Суми вибраних ляжуть у колонку Kara рядка фабрики штрафу (нема рядка пари — основної фабрики людини) за вибраний місяць (додаються до наявних). Затверджені вкладки пропускаються."), confirmText: t("Перенести") })) apply.mutate(); }}>
                → {allSelected ? t("Перенести всі") : `${t("Перенести вибрані")} (${sel.size})`} · {selSum.toFixed(2)} zł
              </Button>
            </>
          )}
          <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати штраф")}</Button>
        </div>
      </div>
      {adding && <AddPenaltyModal month={month} onClose={() => setAdding(false)} />}
      {isFetching && !data ? <Spinner /> : !groups.length ? (
        <Empty>{t("За цей місяць штрафів немає")}</Empty>
      ) : (
        <div className="space-y-5">
          {groups.map(([city, byFactory]) => (
            <Card key={city} className="overflow-hidden">
              <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
                <Gavel className="h-4 w-4 text-slate-400" />
                <span className="text-sm font-bold tracking-tight text-slate-800">{t(city)}</span>
                <Badge color="slate">{[...byFactory.values()].reduce((a, rs) => a + rs.length, 0)} {t("ос.")}</Badge>
                <span className="ml-auto text-sm font-semibold tabular-nums text-slate-700">
                  {r2([...byFactory.values()].flat().reduce((a, r) => a + r.amount, 0)).toFixed(2)} zł
                </span>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {[...byFactory.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([factory, rows]) => [
                    <tr key={`f-${factory}`} className="bg-slate-50/80">
                      <td colSpan={2} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">{factory}</td>
                      <td className="px-4 py-1.5 text-right text-[11px] font-semibold tabular-nums text-slate-500">
                        {r2(rows.reduce((a, r) => a + r.amount, 0)).toFixed(2)} zł
                      </td>
                      <td />
                    </tr>,
                    ...rows.map(r => (
                      <tr key={r.id} className="group hover:bg-red-50/30">
                        <td className="w-8 px-3 py-1.5 pl-4">
                          {!r.deducted && (
                            <input type="checkbox" className="accent-red-600" checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                          )}
                        </td>
                        <td className="px-4 py-1.5 text-slate-700">
                          {r.workerName ?? `#${r.workerId}`}
                          {r.note && <span className="ml-2 text-xs text-slate-400">{r.note}</span>}
                          {r.deducted && <Badge color="green">{t("сводна")} {r.deductedMonth ?? ""}</Badge>}
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums">
                          {r.deducted
                            ? <span className="tabular-nums text-slate-500">{r.amount.toFixed(2)}</span>
                            : <AmountCell value={r.amount} onSave={(v) => edit.mutate({ id: r.id, amount: v })} />}
                        </td>
                        <td className="w-24 px-2 text-right">
                          {r.deducted ? (
                            <button className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              onClick={async () => { if (await confirm({ title: t("Відмінити зняття?"), message: `${r.workerName ?? r.workerId} · ${r.amount} zł — ${t("сума віднімається з клітинки Kara сводної")} ${r.deductedMonth}. ${t("Запис повернеться у «до зняття».")}`, danger: true, confirmText: t("Відмінити") })) undo.mutate(r.id); }}>
                              ↩ {t("Відмінити")}
                            </button>
                          ) : (
                            <button type="button" title={t("Видалити")}
                              onClick={() => window.confirm(`${r.workerName ?? r.workerId}: ${t("видалити штраф?")}`) && remove.mutate(r.id)}
                              className="invisible rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500 group-hover:visible">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function AmountCell({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing) {
    return (
      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={() => { const v = Number(draft.replace(",", ".")); if (Number.isFinite(v) && v > 0 && v !== value) onSave(v); setEditing(false); }}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }}
        className="w-24 rounded-md border border-red-400 px-1 py-0.5 text-right text-sm focus:outline-none" />
    );
  }
  return (
    <button type="button" onClick={() => { setDraft(String(value)); setEditing(true); }}
      title={t("Клікни, щоб редагувати")}
      className="cursor-text rounded px-1 tabular-nums hover:bg-red-50 hover:ring-1 hover:ring-red-200">
      {value.toFixed(2)}
    </button>
  );
}

function AddPenaltyModal({ month, onClose }: { month: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const { data: workers } = useQuery<{ id: number; fullName: string; factoryName?: string | null; isActive?: boolean }[]>({
    queryKey: ["workers"], queryFn: () => get("/workers"),
  });
  const add = useMutation({
    mutationFn: () => post("/penalties", { month, workerId, amount: Number(amount.replace(",", ".")), ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["penalties"] }); toast.success(t("Додано")); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const needle = q.trim().toLowerCase();
  const found = needle.length >= 2 ? (workers ?? []).filter(w => w.fullName.toLowerCase().includes(needle)).slice(0, 8) : [];
  const sel = (workers ?? []).find(w => w.id === workerId);
  return (
    <Modal open onClose={onClose} title={t("Додати штраф")}>
      <div className="space-y-3">
        <div>
          <Label>{t("Працівник")}</Label>
          {sel ? (
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <span className="font-medium">{sel.fullName}</span>
              <button className="ml-auto text-xs text-slate-400 hover:text-rose-500" onClick={() => setWorkerId(null)}>✕</button>
            </div>
          ) : (
            <>
              <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("Пошук по імені…")} autoFocus />
              {found.length > 0 && (
                <div className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {found.map(w => (
                    <button key={w.id} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-red-50" onClick={() => setWorkerId(w.id)}>
                      {w.fullName}
                      {w.factoryName && <span className="text-xs text-slate-400">{w.factoryName}</span>}
                      {w.isActive === false && <Badge color="rose">{t("звільнений")}</Badge>}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div><Label>{t("Сума, zł")}</Label><Input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" /></div>
        <div><Label>{t("Примітка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} placeholder={t("необовʼязково")} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={add.isPending} disabled={!workerId || !(Number(amount.replace(",", ".")) > 0)} onClick={() => add.mutate()}>{t("Додати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// «Хостели» — зняття за хостел із ЗП за місяць: місто → фабрика → працівники
// і суми. Джерело колонки Hostel у сводній («Години підтверджені → до сводної»
// підтягує суму по людині). Поки лише таблиця «знято з ЗП» + ручний CRUD.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Home, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Button, Input, Modal, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { monthOptions } from "../lib/dates";
import { useT } from "../lib/i18n";

type HostelRow = { id: number; workerId: number; workerName: string | null; city: string | null; factoryId: number | null; factoryLabel: string | null; amount: number; note: string | null };
type Data = { month: string; months: string[]; rows: HostelRow[] };

const r2 = (n: number) => Math.round(n * 100) / 100;

export default function Hostels() {
  const t = useT();
  const qc = useQueryClient();
  const months = useMemo(() => monthOptions(), []);
  const [month, setMonth] = useState(months[0]!.value);
  const [adding, setAdding] = useState(false);
  const { data, isFetching } = useQuery<Data>({ queryKey: ["hostels", month], queryFn: () => get(`/hostels?month=${month}`) });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/hostels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hostels"] }),
    onError: (e: any) => toast.error(e.message),
  });
  const edit = useMutation({
    mutationFn: (p: { id: number; amount: number }) => patch(`/hostels/${p.id}`, { amount: p.amount }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hostels"] }),
    onError: (e: any) => toast.error(e.message),
  });

  // місто → фабрика → рядки
  const groups = useMemo(() => {
    const byCity = new Map<string, Map<string, HostelRow[]>>();
    for (const r of data?.rows ?? []) {
      const c = r.city ?? "—";
      const f = r.factoryLabel ?? t("Без фабрики");
      const m = byCity.get(c) ?? byCity.set(c, new Map()).get(c)!;
      (m.get(f) ?? m.set(f, []).get(f)!).push(r);
    }
    return [...byCity.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, t]);
  const total = r2((data?.rows ?? []).reduce((a, r) => a + r.amount, 0));

  return (
    <>
      <PageHeader title={t("Хостели")} subtitle={t("Зняття за хостел із зарплати — джерело колонки Hostel у сводній")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        {data && <Badge color="green">{t("Знято разом:")} {total.toFixed(2)} zł</Badge>}
        {data && <Badge color="slate">{data.rows.length} {t("ос.")}</Badge>}
        <Button className="ml-auto" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати зняття")}</Button>
      </div>
      {adding && <AddHostelModal month={month} onClose={() => setAdding(false)} />}
      {isFetching && !data ? <Spinner /> : !groups.length ? (
        <Empty>{t("За цей місяць знять за хостел немає")}</Empty>
      ) : (
        <div className="space-y-5">
          {groups.map(([city, byFactory]) => (
            <Card key={city} className="overflow-hidden">
              <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
                <Home className="h-4 w-4 text-slate-400" />
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
                      <td className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">{factory}</td>
                      <td className="px-4 py-1.5 text-right text-[11px] font-semibold tabular-nums text-slate-500">
                        {r2(rows.reduce((a, r) => a + r.amount, 0)).toFixed(2)} zł
                      </td>
                      <td />
                    </tr>,
                    ...rows.map(r => (
                      <tr key={r.id} className="group hover:bg-red-50/30">
                        <td className="px-4 py-1.5 pl-8 text-slate-700">{r.workerName ?? `#${r.workerId}`}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">
                          <AmountCell value={r.amount} onSave={(v) => edit.mutate({ id: r.id, amount: v })} />
                        </td>
                        <td className="w-10 px-2 text-right">
                          <button type="button" title={t("Видалити")}
                            onClick={() => window.confirm(`${r.workerName ?? r.workerId}: ${t("видалити зняття?")}`) && remove.mutate(r.id)}
                            className="invisible rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500 group-hover:visible">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
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

function AddHostelModal({ month, onClose }: { month: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const { data: workers } = useQuery<{ id: number; fullName: string; factoryName?: string | null; isActive?: boolean }[]>({
    queryKey: ["workers"], queryFn: () => get("/workers"),
  });
  const add = useMutation({
    mutationFn: () => post("/hostels", { month, workerId, amount: Number(amount.replace(",", ".")) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hostels"] }); toast.success(t("Додано")); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const needle = q.trim().toLowerCase();
  const found = needle.length >= 2 ? (workers ?? []).filter(w => w.fullName.toLowerCase().includes(needle)).slice(0, 8) : [];
  const sel = (workers ?? []).find(w => w.id === workerId);
  return (
    <Modal open onClose={onClose} title={t("Додати зняття за хостел")}>
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
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={add.isPending} disabled={!workerId || !(Number(amount.replace(",", ".")) > 0)} onClick={() => add.mutate()}>{t("Додати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

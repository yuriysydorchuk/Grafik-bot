import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Check, RotateCcw, Scale, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { get, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { ObligationModal, type Obligation as Ob } from "../components/ObligationModal";

interface Meta { companies: { id: number; name: string }[] }

const zl = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;

export default function Obligations() {
  const t = useT();
  const qc = useQueryClient();
  const [status, setStatus] = useState("open");
  const [companyId, setCompanyId] = useState("");
  const [editing, setEditing] = useState<Ob | null>(null);
  const [adding, setAdding] = useState(false);

  const meta = useQuery<Meta>({ queryKey: ["bank-meta"], queryFn: () => get("/bank/meta") });
  const params = new URLSearchParams({ status });
  if (companyId) params.set("companyId", companyId);
  const q = useQuery<{ rows: Ob[]; totals: { receivable: number; payable: number; net: number } }>({
    queryKey: ["obligations", params.toString()], queryFn: () => get(`/obligations?${params}`),
  });
  const coName = (id: number | null) => meta.data?.companies.find(c => c.id === id)?.name ?? "—";
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["obligations"] }); qc.invalidateQueries({ queryKey: ["cashflow"] }); };
  const d = q.data;
  const overdue = (o: Ob) => o.status === "open" && o.dueDate && o.dueDate < new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader title={t("Належності")} subtitle={t("Хто винен нам і що винні ми: недоотримані оплати, податки, неоплачені фактури")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Статус")}</div>
          <Select value={status} onChange={e => setStatus(e.target.value)} className="w-36">
            <option value="open">{t("Відкриті")}</option>
            <option value="settled">{t("Закриті")}</option>
            <option value="all">{t("Всі")}</option>
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Фірма")}</div>
          <Select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-40">
            <option value="">{t("Усі")}</option>
            {meta.data?.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />{t("Запис")}</Button>
      </div>

      {q.isFetching && !d ? <Spinner /> : d && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Metric icon={<ArrowDownLeft className="h-5 w-5 text-emerald-500" />} label={t("Нам винні")} value={d.totals.receivable} tone="text-emerald-700" />
          <Metric icon={<ArrowUpRight className="h-5 w-5 text-rose-500" />} label={t("Ми винні")} value={d.totals.payable} tone="text-rose-600" />
          <Metric icon={<Scale className="h-5 w-5 text-slate-400" />} label={t("Нетто")} value={d.totals.net} tone={d.totals.net >= 0 ? "text-emerald-700" : "text-rose-600"} />
        </div>
      )}

      <Card className="mt-4 p-0">
        {q.isFetching && !d ? <div className="p-5"><Spinner /></div> : !(d?.rows.length) ? <div className="p-5"><Empty>{t("Немає записів")}</Empty></div> : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
              <th className="px-4 py-2 text-left">{t("Хто / кому")}</th>
              {!companyId && <th className="px-3 py-2 text-left">{t("Фірма")}</th>}
              <th className="px-3 py-2 text-left">{t("Опис")}</th>
              <th className="px-3 py-2 text-left">{t("Термін")}</th>
              <th className="px-3 py-2 text-right">{t("Сума")}</th>
              <th className="px-2 py-2"></th>
            </tr></thead>
            <tbody>
              {d!.rows.map(o => (
                <tr key={o.id} className={`border-b border-slate-100 ${o.status === "settled" ? "opacity-50" : ""} ${overdue(o) ? "bg-amber-50" : ""}`}>
                  <td className="px-4 py-2">
                    <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${o.direction === "receivable" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                      {o.direction === "receivable" ? t("нам") : t("ми")}
                    </span>
                    <span className="font-medium text-slate-700">{o.counterparty}</span>
                  </td>
                  {!companyId && <td className="px-3 py-2 text-slate-500">{coName(o.companyId)}</td>}
                  <td className="px-3 py-2 text-slate-500"><div className="max-w-[280px] truncate">{o.description || "—"}</div></td>
                  <td className="px-3 py-2 text-slate-500">
                    {o.status === "settled" ? <span>{t("закрито")} {o.settledAt}</span> : o.dueDate ?? "—"}
                    {overdue(o) && <span className="ml-1.5 text-[11px] font-medium text-amber-600">{t("прострочено")}</span>}
                  </td>
                  <td className={`whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums ${o.direction === "receivable" ? "text-emerald-600" : "text-rose-600"}`}>{zl(o.amount)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right">
                    {o.status === "open" ? (
                      <button className="p-1 text-slate-300 hover:text-emerald-600" title={t("Закрити (оплачено/отримано)")}
                        onClick={async () => { await patch(`/obligations/${o.id}`, { status: "settled" }); invalidate(); }}><Check className="h-4 w-4" /></button>
                    ) : (
                      <button className="p-1 text-slate-300 hover:text-slate-600" title={t("Повернути у відкриті")}
                        onClick={async () => { await patch(`/obligations/${o.id}`, { status: "open" }); invalidate(); }}><RotateCcw className="h-4 w-4" /></button>
                    )}
                    {o.source === "manual" && (
                      <>
                        <button className="p-1 text-slate-300 hover:text-slate-600" onClick={() => setEditing(o)}><Pencil className="h-4 w-4" /></button>
                        <button className="p-1 text-slate-300 hover:text-rose-500" onClick={async () => { if (confirm(t("Видалити запис?"))) { await del(`/obligations/${o.id}`); invalidate(); } }}><Trash2 className="h-4 w-4" /></button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {(adding || editing) && (
        <ObligationModal companies={meta.data?.companies ?? []} ob={editing} defaults={{ companyId }}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); invalidate(); }} />
      )}
    </>
  );
}

function Metric({ icon, label, value, tone = "text-slate-800" }: { icon: React.ReactNode; label: string; value: number; tone?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between"><div className="text-sm font-medium text-slate-500">{label}</div>{icon}</div>
      <div className={`mt-2 text-2xl font-bold ${tone}`}>{zl(value)}</div>
    </Card>
  );
}

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search, FileText, AlertTriangle, Plus, Pencil, Trash2 } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

interface Meta { companies: { id: number; name: string }[]; years: string[]; categories: string[] }
interface Inv {
  id: number; companyId: number | null; periodMonth: string; docType: string | null;
  issueDate: string | null; number: string | null; amount: number; statusRaw: string | null;
  unpaid: boolean; dueDate: string | null; counterparty: string | null; category: string | null; paidDate: string | null;
  manualStatus: string | null; manualPaidDate: string | null; manualCategory: string | null;
  effUnpaid: boolean; effPaidDate: string | null; effCategory: string; editable: boolean;
  cashPaid: boolean;
}
interface CatSum { category: string; total: number; n: number; unpaid: number; unpaidCount: number }

const zl = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const MONTHS_UK = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];

export default function Invoices() {
  const t = useT();
  const qc = useQueryClient();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [monthNum, setMonthNum] = useState(String(now.getMonth() + 1).padStart(2, "0"));
  const [companyId, setCompanyId] = useState("");
  const [status, setStatus] = useState("");
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Inv | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const meta = useQuery<Meta>({ queryKey: ["inv-meta"], queryFn: () => get("/invoices/meta") });
  const params = new URLSearchParams({ year });
  if (monthNum) params.set("month", monthNum);
  if (companyId) params.set("companyId", companyId);
  if (status) params.set("status", status);
  if (cat) params.set("cat", cat);
  if (q) params.set("q", q);
  const data = useQuery<{ rows: Inv[]; totals: { total: number; count: number; unpaid: number; unpaidCount: number }; categories: CatSum[] }>({
    queryKey: ["invoices", params.toString()], queryFn: () => get(`/invoices?${params}`),
  });
  const coName = (id: number | null) => meta.data?.companies.find(c => c.id === id)?.name ?? "—";
  const invalidate = () => ["invoices", "inv-meta", "balance", "cashflow"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  const d = data.data;
  const today = new Date().toISOString().slice(0, 10);
  const togglePaid = async (r: Inv) => {
    setBusyId(r.id);
    try { await patch(`/invoices/${r.id}`, { paid: r.effUnpaid }); invalidate(); } finally { setBusyId(null); }
  };

  return (
    <>
      <PageHeader title={t("Фактури")} subtitle={t("Кошторисні фактури (ES · ESO · Klinex): статус оплати, категорії; неоплачені входять у «ми винні»")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Рік")}</div>
          <Select value={year} onChange={e => setYear(e.target.value)} className="w-24">
            {(meta.data?.years?.length ? meta.data.years : [year]).map(y => <option key={y} value={y}>{y}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Період")}</div>
          <Select value={monthNum} onChange={e => setMonthNum(e.target.value)} className="w-32">
            <option value="">{t("Весь рік")}</option>
            {MONTHS_UK.map((m, i) => <option key={i} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Фірма")}</div>
          <Select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-28">
            <option value="">{t("Усі")}</option>
            {meta.data?.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Статус")}</div>
          <Select value={status} onChange={e => setStatus(e.target.value)} className="w-32">
            <option value="">{t("Всі")}</option>
            <option value="unpaid">{t("Неоплачені")}</option>
            <option value="paid">{t("Оплачені")}</option>
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Категорія")}</div>
          <Select value={cat} onChange={e => setCat(e.target.value)} className="w-36">
            <option value="">{t("Всі")}</option>
            {meta.data?.categories.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("пошук…")} className="w-40 pl-8" />
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />{t("Фактура")}</Button>
        <Button variant="secondary" loading={syncing} onClick={async () => {
          setSyncing(true);
          try { await post("/invoices/sync"); invalidate(); } finally { setSyncing(false); }
        }}><RefreshCw className="mr-1 h-4 w-4" />{t("Синхронізувати")}</Button>
      </div>

      {data.isFetching && !d ? <Spinner /> : d && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="grid grid-cols-1 gap-4">
            <Card className="p-5">
              <div className="flex items-center justify-between"><div className="text-sm font-medium text-slate-500">{t("Фактур за період")}</div><FileText className="h-5 w-5 text-slate-400" /></div>
              <div className="mt-2 text-2xl font-bold text-slate-800">{zl(d.totals.total)}</div>
              <div className="mt-1 text-xs text-slate-400">{d.totals.count} {t("шт.")}</div>
            </Card>
            <Card className="p-5">
              <div className="flex items-center justify-between"><div className="text-sm font-medium text-slate-500">{t("З них неоплачено")}</div><AlertTriangle className="h-5 w-5 text-amber-500" /></div>
              <div className={`mt-2 text-2xl font-bold ${d.totals.unpaid > 0 ? "text-amber-600" : "text-emerald-700"}`}>{zl(d.totals.unpaid)}</div>
              <div className="mt-1 text-xs text-slate-400">{d.totals.unpaidCount} {t("шт.")}</div>
            </Card>
          </div>
          {/* category summary — click to filter */}
          <Card className="p-0 lg:col-span-2">
            <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">{t("По категоріях")}</div>
            <div className="max-h-[260px] overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {d.categories.map(c => {
                    const active = cat === c.category;
                    const max = Math.max(1, ...d.categories.map(x => x.total));
                    return (
                      <tr key={c.category} className={`cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 ${active ? "bg-red-50" : ""}`}
                        onClick={() => setCat(active ? "" : c.category)}>
                        <td className={`px-4 py-1.5 ${active ? "font-semibold text-red-700" : "font-medium text-slate-700"}`}>{c.category}</td>
                        <td className="w-1/3 px-2 py-1.5">
                          <div className="h-2 rounded bg-slate-100"><div className="h-2 rounded bg-slate-400" style={{ width: `${Math.max(2, (c.total / max) * 100)}%` }} /></div>
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-slate-700">{zl(c.total)} <span className="text-xs text-slate-400">({c.n})</span></td>
                        <td className="whitespace-nowrap px-4 py-1.5 text-right text-xs tabular-nums">
                          {c.unpaid > 0 ? <span className="font-medium text-amber-600">{t("не опл.")} {zl(c.unpaid)}</span> : <span className="text-emerald-600">✓</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      <Card className="mt-4 p-0">
        {data.isFetching && !d ? <div className="p-5"><Spinner /></div> : !(d?.rows.length) ? <div className="p-5"><Empty>{t("Немає фактур")}</Empty></div> : (
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <th className="px-3 py-2 text-left">{t("Оплачена")}</th>
                <th className="px-3 py-2 text-left">{t("Дата")}</th>
                {!companyId && <th className="px-3 py-2 text-left">{t("Фірма")}</th>}
                <th className="px-3 py-2 text-left">{t("№ фактури")}</th>
                <th className="px-3 py-2 text-left">{t("Виставник")}</th>
                <th className="px-3 py-2 text-left">{t("Категорія")}</th>
                <th className="px-3 py-2 text-right">{t("Сума")}</th>
                <th className="px-3 py-2 text-left">{t("Термін")}</th>
                <th className="px-3 py-2 text-left">{t("Спосіб")}</th>
                <th className="px-3 py-2 text-left">{t("Дата оплати")}</th>
                <th className="px-2 py-2"></th>
              </tr></thead>
              <tbody>
                {d!.rows.map(r => {
                  const overdue = r.effUnpaid && r.dueDate && r.dueDate < today;
                  return (
                    <tr key={r.id} className={`border-b border-slate-100 ${r.effUnpaid ? "bg-amber-50" : ""}`}>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input type="checkbox" checked={!r.effUnpaid} disabled={busyId === r.id}
                            onChange={() => togglePaid(r)} className="h-4 w-4 cursor-pointer rounded border-slate-300 text-emerald-600" />
                          {r.effUnpaid
                            ? <span className="text-[11px] font-semibold text-amber-700">{t("ні")}</span>
                            : <span className="text-xs text-emerald-600">{t("так")}</span>}
                          {r.manualStatus && <span className="rounded bg-sky-100 px-1 text-[10px] font-medium text-sky-700" title={t("статус змінено в панелі")}>✎</span>}
                        </label>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{r.issueDate ?? r.periodMonth}</td>
                      {!companyId && <td className="px-3 py-1.5 text-slate-600">{coName(r.companyId)}</td>}
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-600">
                        {r.number}
                        {r.docType && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px]">{r.docType}</span>}
                        {r.editable && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px]">{t("панель")}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-slate-700"><div className="max-w-[220px] truncate">{r.counterparty || "—"}</div></td>
                      <td className="px-3 py-1.5 text-slate-500">
                        {r.effCategory}
                        {r.manualCategory && <span className="ml-1 rounded bg-sky-100 px-1 text-[10px] font-medium text-sky-700">✎</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums text-slate-800">{zl(r.amount)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                        {r.dueDate ?? "—"}
                        {overdue && <span className="ml-1.5 text-[11px] font-medium text-amber-600">{t("прострочено")}</span>}
                      </td>
                      {/* спосіб оплати — як записано в реєстрі */}
                      <td className="whitespace-nowrap px-3 py-1.5">
                        {r.cashPaid
                          ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">{t("Готівка")}</span>
                          : /przelew/i.test(r.statusRaw ?? "") || (!r.effUnpaid && !r.cashPaid)
                            ? <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-700">Przelew</span>
                            : <span className="text-xs text-slate-300">—</span>}
                      </td>
                      {/* дата оплати — з реєстру/панелі */}
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                        {r.effUnpaid ? <span className="text-slate-300">—</span> : (r.effPaidDate ?? <span className="text-slate-300">{t("без дати")}</span>)}
                        {r.manualPaidDate && <span className="ml-1 rounded bg-sky-100 px-1 text-[10px] font-medium text-sky-700">✎</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">
                        <button className="p-1 text-slate-300 hover:text-slate-600" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></button>
                        {r.editable && (
                          <button className="p-1 text-slate-300 hover:text-rose-500" onClick={async () => { if (confirm(t("Видалити фактуру?"))) { await del(`/invoices/${r.id}`); invalidate(); } }}><Trash2 className="h-4 w-4" /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(adding || editing) && (
        <InvModal
          companies={meta.data?.companies ?? []}
          categories={meta.data?.categories ?? []}
          inv={editing}
          defaultCompany={companyId}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); invalidate(); }}
        />
      )}
    </>
  );
}

function InvModal({ companies, categories, inv, defaultCompany, onClose, onSaved }: {
  companies: { id: number; name: string }[]; categories: string[]; inv: Inv | null; defaultCompany: string;
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const sheetRow = !!inv && !inv.editable;
  const [companyId, setCompanyId] = useState(inv ? String(inv.companyId ?? "") : (defaultCompany || String(companies[0]?.id ?? "")));
  const [issueDate, setIssueDate] = useState(inv?.issueDate ?? new Date().toISOString().slice(0, 10));
  const [number, setNumber] = useState(inv?.number ?? "");
  const [amount, setAmount] = useState(inv ? String(inv.amount) : "");
  const [counterparty, setCounterparty] = useState(inv?.counterparty ?? "");
  const [category, setCategory] = useState(inv ? inv.effCategory : "Inne");
  const [dueDate, setDueDate] = useState(inv?.dueDate ?? "");
  const [paid, setPaid] = useState(inv ? !inv.effUnpaid : false);
  const [paidDate, setPaidDate] = useState(inv?.effPaidDate ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (inv) {
        const body: any = { paid, paidDate: paid ? (paidDate || undefined) : undefined, category };
        if (!sheetRow) Object.assign(body, { companyId: Number(companyId), issueDate, number, amount, counterparty, dueDate: dueDate || null });
        await patch(`/invoices/${inv.id}`, body);
      } else {
        await post("/invoices", { companyId: Number(companyId), issueDate, number, amount, counterparty, category, dueDate: dueDate || null, paid, paidDate: paid ? (paidDate || undefined) : undefined });
      }
      onSaved();
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={inv ? (sheetRow ? t("Фактура з таблиці — статус і категорія") : t("Редагувати фактуру")) : t("Нова фактура")} onClose={onClose}>
      <div className="space-y-3">
        {sheetRow && (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {inv!.number} · {inv!.counterparty} · {zl(inv!.amount)} — {t("вміст редагується в Google-таблиці; тут можна змінити статус оплати і категорію")}
          </div>
        )}
        {!sheetRow && (
          <>
            <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Фірма")}</div>
              <Select value={companyId} onChange={e => setCompanyId(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Дата виставлення")}</div>
                <Input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} /></label>
              <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("№ фактури")}</div>
                <Input value={number} onChange={e => setNumber(e.target.value)} /></label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Сума (брутто)")}</div>
                <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></label>
              <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Термін оплати")}</div>
                <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></label>
            </div>
            <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Виставник")}</div>
              <Input value={counterparty} onChange={e => setCounterparty(e.target.value)} /></label>
          </>
        )}
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Категорія")}</div>
          <Input list="inv-cats" value={category} onChange={e => setCategory(e.target.value)} />
          <datalist id="inv-cats">{categories.map(c => <option key={c} value={c} />)}</datalist></label>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={paid} onChange={e => setPaid(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            {t("Оплачена")}
          </label>
          {paid && (
            <label className="flex items-center gap-2 text-sm text-slate-500">
              {t("дата оплати")}
              <Input type="date" value={paidDate} onChange={e => setPaidDate(e.target.value)} className="w-40" />
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={busy} disabled={!sheetRow && (!amount || !number)} onClick={save}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

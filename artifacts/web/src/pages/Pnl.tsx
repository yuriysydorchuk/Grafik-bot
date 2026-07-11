import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, TrendingUp, TrendingDown, BarChart3, Percent } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

interface ClientRow { label: string; revenue: number; revenueGross: number; cogs: number; margin: number; marginPct: number | null; revenueIds: number[]; cogsIds: number[] }
interface FixedRow { id: number; label: string; amount: number; source: string; note: string | null }
interface Data {
  month: string;
  segment: string;
  clients: ClientRow[];
  fixed: FixedRow[];
  totals: { revenue: number; revenueGross: number; cogs: number; margin: number; marginPct: number | null; fixed: number; net: number };
  imported: boolean;
}

const zl = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const MONTHS_UK = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthLabel = (m: string) => { const [y, mm] = m.split("-"); return `${MONTHS_UK[Number(mm) - 1]} ${y}`; };

export default function Pnl() {
  const t = useT();
  const qc = useQueryClient();
  const months = useQuery<{ months: string[] }>({ queryKey: ["pnl-months"], queryFn: () => get("/pnl/months") });
  const [month, setMonth] = useState<string>("");
  const [segment, setSegment] = useState<"main" | "cleaning">("main");
  const active = month || months.data?.months[0] || "";
  const q = useQuery<Data>({ queryKey: ["pnl", active, segment], queryFn: () => get(`/pnl?month=${active}&segment=${segment}`), enabled: !!active });
  const [adding, setAdding] = useState<null | "revenue" | "cogs" | "fixed">(null);
  const [editing, setEditing] = useState<{ id: number; label: string; amount: number; note: string | null } | null>(null);
  const d = q.data;
  const invalidate = () => ["pnl", "pnl-months"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));

  return (
    <>
      <PageHeader title="P&L" subtitle={t("Прибутки і збитки за місяць (за нарахуванням): доходи й собівартість по клієнтах + постійні витрати")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Місяць")}</div>
          <Select value={active} onChange={e => setMonth(e.target.value)} className="w-44">
            {(months.data?.months ?? []).map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </Select>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium">
          {([["main", t("Основний бізнес")], ["cleaning", t("Прибирання")]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setSegment(k)}
              className={`rounded-md px-4 py-1.5 ${segment === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
        {d?.imported && (
          <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-500">{t("дані з таблиці фінзвіту (доходи з VAT)")}</div>
        )}
      </div>

      {q.isFetching && !d ? <Spinner /> : !d ? <Empty>{t("Немає даних — вибери місяць або додай записи")}</Empty> : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Metric label={t("Доходи")} value={d.totals.revenue} tone="text-slate-800" icon={<BarChart3 className="h-5 w-5 text-slate-400" />} />
            <Metric label={t("Собівартість")} value={d.totals.cogs} tone="text-slate-800" icon={<BarChart3 className="h-5 w-5 text-slate-400" />} />
            <Metric label={t("Маржинальний прибуток")} value={d.totals.margin} tone="text-slate-800" icon={<Percent className="h-5 w-5 text-slate-400" />} sub={d.totals.marginPct != null ? `${d.totals.marginPct}%` : undefined} />
            <Metric label={t("Постійні витрати")} value={d.totals.fixed} tone="text-rose-600" icon={<TrendingDown className="h-5 w-5 text-rose-400" />} />
            <Metric label={t("Чистий прибуток")} value={d.totals.net} tone={d.totals.net >= 0 ? "text-emerald-700" : "text-rose-600"}
              icon={d.totals.net >= 0 ? <TrendingUp className="h-5 w-5 text-emerald-500" /> : <TrendingDown className="h-5 w-5 text-rose-500" />} />
          </div>

          {/* clients */}
          <Card className="mt-5 p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="font-semibold text-slate-700">{t("По клієнтах")}</div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setAdding("revenue")}><Plus className="mr-1 h-4 w-4" />{t("Дохід")}</Button>
                <Button variant="ghost" onClick={() => setAdding("cogs")}><Plus className="mr-1 h-4 w-4" />{t("Собівартість")}</Button>
              </div>
            </div>
            {!d.clients.length ? <div className="p-4"><Empty>{t("Немає записів")}</Empty></div> : (
              <div className="max-h-[480px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                    <th className="px-4 py-2 text-left">{t("Клієнт")}</th>
                    <th className="px-3 py-2 text-right">{t("Дохід нетто")}</th>
                    <th className="px-3 py-2 text-right">{t("Дохід брутто (з VAT)")}</th>
                    <th className="px-3 py-2 text-right">{t("Собівартість (ЗП + податки)")}</th>
                    <th className="px-3 py-2 text-right">{t("Маржа")}</th>
                    <th className="px-4 py-2 text-right">%</th>
                  </tr></thead>
                  <tbody>
                    {d.clients.map(c => (
                      <tr key={c.label} className="border-b border-slate-100">
                        <td className="px-4 py-1.5 font-medium text-slate-700">{c.label}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{c.revenue ? zl(c.revenue) : "—"}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{c.revenueGross ? zl(c.revenueGross) : "—"}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{c.cogs ? zl(c.cogs) : "—"}</td>
                        <td className={`whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums ${c.margin >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{zl(c.margin)}</td>
                        <td className={`whitespace-nowrap px-4 py-1.5 text-right tabular-nums ${c.marginPct != null && c.marginPct < 0 ? "text-rose-600" : "text-slate-500"}`}>{c.marginPct != null ? `${c.marginPct}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
                    <td className="px-4 py-2">{t("Разом")}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.revenue)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.revenueGross)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.cogs)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.margin)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{d.totals.marginPct != null ? `${d.totals.marginPct}%` : "—"}</td>
                  </tr></tfoot>
                </table>
              </div>
            )}
          </Card>

          {/* fixed costs */}
          <Card className="mt-4 p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="font-semibold text-slate-700">{t("Постійні витрати")}</div>
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-rose-600">{zl(d.totals.fixed)}</div>
                <Button variant="ghost" onClick={() => setAdding("fixed")}><Plus className="mr-1 h-4 w-4" />{t("Запис")}</Button>
              </div>
            </div>
            {!d.fixed.length ? <div className="p-4"><Empty>{t("Немає записів — додай VAT/ZUS/зарплату офісу кнопкою вище")}</Empty></div> : (
              <table className="w-full text-sm">
                <tbody>
                  {d.fixed.map(f => (
                    <tr key={f.id} className="group border-b border-slate-100 last:border-0">
                      <td className="px-4 py-1.5 text-slate-700">
                        {f.label}
                        {f.source !== "manual" && <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] text-slate-500">{f.source === "import" ? t("з таблиці") : f.source}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(f.amount)}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right">
                        <span className="invisible group-hover:visible">
                          <button className="p-1 text-slate-300 hover:text-slate-600" onClick={() => setEditing(f)}><Pencil className="h-4 w-4" /></button>
                          <button className="p-1 text-slate-300 hover:text-rose-500" onClick={async () => { if (confirm(t("Видалити запис?"))) { await del(`/pnl/entries/${f.id}`); invalidate(); } }}><Trash2 className="h-4 w-4" /></button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <div className="mt-3 text-xs text-slate-400">
            {t("Доходи й собівартість — за місяць надання послуг (фактура/зарплата за нього платяться наступного місяця). VAT/ZUS вноси в постійні за той місяць, ЗА який вони сплачені.")}
          </div>
        </>
      )}

      {(adding || editing) && (
        <EntryModal
          segment={segment}
          month={active}
          section={adding ?? "fixed"}
          entry={editing}
          onClose={() => { setAdding(null); setEditing(null); }}
          onSaved={() => { setAdding(null); setEditing(null); invalidate(); }}
        />
      )}
    </>
  );
}

function Metric({ label, value, tone, icon, sub }: { label: string; value: number; tone: string; icon: React.ReactNode; sub?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between"><div className="text-sm font-medium text-slate-500">{label}</div>{icon}</div>
      <div className={`mt-2 text-2xl font-bold ${tone}`}>{zl(value)}</div>
      {sub && <div className="mt-1 text-xs text-slate-400">{sub}</div>}
    </Card>
  );
}

function EntryModal({ month, section, segment, entry, onClose, onSaved }: {
  month: string; section: "revenue" | "cogs" | "fixed"; segment: string;
  entry: { id: number; label: string; amount: number; note: string | null } | null;
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [label, setLabel] = useState(entry?.label ?? "");
  const [amount, setAmount] = useState(entry ? String(entry.amount) : "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [busy, setBusy] = useState(false);
  const titles = { revenue: t("Дохід по клієнту"), cogs: t("Собівартість по клієнту"), fixed: t("Постійна витрата") };
  const save = async () => {
    setBusy(true);
    try {
      if (entry) await patch(`/pnl/entries/${entry.id}`, { label, amount, note });
      else await post("/pnl/entries", { periodMonth: month, section, label, amount, note, segment });
      onSaved();
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={`${entry ? t("Редагувати") : titles[section]} — ${month}`} onClose={onClose}>
      <div className="space-y-3">
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{section === "fixed" ? t("Назва (напр. VAT ES, ZUS ESO, Зарплата офісу)") : t("Клієнт")}</div>
          <Input value={label} onChange={e => setLabel(e.target.value)} /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Сума")}</div>
          <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Нотатка")}</div>
          <Input value={note} onChange={e => setNote(e.target.value)} /></label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={busy} disabled={!label || !amount} onClick={save}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

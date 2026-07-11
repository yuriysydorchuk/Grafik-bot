import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Wallet, ArrowDownLeft, ArrowUpRight, Scale, Plus, Pencil, Trash2, Check } from "lucide-react";
import { Link } from "wouter";
import { get, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { ObligationModal, type Obligation } from "../components/ObligationModal";

interface Meta { companies: { id: number; name: string }[] }
interface Data {
  year: string; month: string | null; asOf: string;
  money: {
    total: number;
    banks: { total: number; perFirm: { companyId: number; name: string; amount: number }[] };
    cash: { total: number; perBox: { box: string; closing: number }[] };
  };
  receivables: { total: number; rows: Obligation[] };
  payables: { total: number; unpaidInvoices: { total: number; count: number }; rows: Obligation[] };
  netPosition: number;
}

const zl = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const MONTHS_UK = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const BOX_LABELS: Record<string, string> = { office: "Каса офісу", yuriy: "Сейф Юрія", tetiana: "Сейф Тетяни" };

export default function Balance() {
  const t = useT();
  const qc = useQueryClient();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [monthNum, setMonthNum] = useState(String(now.getMonth() + 1).padStart(2, "0"));
  const [adding, setAdding] = useState<"receivable" | "payable" | null>(null);
  const [editing, setEditing] = useState<Obligation | null>(null);

  const params = new URLSearchParams({ year });
  if (monthNum) params.set("month", monthNum);
  const meta = useQuery<Meta>({ queryKey: ["bank-meta"], queryFn: () => get("/bank/meta") });
  const q = useQuery<Data>({ queryKey: ["balance", params.toString()], queryFn: () => get(`/balance?${params}`) });
  const d = q.data;
  const invalidate = () => ["balance", "obligations", "cashflow"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));

  const ObRows = ({ rows, tone }: { rows: Obligation[]; tone: string }) => (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(r => (
          <tr key={r.id} className="group border-b border-slate-100 last:border-0">
            <td className="px-4 py-2">
              <div className="font-medium text-slate-700">{r.counterparty}</div>
              {(r.description || r.dueDate) && (
                <div className="max-w-[340px] truncate text-xs text-slate-400">
                  {r.description}{r.dueDate && <span className="ml-1">{t("до")} {r.dueDate}</span>}
                </div>
              )}
            </td>
            <td className={`whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums ${tone}`}>{zl(r.amount)}</td>
            <td className="whitespace-nowrap py-2 pr-3 text-right">
              <span className="invisible group-hover:visible">
                {r.status === "open" && (
                  <button className="p-1 text-slate-300 hover:text-emerald-600" title={t("Закрити (оплачено/отримано)")}
                    onClick={async () => { await patch(`/obligations/${r.id}`, { status: "settled" }); invalidate(); }}><Check className="h-4 w-4" /></button>
                )}
                <button className="p-1 text-slate-300 hover:text-slate-600" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></button>
                <button className="p-1 text-slate-300 hover:text-rose-500" onClick={async () => { if (confirm(t("Видалити запис?"))) { await del(`/obligations/${r.id}`); invalidate(); } }}><Trash2 className="h-4 w-4" /></button>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <PageHeader title={t("Баланс")} subtitle={t("Знімок фінансового стану на кінець вибраного місяця")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Рік")}</div>
          <Select value={year} onChange={e => setYear(e.target.value)} className="w-24">
            {[String(now.getFullYear()), String(now.getFullYear() - 1)].map(y => <option key={y} value={y}>{y}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Місяць")}</div>
          <Select value={monthNum} onChange={e => setMonthNum(e.target.value)} className="w-36">
            <option value="">{t("Кінець року")}</option>
            {MONTHS_UK.map((m, i) => <option key={i} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
          </Select>
        </div>
        {d && <div className="pb-2 text-sm text-slate-400">{t("станом на {d}", { d: d.asOf })}</div>}
        <Link href="/obligations" className="ml-auto pb-2 text-sm text-slate-400 underline decoration-slate-300 underline-offset-2 hover:text-slate-600">{t("усі записи й історія →")}</Link>
      </div>

      {q.isFetching && !d ? <Spinner /> : !d ? <Empty>{t("Немає даних")}</Empty> : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Metric icon={<Wallet className="h-5 w-5 text-slate-400" />} label={t("Гроші")} value={d.money.total} />
            <Metric icon={<ArrowDownLeft className="h-5 w-5 text-emerald-500" />} label={t("Нам винні")} value={d.receivables.total} tone="text-emerald-700" />
            <Metric icon={<ArrowUpRight className="h-5 w-5 text-rose-500" />} label={t("Ми винні")} value={d.payables.total} tone="text-rose-600" />
            <Metric icon={<Scale className="h-5 w-5 text-slate-400" />} label={t("Чиста позиція")} value={d.netPosition} tone={d.netPosition >= 0 ? "text-emerald-700" : "text-rose-600"} />
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* money composition */}
            <Card className="p-0">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div className="font-semibold text-slate-700">{t("Гроші")}</div>
                <div className="text-sm font-semibold text-slate-700">{zl(d.money.total)}</div>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {d.money.banks.perFirm.map(f => (
                    <tr key={f.companyId} className="border-b border-slate-100">
                      <td className="px-4 py-2 text-slate-600">{t("Банк")} · {f.name}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums">{zl(f.amount)}</td>
                    </tr>
                  ))}
                  {d.money.cash.perBox.map(b => (
                    <tr key={b.box} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-2 text-slate-600">{t("Готівка")} · {t(BOX_LABELS[b.box] ?? b.box)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums">{zl(b.closing)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            {/* receivables */}
            <Card className="p-0">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div className="font-semibold text-slate-700">{t("Нам винні")}</div>
                <div className="flex items-center gap-2">
                  <div className="text-sm font-semibold text-emerald-700">{zl(d.receivables.total)}</div>
                  <button className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title={t("Дописати")}
                    onClick={() => setAdding("receivable")}><Plus className="h-4 w-4" /></button>
                </div>
              </div>
              {!d.receivables.rows.length ? <div className="p-4"><Empty>{t("Немає відкритих — натисни + щоб дописати")}</Empty></div>
                : <ObRows rows={d.receivables.rows} tone="text-emerald-700" />}
            </Card>
          </div>

          {/* payables */}
          <Card className="mt-4 p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="font-semibold text-slate-700">{t("Ми винні")}</div>
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-rose-600">{zl(d.payables.total)}</div>
                <button className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title={t("Дописати")}
                  onClick={() => setAdding("payable")}><Plus className="h-4 w-4" /></button>
              </div>
            </div>
            {d.payables.unpaidInvoices.total > 0 && (
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
                <div>
                  <Link href="/invoices" className="text-sm font-medium text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-red-700">
                    {t("Неоплачені фактури ({n} шт.)", { n: d.payables.unpaidInvoices.count })}
                  </Link>
                  <div className="text-xs text-slate-400">{t("автоматично з реєстрів фактур")}</div>
                </div>
                <div className="whitespace-nowrap text-sm font-medium tabular-nums text-rose-600">{zl(d.payables.unpaidInvoices.total)}</div>
              </div>
            )}
            {!d.payables.rows.length && !d.payables.unpaidInvoices.total
              ? <div className="p-4"><Empty>{t("Немає відкритих боргів")}</Empty></div>
              : <ObRows rows={d.payables.rows} tone="text-rose-600" />}
          </Card>

          <div className="mt-3 text-xs text-slate-400">
            {t("Чиста позиція = гроші (банки + готівка) + нам винні − ми винні. Кредити та нерухомість не враховуються. Новий запис отримує дату виникнення = кінець вибраного місяця.")}
          </div>
        </>
      )}

      {(adding || editing) && (
        <ObligationModal
          companies={meta.data?.companies ?? []}
          ob={editing}
          defaults={{ direction: adding ?? undefined, arisenDate: d?.asOf }}
          onClose={() => { setAdding(null); setEditing(null); }}
          onSaved={() => { setAdding(null); setEditing(null); invalidate(); }}
        />
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

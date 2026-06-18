import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Wallet, TrendingUp, TrendingDown, Factory as FactoryIcon, FileText, Users as UsersIcon, Clock,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { get } from "../lib/api";
import { monthOptions } from "../lib/dates";
import { Card, Spinner, Select, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT, useLang } from "../lib/i18n";
import { useMemo } from "react";

interface FacFin {
  factoryId: number; name: string; invoiceRate: number | null; hasRate: boolean; hours: number; workers: number;
  invoiceNet: number; invoiceVat: number; invoiceGross: number; laborCost: number; profit: number; margin: number | null;
}
interface Totals { hours: number; invoiceNet: number; invoiceVat: number; invoiceGross: number; laborCost: number; profit: number; people: number }
interface FinResp { month: string; factories: FacFin[]; totals: Totals; prev: { month: string; totals: Totals } }

const zl = (n: number) => `${n.toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const zlShort = (n: number) => `${Math.round(n).toLocaleString("uk-UA")} zł`;

function Delta({ cur, prev }: { cur: number; prev: number }) {
  const t = useT();
  const d = cur - prev;
  if (Math.abs(d) < 0.005) return <span className="text-xs text-slate-400">{t("= минулий період")}</span>;
  const up = d > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? "text-emerald-600" : "text-rose-600"}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? "+" : ""}{zl(d)} <span className="text-slate-400">{t("vs мин. міс.")}</span>
    </span>
  );
}

export default function Finance() {
  const t = useT();
  const { lang } = useLang();
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const [month, setMonth] = useState(months[0]!.value);
  const { data, isFetching } = useQuery<FinResp>({ queryKey: ["finance", month], queryFn: () => get(`/finance?month=${month}`) });

  return (
    <>
      <PageHeader title={t("Фінанси")} subtitle={t("Жива фактура, вартість праці та прибуток по фабриках (із відмічених явок)")} />
      <div className="mb-4"><Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">{months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></div>

      {isFetching && !data ? <Spinner /> : !data ? <Empty>{t("Немає даних")}</Empty> : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card className="p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-500"><FileText className="h-4 w-4 text-sky-500" /> {t("Фактура (нетто)")}</div>
              <div className="mt-1 text-2xl font-bold text-slate-800">{zl(data.totals.invoiceNet)}</div>
              <div className="mt-0.5 text-xs text-slate-400">{t("з ВАТ:")} {zl(data.totals.invoiceGross)}</div>
              <div className="mt-2"><Delta cur={data.totals.invoiceNet} prev={data.prev.totals.invoiceNet} /></div>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-500"><Wallet className="h-4 w-4 text-amber-500" /> {t("Вартість праці")}</div>
              <div className="mt-1 text-2xl font-bold text-slate-800">{zl(data.totals.laborCost)}</div>
              <div className="mt-0.5 text-xs text-slate-400">{t("брутто ЗП + ZUS роботодавця")}</div>
              <div className="mt-2"><Delta cur={data.totals.laborCost} prev={data.prev.totals.laborCost} /></div>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-500"><TrendingUp className="h-4 w-4 text-emerald-500" /> {t("Прибуток")}</div>
              <div className={`mt-1 text-2xl font-bold ${data.totals.profit >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{zl(data.totals.profit)}</div>
              <div className="mt-0.5 text-xs text-slate-400">{data.totals.invoiceNet > 0 ? t("маржа {n}%", { n: Math.round((data.totals.profit / data.totals.invoiceNet) * 100) }) : "—"}</div>
              <div className="mt-2"><Delta cur={data.totals.profit} prev={data.prev.totals.profit} /></div>
            </Card>
          </div>

          {!data.factories.length ? <Empty>{t("За цей місяць немає відмічених явок")}</Empty> : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-2.5">{t("Фабрика")}</th>
                    <th className="px-3 py-2.5 text-right">{t("Год")}</th>
                    <th className="px-3 py-2.5 text-right">{t("Люди")}</th>
                    <th className="px-3 py-2.5 text-right">{t("Ставка")}</th>
                    <th className="px-3 py-2.5 text-right">{t("Фактура нетто")}</th>
                    <th className="px-3 py-2.5 text-right">{t("ВАТ")}</th>
                    <th className="px-3 py-2.5 text-right">{t("Вартість праці")}</th>
                    <th className="px-3 py-2.5 text-right">{t("Прибуток")}</th>
                    <th className="px-3 py-2.5 text-right">{t("Маржа")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.factories.map(f => (
                    <tr key={f.factoryId} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-700">
                        <span className="flex items-center gap-2"><FactoryIcon className="h-3.5 w-3.5 text-slate-400" />{f.name}</span>
                        {!f.hasRate && <span className="ml-5 text-xs text-amber-500">⚠️ {t("ставку не задано")}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{f.hours}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{f.workers}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400">{f.invoiceRate != null ? `${f.invoiceRate}` : "—"}</td>
                      <td className="px-3 py-2.5 text-right text-slate-700">{zl(f.invoiceNet)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400">{zl(f.invoiceVat)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{zl(f.laborCost)}</td>
                      <td className={`px-3 py-2.5 text-right font-semibold ${f.profit >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{zl(f.profit)}</td>
                      <td className="px-3 py-2.5 text-right">{f.margin != null ? <Badge color={f.margin >= 20 ? "green" : f.margin >= 0 ? "amber" : "rose"}>{f.margin}%</Badge> : <span className="text-slate-300">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-semibold text-slate-700">
                    <td className="px-4 py-2.5">{t("Разом")}</td>
                    <td className="px-3 py-2.5 text-right">{data.totals.hours}</td>
                    <td className="px-3 py-2.5 text-right">{data.totals.people}</td>
                    <td />
                    <td className="px-3 py-2.5 text-right">{zl(data.totals.invoiceNet)}</td>
                    <td className="px-3 py-2.5 text-right text-slate-500">{zl(data.totals.invoiceVat)}</td>
                    <td className="px-3 py-2.5 text-right">{zl(data.totals.laborCost)}</td>
                    <td className={`px-3 py-2.5 text-right ${data.totals.profit >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{zl(data.totals.profit)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </Card>
          )}
          <p className="mt-3 text-xs text-slate-400">
            💡 {t("Прибуток = фактура нетто − повна вартість праці (брутто ЗП + ZUS роботодавця). Ставки ZUS/ВАТ — кнопка зверху.")}
          </p>

          <ComparisonSection />
        </>
      )}
    </>
  );
}

// ─── Comparison charts ────────────────────────────────────────────────────────────
type Metrics = { turnover: number; profit: number; hours: number; people: number };
interface CompareResp {
  mode: string;
  current: { label: string }; compare: { label: string };
  company: { current: Metrics; compare: Metrics };
  factories: { factoryId: number; name: string; current: Metrics; compare: Metrics }[];
}
const MODES = [
  { value: "mtd", label: "День-у-день (vs минулий міс.)" },
  { value: "mom", label: "Місяць до минулого" },
  { value: "yoy_month", label: "Місяць vs торік" },
  { value: "yoy", label: "Рік до року" },
];
const METRICS: { key: keyof Metrics; title: string; icon: any; money: boolean; color: string }[] = [
  { key: "turnover", title: "Оборот (фактура нетто)", icon: FileText, money: true, color: "#0ea5e9" },
  { key: "profit", title: "Прибуток", icon: TrendingUp, money: true, color: "#10b981" },
  { key: "hours", title: "Години", icon: Clock, money: false, color: "#f59e0b" },
  { key: "people", title: "Людей", icon: UsersIcon, money: false, color: "#ef4444" },
];

function pct(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? "0%" : "—";
  return `${cur >= prev ? "+" : ""}${Math.round(((cur - prev) / prev) * 100)}%`;
}

function ComparisonSection() {
  const t = useT();
  const [mode, setMode] = useState("mtd");
  const { data, isFetching } = useQuery<CompareResp>({ queryKey: ["finance-compare", mode], queryFn: () => get(`/finance/compare?mode=${mode}`) });

  return (
    <div className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{t("Порівняння динаміки")}</h2>
        <div className="flex flex-wrap gap-1">
          {MODES.map(mo => (
            <button key={mo.value} onClick={() => setMode(mo.value)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${mode === mo.value ? "bg-red-600 text-white" : "bg-white text-slate-500 ring-1 ring-slate-200 hover:ring-red-300"}`}>
              {t(mo.label)}
            </button>
          ))}
        </div>
      </div>

      {isFetching && !data ? <Spinner /> : !data ? null : (
        <>
          <div className="mb-3 text-xs text-slate-400">
            <span className="font-medium text-slate-600">{data.current.label}</span> {t("проти")} <span className="font-medium text-slate-600">{data.compare.label}</span>
          </div>
          {/* company KPI deltas */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {METRICS.map(mt => {
              const c = data.company.current[mt.key], p = data.company.compare[mt.key];
              const up = c >= p;
              return (
                <Card key={mt.key} className="p-4">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><mt.icon className="h-3.5 w-3.5" />{t(mt.title)}</div>
                  <div className="mt-1 text-lg font-bold text-slate-800">{mt.money ? zlShort(c) : c}</div>
                  <div className="text-xs text-slate-400">{t("було:")} {mt.money ? zlShort(p) : p} · <span className={up ? "text-emerald-600" : "text-rose-600"}>{pct(c, p)}</span></div>
                </Card>
              );
            })}
          </div>

          {/* per-metric bar charts: company + factories */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {METRICS.map(mt => {
              const rows = [
                { name: t("Компанія"), Поточний: data.company.current[mt.key], Порівняння: data.company.compare[mt.key] },
                ...data.factories.map(f => ({ name: f.name, "Поточний": f.current[mt.key], "Порівняння": f.compare[mt.key] })),
              ];
              return (
                <Card key={mt.key} className="p-4">
                  <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700"><mt.icon className="h-4 w-4 text-slate-400" />{t(mt.title)}</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} width={48} tickFormatter={(v: number) => mt.money ? `${Math.round(v / 1000)}k` : String(v)} />
                      <Tooltip formatter={(v: any) => mt.money ? zl(Number(v)) : v} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="Поточний" name={t("Поточний")} fill={mt.color} radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Порівняння" name={t("Порівняння")} fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}


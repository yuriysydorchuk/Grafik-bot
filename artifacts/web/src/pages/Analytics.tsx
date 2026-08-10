// «Аналітика» (/analytics) — багатомісячні тренди бізнесу поверх P&L:
// динаміка дохід/собівартість/маржа по сегментах, маржа на годину,
// рентабельність клієнтів за період із дрил-дауном по місяцях.
// Місячний зріз і звірки — на /cfo. Owner-only (viewFinance).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { ChevronDown, ChevronRight, LineChart as LineChartIcon } from "lucide-react";
import { get } from "../lib/api";
import { Card, Spinner, Select, Empty } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { useChartTheme } from "../lib/theme";

type SegmentSum = { revenue: number; cogs: number; margin: number; marginPct: number | null };
interface SeriesPoint {
  month: string;
  main: SegmentSum; cleaning: SegmentSum; total: SegmentSum;
  fixed: number; profit: number;
  hours: number | null; marginPerHour: number | null; revenuePerHour: number | null;
}
interface Client {
  label: string; segment: string;
  total: SegmentSum;
  monthly: Record<string, { revenue: number; cogs: number; margin: number }>;
  activeMonths: string[]; lastMonth: string | null;
}
interface Data { months: string[]; series: SeriesPoint[]; clients: Client[] }

type Seg = "main" | "cleaning" | "total";

const zl = (n: number | null | undefined) =>
  n == null ? "—" : `${n.toLocaleString("uk-UA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} zł`;
const zlShort = (n: number) => (Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : Math.abs(n) >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

export default function Analytics() {
  const t = useT();
  const chart = useChartTheme();
  const [months, setMonths] = useState(12);
  const [segView, setSegView] = useState<Seg>("main");
  const [openClient, setOpenClient] = useState<string | null>(null);

  const q = useQuery<Data>({ queryKey: ["analytics", months], queryFn: () => get(`/analytics?months=${months}`) });
  const d = q.data;

  // останній місяць із доходом — «поточний» для KPI; попередній — база порівняння
  const kpi = useMemo(() => {
    if (!d?.series.length) return null;
    const withRevenue = d.series.filter(s => s.total.revenue > 0);
    if (!withRevenue.length) return null;
    const cur = withRevenue[withRevenue.length - 1]!;
    const prev = withRevenue.length > 1 ? withRevenue[withRevenue.length - 2]! : null;
    return { cur, prev };
  }, [d]);

  const chartData = useMemo(() => (d?.series ?? []).map(s => ({
    month: s.month.slice(2), // "26-06" компактніше на осі
    revenue: s[segView].revenue,
    cogs: s[segView].cogs,
    marginPct: s[segView].marginPct,
  })), [d, segView]);

  const hoursData = useMemo(() => (d?.series ?? []).filter(s => s.hours != null).map(s => ({
    month: s.month.slice(2),
    hours: s.hours,
    marginPerHour: s.marginPerHour,
    revenuePerHour: s.revenuePerHour,
  })), [d]);

  const segBtn = (v: Seg, label: string) => (
    <button key={v} onClick={() => setSegView(v)}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${segView === v ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
      {label}
    </button>
  );

  return (
    <>
      <PageHeader title={t("Аналітика")} subtitle={t("Тренди по місяцях: дохід, маржа, рентабельність клієнтів. Місячний зріз і звірки — на сторінці CFO.")} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1.5">
          {segBtn("main", t("Основний"))}
          {segBtn("cleaning", t("Клінінг"))}
          {segBtn("total", t("Разом"))}
        </div>
        {segView === "total" && <span className="text-xs text-amber-600">{t("Сегменти зведені разом — для оцінки масштабу, не для маржі")}</span>}
        <div className="ml-auto">
          <Select value={String(months)} onChange={e => setMonths(Number(e.target.value))} className="w-40">
            <option value="6">{t("6 місяців")}</option>
            <option value="12">{t("12 місяців")}</option>
            <option value="24">{t("24 місяці")}</option>
          </Select>
        </div>
      </div>

      {q.isFetching && !d ? <Spinner /> : !d || !d.series.length ? <Empty>{t("Немає даних")}</Empty> : (
        <>
          {/* ── KPI останнього місяця ── */}
          {kpi && (
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Kpi label={`${t("Дохід")} · ${kpi.cur.month}`} value={zl(kpi.cur[segView].revenue)}
                delta={kpi.prev ? kpi.cur[segView].revenue - kpi.prev[segView].revenue : null} money />
              <Kpi label={t("Маржа")} value={zl(kpi.cur[segView].margin)}
                delta={kpi.prev ? kpi.cur[segView].margin - kpi.prev[segView].margin : null} money />
              <Kpi label={t("Маржа %")} value={kpi.cur[segView].marginPct != null ? `${kpi.cur[segView].marginPct}%` : "—"}
                delta={kpi.prev && kpi.cur[segView].marginPct != null && kpi.prev[segView].marginPct != null
                  ? +(kpi.cur[segView].marginPct! - kpi.prev[segView].marginPct!).toFixed(1) : null} suffix={` ${t("п.п.")}`} />
              <Kpi label={t("Прибуток (− постійні)")} value={zl(kpi.cur.profit)}
                delta={kpi.prev ? kpi.cur.profit - kpi.prev.profit : null} money />
              <Kpi label={t("Маржа / год")} value={kpi.cur.marginPerHour != null ? zl(kpi.cur.marginPerHour) : "—"}
                delta={kpi.prev && kpi.cur.marginPerHour != null && kpi.prev.marginPerHour != null
                  ? +(kpi.cur.marginPerHour - kpi.prev.marginPerHour).toFixed(2) : null} money />
            </div>
          )}

          {/* ── Динаміка: дохід/собівартість + маржа % ── */}
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <LineChartIcon className="h-5 w-5 text-slate-400" />
              <span className="font-semibold text-slate-700">{t("Динаміка: дохід, собівартість, маржа %")}</span>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chart.grid} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: chart.tickMuted }} />
                <YAxis yAxisId="zl" tickFormatter={zlShort} tick={{ fontSize: 11, fill: chart.tickMuted }} width={44} />
                <YAxis yAxisId="pct" orientation="right" domain={[0, 60]} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11, fill: chart.tickMuted }} width={38} />
                <Tooltip contentStyle={chart.tooltip}
                  formatter={(v: any, name: any) => name === t("Маржа %") ? [`${v}%`, name] : [zl(Number(v)), name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="zl" dataKey="revenue" name={t("Дохід")} fill="#dc2626" radius={[3, 3, 0, 0]} />
                <Bar yAxisId="zl" dataKey="cogs" name={t("Собівартість (ЗП)")} fill="#94a3b8" radius={[3, 3, 0, 0]} />
                <Line yAxisId="pct" type="monotone" dataKey="marginPct" name={t("Маржа %")} stroke="#0f766e" strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
            {segView === "cleaning" && <p className="mt-2 text-xs text-slate-400">{t("Для клінінгу собівартість у P&L поки не ведеться окремо — маржа показана від доходу.")}</p>}
          </Card>

          {/* ── Години та ефективність ── */}
          {hoursData.length > 0 && segView !== "cleaning" && (
            <Card className="mt-4 p-5">
              <div className="mb-3 font-semibold text-slate-700">{t("Ефективність години (основний бізнес)")}</div>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={hoursData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chart.grid} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: chart.tickMuted }} />
                  <YAxis yAxisId="h" tickFormatter={zlShort} tick={{ fontSize: 11, fill: chart.tickMuted }} width={44} />
                  <YAxis yAxisId="rate" orientation="right" tick={{ fontSize: 11, fill: chart.tickMuted }} width={38} />
                  <Tooltip contentStyle={chart.tooltip}
                    formatter={(v: any, name: any) => name === t("Годин") ? [Number(v).toLocaleString("uk-UA"), name] : [zl(Number(v)), name]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar yAxisId="h" dataKey="hours" name={t("Годин")} fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="rate" type="monotone" dataKey="revenuePerHour" name={t("Дохід / год")} stroke="#dc2626" strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
                  <Line yAxisId="rate" type="monotone" dataKey="marginPerHour" name={t("Маржа / год")} stroke="#0f766e" strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
              <p className="mt-2 text-xs text-slate-400">{t("Години — з зведених ЗП (payroll); маржа/год = маржа основного сегмента ÷ години місяця.")}</p>
            </Card>
          )}

          {/* ── Клієнти за період ── */}
          <Card className="mt-4 overflow-x-auto p-0">
            <div className="border-b border-slate-200 px-5 py-3 font-semibold text-slate-700">
              {t("Клієнти за період ({n} міс.)", { n: d.months.length })}
            </div>
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                <th className="w-8 px-3 py-2.5" />
                <th className="px-2 py-2.5">{t("Клієнт")}</th>
                <th className="px-3 py-2.5 text-right">{t("Дохід")}</th>
                <th className="px-3 py-2.5 text-right">{t("Частка")}</th>
                <th className="px-3 py-2.5 text-right">{t("Маржа")}</th>
                <th className="px-3 py-2.5 text-right">{t("Маржа %")}</th>
                <th className="px-3 py-2.5 text-right">{t("Місяців")}</th>
                <th className="px-3 py-2.5 text-right">{t("Останній")}</th>
              </tr></thead>
              <tbody>
                {d.clients.filter(c => segView === "total" || c.segment === segView).map(c => {
                  const totalRev = d.clients.filter(x => segView === "total" || x.segment === segView).reduce((s, x) => s + x.total.revenue, 0);
                  const open = openClient === c.label;
                  return (
                    <ClientRows key={c.label} c={c} months={d.months} open={open}
                      share={totalRev > 0 ? Math.round((c.total.revenue / totalRev) * 100) : 0}
                      onToggle={() => setOpenClient(open ? null : c.label)} />
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}

function Kpi({ label, value, delta, money, suffix }: { label: string; value: string; delta: number | null; money?: boolean; suffix?: string }) {
  const t = useT();
  return (
    <Card className="p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-slate-800">{value}</div>
      {delta != null && (
        <div className={`mt-0.5 text-xs tabular-nums ${delta > 0 ? "text-emerald-700" : delta < 0 ? "text-rose-600" : "text-slate-400"}`}>
          {delta > 0 ? "+" : ""}{money ? zl(delta) : `${delta}${suffix ?? ""}`} {t("до попер. місяця")}
        </div>
      )}
    </Card>
  );
}

function ClientRows({ c, months, share, open, onToggle }: {
  c: Client; months: string[]; share: number; open: boolean; onToggle: () => void;
}) {
  const t = useT();
  return (
    <>
      <tr className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={onToggle}>
        <td className="px-3 py-2 text-slate-400">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
        <td className="max-w-[280px] truncate px-2 py-2 font-medium text-slate-700" title={c.label}>
          {c.label}
          {c.segment === "cleaning" && <span className="ml-1.5 rounded bg-sky-100 px-1 py-0.5 text-[10px] font-semibold text-sky-700">{t("клінінг")}</span>}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{zl(c.total.revenue)}</td>
        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{share}%</td>
        <td className={`whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums ${c.total.margin < 0 ? "text-rose-600" : ""}`}>{zl(c.total.margin)}</td>
        <td className={`whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums ${c.total.marginPct == null ? "text-slate-400" : c.total.marginPct < 10 ? "text-rose-600" : c.total.marginPct < 15 ? "text-amber-600" : "text-emerald-700"}`}>
          {c.total.marginPct ?? "—"}{c.total.marginPct != null && "%"}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{c.activeMonths.length}</td>
        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{c.lastMonth ?? "—"}</td>
      </tr>
      {open && (
        <tr className="border-b border-slate-100 bg-slate-50/60">
          <td colSpan={8} className="px-5 py-3">
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-4">
              {months.filter(m => c.monthly[m]).map(m => {
                const mm = c.monthly[m]!;
                const pctV = mm.revenue > 0 ? Math.round((mm.margin / mm.revenue) * 100) : null;
                return (
                  <div key={m} className="flex items-baseline justify-between gap-2">
                    <span className="text-slate-400">{m}</span>
                    <span className="tabular-nums text-slate-600">{zl(mm.revenue)} · <span className={mm.margin < 0 ? "text-rose-600" : "text-slate-700"}>{pctV != null ? `${pctV}%` : "—"}</span></span>
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

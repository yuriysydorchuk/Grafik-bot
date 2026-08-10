import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, TrendingUp, TrendingDown, BarChart3, Percent, ChevronDown, ChevronRight, Users, Fuel } from "lucide-react";
import { toast } from "sonner";
import { get, post, put, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

interface ClientRow { label: string; revenue: number; revenueGross: number; cogs: number; cogsSalary: number; cogsTax: number; margin: number; marginPct: number | null; revenueIds: number[]; cogsIds: number[] }
interface FixedRow { id: number; label: string; amount: number; source: string; note: string | null }
interface Data {
  month: string;
  segment: string;
  clients: ClientRow[];
  fixed: FixedRow[];
  totals: { revenue: number; revenueGross: number; cogs: number; cogsSalary: number; cogsTax: number; margin: number; marginPct: number | null; fixed: number; net: number };
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
  const [view, setView] = useState<"clients" | "cities">("clients");
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
          {([["clients", t("По клієнтах")], ["cities", t("По містах")]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setView(k)}
              className={`rounded-md px-4 py-1.5 ${view === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
        {view === "clients" && (
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium">
            {([["main", t("Основний бізнес")], ["cleaning", t("Прибирання")]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setSegment(k)}
                className={`rounded-md px-4 py-1.5 ${segment === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        {view === "clients" && d?.imported && (
          <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-500">{t("дані з таблиці фінзвіту (доходи з VAT)")}</div>
        )}
      </div>

      {view === "cities" ? (active ? <CitiesView month={active} /> : <Spinner />) :
      q.isFetching && !d ? <Spinner /> : !d ? <Empty>{t("Немає даних — вибери місяць або додай записи")}</Empty> : (
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
                    <th className="px-3 py-2 text-right">{t("ЗП")}</th>
                    <th className="px-3 py-2 text-right">{t("Податки (PIT/ZUS)")}</th>
                    <th className="px-3 py-2 text-right">{t("Маржа")}</th>
                    <th className="px-4 py-2 text-right">%</th>
                  </tr></thead>
                  <tbody>
                    {d.clients.map(c => (
                      <tr key={c.label} className="border-b border-slate-100">
                        <td className="px-4 py-1.5 font-medium text-slate-700">{c.label}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{c.revenue ? zl(c.revenue) : "—"}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{c.revenueGross ? zl(c.revenueGross) : "—"}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500" title={c.cogs ? `${t("Разом собівартість")}: ${zl(c.cogs)}` : undefined}>{c.cogsSalary ? zl(c.cogsSalary) : "—"}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{c.cogsTax ? zl(c.cogsTax) : "—"}</td>
                        <td className={`whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums ${c.margin >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{zl(c.margin)}</td>
                        <td className={`whitespace-nowrap px-4 py-1.5 text-right tabular-nums ${c.marginPct != null && c.marginPct < 0 ? "text-rose-600" : "text-slate-500"}`}>{c.marginPct != null ? `${c.marginPct}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
                    <td className="px-4 py-2">{t("Разом")}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.revenue)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.revenueGross)}</td>
                    <td className="px-3 py-2 text-right tabular-nums" title={`${t("Разом собівартість")}: ${zl(d.totals.cogs)}`}>{zl(d.totals.cogsSalary)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.cogsTax)}</td>
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

          <ActualsSection month={active} />
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

// ── Фактичні платежі (у M+1 за M): касовий зріз під P&L ─────────────────────
interface CatAgg { category: string; total: number; rows: { id: number; number: string | null; counterparty: string | null; amount: number }[] }
interface ManualItem { id: number; kind: string; firm: string; amount: number; note: string | null }
interface ActualsData {
  month: string;
  income: { net: number; gross: number; count: number };
  salary: { konto: number; cash: number; unsplit: number; total: number };
  advances: number;
  fuel: { net: number; gross: number; count: number };
  fuelRegistry: CatAgg;
  repairs: CatAgg; hostels: CatAgg;
  officeSalary: { konto: number; cash: number; unsplit: number; total: number };
  manual: { vat: ManualItem[]; zus: ManualItem[]; vatTotal: number; zusTotal: number; firms: string[] };
  others: CatAgg[]; othersTotal: number;
  totals: { expenses: number; balanceGross: number; balanceNet: number };
}

const nextMonthOf = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return mm === 12 ? `${y! + 1}-01` : `${y}-${String(mm! + 1).padStart(2, "0")}`;
};

function ActualsSection({ month }: { month: string }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery<ActualsData>({ queryKey: ["pnl-actuals", month], queryFn: () => get(`/pnl/actuals?month=${month}`) });
  const [openCat, setOpenCat] = useState<Record<string, boolean>>({});
  const d = q.data;
  if (!d) return q.isFetching ? <div className="mt-5"><Spinner /></div> : null;

  const row = (label: React.ReactNode, amount: number | null, opts?: { sub?: boolean; tone?: string; extra?: React.ReactNode; onClick?: () => void }) => (
    <tr className={`border-b border-slate-100 last:border-0 ${opts?.onClick ? "cursor-pointer hover:bg-slate-50/60" : ""}`} onClick={opts?.onClick}>
      <td className={`px-4 py-1.5 ${opts?.sub ? "pl-9 text-slate-500" : "text-slate-700"}`}>{label}{opts?.extra}</td>
      <td className={`whitespace-nowrap px-4 py-1.5 text-right tabular-nums ${opts?.tone ?? (opts?.sub ? "text-slate-500" : "text-slate-700")}`}>
        {amount != null ? zl(amount) : ""}
      </td>
    </tr>
  );
  const catRows = (agg: CatAgg, label: string) => [
    row(
      <><span className="mr-1.5 inline-block w-3 text-slate-400">{openCat[agg.category] ? "▾" : "▸"}</span>{label}
        <span className="ml-2 text-xs text-slate-400">{agg.rows.length} {t("факт.")}</span></>,
      agg.total,
      { onClick: () => setOpenCat(o => ({ ...o, [agg.category]: !o[agg.category] })) },
    ),
    ...(openCat[agg.category] ? agg.rows.map(r => row(
      <>{r.counterparty ?? "—"}{r.number && <span className="ml-2 text-xs text-slate-400">{r.number}</span>}</>,
      r.amount, { sub: true },
    )) : []),
  ];

  return (
    <Card className="mt-5 p-0">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="font-semibold text-slate-700">
          {t("Фактичні платежі")} — {t("у")} {monthLabel(nextMonthOf(d.month)).toLowerCase()} {t("за")} {monthLabel(d.month).toLowerCase()}
        </div>
        <div className={`text-sm font-semibold ${d.totals.balanceGross >= 0 ? "text-emerald-700" : "text-rose-600"}`}>
          {t("Сальдо")}: {zl(d.totals.balanceGross)}
        </div>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {row(<span className="font-semibold">{t("Приходи — виставлені фактури")}<span className="ml-2 text-xs font-normal text-slate-400">{d.income.count} {t("факт.")} · {t("нетто")} {zl(d.income.net)}</span></span>,
            d.income.gross, { tone: "font-semibold text-emerald-700" })}

          <tr className="border-b border-slate-100 bg-slate-50/80">
            <td colSpan={2} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">{t("Витрати")}</td>
          </tr>
          {row(t("ЗП на конто (зі сводної)"), d.salary.konto)}
          {row(t("ЗП готівкою (зі сводної)"), d.salary.cash)}
          {d.salary.unsplit > 0 && row(<>{t("ЗП без розкладки конто/готівка")}<span className="ml-2 text-xs text-slate-400">{t("сводна ще не розкладена")}</span></>, d.salary.unsplit)}
          {row(t("Аванси (зі сводної)"), d.advances)}
          {row(<>{t("Бензин (Orlen, KSeF)")}<span className="ml-2 text-xs text-slate-400">{d.fuel.count} {t("факт.")} · {t("нетто")} {zl(d.fuel.net)}</span></>, d.fuel.gross)}
          {catRows(d.repairs, t("Ремонти"))}
          {catRows(d.hostels, t("Хостели"))}

          {d.manual.firms.map(firm => {
            const item = d.manual.vat.find(m => m.firm === firm);
            return <ManualRow key={`vat-${firm}`} month={month} kind="vat" firm={firm} item={item} label={`VAT — ${firm}`}
              onSaved={() => qc.invalidateQueries({ queryKey: ["pnl-actuals"] })} />;
          })}
          {d.manual.firms.map(firm => {
            const item = d.manual.zus.find(m => m.firm === firm);
            return <ManualRow key={`zus-${firm}`} month={month} kind="zus" firm={firm} item={item} label={`ZUS — ${firm}`}
              onSaved={() => qc.invalidateQueries({ queryKey: ["pnl-actuals"] })} />;
          })}

          {row(<>{t("ЗП офісу — конто (зі сводної)")}<span className="ml-2 text-xs text-slate-400">{t("вкладки «Офис»")}</span></>, d.officeSalary.konto)}
          {row(t("ЗП офісу — готівкою"), d.officeSalary.cash)}
          {d.officeSalary.unsplit > 0 && row(t("ЗП офісу без розкладки"), d.officeSalary.unsplit)}

          {d.others.map(c => catRows(c, c.category))}
          {d.fuelRegistry.total > 0 && row(
            <span className="text-xs text-slate-400">{t("Категорія Paliwo з реєстру фактур — не входить у підсумок (дубль бензину з KSeF)")}</span>,
            null, { extra: <span className="ml-2 text-xs tabular-nums text-slate-400">{zl(d.fuelRegistry.total)}</span> })}
        </tbody>
        <tfoot className="bg-slate-50">
          <tr className="border-t border-slate-300 font-semibold text-slate-800">
            <td className="px-4 py-2">{t("Разом витрат")}</td>
            <td className="px-4 py-2 text-right tabular-nums text-rose-600">{zl(d.totals.expenses)}</td>
          </tr>
          <tr className="font-semibold">
            <td className="px-4 py-2">{t("Сальдо (приходи брутто − витрати)")}</td>
            <td className={`px-4 py-2 text-right tabular-nums ${d.totals.balanceGross >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{zl(d.totals.balanceGross)}</td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );
}

// Рядок VAT/ZUS фірми: сума вводиться руками, зберігається по blur/Enter
function ManualRow({ month, kind, firm, item, label, onSaved }: {
  month: string; kind: "vat" | "zus"; firm: string; item: ManualItem | undefined; label: string; onSaved: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const save = async () => {
    if (draft == null) return;
    const v = Number(draft.replace(",", "."));
    if (!Number.isFinite(v) || v < 0 || v === (item?.amount ?? 0)) { setDraft(null); return; }
    try { await put("/pnl/manual", { month, kind, firm, amount: v }); onSaved(); } catch (e: any) { toast.error(e.message); }
    setDraft(null);
  };
  return (
    <tr className="border-b border-slate-100">
      <td className="px-4 py-1.5 text-slate-700">{label}<span className="ml-2 text-xs text-slate-400">{t("вручну")}</span></td>
      <td className="px-4 py-1 text-right">
        <input
          value={draft ?? (item?.amount ? String(item.amount) : "")}
          placeholder="0.00"
          onChange={e => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setDraft(null); }}
          className="w-28 rounded-md border border-slate-200 px-2 py-0.5 text-right text-sm tabular-nums focus:border-red-400 focus:outline-none"
          inputMode="decimal"
        />
        <span className="ml-1 text-xs text-slate-400">zł</span>
      </td>
    </tr>
  );
}

// ── P&L по містах: собівартість + накладні (офіс, паливо, житло, фактури) ────
interface CityData {
  city: string;
  revenue: number; revenueClients: { label: string; amount: number }[];
  cogs: number; cogsClients: { label: string; amount: number }[];
  office: { total: number; rows: { personKey: string; name: string; cost: number; pct: number }[] };
  fuel: { total: number; workers: number };
  housing: { cost: number; deducted: number; net: number; hostels: { name: string; cost: number; source: string | null }[] };
  invoices: { total: number; rows: { id: number; number: string | null; counterparty: string | null; category: string | null; amount: number }[] };
  margin: number; overheads: number; net: number;
}
interface StaffRow { personKey: string; personName: string; firms: string[]; defaultCity: string; cost: number; allocations: { city: string; pct: number }[] }
interface CitiesData {
  month: string;
  cities: CityData[];
  staff: StaffRow[];
  fuelMeta: { bankTotal: number; workersTotal: number; commuteFactories: number };
  unallocated: { revenue: { label: string; amount: number }[]; fixed: { label: string; amount: number }[]; fixedTotal: number; fuel: number };
  totals: { revenue: number; cogs: number; overheads: number; net: number };
}

function CitiesView({ month }: { month: string }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery<CitiesData>({ queryKey: ["pnl-cities", month], queryFn: () => get(`/pnl/cities?month=${month}`) });
  const [open, setOpen] = useState<string | null>(null);
  const [staffOpen, setStaffOpen] = useState(false);
  const [editStaff, setEditStaff] = useState<StaffRow | null>(null);
  const d = q.data;
  if (q.isFetching && !d) return <Spinner />;
  if (!d) return <Empty>{t("Немає даних")}</Empty>;
  const cityNames = [...new Set([...d.cities.map(c => c.city), ...d.staff.map(s => s.defaultCity)])];

  return (
    <>
      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
              <th className="px-4 py-2 text-left">{t("Місто")}</th>
              <th className="px-3 py-2 text-right">{t("Дохід")}</th>
              <th className="px-3 py-2 text-right">{t("Собівартість")}</th>
              <th className="px-3 py-2 text-right">{t("Маржа")}</th>
              <th className="px-3 py-2 text-right">{t("Офіс/персонал")}</th>
              <th className="px-3 py-2 text-right">{t("Паливо")}</th>
              <th className="px-3 py-2 text-right">{t("Житло (нетто)")}</th>
              <th className="px-3 py-2 text-right">{t("Інші витрати")}</th>
              <th className="px-4 py-2 text-right">{t("Результат")}</th>
            </tr></thead>
            <tbody>
              {d.cities.map(c => [
                <tr key={c.city} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => setOpen(open === c.city ? null : c.city)}>
                  <td className="px-4 py-2 font-medium text-slate-700">
                    <span className="inline-flex items-center gap-1">
                      {open === c.city ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
                      {c.city}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700">{c.revenue ? zl(c.revenue) : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{c.cogs ? zl(c.cogs) : "—"}</td>
                  <td className={`whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums ${c.margin >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{zl(c.margin)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{c.office.total ? zl(c.office.total) : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{c.fuel.total ? zl(c.fuel.total) : "—"}</td>
                  <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${c.housing.net < 0 ? "text-emerald-700" : "text-slate-500"}`}>{c.housing.cost || c.housing.deducted ? zl(c.housing.net) : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{c.invoices.total ? zl(c.invoices.total) : "—"}</td>
                  <td className={`whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums ${c.net >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{zl(c.net)}</td>
                </tr>,
                open === c.city && (
                  <tr key={`${c.city}-d`} className="border-b border-slate-100 bg-slate-50/60">
                    <td colSpan={9} className="px-6 py-3">
                      <div className="grid gap-4 text-xs md:grid-cols-2 xl:grid-cols-4">
                        <DrillList title={t("Дохід по клієнтах")} rows={c.revenueClients.map(x => ({ label: x.label, amount: x.amount }))} />
                        <DrillList title={t("Собівартість по клієнтах")} rows={c.cogsClients.map(x => ({ label: x.label, amount: x.amount }))} />
                        <DrillList title={`${t("Персонал")} (${zl(c.office.total)})`} rows={c.office.rows.map(x => ({ label: `${x.name}${x.pct < 100 ? ` · ${x.pct}%` : ""}`, amount: x.cost }))} />
                        <div className="space-y-3">
                          <DrillList title={`${t("Житло")}: ${zl(c.housing.cost)} − ${zl(c.housing.deducted)} ${t("з ЗП")}`}
                            rows={c.housing.hostels.map(h => ({ label: `${h.name}${h.source === "contract" ? ` (${t("за договором")})` : ""}`, amount: h.cost }))} />
                          {c.invoices.rows.length > 0 && (
                            <DrillList title={t("Фактури міста")} rows={c.invoices.rows.map(i => ({ label: `${i.number ?? "—"}${i.counterparty ? ` · ${i.counterparty}` : ""}`, amount: i.amount }))} />
                          )}
                          {c.fuel.total > 0 && (
                            <div className="text-slate-500">
                              <Fuel className="mr-1 inline h-3.5 w-3.5" />
                              {t("Паливо:")} {zl(c.fuel.total)} · {c.fuel.workers}/{d.fuelMeta.workersTotal} {t("ос. на фабриках з доїздом")}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
            <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
              <td className="px-4 py-2">{t("Разом")}</td>
              <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.revenue)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.cogs)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.revenue - d.totals.cogs)}</td>
              <td colSpan={4} className="px-3 py-2 text-right tabular-nums text-slate-500">{t("накладні")}: {zl(d.totals.overheads)}</td>
              <td className={`px-4 py-2 text-right tabular-nums ${d.totals.net >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{zl(d.totals.net)}</td>
            </tr></tfoot>
          </table>
        </div>
      </Card>

      {/* нерозподілене: fixed-рядки + дохід без собівартості + паливо без фабрик */}
      {(d.unallocated.fixed.length > 0 || d.unallocated.revenue.length > 0 || d.unallocated.fuel > 0) && (
        <Card className="mt-4 p-4 text-sm">
          <div className="mb-2 font-semibold text-slate-700">{t("Нерозподілене по містах")}</div>
          <div className="grid gap-4 text-xs md:grid-cols-3">
            {d.unallocated.fixed.length > 0 && (
              <DrillList title={`${t("Постійні витрати (фірма загалом)")} — ${zl(d.unallocated.fixedTotal)}`} rows={d.unallocated.fixed} />
            )}
            {d.unallocated.revenue.length > 0 && (
              <DrillList title={t("Дохід без собівартості (не мапиться на місто)")} rows={d.unallocated.revenue} />
            )}
            {d.unallocated.fuel > 0 && (
              <div className="text-slate-500">
                <Fuel className="mr-1 inline h-3.5 w-3.5" />
                {t("Паливо")} {zl(d.unallocated.fuel)} {t("не поділене — познач фабрики з доїздом у налаштуваннях фабрик")}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* обслуговуючий персонал: хто скільки коштує і на які міста ділиться */}
      <Card className="mt-4 p-0">
        <button className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setStaffOpen(!staffOpen)}>
          <Users className="h-4 w-4 text-slate-400" />
          <span className="font-semibold text-slate-700">{t("Обслуговуючий персонал")}</span>
          <Badge color="slate">{d.staff.length}</Badge>
          <span className="ml-auto text-sm tabular-nums text-slate-500">{zl(d.staff.reduce((s, x) => s + x.cost, 0))}</span>
          {staffOpen ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
        </button>
        {staffOpen && (
          <table className="w-full border-t border-slate-100 text-sm">
            <tbody className="divide-y divide-slate-100">
              {d.staff.map(s => (
                <tr key={s.personKey} className="group hover:bg-slate-50">
                  <td className="px-4 py-1.5 text-slate-700">{s.personName}{s.firms.length > 0 && <span className="ml-2 text-xs text-slate-400">{s.firms.join(" · ")}</span>}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-500">
                    {s.allocations.length
                      ? s.allocations.map(a => `${a.city} ${a.pct}%`).join(" · ")
                      : <>{s.defaultCity} 100% <span className="text-slate-300">({t("типово")})</span></>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">{zl(s.cost)}</td>
                  <td className="w-10 py-1.5 pr-3 text-right">
                    <button className="invisible p-1 text-slate-300 hover:text-slate-600 group-hover:visible" title={t("Поділ між містами")}
                      onClick={() => setEditStaff(s)}><Pencil className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="mt-3 text-xs text-slate-400">
        {t("Дохід ділиться по містах пропорційно собівартості клієнта в кожному місті. Житло = фактури хостелів (або договірна ціна) мінус утримання з зарплат. Паливо — банк-категорія «Паливо», поділена за кількістю людей на фабриках з доїздом.")}
      </div>

      {editStaff && (
        <StaffAllocModal staff={editStaff} cityOptions={cityNames}
          onClose={() => setEditStaff(null)}
          onSaved={() => { setEditStaff(null); qc.invalidateQueries({ queryKey: ["pnl-cities"] }); }} />
      )}
    </>
  );
}

function DrillList({ title, rows }: { title: string; rows: { label: string; amount: number }[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      <div className="space-y-0.5">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2 text-slate-600">
            <span className="truncate">{r.label}</span>
            <span className="ml-auto shrink-0 tabular-nums">{zl(r.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StaffAllocModal({ staff, cityOptions, onClose, onSaved }: {
  staff: StaffRow; cityOptions: string[]; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<{ city: string; pct: string }[]>(
    staff.allocations.length ? staff.allocations.map(a => ({ city: a.city, pct: String(a.pct) }))
      : [{ city: staff.defaultCity, pct: "100" }]
  );
  const [busy, setBusy] = useState(false);
  const total = rows.reduce((s, r) => s + (Number(r.pct.replace(",", ".")) || 0), 0);
  const save = async (reset = false) => {
    setBusy(true);
    try {
      await put("/pnl/staff-allocations", {
        personKey: staff.personKey, personName: staff.personName,
        allocations: reset ? [] : rows.map(r => ({ city: r.city.trim(), pct: Number(r.pct.replace(",", ".")) })),
      });
      toast.success(t("Збережено"));
      onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`${staff.personName} — ${t("поділ між містами")}`} onClose={onClose}>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input list="alloc-cities" value={r.city} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, city: e.target.value } : x))} placeholder={t("Місто")} />
            <Input value={r.pct} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} inputMode="decimal" className="w-20 text-right" />
            <span className="text-sm text-slate-400">%</span>
            {rows.length > 1 && (
              <button className="p-1 text-slate-300 hover:text-rose-500" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
            )}
          </div>
        ))}
        <datalist id="alloc-cities">{cityOptions.map(c => <option key={c} value={c} />)}</datalist>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setRows(rs => [...rs, { city: "", pct: "" }])}><Plus className="h-4 w-4" /> {t("Додати місто")}</Button>
          <span className={`ml-auto text-xs tabular-nums ${Math.abs(total - 100) > 0.5 ? "text-rose-600" : "text-slate-400"}`}>Σ {total}%</span>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          {staff.allocations.length > 0 && (
            <Button variant="secondary" loading={busy} onClick={() => save(true)}>{t("Скинути до типового")}</Button>
          )}
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={busy} disabled={Math.abs(total - 100) > 0.5 || rows.some(r => !r.city.trim())} onClick={() => save(false)}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
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

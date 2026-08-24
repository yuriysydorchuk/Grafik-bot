// «Пальне» (cap `fuel`) — аналітика фактур Orlen по місяцях: кошти на місто /
// водія / авто / продукт, дрил-даун транзакцій, довідник флотових карток
// (мапінг картка → місто команди / водій / авто) та імпорт PDF-фактур.
import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Fuel as FuelIcon, Upload, Plus, Trash2, Pencil, AlertTriangle, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del, upload } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Button, Input, Modal, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { monthOptions } from "../lib/dates";
import { useT } from "../lib/i18n";

type Agg = {
  key: string; label: string; liters: number; fuelNet: number; fuelGross: number;
  goodsNet: number; goodsGross: number; net: number; gross: number; txCount: number;
};
type CardAgg = Agg & { city: string | null; driverName: string | null; vehiclePlate: string | null; mapped: boolean; regNumbers: string[] };
type Invoice = { id: number; number: string; invoiceDate: string; saleDate: string | null; net: number; vat: number; gross: number; fileName: string | null };
type StationAgg = Agg & { region: string | null };
type NoRegAgg = Agg & { cardNumber: string };
type VehicleAgg = Agg & { km: number | null }; // пробіг: журнал Любліна до 07.2026, далі бот-зміни
type Summary = {
  month: string;
  totals: { liters: number; fuelNet: number; fuelGross: number; goodsNet: number; goodsGross: number; net: number; gross: number; avgPricePerLiter: number | null; txCount: number };
  byCity: Agg[]; byDriver: Agg[]; byVehicle: VehicleAgg[]; byProduct: Agg[]; byStationCity: StationAgg[]; byMonth: Agg[];
  noRegByCard: NoRegAgg[];
  byCard: CardAgg[]; unmappedCards: CardAgg[]; invoices: Invoice[];
};
type TxRow = {
  id: number; lp: number; invoiceNumber: string; cardNumber: string; cardLabel: string | null;
  driverName: string | null; city: string | null; regNumber: string | null; product: string; isFuel: boolean;
  stationCity: string | null; stationNo: string | null; txDate: string; txTime: string | null;
  qty: number; unitPrice: number | null; priceAfterRebate: number | null; vatRate: number | null;
  net: number; vatAmount: number; gross: number;
};
type FuelCard = { id: number; cardNumber: string; label: string | null; city: string | null; driverId: number | null; vehicleId: number | null; note: string | null; isActive: boolean; driverName: string | null; vehiclePlate: string | null };
type SeenCard = { cardNumber: string; lastTx: string | null; regNumber: string | null; txCount: number; mapped: boolean };

type TxFilter = { card?: string; city?: string; driver?: string; vehicle?: string; product?: string; stationCity?: string; region?: string; kind?: "fuel" | "goods" };
type Tab = "overview" | "tx" | "cards";

const zl = (n: number) => `${n.toFixed(2)} zł`;

export default function Fuel() {
  const t = useT();
  const qc = useQueryClient();
  const fallbackMonths = useMemo(() => monthOptions(), []);
  const { data: monthsData } = useQuery<{ months: string[]; years: string[]; invoices: Invoice[] }>({
    queryKey: ["fuel-months"], queryFn: () => get("/fuel/months"),
  });
  const months = monthsData?.months?.length ? monthsData.months : fallbackMonths.map(m => m.value);
  const years = monthsData?.years ?? [];
  const [month, setMonth] = useState<string | null>(null);
  const activeMonth = month ?? months[0] ?? fallbackMonths[0]!.value;
  const [tab, setTab] = useState<Tab>("overview");
  const [txFilter, setTxFilter] = useState<TxFilter>({});

  const { data: summary, isFetching } = useQuery<Summary>({
    queryKey: ["fuel-summary", activeMonth],
    queryFn: () => get(`/fuel/summary?month=${activeMonth}`),
  });

  const fileRef = useRef<HTMLInputElement>(null);
  const importMut = useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      return upload<{ results: { file: string; ok: boolean; number?: string; replaced?: boolean; txCount?: number; error?: string; warnings?: string[] }[] }>("/fuel/import", form);
    },
    onSuccess: (data) => {
      const okRes = data.results.filter(r => r.ok);
      const bad = data.results.filter(r => !r.ok);
      const warns = okRes.flatMap(r => r.warnings ?? []);
      if (okRes.length) toast.success(`${t("Імпортовано фактур:")} ${okRes.length}${warns.length ? ` (${t("попереджень:")} ${warns.length})` : ""}`);
      for (const b of bad) toast.error(`${b.file}: ${b.error}`);
      qc.invalidateQueries({ queryKey: ["fuel-months"] });
      qc.invalidateQueries({ queryKey: ["fuel-summary"] });
      qc.invalidateQueries({ queryKey: ["fuel-tx"] });
      qc.invalidateQueries({ queryKey: ["fuel-cards"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const drill = (f: TxFilter) => { setTxFilter(f); setTab("tx"); };

  return (
    <>
      <PageHeader title={t("Пальне")} subtitle={t("Фактури Orlen — кошти по містах, водіях і авто")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={activeMonth} onChange={e => { setMonth(e.target.value); setTxFilter({}); }} className="w-44">
          {years.map(y => <option key={y} value={y}>{y} — {t("весь рік")}</option>)}
          {months.map(m => <option key={m} value={m}>{m}</option>)}
        </Select>
        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {([["overview", t("Огляд")], ["tx", t("Транзакції")], ["cards", t("Картки")]] as [Tab, string][]).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-sm font-medium ${tab === k ? "bg-red-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
              {label}
            </button>
          ))}
        </div>
        {!!summary?.unmappedCards?.length && tab !== "cards" && (
          <button type="button" onClick={() => setTab("cards")} className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-100">
            <AlertTriangle className="h-4 w-4" /> {t("Незамаплених карток:")} {summary.unmappedCards.length}
          </button>
        )}
        <input ref={fileRef} type="file" accept="application/pdf" multiple className="hidden"
          // File-обʼєкти знімаємо синхронно: mutationFn виконується вже після
          // очистки інпута, а живий FileList на той момент порожній (400 «нема файлів»)
          onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) importMut.mutate(files); e.target.value = ""; }} />
        <Button className="ml-auto" loading={importMut.isPending} onClick={() => fileRef.current?.click()}>
          <Upload className="h-4 w-4" /> {t("Імпорт PDF")}
        </Button>
      </div>

      {isFetching && !summary ? <Spinner /> : !summary ? null : (
        <>
          {tab === "overview" && <Overview summary={summary} onDrill={drill} onPickMonth={m => { setMonth(m); setTxFilter({}); }} />}
          {tab === "tx" && <Transactions month={activeMonth} filter={txFilter} onClear={() => setTxFilter({})} />}
          {tab === "cards" && <Cards onDrill={drill} />}
        </>
      )}
    </>
  );
}

// ── Огляд ───────────────────────────────────────────────────────────────────
function Overview({ summary, onDrill, onPickMonth }: { summary: Summary; onDrill: (f: TxFilter) => void; onPickMonth: (m: string) => void }) {
  const t = useT();
  const s = summary.totals;
  const tiles: [string, string][] = [
    [t("Літрів"), s.liters.toFixed(0)],
    [t("Паливо (брутто)"), zl(s.fuelGross)],
    [t("Інше: дороги, товари (брутто)"), zl(s.goodsGross)],
    [t("Разом (брутто)"), zl(s.gross)],
    [t("Середня ціна / л"), s.avgPricePerLiter != null ? zl(s.avgPricePerLiter) : "—"],
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map(([label, value]) => (
          <Card key={label} className="px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
            <div className="mt-1 text-lg font-bold tabular-nums text-slate-800">{value}</div>
          </Card>
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        {summary.byMonth.length > 1 && (
          <AggTable title={t("По місяцях")} rows={summary.byMonth} onDrill={m => onPickMonth(m)} />
        )}
        <AggTable title={t("По містах (команда картки)")} rows={summary.byCity} onDrill={k => onDrill({ city: k })} />
        <AggTable title={t("По водіях")} rows={summary.byDriver} onDrill={k => onDrill({ driver: k })} />
        <VehicleTable rows={summary.byVehicle} noReg={summary.noRegByCard} onDrill={onDrill} />
        <AggTable title={t("По продуктах")} rows={summary.byProduct.map(r => r.key === "__goods__" ? { ...r, label: t("Непаливне (дороги, товари)") } : r)}
          onDrill={(k) => onDrill(k === "__goods__" ? { kind: "goods" } : { product: k })} litersCol />
        <RegionTable rows={summary.byStationCity} onDrill={onDrill} />
        <InvoicesCard invoices={summary.invoices} />
      </div>
    </div>
  );
}

function AggTable({ title, rows, onDrill, litersCol }: { title: string; rows: Agg[]; onDrill?: (key: string) => void; litersCol?: boolean }) {
  const t = useT();
  if (!rows.length) return null;
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3 text-sm font-bold tracking-tight text-slate-800">{title}</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-400">
            <td className="px-4 py-1.5">{title.includes(t("продукт")) ? t("Продукт") : ""}</td>
            <td className="px-2 py-1.5 text-right">{t("Літри")}</td>
            {!litersCol && <td className="px-2 py-1.5 text-right">{t("Паливо")}</td>}
            {!litersCol && <td className="px-2 py-1.5 text-right">{t("Інше")}</td>}
            <td className="px-4 py-1.5 text-right">{t("Разом (брутто)")}</td>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(r => (
            <tr key={r.key || "—"} className={onDrill ? "cursor-pointer hover:bg-red-50/40" : undefined}
              onClick={onDrill ? () => onDrill(r.key) : undefined}
              title={onDrill ? t("Клікни — транзакції") : undefined}>
              <td className="px-4 py-1.5 font-medium text-slate-700">{r.label}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.liters ? r.liters.toFixed(0) : "—"}</td>
              {!litersCol && <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.fuelGross ? zl(r.fuelGross) : "—"}</td>}
              {!litersCol && <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.goodsGross ? zl(r.goodsGross) : "—"}</td>}
              <td className="px-4 py-1.5 text-right font-semibold tabular-nums text-slate-800">{zl(r.gross)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// «По авто» — як AggTable, але рядок «—» (заправки без номера авто) розгортається
// у список «хто і на скільки» (по картках); клік по людині → її транзакції без номера.
function VehicleTable({ rows, noReg, onDrill }: { rows: VehicleAgg[]; noReg: NoRegAgg[]; onDrill: (f: TxFilter) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3 text-sm font-bold tracking-tight text-slate-800">{t("По авто")}</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-400">
            <td className="px-4 py-1.5" />
            <td className="px-2 py-1.5 text-right">{t("Пробіг, км")}</td>
            <td className="px-2 py-1.5 text-right">{t("зл/км")}</td>
            <td className="px-2 py-1.5 text-right">{t("л/100 км")}</td>
            <td className="px-2 py-1.5 text-right">{t("Літри")}</td>
            <td className="px-2 py-1.5 text-right">{t("Паливо")}</td>
            <td className="px-2 py-1.5 text-right">{t("Інше")}</td>
            <td className="px-4 py-1.5 text-right">{t("Разом (брутто)")}</td>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(r => {
            const isNoReg = !r.key;
            const main = (
              <tr key={r.key || "—"} className="cursor-pointer hover:bg-red-50/40"
                onClick={isNoReg ? () => setOpen(o => !o) : () => onDrill({ vehicle: r.key })}
                title={isNoReg ? t("Клікни — хто заправляв без номера") : t("Клікни — транзакції")}>
                <td className="px-4 py-1.5 font-medium text-slate-700">
                  {isNoReg ? (
                    <>
                      <span className="mr-1.5 inline-block w-3 text-slate-400">{open ? "▾" : "▸"}</span>
                      {t("Без номера авто")}
                      <span className="ml-2 text-xs text-slate-400">{noReg.length}</span>
                    </>
                  ) : r.label}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.km != null ? r.km.toLocaleString("uk-UA") : "—"}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.km && r.fuelGross ? (r.fuelGross / r.km).toFixed(2) : "—"}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.km && r.liters ? (r.liters / r.km * 100).toFixed(1) : "—"}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.liters ? r.liters.toFixed(0) : "—"}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.fuelGross ? zl(r.fuelGross) : "—"}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.goodsGross ? zl(r.goodsGross) : "—"}</td>
                <td className="px-4 py-1.5 text-right font-semibold tabular-nums text-slate-800">{zl(r.gross)}</td>
              </tr>
            );
            const subs = isNoReg && open ? noReg.map(s => (
              <tr key={`noreg-${s.cardNumber}`} className="cursor-pointer bg-slate-50/50 hover:bg-red-50/40"
                onClick={() => onDrill({ vehicle: "", card: s.cardNumber })} title={t("Клікни — транзакції")}>
                <td className="px-4 py-1 pl-10 text-slate-500">{s.label}</td>
                <td className="px-2 py-1 text-right tabular-nums text-slate-400">—</td>
                <td className="px-2 py-1 text-right tabular-nums text-slate-400">—</td>
                <td className="px-2 py-1 text-right tabular-nums text-slate-400">—</td>
                <td className="px-2 py-1 text-right tabular-nums text-slate-400">{s.liters ? s.liters.toFixed(0) : "—"}</td>
                <td className="px-2 py-1 text-right tabular-nums text-slate-400">{s.fuelGross ? zl(s.fuelGross) : "—"}</td>
                <td className="px-2 py-1 text-right tabular-nums text-slate-400">{s.goodsGross ? zl(s.goodsGross) : "—"}</td>
                <td className="px-4 py-1 text-right tabular-nums text-slate-500">{zl(s.gross)}</td>
              </tr>
            )) : [];
            return [main, ...subs];
          })}
        </tbody>
      </table>
    </Card>
  );
}

// Міста станцій, згруповані у воєводства: рядок регіону з підсумком,
// клік розгортає міста всередині.
function RegionTable({ rows, onDrill }: { rows: StationAgg[]; onDrill: (f: TxFilter) => void }) {
  const t = useT();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const by = new Map<string, { key: string; label: string; cities: StationAgg[]; liters: number; gross: number }>();
    for (const r of rows) {
      const key = r.region ?? "__other__";
      const g = by.get(key) ?? by.set(key, { key, label: r.region ?? t("Інше"), cities: [], liters: 0, gross: 0 }).get(key)!;
      g.cities.push(r); g.liters += r.liters; g.gross += r.gross;
    }
    return [...by.values()].sort((a, b) => b.gross - a.gross);
  }, [rows, t]);
  if (!rows.length) return null;
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3 text-sm font-bold tracking-tight text-slate-800">
        {t("По регіонах станцій (де заправлялись)")}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-400">
            <td className="px-4 py-1.5">{t("Воєводство")}</td>
            <td className="px-2 py-1.5 text-right">{t("Літри")}</td>
            <td className="px-4 py-1.5 text-right">{t("Разом (брутто)")}</td>
            <td className="w-10" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {groups.map(g => [
            <tr key={g.key} className="group cursor-pointer hover:bg-red-50/40" onClick={() => setOpen(o => ({ ...o, [g.key]: !o[g.key] }))}
              title={t("Клікни — міста регіону")}>
              <td className="px-4 py-1.5 font-medium text-slate-700">
                <span className="mr-1.5 inline-block w-3 text-slate-400">{open[g.key] ? "▾" : "▸"}</span>
                {g.label}
                <span className="ml-2 text-xs text-slate-400">{g.cities.length}</span>
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{g.liters.toFixed(0)}</td>
              <td className="px-4 py-1.5 text-right font-semibold tabular-nums text-slate-800">{zl(g.gross)}</td>
              <td className="px-2 text-right">
                <button type="button" title={t("Показати транзакції")}
                  onClick={e => { e.stopPropagation(); onDrill({ region: g.key }); }}
                  className="invisible rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500 group-hover:visible">
                  <ArrowLeft className="h-3.5 w-3.5 rotate-180" />
                </button>
              </td>
            </tr>,
            ...(open[g.key] ? g.cities.map(c => (
              <tr key={`${g.key}-${c.key}`} className="cursor-pointer bg-slate-50/50 hover:bg-red-50/40"
                onClick={() => onDrill({ stationCity: c.key })} title={t("Клікни — транзакції")}>
                <td className="px-4 py-1 pl-10 text-slate-500">{c.label}</td>
                <td className="px-2 py-1 text-right tabular-nums text-slate-400">{c.liters.toFixed(0)}</td>
                <td className="px-4 py-1 text-right tabular-nums text-slate-500">{zl(c.gross)}</td>
                <td />
              </tr>
            )) : []),
          ])}
        </tbody>
      </table>
    </Card>
  );
}

function InvoicesCard({ invoices }: { invoices: Invoice[] }) {
  const t = useT();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: number) => del(`/fuel/invoices/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fuel-months"] }); qc.invalidateQueries({ queryKey: ["fuel-summary"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  if (!invoices.length) return null;
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3 text-sm font-bold tracking-tight text-slate-800">{t("Фактури періоду")}</div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-100">
          {invoices.map(inv => (
            <tr key={inv.id} className="group">
              <td className="px-4 py-1.5 font-medium tabular-nums text-slate-700">№{inv.number}</td>
              <td className="px-2 py-1.5 tabular-nums text-slate-500">{inv.invoiceDate}</td>
              <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-slate-800">{zl(inv.gross)}</td>
              <td className="w-10 px-2 text-right">
                <button type="button" title={t("Видалити фактуру")}
                  onClick={() => window.confirm(`№${inv.number}: ${t("видалити фактуру разом із транзакціями?")}`) && remove.mutate(inv.id)}
                  className="invisible rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500 group-hover:visible">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ── Транзакції ──────────────────────────────────────────────────────────────
function Transactions({ month, filter, onClear }: { month: string; filter: TxFilter; onClear: () => void }) {
  const t = useT();
  const params = new URLSearchParams({ month });
  if (filter.card) params.set("card", filter.card);
  if (filter.city !== undefined) params.set("city", filter.city);
  if (filter.driver !== undefined) params.set("driver", filter.driver);
  if (filter.vehicle !== undefined) params.set("vehicle", filter.vehicle);
  if (filter.product) params.set("product", filter.product);
  if (filter.stationCity !== undefined) params.set("stationCity", filter.stationCity);
  if (filter.region !== undefined) params.set("region", filter.region);
  if (filter.kind === "fuel") params.set("fuelOnly", "1");
  if (filter.kind === "goods") params.set("goodsOnly", "1");
  const { data, isFetching } = useQuery<{ rows: TxRow[] }>({
    queryKey: ["fuel-tx", params.toString()],
    queryFn: () => get(`/fuel/transactions?${params.toString()}`),
  });
  const hasFilter = Object.keys(filter).length > 0;
  const [detail, setDetail] = useState<TxRow | null>(null);
  const rows = data?.rows ?? [];
  const total = rows.reduce((a, r) => a + r.gross, 0);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
        <span className="text-sm font-bold tracking-tight text-slate-800">{t("Транзакції")}</span>
        <Badge color="slate">{rows.length}</Badge>
        <span className="text-sm font-semibold tabular-nums text-slate-700">{zl(total)}</span>
        {hasFilter && (
          <button type="button" onClick={onClear} className="ml-auto flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-600">
            <ArrowLeft className="h-3.5 w-3.5" /> {t("Скинути фільтр")}
          </button>
        )}
      </div>
      {isFetching && !data ? <Spinner /> : !rows.length ? <Empty>{t("Транзакцій немає")}</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <td className="px-4 py-1.5">{t("Дата")}</td>
                <td className="px-2 py-1.5">{t("Продукт")}</td>
                <td className="px-2 py-1.5">{t("Авто")}</td>
                <td className="px-2 py-1.5">{t("Водій / картка")}</td>
                <td className="px-2 py-1.5">{t("Місто")}</td>
                <td className="px-2 py-1.5">{t("Станція")}</td>
                <td className="px-2 py-1.5 text-right">{t("К-сть")}</td>
                <td className="px-2 py-1.5 text-right">{t("Ціна")}</td>
                <td className="px-4 py-1.5 text-right">{t("Брутто")}</td>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.id} className="cursor-pointer hover:bg-slate-50/60" onClick={() => setDetail(r)} title={t("Клікни — деталі")}>
                  <td className="whitespace-nowrap px-4 py-1.5 tabular-nums text-slate-600">{r.txDate}{r.txTime ? ` ${r.txTime.slice(0, 5)}` : ""}</td>
                  <td className="px-2 py-1.5 text-slate-700">
                    {r.product}
                    {!r.isFuel && <Badge color="slate">{t("не паливо")}</Badge>}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-600">{r.regNumber ?? "—"}</td>
                  <td className="px-2 py-1.5 text-slate-600">{r.driverName ?? r.cardLabel ?? `…${r.cardNumber.slice(-4)}`}</td>
                  <td className="px-2 py-1.5 text-slate-600">{r.city ?? "—"}</td>
                  <td className="px-2 py-1.5 text-slate-500">{r.stationCity ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{r.isFuel ? `${r.qty.toFixed(2)} l` : r.qty}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.priceAfterRebate ?? r.unitPrice ?? "—"}</td>
                  <td className="px-4 py-1.5 text-right font-semibold tabular-nums text-slate-800">{zl(r.gross)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail && <TxDetailModal tx={detail} onClose={() => setDetail(null)} />}
    </Card>
  );
}

function TxDetailModal({ tx, onClose }: { tx: TxRow; onClose: () => void }) {
  const t = useT();
  const rows: [string, string][] = [
    [t("Дата"), `${tx.txDate}${tx.txTime ? ` ${tx.txTime}` : ""}`],
    [t("Продукт"), tx.product],
    [t("Фактура"), `№${tx.invoiceNumber} (${t("поз.")} ${tx.lp})`],
    [t("Картка"), tx.cardNumber],
    [t("Назва / хто"), tx.cardLabel ?? "—"],
    [t("Водій"), tx.driverName ?? "—"],
    [t("Місто (розріз аналітики)"), tx.city ?? "—"],
    [t("Авто"), tx.regNumber ?? "—"],
    [t("Станція"), tx.stationCity ? `${tx.stationCity}${tx.stationNo ? ` — №${tx.stationNo}` : ""}` : "—"],
    [tx.isFuel ? t("Літри") : t("К-сть"), tx.isFuel ? `${tx.qty.toFixed(2)} l` : String(tx.qty)],
    [t("Ціна"), tx.unitPrice != null ? zl(tx.unitPrice) : "—"],
    [t("Ціна після рабату"), tx.priceAfterRebate != null ? zl(tx.priceAfterRebate) : "—"],
    ["VAT", tx.vatRate != null ? `${tx.vatRate}% (${zl(tx.vatAmount)})` : "ND"],
    [t("Нетто"), zl(tx.net)],
    [t("Брутто"), zl(tx.gross)],
  ];
  return (
    <Modal open onClose={onClose} title={t("Деталі транзакції")}>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-100">
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td className="py-1.5 pr-4 text-slate-500">{label}</td>
              <td className="py-1.5 text-right font-medium tabular-nums text-slate-800">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

// ── Картки ──────────────────────────────────────────────────────────────────
function Cards({ onDrill }: { onDrill: (f: TxFilter) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isFetching } = useQuery<{ cards: FuelCard[]; seen: SeenCard[] }>({
    queryKey: ["fuel-cards"], queryFn: () => get("/fuel/cards"),
  });
  const [editing, setEditing] = useState<FuelCard | null>(null);
  const [creating, setCreating] = useState<{ cardNumber: string; regNumber: string | null } | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => del(`/fuel/cards/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fuel-cards"] }); qc.invalidateQueries({ queryKey: ["fuel-summary"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  if (isFetching && !data) return <Spinner />;
  const seenBy = new Map((data?.seen ?? []).map(s => [s.cardNumber, s]));
  const unmapped = (data?.seen ?? []).filter(s => !s.mapped);
  return (
    <div className="space-y-5">
      {!!unmapped.length && (
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
            <AlertTriangle className="h-4 w-4" /> {t("Картки з фактур без мапінгу")}
            <Badge color="amber">{unmapped.length}</Badge>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {unmapped.map(s => (
                <tr key={s.cardNumber} className="cursor-pointer hover:bg-amber-50/40" onClick={() => onDrill({ card: s.cardNumber })} title={t("Клікни — транзакції")}>
                  <td className="px-4 py-1.5 font-mono text-xs text-slate-700">{s.cardNumber}</td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-600">{s.regNumber ?? "—"}</td>
                  <td className="px-2 py-1.5 text-slate-500">{s.txCount} {t("транз.")}</td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-500">{s.lastTx}</td>
                  <td className="w-28 px-3 py-1.5 text-right">
                    <Button variant="secondary" onClick={e => { e.stopPropagation(); setCreating({ cardNumber: s.cardNumber, regNumber: s.regNumber }); }}>
                      <Plus className="h-3.5 w-3.5" /> {t("Замапити")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
          <FuelIcon className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-bold tracking-tight text-slate-800">{t("Довідник карток")}</span>
          <Badge color="slate">{data?.cards.length ?? 0}</Badge>
          <Button className="ml-auto" variant="secondary" onClick={() => setCreating({ cardNumber: "", regNumber: null })}>
            <Plus className="h-4 w-4" /> {t("Додати картку")}
          </Button>
        </div>
        {!data?.cards.length ? <Empty>{t("Довідник порожній — замап картки з фактур вище")}</Empty> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <td className="px-4 py-1.5">{t("Картка")}</td>
                <td className="px-2 py-1.5">{t("Назва / хто")}</td>
                <td className="px-2 py-1.5">{t("Місто")}</td>
                <td className="px-2 py-1.5">{t("Водій")}</td>
                <td className="px-2 py-1.5">{t("Авто")}</td>
                <td className="px-2 py-1.5 text-right">{t("Транз.")}</td>
                <td className="w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.cards.map(c => (
                <tr key={c.id} className="group cursor-pointer hover:bg-slate-50/60" onClick={() => onDrill({ card: c.cardNumber })} title={t("Клікни — транзакції")}>
                  <td className="px-4 py-1.5 font-mono text-xs text-slate-700">…{c.cardNumber.slice(-6)}</td>
                  <td className="px-2 py-1.5 text-slate-700">{c.label ?? "—"}{c.note && <span className="ml-2 text-xs text-slate-400">{c.note}</span>}</td>
                  <td className="px-2 py-1.5 text-slate-600">{c.city ?? "—"}</td>
                  <td className="px-2 py-1.5 text-slate-600">{c.driverName ?? "—"}</td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-600">{c.vehiclePlate ?? seenBy.get(c.cardNumber)?.regNumber ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{seenBy.get(c.cardNumber)?.txCount ?? 0}</td>
                  <td className="w-20 px-2 text-right">
                    <button type="button" title={t("Редагувати")} onClick={e => { e.stopPropagation(); setEditing(c); }}
                      className="invisible rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600 group-hover:visible">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" title={t("Видалити")}
                      onClick={e => { e.stopPropagation(); window.confirm(`…${c.cardNumber.slice(-6)}: ${t("видалити з довідника?")}`) && remove.mutate(c.id); }}
                      className="invisible rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500 group-hover:visible">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {(creating || editing) && (
        <CardModal
          card={editing}
          presetNumber={creating?.cardNumber ?? ""}
          presetReg={creating?.regNumber ?? null}
          onClose={() => { setCreating(null); setEditing(null); }}
        />
      )}
    </div>
  );
}

function CardModal({ card, presetNumber, presetReg, onClose }: { card: FuelCard | null; presetNumber: string; presetReg: string | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: drivers } = useQuery<{ id: number; name: string; isActive?: boolean }[]>({ queryKey: ["drivers"], queryFn: () => get("/drivers") });
  const { data: vehicles } = useQuery<{ id: number; plate: string; brandModel?: string | null; isActive?: boolean }[]>({ queryKey: ["vehicles"], queryFn: () => get("/vehicles") });
  const normPlate = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();
  const suggestedVehicle = presetReg ? (vehicles ?? []).find(v => normPlate(v.plate) === normPlate(presetReg)) : undefined;

  const [cardNumber, setCardNumber] = useState(card?.cardNumber ?? presetNumber);
  const [label, setLabel] = useState(card?.label ?? "");
  const [city, setCity] = useState(card?.city ?? "");
  const [driverId, setDriverId] = useState<string>(card?.driverId != null ? String(card.driverId) : "");
  const [vehicleId, setVehicleId] = useState<string>(card?.vehicleId != null ? String(card.vehicleId) : suggestedVehicle ? String(suggestedVehicle.id) : "");
  const [note, setNote] = useState(card?.note ?? "");

  const save = useMutation({
    mutationFn: () => {
      const body = {
        label: label.trim() || null, city: city.trim() || null,
        driverId: driverId ? Number(driverId) : null,
        vehicleId: vehicleId ? Number(vehicleId) : null,
        note: note.trim() || null,
      };
      return card ? patch(`/fuel/cards/${card.id}`, body) : post("/fuel/cards", { ...body, cardNumber: cardNumber.trim() });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fuel-cards"] });
      qc.invalidateQueries({ queryKey: ["fuel-summary"] });
      qc.invalidateQueries({ queryKey: ["fuel-tx"] });
      toast.success(t("Збережено"));
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={card ? `${t("Картка")} …${card.cardNumber.slice(-6)}` : t("Додати картку")}>
      <div className="space-y-3">
        {!card && (
          <div>
            <Label>{t("Номер картки (17 цифр)")}</Label>
            <Input value={cardNumber} onChange={e => setCardNumber(e.target.value)} placeholder="78971517791900…" />
          </div>
        )}
        <div><Label>{t("Назва / хто користується")}</Label><Input value={label} onChange={e => setLabel(e.target.value)} placeholder={t("напр., Бус Люблін 1")} /></div>
        <div><Label>{t("Місто (розріз аналітики)")}</Label><Input value={city} onChange={e => setCity(e.target.value)} placeholder="Lublin / Poznań / …" /></div>
        <div>
          <Label>{t("Водій")}</Label>
          <Select value={driverId} onChange={e => setDriverId(e.target.value)}>
            <option value="">—</option>
            {(drivers ?? []).filter(d => d.isActive !== false || String(d.id) === driverId).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </div>
        <div>
          <Label>{t("Авто")}</Label>
          <Select value={vehicleId} onChange={e => setVehicleId(e.target.value)}>
            <option value="">—</option>
            {(vehicles ?? []).map(v => <option key={v.id} value={v.id}>{v.plate}{v.brandModel ? ` — ${v.brandModel}` : ""}</option>)}
          </Select>
          {suggestedVehicle && !card && <div className="mt-1 text-xs text-slate-400">{t("Підставлено по номеру з фактур:")} {presetReg}</div>}
        </div>
        <div><Label>{t("Примітка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} placeholder={t("необовʼязково")} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!card && !/^\d{17}$/.test(cardNumber.trim())} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

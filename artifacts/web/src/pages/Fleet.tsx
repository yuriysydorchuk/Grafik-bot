// Автопарк 2.0 — повні картки авто (страховка/техогляд/власність), алерти про
// сплив документів і облік ремонтів по місяцях (мігровано з таблиці «АВТОПАРК 2»).
// Фінансовий шар (оренда, ціни купівлі/продажу) приходить з API лише з viewFinance.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, CarFront, ShieldAlert, Wrench } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del, type Company } from "../lib/api";
import { Button, Input, Label, Card, Spinner, Badge, Modal, Empty, Select } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT } from "../lib/i18n";

type FleetVehicle = {
  id: number; plate: string; brandModel: string | null; seats: number | null; isActive: boolean;
  city: string | null; companyId: number | null; companyName: string | null; ownerName: string | null;
  fuel: string | null; year: number | null; vin: string | null; ownership: string | null;
  insuranceUntil: string | null; inspectionUntil: string | null;
  rentMonthly?: number | null; purchasePrice?: number | null; marketPrice?: number | null;
  leaseTotal?: number | null; leaseInitialPaid?: number | null; leaseLessor: string | null; leaseContractNo: string | null;
  leaseInvoiced?: number; leasePaid?: number; leaseInvoiceCount?: number;
  purchasedAt: string | null; soldAt: string | null; status: string; kind: string | null; personal: boolean;
  equipment: Record<string, string>; notes: string | null;
};
type FleetAlert = {
  id: number; plate: string; brandModel: string | null; city: string | null;
  insuranceUntil: string | null; inspectionUntil: string | null;
  insuranceExpired: boolean; insuranceSoon: boolean; inspectionExpired: boolean; inspectionSoon: boolean;
};
type Expense = {
  id: number; vehicleId: number | null; vehicleLabel: string | null; plate: string | null; brandModel: string | null;
  month: string; amount: number; kind: string; service: string | null; invoiceNo: string | null; note: string | null;
};
type Summary = {
  year: string;
  vehicles: { vehicleId: number | null; label: string; months: Record<string, number>; total: number }[];
  grandTotal: number;
  invoices: { id: number; invoiceNo: string; service: string | null; month: string; amount: number }[];
  invoicesTotal: number;
};

const OWNERSHIP_LABEL: Record<string, string> = { umowa: "umowa", leasing: "leasing", faktura: "faktura", private: "приватне" };
const fmtDate = (d: string | null) => (d ? d.split("-").reverse().join(".") : "—");
const fmtPln = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });

function DateBadge({ date, t }: { date: string | null; t: (s: string) => string }) {
  if (!date) return <span className="text-slate-400">—</span>;
  const today = todayStr();
  const soon = new Date(Date.parse(today) + 30 * 86400_000).toISOString().slice(0, 10);
  if (date < today) return <Badge color="rose">{fmtDate(date)}</Badge>;
  if (date <= soon) return <Badge color="amber">{fmtDate(date)}</Badge>;
  return <span className="tabular-nums text-slate-600">{fmtDate(date)}</span>;
}

export default function Fleet() {
  const t = useT();
  const me = useMe();
  const canFin = can(me, "viewFinance");
  const [showAll, setShowAll] = useState(false);
  const { data: vehicles = [], isLoading } = useQuery<FleetVehicle[]>({ queryKey: ["fleet-vehicles"], queryFn: () => get("/fleet/vehicles?all=1") });
  const { data: alerts = [] } = useQuery<FleetAlert[]>({ queryKey: ["fleet-alerts"], queryFn: () => get("/fleet/alerts") });
  const [editing, setEditing] = useState<FleetVehicle | null>(null);

  const shown = useMemo(
    () => vehicles.filter(v => showAll || (v.isActive && v.status === "active")),
    [vehicles, showAll],
  );
  const activeCount = vehicles.filter(v => v.isActive && v.status === "active").length;

  if (isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t("Автопарк")} subtitle={`${activeCount} ${t("активних авто")}`}
        action={
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-500">
            <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} className="accent-red-600" />
            {t("показати продані/списані")}
          </label>
        } />

      {alerts.length > 0 && (
        <Card className="mb-4 border-amber-300 bg-amber-50 p-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-800">
            <ShieldAlert className="h-4 w-4" /> {t("Документи потребують уваги")}
          </div>
          <ul className="space-y-0.5 text-sm text-amber-800">
            {alerts.map(a => (
              <li key={a.id}>
                🚙 {a.brandModel} <span className="font-mono">{a.plate}</span>{a.city ? ` (${a.city})` : ""}:{" "}
                {a.insuranceExpired && <>{t("страховка збігла")} {fmtDate(a.insuranceUntil)}. </>}
                {a.insuranceSoon && <>{t("страховка до")} {fmtDate(a.insuranceUntil)}. </>}
                {a.inspectionExpired && <>{t("техогляд збіг")} {fmtDate(a.inspectionUntil)}. </>}
                {a.inspectionSoon && <>{t("техогляд до")} {fmtDate(a.inspectionUntil)}.</>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="overflow-x-auto">
        {!shown.length ? <Empty>{t("Немає авто")}</Empty> : (
          <table className="w-full min-w-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Номер")}</th>
                <th className="px-3 py-2.5">{t("Марка і модель")}</th>
                <th className="px-3 py-2.5">{t("Місто")}</th>
                <th className="px-3 py-2.5">{t("Фірма / власник")}</th>
                <th className="px-3 py-2.5 text-right">{t("Рік")}</th>
                <th className="px-3 py-2.5">{t("Паливо")}</th>
                <th className="px-3 py-2.5 text-right">{t("Місць")}</th>
                <th className="px-3 py-2.5">{t("Власність")}</th>
                <th className="px-3 py-2.5">{t("Страховка до")}</th>
                <th className="px-3 py-2.5">{t("Техогляд до")}</th>
                {canFin && <th className="px-3 py-2.5 text-right">{t("Вартість (купівля / лізинг)")}</th>}
                {canFin && <th className="px-3 py-2.5 text-right">{t("Оренда/міс")}</th>}
                <th className="px-3 py-2.5">{t("Статус")}</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map(v => (
                <tr key={v.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono font-medium text-slate-700">{v.plate}</td>
                  <td className="px-3 py-2 text-slate-600">{v.kind === "bus" ? "🚌 " : ""}{v.brandModel ?? "—"}{v.personal && <> <Badge color="slate">{t("особисте")}</Badge></>}</td>
                  <td className="px-3 py-2 text-slate-500">{v.city ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{v.companyName ?? v.ownerName ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{v.year ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{v.fuel ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{v.seats ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{v.ownership ? (OWNERSHIP_LABEL[v.ownership] ?? v.ownership) : "—"}</td>
                  <td className="px-3 py-2">
                    {v.insuranceUntil == null && v.ownership === "leasing"
                      ? <Badge color="blue">leasing</Badge>
                      : <DateBadge date={v.insuranceUntil} t={t} />}
                  </td>
                  <td className="px-3 py-2"><DateBadge date={v.inspectionUntil} t={t} /></td>
                  {canFin && (
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {v.personal ? "—"
                        : v.purchasePrice != null ? fmtPln(v.purchasePrice)
                        : v.leaseLessor ? <>{fmtPln((v.leaseInitialPaid ?? 0) + (v.leasePaid ?? 0))} <span className="text-xs text-slate-400">{t("лізинг")}</span></>
                        : "—"}
                    </td>
                  )}
                  {canFin && <td className="px-3 py-2 text-right tabular-nums text-slate-600">{v.rentMonthly != null ? fmtPln(v.rentMonthly) : "—"}</td>}
                  <td className="px-3 py-2">
                    {v.status === "active" && v.isActive ? <Badge color="green">{t("активне")}</Badge>
                      : v.status === "sold" ? <Badge color="slate">{t("продане")}</Badge>
                      : v.status === "scrapped" ? <Badge color="slate">{t("утиль")}</Badge>
                      : <Badge color="slate">{t("неактивне")}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setEditing(v)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title={t("Редагувати")}><Pencil className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
              {canFin && (
                <tr className="bg-slate-50 font-semibold">
                  <td className="px-3 py-2 text-slate-700" colSpan={10}>{t("Разом вартість авто (купівля + виплачений лізинг, без особистих)")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                    {fmtPln(shown.filter(v => !v.personal).reduce((s2, v) =>
                      s2 + (v.purchasePrice ?? 0) + (v.leaseLessor ? (v.leaseInitialPaid ?? 0) + (v.leasePaid ?? 0) : 0), 0))}
                  </td>
                  <td className="px-3 py-2" colSpan={3}></td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>

      {canFin && <LeaseSection vehicles={vehicles} />}

      <ExpensesSection canFin={canFin} vehicles={vehicles} />

      {editing && <FleetVehicleModal vehicle={editing} canFin={canFin} onClose={() => setEditing(null)} />}
    </>
  );
}

// ─── Лізинг: умови договору + привʼязані фактури (виплачено/залишок) ─────────
function LeaseSection({ vehicles }: { vehicles: FleetVehicle[] }) {
  const t = useT();
  const qc = useQueryClient();
  const leased = vehicles.filter(v => v.ownership === "leasing" || v.leaseTotal != null || (v.leaseInvoiceCount ?? 0) > 0);
  const attach = useMutation({
    mutationFn: () => post<{ attached: number }>("/fleet/lease-attach", {}),
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ["fleet-vehicles"] }); toast.success(t("Привʼязано фактур: {n}", { n: d.attached })); },
    onError: (e: any) => toast.error(e.message),
  });
  if (!leased.length) return null;
  return (
    <>
      <div className="mt-8 mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <CarFront className="h-4 w-4 text-red-600" /> {t("Лізинг")}
          <span className="font-normal text-slate-400">{t("фактури лізингодавця падають на авто за правилом «лізингодавець + № договору»")}</span>
        </h3>
        <Button variant="secondary" loading={attach.isPending} onClick={() => attach.mutate()}>{t("Підтягнути фактури")}</Button>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-160 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2.5">{t("Авто")}</th>
              <th className="px-3 py-2.5">{t("Лізингодавець")}</th>
              <th className="px-3 py-2.5">{t("№ договору")}</th>
              <th className="px-3 py-2.5 text-right">{t("Вартість договору")}</th>
              <th className="px-3 py-2.5 text-right">{t("Фактур")}</th>
              <th className="px-3 py-2.5 text-right">{t("Виставлено")}</th>
              <th className="px-3 py-2.5 text-right">{t("Оплачено")}</th>
              <th className="px-3 py-2.5 text-right">{t("Залишок")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {leased.map(v => {
              const paidAll = Math.round(((v.leaseInitialPaid ?? 0) + (v.leasePaid ?? 0)) * 100) / 100;
              const remaining = v.leaseTotal != null ? Math.round((v.leaseTotal - paidAll) * 100) / 100 : null;
              return (
                <tr key={v.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-700">{v.brandModel ?? ""} <span className="font-mono">{v.plate}</span></td>
                  <td className="px-3 py-2 text-slate-600">{v.leaseLessor ?? <span className="text-amber-600">{t("вкажи в картці авто")}</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{v.leaseContractNo ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{v.leaseTotal != null ? fmtPln(v.leaseTotal) : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{v.leaseInvoiceCount ?? 0}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtPln(v.leaseInvoiced ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-green-700">{fmtPln(paidAll)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{remaining != null ? fmtPln(remaining) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function FleetVehicleModal({ vehicle, canFin, onClose }: { vehicle: FleetVehicle; canFin: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const [f, setF] = useState({
    plate: vehicle.plate, brandModel: vehicle.brandModel ?? "", seats: vehicle.seats != null ? String(vehicle.seats) : "",
    kind: vehicle.kind ?? "", city: vehicle.city ?? "", companyId: vehicle.companyId != null ? String(vehicle.companyId) : "",
    ownerName: vehicle.ownerName ?? "", fuel: vehicle.fuel ?? "", year: vehicle.year != null ? String(vehicle.year) : "",
    vin: vehicle.vin ?? "", ownership: vehicle.ownership ?? "", insuranceUntil: vehicle.insuranceUntil ?? "",
    inspectionUntil: vehicle.inspectionUntil ?? "", purchasedAt: vehicle.purchasedAt ?? "", soldAt: vehicle.soldAt ?? "",
    status: vehicle.status, personal: vehicle.personal, notes: vehicle.notes ?? "",
    rentMonthly: vehicle.rentMonthly != null ? String(vehicle.rentMonthly) : "",
    leaseTotal: vehicle.leaseTotal != null ? String(vehicle.leaseTotal) : "",
    leaseLessor: vehicle.leaseLessor ?? "", leaseContractNo: vehicle.leaseContractNo ?? "",
    purchasePrice: vehicle.purchasePrice != null ? String(vehicle.purchasePrice) : "",
    marketPrice: vehicle.marketPrice != null ? String(vehicle.marketPrice) : "",
  });
  const set = (k: keyof typeof f) => (e: any) => setF(s => ({ ...s, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        plate: f.plate, brandModel: f.brandModel, seats: f.seats.trim() ? Number(f.seats) : null,
        kind: f.kind, city: f.city, companyId: f.companyId ? Number(f.companyId) : null,
        ownerName: f.ownerName, fuel: f.fuel, year: f.year.trim() ? Number(f.year) : null,
        vin: f.vin, ownership: f.ownership, status: f.status, personal: f.personal, notes: f.notes,
        insuranceUntil: f.insuranceUntil || null, inspectionUntil: f.inspectionUntil || null,
        purchasedAt: f.purchasedAt || null, soldAt: f.soldAt || null,
      };
      if (canFin) {
        body.rentMonthly = f.rentMonthly.trim() ? Number(f.rentMonthly) : null;
        body.purchasePrice = f.purchasePrice.trim() ? Number(f.purchasePrice) : null;
        body.marketPrice = f.marketPrice.trim() ? Number(f.marketPrice) : null;
        body.leaseTotal = f.leaseTotal.trim() ? Number(f.leaseTotal) : null;
        body.leaseLessor = f.leaseLessor;
        body.leaseContractNo = f.leaseContractNo;
      }
      return patch(`/fleet/vehicles/${vehicle.id}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fleet-vehicles"] });
      qc.invalidateQueries({ queryKey: ["fleet-alerts"] });
      qc.invalidateQueries({ queryKey: ["vehicles"] });
      toast.success(t("Збережено")); onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const equipmentList = Object.entries(vehicle.equipment ?? {}).filter(([, v]) => v);

  return (
    <Modal open onClose={onClose} title={`${t("Картка авто")} — ${vehicle.plate}`} size="lg">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div><Label>{t("Номер")}</Label><Input value={f.plate} onChange={set("plate")} /></div>
        <div><Label>{t("Марка і модель")}</Label><Input value={f.brandModel} onChange={set("brandModel")} /></div>
        <div><Label>{t("Тип")}</Label>
          <Select value={f.kind} onChange={set("kind")}>
            <option value="">—</option><option value="car">{t("легкове")}</option><option value="bus">{t("автобус")}</option>
          </Select></div>
        <div><Label>{t("Місто")}</Label><Input value={f.city} onChange={set("city")} placeholder="LUBLIN" /></div>
        <div><Label>{t("Фірма")}</Label>
          <Select value={f.companyId} onChange={set("companyId")}>
            <option value="">—</option>
            {companies.map(co => <option key={co.id} value={co.id}>{co.name}</option>)}
          </Select></div>
        <div><Label>{t("Власник (якщо оренда у особи)")}</Label><Input value={f.ownerName} onChange={set("ownerName")} /></div>
        <div><Label>{t("Паливо")}</Label><Input value={f.fuel} onChange={set("fuel")} placeholder="D / B / B/G" /></div>
        <div><Label>{t("Рік")}</Label><Input type="number" value={f.year} onChange={set("year")} /></div>
        <div><Label>{t("Місць")}</Label><Input type="number" value={f.seats} onChange={set("seats")} /></div>
        <div><Label>VIN</Label><Input value={f.vin} onChange={set("vin")} /></div>
        <div><Label>{t("Власність")}</Label>
          <Select value={f.ownership} onChange={set("ownership")}>
            <option value="">—</option>
            <option value="umowa">umowa</option><option value="leasing">leasing</option>
            <option value="faktura">faktura</option><option value="private">{t("приватне")}</option>
          </Select></div>
        <div><Label>{t("Статус")}</Label>
          <Select value={f.status} onChange={set("status")}>
            <option value="active">{t("активне")}</option><option value="sold">{t("продане")}</option><option value="scrapped">{t("утиль")}</option>
          </Select></div>
        <div><Label>{t("Страховка до")}</Label><Input type="date" value={f.insuranceUntil} onChange={set("insuranceUntil")} /></div>
        <div><Label>{t("Техогляд до")}</Label><Input type="date" value={f.inspectionUntil} onChange={set("inspectionUntil")} /></div>
        <div><Label>{t("Куплене")}</Label><Input type="date" value={f.purchasedAt} onChange={set("purchasedAt")} /></div>
        <div><Label>{t("Продане")}</Label><Input type="date" value={f.soldAt} onChange={set("soldAt")} /></div>
        {canFin && <>
          <div><Label>{t("Оренда, зл/міс")}</Label><Input type="number" value={f.rentMonthly} onChange={set("rentMonthly")} /></div>
          <div><Label>{t("Ціна купівлі, зл")}</Label><Input type="number" value={f.purchasePrice} onChange={set("purchasePrice")} /></div>
          <div><Label>{t("Ринкова ціна, зл")}</Label><Input type="number" value={f.marketPrice} onChange={set("marketPrice")} /></div>
          <div><Label>{t("Лізингодавець")}</Label><Input value={f.leaseLessor} onChange={set("leaseLessor")} placeholder="PKO Leasing" /></div>
          <div><Label>{t("№ договору лізингу")}</Label><Input value={f.leaseContractNo} onChange={set("leaseContractNo")} /></div>
          <div><Label>{t("Вартість договору, зл")}</Label><Input type="number" value={f.leaseTotal} onChange={set("leaseTotal")} /></div>
        </>}
        <div className="flex items-end pb-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={f.personal} onChange={(e) => setF(st => ({ ...st, personal: e.target.checked }))} className="accent-red-600" /> {t("особисте авто")}
          </label>
        </div>
        <div className="col-span-2 sm:col-span-3"><Label>{t("Нотатки")}</Label><Input value={f.notes} onChange={set("notes")} /></div>
      </div>
      {equipmentList.length > 0 && (
        <div className="mt-3 text-xs text-slate-500">
          {t("Інвентар")}: {equipmentList.map(([k, v]) => `${k}: ${v}`).join(" · ")}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
        <Button loading={save.isPending} onClick={() => f.plate.trim() && save.mutate()}>{t("Зберегти")}</Button>
      </div>
    </Modal>
  );
}

// ─── Ремонти (vehicle_expenses) ──────────────────────────────────────────────

const MONTH_SHORT = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];

function ExpensesSection({ canFin, vehicles }: { canFin: boolean; vehicles: FleetVehicle[] }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const { data: summary } = useQuery<Summary>({ queryKey: ["fleet-summary", year], queryFn: () => get(`/fleet/summary?year=${year}`) });
  const { data: exp } = useQuery<{ years: string[]; rows: Expense[] }>({ queryKey: ["fleet-expenses", year], queryFn: () => get(`/fleet/expenses?year=${year}`) });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [showList, setShowList] = useState(false);
  const inv = () => { qc.invalidateQueries({ queryKey: ["fleet-summary"] }); qc.invalidateQueries({ queryKey: ["fleet-expenses"] }); };
  const remove = useMutation({ mutationFn: (id: number) => del(`/fleet/expenses/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });

  const years = exp?.years?.length ? exp.years : [String(new Date().getFullYear())];
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

  return (
    <>
      <div className="mt-8 mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Wrench className="h-4 w-4 text-red-600" /> {t("Ремонти та витрати на авто")}
          {summary && <span className="font-normal text-slate-400">{t("за рік")}: {fmtPln(summary.grandTotal)} зл</span>}
        </h3>
        <div className="flex items-center gap-2">
          <Select value={year} onChange={e => setYear(e.target.value)} className="w-24">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </Select>
          <Button variant="secondary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати витрату")}</Button>
        </div>
      </div>

      <Card className="overflow-x-auto">
        {!summary?.vehicles.length ? <Empty>{t("Немає витрат за цей рік")}</Empty> : (
          <table className="w-full min-w-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Авто")}</th>
                {MONTH_SHORT.map(m => <th key={m} className="px-2 py-2.5 text-right">{t(m)}</th>)}
                <th className="px-3 py-2.5 text-right">{t("Разом")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.vehicles.map(v => (
                <tr key={v.vehicleId ?? v.label} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-700">{v.label}</td>
                  {months.map(m => (
                    <td key={m} className="px-2 py-2 text-right tabular-nums text-slate-500">
                      {v.months[m] ? fmtPln(v.months[m]!) : ""}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-700">{fmtPln(v.total)}</td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-semibold">
                <td className="px-3 py-2 text-slate-700">{t("Разом")}</td>
                {months.map(m => {
                  const s = summary.vehicles.reduce((acc, v) => acc + (v.months[m] ?? 0), 0);
                  return <td key={m} className="px-2 py-2 text-right tabular-nums text-slate-700">{s ? fmtPln(s) : ""}</td>;
                })}
                <td className="px-3 py-2 text-right tabular-nums text-slate-800">{fmtPln(summary.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Card>

      <button onClick={() => setShowList(s => !s)} className="mt-3 text-sm text-red-600 hover:underline">
        {showList ? t("Сховати список витрат") : t("Показати список витрат")} ({exp?.rows.length ?? 0})
      </button>
      {showList && (
        <Card className="mt-2 overflow-x-auto">
          <table className="w-full min-w-150 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Місяць")}</th><th className="px-3 py-2.5">{t("Авто")}</th>
                <th className="px-3 py-2.5 text-right">{t("Сума")}</th><th className="px-3 py-2.5">{t("Тип")}</th>
                <th className="px-3 py-2.5">{t("Сервіс")}</th><th className="px-3 py-2.5">{t("Фактура")}</th>
                <th className="px-3 py-2.5">{t("Нотатка")}</th><th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(exp?.rows ?? []).map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 tabular-nums text-slate-500">{r.month}</td>
                  <td className="px-3 py-2 text-slate-700">{r.plate ? `${r.brandModel ?? ""} ${r.plate}` : (r.vehicleLabel ?? "—")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtPln(r.amount)}</td>
                  <td className="px-3 py-2 text-slate-500">{r.kind === "repair" ? t("ремонт") : r.kind === "tire" ? t("шини") : t("інше")}</td>
                  <td className="px-3 py-2 text-slate-500">{r.service ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{r.invoiceNo ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{r.note ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setEditing(r)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Pencil className="h-4 w-4" /></button>
                      <button onClick={async () => { if (await confirm({ title: t("Видалити витрату?"), danger: true, confirmText: t("Видалити") })) remove.mutate(r.id); }}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {canFin && (summary?.invoices.length ?? 0) > 0 && (
        <>
          <div className="mt-6 mb-2 text-sm font-semibold text-slate-700">
            {t("Фактури автосервісів (довідково)")} <span className="font-normal text-slate-400">{fmtPln(summary!.invoicesTotal)} зл</span>
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-100 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr><th className="px-3 py-2.5">{t("Місяць")}</th><th className="px-3 py-2.5">{t("Номер фактури")}</th><th className="px-3 py-2.5">{t("Сервіс")}</th><th className="px-3 py-2.5 text-right">{t("Сума")}</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summary!.invoices.map(i => (
                  <tr key={i.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 tabular-nums text-slate-500">{i.month}</td>
                    <td className="px-3 py-2 font-mono text-slate-700">{i.invoiceNo}</td>
                    <td className="px-3 py-2 text-slate-500">{i.service ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtPln(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {(adding || editing) && (
        <ExpenseModal expense={editing ?? undefined} vehicles={vehicles} defaultYear={year}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { inv(); setAdding(false); setEditing(null); }} />
      )}
    </>
  );
}

function ExpenseModal({ expense, vehicles, defaultYear, onClose, onSaved }: {
  expense?: Expense; vehicles: FleetVehicle[]; defaultYear: string; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const isEdit = !!expense;
  const [f, setF] = useState({
    vehicleId: expense?.vehicleId != null ? String(expense.vehicleId) : "",
    vehicleLabel: expense?.vehicleLabel ?? "",
    month: expense?.month ?? `${defaultYear}-${String(new Date().getMonth() + 1).padStart(2, "0")}`,
    amount: expense != null ? String(expense.amount) : "",
    kind: expense?.kind ?? "repair",
    service: expense?.service ?? "", invoiceNo: expense?.invoiceNo ?? "", note: expense?.note ?? "",
  });
  const set = (k: keyof typeof f) => (e: any) => setF(s => ({ ...s, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        vehicleId: f.vehicleId ? Number(f.vehicleId) : null, vehicleLabel: f.vehicleLabel,
        month: f.month.slice(0, 7), amount: Number(f.amount), kind: f.kind,
        service: f.service, invoiceNo: f.invoiceNo, note: f.note,
      };
      return isEdit ? patch(`/fleet/expenses/${expense!.id}`, body) : post("/fleet/expenses", body);
    },
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={isEdit ? t("Редагувати витрату") : t("Нова витрата на авто")}>
      <div className="space-y-3">
        <div><Label>{t("Авто")}</Label>
          <Select value={f.vehicleId} onChange={set("vehicleId")}>
            <option value="">{t("— інше (впишіть підпис) —")}</option>
            {vehicles.map(v => <option key={v.id} value={v.id}>{v.brandModel ?? ""} {v.plate}</option>)}
          </Select></div>
        {!f.vehicleId && <div><Label>{t("Підпис (якщо авто нема в списку)")}</Label><Input value={f.vehicleLabel} onChange={set("vehicleLabel")} /></div>}
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Місяць")}</Label><Input type="month" value={f.month} onChange={set("month")} /></div>
          <div><Label>{t("Сума, зл")}</Label><Input type="number" value={f.amount} onChange={set("amount")} autoFocus={!isEdit} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Тип")}</Label>
            <Select value={f.kind} onChange={set("kind")}>
              <option value="repair">{t("ремонт")}</option><option value="tire">{t("шини")}</option><option value="other">{t("інше")}</option>
            </Select></div>
          <div><Label>{t("Сервіс")}</Label><Input value={f.service} onChange={set("service")} placeholder="Techno House" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Номер фактури")}</Label><Input value={f.invoiceNo} onChange={set("invoiceNo")} /></div>
          <div><Label>{t("Нотатка")}</Label><Input value={f.note} onChange={set("note")} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => Number(f.amount) > 0 && save.mutate()}>{isEdit ? t("Зберегти") : t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

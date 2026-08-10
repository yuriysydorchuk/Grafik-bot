// Транспортні гроші: виплати водіям за виїзди (журнал 2022–2026 або авторозрахунок
// з призначень × ставки), архівний журнал поїздок, зняття з ЗП за довіз, ставки.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Bus } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del, put } from "../lib/api";
import { Button, Input, Label, Card, Spinner, Badge, Modal, Empty, Select } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";

const fmtPln = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const curMonth = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" }).slice(0, 7);

type PayRow = { driverId: number | null; driverName: string | null; factoryLabel: string; trips: number; km: number | null; pay: number; noRate?: boolean };
type TripRow = {
  id: number; tripDate: string; factoryLabel: string; shiftTime: string | null; driverName: string | null;
  vehiclePlate: string | null; odoFrom: number | null; odoTo: number | null; km: number | null;
  people: number | null; payAmount: number | null; note: string | null;
};
type DeductionRow = { id: number; workerId: number | null; workerName: string | null; factoryLabel: string | null; tripsCount: number | null; amount: number; note: string | null };
type RatesData = { drivers: { id: number; name: string; tripRate: number | null }[]; overrides: { id: number; driverId: number; factoryId: number; factoryName: string | null; rate: number }[] };

export default function Transport() {
  const t = useT();
  const [tab, setTab] = useState<"pay" | "log" | "deductions" | "rates">("pay");
  const TABS: [typeof tab, string][] = [
    ["pay", t("Виплати водіям")], ["log", t("Журнал поїздок")], ["deductions", t("Зняття за довіз")], ["rates", t("Ставки")],
  ];
  return (
    <>
      <PageHeader title={t("Транспорт")} subtitle={t("виїзди, оплати водіям і зняття за довіз")} />
      <div className="mb-4 flex gap-1 rounded-xl bg-slate-100 p-1 text-sm font-medium w-fit">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 ${tab === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "pay" && <PayTab />}
      {tab === "log" && <LogTab />}
      {tab === "deductions" && <DeductionsTab />}
      {tab === "rates" && <RatesTab />}
    </>
  );
}

function MonthPicker({ month, months, onChange }: { month: string; months: string[]; onChange: (m: string) => void }) {
  const all = useMemo(() => [...new Set([month, ...months])].sort().reverse(), [month, months]);
  return (
    <Select value={month} onChange={(e) => onChange(e.target.value)} className="w-36">
      {all.map((m) => <option key={m} value={m}>{m}</option>)}
    </Select>
  );
}

function PayTab() {
  const t = useT();
  const [month, setMonth] = useState(curMonth());
  const { data: log } = useQuery<{ months: string[] }>({ queryKey: ["trip-log-months"], queryFn: () => get(`/transport/trip-log?month=${curMonth()}`) });
  const { data, isLoading } = useQuery<{ source: string; rows: PayRow[] }>({ queryKey: ["driver-pay", month], queryFn: () => get(`/transport/driver-pay?month=${month}`) });

  const byDriver = useMemo(() => {
    const m = new Map<string, { name: string; rows: PayRow[]; trips: number; km: number; pay: number }>();
    for (const r of data?.rows ?? []) {
      const key = r.driverName ?? "—";
      const cur = m.get(key) ?? { name: key, rows: [], trips: 0, km: 0, pay: 0 };
      cur.rows.push(r); cur.trips += r.trips; cur.km += r.km ?? 0; cur.pay = Math.round((cur.pay + r.pay) * 100) / 100;
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.pay - a.pay);
  }, [data]);
  const total = byDriver.reduce((s, d) => s + d.pay, 0);

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <MonthPicker month={month} months={log?.months ?? []} onChange={setMonth} />
        {data && (
          <Badge color={data.source === "log" ? "blue" : "amber"}>
            {data.source === "log" ? t("з журналу поїздок") : t("розраховано з призначень × ставки")}
          </Badge>
        )}
        <span className="text-sm text-slate-500">{t("Разом")}: <b>{fmtPln(total)} зл</b></span>
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? <Spinner /> : !byDriver.length ? <Empty>{t("Немає даних за цей місяць")}</Empty> : (
          <table className="w-full min-w-150 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Водій")}</th><th className="px-3 py-2.5">{t("Фабрика")}</th>
                <th className="px-3 py-2.5 text-right">{t("Виїздів")}</th><th className="px-3 py-2.5 text-right">{t("Км")}</th>
                <th className="px-3 py-2.5 text-right">{t("До виплати")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byDriver.map((d) => (
                <>
                  {d.rows.map((r, i) => (
                    <tr key={`${d.name}-${r.factoryLabel}`} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium text-slate-700">{i === 0 ? d.name : ""}</td>
                      <td className="px-3 py-2 text-slate-500">{r.factoryLabel}{r.noRate && <span title={t("не всі виїзди мають ставку")}> ⚠️</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.trips}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.km ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtPln(r.pay)}</td>
                    </tr>
                  ))}
                  <tr key={`${d.name}-total`} className="bg-slate-50/60 font-semibold">
                    <td className="px-3 py-1.5 text-slate-700">{d.name}</td><td className="px-3 py-1.5"></td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{d.trips}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{d.km || "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-800">{fmtPln(d.pay)}</td>
                  </tr>
                </>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function LogTab() {
  const t = useT();
  const [month, setMonth] = useState(curMonth());
  const [factory, setFactory] = useState("");
  const { data, isLoading } = useQuery<{ months: string[]; factories: string[]; rows: TripRow[] }>({
    queryKey: ["trip-log", month, factory],
    queryFn: () => get(`/transport/trip-log?month=${month}${factory ? `&factory=${encodeURIComponent(factory)}` : ""}`),
  });
  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <MonthPicker month={month} months={data?.months ?? []} onChange={setMonth} />
        <Select value={factory} onChange={(e) => setFactory(e.target.value)} className="w-48">
          <option value="">{t("Усі фабрики")}</option>
          {(data?.factories ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
        </Select>
        <span className="text-sm text-slate-500">{data?.rows.length ?? 0} {t("поїздок")}</span>
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? <Spinner /> : !data?.rows.length ? <Empty>{t("Немає поїздок за цей місяць")}</Empty> : (
          <table className="w-full min-w-180 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Дата")}</th><th className="px-3 py-2.5">{t("Фабрика")}</th>
                <th className="px-3 py-2.5">{t("Зміна")}</th><th className="px-3 py-2.5">{t("Водій")}</th>
                <th className="px-3 py-2.5">{t("Авто")}</th><th className="px-3 py-2.5 text-right">{t("Одометр")}</th>
                <th className="px-3 py-2.5 text-right">{t("Км")}</th><th className="px-3 py-2.5 text-right">{t("Людей")}</th>
                <th className="px-3 py-2.5 text-right">{t("Оплата")}</th><th className="px-3 py-2.5">{t("Нотатка")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 tabular-nums text-slate-600">{r.tripDate.slice(8)}.{r.tripDate.slice(5, 7)}</td>
                  <td className="px-3 py-2 text-slate-500">{r.factoryLabel}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{r.shiftTime ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-700">{r.driverName ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.vehiclePlate ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-400">{r.odoFrom != null ? `${r.odoFrom}→${r.odoTo ?? "?"}` : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{r.km ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.people ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{r.payAmount != null ? fmtPln(r.payAmount) : "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function DeductionsTab() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [month, setMonth] = useState(curMonth());
  const { data, isLoading } = useQuery<{ months: string[]; rows: DeductionRow[] }>({
    queryKey: ["transport-deductions", month],
    queryFn: () => get(`/transport/deductions?month=${month}`),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<DeductionRow | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["transport-deductions"] });
  const remove = useMutation({ mutationFn: (id: number) => del(`/transport/deductions/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  const total = (data?.rows ?? []).reduce((s, r) => s + r.amount, 0);

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <MonthPicker month={month} months={data?.months ?? []} onChange={setMonth} />
        <span className="text-sm text-slate-500">{t("Разом")}: <b>{fmtPln(total)} зл</b></span>
        <Button variant="secondary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати")}</Button>
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? <Spinner /> : !data?.rows.length ? <Empty>{t("Немає знять за цей місяць")}</Empty> : (
          <table className="w-full min-w-120 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Працівник")}</th><th className="px-3 py-2.5">{t("Фабрика")}</th>
                <th className="px-3 py-2.5 text-right">{t("Виїздів")}</th><th className="px-3 py-2.5 text-right">{t("Сума")}</th>
                <th className="px-3 py-2.5">{t("Нотатка")}</th><th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-700">{r.workerName ?? "—"}{r.workerId == null && <Badge color="amber">{t("не привʼязано")}</Badge>}</td>
                  <td className="px-3 py-2 text-slate-500">{r.factoryLabel ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.tripsCount ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtPln(r.amount)}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{r.note ?? ""}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setEditing(r)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Pencil className="h-4 w-4" /></button>
                      <button onClick={async () => { if (await confirm({ title: t("Видалити зняття?"), danger: true, confirmText: t("Видалити") })) remove.mutate(r.id); }}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {(adding || editing) && <DeductionModal deduction={editing ?? undefined} month={month} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => { inv(); setAdding(false); setEditing(null); }} />}
    </>
  );
}

function DeductionModal({ deduction, month, onClose, onSaved }: { deduction?: DeductionRow; month: string; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const isEdit = !!deduction;
  const { data: workers = [] } = useQuery<{ id: number; fullName: string }[]>({ queryKey: ["workers-light"], queryFn: () => get("/workers") });
  const [workerId, setWorkerId] = useState(deduction?.workerId != null ? String(deduction.workerId) : "");
  const [amount, setAmount] = useState(deduction != null ? String(deduction.amount) : "");
  const [tripsCount, setTripsCount] = useState(deduction?.tripsCount != null ? String(deduction.tripsCount) : "");
  const [note, setNote] = useState(deduction?.note ?? "");

  const save = useMutation({
    mutationFn: () => {
      const body = { month, workerId: Number(workerId), amount: Number(amount), tripsCount: tripsCount.trim() ? Number(tripsCount) : null, note };
      return isEdit ? patch(`/transport/deductions/${deduction!.id}`, body) : post("/transport/deductions", body);
    },
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={isEdit ? t("Редагувати зняття") : t("Нове зняття за довіз")}>
      <div className="space-y-3">
        {!isEdit && (
          <div><Label>{t("Працівник")}</Label>
            <Select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
              <option value="">—</option>
              {workers.map((w: any) => <option key={w.id} value={w.id}>{w.fullName}</option>)}
            </Select></div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Сума, зл")}</Label><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></div>
          <div><Label>{t("Виїздів")}</Label><Input type="number" value={tripsCount} onChange={(e) => setTripsCount(e.target.value)} /></div>
        </div>
        <div><Label>{t("Нотатка")}</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => (isEdit || workerId) && Number(amount) >= 0 && save.mutate()}>{isEdit ? t("Зберегти") : t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function RatesTab() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<RatesData>({ queryKey: ["transport-rates"], queryFn: () => get("/transport/rates") });
  const { data: factories = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const inv = () => qc.invalidateQueries({ queryKey: ["transport-rates"] });
  const [ovDriver, setOvDriver] = useState(""); const [ovFactory, setOvFactory] = useState(""); const [ovRate, setOvRate] = useState("");

  const setBase = useMutation({
    mutationFn: ({ id, rate }: { id: number; rate: number | null }) => put(`/transport/rates/driver/${id}`, { rate }),
    onSuccess: () => { inv(); toast.success(t("Збережено")); }, onError: (e: any) => toast.error(e.message),
  });
  const setOverride = useMutation({
    mutationFn: (body: { driverId: number; factoryId: number; rate: number | null }) => put("/transport/rates/override", body),
    onSuccess: () => { inv(); toast.success(t("Збережено")); setOvRate(""); }, onError: (e: any) => toast.error(e.message),
  });

  if (isLoading) return <Spinner />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><Bus className="h-4 w-4 text-red-600" /> {t("Базова ставка за виїзд, зл")}</div>
        <div className="space-y-2">
          {(data?.drivers ?? []).map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3">
              <span className="text-sm text-slate-600">{d.name}</span>
              <Input type="number" defaultValue={d.tripRate ?? ""} className="w-24 text-right" placeholder="—"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  const rate = v ? Number(v) : null;
                  if (rate !== d.tripRate) setBase.mutate({ id: d.id, rate });
                }} />
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-400">{t("Порожньо = виїзди не оплачуються. Зміна зберігається, коли поле втрачає фокус.")}</p>
      </Card>
      <Card className="p-4">
        <div className="mb-2 text-sm font-semibold text-slate-700">{t("Винятки: ставка для пари водій × фабрика")}</div>
        <div className="space-y-1.5">
          {(data?.overrides ?? []).map((o) => {
            const dName = data?.drivers.find((d) => d.id === o.driverId)?.name ?? `#${o.driverId}`;
            return (
              <div key={o.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-600">{dName} × {o.factoryName ?? `#${o.factoryId}`}</span>
                <span className="flex items-center gap-2 tabular-nums text-slate-700">{fmtPln(o.rate)}
                  <button onClick={() => setOverride.mutate({ driverId: o.driverId, factoryId: o.factoryId, rate: null })}
                    className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              </div>
            );
          })}
          {!data?.overrides.length && <div className="text-sm text-slate-400">{t("Винятків немає — усі за базовою ставкою")}</div>}
        </div>
        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1"><Label>{t("Водій")}</Label>
            <Select value={ovDriver} onChange={(e) => setOvDriver(e.target.value)}>
              <option value="">—</option>
              {(data?.drivers ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select></div>
          <div className="flex-1"><Label>{t("Фабрика")}</Label>
            <Select value={ovFactory} onChange={(e) => setOvFactory(e.target.value)}>
              <option value="">—</option>
              {factories.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select></div>
          <div className="w-24"><Label>{t("Ставка")}</Label><Input type="number" value={ovRate} onChange={(e) => setOvRate(e.target.value)} /></div>
          <Button variant="secondary" disabled={!ovDriver || !ovFactory || !ovRate}
            onClick={() => setOverride.mutate({ driverId: Number(ovDriver), factoryId: Number(ovFactory), rate: Number(ovRate) })}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </Card>
    </div>
  );
}

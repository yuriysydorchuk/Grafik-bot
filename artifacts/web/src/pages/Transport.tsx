// Транспортні гроші: виплати водіям за виїзди (журнал 2022–2026 або авторозрахунок
// з призначень × ставки), архівний журнал поїздок, зняття з ЗП за довіз, ставки.
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Bus, Car } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del, put } from "../lib/api";
import { Button, Input, Label, Card, Spinner, Badge, Modal, Empty, Select } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { NatFlag } from "../lib/nationality";

const fmtPln = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const curMonth = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" }).slice(0, 7);

type PayRow = { driverId: number | null; driverName: string | null; factoryLabel: string; trips: number; km: number | null; pay: number; noRate?: boolean };
type TripRow = {
  id: number; tripDate: string; factoryLabel: string; shiftTime: string | null; driverName: string | null;
  vehiclePlate: string | null; odoFrom: number | null; odoTo: number | null; km: number | null;
  people: number | null; payAmount: number | null; note: string | null;
};
type DeductionRow = {
  id: number | null; workerId: number | null; workerName: string | null; factoryId: number | null; factoryLabel: string | null;
  tripsCount: number | null; amount: number | null; note: string | null; sourceRef?: string | null; hours?: number | null;
  selfTransport?: boolean; selfTransportSince?: string | null; nationality?: string | null;
};
type RatesData = { drivers: { id: number; name: string; tripRate: number | null }[]; overrides: { id: number; driverId: number; factoryId: number; factoryName: string | null; rate: number }[] };
type FeeFactory = { factoryId: number; name: string; feePerShift: number | null; monthCap: number | null; members: { workerId: number; name: string }[] };
type FeeCandidate = { workerId: number; name: string; isActive: boolean; hasHours: boolean; member: boolean };

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
  const me = useMe();
  const canSvodni = can(me, "svodni"); // перенесення пише у сводну — потрібен її cap
  const [month, setMonth] = useState(curMonth());
  const { data, isLoading } = useQuery<{ months: string[]; rows: DeductionRow[] }>({
    queryKey: ["transport-deductions", month],
    queryFn: () => get(`/transport/deductions?month=${month}`),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<DeductionRow | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["transport-deductions"] });
  const remove = useMutation({ mutationFn: (id: number) => del(`/transport/deductions/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  const total = (data?.rows ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
  // авторозрахунок по фабриках з платним довозом (перетирає лише авто-рядки)
  const generate = useMutation({
    mutationFn: () => post<{ created: number; updated: number; deleted: number; skippedManual: number }>("/transport/deductions/generate", { month }),
    onSuccess: (d) => {
      inv();
      const parts = [`${t("створено")}: ${d.created}`, `${t("оновлено")}: ${d.updated}`];
      if (d.deleted) parts.push(`${t("знесено")}: ${d.deleted}`);
      if (d.skippedManual) parts.push(`${t("ручних не чіпано")}: ${d.skippedManual}`);
      toast.success(t("Розраховано"), { description: parts.join(", ") });
    },
    onError: (e: any) => toast.error(e.message),
  });
  const applySvodni = useMutation({
    mutationFn: (vars: { factoryId?: number | null }) =>
      post<{ updated: number; verified: number; verifyMismatches: { workerName: string; factoryLabel: string; expected: number | null; actual: number | null }[]; skippedLocked: number; unmatched: { workerName: string | null; factoryLabel: string | null; amount: number }[] }>(
        "/svodni/apply-transport-deductions", { month, ...(vars.factoryId != null ? { factoryId: vars.factoryId } : {}) }),
    onSuccess: (d) => {
      const parts = [`${t("оновлено рядків")}: ${d.updated}`, `${t("звірено")}: ${d.verified - d.verifyMismatches.length}/${d.verified} ✓`];
      if (d.skippedLocked) parts.push(`${t("пропущено затверджених")}: ${d.skippedLocked}`);
      toast.success(t("Перенесено до сводної"), { description: parts.join(", ") });
      if (d.verifyMismatches.length) {
        toast.error(`${t("Самозвірка не зійшлася")}: ${d.verifyMismatches.length}`, {
          description: d.verifyMismatches.slice(0, 6).map((v) => `${v.workerName}: ${v.expected ?? 0} ≠ ${v.actual ?? 0}`).join(", "),
          duration: 15000,
        });
      }
      if (d.unmatched.length) {
        toast.warning(`${t("Без рядка сводної")}: ${d.unmatched.length}`, {
          description: d.unmatched.slice(0, 6).map((u) => `${u.workerName ?? "—"} (${u.factoryLabel ?? "—"})`).join(", ") + (d.unmatched.length > 6 ? "…" : ""),
          duration: 12000,
        });
      }
    },
    // 409 = зняття розійшлися з поточною сводною (повний список — у повідомленні сервера)
    onError: (e: any) => toast.error(e.message, { duration: e.status === 409 ? 15000 : undefined }),
  });
  // поділ по фабриках із підсумком кожної
  const groups = useMemo(() => {
    const m = new Map<string, { factoryId: number | null; rows: DeductionRow[] }>();
    for (const r of data?.rows ?? []) {
      const k = r.factoryLabel ?? "—";
      const g = m.get(k) ?? m.set(k, { factoryId: r.factoryId, rows: [] }).get(k)!;
      g.rows.push(r);
    }
    return [...m.entries()];
  }, [data?.rows]);
  // вибірковий платний довіз: фабрики з paid_transport + списки «хто платить»
  const { data: feeConfig } = useQuery<{ factories: FeeFactory[] }>({
    queryKey: ["transport-fee-members"],
    queryFn: () => get("/transport/fee-members"),
  });
  const [membersFor, setMembersFor] = useState<FeeFactory | null>(null);
  const feeByFactoryId = useMemo(() => new Map((feeConfig?.factories ?? []).map(f => [f.factoryId, f])), [feeConfig]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <MonthPicker month={month} months={data?.months ?? []} onChange={setMonth} />
        <div className="flex items-baseline gap-2 text-sm text-slate-500">
          <span>{t("Разом")}:</span>
          <span className="text-base font-semibold tabular-nums text-slate-800">{fmtPln(total)} зл</span>
          {(data?.rows.length ?? 0) > 0 && (
            <span className="text-xs text-slate-400">{data!.rows.length} {t("людей")} · {groups.length} {t("фабрик")}</span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати")}</Button>
          <Button variant="secondary" loading={generate.isPending}
            onClick={async () => { if (await confirm({ title: t("Розрахувати зняття за довіз?"), message: t("Зміни = години сводної місяця ÷ тривалість зміни фабрики (округлення вгору), по фабриках з платним довозом; спершу заповни сводну. Рядки, правлені вручну, не чіпаються."), confirmText: t("Розрахувати") })) generate.mutate(); }}>
            🔄 {t("Розрахувати")}
          </Button>
          {canSvodni && (
            <Button loading={applySvodni.isPending}
              onClick={async () => { if (await confirm({ title: t("Перенести суми до сводної?"), message: t("Суми з цієї таблиці ляжуть у колонку Dojazd сводної місяця (затверджені вкладки пропускаються)."), confirmText: t("Перенести") })) applySvodni.mutate({}); }}>
              → {t("Перенести до сводної")}
            </Button>
          )}
        </div>
      </div>
      {(feeConfig?.factories.length ?? 0) > 0 && (
        <Card className="mb-4 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
            <Bus className="h-4 w-4 text-red-600" /> {t("Платний довіз")}
            <span className="text-xs font-normal text-slate-400">{t("хто платить — вибірково або вся фабрика")}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {feeConfig!.factories.map((f) => (
              <button key={f.factoryId} onClick={() => setMembersFor(f)}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm transition hover:border-red-300 hover:bg-red-50/40"
                title={t("Змінити, хто платить")}>
                <span className="font-medium text-slate-700">{f.name}</span>
                <span className="text-xs tabular-nums text-slate-400">
                  {f.feePerShift != null ? `${fmtPln(f.feePerShift)} ${t("зл/зміну")}` : "—"}
                  {f.monthCap != null ? ` · ${t("макс")} ${fmtPln(f.monthCap)}` : ""}
                </span>
                {f.members.length
                  ? <Badge color="blue">👥 {t("вибрані")}: {f.members.length}</Badge>
                  : <Badge>{t("уся фабрика")}</Badge>}
              </button>
            ))}
          </div>
        </Card>
      )}
      {isLoading ? <Spinner /> : !data?.rows.length ? (
        <Card>
          <Empty>
            {t("Немає знять за цей місяць")}
            <p className="mt-1 text-xs text-slate-400">{t("Натисни «🔄 Розрахувати» — зніметься з годин сводної по фабриках з платним довозом.")}</p>
          </Empty>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map(([label, { factoryId, rows }]) => (
            <Card key={label} className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Bus className="h-4 w-4 text-red-600" />
                  <span className="text-sm font-semibold text-slate-800">{label}</span>
                  <span className="text-xs text-slate-400">{rows.length} {t("людей")}</span>
                  {factoryId != null && (feeByFactoryId.get(factoryId)?.members.length ?? 0) > 0 && (
                    <span title={t("Платний довіз лише для вибраних")}>
                      <Badge color="blue">👥 {t("вибрані")}: {feeByFactoryId.get(factoryId)!.members.length}</Badge>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold tabular-nums text-slate-800">{fmtPln(rows.reduce((s, r) => s + (r.amount ?? 0), 0))} зл</span>
                  {canSvodni && factoryId != null && (
                    <Button variant="secondary" className="px-2 py-1 text-xs" loading={applySvodni.isPending}
                      onClick={async () => { if (await confirm({ title: `${t("Перенести до сводної")}: ${label}?`, message: t("Суми з цієї таблиці ляжуть у колонку Dojazd сводної місяця (затверджені вкладки пропускаються)."), confirmText: t("Перенести") })) applySvodni.mutate({ factoryId }); }}>
                      → {t("До сводної")}
                    </Button>
                  )}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-130 text-sm">
                  <thead className="text-left text-xs uppercase text-slate-400">
                    <tr className="border-b border-slate-100">
                      <th className="px-4 py-2 font-medium">{t("Працівник")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("Годин")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("Змін")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("Сума")}</th>
                      <th className="px-4 py-2 font-medium">{t("Нотатка")}</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r) => (
                      <tr key={r.id ?? `v${r.workerId}|${r.factoryId}`} className="hover:bg-slate-50">
                        <td className="px-4 py-2">
                          {r.workerId != null ? (
                            <Link href={`/workers/${r.workerId}`} className="font-medium text-slate-700 hover:text-red-600 hover:underline">{r.workerName ?? "—"}</Link>
                          ) : (
                            <span className="font-medium text-slate-700">{r.workerName ?? "—"}</span>
                          )}
                          <NatFlag value={r.nationality} className="ml-1 cursor-default align-middle" />
                          {r.selfTransport && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-sky-500"
                              title={t("Доїжджає сам") + (r.selfTransportSince ? ` · ${t("з")} ${r.selfTransportSince}` : "")}>
                              <Car className="h-3.5 w-3.5" /><span className="text-[10px] font-medium uppercase">{t("сам")}</span>
                            </span>
                          )}
                          {r.workerId == null && <span className="ml-1.5 align-middle"><Badge color="amber">{t("не привʼязано")}</Badge></span>}
                          {r.sourceRef === "auto" && <span className="ml-1.5 align-middle"><Badge>{t("авто")}</Badge></span>}
                          {r.sourceRef === "manual-edit" && <span className="ml-1.5 align-middle"><Badge color="blue">{t("правлено")}</Badge></span>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-right tabular-nums text-slate-500">
                          {r.hours != null ? <>{r.hours} <span className="text-xs text-slate-400">{t("год")}</span></> : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-700">{r.tripsCount ?? "—"}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-right font-semibold tabular-nums text-slate-800">
                          {r.amount != null ? <>{fmtPln(r.amount)} <span className="text-xs font-normal text-slate-400">зл</span></>
                            : <span className="text-xs font-normal text-slate-400">{t("не знімається")}</span>}
                        </td>
                        <td className="max-w-50 truncate px-4 py-2 text-xs text-slate-400" title={r.note ?? undefined}>{r.note ?? ""}</td>
                        <td className="px-2 py-2 text-right">
                          {r.id != null && (
                            <div className="flex justify-end gap-0.5">
                              <button onClick={() => setEditing(r)} title={t("Редагувати")}
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Pencil className="h-4 w-4" /></button>
                              <button onClick={async () => { if (await confirm({ title: t("Видалити зняття?"), danger: true, confirmText: t("Видалити") })) remove.mutate(r.id!); }}
                                title={t("Видалити")} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
      {(adding || editing) && <DeductionModal deduction={editing ?? undefined} month={month} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => { inv(); setAdding(false); setEditing(null); }} />}
      {membersFor && <FeeMembersModal factory={membersFor} month={month} onClose={() => setMembersFor(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ["transport-fee-members"] }); setMembersFor(null); }} />}
    </>
  );
}

function DeductionModal({ deduction, month, onClose, onSaved }: { deduction?: DeductionRow; month: string; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const isEdit = !!deduction;
  const { data: workers = [] } = useQuery<{ id: number; fullName: string }[]>({ queryKey: ["workers-light"], queryFn: () => get("/workers") });
  const [workerId, setWorkerId] = useState(deduction?.workerId != null ? String(deduction.workerId) : "");
  const [amount, setAmount] = useState(deduction?.amount != null ? String(deduction.amount) : "");
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

// Вибірковий платний довіз: чекбокс-список «хто платить» на фабриці.
// Нікого не вибрано = платить уся фабрика (поведінка за замовчуванням).
function FeeMembersModal({ factory, month, onClose, onSaved }: { factory: FeeFactory; month: string; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { data, isLoading } = useQuery<{ candidates: FeeCandidate[] }>({
    queryKey: ["transport-fee-candidates", factory.factoryId, month],
    queryFn: () => get(`/transport/fee-members/candidates?factoryId=${factory.factoryId}&month=${month}`),
  });
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [q, setQ] = useState("");
  // початковий стан — з сервера (member); ініціалізується після завантаження
  const sel = selected ?? new Set((data?.candidates ?? []).filter(c => c.member).map(c => c.workerId));
  const toggle = (id: number) => {
    const n = new Set(sel);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  };
  const list = (data?.candidates ?? []).filter(c => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()));
  const save = useMutation({
    mutationFn: () => put("/transport/fee-members", { factoryId: factory.factoryId, workerIds: [...sel] }),
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={`${t("Хто платить за довіз")} — ${factory.name}`}>
      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          {t("Вибрані платять за довіз при авторозрахунку знять; нікого не вибрано — платить уся фабрика.")}
          {factory.feePerShift != null && <> {fmtPln(factory.feePerShift)} {t("зл/зміну")}{factory.monthCap != null ? `, ${t("макс")} ${fmtPln(factory.monthCap)} ${t("зл/міс")}` : ""}.</>}
        </p>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Пошук…")} autoFocus />
        {isLoading ? <Spinner /> : (
          <div className="max-h-80 space-y-0.5 overflow-y-auto rounded-lg border border-slate-200 p-1.5">
            {list.map((c) => (
              <label key={c.workerId} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-slate-50">
                <input type="checkbox" checked={sel.has(c.workerId)} onChange={() => toggle(c.workerId)} />
                <span className={`min-w-0 flex-1 truncate ${c.isActive ? "text-slate-700" : "text-slate-400 line-through"}`}>{c.name}</span>
                {c.hasHours && <span className="text-[10px] font-medium text-emerald-600" title={t("має години сводної цього місяця")}>{t("год")} ✓</span>}
                {!c.isActive && <Badge color="amber">{t("звільнений")}</Badge>}
              </label>
            ))}
            {!list.length && <div className="px-2 py-3 text-center text-sm text-slate-400">{t("Нікого не знайдено")}</div>}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-slate-400">
            {sel.size ? `${t("вибрані")}: ${sel.size}` : t("уся фабрика")}
            {sel.size > 0 && <button onClick={() => setSelected(new Set())} className="ml-2 text-red-600 hover:underline">{t("зняти всіх")}</button>}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
          </div>
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

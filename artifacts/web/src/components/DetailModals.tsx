import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Trash2, Plus, X } from "lucide-react";
import { get, post, patch, DAY_UK, SHIFT_UK, type DayCode, type ShiftCode, type Factory } from "../lib/api";
import { Modal, Spinner, Empty, Badge, Button, Input, Select } from "./ui";
import { useT, type TFn } from "../lib/i18n";

const fmtDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
const fmtTime = (t: string | null) => t ? new Date(t).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "—";
const round = (n: number) => Math.round(n * 100) / 100;

interface WorkerDay { entryId: number; date: string; day: DayCode; factory: string | null; factoryId: number | null; shift: ShiftCode; status: string; reason: string | null; computedHours: number; hoursOverride: number | null; hours: number; pickedUpBy: string | null }
interface DisputeItem { kind: "wrong" | "remove" | "add"; entryId?: number; date?: string; shift?: string; factoryId?: number | null; factoryName?: string | null; hours?: number; applied?: boolean }
interface DisputeRef { id: number; message: string | null; items: DisputeItem[]; hasPhoto: boolean; createdAt: string }
interface WorkerDays { workerId: number; name: string; code: string | null; workerFactoryId: number | null; days: WorkerDay[]; disputes: DisputeRef[] }

const statusChip = (d: WorkerDay, t: TFn) =>
  d.status === "present" ? <Badge color="green">🟢 {t("присутній")}</Badge>
  : d.status === "absent" ? (d.reason ? <Badge color="amber">🟡 {t("скасовано")}</Badge> : <Badge color="rose">🔴 {t("не вийшов")}</Badge>)
  : <Badge color="slate">{t("заплановано")}</Badge>;

const itemLabel = (it: DisputeItem, t: TFn) => {
  const head = it.kind === "add" ? t("➕ Додати") : it.kind === "remove" ? t("🗑 Прибрати") : t("✏️ Години");
  const tail = it.kind === "wrong" && it.hours != null ? ` → ${it.hours} ${t("год")}` : "";
  return `${head}: ${it.date ? fmtDate(it.date) : ""} · ${it.shift ?? "?"} ${t("зм")}${it.factoryName ? ` · ${it.factoryName}` : ""}${tail}`;
};

export function WorkerDaysModal({ workerId, name, month, monthLabel, onClose }: { workerId: number; name: string; month: string; monthLabel: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<WorkerDays>({ queryKey: ["worker-days", workerId, month], queryFn: () => get(`/worker-days/${workerId}?month=${month}`) });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const inv = () => { qc.invalidateQueries({ queryKey: ["worker-days", workerId, month] }); qc.invalidateQueries({ queryKey: ["hours", month] }); qc.invalidateQueries({ queryKey: ["hours-reports"] }); };

  const editEntry = useMutation({
    mutationFn: (v: { id: number; hoursOverride?: number | null; status?: string }) => patch(`/worker-days/entry/${v.id}`, v),
    onSuccess: () => inv(), onError: (e: any) => toast.error(e.message),
  });
  const addShift = useMutation({
    mutationFn: (v: { date: string; factoryId: number; shift: string }) => post(`/worker-days/${workerId}/add-shift`, v),
    onSuccess: () => { inv(); toast.success(t("Зміну додано")); }, onError: (e: any) => toast.error(e.message),
  });
  const applyItem = useMutation({
    mutationFn: (v: { disputeId: number; index: number }) => post(`/hours-reports/${v.disputeId}/apply`, { index: v.index }),
    onSuccess: () => { inv(); toast.success(t("Правку застосовано")); }, onError: (e: any) => toast.error(e.message),
  });
  const resolveDispute = useMutation({
    mutationFn: (id: number) => post(`/hours-reports/${id}/resolve`, { resolved: true }),
    onSuccess: () => { inv(); toast.success(t("Скаргу опрацьовано")); }, onError: (e: any) => toast.error(e.message),
  });

  const days = data?.days ?? [];
  const disputes = data?.disputes ?? [];
  const totalHours = round(days.reduce((s, d) => s + d.hours, 0));
  const present = days.filter(d => d.status === "present").length;
  const absent = days.filter(d => d.status === "absent" && !d.reason).length;
  const defFactory = data?.workerFactoryId ?? days.find(d => d.factoryId)?.factoryId ?? null;

  return (
    <Modal open onClose={onClose} title={`${name} — ${monthLabel}`} size="lg">
      {isLoading ? <Spinner /> : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge color="green">{t("Відпрацьовано:")} {present}</Badge>
            <Badge color="green">{t("Години:")} {totalHours}</Badge>
            {absent > 0 && <Badge color="rose">{t("Невиходи:")} {absent}</Badge>}
          </div>

          {disputes.length > 0 && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
              <div className="mb-2 text-sm font-semibold text-amber-700">{t("Правки від працівника")}</div>
              {disputes.map(d => (
                <div key={d.id} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    {d.message ? <p className="text-sm text-slate-600">💬 {d.message}</p> : <span />}
                    <button onClick={() => resolveDispute.mutate(d.id)} disabled={resolveDispute.isPending} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-white hover:text-emerald-600 disabled:opacity-50"><Check className="h-3.5 w-3.5" /> {t("Опрацьовано")}</button>
                  </div>
                  {d.items.map((it, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-sm">
                      <span className="text-slate-700">{itemLabel(it, t)}</span>
                      {it.applied
                        ? <Badge color="green">{t("застосовано")}</Badge>
                        : (it.kind === "wrong" && it.hours == null)
                          ? <span className="text-xs text-slate-400">{t("виправте години нижче")}</span>
                          : <button onClick={() => applyItem.mutate({ disputeId: d.id, index: i })} disabled={applyItem.isPending} className="flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"><Check className="h-3.5 w-3.5" /> {t("Затвердити")}</button>}
                    </div>
                  ))}
                </div>
              ))}
              <p className="mt-2 text-xs text-amber-600/80">{t("«Затвердити» застосує правку (додасть/прибере зміну або виставить запропоновані години). «Опрацьовано» — закрити скаргу. Працівник отримає сповіщення про рішення.")}</p>
            </div>
          )}

          {!!days.length && <p className="mb-1 mt-3 text-xs text-slate-400">{t("Натисніть на число годин, щоб змінити (з'явиться ✓). 🗑 — прибрати зміну, ✓ — зарахувати як відпрацьовану.")}</p>}

          {!days.length ? <Empty>{t("Немає змін за цей місяць")}</Empty> : (
            <div className="max-h-[50vh] overflow-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-3 py-2">{t("Дата")}</th><th className="px-3 py-2">{t("День")}</th><th className="px-3 py-2">{t("Фабрика")}</th>
                    <th className="px-3 py-2">{t("Зміна")}</th><th className="px-3 py-2">{t("Статус")}</th><th className="px-3 py-2 text-right">{t("Години")}</th><th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {days.map((d) => (
                    <tr key={d.entryId} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium text-slate-700">{fmtDate(d.date)}</td>
                      <td className="px-3 py-2 text-slate-500">{DAY_UK[d.day]}</td>
                      <td className="px-3 py-2 text-slate-500">{d.factory ?? "—"}</td>
                      <td className="px-3 py-2 text-slate-500">{SHIFT_UK[d.shift]}</td>
                      <td className="px-3 py-2">{statusChip(d, t)}{d.reason && <div className="text-xs text-slate-400">{d.reason}</div>}</td>
                      <td className="px-2 py-2 text-right">
                        {d.status === "present"
                          ? <HoursCell key={`${d.entryId}-${d.hoursOverride ?? d.computedHours}`} value={d.hoursOverride ?? d.computedHours} overridden={d.hoursOverride != null}
                              onSave={(h) => editEntry.mutate({ id: d.entryId, hoursOverride: h })} />
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {d.status === "present"
                          ? <button onClick={() => editEntry.mutate({ id: d.entryId, status: "scheduled" })} title={t("Прибрати зміну (не зараховувати)")} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                          : <button onClick={() => editEntry.mutate({ id: d.entryId, status: "present" })} title={t("Зарахувати як відпрацьовану")} className="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600"><Check className="h-4 w-4" /></button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <AddShiftRow factories={factories} defFactory={defFactory} onAdd={(v) => addShift.mutate(v)} pending={addShift.isPending} />
        </>
      )}
    </Modal>
  );
}

function HoursCell({ value, overridden, onSave }: { value: number; overridden: boolean; onSave: (h: number | null) => void }) {
  const [v, setV] = useState(String(round(value)));
  const dirty = v !== String(round(value));
  return (
    <span className="inline-flex items-center gap-1">
      <input value={v} onChange={e => setV(e.target.value)} inputMode="decimal"
        className={`w-14 rounded-md border px-1.5 py-1 text-right text-sm ${overridden ? "border-red-300 bg-red-50/40" : "border-slate-200"}`} />
      {dirty && <button onClick={() => onSave(v.trim() === "" ? null : Number(v.replace(",", ".")))} className="rounded-md bg-emerald-500 p-1 text-white hover:bg-emerald-600" title="Зберегти"><Check className="h-3 w-3" /></button>}
    </span>
  );
}

function AddShiftRow({ factories, defFactory, onAdd, pending }: { factories: Factory[]; defFactory: number | null; onAdd: (v: { date: string; factoryId: number; shift: string }) => void; pending: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [factoryId, setFactoryId] = useState(defFactory ? String(defFactory) : "");
  const [shift, setShift] = useState("1");
  const fac = factories.find(f => String(f.id) === factoryId);
  const shiftCount = Math.min(6, Math.max(1, fac?.shiftCount ?? 3));
  if (!open) return (
    <button onClick={() => setOpen(true)} className="mt-3 flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"><Plus className="h-4 w-4" /> {t("Додати зміну")}</button>
  );
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 p-3">
      <div><label className="mb-0.5 block text-xs text-slate-500">{t("Дата")}</label><Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-40" /></div>
      <div><label className="mb-0.5 block text-xs text-slate-500">{t("Фабрика")}</label>
        <Select value={factoryId} onChange={e => setFactoryId(e.target.value)} className="w-40">
          <option value="">—</option>
          {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
      </div>
      <div><label className="mb-0.5 block text-xs text-slate-500">{t("Зміна")}</label>
        <Select value={shift} onChange={e => setShift(e.target.value)} className="w-24">
          {Array.from({ length: shiftCount }, (_, i) => String(i + 1)).map(s => <option key={s} value={s}>{s} {t("зм")}</option>)}
        </Select>
      </div>
      <Button disabled={!date || !factoryId || pending} onClick={() => { onAdd({ date, factoryId: Number(factoryId), shift }); setOpen(false); setDate(""); }}>{t("Додати")}</Button>
      <button onClick={() => setOpen(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
    </div>
  );
}

interface DriverDay { date: string; day: DayCode; factory: string | null; shift: ShiftCode; pickupAt: string | null; arrivedAt: string | null; lateP: boolean; lateF: boolean; travelMin: number | null }
interface DriverDays { driverId: number; name: string; vehicle: string | null; days: DriverDay[] }

export function DriverDaysModal({ driverId, name, month, monthLabel, onClose }: { driverId: number; name: string; month: string; monthLabel: string; onClose: () => void }) {
  const t = useT();
  const { data, isLoading } = useQuery<DriverDays>({ queryKey: ["driver-days", driverId, month], queryFn: () => get(`/driver-days/${driverId}?month=${month}`) });
  const days = data?.days ?? [];
  const lateP = days.filter(d => d.lateP).length, lateF = days.filter(d => d.lateF).length;
  return (
    <Modal open onClose={onClose} title={`${name} — ${monthLabel}`} size="lg">
      {isLoading ? <Spinner /> : !days.length ? <Empty>{t("Немає поїздок за цей місяць")}</Empty> : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge color="slate">{t("Поїздок:")} {days.length}</Badge>
            {lateP > 0 && <Badge color="amber">{t("Спізн. на збір:")} {lateP}</Badge>}
            {lateF > 0 && <Badge color="rose">{t("Спізн. на фабрику:")} {lateF}</Badge>}
          </div>
          <div className="max-h-[60vh] overflow-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-2">{t("Дата")}</th><th className="px-3 py-2">{t("День")}</th><th className="px-3 py-2">{t("Фабрика")}</th>
                  <th className="px-3 py-2">{t("Зміна")}</th><th className="px-3 py-2">{t("Виїзд")}</th><th className="px-3 py-2">{t("Прибуття")}</th><th className="px-3 py-2 text-right">{t("В дорозі")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {days.map((d, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-700">{fmtDate(d.date)}</td>
                    <td className="px-3 py-2 text-slate-500">{DAY_UK[d.day]}</td>
                    <td className="px-3 py-2 text-slate-500">{d.factory ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-500">{SHIFT_UK[d.shift]}</td>
                    <td className="px-3 py-2"><span className={d.lateP ? "text-amber-600" : "text-slate-600"}>{fmtTime(d.pickupAt)}</span>{d.lateP && <span className="ml-1 text-xs text-amber-500">↑</span>}</td>
                    <td className="px-3 py-2"><span className={d.lateF ? "text-rose-600" : "text-slate-600"}>{fmtTime(d.arrivedAt)}</span>{d.lateF && <span className="ml-1 text-xs text-rose-500">↑</span>}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{d.travelMin != null ? `${d.travelMin} ${t("хв")}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

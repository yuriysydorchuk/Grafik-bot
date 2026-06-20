import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Link2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, type Factory, type Company, type Position, type GenMode } from "../lib/api";
import { Button, Input, Label, Select, Card, Spinner, Modal, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { badgeClass, dotClass } from "../lib/colors";

const GEN_MODE_LABEL: Record<GenMode, string> = {
  availability: "Працівники заповнюють доступність",
  orders: "Генеруємо за замовленнями (всі активні)",
  all: "Випускаємо всіх активних (без замовлень)",
};

export default function Factories() {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const isOwner = me?.role === "owner";
  const { data: factories, isLoading } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const [edit, setEdit] = useState<Factory | null>(null);
  const [adding, setAdding] = useState(false);
  const inv = () => qc.invalidateQueries({ queryKey: ["factories"] });
  const joinLink = useMutation({
    mutationFn: (id: number) => get<{ link: string }>(`/factories/${id}/join-link`),
    onSuccess: (d) => { navigator.clipboard?.writeText(d.link); toast.success(t("Посилання для реєстрації скопійовано"), { description: d.link }); },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title={t("Фабрики")} subtitle={`${factories?.length ?? 0}`}
        action={<Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати")}</Button>} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {!factories?.length && <Empty>{t("Немає фабрик")}</Empty>}
        {factories?.map(f => (
          <Card key={f.id} className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800">{f.name}{f.companyName && <Badge color="blue">{f.companyName}</Badge>}</h3>
                {f.address && <p className="mt-0.5 text-sm text-slate-500">{f.address}</p>}
              </div>
              <div className="flex gap-1">
                <button onClick={() => joinLink.mutate(f.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title={t("Посилання для самореєстрації працівників")}><Link2 className="h-4 w-4" /></button>
                <button onClick={() => setEdit(f)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Редагувати")}><Pencil className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              {(f.shifts?.length ? f.shifts : [{ start: f.shift1Start ?? "06:00", end: "" }]).map((s, i) => (
                <Badge key={i} color={["blue", "amber", "red", "green", "rose", "slate"][i] as any}>
                  {i + 1} {t("зм")}: {s.start}{s.end ? `–${s.end}` : ""}
                </Badge>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge color={f.genMode === "availability" ? "green" : f.genMode === "all" ? "blue" : "amber"}>{t(GEN_MODE_LABEL[f.genMode] ?? GEN_MODE_LABEL.availability)}</Badge>
              {f.usesGender && <Badge color="rose">{t("Поділ за статтю")}</Badge>}
            </div>
            {f.usesPositions && (f.positions?.length ?? 0) > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {f.positions.map(p => (
                  <span key={p.positionId} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass(p.color ?? "slate")}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${dotClass(p.color ?? "slate")}`} />{p.name}{isOwner && p.rate != null && <span className="opacity-60">· {p.rate} zł</span>}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-3 text-sm text-slate-500">📧 {f.clientEmail || <span className="text-slate-300">{t("email клієнта не вказано")}</span>}</div>
            {isOwner && <div className="mt-1 text-sm text-slate-500">💰 {t("Ставка фактури:")} {f.invoiceRate != null ? <span className="font-medium text-slate-700">{f.invoiceRate} {t("zł/год нетто")}</span> : <span className="text-amber-500">{t("не задано")}</span>}</div>}
          </Card>
        ))}
      </div>
      {(adding || edit) && <FactoryModal factory={edit} isOwner={isOwner} onClose={() => { setAdding(false); setEdit(null); }} onSaved={() => { inv(); setAdding(false); setEdit(null); }} />}
    </>
  );
}

type ShiftTime = { start: string; end: string };
const DEFAULT_SHIFTS: ShiftTime[] = [
  { start: "06:00", end: "14:00" }, { start: "14:00", end: "22:00" }, { start: "22:00", end: "06:00" },
  { start: "06:00", end: "12:00" }, { start: "12:00", end: "18:00" }, { start: "18:00", end: "00:00" },
];
const initialShifts = (f: Factory | null): ShiftTime[] => {
  if (f?.shifts?.length) return f.shifts.map(s => ({ start: s.start, end: s.end }));
  const starts = [f?.shift1Start, f?.shift2Start, f?.shift3Start].filter(Boolean) as string[];
  if (starts.length) return starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? DEFAULT_SHIFTS[i]?.end ?? "14:00" }));
  return DEFAULT_SHIFTS.slice(0, f?.shiftCount ?? 3);
};

type PosRow = { positionId: number; rate: string; invoiceRate: string };
function FactoryModal({ factory, isOwner, onClose, onSaved }: { factory: Factory | null; isOwner: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const { data: allPositions = [] } = useQuery<Position[]>({ queryKey: ["positions"], queryFn: () => get("/positions") });
  const [v, setV] = useState({
    name: factory?.name ?? "", address: factory?.address ?? "",
    clientEmail: factory?.clientEmail ?? "",
    companyId: factory?.companyId ? String(factory.companyId) : "",
    genMode: (factory?.genMode ?? "availability") as GenMode,
    usesPositions: factory?.usesPositions ?? false,
    usesGender: factory?.usesGender ?? false,
    usesTransport: factory?.usesTransport ?? true,
    showWorkerHours: factory?.showWorkerHours ?? true,
    showCode: factory?.showCode ?? true,
    invoiceRate: factory?.invoiceRate != null ? String(factory.invoiceRate) : "",
  });
  const [posRows, setPosRows] = useState<PosRow[]>(
    (factory?.positions ?? []).map(p => ({ positionId: p.positionId, rate: p.rate != null ? String(p.rate) : "", invoiceRate: p.invoiceRate != null ? String(p.invoiceRate) : "" }))
  );
  const addPosRow = () => {
    const used = new Set(posRows.map(r => r.positionId));
    const next = allPositions.find(p => !used.has(p.id));
    if (next) setPosRows(rows => [...rows, { positionId: next.id, rate: "", invoiceRate: "" }]);
  };
  const setPosRow = (i: number, patch: Partial<PosRow>) => setPosRows(rows => rows.map((r, j) => j === i ? { ...r, ...patch } : r));
  const removePosRow = (i: number) => setPosRows(rows => rows.filter((_, j) => j !== i));
  const [shifts, setShifts] = useState<ShiftTime[]>(initialShifts(factory));
  const [stops, setStops] = useState<{ name: string; time: string }[]>(factory?.stops ?? []);
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });
  const setStop = (i: number, key: "name" | "time") => (e: any) =>
    setStops(prev => prev.map((s, j) => j === i ? { ...s, [key]: e.target.value } : s));
  const addStop = () => setStops(prev => [...prev, { name: "", time: "" }]);
  const removeStop = (i: number) => setStops(prev => prev.filter((_, j) => j !== i));

  const setCount = (n: number) => setShifts(prev => Array.from({ length: n }, (_, i) => prev[i] ?? DEFAULT_SHIFTS[i] ?? { start: "06:00", end: "14:00" }));
  const setShift = (i: number, key: "start" | "end") => (e: any) =>
    setShifts(prev => prev.map((s, j) => j === i ? { ...s, [key]: e.target.value } : s));

  const valid = /^\d{1,2}:\d{2}$/;
  const shiftsOk = shifts.every(s => valid.test(s.start) && valid.test(s.end));
  const payload = () => ({
    name: v.name.trim(), address: v.address, clientEmail: v.clientEmail,
    companyId: v.companyId ? Number(v.companyId) : null,
    genMode: v.genMode, usesPositions: v.usesPositions, usesGender: v.usesGender,
    usesTransport: v.usesTransport, showWorkerHours: v.showWorkerHours, showCode: v.showCode,
    positions: v.usesPositions ? posRows.map(r => ({ positionId: r.positionId, rate: r.rate.trim() === "" ? null : Number(r.rate.replace(",", ".")), invoiceRate: r.invoiceRate.trim() === "" ? null : Number(r.invoiceRate.replace(",", ".")) })) : [],
    shifts, stops: stops.filter(s => s.name.trim()),
    ...(isOwner ? { invoiceRate: v.invoiceRate.trim() === "" ? null : Number(v.invoiceRate.replace(",", ".")) } : {}),
  });
  const save = useMutation({
    mutationFn: () => factory ? patch(`/factories/${factory.id}`, payload()) : post(`/factories`, payload()),
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={factory ? t("Редагувати фабрику") : t("Нова фабрика")}>
      <div className="space-y-3">
        <div><Label>{t("Назва")}</Label><Input value={v.name} onChange={set("name")} autoFocus /></div>
        <div><Label>{t("Фірма")}</Label>
          <Select value={v.companyId} onChange={set("companyId")}>
            <option value="">{t("— без фірми —")}</option>
            {companies.map(co => <option key={co.id} value={co.id}>{co.name}</option>)}
          </Select>
        </div>
        <div><Label>{t("Адреса")}</Label><Input value={v.address} onChange={set("address")} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>{t("Кількість змін")}</Label>
            <Select value={String(shifts.length)} onChange={e => setCount(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} {t(n === 1 ? "зміна" : n < 5 ? "зміни" : "змін")}</option>)}
            </Select>
          </div>
          <div>
            <Label>{t("Режим графіку")}</Label>
            <Select value={v.genMode} onChange={e => setV({ ...v, genMode: e.target.value as GenMode })}>
              <option value="availability">{t("Працівники заповнюють доступність")}</option>
              <option value="orders">{t("Генеруємо за замовленнями (всі активні)")}</option>
              <option value="all">{t("Випускаємо всіх активних (без замовлень)")}</option>
            </Select>
          </div>
        </div>
        {v.genMode === "orders" && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {t("Працівники цієї фабрики не заповнюють доступність. «Згенерувати» розставить усіх активних працівників за замовленнями — далі правите вручну.")}
          </p>
        )}
        {v.genMode === "all" && (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-700">
            {t("Без замовлень. «Згенерувати» випустить УСІХ активних працівників (Пн–Сб): закріплені — у свою зміну, решта рівномірно по змінах. Хто зголосив відсутність — не ставиться.")}
          </p>
        )}

        {/* Positions + gender config — only the factories that need it */}
        <div className="space-y-2 rounded-xl border border-slate-200 p-3">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={v.usesPositions} onChange={e => setV({ ...v, usesPositions: e.target.checked })} />
            {t("Розрізняти посади на цій фабриці")}
          </label>
          {v.usesPositions && (
            <div className="space-y-1.5 pl-6">
              {posRows.length === 0 && <p className="text-xs text-slate-400">{t("Додайте посади, які є на цій фабриці.")}</p>}
              {isOwner && posRows.length > 0 && (
                <div className="flex items-center gap-2 pr-9 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                  <span className="flex-1">{t("Посада")}</span>
                  <span className="w-24 text-center">{t("Платимо")}</span>
                  <span className="w-24 text-center">{t("Клієнт")}</span>
                </div>
              )}
              {posRows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select value={String(r.positionId)} onChange={e => setPosRow(i, { positionId: Number(e.target.value) })} className="flex-1">
                    {allPositions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                  {isOwner && <Input value={r.rate} onChange={e => setPosRow(i, { rate: e.target.value })} placeholder={t("zł/год")} inputMode="decimal" className="w-24 text-center" />}
                  {isOwner && <Input value={r.invoiceRate} onChange={e => setPosRow(i, { invoiceRate: e.target.value })} placeholder={t("zł/год")} inputMode="decimal" className="w-24 text-center" />}
                  <button type="button" onClick={() => removePosRow(i)} className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-4 w-4" /></button>
                </div>
              ))}
              {posRows.length < allPositions.length && (
                <button type="button" onClick={addPosRow} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"><Plus className="h-3.5 w-3.5" /> {t("Додати посаду")}</button>
              )}
              {!allPositions.length && <p className="text-xs text-amber-600">{t("Спершу створіть посади в Налаштування → Посади.")}</p>}
              {isOwner && <p className="text-xs text-slate-400">{t("«Платимо» — ставка працівнику (брутто zł/год). «Клієнт» — скільки виставляємо клієнту за цю посаду (нетто zł/год). Порожньо = власна ставка / загальна ставка фабрики.")}</p>}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={v.usesGender} onChange={e => setV({ ...v, usesGender: e.target.checked })} />
            {t("Поділ за статтю (чоловіки / жінки)")}
          </label>
        </div>
        {/* What the worker sees in the bot — trims their menu buttons */}
        <div className="space-y-2 rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{t("Що бачить працівник у боті")}</p>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={v.usesTransport} onChange={e => setV({ ...v, usesTransport: e.target.checked })} />
            {t("Є довіз працівників (показувати зупинки)")}
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={v.showWorkerHours} onChange={e => setV({ ...v, showWorkerHours: e.target.checked })} />
            {t("Показувати кнопку «Мої години та зміни»")}
          </label>
          <p className="pl-6 text-xs text-slate-400">{t("Кнопка «Заповнити доступність» зʼявляється лише в режимі «Працівники заповнюють доступність».")}</p>
        </div>
        {/* Excel schedule columns */}
        <div className="space-y-2 rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{t("Стовпчики Excel-графіку")}</p>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={v.showCode} onChange={e => setV({ ...v, showCode: e.target.checked })} />
            {t("Стовпчик коду працівника")}
          </label>
          <p className="pl-6 text-xs text-slate-400">{t("Стовпчик «Стать» і розділення по посадах керуються перемикачами «Поділ за статтю» та «Розрізняти посади» вище.")}</p>
        </div>
        <div>
          <Label>{t("Час змін (початок – кінець)")}</Label>
          <div className="space-y-1.5">
            {shifts.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-xs font-medium text-slate-500">{i + 1} {t("зміна")}</span>
                <Input value={s.start} onChange={setShift(i, "start")} placeholder="06:00" className="text-center" />
                <span className="text-slate-400">–</span>
                <Input value={s.end} onChange={setShift(i, "end")} placeholder="14:00" className="text-center" />
              </div>
            ))}
          </div>
          {!shiftsOk && <p className="mt-1 text-xs text-rose-500">{t("Час у форматі HH:MM (напр. 06:00). Нічна зміна (22:00–06:00) рахується через північ.")}</p>}
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <Label>{t("Зупинки (де водій забирає працівників)")}</Label>
            <button type="button" onClick={addStop} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"><Plus className="h-3.5 w-3.5" /> {t("Додати")}</button>
          </div>
          {stops.length === 0 && <p className="text-xs text-slate-400">{t("Немає зупинок. Працівник побачить їх у боті («🏭 Інфо по фабриці»).")}</p>}
          <div className="space-y-1.5">
            {stops.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={s.name} onChange={setStop(i, "name")} placeholder={t("напр. Ринок, головний вхід")} className="flex-1" />
                <Input value={s.time} onChange={setStop(i, "time")} placeholder="06:30" className="w-20 text-center" />
                <button type="button" onClick={() => removeStop(i)} className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Прибрати")}><span className="text-sm">✕</span></button>
              </div>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">{t("Час — коли працівник має бути на зупинці (необов'язково).")}</p>
        </div>
        <div><Label>{t("Email клієнта (для розсилки графіку)")}</Label><Input value={v.clientEmail} onChange={set("clientEmail")} type="email" /></div>
        {isOwner && (
          <div>
            <Label>{t("Ставка фактури (zł/год, нетто — для фінансів)")}</Label>
            <Input value={v.invoiceRate} onChange={set("invoiceRate")} placeholder={t("напр. 50")} inputMode="decimal" />
            <p className="mt-1 text-xs text-slate-400">{t("Скільки виставляємо фабриці за годину праці. ВАТ 23% додається зверху.")}</p>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!v.name.trim() || !shiftsOk} onClick={() => v.name.trim() && shiftsOk && save.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

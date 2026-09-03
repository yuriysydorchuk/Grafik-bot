import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Link2, Trash2, X, Eye } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, put, del, type Factory, type FactoryPositionConf, type Company, type Position, type GenMode, type EmailTemplate } from "../lib/api";
import { Button, Input, Label, Select, Card, Spinner, Modal, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { badgeClass, dotClass } from "../lib/colors";
import { can } from "../lib/roles";

// New backend fields not yet in the shared Factory type (fin-gated ones come per-cap:
// rates — viewFinance|factoryRates, NIP/P&L — viewFinance only)
type FactoryX = Omit<Factory, "positions"> & {
  city?: string | null;
  fuelCommute?: boolean;
  paidTransport?: boolean;
  transportFeePerShift?: number | null;
  transportFeeMonthCap?: number | null;
  rateBrutto?: number | null; rateNetto?: number | null; nightAddon?: number | null;
  clientNip?: string | null; pnlLabel?: string | null;
  positions: (FactoryPositionConf & { rateNetto?: number | null })[];
};

const GEN_MODE_LABEL: Record<GenMode, string> = {
  availability: "Працівники заповнюють доступність",
  orders: "Генеруємо за замовленнями (всі активні)",
  all: "Випускаємо всіх активних (без замовлень)",
};

export default function Factories() {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  // ставки (брутто/нетто/нічна/фактурна + посади) — viewFinance або factoryRates;
  // NIP/P&L-підпис — лише viewFinance (canRates ⊇ canInvoice)
  const canRates = can(me, "viewFinance") || can(me, "factoryRates");
  const canInvoice = can(me, "viewFinance");
  // правила konto/готівки сводної: перегляд — svodniSensitive, редагування — viewFinance
  const canPayoutView = can(me, "svodniSensitive");
  const canPayoutEdit = can(me, "viewFinance");
  const { data: factories, isLoading } = useQuery<FactoryX[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const [edit, setEdit] = useState<FactoryX | null>(null);
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
                    <span className={`h-1.5 w-1.5 rounded-full ${dotClass(p.color ?? "slate")}`} />{p.name}{canRates && p.rate != null && <span className="opacity-60">· {p.rate} zł</span>}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-3 text-sm text-slate-500">📧 {f.emailRecipients?.length ? f.emailRecipients.map(r => r.email).join(", ") : (f.clientEmail || <span className="text-slate-300">{t("email клієнта не вказано")}</span>)}</div>
            {f.genMode === "availability" && f.minDaysPerWeek != null && <div className="mt-1 text-sm text-slate-500">📅 {t("Мінімум днів доступності на тиждень:")} <span className="font-medium text-slate-700">{f.minDaysPerWeek}</span></div>}
            {canRates && <div className="mt-1 text-sm text-slate-500">💰 {t("Ставка фактури:")} {f.invoiceRate != null ? <span className="font-medium text-slate-700">{f.invoiceRate} {t("zł/год нетто")}</span> : <span className="text-amber-500">{t("не задано")}</span>}</div>}
          </Card>
        ))}
      </div>
      {(adding || edit) && <FactoryModal factory={edit} canRates={canRates} canInvoice={canInvoice} canPayoutView={canPayoutView} canPayoutEdit={canPayoutEdit} onClose={() => { setAdding(false); setEdit(null); }} onSaved={() => { inv(); setAdding(false); setEdit(null); }} />}
    </>
  );
}

type ShiftTime = { start: string; end: string };
const DEFAULT_SHIFTS: ShiftTime[] = [
  { start: "06:00", end: "14:00" }, { start: "14:00", end: "22:00" }, { start: "22:00", end: "06:00" },
  { start: "06:00", end: "12:00" }, { start: "12:00", end: "18:00" }, { start: "18:00", end: "00:00" },
];
const initialShifts = (f: FactoryX | null): ShiftTime[] => {
  if (f?.shifts?.length) return f.shifts.map(s => ({ start: s.start, end: s.end }));
  const starts = [f?.shift1Start, f?.shift2Start, f?.shift3Start].filter(Boolean) as string[];
  if (starts.length) return starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? DEFAULT_SHIFTS[i]?.end ?? "14:00" }));
  return DEFAULT_SHIFTS.slice(0, f?.shiftCount ?? 3);
};

type PosRow = { positionId: number; rate: string; rateNetto: string; invoiceRate: string };
function FactoryModal({ factory, canRates, canInvoice, canPayoutView, canPayoutEdit, onClose, onSaved }: { factory: FactoryX | null; canRates: boolean; canInvoice: boolean; canPayoutView: boolean; canPayoutEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const { data: allPositions = [] } = useQuery<Position[]>({ queryKey: ["positions"], queryFn: () => get("/positions") });
  const { data: tplData } = useQuery<{ templates: EmailTemplate[] }>({ queryKey: ["email-templates"], queryFn: () => get("/email-templates") });
  const templates = tplData?.templates ?? [];
  // отримувачі графіку: email + шаблон листа (порожньо = стандартний)
  const [recipients, setRecipients] = useState<{ email: string; name: string; templateId: string }[]>(
    (factory?.emailRecipients ?? []).map(r => ({ email: r.email, name: r.name ?? "", templateId: r.templateId != null ? String(r.templateId) : "" }))
  );
  const setRecipient = (i: number, p: Partial<{ email: string; name: string; templateId: string }>) => setRecipients(prev => prev.map((r, j) => j === i ? { ...r, ...p } : r));
  const addRecipient = () => setRecipients(prev => [...prev, { email: "", name: "", templateId: "" }]);
  const removeRecipient = (i: number) => setRecipients(prev => prev.filter((_, j) => j !== i));
  const emailOk = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
  const [v, setV] = useState({
    name: factory?.name ?? "", address: factory?.address ?? "",
    city: factory?.city ?? "",
    minDaysPerWeek: factory?.minDaysPerWeek != null ? String(factory.minDaysPerWeek) : "",
    companyId: factory?.companyId ? String(factory.companyId) : "",
    genMode: (factory?.genMode ?? "availability") as GenMode,
    usesPositions: factory?.usesPositions ?? false,
    usesGender: factory?.usesGender ?? false,
    usesTransport: factory?.usesTransport ?? true,
    fuelCommute: factory?.fuelCommute ?? false,
    paidTransport: factory?.paidTransport ?? false,
    transportFeePerShift: factory?.transportFeePerShift != null ? String(factory.transportFeePerShift) : "",
    transportFeeMonthCap: factory?.transportFeeMonthCap != null ? String(factory.transportFeeMonthCap) : "",
    usesScheduling: factory?.usesScheduling ?? true,
    showWorkerHours: factory?.showWorkerHours ?? true,
    showCode: factory?.showCode ?? true,
    invoiceRate: factory?.invoiceRate != null ? String(factory.invoiceRate) : "",
    rateBrutto: factory?.rateBrutto != null ? String(factory.rateBrutto) : "",
    rateNetto: factory?.rateNetto != null ? String(factory.rateNetto) : "",
    nightAddon: factory?.nightAddon != null ? String(factory.nightAddon) : "",
    clientNip: factory?.clientNip ?? "",
    pnlLabel: factory?.pnlLabel ?? "",
  });
  const [posRows, setPosRows] = useState<PosRow[]>(
    (factory?.positions ?? []).map(p => ({ positionId: p.positionId, rate: p.rate != null ? String(p.rate) : "", rateNetto: p.rateNetto != null ? String(p.rateNetto) : "", invoiceRate: p.invoiceRate != null ? String(p.invoiceRate) : "" }))
  );
  const addPosRow = () => {
    const used = new Set(posRows.map(r => r.positionId));
    const next = allPositions.find(p => !used.has(p.id));
    if (next) setPosRows(rows => [...rows, { positionId: next.id, rate: "", rateNetto: "", invoiceRate: "" }]);
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
  const num = (s: string) => s.trim() === "" ? null : Number(s.replace(",", "."));
  const payload = () => ({
    name: v.name.trim(), address: v.address, city: v.city.trim() || null,
    minDaysPerWeek: v.minDaysPerWeek.trim() ? Number(v.minDaysPerWeek) : null,
    companyId: v.companyId ? Number(v.companyId) : null,
    genMode: v.genMode, usesPositions: v.usesPositions, usesGender: v.usesGender,
    usesTransport: v.usesTransport, fuelCommute: v.fuelCommute, usesScheduling: v.usesScheduling, showWorkerHours: v.showWorkerHours, showCode: v.showCode,
    paidTransport: v.paidTransport, transportFeePerShift: num(v.transportFeePerShift), transportFeeMonthCap: num(v.transportFeeMonthCap),
    // поля, на які немає права, не шлемо — бекенд і так їх ігнорує і зберігає наявні значення
    positions: v.usesPositions ? posRows.map(r => ({
      positionId: r.positionId,
      ...(canRates ? { rate: num(r.rate), rateNetto: num(r.rateNetto), invoiceRate: num(r.invoiceRate) } : {}),
    })) : [],
    shifts, stops: stops.filter(s => s.name.trim()),
    ...(canRates ? { invoiceRate: num(v.invoiceRate), rateBrutto: num(v.rateBrutto), rateNetto: num(v.rateNetto), nightAddon: num(v.nightAddon) } : {}),
    ...(canInvoice ? { clientNip: v.clientNip.trim() || null, pnlLabel: v.pnlLabel.trim() || null } : {}),
  });
  const save = useMutation({
    mutationFn: async () => {
      const list = recipients.map(r => ({ ...r, email: r.email.trim() })).filter(r => r.email);
      const bad = list.find(r => !emailOk.test(r.email));
      if (bad) throw new Error(`${t("Невірний email")}: ${bad.email}`);
      const f = factory ? await patch<Factory>(`/factories/${factory.id}`, payload()) : await post<Factory>(`/factories`, payload());
      await put(`/factories/${f.id}/email-recipients`, { recipients: list.map(r => ({ email: r.email, name: r.name.trim() || null, templateId: r.templateId ? Number(r.templateId) : null })) });
    },
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
        <div>
          <Label>{t("Місто")}</Label>
          <Input value={v.city} onChange={set("city")} list="factory-city-options" />
          <datalist id="factory-city-options">
            <option value="Люблін" /><option value="Познань" /><option value="Лодзь" />
          </datalist>
        </div>
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
        {v.genMode === "availability" && (
          <div className="grid grid-cols-2 items-end gap-2">
            <div>
              <Label>{t("Мінімум днів доступності на тиждень")}</Label>
              <Select value={v.minDaysPerWeek} onChange={set("minDaysPerWeek")}>
                <option value="">{t("— без правила —")}</option>
                {[1, 2, 3, 4, 5, 6, 7].map(n => <option key={n} value={n}>{n}</option>)}
              </Select>
            </div>
            <p className="pb-1 text-xs text-slate-400">{t("Бот не прийме доступність із меншою кількістю днів і попросить працівника дозаповнити.")}</p>
          </div>
        )}
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
              {canRates && posRows.length > 0 && (
                <div className="flex items-center gap-2 pr-9 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                  <span className="flex-1">{t("Посада")}</span>
                  <span className="w-20 text-center">{t("Платимо")}</span>
                  <span className="w-20 text-center">{t("Нетто")}</span>
                  <span className="w-20 text-center">{t("Клієнт")}</span>
                </div>
              )}
              {posRows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select value={String(r.positionId)} onChange={e => setPosRow(i, { positionId: Number(e.target.value) })} className="flex-1">
                    {allPositions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                  {canRates && <Input value={r.rate} onChange={e => setPosRow(i, { rate: e.target.value })} placeholder={t("zł/год")} inputMode="decimal" className="w-20 text-center" />}
                  {canRates && <Input value={r.rateNetto} onChange={e => setPosRow(i, { rateNetto: e.target.value })} placeholder={t("zł/год")} inputMode="decimal" className="w-20 text-center" />}
                  {canRates && <Input value={r.invoiceRate} onChange={e => setPosRow(i, { invoiceRate: e.target.value })} placeholder={t("zł/год")} inputMode="decimal" className="w-20 text-center" />}
                  <button type="button" onClick={() => removePosRow(i)} className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-4 w-4" /></button>
                </div>
              ))}
              {posRows.length < allPositions.length && (
                <button type="button" onClick={addPosRow} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"><Plus className="h-3.5 w-3.5" /> {t("Додати посаду")}</button>
              )}
              {!allPositions.length && <p className="text-xs text-amber-600">{t("Спершу створіть посади в Налаштування → Посади.")}</p>}
              {canRates && <p className="text-xs text-slate-400">{t("«Платимо» — ставка працівнику (брутто zł/год), «Нетто» — та сама ставка нетто. «Клієнт» — скільки виставляємо клієнту за цю посаду (нетто zł/год). Порожньо = власна ставка / загальна ставка фабрики.")}</p>}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={v.usesGender} onChange={e => setV({ ...v, usesGender: e.target.checked })} />
            {t("Поділ за статтю (чоловіки / жінки)")}
          </label>
        </div>
        {/* What the worker sees in the bot — trims their menu buttons */}
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={v.usesScheduling} onChange={e => setV({ ...v, usesScheduling: e.target.checked })} />
          {t("Планування графіків (замовлення/генерація/доступність)")}
        </label>
        <div className="space-y-2 rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{t("Що бачить працівник у боті")}</p>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={v.usesTransport} onChange={e => setV({ ...v, usesTransport: e.target.checked })} />
            {t("Є довіз працівників (показувати зупинки)")}
          </label>
          <label className="flex items-center gap-2 pl-6 text-sm text-slate-600">
            <input type="checkbox" checked={v.fuelCommute} onChange={e => setV({ ...v, fuelCommute: e.target.checked })} />
            {t("Доїзд нашим транспортом — паливо ділиться на це місто (P&L)")}
          </label>
          <label className="flex items-center gap-2 pl-6 text-sm text-slate-600">
            <input type="checkbox" checked={v.paidTransport} onChange={e => setV({ ...v, paidTransport: e.target.checked })} />
            {t("Платний довіз (зняття з ЗП)")}
          </label>
          {v.paidTransport && (
            <div className="space-y-1.5 pl-12">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>{t("Ціна за зміну, zł")}</Label>
                  <Input value={v.transportFeePerShift} onChange={set("transportFeePerShift")} placeholder="20" inputMode="decimal" />
                </div>
                <div>
                  <Label>{t("Макс. за місяць, zł")}</Label>
                  <Input value={v.transportFeeMonthCap} onChange={set("transportFeeMonthCap")} placeholder="150" inputMode="decimal" />
                </div>
              </div>
              <p className="text-xs text-slate-400">{t("Зняття = зміни × ціна, але не більше максимуму. Зміни = години сводної місяця ÷ тривалість зміни фабрики, округлення вгору. Рахується кнопкою «Розрахувати» у Транспорт → Зняття за довіз.")}</p>
            </div>
          )}
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
        <div>
          <div className="mb-1 flex items-center justify-between">
            <Label>{t("Email клієнта (для розсилки графіку)")}</Label>
            <button type="button" onClick={addRecipient} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"><Plus className="h-3.5 w-3.5" /> {t("Додати")}</button>
          </div>
          {recipients.length === 0 && <p className="text-xs text-slate-400">{t("Немає отримувачів — лист із графіком не надсилатиметься.")}</p>}
          <div className="space-y-1.5">
            {recipients.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={r.email} onChange={e => setRecipient(i, { email: e.target.value })} type="email" placeholder="email@firma.pl" className="flex-1" />
                <Select value={r.templateId} onChange={e => setRecipient(i, { templateId: e.target.value })} className="w-40">
                  <option value="">{t("Стандартний")}</option>
                  {templates.map(tp => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
                </Select>
                <button type="button" onClick={() => removeRecipient(i)} className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Прибрати")}><span className="text-sm">✕</span></button>
              </div>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">{t("Кожен отримувач може мати власний шаблон листа (Налаштування → Email-шаблони). Лист надсилається всім одразу.")}</p>
        </div>
        {canRates && (
          <div>
            <Label>{t("Ставка фактури (zł/год, нетто — для фінансів)")}</Label>
            <Input value={v.invoiceRate} onChange={set("invoiceRate")} placeholder={t("напр. 50")} inputMode="decimal" />
            <p className="mt-1 text-xs text-slate-400">{t("Скільки виставляємо фабриці за годину праці. ВАТ 23% додається зверху.")}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div>
                <Label>{t("Ставка брутто, zł/год")}</Label>
                <Input value={v.rateBrutto} onChange={set("rateBrutto")} placeholder={t("напр. 31,40")} inputMode="decimal" />
              </div>
              <div>
                <Label>{t("Ставка нетто, zł/год")}</Label>
                <Input value={v.rateNetto} onChange={set("rateNetto")} placeholder={t("напр. 25,35")} inputMode="decimal" />
              </div>
            </div>
            <p className="mt-1 text-xs text-slate-400">{t("Базові ставки — для сводної 2.0; якщо фабрика веде посади, ставки задаються по посадах")}</p>
            <div className="mt-3">
              <Label>{t("Нічна доплата, zł/год (нетто)")}</Label>
              <Input value={v.nightAddon} onChange={set("nightAddon")} placeholder={t("порожньо = без нічних")} inputMode="decimal" />
            </div>
            {canInvoice && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <Label>{t("NIP клієнта (для P&L)")}</Label>
                    <Input value={v.clientNip} onChange={set("clientNip")} placeholder="7791906082" inputMode="numeric" />
                  </div>
                  <div>
                    <Label>{t("Підпис клієнта в P&L")}</Label>
                    <Input value={v.pnlLabel} onChange={set("pnlLabel")} placeholder={t("напр. Eurocash")} />
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-400">{t("Фактури KSeF матчаться по NIP; дохід і собівартість зливаються цим підписом. Кілька фабрик одного клієнта — однаковий NIP і підпис.")}</p>
              </>
            )}
          </div>
        )}
        {factory && canPayoutView && <PayoutRulesBlock factoryId={factory.id} canEdit={canPayoutEdit} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!v.name.trim() || !shiftsOk} onClick={() => v.name.trim() && shiftsOk && save.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Правила сводної (konto/готівка) — версійні, «діє з» ──────────────────────
// Перегляд — svodniSensitive, редагування — viewFinance. Фабрика без версій
// працює за спадковими правилами з коду (legacy); перша збережена версія
// перекриває їх зі свого місяця. Після збереження — превʼю перерахунку
// зачеплених місяців (залочені вкладки пропускаються).
type StazStep = { days: number; add: number };
type PayoutRuleCore = {
  capH: number | null; capHighH: number | null; capThresholdH: number | null; capFirm: string | null;
  cashBonus: number; stazBonus: boolean; stazMinHours: number | null; stazSteps: StazStep[] | null;
  premiaCash: boolean;
};
type PayoutRuleV = PayoutRuleCore & { id: number; factoryId: number; effectiveFrom: string; note: string | null };
type RulesResp = {
  factoryId: number; month: string; versions: PayoutRuleV[]; legacy: PayoutRuleCore;
  effective: PayoutRuleCore; effectiveSource: { id: number; effectiveFrom: string } | "legacy";
};
type ImpactRow = {
  id: number; month: string; city: string; factoryLabel: string; name: string;
  locked: boolean; segmented: boolean; diffs: { key: string; from: unknown; to: unknown }[];
};

function ruleChips(r: PayoutRuleCore, t: (s: string) => string): string[] {
  const chips: string[] = [];
  if (r.capH != null) {
    let cap = `${t("конто ≤")} ${r.capH} ${t("год")}`;
    if (r.capThresholdH != null && r.capHighH != null) cap += ` (${t("від")} ${r.capThresholdH} ${t("год")} — ${r.capHighH})`;
    if (r.capFirm) cap += ` · ${r.capFirm}`;
    chips.push(cap);
  }
  if (r.cashBonus > 0) chips.push(`${t("нал")} +${r.cashBonus} ${t("zł/год")}`);
  if (r.stazBonus) {
    const steps = (r.stazSteps ?? []).map(s => `${s.days}${t("д")} +${s.add}`).join(" / ");
    chips.push(`${t("стаж")} ${steps || "—"}${r.stazMinHours != null ? ` (${t("від")} ${r.stazMinHours} ${t("год/міс")})` : ""}`);
  }
  if (r.premiaCash) chips.push(t("Premia готівкою"));
  if (!chips.length) chips.push(t("без особливих правил"));
  return chips;
}

const RULE_DIFF_LABEL: Record<string, string> = {
  rateNetto: "Ставка нетто", doWyplaty: "До виплати", hoursDeclared: "Год. księg.",
  ksiegBrutto: "Księg. brutto", ksiegNetto: "Księg. netto", konto: "Конто", gotowka: "Готівка",
};

function PayoutRulesBlock({ factoryId, canEdit }: { factoryId: number; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const qk = ["factory-payout-rules", factoryId];
  const { data, isLoading } = useQuery<RulesResp>({ queryKey: qk, queryFn: () => get(`/svodni/factory-rules?factoryId=${factoryId}`) });
  const [form, setForm] = useState<null | { id: number | null; v: Record<string, string | boolean>; steps: { days: string; add: string }[] }>(null);
  const [impact, setImpact] = useState<null | { fromMonth: string; rows: ImpactRow[]; skippedLocked: number; done?: { updated: number } }>(null);
  const inv = () => qc.invalidateQueries({ queryKey: qk });

  const openForm = (ver: PayoutRuleV | null) => {
    const base: PayoutRuleCore = ver ?? data?.effective ?? { capH: null, capHighH: null, capThresholdH: null, capFirm: null, cashBonus: 0, stazBonus: false, stazMinHours: null, stazSteps: [], premiaCash: false };
    setForm({
      id: ver?.id ?? null,
      v: {
        effectiveFrom: ver?.effectiveFrom ?? "",
        capH: base.capH != null ? String(base.capH) : "",
        capHighH: base.capHighH != null ? String(base.capHighH) : "",
        capThresholdH: base.capThresholdH != null ? String(base.capThresholdH) : "",
        capFirm: base.capFirm ?? "",
        cashBonus: base.cashBonus ? String(base.cashBonus) : "",
        stazBonus: base.stazBonus,
        stazMinHours: base.stazMinHours != null ? String(base.stazMinHours) : "",
        premiaCash: base.premiaCash,
        note: (ver?.note ?? "") as string,
      },
      steps: (base.stazSteps ?? []).map(s => ({ days: String(s.days), add: String(s.add) })),
    });
  };

  // превʼю впливу показуємо ЗАВЖДИ (і коли рядків 0 — явним «нічого не
  // зміниться», а не тостом, який легко пропустити)
  const runImpact = async (fromMonth: string) => {
    try {
      const r = await post<{ rows: ImpactRow[]; skippedLocked: number }>("/svodni/factory-rules/impact", { factoryId, fromMonth });
      setImpact({ fromMonth, rows: r.rows, skippedLocked: r.skippedLocked });
    } catch (e: any) { toast.error(e.message); }
  };

  const saveForm = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error("no form");
      const num = (s: unknown) => String(s ?? "").trim() === "" ? null : Number(String(s).replace(",", "."));
      const body = {
        factoryId,
        effectiveFrom: String(form.v.effectiveFrom),
        capH: num(form.v.capH), capHighH: num(form.v.capHighH), capThresholdH: num(form.v.capThresholdH),
        capFirm: String(form.v.capFirm ?? "").trim() || null,
        cashBonus: num(form.v.cashBonus) ?? 0,
        stazBonus: !!form.v.stazBonus,
        stazMinHours: num(form.v.stazMinHours),
        stazSteps: form.steps
          .filter(s => s.days.trim() !== "" && s.add.trim() !== "")
          .map(s => ({ days: Number(s.days.replace(",", ".")), add: Number(s.add.replace(",", ".")) })),
        premiaCash: !!form.v.premiaCash,
        note: String(form.v.note ?? "").trim() || null,
      };
      const prev = form.id != null ? (data?.versions ?? []).find(x => x.id === form.id) : null;
      const saved = form.id != null
        ? await patch<PayoutRuleV>(`/svodni/factory-rules/${form.id}`, body)
        : await post<PayoutRuleV>("/svodni/factory-rules", body);
      // перерахунок — від найранішого зачепленого місяця (стара і нова дати версії)
      const months = [saved.effectiveFrom, prev?.effectiveFrom].filter(Boolean) as string[];
      return months.sort()[0]!.slice(0, 7);
    },
    onSuccess: (fromMonth) => { toast.success(t("Збережено")); setForm(null); inv(); runImpact(fromMonth); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (ver: PayoutRuleV) => { await del(`/svodni/factory-rules/${ver.id}`); return ver.effectiveFrom.slice(0, 7); },
    onSuccess: (fromMonth) => { toast.success(t("Версію видалено")); inv(); runImpact(fromMonth); },
    onError: (e: any) => toast.error(e.message),
  });

  const recompute = useMutation({
    mutationFn: (fromMonth: string) => post<{ updated: number; skippedLocked: number }>("/svodni/factory-rules/recompute", { factoryId, fromMonth }),
    onSuccess: (r) => {
      toast.success(`${t("Перераховано рядків:")} ${r.updated}${r.skippedLocked ? ` · ${t("пропущено (лок):")} ${r.skippedLocked}` : ""}`);
      setImpact(null);
      qc.invalidateQueries({ queryKey: ["svodni"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !data) return <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-400">{t("Правила сводної")}…</div>;
  const fmtD = (d: string) => { const [y, m, dd] = d.split("-"); return `${dd}.${m}.${y}`; };
  const effectiveLegacy = data.effectiveSource === "legacy";
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{t("Правила сводної (konto/готівка)")}</p>
        {canEdit && !form && (
          <button type="button" onClick={() => openForm(null)} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50">
            <Plus className="h-3.5 w-3.5" /> {t("Нова версія")}
          </button>
        )}
      </div>
      {/* чинне правило на поточний місяць */}
      <div className="text-sm text-slate-600">
        <span className="text-xs text-slate-400">{t("Зараз діє")} ({effectiveLegacy ? t("спадкове з коду") : `${t("з")} ${fmtD((data.effectiveSource as { effectiveFrom: string }).effectiveFrom)}`}):</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {ruleChips(data.effective, t).map((c, i) => <Badge key={i} color={effectiveLegacy ? "slate" : "green"}>{c}</Badge>)}
        </div>
      </div>
      {/* історія версій */}
      {data.versions.length > 0 && (
        <div className="space-y-1">
          {data.versions.map(ver => (
            <div key={ver.id} className="flex items-start justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1.5">
              <div className="min-w-0 text-xs text-slate-600">
                <span className="font-medium text-slate-700">{t("Діє з")} {fmtD(ver.effectiveFrom)}</span>
                <span className="ml-1 text-slate-400">({t("місяць")} {ver.effectiveFrom.slice(0, 7)} {t("цілком")})</span>
                <div className="mt-0.5 flex flex-wrap gap-1">{ruleChips(ver, t).map((c, i) => <Badge key={i} color="blue">{c}</Badge>)}</div>
                {ver.note && <div className="mt-0.5 text-slate-400">{ver.note}</div>}
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-1">
                  <button type="button" onClick={() => runImpact(ver.effectiveFrom.slice(0, 7))} className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700" title={t("На що впливає (рядки сводних від місяця версії)")}><Eye className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => openForm(ver)} className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700" title={t("Редагувати")}><Pencil className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => { if (confirm(t("Видалити цю версію правил?"))) remove.mutate(ver); }} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!data.versions.length && <p className="text-xs text-slate-400">{t("Версій ще нема — діють спадкові правила з коду. Перша збережена версія перекриє їх зі свого місяця.")}</p>}

      {/* форма нової/редагованої версії */}
      {form && (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/40 p-2.5">
          <div>
            <Label>{t("Діє з (дата)")}</Label>
            <Input type="date" value={String(form.v.effectiveFrom)} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, effectiveFrom: e.target.value } }))} />
            <p className="mt-0.5 text-xs text-slate-400">{t("Правило діє на сводну всього місяця, в який потрапляє дата.")}</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label>{t("Стеля конто, год")}</Label>
              <Input value={String(form.v.capH)} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, capH: e.target.value } }))} placeholder={t("без стелі")} inputMode="decimal" />
            </div>
            <div>
              <Label>{t("Підвищена, год")}</Label>
              <Input value={String(form.v.capHighH)} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, capHighH: e.target.value } }))} placeholder="70" inputMode="decimal" />
            </div>
            <div>
              <Label>{t("…від годин")}</Label>
              <Input value={String(form.v.capThresholdH)} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, capThresholdH: e.target.value } }))} placeholder="200" inputMode="decimal" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>{t("Стеля лише для фірми")}</Label>
              <Input value={String(form.v.capFirm)} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, capFirm: e.target.value } }))} placeholder={t("порожньо = всі")} />
            </div>
            <div>
              <Label>{t("Готівковий бонус, zł/год")}</Label>
              <Input value={String(form.v.cashBonus)} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, cashBonus: e.target.value } }))} placeholder="0" inputMode="decimal" />
            </div>
          </div>
          <p className="text-xs text-slate-400">{t("Стеля — скільки годин максимум декларується на конто (решта готівкою); працює «60, а від 200 відпрацьованих — 70». Готівковий бонус вмикається галочкою в профілі працівника.")}</p>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={!!form.v.stazBonus} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, stazBonus: e.target.checked } }))} />
            {t("Стажевий бонус (сходинки за днями стажу)")}
          </label>
          {!!form.v.stazBonus && (
            <div className="space-y-1.5 pl-6">
              <div>
                <Label>{t("Мін. годин за місяць")}</Label>
                <Input value={String(form.v.stazMinHours)} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, stazMinHours: e.target.value } }))} placeholder={t("порожньо = без порога")} inputMode="decimal" className="w-40" />
              </div>
              {form.steps.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-slate-600">
                  <span>{t("від")}</span>
                  <Input value={s.days} onChange={e => setForm(f => f && ({ ...f, steps: f.steps.map((x, j) => j === i ? { ...x, days: e.target.value } : x) }))} placeholder="30" inputMode="numeric" className="w-16 text-center" />
                  <span>{t("днів")} → +</span>
                  <Input value={s.add} onChange={e => setForm(f => f && ({ ...f, steps: f.steps.map((x, j) => j === i ? { ...x, add: e.target.value } : x) }))} placeholder="1" inputMode="decimal" className="w-16 text-center" />
                  <span>{t("zł/год")}</span>
                  <button type="button" onClick={() => setForm(f => f && ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button>
                </div>
              ))}
              <button type="button" onClick={() => setForm(f => f && ({ ...f, steps: [...f.steps, { days: "", add: "" }] }))} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"><Plus className="h-3.5 w-3.5" /> {t("Додати сходинку")}</button>
              <p className="text-xs text-slate-400">{t("Стаж — від дати працевлаштування на кінець місяця; галочка в профілі без дати = перша сходинка.")}</p>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={!!form.v.premiaCash} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, premiaCash: e.target.checked } }))} />
            {t("Колонка Premia — завжди готівкою")}
          </label>
          <div>
            <Label>{t("Нотатка")}</Label>
            <Input value={String(form.v.note)} onChange={e => setForm(f => f && ({ ...f, v: { ...f.v, note: e.target.value } }))} placeholder={t("напр. рішення власника 09.2026")} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setForm(null)}>{t("Скасувати")}</Button>
            <Button loading={saveForm.isPending} disabled={!String(form.v.effectiveFrom)} onClick={() => saveForm.mutate()}>{form.id != null ? t("Зберегти версію") : t("Створити версію")}</Button>
          </div>
        </div>
      )}

      {/* превʼю перерахунку зачеплених рядків */}
      {impact && (() => {
        const unlockedCount = impact.rows.filter(r => !r.locked).length;
        // підсумок по місяцях: 2026-07 — 3 рядки (1 🔒)
        const byMonth = new Map<string, { total: number; locked: number }>();
        for (const r of impact.rows) {
          const m = byMonth.get(r.month) ?? byMonth.set(r.month, { total: 0, locked: 0 }).get(r.month)!;
          m.total++;
          if (r.locked) m.locked++;
        }
        return (
          <Modal open onClose={() => setImpact(null)} title={t("На що вплине правило")}>
            <div className="space-y-2">
              {!impact.rows.length ? (
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  {t("Від місяця")} <span className="font-medium">{impact.fromMonth}</span>: {t("наявні рядки сводних НЕ зміняться — правило збігається з тим, за чим вони вже пораховані. Воно застосується до нових розрахунків (наступний «З обліку годин»).")}
                </p>
              ) : (
                <>
                  <p className="text-sm text-slate-600">
                    {t("Зачеплені рядки від місяця")} <span className="font-medium">{impact.fromMonth}</span>: {impact.rows.length}
                    {impact.skippedLocked > 0 && <span className="text-amber-600"> · {t("залочених (не зміняться):")} {impact.skippedLocked}</span>}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {[...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([m, c]) => (
                      <Badge key={m} color={c.locked === c.total ? "amber" : "blue"}>
                        {m}: {c.total}{c.locked > 0 ? ` (${c.locked} 🔒)` : ""}
                      </Badge>
                    ))}
                  </div>
                  <div className="max-h-80 space-y-1 overflow-y-auto">
                    {impact.rows.map(r => (
                      <div key={r.id} className={`rounded-lg px-2 py-1.5 text-xs ${r.locked ? "bg-amber-50 text-amber-700" : "bg-slate-50 text-slate-600"}`}>
                        <span className="font-medium text-slate-700">{r.name}</span>
                        <span className="ml-1 text-slate-400">{r.month} · {r.factoryLabel}{r.segmented ? " · 🧩" : ""}{r.locked ? ` · 🔒 ${t("лок")}` : ""}</span>
                        <div className="mt-0.5 flex flex-wrap gap-x-3">
                          {r.diffs.map((d, i) => (
                            <span key={i}>{t(RULE_DIFF_LABEL[d.key] ?? d.key)}: {String(d.from ?? "—")} → <span className="font-medium">{String(d.to ?? "—")}</span></span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-slate-400">{t("«Перерахувати» оновить незалочені рядки. Можна і не перераховувати — наступний «З обліку годин» застосує правило сам.")}</p>
                </>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setImpact(null)}>{impact.rows.length ? t("Не зараз") : t("Зрозуміло")}</Button>
                {unlockedCount > 0 && (
                  <Button loading={recompute.isPending} onClick={() => recompute.mutate(impact.fromMonth)}>
                    {t("Перерахувати незалочені")} ({unlockedCount})
                  </Button>
                )}
              </div>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

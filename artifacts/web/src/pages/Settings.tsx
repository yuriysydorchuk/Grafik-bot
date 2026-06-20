import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Percent, Plus, Trash2, GripVertical, ChevronUp, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { get, put, post, patch, del, type Funnel, type FunnelStage, type Company, type DocumentType, type Position, type Me } from "../lib/api";
import { Card, Spinner, Input, Label, Button, Select, Badge, Empty } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { STAGE_COLORS, dotClass, badgeClass } from "../lib/colors";
import { can } from "../lib/roles";
import Factories from "./Factories";
import Admins from "./Admins";

type TabId = "general" | "companies" | "factories" | "positions" | "documents" | "funnels" | "users";
const TABS: { id: TabId; label: string; show: (me: Me) => boolean }[] = [
  { id: "general", label: "Фінанси / ставки", show: m => can(m, "viewFinance") },
  { id: "companies", label: "Фірми", show: m => can(m, "editData") },
  { id: "factories", label: "Фабрики", show: m => can(m, "editData") },
  { id: "positions", label: "Посади", show: m => can(m, "editData") },
  { id: "documents", label: "Документи", show: m => can(m, "editData") },
  { id: "funnels", label: "Воронки рекрутації", show: m => can(m, "editData") },
  { id: "users", label: "Користувачі та ролі", show: m => m.isMain },
];

export default function Settings() {
  const t = useT();
  const me = useMe();
  const tabs = me ? TABS.filter(tab => tab.show(me)) : [];
  const [tab, setTab] = useState<TabId>(tabs[0]?.id ?? "factories");
  const active = tabs.some(t => t.id === tab) ? tab : (tabs[0]?.id ?? "factories");

  return (
    <>
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight text-slate-800">{t("Налаштування")}</h1>
        <p className="mt-0.5 text-sm text-slate-500">{t("Оберіть розділ, який хочете налаштувати")}</p>
      </div>

      <div className="mb-6 flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setTab(tab.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              active === tab.id ? "border-red-600 text-red-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {t(tab.label)}
          </button>
        ))}
      </div>

      {active === "general" && <FinanceRates />}
      {active === "companies" && <CompaniesSettings />}
      {active === "factories" && <Factories />}
      {active === "positions" && <PositionsSettings />}
      {active === "documents" && <DocTypesSettings />}
      {active === "funnels" && <FunnelsSettings />}
      {active === "users" && me && <Admins me={me} />}
    </>
  );
}

// ─── Finance rates (umowa zlecenie) ───────────────────────────────────────────────
interface Rates {
  vat: number; eePension: number; eeDisability: number; eeSickness: number; eeHealth: number;
  erPension: number; erDisability: number; erAccident: number; erFp: number; erFgsp: number; defaultRate: number;
}
const RATE_FIELDS: { key: keyof Rates; label: string; group: string }[] = [
  { key: "vat", label: "ВАТ (%)", group: "Фактура" },
  { key: "defaultRate", label: "Ставка за замовч. (zł/год брутто)", group: "Фактура" },
  { key: "eePension", label: "Емеритальне (%)", group: "Працівник (утримання)" },
  { key: "eeDisability", label: "Рентове (%)", group: "Працівник (утримання)" },
  { key: "eeSickness", label: "Хворобове (%)", group: "Працівник (утримання)" },
  { key: "eeHealth", label: "Здоровотне (%)", group: "Працівник (утримання)" },
  { key: "erPension", label: "Емеритальне (%)", group: "Роботодавець" },
  { key: "erDisability", label: "Рентове (%)", group: "Роботодавець" },
  { key: "erAccident", label: "Wypadkowe (%)", group: "Роботодавець" },
  { key: "erFp", label: "Fundusz Pracy (%)", group: "Роботодавець" },
  { key: "erFgsp", label: "FGŚP (%)", group: "Роботодавець" },
];
const GROUPS = ["Фактура", "Працівник (утримання)", "Роботодавець"];

function FinanceRates() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Rates>({ queryKey: ["finance-settings"], queryFn: () => get("/finance/settings") });
  const [v, setV] = useState<Partial<Rates>>({});
  const val = (k: keyof Rates) => (v[k] ?? data?.[k] ?? 0);
  const dirty = Object.keys(v).length > 0;
  const save = useMutation({
    mutationFn: () => put("/finance/settings", { ...data, ...v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["finance"] });
      qc.invalidateQueries({ queryKey: ["finance-compare"] });
      qc.invalidateQueries({ queryKey: ["finance-settings"] });
      qc.invalidateQueries({ queryKey: ["hours"] });
      setV({});
      toast.success(t("Ставки збережено"));
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><Percent className="h-4 w-4 text-slate-400" /> {t("Ставки ZUS / ВАТ (umowa zlecenie)")}</div>
      <p className="mb-4 text-xs text-slate-400">{t("Студент до 26 років — завжди без внесків (нетто = брутто). ПІТ не утримується (0). Зміни одразу впливають на «Облік годин» і «Фінанси».")}</p>
      {isLoading ? <Spinner /> : (
        <div className="space-y-4">
          {GROUPS.map(g => (
            <div key={g}>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t(g)}</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {RATE_FIELDS.filter(f => f.group === g).map(f => (
                  <div key={f.key}>
                    <Label>{t(f.label)}</Label>
                    <Input value={String(val(f.key))} inputMode="decimal"
                      onChange={e => setV(prev => ({ ...prev, [f.key]: Number(e.target.value.replace(",", ".")) || 0 }))} />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="flex justify-end pt-1">
            <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Recruitment funnels ──────────────────────────────────────────────────────

function FunnelsSettings() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: funnels = [], isLoading } = useQuery<Funnel[]>({ queryKey: ["funnels"], queryFn: () => get("/funnels") });
  const inv = () => qc.invalidateQueries({ queryKey: ["funnels"] });
  const create = useMutation({
    mutationFn: () => post("/funnels", { name: t("Нова воронка") }),
    onSuccess: () => { inv(); toast.success(t("Воронку створено")); }, onError: (e: any) => toast.error(e.message),
  });
  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{t("Створюйте власні воронки рекрутації з потрібними етапами. «Реферали» — вбудована.")}</p>
        <Button onClick={() => create.mutate()} loading={create.isPending}><Plus className="h-4 w-4" /> {t("Нова воронка")}</Button>
      </div>
      {!funnels.length && <Empty>{t("Немає воронок")}</Empty>}
      {funnels.map(f => <FunnelEditor key={f.id} funnel={f} onChanged={inv} confirm={confirm} />)}
    </div>
  );
}

function FunnelEditor({ funnel, onChanged, confirm }: { funnel: Funnel; onChanged: () => void; confirm: ReturnType<typeof useConfirm> }) {
  const t = useT();
  const isReferral = funnel.kind === "referral";
  const [name, setName] = useState(funnel.name);
  const [stages, setStages] = useState<FunnelStage[]>(funnel.stages);
  const dirty = name !== funnel.name || JSON.stringify(stages) !== JSON.stringify(funnel.stages);
  const save = useMutation({
    mutationFn: () => patch(`/funnels/${funnel.id}`, { name, stages }),
    onSuccess: () => { onChanged(); toast.success(t("Збережено")); }, onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => del(`/funnels/${funnel.id}`),
    onSuccess: () => { onChanged(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message),
  });
  const setStage = (i: number, p: Partial<FunnelStage>) => setStages(prev => prev.map((s, j) => j === i ? { ...s, ...p } : s));
  const addStage = () => setStages(prev => [...prev, { key: "", label: "", color: "slate" }]);
  const removeStage = (i: number) => setStages(prev => prev.filter((_, j) => j !== i));
  const move = (i: number, dir: number) => setStages(prev => {
    const n = [...prev]; const j = i + dir; if (j < 0 || j >= n.length) return prev;
    [n[i], n[j]] = [n[j]!, n[i]!]; return n;
  });

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} className="flex-1 font-medium" />
        <Badge color={isReferral ? "red" : "slate"}>{isReferral ? t("вбудована") : t("власна")}</Badge>
        {!isReferral && (
          <button onClick={async () => { if (await confirm({ title: t("Видалити воронку «{name}»?", { name: funnel.name }), message: t("Воронку без кандидатів буде видалено."), danger: true, confirmText: t("Видалити") })) remove.mutate(); }}
            className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>
        )}
      </div>
      <div className="space-y-1.5">
        {stages.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass(s.color)}`} />
            <Input value={s.label} onChange={e => setStage(i, { label: e.target.value })} placeholder={t("Назва етапу")} className="flex-1" />
            <Select value={s.color} onChange={e => setStage(i, { color: e.target.value })} className="w-28">
              {STAGE_COLORS.map(c => <option key={c} value={c}>{c}</option>)}
            </Select>
            <div className="flex shrink-0">
              <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
              <button onClick={() => move(i, 1)} disabled={i === stages.length - 1} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
            </div>
            {!isReferral && <button onClick={() => removeStage(i)} className="shrink-0 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>}
            {isReferral && <GripVertical className="h-3.5 w-3.5 shrink-0 text-transparent" />}
          </div>
        ))}
      </div>
      {isReferral && <p className="mt-1.5 text-xs text-slate-400">{t("Етапи рефералів фіксовані (від них залежать бонуси) — можна змінювати назви й кольори.")}</p>}
      <div className="mt-3 flex items-center justify-between">
        {!isReferral
          ? <button onClick={addStage} className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-red-600 hover:bg-red-50"><Plus className="h-4 w-4" /> {t("Додати етап")}</button>
          : <span />}
        <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
      </div>
    </Card>
  );
}

// ─── Companies (our agencies) ─────────────────────────────────────────────────
function CompaniesSettings() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: companies = [], isLoading } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const [name, setName] = useState("");
  const inv = () => { qc.invalidateQueries({ queryKey: ["companies"] }); qc.invalidateQueries({ queryKey: ["factories"] }); qc.invalidateQueries({ queryKey: ["workers"] }); };
  const create = useMutation({ mutationFn: () => post("/companies", { name: name.trim() }), onSuccess: () => { setName(""); inv(); toast.success(t("Додано")); }, onError: (e: any) => toast.error(e.message) });
  const rename = useMutation({ mutationFn: (v: { id: number; name: string }) => patch(`/companies/${v.id}`, { name: v.name }), onSuccess: () => { inv(); toast.success(t("Збережено")); }, onError: (e: any) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: (id: number) => del(`/companies/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  if (isLoading) return <Spinner />;
  return (
    <Card className="p-5">
      <div className="mb-1 text-sm font-semibold text-slate-700">{t("Наші фірми")}</div>
      <p className="mb-4 text-xs text-slate-400">{t("Фірми, від яких ваші працівники працюють у клієнтів (напр. ES, ESO, Klinex). До фірми прив'язуються фабрики та працівники.")}</p>
      <div className="mb-4 flex gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder={t("Назва фірми")} onKeyDown={e => { if (e.key === "Enter" && name.trim()) create.mutate(); }} className="max-w-xs" />
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}><Plus className="h-4 w-4" /> {t("Додати")}</Button>
      </div>
      {!companies.length ? <Empty>{t("Немає фірм")}</Empty> : (
        <div className="space-y-1.5">
          {companies.map(co => <CompanyRow key={co.id} co={co} onRename={(n) => rename.mutate({ id: co.id, name: n })}
            onDelete={async () => { if (await confirm({ title: t("Видалити фірму «{name}»?", { name: co.name }), danger: true, confirmText: t("Видалити") })) remove.mutate(co.id); }} />)}
        </div>
      )}
    </Card>
  );
}

function CompanyRow({ co, onRename, onDelete }: { co: Company; onRename: (n: string) => void; onDelete: () => void }) {
  const t = useT();
  const [name, setName] = useState(co.name);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
      <Input value={name} onChange={e => setName(e.target.value)} className="flex-1" />
      <Badge color="slate">{co.workerCount ?? 0} {t("прац.")}</Badge>
      {name.trim() && name !== co.name && <Button variant="secondary" onClick={() => onRename(name.trim())}>{t("Зберегти")}</Button>}
      <button onClick={onDelete} className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>
    </div>
  );
}

// ─── Document types (required-docs catalogue) ─────────────────────────────────
function DocTypesSettings() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: types = [], isLoading } = useQuery<DocumentType[]>({ queryKey: ["document-types"], queryFn: () => get("/document-types") });
  const [name, setName] = useState("");
  const inv = () => qc.invalidateQueries({ queryKey: ["document-types"] });
  const create = useMutation({ mutationFn: () => post("/document-types", { name: name.trim() }), onSuccess: () => { setName(""); inv(); toast.success(t("Додано")); }, onError: (e: any) => toast.error(e.message) });
  const upd = useMutation({ mutationFn: (v: { id: number; patch: any }) => patch(`/document-types/${v.id}`, v.patch), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: (id: number) => del(`/document-types/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  if (isLoading) return <Spinner />;
  return (
    <Card className="p-5">
      <div className="mb-1 text-sm font-semibold text-slate-700">{t("Обов'язкові документи")}</div>
      <p className="mb-4 text-xs text-slate-400">{t("Список документів, які мають бути у працівників. Редагуйте за змін у законодавстві — він відображається в картці кожного працівника.")}</p>
      <div className="mb-4 flex gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder={t("Назва документа")} onKeyDown={e => { if (e.key === "Enter" && name.trim()) create.mutate(); }} className="max-w-xs" />
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}><Plus className="h-4 w-4" /> {t("Додати")}</Button>
      </div>
      {!types.length ? <Empty>{t("Немає документів")}</Empty> : (
        <div className="space-y-1.5">
          {types.map(d => <DocTypeRow key={d.id} d={d} onSave={p => upd.mutate({ id: d.id, patch: p })}
            onDelete={async () => { if (await confirm({ title: t("Видалити документ «{name}»?", { name: d.name }), danger: true, confirmText: t("Видалити") })) remove.mutate(d.id); }} />)}
        </div>
      )}
    </Card>
  );
}

function DocTypeRow({ d, onSave, onDelete }: { d: DocumentType; onSave: (p: any) => void; onDelete: () => void }) {
  const t = useT();
  const [name, setName] = useState(d.name);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
      <Input value={name} onChange={e => setName(e.target.value)} className="min-w-40 flex-1" />
      <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={d.required} onChange={e => onSave({ required: e.target.checked })} /> {t("обов'язковий")}</label>
      <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={d.hasExpiry} onChange={e => onSave({ hasExpiry: e.target.checked })} /> {t("має термін дії")}</label>
      {name.trim() && name !== d.name && <Button variant="secondary" onClick={() => onSave({ name: name.trim() })}>{t("Зберегти")}</Button>}
      <button onClick={onDelete} className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>
    </div>
  );
}

// ─── Work positions (roles catalogue) ─────────────────────────────────────────
function PositionsSettings() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: positions = [], isLoading } = useQuery<Position[]>({ queryKey: ["positions"], queryFn: () => get("/positions") });
  const [name, setName] = useState("");
  const [color, setColor] = useState("slate");
  const inv = () => { qc.invalidateQueries({ queryKey: ["positions"] }); qc.invalidateQueries({ queryKey: ["workers"] }); };
  const create = useMutation({ mutationFn: () => post("/positions", { name: name.trim(), color }), onSuccess: () => { setName(""); inv(); toast.success(t("Додано")); }, onError: (e: any) => toast.error(e.message) });
  const upd = useMutation({ mutationFn: (v: { id: number; patch: any }) => patch(`/positions/${v.id}`, v.patch), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: (id: number) => del(`/positions/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  if (isLoading) return <Spinner />;
  return (
    <Card className="p-5">
      <div className="mb-1 text-sm font-semibold text-slate-700">{t("Посади (становіска праці)")}</div>
      <p className="mb-4 text-xs text-slate-400">{t("Ролі, які можуть мати працівники (напр. Pracownik produkcji, Wózkowy, Brygadista). Вони відображаються у графіках і замовленнях. Нові ролі можна додавати будь-коли.")}</p>
      <div className="mb-4 flex flex-wrap gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder={t("Назва посади")} onKeyDown={e => { if (e.key === "Enter" && name.trim()) create.mutate(); }} className="max-w-xs" />
        <Select value={color} onChange={e => setColor(e.target.value)} className="w-32">
          {STAGE_COLORS.map(c => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}><Plus className="h-4 w-4" /> {t("Додати")}</Button>
      </div>
      {!positions.length ? <Empty>{t("Немає посад")}</Empty> : (
        <div className="space-y-1.5">
          {positions.map(p => <PositionRow key={p.id} p={p} onSave={patch => upd.mutate({ id: p.id, patch })}
            onDelete={async () => { if (await confirm({ title: t("Видалити посаду «{name}»?", { name: p.name }), danger: true, confirmText: t("Видалити") })) remove.mutate(p.id); }} />)}
        </div>
      )}
    </Card>
  );
}

function PositionRow({ p, onSave, onDelete }: { p: Position; onSave: (patch: any) => void; onDelete: () => void }) {
  const t = useT();
  const [name, setName] = useState(p.name);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass(p.color)}`}><span className={`h-2 w-2 rounded-full ${dotClass(p.color)}`} />{p.name}</span>
      <Input value={name} onChange={e => setName(e.target.value)} className="min-w-32 flex-1" />
      <Select value={p.color} onChange={e => onSave({ color: e.target.value })} className="w-28">
        {STAGE_COLORS.map(c => <option key={c} value={c}>{c}</option>)}
      </Select>
      {name.trim() && name !== p.name && <Button variant="secondary" onClick={() => onSave({ name: name.trim() })}>{t("Зберегти")}</Button>}
      <button onClick={onDelete} className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>
    </div>
  );
}

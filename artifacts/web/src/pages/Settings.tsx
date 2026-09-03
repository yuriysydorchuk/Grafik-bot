import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Percent, Plus, Trash2, GripVertical, ChevronUp, ChevronDown, Landmark, Scale, Check, ShieldQuestion, History } from "lucide-react";
import { toast } from "sonner";
import { get, put, post, patch, del, upload, type Funnel, type FunnelStage, type Company, type DocumentType, type Position, type Me, type Factory, type DocCategory, type LegalRule } from "../lib/api";
import { Card, Spinner, Input, Label, Button, Select, Badge, Empty, Modal, Textarea } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { STAGE_COLORS, dotClass, badgeClass } from "../lib/colors";
import { DOC_TYPE_ICONS, DOC_TYPE_ICON_KEYS, docTypeIcon } from "../lib/docTypeIcons";
import { DOC_CATEGORY_LABEL, NAT_GROUP_LABEL } from "../lib/legality";
import { NATIONALITIES } from "../lib/nationality";
import { can } from "../lib/roles";
import Factories from "./Factories";
import Admins from "./Admins";

type TabId = "general" | "companies" | "factories" | "positions" | "documents" | "legalRules" | "funnels" | "email" | "gratyfikant" | "users";
const TABS: { id: TabId; label: string; show: (me: Me) => boolean }[] = [
  { id: "general", label: "Фінанси / ставки", show: m => can(m, "viewFinance") },
  { id: "companies", label: "Фірми", show: m => can(m, "editData") },
  { id: "factories", label: "Фабрики", show: m => can(m, "editData") },
  { id: "positions", label: "Посади", show: m => can(m, "editData") },
  { id: "documents", label: "Документи", show: m => can(m, "editData") },
  { id: "legalRules", label: "Правила легальності", show: m => can(m, "legalization") },
  { id: "funnels", label: "Воронки рекрутації", show: m => can(m, "editData") },
  { id: "email", label: "Email-шаблони", show: m => can(m, "editData") },
  { id: "gratyfikant", label: "Gratyfikant", show: m => can(m, "svodniSensitive") },
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

      {active === "general" && <div className="space-y-4"><FinanceRates /><SvodniMinRates /></div>}
      {active === "companies" && <CompaniesSettings />}
      {active === "factories" && <Factories />}
      {active === "positions" && <PositionsSettings />}
      {active === "documents" && <DocTypesSettings />}
      {active === "legalRules" && <LegalRulesSettings />}
      {active === "funnels" && <FunnelsSettings />}
      {active === "email" && <EmailTemplatesSettings />}
      {active === "gratyfikant" && <GratyfikantSettings />}
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

// ─── Сводні: мінімальна ставка року (księgowa пара) ──────────────────────────
function SvodniMinRates() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ minNetto: number; minBrutto: number }>({
    queryKey: ["svodni-settings"], queryFn: () => get("/svodni/settings"),
  });
  const [v, setV] = useState<{ minNetto?: string; minBrutto?: string }>({});
  const dirty = Object.keys(v).length > 0;
  const save = useMutation({
    mutationFn: () => put("/svodni/settings", {
      minNetto: v.minNetto ?? data?.minNetto, minBrutto: v.minBrutto ?? data?.minBrutto,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["svodni-settings"] });
      qc.invalidateQueries({ queryKey: ["svodni"] });
      setV({});
      toast.success(t("Мінімальні ставки збережено"));
    },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Card className="p-5">
      <div className="mb-1 text-sm font-semibold text-slate-700">{t("Сводні: мінімальна ставка року")}</div>
      <p className="mb-4 text-xs text-slate-400">{t("Księgowa пара: конто декларується по цій ставці нетто (зараз 25,35/31,40). Зміна одразу впливає на розклад конто/готівки у сводних.")}</p>
      {isLoading ? <Spinner /> : (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label>{t("Мін. ставка нетто (zł/год)")}</Label>
            <Input className="w-36" inputMode="decimal" value={v.minNetto ?? String(data?.minNetto ?? "")}
              onChange={e => setV(p => ({ ...p, minNetto: e.target.value }))} />
          </div>
          <div>
            <Label>{t("Мін. ставка брутто (zł/год)")}</Label>
            <Input className="w-36" inputMode="decimal" value={v.minBrutto ?? String(data?.minBrutto ?? "")}
              onChange={e => setV(p => ({ ...p, minBrutto: e.target.value }))} />
          </div>
          <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
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
  const [showRegistry, setShowRegistry] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
      <Input value={name} onChange={e => setName(e.target.value)} className="flex-1" />
      <Badge color="slate">{co.workerCount ?? 0} {t("прац.")}</Badge>
      {name.trim() && name !== co.name && <Button variant="secondary" onClick={() => onRename(name.trim())}>{t("Зберегти")}</Button>}
      <button onClick={() => setShowRegistry(true)} className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Реквізити (KRS/REGON/адреса) — для документів")}><Landmark className="h-4 w-4" /></button>
      <button onClick={onDelete} className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>
      {showRegistry && <CompanyRegistryModal co={co} onClose={() => setShowRegistry(false)} />}
    </div>
  );
}

// Реквізити KRS — {%Nazwa firmy%}/{%NIP firmy%}/{%KRS firmy%}/{%REGON firmy%}/
// адреса/{%Reprezentant firmy%} у шаблонах Umowa (worker-docs-signing). Дані
// беруться з офіційного реєстру KRS, не вигадуються.
function CompanyRegistryModal({ co, onClose }: { co: Company; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [f, setF] = useState({
    legalName: co.legalName ?? "", nip: co.nip ?? "", krs: co.krs ?? "", regon: co.regon ?? "",
    street: co.street ?? "", houseNumber: co.houseNumber ?? "", postalCode: co.postalCode ?? "", city: co.city ?? "",
    representative: co.representative ?? "",
  });
  const save = useMutation({
    mutationFn: () => patch(`/companies/${co.id}`, f),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["companies"] }); toast.success(t("Збережено")); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(v => ({ ...v, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title={t("Реквізити — {name}", { name: co.name })}>
      <div className="space-y-3">
        <p className="text-xs text-slate-400">{t("Підставляються в Umowa та інші документи (бібліотека шаблонів). Джерело — офіційний реєстр KRS.")}</p>
        <div><Label>{t("Повна юридична назва")}</Label><Input value={f.legalName} onChange={set("legalName")} placeholder="Eurosupport Group Sp. z o.o." /></div>
        <div className="grid grid-cols-3 gap-2">
          <div><Label>NIP</Label><Input value={f.nip} onChange={set("nip")} /></div>
          <div><Label>KRS</Label><Input value={f.krs} onChange={set("krs")} /></div>
          <div><Label>REGON</Label><Input value={f.regon} onChange={set("regon")} /></div>
        </div>
        <div className="grid grid-cols-[2fr_1fr] gap-2">
          <div><Label>{t("Вулиця")}</Label><Input value={f.street} onChange={set("street")} /></div>
          <div><Label>{t("Номер")}</Label><Input value={f.houseNumber} onChange={set("houseNumber")} /></div>
        </div>
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          <div><Label>{t("Індекс")}</Label><Input value={f.postalCode} onChange={set("postalCode")} placeholder="20-076" /></div>
          <div><Label>{t("Місто")}</Label><Input value={f.city} onChange={set("city")} /></div>
        </div>
        <div><Label>{t("Представник (ПІБ + посада)")}</Label><Input value={f.representative} onChange={set("representative")} placeholder="Alona Kovalchuk – Prezes Zarządu" /></div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
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
  const Icon = docTypeIcon(d.icon);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-slate-400" />
        <Input value={name} onChange={e => setName(e.target.value)} className="min-w-40 flex-1" />
        <Select value={d.icon ?? ""} onChange={e => onSave({ icon: e.target.value || null })} className="w-40" title={t("Іконка")}>
          <option value="">{t("— без іконки —")}</option>
          {DOC_TYPE_ICON_KEYS.map(k => <option key={k} value={k}>{t(DOC_TYPE_ICONS[k]!.label)}</option>)}
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={d.required} onChange={e => onSave({ required: e.target.checked })} /> {t("обов'язковий")}</label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={d.hasExpiry} onChange={e => onSave({ hasExpiry: e.target.checked })} /> {t("має термін дії")}</label>
        {name.trim() && name !== d.name && <Button variant="secondary" onClick={() => onSave({ name: name.trim() })}>{t("Зберегти")}</Button>}
        {!d.isSystem && <button onClick={onDelete} className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>}
      </div>
      {/* Легалізація (02.09.2026): що документ «дає» + строки + для кого. code — стабільний ключ сіду, не правиться. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
        {d.code && <span className="rounded bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-400" title={t("Стабільний ключ (не редагується)")}>{d.code}</span>}
        <Select value={d.category} onChange={e => onSave({ category: e.target.value })} className="w-36" title={t("Категорія")}>
          {(Object.keys(DOC_CATEGORY_LABEL) as DocCategory[]).map(c => <option key={c} value={c}>{t(DOC_CATEGORY_LABEL[c])}</option>)}
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={d.grantsStay} onChange={e => onSave({ grantsStay: e.target.checked })} /> {t("підстава перебування")}</label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={d.grantsWork} onChange={e => onSave({ grantsWork: e.target.checked })} /> {t("підстава праці")}</label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={d.requiresEmployerMatch} onChange={e => onSave({ requiresEmployerMatch: e.target.checked })} /> {t("на роботодавця")}</label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          {t("нагадувати за")}
          <Input type="number" min={0} value={d.renewalLeadDays ?? ""} placeholder="—"
            onChange={e => onSave({ renewalLeadDays: e.target.value === "" ? null : Number(e.target.value) })} className="w-16 py-1 text-center" />
          {t("дн.")}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          {t("типовий строк")}
          <Input type="number" min={0} value={d.defaultValidityDays ?? ""} placeholder="—"
            onChange={e => onSave({ defaultValidityDays: e.target.value === "" ? null : Number(e.target.value) })} className="w-16 py-1 text-center" />
          {t("дн.")}
        </label>
        <NatMultiSelect value={d.appliesToNationalities} onChange={v => onSave({ appliesToNationalities: v })} />
        <label className="ml-auto flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <input type="checkbox" checked={d.isActive} onChange={e => onSave({ isActive: e.target.checked })} /> {t("активний")}
        </label>
      </div>
    </div>
  );
}

// Мультивибір національностей (групи ua/eu/non_eu + каталог) для appliesToNationalities.
// Порожньо = застосовується до всіх. Компактний dropdown у стилі SearchableSelect.
function NatMultiSelect({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);
  const sel = new Set(value ?? []);
  const toggle = (v: string) => {
    const n = new Set(sel);
    n.has(v) ? n.delete(v) : n.add(v);
    onChange(n.size === 0 ? null : [...n]);
  };
  const label = !value || value.length === 0 ? t("усі") : `${value.length} ${t("обрано")}`;
  return (
    <div ref={boxRef} className="relative">
      <button type="button" onClick={() => setOpen(v => !v)}
        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:border-slate-400">
        {t("Громадянство")}: {label}
      </button>
      {open && (
        <div className="absolute z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t("Групи")}</div>
          {Object.entries(NAT_GROUP_LABEL).map(([g, lbl]) => (
            <label key={g} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
              <input type="checkbox" checked={sel.has(g)} onChange={() => toggle(g)} /> {t(lbl)}
            </label>
          ))}
          <div className="mb-1 mt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t("Каталог")}</div>
          {NATIONALITIES.map(n => (
            <label key={n.value} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
              <input type="checkbox" checked={sel.has(n.value)} onChange={() => toggle(n.value)} /> {n.flag} {t(n.label)}
            </label>
          ))}
          <button type="button" onClick={() => onChange(null)} className="mt-1 w-full rounded px-1.5 py-1 text-left text-xs text-red-600 hover:bg-red-50">{t("Скинути (= усі)")}</button>
        </div>
      )}
    </div>
  );
}

// ─── Правила легальності (legal_rules, cap `legalization`) ───────────────────
// Версійований журнал: попередня чинна версія коду автоматично закривається
// датою нової (POST /legal-rules). Тут — тільки перегляд+нова версія+точкові
// PATCH (verified/note/source/isActive/effectiveTo); умови/код/kind/вісь
// правляться лише новою версією.
const RULE_KIND_LABEL: Record<LegalRule["kind"], string> = {
  basis_by_nationality: "підстава за громадянством", requirement: "вимога", obligation: "обов'язок",
  precedence: "пріоритет", global: "глобальний параметр",
};
const RULE_AXIS_LABEL: Record<string, string> = { stay: "Перебування", work: "Праця", both: "обидві", none: "—" };
const today = () => new Date().toLocaleDateString("sv-SE");

function LegalRulesSettings() {
  const t = useT();
  const qc = useQueryClient();
  const { data: rules = [], isLoading } = useQuery<LegalRule[]>({ queryKey: ["legal-rules"], queryFn: () => get("/legal-rules") });
  const [modal, setModal] = useState<{ mode: "newRule" } | { mode: "newVersion"; rule: LegalRule } | null>(null);

  // рядки вже відсортовані бекендом по code, effectiveFrom desc — групуємо по code, зберігаючи порядок
  const groups: [string, LegalRule[]][] = [];
  { const m = new Map<string, LegalRule[]>(); for (const r of rules) { if (!m.has(r.code)) { m.set(r.code, []); groups.push([r.code, m.get(r.code)!]); } m.get(r.code)!.push(r); } }

  const globalUkr = rules.find(r => r.code === "global.ukr_status_end" && r.effectiveTo === null && r.effectiveFrom <= today());

  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-slate-500">
          {t("Джерело правди для движка легальності (громадянство, обов'язки роботодавця, строки, глобальні дати). Кожна зміна — нова версія з датою «діє з»; попередня закривається автоматично. Неперевірене правило позначає результат «потребує перевірки».")}
        </p>
        <Button onClick={() => setModal({ mode: "newRule" })}><Plus className="h-4 w-4" /> {t("Нове правило")}</Button>
      </div>

      {globalUkr && (
        <Card className="flex flex-wrap items-center gap-3 border-amber-200 bg-amber-50/60 p-3 text-sm">
          <Scale className="h-4 w-4 shrink-0 text-amber-600" />
          <span className="text-amber-800">
            {t("Глобальна дата кінця статусу UKR: {date} (правило global.ukr_status_end)", { date: String(globalUkr.conditions?.date ?? "—") })}
          </span>
          <Button variant="secondary" className="ml-auto" onClick={() => setModal({ mode: "newVersion", rule: globalUkr })}>{t("Змінити")}</Button>
        </Card>
      )}

      {!groups.length ? <Empty>{t("Немає правил")}</Empty> : (
        <div className="space-y-2">
          {groups.map(([code, versions]) => (
            <RuleGroup key={code} code={code} versions={versions} onNewVersion={r => setModal({ mode: "newVersion", rule: r })} />
          ))}
        </div>
      )}

      {modal && (
        <RuleModal mode={modal.mode} rule={modal.mode === "newVersion" ? modal.rule : undefined}
          onClose={() => setModal(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["legal-rules"] }); setModal(null); }} />
      )}
    </div>
  );
}

function RuleGroup({ code, versions, onNewVersion }: { code: string; versions: LegalRule[]; onNewVersion: (r: LegalRule) => void }) {
  const t = useT();
  const [showOld, setShowOld] = useState(false);
  const td = today();
  const current = versions.find(r => r.effectiveTo === null && r.effectiveFrom <= td) ?? versions[0]!;
  const old = versions.filter(r => r.id !== current.id);
  return (
    <Card className="overflow-hidden">
      <RuleRow r={current} isCurrent onNewVersion={() => onNewVersion(current)} />
      {old.length > 0 && (
        <>
          <button onClick={() => setShowOld(v => !v)} className="flex w-full items-center gap-1.5 border-t border-slate-100 px-3 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-50">
            <History className="h-3.5 w-3.5" /> {showOld ? t("Сховати старі версії") : t("Старі версії")} ({old.length})
          </button>
          {showOld && old.map(r => <RuleRow key={r.id} r={r} onNewVersion={() => onNewVersion(r)} />)}
        </>
      )}
    </Card>
  );
}

function RuleRow({ r, isCurrent, onNewVersion }: { r: LegalRule; isCurrent?: boolean; onNewVersion: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [note, setNote] = useState(r.note ?? "");
  const inv = () => qc.invalidateQueries({ queryKey: ["legal-rules"] });
  const patchRule = useMutation({ mutationFn: (p: any) => patch(`/legal-rules/${r.id}`, p), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  return (
    <div className={`flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-slate-100 px-3 py-2 text-sm first:border-t-0 ${isCurrent ? "" : "bg-slate-50/60 text-slate-500"}`}>
      <div className="min-w-0">
        <div className="font-mono text-xs font-semibold text-slate-700">{r.code}</div>
        <div className="text-xs text-slate-400">{t(RULE_KIND_LABEL[r.kind])} · {t(RULE_AXIS_LABEL[r.axis ?? "none"] ?? r.axis ?? "—")}</div>
      </div>
      <code className="min-w-0 flex-1 truncate rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600" title={JSON.stringify(r.conditions)}>{JSON.stringify(r.conditions)}</code>
      <div className="shrink-0 text-xs text-slate-500">{r.effectiveFrom} → {r.effectiveTo ?? t("чинне")}</div>
      <div className="shrink-0 text-xs">
        {r.source ? (/^https?:\/\//.test(r.source) ? <a href={r.source} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{t("джерело")}</a> : <span className="text-slate-500">{r.source}</span>) : <span className="text-slate-300">—</span>}
      </div>
      <div className="shrink-0">
        {r.verifiedAt ? (
          <button onClick={() => patchRule.mutate({ verified: false })} className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100" title={t("Зняти підтвердження")}>
            <Check className="h-3 w-3" /> {new Date(r.verifiedAt).toLocaleDateString()}
          </button>
        ) : (
          <button onClick={() => patchRule.mutate({ verified: true })} className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100">
            <ShieldQuestion className="h-3 w-3" /> {t("не перевірено — Підтвердити")}
          </button>
        )}
      </div>
      <Input value={note} onChange={e => setNote(e.target.value)} onBlur={() => note !== (r.note ?? "") && patchRule.mutate({ note: note.trim() || null })}
        placeholder={t("примітка")} className="w-40 py-1 text-xs" />
      <label className="flex shrink-0 items-center gap-1 text-xs text-slate-500">
        <input type="checkbox" checked={r.isActive} onChange={e => patchRule.mutate({ isActive: e.target.checked })} /> {t("активне")}
      </label>
      <Button variant="secondary" className="ml-auto shrink-0 px-2 py-1 text-xs" onClick={onNewVersion}>{t("Нова версія")}</Button>
    </div>
  );
}

// Модалка створення нового правила (mode "newRule") або нової версії наявного
// (mode "newVersion" — code/kind/axis успадковуються, умови попередньо заповнені).
function RuleModal({ mode, rule, onClose, onSaved }: { mode: "newRule" | "newVersion"; rule: LegalRule | undefined; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [code, setCode] = useState(rule?.code ?? "");
  const [kind, setKind] = useState<LegalRule["kind"]>(rule?.kind ?? "requirement");
  const [axis, setAxis] = useState<string>(rule?.axis ?? "none");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [conditions, setConditions] = useState(JSON.stringify(rule?.conditions ?? {}, null, 2));
  const [source, setSource] = useState(rule?.source ?? "");
  const [note, setNote] = useState("");
  const [verified, setVerified] = useState(false);
  const create = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try { parsed = JSON.parse(conditions); } catch { throw new Error(t("Умови — некоректний JSON")); }
      return post("/legal-rules", {
        code: code.trim(), kind, axis: axis === "none" ? null : axis, conditions: parsed,
        effectiveFrom, effectiveTo: effectiveTo || undefined, source: source.trim() || undefined, note: note.trim() || undefined, verified,
      });
    },
    onSuccess: () => { toast.success(t("Версію збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={mode === "newVersion" ? t("Нова версія — {code}", { code }) : t("Нове правило")}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>{t("Код (група.назва)")}</Label>
            <Input value={code} onChange={e => setCode(e.target.value)} placeholder="stay.pl_citizen" disabled={mode === "newVersion"} />
          </div>
          <div>
            <Label>{t("Вид")}</Label>
            <Select value={kind} onChange={e => setKind(e.target.value as LegalRule["kind"])} disabled={mode === "newVersion"}>
              {(Object.keys(RULE_KIND_LABEL) as LegalRule["kind"][]).map(k => <option key={k} value={k}>{t(RULE_KIND_LABEL[k])}</option>)}
            </Select>
          </div>
        </div>
        <div>
          <Label>{t("Вісь")}</Label>
          <Select value={axis} onChange={e => setAxis(e.target.value)} className="w-40">
            {["none", "stay", "work", "both"].map(a => <option key={a} value={a}>{t(RULE_AXIS_LABEL[a]!)}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{t("Діє з")}</Label><Input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></div>
          <div><Label>{t("Діє до (необов'язково)")}</Label><Input type="date" value={effectiveTo} onChange={e => setEffectiveTo(e.target.value)} /></div>
        </div>
        <div>
          <Label>{t("Умови (JSON)")}</Label>
          <Textarea value={conditions} onChange={e => setConditions(e.target.value)} rows={6} className="font-mono text-xs" />
        </div>
        <div><Label>{t("Джерело (URL або назва акта)")}</Label><Input value={source} onChange={e => setSource(e.target.value)} /></div>
        <div><Label>{t("Примітка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} /></div>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} /> {t("перевірено")}
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={create.isPending} disabled={!code.trim()} onClick={() => create.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
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

// ─── Email templates (client-facing letters) ─────────────────────────────────
type EmailTpl = { subject: string; body: string };

function EmailTemplatesSettings() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ schedule: EmailTpl; defaults: { schedule: EmailTpl } }>({
    queryKey: ["email-templates"], queryFn: () => get("/email-templates"),
  });
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (data && !loaded) { setSubject(data.schedule.subject); setBody(data.schedule.body); setLoaded(true); }
  }, [data, loaded]);
  const save = useMutation({
    mutationFn: () => put("/email-templates", { schedule: { subject, body } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["email-templates"] }); toast.success(t("Збережено")); },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !data) return <Spinner />;
  return (
    <Card className="max-w-2xl p-4">
      <h3 className="mb-1 text-sm font-semibold text-slate-700">{t("Лист із графіком клієнту")}</h3>
      <p className="mb-4 text-xs text-slate-500">{t("Використовується при надсиланні графіку на фабрику (день або тиждень). Лист — польською; графік додається Excel-файлом.")}</p>
      <div className="space-y-3">
        <div>
          <Label>{t("Тема листа")}</Label>
          <Input value={subject} onChange={e => setSubject(e.target.value)} />
        </div>
        <div>
          <Label>{t("Текст листа")}</Label>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={13}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-red-300 focus:outline-none" />
        </div>
        <p className="text-xs text-slate-400">{t("Плейсхолдери: {data} — дата дня або період тижня, {fabryka} — назва фабрики.")}</p>
        <div className="flex gap-2">
          <Button loading={save.isPending} disabled={!subject.trim() || !body.trim()} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
          <Button variant="secondary" onClick={() => { setSubject(data.defaults.schedule.subject); setBody(data.defaults.schedule.body); }}>{t("Скинути до стандартного")}</Button>
        </div>
      </div>
    </Card>
  );
}

// ─── Gratyfikant nexo: імпорт вивантажень (умови / картотека з PESEL) ─────────
// «Перевірити» = dry-run: бекенд віддає КОЖНУ зміну окремо (ключ + стара→нова +
// спосіб матчу). Точні збіги відзначені одразу, нечіткі (fuzzy) — зняті й чекають
// ручного підтвердження. «Застосувати» шле лише схвалені ключі.
type GratChange = { key: string; kind: "pesel" | "name"; workerId: number; our: string; to: string; method: string };
type GratLink = { key: string; nexoName: string; workerId: number; workerName: string; method: string };
function GratyfikantSettings() {
  const t = useT();
  const qc = useQueryClient();
  const { data: status } = useQuery<{
    firms: Record<string, { umowy: number; linked: number; importedAt: string | null }>;
    activeWorkers: number; withPesel: number;
  }>({ queryKey: ["gratyfikant-status"], queryFn: () => get("/gratyfikant/status") });
  const [firm, setFirm] = useState("ES");
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<any>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const items: (GratChange | GratLink)[] = report?.kind === "kartoteka" ? (report.changes ?? []) : (report?.links ?? []);
  const run = useMutation({
    mutationFn: async (dry: boolean) => {
      const form = new FormData();
      form.append("file", file!);
      form.append("firm", firm);
      if (dry) form.append("dry", "1");
      else form.append("approved", JSON.stringify([...approved]));
      return upload(`/gratyfikant/import${dry ? "?dry=1" : ""}`, form);
    },
    onSuccess: (r: any, dry) => {
      setReport(r);
      if (dry) {
        // дефолт: точні збіги схвалені, нечіткі — ні (підтверджуєш руками)
        const list: (GratChange | GratLink)[] = r.kind === "kartoteka" ? (r.changes ?? []) : (r.links ?? []);
        setApproved(new Set(list.filter(i => i.method !== "fuzzy").map(i => i.key)));
      } else {
        toast.success(t("Імпортовано"));
        qc.invalidateQueries({ queryKey: ["gratyfikant-status"] });
      }
    },
    onError: (e: any) => toast.error(e.message),
  });
  const toggle = (key: string) => setApproved(prev => {
    const n = new Set(prev);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });
  const descr = (i: GratChange | GratLink) =>
    "our" in i
      ? `${i.our} → ${i.kind === "pesel" ? "PESEL " : ""}${i.to}`
      : `${i.nexoName} → ${t("профіль")} ${i.workerName}`;
  return (
    <div className="max-w-3xl space-y-4">
      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-700">{t("Імпорт з Gratyfikant nexo")}</h3>
        <p className="mb-3 text-xs text-slate-500">
          {t("Завантаж вивантаження з nexo: список умов (Pracownik / Nr umowy / Od–Do dnia) або картотеку працівників з PESEL. Тип файлу визначається автоматично; матчинг з профілями — по іменах з усіма запобіжниками. Ручні значення не перетираються.")}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label>{t("Фірма (podmiot)")}</Label>
            <Select value={firm} onChange={e => setFirm(e.target.value)}>
              {["ES", "ESO", "Klinex"].map(f => <option key={f} value={f}>{f}</option>)}
            </Select>
          </div>
          <div>
            <Label>{t("Файл (xlsx)")}</Label>
            <input type="file" accept=".xlsx" onChange={e => { setFile(e.target.files?.[0] ?? null); setReport(null); setApproved(new Set()); }}
              className="block text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-200" />
          </div>
          <Button variant="secondary" disabled={!file} loading={run.isPending} onClick={() => run.mutate(true)}>{t("Перевірити")}</Button>
          <Button disabled={!file || !report || report.applied || (items.length > 0 && approved.size === 0)}
            loading={run.isPending} onClick={() => run.mutate(false)}>
            {t("Застосувати")}{items.length ? ` (${approved.size})` : ""}
          </Button>
        </div>
        {report && (
          <div className="mt-4 space-y-2">
            <div className="text-sm font-medium text-slate-700">
              {report.kind === "umowy" ? t("Список умов") : t("Картотека з PESEL")} · {report.firm} · {report.inFile} {t("рядків")}
              {report.applied ? ` · ✅ ${t("застосовано")}: ${report.appliedCount ?? report.linkedToWorkers}` : ` · ${t("превʼю (нічого не записано)")}`}
            </div>
            {report.conflicts?.length > 0 && (
              <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{t("Конфлікти PESEL")}: {report.conflicts.join("; ")}</div>
            )}
            {report.kind === "umowy" && (
              <div className="text-xs text-slate-500">{t("Знімок умов буде замінено")}: {report.inFile} {t("умов")} · {t("нижче — привʼязки до профілів (не схвалена = умова без привʼязки)")} · {t("без збігу")}: {report.unlinked}</div>
            )}
            {report.kind === "kartoteka" && (
              <div className="text-xs text-slate-500">{t("Змін до запису")}: {items.length} · {t("не знайдені в наших профілях")}: {report.unmatchedInFile}</div>
            )}
            {!report.applied && items.length > 0 && (
              <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <tbody>
                    {items.map(i => (
                      <tr key={i.key} className={`border-b border-slate-100 last:border-0 ${approved.has(i.key) ? "" : "opacity-60"} ${i.method === "fuzzy" ? "bg-amber-50/60" : ""}`}>
                        <td className="w-8 px-2 py-1.5"><input type="checkbox" checked={approved.has(i.key)} onChange={() => toggle(i.key)} /></td>
                        <td className="px-2 py-1.5">{descr(i)}</td>
                        <td className="px-2 py-1.5 text-right">
                          {i.method === "fuzzy"
                            ? <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">{t("нечіткий збіг — підтверди")}</span>
                            : <span className="text-[10px] text-slate-400">{i.method === "exact" ? t("точний") : t("перестановка/скорочення")}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!report.applied && items.length === 0 && (
              <div className="text-sm text-slate-500">{t("Змін немає — все вже актуальне.")}</div>
            )}
          </div>
        )}
      </Card>
      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">{t("Стан даних")}</h3>
        {status ? (
          <div className="space-y-1 text-sm text-slate-600">
            <div>{t("Активних працівників")}: {status.activeWorkers} · {t("з PESEL")}: <b>{status.withPesel}</b></div>
            {Object.entries(status.firms).map(([f, s]) => (
              <div key={f}>
                {f}: {s.umowy ? `${s.umowy} ${t("умов")}, ${t("привʼязано")} ${s.linked}` : t("умови ще не завантажені")}
                {s.importedAt ? ` · ${new Date(s.importedAt).toLocaleDateString()}` : ""}
              </div>
            ))}
          </div>
        ) : <Spinner />}
      </Card>
    </div>
  );
}

// Налаштування → praca.gov.pl (13.10.2026): робот подачі powiadomienia PSZ-PPWPU.
// Розділи: Акаунт (profil zaufany власника; головний бачить усіх), Фірми (1.2/1.3/4/PKD/KRAZ),
// Фабрики (3.4 TERYT + назва посади/KZiS за замовчуванням і по посадах фабрики), Посади (KZiS),
// Історія подач. Довідкові поля правляться на місці через /praca-gov/reference (cap legalization).
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2, Play, XCircle, RefreshCw, Pencil, Plus, ChevronDown, ChevronRight, KeyRound, Building2, Factory as FactoryIcon, Briefcase, History } from "lucide-react";
import { get, post, patch, del, upload } from "../lib/api";
import { Card, Spinner, Input, Label, Button, Badge, Empty, Modal, cn } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";

interface PzAccount { id: number; adminId: number; adminName: string | null; label: string | null; login: string; companyIds: number[]; contextName: string | null; signerFunction: string | null; poaFilePath: string | null; isActive: boolean; lastLoginAt: string | null; lastError: string | null; busy: boolean; own: boolean }
interface Submission { id: number; kind: string; accountId: number | null; workerId: number | null; status: string; step: string | null; error: string | null; previewFile: string | null; screenshots: string[]; createdAt: string; finishedAt: string | null; payload?: { workerName?: string; companyName?: string } | null }
interface RefCompany { id: number; name: string; legalName: string | null; city: string | null; pkd: string | null; kraz: string | null; contactEmail: string | null; contactPhone: string | null; headcountEmployment: number | null; headcountCivil: number | null }
interface RefFactoryPosition { positionId: number; name: string | null; contractDuties: string | null; uaStanowisko: string | null; kzisCode: string | null }
interface RefFactory { id: number; name: string; address: string | null; city: string | null; companyName: string | null; contractDuties: string | null; addrPostalCode: string | null; addrWojewodztwo: string | null; addrPowiat: string | null; addrGmina: string | null; addrMiejscowosc: string | null; addrStreet: string | null; addrHouseNo: string | null; addrAptNo: string | null; uaStanowisko: string | null; uaKzisCode: string | null; positions: RefFactoryPosition[] }
interface RefPosition { id: number; name: string; kzisCode: string | null }
interface Reference { companies: RefCompany[]; factories: RefFactory[]; positions: RefPosition[] }

const STATUS_COLOR: Record<string, "slate" | "green" | "amber" | "blue" | "rose"> = { queued: "slate", running: "blue", awaiting_code: "amber", review: "amber", signing: "blue", submitted: "green", done: "green", failed: "rose", cancelled: "slate" };
const STATUS_LABEL: Record<string, string> = { queued: "у черзі", running: "виконується", awaiting_code: "чекає код SMS", review: "на перегляді", signing: "підпис", submitted: "подано", done: "готово", failed: "помилка", cancelled: "скасовано" };
const OPEN = new Set(["queued", "running", "awaiting_code", "review", "signing"]);
type Tab = "account" | "companies" | "factories" | "positions" | "history";

export function PracaGovSettings() {
  const t = useT();
  const { data: status } = useQuery<{ ready: boolean }>({ queryKey: ["praca-gov-status"], queryFn: () => get("/praca-gov/status") });
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get("submission") ? "history" : "account"));
  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "account", label: t("Акаунт"), icon: <KeyRound className="h-3.5 w-3.5" /> },
    { id: "companies", label: t("Фірми"), icon: <Building2 className="h-3.5 w-3.5" /> },
    { id: "factories", label: t("Фабрики"), icon: <FactoryIcon className="h-3.5 w-3.5" /> },
    { id: "positions", label: t("Посади"), icon: <Briefcase className="h-3.5 w-3.5" /> },
    { id: "history", label: t("Історія подач"), icon: <History className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-800">{t("Робот подачі powiadomienia на praca.gov.pl")}</h3>
          <p className="mt-0.5 max-w-3xl text-sm text-slate-500">{t("Робот входить вашим profilem zaufanym, заповнює форму PSZ-PPWPU з даних профілю й цих довідників, показує Wydruk і зупиняється перед підписом. Код SMS просить у боті.")}</p>
        </div>
        {status && (status.ready ? <Badge color="green">{t("шифрування ввімкнено")}</Badge> : <Badge color="rose">{t("PZ_SECRET не задано на сервері")}</Badge>)}
      </div>
      <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
        {TABS.map(x => <button key={x.id} onClick={() => setTab(x.id)} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition", tab === x.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>{x.icon}{x.label}</button>)}
      </div>
      {tab === "account" && <AccountsTab ready={status?.ready !== false} />}
      {tab === "companies" && <CompaniesTab />}
      {tab === "factories" && <FactoriesTab />}
      {tab === "positions" && <PositionsTab />}
      {tab === "history" && <HistoryTab />}
    </div>
  );
}

// ── спільні елементи ──────────────────────────────────────────────────────────
function Cell({ value, onSave, placeholder, type, w, mono }: { value: string | number | null | undefined; onSave: (v: string) => void; placeholder?: string; type?: string; w?: string; mono?: boolean }) {
  const [v, setV] = useState(value == null ? "" : String(value));
  useEffect(() => { setV(value == null ? "" : String(value)); }, [value]);
  return <input value={v} type={type ?? "text"} placeholder={placeholder} onChange={e => setV(e.target.value)} onBlur={() => { if (v !== (value == null ? "" : String(value))) onSave(v); }}
    className={cn("rounded-md border border-transparent bg-slate-50 px-2 py-1 text-sm text-slate-800 placeholder:text-slate-300 hover:border-slate-200 focus:border-red-400 focus:bg-white focus:outline-none", mono && "font-mono", w ?? "w-full")} />;
}
function useReference() {
  const qc = useQueryClient();
  const q = useQuery<Reference>({ queryKey: ["praca-gov-reference"], queryFn: () => get("/praca-gov/reference") });
  const inv = () => qc.invalidateQueries({ queryKey: ["praca-gov-reference"] });
  const err = (e: any) => toast.error(e.message);
  const company = useMutation({ mutationFn: (v: { id: number; patch: any }) => patch(`/praca-gov/reference/company/${v.id}`, v.patch), onSuccess: inv, onError: err });
  const factory = useMutation({ mutationFn: (v: { id: number; patch: any }) => patch(`/praca-gov/reference/factory/${v.id}`, v.patch), onSuccess: inv, onError: err });
  const factoryPos = useMutation({ mutationFn: (v: { id: number; positionId: number; patch: any }) => patch(`/praca-gov/reference/factory/${v.id}/position/${v.positionId}`, v.patch), onSuccess: inv, onError: err });
  const position = useMutation({ mutationFn: (v: { id: number; patch: any }) => patch(`/praca-gov/reference/position/${v.id}`, v.patch), onSuccess: inv, onError: err });
  return { ...q, company, factory, factoryPos, position };
}
const TH = "px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400";
const TD = "px-2 py-1 align-middle";

// ── Акаунт ────────────────────────────────────────────────────────────────────
function AccountsTab({ ready }: { ready: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const confirm = useConfirm();
  const { data: accounts = [], isLoading } = useQuery<PzAccount[]>({ queryKey: ["praca-gov-accounts"], queryFn: () => get("/praca-gov/accounts"), refetchInterval: 5000 });
  const inv = () => qc.invalidateQueries({ queryKey: ["praca-gov-accounts"] });
  const [edit, setEdit] = useState<PzAccount | null | "new">(null);
  const [sel, setSel] = useState<number | null>(null);
  const remove = useMutation({ mutationFn: (id: number) => del(`/praca-gov/accounts/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  const testLogin = useMutation({ mutationFn: (id: number) => post<{ submissionId: number }>(`/praca-gov/accounts/${id}/test-login`), onSuccess: r => { setSel(r.submissionId); inv(); }, onError: (e: any) => toast.error(e.message) });
  const upd = useMutation({ mutationFn: (v: { id: number; patch: any }) => patch(`/praca-gov/accounts/${v.id}`, v.patch), onSuccess: () => { inv(); toast.success(t("Збережено")); }, onError: (e: any) => toast.error(e.message) });
  const poaUp = useMutation({ mutationFn: (v: { id: number; file: File }) => { const fd = new FormData(); fd.append("file", v.file); return upload(`/praca-gov/accounts/${v.id}/poa`, fd); }, onSuccess: () => { inv(); toast.success(t("Довіреність збережено")); }, onError: (e: any) => toast.error(e.message) });
  const poaDel = useMutation({ mutationFn: (id: number) => del(`/praca-gov/accounts/${id}/poa`), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  if (isLoading) return <Spinner />;
  const mine = accounts.filter(a => a.own); const others = accounts.filter(a => !a.own);
  const card = (a: PzAccount) => (
    <Card key={a.id} className={cn("p-4", !a.isActive && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-slate-400" />
        <span className="font-semibold text-slate-800">{a.label || a.login}</span>
        <span className="text-xs text-slate-400">{a.login}</span>
        {!a.own && <Badge>{a.adminName ?? `#${a.adminId}`}</Badge>}
        {a.busy && <Badge color="blue">{t("виконує подачу")}</Badge>}
        {!a.isActive && <Badge color="rose">{t("вимкнено")}</Badge>}
        {a.lastLoginAt && !a.lastError && <Badge color="green">{t("вхід працює")} · {new Date(a.lastLoginAt).toLocaleDateString("uk-UA")}</Badge>}
        {a.lastError && <Badge color="rose">{t("помилка входу")}</Badge>}
        <span className="ml-auto flex items-center gap-1">
          {a.own && <Button variant="secondary" onClick={() => testLogin.mutate(a.id)} loading={testLogin.isPending} disabled={a.busy || !a.isActive}><Play className="mr-1 h-3.5 w-3.5" />{t("Перевірити вхід")}</Button>}
          {a.own && <Button variant="secondary" onClick={() => setEdit(a)}><Pencil className="mr-1 h-3.5 w-3.5" />{t("Редагувати")}</Button>}
          {a.own && <Button variant="secondary" onClick={() => upd.mutate({ id: a.id, patch: { isActive: !a.isActive } })}>{a.isActive ? t("Вимкнути") : t("Увімкнути")}</Button>}
          {a.own && <button onClick={async () => { if (await confirm({ title: t("Видалити акаунт?"), message: t("Збережений пароль буде стерто."), danger: true, confirmText: t("Видалити") })) remove.mutate(a.id); }} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>}
          {!a.own && <span className="text-xs text-slate-400">{t("лише власник може користуватись")}</span>}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-5">
        <div><dt className="text-slate-400">{t("Привʼязано до")}</dt><dd className="text-slate-700">{a.own ? t("вас") : (a.adminName ?? `#${a.adminId}`)}</dd></div>
        <div><dt className="text-slate-400">{t("Контекст на порталі")}</dt><dd className="text-slate-700">{a.contextName || t("назва фірми")}</dd></div>
        <div><dt className="text-slate-400">Pełniona funkcja</dt><dd className="text-slate-700">{a.signerFunction || "—"}</dd></div>
        <div><dt className="text-slate-400">{t("Подає за фірми")}</dt><dd className="text-slate-700">{a.companyIds.length ? a.companyIds.length : t("будь-яку")}</dd></div>
        <div><dt className="text-slate-400">Pełnomocnictwo (PDF)</dt><dd className="flex gap-2 text-slate-700">
          {a.poaFilePath ? <><a href={`/api/praca-gov/accounts/${a.id}/poa`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{t("переглянути")}</a>{a.own && <button onClick={() => poaDel.mutate(a.id)} className="text-rose-600 hover:underline">{t("видалити")}</button>}</> : <span className="text-slate-400">{t("не потрібно при прямому uprawnieniu")}</span>}
          {a.own && <label className="cursor-pointer text-blue-600 hover:underline">{a.poaFilePath ? t("замінити") : t("завантажити")}<input type="file" accept="application/pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) poaUp.mutate({ id: a.id, file: f }); e.target.value = ""; }} /></label>}
        </dd></div>
      </dl>
      {a.lastError && <p className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700">{a.lastError}</p>}
    </Card>
  );
  return (
    <div className="space-y-3">
      {mine.length === 0
        ? <Card className="p-4"><div className="flex flex-wrap items-center gap-3"><div><div className="font-medium text-slate-800">{t("У вас ще нема акаунта profilu zaufanego для робота")}</div><div className="text-sm text-slate-500">{t("Акаунт привʼязується до вашого профілю: лише ви можете ним подавати, міняти пароль чи видалити. Пароль зберігається зашифрованим і нікому не показується.")}</div></div><Button className="ml-auto" onClick={() => setEdit("new")} disabled={!ready}><Plus className="mr-1 h-4 w-4" />{t("Додати акаунт")}</Button></div></Card>
        : mine.map(card)}
      {mine.length > 0 && <div className="flex justify-end"><Button variant="secondary" onClick={() => setEdit("new")} disabled={!ready}><Plus className="mr-1 h-4 w-4" />{t("Ще один акаунт")}</Button></div>}
      {others.length > 0 && me?.isMain && <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-medium text-slate-600">{t("Акаунти інших адмінів")} ({others.length})</summary><div className="mt-3 space-y-3">{others.map(card)}</div></details>}
      {sel != null && <SubmissionPanel id={sel} onClose={() => setSel(null)} />}
      {edit && <EditAccountModal a={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); inv(); }} />}
    </div>
  );
}

function EditAccountModal({ a, onClose, onSaved }: { a: PzAccount | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { data: ref } = useReference();
  const [f, setF] = useState({ label: a?.label ?? "", login: a?.login ?? "", password: "", contextName: a?.contextName ?? "", signerFunction: a?.signerFunction ?? "", companyIds: a?.companyIds ?? [] as number[] });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(v => ({ ...v, [k]: e.target.value }));
  const toggleCo = (id: number) => setF(v => ({ ...v, companyIds: v.companyIds.includes(id) ? v.companyIds.filter(x => x !== id) : [...v.companyIds, id] }));
  const save = useMutation({
    mutationFn: () => a ? patch(`/praca-gov/accounts/${a.id}`, { ...f, password: f.password || undefined }) : post("/praca-gov/accounts", f),
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); }, onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={a ? t("Акаунт praca.gov.pl — {name}", { name: a.label || a.login }) : t("Додати акаунт profilu zaufanego")}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{t("Підпис")}</Label><Input value={f.label} onChange={set("label")} placeholder={t("напр. Влада — Eurosupport")} /></div>
          <div><Label>{t("Логін login.gov.pl")}</Label><Input value={f.login} onChange={set("login")} autoComplete="off" /></div>
        </div>
        <div><Label>{a ? t("Новий пароль (порожньо = не міняти)") : t("Пароль")}</Label><Input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{t("Контекст організації (частина назви)")}</Label><Input value={f.contextName} onChange={set("contextName")} placeholder="EUROSUPPORT GROUP" /></div>
          <div><Label>Pełniona funkcja</Label><Input value={f.signerFunction} onChange={set("signerFunction")} placeholder="Specjalista ds. kadr" /></div>
        </div>
        <div>
          <Label>{t("Подає за фірми (порожньо = будь-яка)")}</Label>
          <div className="flex flex-wrap gap-3 pt-1">{(ref?.companies ?? []).map(c => <label key={c.id} className="flex items-center gap-1 text-sm text-slate-700"><input type="checkbox" checked={f.companyIds.includes(c.id)} onChange={() => toggleCo(c.id)} />{c.name}</label>)}</div>
        </div>
        <p className="text-xs text-slate-400">{t("Контекст порожній — робот візьме назву фірми з подачі. Довіреність не потрібна, коли людина має пряме uprawnienie на порталі.")}</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.login.trim() || (!a && !f.password)}>{a ? t("Зберегти") : t("Додати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Фірми ─────────────────────────────────────────────────────────────────────
function CompaniesTab() {
  const t = useT();
  const r = useReference();
  if (r.isLoading || !r.data) return <Spinner />;
  const save = (id: number, k: string) => (v: string) => r.company.mutate({ id, patch: { [k]: v } });
  return (
    <Card className="p-4">
      <p className="mb-2 text-xs text-slate-500">{t("Секції 1.2–1.3 (контакт), 4 (чисельність на день подачі, 0 якщо нема), PKD і KRAZ. Nazwa/NIP/REGON та адресу siedziby portal бере з реєстрації організації.")}</p>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr><th className={TH}>{t("Фірма")}</th><th className={TH}>e-mail (1.2)</th><th className={TH}>Telefon (1.3)</th><th className={TH}>PKD</th><th className={TH}>KRAZ</th><th className={TH}>Umowa o pracę</th><th className={TH}>Umowy cywilnoprawne</th><th className={TH}>Miejscowość</th></tr></thead>
        <tbody>{r.data.companies.map(c => (
          <tr key={c.id} className="border-t border-slate-100">
            <td className={cn(TD, "whitespace-nowrap")}><div className="font-medium text-slate-800">{c.name}</div><div className="text-[10px] text-slate-400">{c.legalName}</div></td>
            <td className={TD}><Cell value={c.contactEmail} type="email" w="w-48" onSave={save(c.id, "contactEmail")} /></td>
            <td className={TD}><Cell value={c.contactPhone} w="w-36" onSave={save(c.id, "contactPhone")} /></td>
            <td className={TD}><Cell value={c.pkd} placeholder="78.10.Z" w="w-24" mono onSave={save(c.id, "pkd")} /></td>
            <td className={TD}><Cell value={c.kraz} w="w-20" mono onSave={save(c.id, "kraz")} /></td>
            <td className={TD}><Cell value={c.headcountEmployment} type="number" w="w-20" onSave={save(c.id, "headcountEmployment")} /></td>
            <td className={TD}><Cell value={c.headcountCivil} type="number" w="w-20" onSave={save(c.id, "headcountCivil")} /></td>
            <td className={TD}><Cell value={c.city} w="w-28" onSave={save(c.id, "city")} /></td>
          </tr>))}</tbody>
      </table></div>
    </Card>
  );
}

// ── Фабрики ───────────────────────────────────────────────────────────────────
function FactoriesTab() {
  const t = useT();
  const r = useReference();
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (r.isLoading || !r.data) return <Spinner />;
  const toggle = (id: number) => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const complete = (f: RefFactory) => !!(f.addrWojewodztwo && f.addrPowiat && f.addrGmina);
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">{t("Секція 3.4: адреса місця роботи зі словника TERYT (województwo маленькими — lubelskie; powiat — «m. Lublin» або «lubelski»; gmina і miejscowość як у TERYT). Секції 3.2–3.3: як назвати посаду і який код KZiS подавати на цій фабриці — за замовчуванням для всіх, або окремо по посадах.")}</p>
      {r.data.factories.map(f => (
        <Card key={f.id}>
          <button onClick={() => toggle(f.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left">
            {open.has(f.id) ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
            <span className="font-semibold text-slate-800">{f.name}</span>
            {f.companyName && <Badge>{f.companyName}</Badge>}
            <span className="truncate text-xs text-slate-400">{f.address}</span>
            <span className="ml-auto shrink-0 text-xs">{complete(f) ? <span className="text-emerald-700">{[f.addrMiejscowosc, f.addrPowiat].filter(Boolean).join(" · ")}</span> : <span className="text-amber-700">{t("адресу TERYT не заповнено")}</span>}</span>
          </button>
          {open.has(f.id) && (
            <div className="space-y-3 border-t border-slate-100 px-4 py-3">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">3.4 Miejsce wykonywania pracy</div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
                  {([["addrPostalCode", "Kod pocztowy"], ["addrWojewodztwo", "Województwo"], ["addrPowiat", "Powiat"], ["addrGmina", "Gmina"], ["addrMiejscowosc", "Miejscowość"], ["addrStreet", "Ulica"], ["addrHouseNo", "Nr domu"], ["addrAptNo", "Nr lokalu"]] as const).map(([k, l]) => (
                    <div key={k}><div className="text-[10px] text-slate-400">{l}</div><Cell value={f[k]} onSave={v => r.factory.mutate({ id: f.id, patch: { [k]: v } })} /></div>))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">3.2 Stanowisko · 3.3 Kod zawodu (KZiS)</div>
                <table className="w-full text-sm">
                  <thead><tr><th className={TH}>{t("Посада у нас")}</th><th className={TH}>{t("Як подати (Stanowisko / rodzaj pracy)")}</th><th className={TH}>KZiS</th></tr></thead>
                  <tbody>
                    <tr className="border-t border-slate-100 bg-slate-50/60">
                      <td className={cn(TD, "text-slate-500 italic")}>{t("за замовчуванням для всіх посад фабрики")}</td>
                      <td className={TD}><Cell value={f.uaStanowisko} placeholder={f.contractDuties || t("напр. Pracownik produkcji — pakowanie")} onSave={v => r.factory.mutate({ id: f.id, patch: { uaStanowisko: v } })} /></td>
                      <td className={TD}><Cell value={f.uaKzisCode} placeholder="932990" w="w-24" mono onSave={v => r.factory.mutate({ id: f.id, patch: { uaKzisCode: v } })} /></td>
                    </tr>
                    {f.positions.map(p => (
                      <tr key={p.positionId} className="border-t border-slate-100">
                        <td className={cn(TD, "whitespace-nowrap text-slate-700")}>{p.name}</td>
                        <td className={TD}><Cell value={p.uaStanowisko} placeholder={f.uaStanowisko || p.contractDuties || p.name || ""} onSave={v => r.factoryPos.mutate({ id: f.id, positionId: p.positionId, patch: { uaStanowisko: v } })} /></td>
                        <td className={TD}><Cell value={p.kzisCode} placeholder={f.uaKzisCode || r.data!.positions.find(x => x.id === p.positionId)?.kzisCode || "—"} w="w-24" mono onSave={v => r.factoryPos.mutate({ id: f.id, positionId: p.positionId, patch: { kzisCode: v } })} /></td>
                      </tr>))}
                    {f.positions.length === 0 && <tr><td colSpan={3} className={cn(TD, "text-xs text-slate-400")}>{t("На фабриці не налаштовано посад — діє рядок «за замовчуванням» або код посади з розділу «Посади»")}</td></tr>}
                  </tbody>
                </table>
                <p className="mt-1 text-[11px] text-slate-400">{t("Порожнє поле = беремо з рядка вище: посада на фабриці → фабрика → обовʼязки з умови → назва посади. Сірий текст у полі показує, що саме піде.")}</p>
              </div>
            </div>
          )}
        </Card>))}
    </div>
  );
}

// ── Посади ────────────────────────────────────────────────────────────────────
function PositionsTab() {
  const t = useT();
  const r = useReference();
  if (r.isLoading || !r.data) return <Spinner />;
  return (
    <Card className="p-4">
      <p className="mb-2 text-xs text-slate-500">{t("Код zawodu KZiS посади за замовчуванням (6 цифр). Приклади: 932101 Pakowacz ręczny · 932990 Robotnik przemysłowy gdzie indziej niesklasyfikowany · 834401 Kierowca operator wózków jezdniowych. На фабриці можна задати інший.")}</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {r.data.positions.map(p => <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"><span className="text-slate-700">{p.name}</span><Cell value={p.kzisCode} placeholder="— — — — — —" w="w-24" mono onSave={v => r.position.mutate({ id: p.id, patch: { kzisCode: v } })} /></div>)}
      </div>
    </Card>
  );
}

// ── Історія подач ─────────────────────────────────────────────────────────────
function HistoryTab() {
  const t = useT();
  const { data: rows = [], isLoading } = useQuery<Submission[]>({ queryKey: ["praca-gov-submissions", "all"], queryFn: () => get("/praca-gov/submissions"), refetchInterval: 5000 });
  const [sel, setSel] = useState<number | null>(() => { const s = new URLSearchParams(window.location.search).get("submission"); return s ? Number(s) : null; });
  if (isLoading) return <Spinner />;
  if (!rows.length) return <Empty>{t("Подач ще не було")}</Empty>;
  return (
    <div className="space-y-3">
      <Card>
        <table className="w-full text-sm">
          <thead><tr><th className={TH}>#</th><th className={TH}>{t("Коли")}</th><th className={TH}>{t("Що")}</th><th className={TH}>{t("Стан")}</th><th className={TH}></th></tr></thead>
          <tbody>{rows.map(s => (
            <tr key={s.id} className={cn("border-t border-slate-100 hover:bg-slate-50", sel === s.id && "bg-red-50/40")}>
              <td className={cn(TD, "text-slate-400")}>{s.id}</td>
              <td className={cn(TD, "whitespace-nowrap text-slate-600")}>{new Date(s.createdAt).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" })}</td>
              <td className={TD}>{s.kind === "login_test" ? t("тест входу") : <>{s.payload?.workerName ?? `#${s.workerId}`}{s.payload?.companyName && <span className="text-slate-400"> · {s.payload.companyName}</span>}</>}</td>
              <td className={TD}><Badge color={STATUS_COLOR[s.status] ?? "slate"}>{t(STATUS_LABEL[s.status] ?? s.status)}</Badge>{OPEN.has(s.status) && <span className="ml-1 text-xs text-slate-500">{s.step}</span>}</td>
              <td className={cn(TD, "text-right whitespace-nowrap")}>{s.previewFile && <a href={`/api/praca-gov/submissions/${s.id}/preview`} target="_blank" rel="noreferrer" className="mr-3 text-blue-600 hover:underline">Wydruk</a>}<button onClick={() => setSel(sel === s.id ? null : s.id)} className="text-slate-500 hover:underline">{sel === s.id ? t("сховати") : t("деталі")}</button></td>
            </tr>))}</tbody>
        </table>
      </Card>
      {sel != null && <SubmissionPanel id={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

export function SubmissionPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const { data: s } = useQuery<Submission>({ queryKey: ["praca-gov-submission", id], queryFn: () => get(`/praca-gov/submissions/${id}`), refetchInterval: q => (q.state.data && !OPEN.has(q.state.data.status) ? false : 2000) });
  const inv = () => { qc.invalidateQueries({ queryKey: ["praca-gov-submission", id] }); qc.invalidateQueries({ queryKey: ["praca-gov-accounts"] }); qc.invalidateQueries({ queryKey: ["praca-gov-submissions"] }); };
  const sendCode = useMutation({ mutationFn: () => post(`/praca-gov/submissions/${id}/code`, { code }), onSuccess: () => { setCode(""); toast.success(t("Код передано роботу")); }, onError: (e: any) => toast.error(e.message) });
  const cancel = useMutation({ mutationFn: () => post(`/praca-gov/submissions/${id}/cancel`), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const decide = useMutation({ mutationFn: (decision: "save_draft" | "sign" | "cancel") => post(`/praca-gov/submissions/${id}/decision`, { decision }), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  if (!s) return <Spinner />;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-slate-800">{s.kind === "login_test" ? t("Тест входу") : t("Подача")} #{s.id}</span>
        <Badge color={STATUS_COLOR[s.status] ?? "slate"}>{t(STATUS_LABEL[s.status] ?? s.status)}</Badge>
        {s.step && <span className="text-sm text-slate-600">{s.step}</span>}
        {OPEN.has(s.status) && <RefreshCw className="h-3.5 w-3.5 animate-spin text-slate-400" />}
        <span className="ml-auto flex gap-1">
          {OPEN.has(s.status) && <Button variant="secondary" onClick={() => cancel.mutate()}><XCircle className="mr-1 h-3.5 w-3.5" />{t("Скасувати")}</Button>}
          <Button variant="secondary" onClick={onClose}>{t("Закрити")}</Button>
        </span>
      </div>
      {s.error && <p className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{s.error}</p>}
      {s.status === "awaiting_code" && (
        <div className="mt-2 flex items-end gap-2">
          <div><Label>{t("Код з SMS")}</Label><Input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className="w-40" autoFocus /></div>
          <Button onClick={() => sendCode.mutate()} loading={sendCode.isPending} disabled={code.length < 4}>{t("Передати код")}</Button>
          <span className="text-xs text-slate-400">{t("або відповісти в боті на запит робота")}</span>
        </div>
      )}
      {s.status === "review" && (
        <div className="mt-2 space-y-2">
          {s.previewFile && <iframe title="Wydruk" src={`/api/praca-gov/submissions/${s.id}/preview`} className="h-[60vh] w-full rounded-lg border border-slate-200 bg-white" />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => decide.mutate("cancel")} loading={decide.isPending}>{t("Скасувати")}</Button>
            <Button variant="secondary" onClick={() => decide.mutate("save_draft")} loading={decide.isPending}>{t("Чернетка на порталі")}</Button>
            <Button onClick={() => decide.mutate("sign")} loading={decide.isPending} disabled title={t("Автопідпис — етап 3")}>{t("Підписати й надіслати")}</Button>
          </div>
        </div>
      )}
      {s.screenshots?.length > 0 && (
        <details className="mt-3"><summary className="cursor-pointer text-xs text-slate-500">{t("Технічні знімки кроків")} ({s.screenshots.length})</summary>
          <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
            {s.screenshots.map((rel, i) => <a key={rel} href={`/api/praca-gov/submissions/${s.id}/screenshot/${i}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-slate-200"><img src={`/api/praca-gov/submissions/${s.id}/screenshot/${i}`} alt={rel} className="h-28 w-full object-cover object-top" loading="lazy" /><span className="block truncate px-1 py-0.5 text-[10px] text-slate-500">{rel.split("/").pop()}</span></a>)}
          </div>
        </details>
      )}
    </Card>
  );
}

// Експорт даних працівників (28.10.2026, модель HRappka): швидкі фільтри (статус, фірми, міста,
// фабрики, посади, пошук) + конструктор умов «поле → оператор → значення» з групами І/АБО по будь-якому
// полю каталогу (профіль, робота, легалізація, анкета, умова, документи по типах) + вибір і порядок
// колонок двома списками «Вибрані / Доступні» (drag&drop) + персональні збережені набори
// (admins.web_prefs, ключ workers.export.presets). Три виходи: Excel-список у вибраних колонках,
// CSV/XLSX для Gratyfikant nexo, ZIP документів по папках Firma/Fabryka/Pracownik.
// Список людей і лічильники — GET /workers/export/preview (≤200 рядків у вибраних колонках).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, FileSpreadsheet, FolderArchive, Table2, Plus, X, GripVertical, Search, Save, Trash2, BookmarkCheck, Check } from "lucide-react";
import { get, type Factory, type Company, type Position, type DocumentType } from "../lib/api";
import { Button, Input, Select, Modal, Label, Badge, Spinner } from "./ui";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useJsonPref } from "../lib/prefs";

type Mode = "active" | "fired" | "blacklist" | "all";
type Kind = "xlsx" | "csv" | "docs";
type FieldType = "text" | "date" | "number" | "bool" | "enum" | "list";
type Group = "base" | "work" | "legal" | "anketa" | "umowa" | "docs";
type Field = { key: string; header: string; label: string; group: Group; type: FieldType; options?: { value: string; label: string }[] };
type Cond = { k: string; op: string; v?: string | string[] | null };
type CondGroup = { and: Cond[] };
type Catalog = { fields: Field[]; defaults: string[]; ops: Record<FieldType, string[]> };
type Preview = { count: number; docs: number; contracts: number; workersWithFiles: number; columns: { key: string; header: string; label: string }[]; rows: (string | number)[][]; ids: number[] };
type Preset = { name: string; kind: Kind; mode: Mode; companyIds: number[]; cities: string[]; factoryIds: number[]; positionIds: number[]; q: string; groups: CondGroup[]; cols: string[] | null; docTypeIds: number[]; withContracts: boolean };

const GROUP_LABEL: Record<Group, string> = { base: "Основне", work: "Робота", legal: "Легалізація", anketa: "Анкета", umowa: "Умова", docs: "Документи" };
const OP_LABEL: Record<string, string> = {
  contains: "містить", not_contains: "не містить", starts: "починається з", ends: "закінчується на", eq: "дорівнює", neq: "не дорівнює",
  empty: "порожнє", not_empty: "заповнене", gt: "більше", gte: "не менше", lt: "менше", lte: "не більше", between: "між", in: "одне з", not_in: "жодне з",
  true: "так", false: "ні", within_days: "настає протягом N днів", older_days: "раніше ніж N днів тому",
};
const OP_LABEL_DATE: Record<string, string> = { eq: "саме ця дата", gt: "після", lt: "до" };
const opLabel = (op: string, type: FieldType) => (type === "date" && OP_LABEL_DATE[op]) || OP_LABEL[op] || op;
const needsValue = (op: string) => !["empty", "not_empty", "true", "false"].includes(op);

export function WorkersExportModal({ onClose, initial }: {
  onClose: () => void;
  initial?: { mode?: Mode; factoryId?: string; companyId?: string; positionId?: string; q?: string };
}) {
  const t = useT();
  const me = useMe();
  const canFiles = can(me, "editData") || can(me, "workerDocs") || can(me, "legalization");
  const canAnketa = can(me, "workerDocs"); // анкетні поля й CSV для Gratyfikant — як GET /workers/:id/questionnaire
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const { data: positions = [] } = useQuery<Position[]>({ queryKey: ["positions"], queryFn: () => get("/positions") });
  const { data: docTypes = [] } = useQuery<DocumentType[]>({ queryKey: ["document-types"], queryFn: () => get("/document-types") });
  const { data: catalog } = useQuery<Catalog>({ queryKey: ["workers-export-fields"], queryFn: () => get("/workers/export/fields") });
  const fields = catalog?.fields ?? [];
  const fieldByKey = useMemo(() => new Map(fields.map(f => [f.key, f])), [fields]);

  const [kind, setKind] = useState<Kind>("xlsx");
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "active");
  const [companyIds, setCompanyIds] = useState<Set<number>>(() => new Set(initial?.companyId ? [Number(initial.companyId)] : []));
  const [cities, setCities] = useState<Set<string>>(new Set());
  const [factoryIds, setFactoryIds] = useState<Set<number>>(() => new Set(initial?.factoryId ? [Number(initial.factoryId)] : []));
  const [positionIds, setPositionIds] = useState<Set<number>>(() => new Set(initial?.positionId ? [Number(initial.positionId)] : []));
  const [q, setQ] = useState(initial?.q ?? "");
  const [groups, setGroups] = useState<CondGroup[]>([{ and: [] }]);
  const [cols, setCols] = useState<string[] | null>(null); // null = типові сервера
  const [docTypeIds, setDocTypeIds] = useState<Set<number>>(new Set());
  const [withContracts, setWithContracts] = useState(true);
  const [csvFormat, setCsvFormat] = useState<"csv" | "xlsx">("csv");
  const [presets, savePresets] = useJsonPref<Preset[]>("workers.export.presets", []);
  const [presetName, setPresetName] = useState("");
  const effCols = cols ?? catalog?.defaults ?? [];

  const cityList = useMemo(() => [...new Set(factories.map(f => f.city).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, "pl")), [factories]);
  const facVisible = useMemo(() => factories.filter(f => (!companyIds.size || (f.companyId != null && companyIds.has(f.companyId)) || f.multiFirm) && (!cities.size || (!!f.city && cities.has(f.city)))), [factories, companyIds, cities]);
  const facGroups = useMemo(() => {
    const g = new Map<string, Factory[]>();
    for (const f of [...facVisible].sort((a, b) => a.name.localeCompare(b.name, "pl"))) { const k = f.city || t("Без міста"); g.set(k, [...(g.get(k) ?? []), f]); }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0], "pl"));
  }, [facVisible, t]);
  const toggle = <T,>(set: Set<T>, v: T, setter: (s: Set<T>) => void) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n); };
  // що прийшло з фільтрів сторінки і досі активне
  const inherited = useMemo(() => {
    const out: string[] = [];
    const fid = initial?.factoryId ? Number(initial.factoryId) : null;
    if (fid && factoryIds.has(fid)) out.push(`${t("Фабрика")}: ${factories.find(f => f.id === fid)?.name ?? fid}`);
    const cid = initial?.companyId ? Number(initial.companyId) : null;
    if (cid && companyIds.has(cid)) out.push(`${t("Фірма")}: ${companies.find(c => c.id === cid)?.name ?? cid}`);
    const pid = initial?.positionId ? Number(initial.positionId) : null;
    if (pid && positionIds.has(pid)) out.push(`${t("Посада")}: ${positions.find(p => p.id === pid)?.name ?? pid}`);
    if (initial?.q && q === initial.q) out.push(`${t("Пошук")}: ${q}`);
    return out;
  }, [initial, factoryIds, companyIds, positionIds, q, factories, companies, positions, t]);
  const resetInherited = () => {
    const fid = initial?.factoryId ? Number(initial.factoryId) : null; if (fid) setFactoryIds(s => { const n = new Set(s); n.delete(fid); return n; });
    const cid = initial?.companyId ? Number(initial.companyId) : null; if (cid) setCompanyIds(s => { const n = new Set(s); n.delete(cid); return n; });
    const pid = initial?.positionId ? Number(initial.positionId) : null; if (pid) setPositionIds(s => { const n = new Set(s); n.delete(pid); return n; });
    if (initial?.q && q === initial.q) setQ("");
  };

  const condSpec = useMemo(() => {
    const or = groups.map(g => ({ and: g.and.filter(c => c.k && c.op && (!needsValue(c.op) || (Array.isArray(c.v) ? c.v.some(Boolean) : c.v != null && String(c.v) !== ""))) })).filter(g => g.and.length);
    return or.length ? JSON.stringify({ or }) : "";
  }, [groups]);
  const params = useMemo(() => {
    const p = new URLSearchParams({ mode });
    const setList = (k: string, s: Set<string | number>) => { if (s.size) p.set(k, [...s].join(",")); };
    setList("companyIds", companyIds); setList("cities", cities); setList("factoryIds", factoryIds); setList("positionIds", positionIds);
    if (q.trim()) p.set("q", q.trim());
    if (condSpec) p.set("f", condSpec);
    setList("docTypeIds", docTypeIds);
    if (withContracts) p.set("contracts", "1");
    if (cols) p.set("cols", cols.join(","));
    return p;
  }, [mode, companyIds, cities, factoryIds, positionIds, q, condSpec, docTypeIds, withContracts, cols]);
  const [debounced, setDebounced] = useState(params.toString());
  useEffect(() => { const h = setTimeout(() => setDebounced(params.toString()), 350); return () => clearTimeout(h); }, [params]);
  const { data: preview, isFetching } = useQuery<Preview>({
    queryKey: ["workers-export-preview", debounced], queryFn: () => get(`/workers/export/preview?${debounced}`), placeholderData: prev => prev,
  });

  const download = () => {
    const url = kind === "xlsx" ? `/api/workers/export/xlsx?${params}` : kind === "csv" ? `/api/workers/export/csv?${params}${csvFormat === "xlsx" ? "&format=xlsx" : ""}` : `/api/workers/export/docs.zip?${params}`;
    window.location.href = url;
  };
  // збережені набори: усе, що вибрано в модалці, під іменем — персонально для адміна
  const snapshot = (name: string): Preset => ({ name, kind, mode, companyIds: [...companyIds], cities: [...cities], factoryIds: [...factoryIds], positionIds: [...positionIds], q, groups, cols, docTypeIds: [...docTypeIds], withContracts });
  const applyPreset = (p: Preset) => {
    setKind(p.kind); setMode(p.mode); setCompanyIds(new Set(p.companyIds)); setCities(new Set(p.cities)); setFactoryIds(new Set(p.factoryIds)); setPositionIds(new Set(p.positionIds));
    setQ(p.q); setGroups(p.groups.length ? p.groups : [{ and: [] }]); setCols(p.cols); setDocTypeIds(new Set(p.docTypeIds)); setWithContracts(p.withContracts);
  };
  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    savePresets([...presets.filter(p => p.name !== name), snapshot(name)]);
    toast.success(t("Набір «{name}» збережено", { name })); setPresetName("");
  };

  const KINDS: { k: Kind; icon: typeof Table2; label: string; hint: string; disabled?: boolean }[] = [
    { k: "xlsx", icon: Table2, label: t("Excel-список"), hint: t("колонки на вибір: основне, робота, легалізація, анкета, умова, документи") },
    { k: "csv", icon: FileSpreadsheet, label: t("CSV для Gratyfikant"), hint: t("колонки як у вивантаженні «Eksport - Umowy» — для імпорту картотеки в nexo"), disabled: !canAnketa },
    { k: "docs", icon: FolderArchive, label: t("ZIP документів"), hint: t("файли документів по папках: фірма / фабрика / працівник (+ підписані умови)"), disabled: !canFiles },
  ];
  const chip = (on: boolean) => `cursor-pointer rounded-lg border px-2.5 py-1 text-xs transition ${on ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`;
  const nConds = groups.reduce((s, g) => s + g.and.length, 0);

  return (
    <Modal open onClose={onClose} title={t("Експорт даних працівників")} size="2xl">
      <div className="space-y-4">
        {/* вихід + збережені набори */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="grid flex-1 gap-2 sm:grid-cols-3">
            {KINDS.map(({ k, icon: Icon, label, hint, disabled }) => (
              <button key={k} type="button" disabled={disabled} onClick={() => setKind(k)}
                className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-left disabled:opacity-40 ${kind === k ? "border-red-300 bg-red-50/60" : "border-slate-200 hover:bg-slate-50"}`}>
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                <span><span className="block text-sm font-medium text-slate-800">{label}</span><span className="block text-xs text-slate-500">{hint}</span></span>
              </button>
            ))}
          </div>
          <div className="w-64 rounded-xl border border-slate-200 p-2">
            <div className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600"><BookmarkCheck className="h-3.5 w-3.5" /> {t("Збережені набори")}</div>
            <Select value="" onChange={e => { const p = presets.find(x => x.name === e.target.value); if (p) applyPreset(p); }}>
              <option value="">{presets.length ? t("— вибрати —") : t("ще немає")}</option>
              {presets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </Select>
            <div className="mt-1.5 flex gap-1">
              <Input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder={t("назва набору")} onKeyDown={e => { if (e.key === "Enter") savePreset(); }} />
              <button type="button" onClick={savePreset} disabled={!presetName.trim()} className="rounded-lg border border-slate-200 px-2 text-slate-600 hover:bg-slate-50 disabled:opacity-40" title={t("Зберегти поточні фільтри й колонки під цією назвою")}><Save className="h-4 w-4" /></button>
              {presets.some(p => p.name === presetName.trim()) && <button type="button" onClick={() => savePresets(presets.filter(p => p.name !== presetName.trim()))} className="rounded-lg border border-rose-200 px-2 text-rose-600 hover:bg-rose-50" title={t("Видалити набір")}><Trash2 className="h-4 w-4" /></button>}
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-12">
          {/* ліва колонка: швидкі фільтри + конструктор умов */}
          <div className="space-y-3 lg:col-span-7">
            <Card title={t("Швидкі фільтри")}>
              {/* успадковані з фільтрів сторінки /workers — показуємо явно, бо непомічений чип фабрики давав «не тих людей» (28.10.2026) */}
              {inherited.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                  <span className="font-medium">{t("Зі сторінки «Працівники»")}:</span>
                  {inherited.map(x => <span key={x} className="rounded-md bg-white px-1.5 py-0.5">{x}</span>)}
                  <button type="button" onClick={resetInherited} className="ml-auto underline-offset-2 hover:underline">{t("скинути")}</button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {([["active", t("Активні")], ["fired", t("Звільнені")], ["blacklist", t("Чорний список")], ["all", t("Усі")]] as const).map(([k, l]) => (
                  <button key={k} type="button" className={chip(mode === k)} onClick={() => setMode(k)}>{l}</button>
                ))}
                <div className="relative ml-auto"><Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" /><Input placeholder={t("Пошук за іменем або кодом")} value={q} onChange={e => setQ(e.target.value)} className="w-56 pl-8" /></div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <ChipRow label={t("Фірми")}>{companies.map(c => <button key={c.id} type="button" className={chip(companyIds.has(c.id))} onClick={() => toggle(companyIds, c.id, setCompanyIds)}>{c.name}</button>)}</ChipRow>
                <ChipRow label={t("Міста")}>{cityList.map(c => <button key={c} type="button" className={chip(cities.has(c))} onClick={() => toggle(cities, c, setCities)}>{c}</button>)}</ChipRow>
              </div>
              <div className="mt-3">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                  {t("Фабрики")} <span className="font-normal text-slate-400">({t("людина рахується і за додатковою фабрикою")})</span>
                  {factoryIds.size > 0 && <button type="button" onClick={() => setFactoryIds(new Set())} className="ml-auto text-slate-500 underline-offset-2 hover:underline">{t("зняти вибір")}</button>}
                </div>
                <div className="mt-1 max-h-32 space-y-1 overflow-auto rounded-lg border border-slate-100 bg-slate-50/50 p-2">
                  {facGroups.map(([city, fs]) => (
                    <div key={city} className="flex flex-wrap items-center gap-1.5">
                      <span className="w-16 shrink-0 text-[11px] font-medium text-slate-400">{city}</span>
                      {fs.map(f => <button key={f.id} type="button" className={chip(factoryIds.has(f.id))} onClick={() => toggle(factoryIds, f.id, setFactoryIds)}>{f.name}</button>)}
                    </div>
                  ))}
                  {!facGroups.length && <div className="text-xs text-slate-400">{t("Під вибрані фірми/міста фабрик немає")}</div>}
                </div>
              </div>
              <div className="mt-3"><ChipRow label={t("Посади")}>{positions.filter(p => p.isActive !== false || positionIds.has(p.id)).map(p => <button key={p.id} type="button" className={chip(positionIds.has(p.id))} onClick={() => toggle(positionIds, p.id, setPositionIds)}>{p.name}</button>)}</ChipRow></div>
            </Card>

            <Card title={t("Умови")} badge={nConds} hint={t("будь-яке поле → оператор → значення; умови в групі — «і», групи між собою — «або»")}>
              <div className="space-y-2">
                {groups.map((g, gi) => (
                  <div key={gi}>
                    {gi > 0 && <div className="my-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400"><span className="h-px flex-1 bg-slate-200" />{t("або")}<span className="h-px flex-1 bg-slate-200" /></div>}
                    <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50/40 p-2">
                      {g.and.map((c, ci) => (
                        <CondRow key={ci} cond={c} fields={fields} fieldByKey={fieldByKey} ops={catalog?.ops} docTypes={docTypes}
                          onChange={next => setGroups(gs => gs.map((x, i) => i === gi ? { and: x.and.map((y, j) => j === ci ? next : y) } : x))}
                          onRemove={() => setGroups(gs => { const n = gs.map((x, i) => i === gi ? { and: x.and.filter((_, j) => j !== ci) } : x); return n.filter((x, i) => x.and.length || i === 0 || n.length === 1); })} />
                      ))}
                      <button type="button" onClick={() => setGroups(gs => gs.map((x, i) => i === gi ? { and: [...x.and, { k: "", op: "contains", v: "" }] } : x))} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-red-600 hover:bg-red-50"><Plus className="h-3.5 w-3.5" /> {t("умова")}</button>
                    </div>
                  </div>
                ))}
                <button type="button" onClick={() => setGroups(gs => [...gs, { and: [{ k: "", op: "contains", v: "" }] }])} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100"><Plus className="h-3.5 w-3.5" /> {t("група «або»")}</button>
              </div>
            </Card>

            {kind === "csv" && (
              <Card title={t("CSV для Gratyfikant")}>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-slate-600">{t("Формат файлу")}:</span>
                  {(["csv", "xlsx"] as const).map(f => <label key={f} className="flex items-center gap-1.5"><input type="radio" name="csvfmt" checked={csvFormat === f} onChange={() => setCsvFormat(f)} /> {f === "csv" ? "CSV (;)" : "XLSX"}</label>)}
                </div>
                <p className="mt-1 text-xs text-slate-500">{t("38 колонок 1:1 як у вивантаженні «Eksport - Umowy». Імʼя — «Nazwisko Imię» (поле «Імʼя в Gratyfikancie», якщо заповнене); умова — чинна umowa на фірму працівника; PESEL, адреса, рахунок, NFZ, US — з анкети.")}</p>
              </Card>
            )}
            {kind === "docs" && (
              <Card title={t("ZIP документів")}>
                <Label>{t("Типи документів в архів")} <span className="font-normal text-slate-400">({t("порожньо = усі")})</span></Label>
                <div className="mt-1 flex max-h-28 flex-wrap gap-1.5 overflow-auto">
                  {docTypes.filter(d => d.isActive !== false).map(d => <button key={d.id} type="button" className={chip(docTypeIds.has(d.id))} onClick={() => toggle(docTypeIds, d.id, setDocTypeIds)}>{d.name}</button>)}
                </div>
                <label className="mt-2 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={withContracts} onChange={e => setWithContracts(e.target.checked)} /> {t("Додати підписані умови (папка Umowy)")}</label>
                <p className="mt-1 text-xs text-slate-500">{t("Структура архіву: Firma / Fabryka / NAZWISKO IMIĘ (kod) / файли. Люди без файлів в архів не потрапляють.")}</p>
              </Card>
            )}
          </div>

          {/* права колонка: колонки й порядок */}
          <div className="lg:col-span-5">
            <ColumnsPicker fields={fields} selected={effCols} defaults={catalog?.defaults ?? []} onChange={setCols} />
          </div>
        </div>

        {/* список людей під фільтри — у тих колонках, що підуть в Excel */}
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <Badge color={preview?.count ? "green" : "slate"}>{t("Людей: {n}", { n: preview?.count ?? "…" })}</Badge>
            {kind === "docs" && preview && <Badge color="blue">{t("Файлів: {n} · з умовами: {c} · людей з файлами: {w}", { n: preview.docs, c: preview.contracts, w: preview.workersWithFiles })}</Badge>}
            {preview && preview.count > preview.rows.length && <span className="text-xs text-slate-400">{t("показано перших {n}", { n: preview.rows.length })}</span>}
            {isFetching && <Spinner />}
          </div>
          <div className="max-h-72 overflow-auto rounded-xl border border-slate-200">
            {preview ? (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-100 text-left uppercase tracking-wide text-slate-500">
                  <tr>{preview.columns.map(c => <th key={c.key} className="whitespace-nowrap px-2 py-1.5" title={c.header}>{t(c.label)}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.rows.map((r, i) => (
                    <tr key={preview.ids[i] ?? i} className="hover:bg-slate-50">
                      {r.map((v, j) => <td key={j} className="max-w-[18rem] truncate whitespace-nowrap px-2 py-1 text-slate-700" title={String(v)}>{preview.columns[j]?.key === "fullName" ? <a href={`/workers/${preview.ids[i]}`} target="_blank" rel="noreferrer" className="font-medium text-red-700 hover:underline">{String(v)}</a> : String(v)}</td>)}
                    </tr>
                  ))}
                  {!preview.rows.length && <tr><td className="px-3 py-4 text-slate-400">{t("Нікого не знайдено")}</td></tr>}
                </tbody>
              </table>
            ) : <div className="p-4"><Spinner /></div>}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3">
          <Button variant="secondary" onClick={onClose}>{t("Закрити")}</Button>
          <Button disabled={!preview?.count} onClick={download}><Download className="h-4 w-4" /> {t("Скачати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Card({ title, badge, hint, children }: { title: string; badge?: number; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">{title}{!!badge && <Badge color="red">{badge}</Badge>}{hint && <span className="text-xs font-normal text-slate-400">{hint}</span>}</div>
      {children}
    </div>
  );
}
function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  const t = useT();
  return (
    <div>
      <div className="text-xs font-medium text-slate-500">{label} <span className="font-normal text-slate-400">({t("порожньо = усі")})</span></div>
      <div className="mt-1 flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

// Рядок умови: поле (optgroup по розділах) → оператор (за типом поля) → значення (за типом і оператором)
function CondRow({ cond, fields, fieldByKey, ops, docTypes, onChange, onRemove }: {
  cond: Cond; fields: Field[]; fieldByKey: Map<string, Field>; ops?: Record<FieldType, string[]>; docTypes: DocumentType[]; onChange: (c: Cond) => void; onRemove: () => void;
}) {
  const t = useT();
  const f = fieldByKey.get(cond.k);
  const opList = f ? (ops?.[f.type] ?? []) : [];
  const groups = useMemo(() => {
    const g = new Map<Group, Field[]>();
    for (const x of fields) g.set(x.group, [...(g.get(x.group) ?? []), x]);
    return [...g.entries()];
  }, [fields]);
  const setField = (k: string) => { const nf = fieldByKey.get(k); const first = nf ? (ops?.[nf.type]?.[0] ?? "contains") : "contains"; onChange({ k, op: first, v: "" }); };
  const v = cond.v;
  const arr = Array.isArray(v) ? v : [];
  const str = typeof v === "string" ? v : "";
  const input = (type: string, value: string, set: (s: string) => void, cls = "w-40") => <Input type={type} value={value} onChange={e => set(e.target.value)} className={cls} />;
  void docTypes;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={cond.k} onChange={e => setField(e.target.value)} className="w-64">
        <option value="">{t("— поле —")}</option>
        {groups.map(([g, list]) => <optgroup key={g} label={t(GROUP_LABEL[g])}>{list.map(x => <option key={x.key} value={x.key}>{t(x.label)}</option>)}</optgroup>)}
      </Select>
      {f && (
        <Select value={cond.op} onChange={e => onChange({ ...cond, op: e.target.value, v: ["in", "not_in", "between"].includes(e.target.value) ? [] : "" })} className="w-44">
          {opList.map(op => <option key={op} value={op}>{t(opLabel(op, f.type))}</option>)}
        </Select>
      )}
      {f && needsValue(cond.op) && (
        f.type === "enum" ? (
          ["in", "not_in"].includes(cond.op) ? (
            <div className="flex flex-wrap gap-1">{(f.options ?? []).map(o => <button key={o.value} type="button" className={`rounded-md border px-2 py-0.5 text-xs ${arr.includes(o.value) ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200 text-slate-600"}`} onClick={() => onChange({ ...cond, v: arr.includes(o.value) ? arr.filter(x => x !== o.value) : [...arr, o.value] })}>{o.label}</button>)}</div>
          ) : (
            <Select value={str} onChange={e => onChange({ ...cond, v: e.target.value })} className="w-44"><option value="">—</option>{(f.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
          )
        ) : f.type === "date" ? (
          cond.op === "between" ? <>{input("date", arr[0] ?? "", s => onChange({ ...cond, v: [s, arr[1] ?? ""] }))}<span className="text-slate-400">—</span>{input("date", arr[1] ?? "", s => onChange({ ...cond, v: [arr[0] ?? "", s] }))}</>
            : ["within_days", "older_days"].includes(cond.op) ? <>{input("number", str, s => onChange({ ...cond, v: s }), "w-20")}<span className="text-xs text-slate-500">{t("днів")}</span></>
            : input("date", str, s => onChange({ ...cond, v: s }))
        ) : f.type === "number" ? (
          cond.op === "between" ? <>{input("number", arr[0] ?? "", s => onChange({ ...cond, v: [s, arr[1] ?? ""] }), "w-24")}<span className="text-slate-400">—</span>{input("number", arr[1] ?? "", s => onChange({ ...cond, v: [arr[0] ?? "", s] }), "w-24")}</>
            : input("number", str, s => onChange({ ...cond, v: s }), "w-24")
        ) : input("text", str, s => onChange({ ...cond, v: s }), "w-48")
      )}
      <button type="button" onClick={onRemove} className="ml-auto rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" title={t("Прибрати умову")}><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

// Колонки: «Вибрані» (порядок drag&drop, ✕) і «Доступні» (пошук, групи, клік — додати)
function ColumnsPicker({ fields, selected, defaults, onChange }: { fields: Field[]; selected: string[]; defaults: string[]; onChange: (next: string[] | null) => void }) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [drag, setDrag] = useState<number | null>(null);
  const byKey = useMemo(() => new Map(fields.map(f => [f.key, f])), [fields]);
  const sel = selected.filter(k => byKey.has(k));
  // показуємо ВСІ поля (вибрані — з галочкою), не ховаємо вибрані: інакше розділ з типовими колонками
  // виглядав порожнім («в умові лише два параметри», 29.10.2026)
  const available = useMemo(() => {
    const s = search.trim().toLowerCase();
    const g = new Map<Group, Field[]>();
    for (const f of fields) if (!s || t(f.label).toLowerCase().includes(s) || f.header.toLowerCase().includes(s)) g.set(f.group, [...(g.get(f.group) ?? []), f]);
    return [...g.entries()];
  }, [fields, search, t]);
  const selSet = new Set(sel);
  const move = (from: number, to: number) => { if (from === to) return; const n = [...sel]; const [x] = n.splice(from, 1); n.splice(to, 0, x!); onChange(n); };
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-700">
        {t("Колонки й порядок")}<Badge color="slate">{sel.length}</Badge>
        <span className="ml-auto flex gap-2 text-xs font-normal">
          <button type="button" className="text-slate-500 underline-offset-2 hover:underline" onClick={() => onChange(null)}>{t("типові")}</button>
          <button type="button" className="text-slate-500 underline-offset-2 hover:underline" onClick={() => onChange(fields.filter(f => f.group !== "docs").map(f => f.key))}>{t("усі без документів")}</button>
          <button type="button" className="text-slate-500 underline-offset-2 hover:underline" onClick={() => onChange(["code", "fullName"])}>{t("лише імʼя")}</button>
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">{t("Вибрані")} <span className="font-normal text-slate-400">({t("перетягніть, щоб змінити порядок")})</span></div>
          <ul className="max-h-[22rem] space-y-0.5 overflow-auto rounded-lg border border-slate-100 bg-slate-50/50 p-1">
            {sel.map((k, i) => {
              const f = byKey.get(k)!;
              return (
                <li key={k} draggable onDragStart={() => setDrag(i)} onDragOver={e => e.preventDefault()} onDrop={() => { if (drag != null) move(drag, i); setDrag(null); }} onDragEnd={() => setDrag(null)}
                  className={`flex items-center gap-1.5 rounded-md border bg-white px-1.5 py-1 text-xs ${drag === i ? "border-red-300 opacity-60" : "border-slate-200"}`}>
                  <GripVertical className="h-3.5 w-3.5 cursor-grab text-slate-300" />
                  <span className="min-w-0 flex-1 truncate text-slate-700" title={f.header}>{t(f.label)} <span className="text-slate-400">· {f.header}</span></span>
                  <button type="button" onClick={() => onChange(sel.filter(x => x !== k))} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button>
                </li>
              );
            })}
            {!sel.length && <li className="px-2 py-3 text-xs text-slate-400">{t("Жодної колонки — додайте з правого списку")}</li>}
          </ul>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">{t("Усі поля")} <span className="font-normal text-slate-400">({t("клік — додати / зняти")})</span></div>
          <div className="relative mb-1"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" /><Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("пошук колонки")} className="pl-7 text-xs" /></div>
          <div className="max-h-[19.5rem] space-y-1.5 overflow-auto rounded-lg border border-slate-100 p-1">
            {available.map(([g, list]) => (
              <div key={g}>
                <div className="flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  {t(GROUP_LABEL[g])}
                  <button type="button" className="font-normal normal-case text-slate-400 underline-offset-2 hover:underline" onClick={() => { const all = list.every(f => selSet.has(f.key)); onChange(all ? sel.filter(k => !list.some(f => f.key === k)) : [...sel, ...list.filter(f => !selSet.has(f.key)).map(f => f.key)]); }}>{list.every(f => selSet.has(f.key)) ? t("зняти всі") : t("вибрати всі")}</button>
                </div>
                {list.map(f => {
                  const on = selSet.has(f.key);
                  return (
                    <button key={f.key} type="button" onClick={() => onChange(on ? sel.filter(k => k !== f.key) : [...sel, f.key])}
                      className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs ${on ? "bg-red-50/60 text-red-700" : "text-slate-700 hover:bg-slate-50"}`}>
                      <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${on ? "border-red-400 bg-red-500 text-white" : "border-slate-300"}`}>{on && <Check className="h-2.5 w-2.5" />}</span>
                      <span className="truncate">{t(f.label)}</span><span className="ml-auto truncate text-[10px] text-slate-400">{f.header}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {!available.length && <div className="px-2 py-3 text-xs text-slate-400">{t("Нічого не знайдено")}</div>}
          </div>
        </div>
      </div>
      {JSON.stringify(sel) !== JSON.stringify(defaults) && <p className="mt-1 text-[11px] text-slate-400">{t("Порядок і склад колонок ідуть в Excel і в список нижче.")}</p>}
    </div>
  );
}

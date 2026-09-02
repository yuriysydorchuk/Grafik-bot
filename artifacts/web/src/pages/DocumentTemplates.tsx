// Бібліотека шаблонів документів (§2.2/§12 Етап 3 плану worker-docs-signing,
// /document-templates, cap `workerDocs`). Один шаблон = один тип документа
// (Umowa/Regulamin/ZUS/…) з тілом на кожну мову ({%Плейсхолдер%} — формат
// архіву HrAppka) і власним scope (де застосовується) — прив'язка до фабрик
// живе ТУТ, не на сторінці фабрики.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Copy, Trash2, Languages, Star, Bold, Italic, Underline, Pilcrow, AlignCenter, Eye, Code2, Download, Upload, FileJson } from "lucide-react";
import { get, post, put, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Label, Button, Input, Textarea, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";

type Lang = "pl" | "en" | "es" | "ru" | "uk";
const LANGS: { key: Lang; label: string }[] = [
  { key: "pl", label: "PL" }, { key: "en", label: "EN" }, { key: "es", label: "ES" },
  { key: "ru", label: "RU" }, { key: "uk", label: "UK" },
];

const KIND_LABEL: Record<string, string> = {
  umowa: "Umowa", regulamin: "Regulamin", zus: "ZUS", tax: "Podatkowe", ppk: "PPK", bhp: "BHP",
  wniosek_konto: "Wniosek — konto", wniosek_reka: "Wniosek — do rąk", wniosek_zaliczki: "Wniosek — zaliczki",
  andros_extra: "Andros — додатковий", sprzatanie_umowa: "Sprzątanie", custom: "Інше",
};
const KIND_KEYS = Object.keys(KIND_LABEL);

type Template = {
  id: number; kind: string; title: string; isBase: boolean; isActive: boolean;
  scope: "all" | "company" | "factory"; scopeCompanyIds: number[]; scopeFactoryIds: number[];
  positionId: number | null; body: Record<string, string>; langIsManual: Record<string, boolean>;
  placeholders: string[]; updatedAt: string;
};

function exportPayload(t: Template) {
  return { kind: t.kind, title: t.title, isBase: false, scope: t.scope, scopeCompanyIds: t.scopeCompanyIds, scopeFactoryIds: t.scopeFactoryIds, body: t.body };
}
function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "template";

function scopeSummary(t: Template, companies: { id: number; name: string }[], factories: { id: number; name: string }[]): string {
  if (t.scope === "all") return "Скрізь";
  if (t.scope === "company") {
    const names = t.scopeCompanyIds.map(id => companies.find(c => c.id === id)?.name ?? `#${id}`);
    return names.length ? `Компанії: ${names.join(", ")}` : "Компанії: (не обрано)";
  }
  const names = t.scopeFactoryIds.map(id => factories.find(f => f.id === id)?.name ?? `#${id}`);
  return names.length ? `Фабрики: ${names.join(", ")}` : "Лише ручний вибір";
}

export default function DocumentTemplates() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [newKind, setNewKind] = useState<string>("umowa");
  const [showImport, setShowImport] = useState(false);

  const { data: rows = [], isLoading } = useQuery<Template[]>({
    queryKey: ["document-templates"], queryFn: () => get("/document-templates"),
  });
  const { data: companies = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const { data: factories = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });

  const del1 = useMutation({
    mutationFn: (id: number) => del(`/document-templates/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["document-templates"] }); toast.success(t("Видалено")); },
    onError: (e: any) => toast.error(e.message),
  });

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
    return m;
  }, [rows]);
  const kindsPresent = KIND_KEYS.filter(k => (counts.get(k) ?? 0) > 0);
  const visible = activeTab === "all" ? rows : rows.filter(r => r.kind === activeTab);

  return (
    <div>
      <PageHeader title={t("Шаблони документів")} subtitle={t("HTML-бібліотека з {%Плейсхолдерами%} — редагуй, прив'язуй до фабрик/компаній, керуй мовами")} />
      <Card className="mb-4 flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setShowImport(true)}><Upload className="h-4 w-4" /> {t("Імпорт")}</Button>
          <button
            onClick={() => downloadJson(rows.map(exportPayload), "document-templates-all.json")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
            title={t("Завантажити всю бібліотеку одним файлом")}>
            <Download className="h-4 w-4" /> {t("Експорт усіх")}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Select value={newKind} onChange={e => setNewKind(e.target.value)} className="w-56">
            {KIND_KEYS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </Select>
          <Button onClick={() => setEditingId("new")}><Plus className="h-4 w-4" /> {t("Новий шаблон")}</Button>
        </div>
      </Card>

      <Card className="mb-4 px-2 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <button onClick={() => setActiveTab("all")} type="button"
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${activeTab === "all" ? "bg-red-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}>
            {t("Усі")} <span className="opacity-70">({rows.length})</span>
          </button>
          {kindsPresent.map(k => (
            <button key={k} onClick={() => setActiveTab(k)} type="button"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${activeTab === k ? "bg-red-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}>
              {KIND_LABEL[k]} <span className="opacity-70">({counts.get(k)})</span>
            </button>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden">
        {isLoading ? <Spinner /> : visible.length ? (
          <div>
            {visible.map(tpl => (
              <div key={tpl.id} className="flex flex-wrap items-center gap-2 border-b border-slate-50 px-4 py-2.5 text-sm last:border-0">
                <Badge color="slate">{KIND_LABEL[tpl.kind] ?? tpl.kind}</Badge>
                <button onClick={() => setEditingId(tpl.id)} className="font-medium text-slate-700 hover:text-red-600 hover:underline">{tpl.title}</button>
                {tpl.isBase && <Badge color="amber"><Star className="h-3 w-3" /> {t("стандартний")}</Badge>}
                {!tpl.isActive && <Badge color="slate">{t("архів")}</Badge>}
                <span className="text-slate-500">{scopeSummary(tpl, companies, factories)}</span>
                <span className="text-xs text-slate-400">{Object.keys(tpl.body).filter(l => tpl.body[l]?.trim()).join("/")}</span>
                <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50/60 p-0.5">
                  <button onClick={() => setEditingId(tpl.id)} className="rounded-md p-1.5 text-slate-500 hover:bg-white hover:text-red-600 hover:shadow-sm" title={t("Редагувати")}><Languages className="h-3.5 w-3.5" /></button>
                  <button
                    onClick={async () => {
                      const title = prompt(t("Назва нового шаблону:"), `${tpl.title} (копія)`);
                      if (title === null) return;
                      const clone = await post<Template>(`/document-templates/${tpl.id}/clone`, { title });
                      qc.invalidateQueries({ queryKey: ["document-templates"] });
                      setEditingId(clone.id);
                    }}
                    className="rounded-md p-1.5 text-slate-500 hover:bg-white hover:text-red-600 hover:shadow-sm" title={t("Клонувати — взяти за основу")}><Copy className="h-3.5 w-3.5" /></button>
                  <button onClick={() => downloadJson(exportPayload(tpl), `${slug(tpl.title)}.json`)}
                    className="rounded-md p-1.5 text-slate-500 hover:bg-white hover:text-red-600 hover:shadow-sm" title={t("Експорт у файл")}><Download className="h-3.5 w-3.5" /></button>
                  <button
                    onClick={async () => { if (await confirm({ title: t("Видалити шаблон?"), danger: true, confirmText: t("Видалити") })) del1.mutate(tpl.id); }}
                    className="rounded-md p-1.5 text-slate-500 hover:bg-white hover:text-rose-600 hover:shadow-sm" title={t("Видалити")}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        ) : <Empty>{t("Немає шаблонів. Створіть перший або імпортуйте бібліотеку.")}</Empty>}
      </Card>

      {editingId !== null && (
        <TemplateEditor
          id={editingId} initialKind={newKind} companies={companies} factories={factories}
          onClose={() => setEditingId(null)}
        />
      )}
      {showImport && (
        <ImportModal onClose={() => setShowImport(false)}
          onImported={id => { qc.invalidateQueries({ queryKey: ["document-templates"] }); setShowImport(false); setEditingId(id); }} />
      )}
    </div>
  );
}

// Два шляхи: (1) один .json — раніше експортований звідси шаблон, відновлює
// всі поля 1:1; (2) окремі .txt/.html файли на мову — типовий випадок нового
// документа з архіву (кожна мова — окремий файл, як у HrAppka-експорті),
// адмін сам вказує назву/тип/де застосовується.
function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: (id: number) => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("umowa");
  const [scope, setScope] = useState<"all" | "company" | "factory">("all");
  const [langFiles, setLangFiles] = useState<Record<string, string>>({});
  const [jsonBusy, setJsonBusy] = useState(false);

  const create = useMutation({
    mutationFn: () => post<Template>("/document-templates", { title, kind, scope, scopeCompanyIds: [], scopeFactoryIds: [], isBase: false, body: langFiles }),
    onSuccess: r => { toast.success(t("Імпортовано")); onImported(r.id); },
    onError: (e: any) => toast.error(e.message),
  });

  const onJsonFile = async (file: File) => {
    setJsonBusy(true);
    try {
      const parsed = JSON.parse(await file.text());
      const payload = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!payload?.body?.pl) throw new Error(t("Файл не схожий на експорт шаблону (немає body.pl)"));
      const r = await post<Template>("/document-templates", {
        title: payload.title ?? file.name.replace(/\.json$/, ""), kind: payload.kind ?? "custom",
        scope: payload.scope ?? "all", scopeCompanyIds: payload.scopeCompanyIds ?? [], scopeFactoryIds: payload.scopeFactoryIds ?? [],
        isBase: false, body: payload.body,
      });
      toast.success(t("Імпортовано"));
      onImported(r.id);
    } catch (e: any) {
      toast.error(e.message ?? t("Не вдалося прочитати JSON"));
    } finally {
      setJsonBusy(false);
    }
  };

  const onLangFile = async (lang: string, file: File) => {
    const text = await file.text();
    setLangFiles(f => ({ ...f, [lang]: text }));
  };

  return (
    <Modal open onClose={onClose} title={t("Імпорт шаблону")} size="lg">
      <div className="space-y-4">
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-700"><FileJson className="h-4 w-4" /> {t("З файлу експорту (.json)")}</div>
          <p className="mb-2 text-xs text-slate-400">{t("Файл, раніше збережений кнопкою «Експорт» — відновлює назву/тип/scope/усі мови одразу.")}</p>
          <input type="file" accept=".json" disabled={jsonBusy}
            onChange={e => { const f = e.target.files?.[0]; if (f) onJsonFile(f); e.target.value = ""; }}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-600 file:ring-1 file:ring-slate-300 hover:file:bg-slate-50" />
        </div>

        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
          <div className="h-px flex-1 bg-slate-200" /> {t("або нові файли по мовах")} <div className="h-px flex-1 bg-slate-200" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Назва")}</Label><Input value={title} onChange={e => setTitle(e.target.value)} placeholder={t("напр. Umowa — LST")} /></div>
          <div><Label>{t("Тип")}</Label>
            <Select value={kind} onChange={e => setKind(e.target.value)}>
              {KIND_KEYS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
          </div>
        </div>
        <div>
          <Label>{t("Де застосовується")}</Label>
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold">
            {([["all", "Скрізь"], ["company", "Обрані компанії"], ["factory", "Обрані фабрики"]] as const).map(([v, label]) => (
              <button key={v} onClick={() => setScope(v)} type="button"
                className={`rounded-md px-2.5 py-1.5 transition ${scope === v ? "bg-red-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                {t(label)}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">{t("Прив'язку до конкретних фабрик/компаній доведеш у редакторі після імпорту.")}</p>
        </div>
        <div className="grid grid-cols-5 gap-2">
          {LANGS.map(l => (
            <div key={l.key}>
              <Label>{l.label}{l.key === "pl" && " *"}</Label>
              <input type="file" accept=".txt,.html"
                onChange={e => { const f = e.target.files?.[0]; if (f) onLangFile(l.key, f); }}
                className="block w-full text-xs text-slate-500 file:mr-1 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs" />
              {langFiles[l.key] && <div className="mt-0.5 text-[10px] text-emerald-600">✓ {t("завантажено")}</div>}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button disabled={!title.trim() || !langFiles.pl || create.isPending} loading={create.isPending} onClick={() => create.mutate()}>
            {t("Створити з файлів")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TemplateEditor({ id, initialKind, companies, factories, onClose }: {
  id: number | "new"; initialKind: string;
  companies: { id: number; name: string }[]; factories: { id: number; name: string }[];
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const isNew = id === "new";
  const { data: tpl, isLoading } = useQuery<Template>({
    queryKey: ["document-templates", id], queryFn: () => get(`/document-templates/${id}`), enabled: !isNew,
  });
  const { data: palette = [] } = useQuery<string[]>({ queryKey: ["document-templates", "placeholders"], queryFn: () => get("/document-templates/placeholders") });

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState(initialKind);
  const [scope, setScope] = useState<"all" | "company" | "factory">("all");
  const [scopeCompanyIds, setScopeCompanyIds] = useState<number[]>([]);
  const [scopeFactoryIds, setScopeFactoryIds] = useState<number[]>([]);
  const [isBase, setIsBase] = useState(false);
  const [body, setBody] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<Lang>("pl");
  const [initialized, setInitialized] = useState(isNew);
  if (tpl && !initialized) {
    setTitle(tpl.title); setKind(tpl.kind); setScope(tpl.scope);
    setScopeCompanyIds(tpl.scopeCompanyIds); setScopeFactoryIds(tpl.scopeFactoryIds);
    setIsBase(tpl.isBase); setBody(tpl.body); setInitialized(true);
  }

  const [view, setView] = useState<"edit" | "preview">("edit");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const insertAtCursor = (chip: string) => {
    const el = textareaRef.current;
    const text = `{%${chip}%}`;
    if (!el) { setBody(b => ({ ...b, [lang]: (b[lang] ?? "") + text })); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const cur = body[lang] ?? "";
    const next = cur.slice(0, start) + text + cur.slice(end);
    setBody(b => ({ ...b, [lang]: next }));
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; });
  };

  // Обгортає виділений текст HTML-тегом (Bold/Italic/…) — не WYSIWYG, але
  // не треба вручну набирати теги. Без виділення — вставляє порожню пару
  // тегів і ставить курсор між ними.
  const wrapSelection = (before: string, after: string = before.startsWith("<") ? `</${before.slice(1)}` : before) => {
    const el = textareaRef.current;
    const cur = body[lang] ?? "";
    if (!el) { setBody(b => ({ ...b, [lang]: cur + before + after })); return; }
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    const selected = cur.slice(start, end);
    const next = cur.slice(0, start) + before + selected + after + cur.slice(end);
    setBody(b => ({ ...b, [lang]: next }));
    const caret = start + before.length + selected.length + (selected ? after.length : 0);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = selected ? caret : start + before.length; });
  };
  const insertBlock = (html: string) => {
    const el = textareaRef.current;
    const cur = body[lang] ?? "";
    if (!el) { setBody(b => ({ ...b, [lang]: cur + html })); return; }
    const start = el.selectionStart ?? cur.length;
    const next = cur.slice(0, start) + html + cur.slice(el.selectionEnd ?? cur.length);
    setBody(b => ({ ...b, [lang]: next }));
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + html.length; });
  };
  const TOOLBAR: { icon: typeof Bold; title: string; action: () => void }[] = [
    { icon: Bold, title: "Жирний", action: () => wrapSelection("<b>", "</b>") },
    { icon: Italic, title: "Курсив", action: () => wrapSelection("<i>", "</i>") },
    { icon: Underline, title: "Підкреслення", action: () => wrapSelection("<u>", "</u>") },
    { icon: Pilcrow, title: "Новий абзац", action: () => insertBlock('<p style="text-align: justify;"></p>') },
    { icon: AlignCenter, title: "Розділ по центру (§)", action: () => insertBlock('<div style="text-align: center; font-weight: bold; margin: 20px 0 10px 0; font-size: 12pt;">&sect;</div>') },
  ];

  const save = useMutation({
    mutationFn: async () => {
      const payload = { title, kind, scope, scopeCompanyIds, scopeFactoryIds, isBase, body };
      return isNew ? post<Template>("/document-templates", payload) : put<Template>(`/document-templates/${id}`, payload);
    },
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: ["document-templates"] });
      toast.success(t("Збережено"));
      if (isNew) onClose(); else qc.setQueryData(["document-templates", id], r);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const translate = useMutation({
    mutationFn: () => post<Template>(`/document-templates/${id}/translate`, { langs: LANGS.filter(l => l.key !== "pl").map(l => l.key) }),
    onSuccess: r => { setBody(r.body); qc.invalidateQueries({ queryKey: ["document-templates"] }); toast.success(t("Перекладено")); },
    onError: (e: any) => toast.error(e.message),
  });

  const toggleId = (list: number[], id: number) => list.includes(id) ? list.filter(x => x !== id) : [...list, id];

  return (
    <Modal open onClose={onClose} title={isNew ? t("Новий шаблон") : (tpl?.title ?? "")} size="xl">
      {!isNew && isLoading ? <Spinner /> : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t("Назва")}</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder={t("напр. Umowa — AGRAM")} />
            </div>
            <div>
              <Label>{t("Тип")}</Label>
              <Select value={kind} onChange={e => setKind(e.target.value)} disabled={!isNew}>
                {KIND_KEYS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </Select>
            </div>
          </div>

          <div>
            <Label>{t("Де застосовується")}</Label>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold">
                {([["all", "Скрізь"], ["company", "Обрані компанії"], ["factory", "Обрані фабрики"]] as const).map(([v, label]) => (
                  <button key={v} onClick={() => setScope(v)} type="button"
                    className={`rounded-md px-2.5 py-1.5 transition ${scope === v ? "bg-red-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                    {t(label)}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={isBase} onChange={e => setIsBase(e.target.checked)} />
                {t("стандартний (база для клонування)")}
              </label>
            </div>
            {scope === "company" && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {companies.map(c => (
                  <button key={c.id} type="button" onClick={() => setScopeCompanyIds(l => toggleId(l, c.id))}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${scopeCompanyIds.includes(c.id) ? "bg-red-50 text-red-700 ring-red-200" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}>
                    {c.name}
                  </button>
                ))}
              </div>
            )}
            {scope === "factory" && (
              <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {factories.map(f => (
                  <button key={f.id} type="button" onClick={() => setScopeFactoryIds(l => toggleId(l, f.id))}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${scopeFactoryIds.includes(f.id) ? "bg-red-50 text-red-700 ring-red-200" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}>
                    {f.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 border-b border-slate-200">
            {LANGS.map(l => (
              <button key={l.key} onClick={() => setLang(l.key)} type="button"
                className={`relative px-3 py-1.5 text-sm font-medium ${lang === l.key ? "text-red-600" : "text-slate-500 hover:text-slate-700"}`}>
                {l.label}
                {l.key !== "pl" && tpl?.langIsManual?.[l.key] && <span className="ml-1 text-[10px] text-amber-500" title={t("редаговано вручну")}>✎</span>}
                {lang === l.key && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-red-600" />}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1">
              <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold">
                <button type="button" onClick={() => setView("edit")}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1 transition ${view === "edit" ? "bg-red-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  <Code2 className="h-3.5 w-3.5" /> {t("Код")}
                </button>
                <button type="button" onClick={() => setView("preview")}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1 transition ${view === "preview" ? "bg-red-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  <Eye className="h-3.5 w-3.5" /> {t("Прев'ю")}
                </button>
              </div>
              {!isNew && (
                <Button variant="ghost" onClick={() => translate.mutate()} loading={translate.isPending}>
                  <Languages className="h-4 w-4" /> {t("Перекласти з PL")}
                </Button>
              )}
            </div>
          </div>

          {view === "preview" ? (
            <TemplatePreview html={body[lang] || body.pl || ""} />
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                <div className="flex items-center gap-1">
                  {TOOLBAR.slice(0, 3).map(({ icon: Icon, title, action }) => (
                    <button key={title} type="button" onClick={action} title={t(title)}
                      className="rounded-md p-1.5 text-slate-500 ring-1 ring-transparent transition hover:bg-red-50 hover:text-red-600 hover:ring-red-100">
                      <Icon className="h-4 w-4" />
                    </button>
                  ))}
                </div>
                <div className="h-5 w-px bg-slate-200" />
                <div className="flex items-center gap-1">
                  {TOOLBAR.slice(3).map(({ icon: Icon, title, action }) => (
                    <button key={title} type="button" onClick={action} title={t(title)}
                      className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 ring-1 ring-transparent transition hover:bg-red-50 hover:text-red-600 hover:ring-red-100">
                      <Icon className="h-4 w-4" /> {t(title)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-[1fr_220px] gap-3">
                <Textarea ref={textareaRef} value={body[lang] ?? ""} onChange={e => setBody(b => ({ ...b, [lang]: e.target.value }))}
                  rows={16} className="font-mono text-xs" placeholder={lang === "pl" ? t("HTML з {%Плейсхолдер%} — див. палітру праворуч") : t("(порожньо — за фолбеком піде PL)")} />
                <div className="max-h-[26rem] overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2">
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Плейсхолдери")}</div>
                  <div className="flex flex-wrap gap-1">
                    {palette.map(p => (
                      <button key={p} type="button" draggable
                        onDragStart={e => e.dataTransfer.setData("text/plain", `{%${p}%}`)}
                        onClick={() => insertAtCursor(p)}
                        className="cursor-grab rounded-md bg-white px-2 py-1 text-left text-[11px] text-slate-600 ring-1 ring-slate-200 hover:bg-red-50 hover:text-red-700 active:cursor-grabbing"
                        title={t("Клік або перетягни в текст")}>
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
            <Button variant="secondary" onClick={onClose}>{t("Закрити")}</Button>
            <Button onClick={() => save.mutate()} loading={save.isPending}>{t("Зберегти")}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Реальний Puppeteer-рендер (назви плейсхолдерів підсвічені замість
// {%Плейсхолдерів%}, не демо-дані) — той самий рушій, що й для готових
// документів, тож це справді ФІНАЛЬНИЙ вигляд верстки, а не приблизна
// апроксимація. Рефетчиться щоразу, як html змінюється (тобто коли
// адмін повертається сюди з вкладки «Код» після правок).
function TemplatePreview({ html }: { html: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const res = await fetch("/api/document-templates/preview", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json", "X-Requested-With": "grafik" },
          body: JSON.stringify({ html }),
        });
        if (!res.ok) { const j = await res.json().catch(() => null); throw new Error(j?.error || `Помилка ${res.status}`); }
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const pdfjs = await import("pdfjs-dist");
        const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url" as any)).default as string;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const doc = await pdfjs.getDocument({ data: buf }).promise;
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = "";
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1.3 });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width; canvas.height = vp.height;
          canvas.style.width = "100%";
          canvas.className = "mb-2 rounded border border-slate-200 bg-white shadow-sm";
          if (cancelled || !ref.current) return;
          ref.current.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp } as any).promise;
        }
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e).slice(0, 300));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [html]);

  if (!html.trim()) return <Empty>{t("Немає тексту для прев'ю.")}</Empty>;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 text-xs text-slate-400">{t("Демо-дані (Jan Kowalski) — не справжній працівник. Підписи лишаються порожніми, як у нависланому документі.")}</div>
      {loading && <Spinner />}
      {err && <div className="text-sm text-rose-500">{t("Не вдалося показати прев'ю.")} {err}</div>}
      <div ref={ref} className="max-h-[28rem] overflow-y-auto" />
    </div>
  );
}

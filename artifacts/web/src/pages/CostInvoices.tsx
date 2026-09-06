// «Фактури» (/cost-invoices) — робочий модуль фактур коштових: KSeF-закупівлі +
// внесені вручну/скановані ботом в одному списку зі статусами оплат. Доступ:
// viewFinance або costInvoices (роль «бухгалтерія»).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, FileText, CheckCircle2, AlertCircle, Receipt, ExternalLink, Pencil, Trash2, ScanLine, RefreshCw, Banknote, Landmark, Clock, UploadCloud, History, FolderClock, Ban, CalendarPlus } from "lucide-react";
import { get, post, patch, del, upload } from "../lib/api";
import { shrinkImageFile } from "../lib/shrinkFile";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { InvoiceAuditModal, type AuditTarget } from "../components/InvoiceAuditModal";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { KsefSales } from "./Ksef";
import { badgeClass } from "../lib/colors";

type PayMethod = "przelew" | "gotowka" | null;
type AgreementKind = "one_time" | "fixed_term" | "indefinite";
interface Row {
  key: string; origin: "ksef" | "local" | "agreement"; id: number;
  source: "ksef" | "manual" | "scan" | "sheet" | "agreement";
  companyId: number | null; firm: string | null;
  issueDate: string | null; number: string | null;
  seller: string | null; sellerNip: string | null;
  gross: number; dueDate: string | null;
  paid: boolean; paidDate: string | null; paidSource: string | null;
  note: string | null; hasFile: boolean; dupOfKsefId: number | null;
  hostelId: number | null; vehicleId: number | null; city: string | null; serviceMonth: string | null;
  paymentMethod: PayMethod; paymentMethodSource: "manual" | "auto" | null;
  cashReport: boolean; cleaning: boolean; cleaningProjectId: number | null; overdue: boolean;
  driveFileId: string | null; drivePdfId: string | null; driveError: string | null;
  addedBy: string | null; addedAt: string | null;
  category: string; categorySource: "manual" | "auto";
  agreementId: number | null; agreementKind: AgreementKind | null;
  isProforma: boolean;
}
const AGREEMENT_KIND_LABEL: Record<AgreementKind, string> = {
  one_time: "разова", fixed_term: "на термін", indefinite: "безстрокова",
};
interface Resp {
  month: string; rows: Row[]; cities: string[];
  totals: {
    count: number; gross: number; paidGross: number; unpaidGross: number; unpaidCount: number;
    przelewGross: number; przelewCount: number; gotowkaGross: number; gotowkaCount: number;
    overdueGross: number; overdueCount: number;
  };
  companies: { id: number; name: string }[];
  categories: { key: string; label: string; icon: string | null; color: string | null }[];
  ksefSync: { at: string; ok: boolean; companies: number; fetched: number; inserted: number; errors: string[] } | null;
}

const zl = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
// компактна дата в таблиці (дд.мм — рік і так заданий фільтром місяця)
const dm = (iso: string | null | undefined) => (iso ? iso.slice(5, 10).split("-").reverse().join(".") : "—");
const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  ksef: { label: "KSeF", cls: "bg-violet-100 text-violet-700" },
  manual: { label: "вручну", cls: "bg-sky-100 text-sky-700" },
  scan: { label: "скан", cls: "bg-emerald-100 text-emerald-700" },
  sheet: { label: "таблиця", cls: "bg-slate-100 text-slate-500" },
  agreement: { label: "умова", cls: "bg-teal-100 text-teal-700" },
};
const TYPE_TABS = [
  ["", "Всі"], ["ksef", "Фактури КСеФ"], ["agreement", "Умови"], ["local", "Фактури без КСеФ"], ["proforma", "Проформи"],
] as const;

export default function CostInvoices() {
  const t = useT();
  const qc = useQueryClient();
  // обидва розділи видні всім, хто має сторінку (viewFinance АБО costInvoices) —
  // кшєнгова веде і закупові, і спшедажові (рішення 26.08.2026)
  const [section, setSection] = useState<"purchase" | "sales">("purchase");
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [companyId, setCompanyId] = useState("");
  const [status, setStatus] = useState("");   // "" | paid | unpaid
  // «proforma» — окремий розділ: проформи (local з doc_type=PROFORMA) не змішуються зі звичайними ручними
  const [originFilter, setOriginFilter] = useState<"" | "ksef" | "agreement" | "local" | "proforma">("");
  const [catFilter, setCatFilter] = useState(""); // ключ категорії з розбивки-чіпсів
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [editingCharge, setEditingCharge] = useState<Row | null>(null); // запис умови за місяць
  const [prefill, setPrefill] = useState<Partial<Row> | null>(null);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [auditFor, setAuditFor] = useState<AuditTarget | null>(null); // модалка «Історія»
  const [managingAgreements, setManagingAgreements] = useState(false); // модалка «Умови»
  const fileInput = useRef<HTMLInputElement>(null);

  // «Скан»: файл → /cost-invoices/scan → модалка з розпізнаними полями і файлом
  const scanPick = async (file: File) => {
    setScanning(true);
    try {
      const fd = new FormData();
      fd.append("file", await shrinkImageFile(file));
      const r = await fetch("/api/cost-invoices/scan", { method: "POST", body: fd, credentials: "include", headers: { "X-Requested-With": "grafik" } });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "scan failed");
      const dr = j.draft ?? {};
      setPrefill({
        companyId: dr.companyId ?? null, issueDate: dr.issueDate ?? null, number: dr.number ?? null,
        seller: dr.seller ?? null, sellerNip: dr.sellerNip ?? null, gross: dr.gross ?? 0,
      });
      setScanFile(file);
      setAdding(true);
      toast.success(t("Розпізнано — перевір поля і збережи"));
    } catch (e: any) { toast.error(e?.message || t("Не вдалося розпізнати")); }
    finally { setScanning(false); if (fileInput.current) fileInput.current.value = ""; }
  };

  const [monthPushing, setMonthPushing] = useState(false);
  const months = useQuery<{ months: string[] }>({ queryKey: ["ci-months"], queryFn: () => get("/cost-invoices/months") });
  const data = useQuery<Resp>({
    queryKey: ["cost-invoices", month, companyId],
    queryFn: () => get(`/cost-invoices?month=${month}${companyId ? `&companyId=${companyId}` : ""}`),
    // поки йде заливка місяця на Drive — рядки зеленіють поступово
    refetchInterval: monthPushing ? 4000 : false,
  });
  const d = data.data;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["cost-invoices"] });

  const catMeta = useMemo(() => new Map((d?.categories ?? []).map(c => [c.key, c])), [d]);
  const catLabel = (k: string) => catMeta.get(k)?.label ?? (k === "other" ? "Інше" : k);
  const catIcon = (k: string) => catMeta.get(k)?.icon ?? (k === "other" ? "🗂️" : "");
  const catColor = (k: string) => catMeta.get(k)?.color ?? "slate";

  const rows = useMemo(() => {
    let r = d?.rows ?? [];
    if (status) r = r.filter(x => (status === "paid") === x.paid);
    if (originFilter === "proforma") r = r.filter(x => x.isProforma);
    else if (originFilter === "local") r = r.filter(x => x.origin === "local" && !x.isProforma);
    else if (originFilter) r = r.filter(x => x.origin === originFilter);
    if (catFilter) r = r.filter(x => x.category === catFilter);
    if (q.trim().length >= 2) {
      const needle = q.trim().toLowerCase();
      r = r.filter(x => `${x.number} ${x.seller} ${x.sellerNip} ${x.note}`.toLowerCase().includes(needle));
    }
    return r;
  }, [d, status, originFilter, catFilter, q]);

  // розбивка місяця по категоріях (без KSeF-дублів) — чіпси-фільтри над таблицею
  const catBreakdown = useMemo(() => {
    const acc = new Map<string, { gross: number; n: number }>();
    for (const r of d?.rows ?? []) {
      if (r.dupOfKsefId) continue;
      const cur = acc.get(r.category) ?? { gross: 0, n: 0 };
      cur.gross += r.gross; cur.n++;
      acc.set(r.category, cur);
    }
    return [...acc.entries()].sort((a, b) => b[1].gross - a[1].gross);
  }, [d]);

  const patchRow = async (r: Row, body: Record<string, unknown>) => {
    try {
      const url = r.origin === "ksef" ? `/cost-invoices/ksef/${r.id}`
        : r.origin === "agreement" ? `/agreements/charges/${r.id}`
        : `/cost-invoices/${r.id}`;
      await patch(url, body);
      invalidate();
    } catch (e: any) { toast.error(e?.message || "error"); }
  };
  const togglePaid = (r: Row) => patchRow(r, { paid: !r.paid });
  // швидка нотатка — інлайн-редагування прямо в рядку (не window.prompt — той
  // ненадійний і не схожий на решту інтерфейсу), той самий /note для всіх походжень
  const [noteEditingKey, setNoteEditingKey] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const startNoteEdit = (r: Row) => { setNoteEditingKey(r.key); setNoteDraft(r.note ?? ""); };
  const saveNote = async (r: Row) => { await patchRow(r, { note: noteDraft.trim() || null }); setNoteEditingKey(null); };
  // умова не має номера документа — назва в «Номері» складається з категорії+контрагента
  const agreementDisplayName = (r: Row) => `${catIcon(r.category) ? `${catIcon(r.category)} ` : ""}${catLabel(r.category)}${r.seller ? ` · ${r.seller}` : ""}`;
  const auditTargetFor = (r: Row): AuditTarget =>
    r.origin === "agreement"
      ? { kind: "agreement", entity: "charge", id: r.id, label: `${agreementDisplayName(r)} · ${r.serviceMonth ?? ""}` }
      : { kind: "invoice", origin: r.origin, id: r.id, label: r.number ?? "" };
  // клік по способу оплати: авто → переказ → готівка → назад на авто
  const cycleMethod = (r: Row) => {
    const next: PayMethod = r.paymentMethodSource !== "manual"
      ? (r.paymentMethod === "przelew" ? "gotowka" : "przelew")
      : r.paymentMethod === "przelew" ? "gotowka" : null;
    void patchRow(r, { paymentMethod: next });
  };

  // разовий пуш однієї фактури на Drive (хмарка в рядку) — KSeF-рядку заодно
  // підтягує термін оплати з XML
  const [pushing, setPushing] = useState<string | null>(null);
  const pushDrive = async (r: Row) => {
    setPushing(r.key);
    try {
      const res = await post(r.origin === "ksef" ? `/cost-invoices/ksef/${r.id}/drive` : `/cost-invoices/${r.id}/drive`, {});
      if (res?.driveFileId) toast.success(t("Фактура на Drive"));
      else toast.error(res?.driveError || t("Не вдалося залити на Drive"));
      invalidate();
    } catch (e: any) { toast.error(e?.message || "error"); }
    finally { setPushing(null); }
  };

  // «Місяць на Drive»: підтягнути всі фактури вибраного місяця, крім уже залитих
  const missingOnDrive = useMemo(() => (d?.rows ?? []).filter(r => !r.driveFileId).length, [d]);
  const runMonthDrive = async () => {
    setMonthPushing(true);
    try {
      const r = await post("/cost-invoices/drive-month", { month });
      if (r?.failed || r?.errors?.length) {
        toast.warning(t("Drive: залито {u}, помилок {f}", { u: r?.uploaded ?? 0, f: (r?.failed ?? 0) + (r?.errors?.length ?? 0) }) + (r?.errors?.[0] ? ` — ${r.errors[0]}` : ""));
      } else toast.success(t("Drive: залито {u}, помилок {f}", { u: r?.uploaded ?? 0, f: 0 }));
      invalidate();
    } catch (e: any) { toast.error(e?.message || "error"); }
    finally { setMonthPushing(false); }
  };

  // ручний синк: KSeF + довантаження архіву на Drive у фоні
  const [syncing, setSyncing] = useState(false);
  const runSync = async () => {
    setSyncing(true);
    try {
      const r = await post("/cost-invoices/sync", {});
      const errs = r?.sync?.errors?.length ?? 0;
      if (errs) toast.warning(t("Синк KSeF: {n} нових, помилок: {e}", { n: r.sync.inserted, e: errs }));
      else toast.success(t("Синк KSeF: {n} нових. Архів на Drive оновлюється у фоні.", { n: r?.sync?.inserted ?? 0 }));
      invalidate();
    } catch (e: any) { toast.error(e?.message || "error"); }
    finally { setSyncing(false); }
  };

  return (
    <>
      <PageHeader title={t("Фактури")} subtitle={t("Закупові (KSeF + вручну + скани з бота) і спшедажові (KSeF) — оплати й архів на Диску в одному місці")} />

      <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1 lg:w-fit">
        {([["purchase", t("Фактури закупові")], ["sales", t("Фактури спшедажові")]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setSection(k)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${section === k ? "bg-white text-red-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            {label}
          </button>
        ))}
      </div>

      {section === "sales" ? <KsefSales /> : (<>

      {d && (
        <div className="-mt-2 mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-400">{t("Останній синк KSeF:")}</span>
          {d.ksefSync ? (
            <span className={d.ksefSync.ok ? "text-emerald-600" : "text-amber-600"} title={(d.ksefSync.errors ?? []).join("\n")}>
              {new Date(d.ksefSync.at).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
              {d.ksefSync.ok ? " ✅" : ` ⚠️ ${t("помилки")}: ${d.ksefSync.errors.length}`}
            </span>
          ) : <span className="text-slate-400">{t("ще не запускався")}</span>}
          <span className="text-slate-300">·</span>
          {missingOnDrive === 0 && d.rows.length > 0 ? (
            <span className="font-medium text-emerald-600">☁️ {t("Всі фактури місяця збережено на Google Диск")} ({d.rows.length})</span>
          ) : d.rows.length > 0 ? (
            <span className="font-medium text-amber-600">☁️ {t("На Google Диску {a} з {b}", { a: d.rows.length - missingOnDrive, b: d.rows.length })}</span>
          ) : null}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Місяць")}</div>
          <Select value={month} onChange={e => setMonth(e.target.value)} className="w-36">
            {!(months.data?.months ?? []).includes(thisMonth) && <option value={thisMonth}>{thisMonth}</option>}
            {(months.data?.months ?? []).map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Фірма")}</div>
          <Select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-32">
            <option value="">{t("Всі")}</option>
            {(d?.companies ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Статус")}</div>
          <Select value={status} onChange={e => setStatus(e.target.value)} className="w-36">
            <option value="">{t("Всі")}</option>
            <option value="unpaid">{t("не оплачені")}</option>
            <option value="paid">{t("оплачені")}</option>
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Тип")}</div>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
            {TYPE_TABS.map(([k, label]) => (
              <button key={k} type="button" onClick={() => setOriginFilter(k)}
                className={`rounded-md px-2 py-1 text-xs font-medium transition ${originFilter === k ? "bg-white text-red-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                {t(label)}
              </button>
            ))}
          </div>
        </div>
        <div className="grow">
          <div className="mb-1 text-xs text-slate-500">{t("Пошук")}</div>
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("номер, постачальник, NIP…")} className="w-64" />
        </div>
        <input ref={fileInput} type="file" accept=".pdf,image/*" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void scanPick(f); }} />
        {missingOnDrive > 0 && (
          <Button variant="secondary" disabled={monthPushing} onClick={runMonthDrive}
            title={t("Залити на Drive всі фактури цього місяця, крім уже залитих")}>
            <UploadCloud className={`mr-1 h-4 w-4 ${monthPushing ? "animate-pulse" : ""}`} />
            {monthPushing ? t("Заливаю…") : t("Місяць на Drive ({n})", { n: missingOnDrive })}
          </Button>
        )}
        <Button variant="secondary" disabled={syncing} onClick={runSync} title={t("Підтягнути свіже з KSeF і довантажити архів фактур на Google Drive")}>
          <RefreshCw className={`mr-1 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />{syncing ? t("Синкую…") : t("Синк KSeF")}
        </Button>
        <Button variant="secondary" disabled={scanning} onClick={() => fileInput.current?.click()}>
          <ScanLine className={`mr-1 h-4 w-4 ${scanning ? "animate-pulse" : ""}`} />{scanning ? t("Розпізнаю…") : t("Скан")}
        </Button>
        <Button variant="secondary" onClick={() => setManagingAgreements(true)}>
          <FolderClock className="mr-1 h-4 w-4" />{t("Умови")}
        </Button>
        <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />{t("Додати фактуру")}</Button>
      </div>

      {data.isFetching && !d ? <Spinner /> : !d ? <Empty>{t("Немає даних")}</Empty> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile icon={<Receipt className="h-5 w-5 text-slate-400" />} label={t("Разом (без дублів)")} value={zl(d.totals.gross)} sub={t("{n} фактур", { n: d.totals.count })} />
            <Tile icon={<CheckCircle2 className="h-5 w-5 text-emerald-500" />} label={t("Оплачено")} value={zl(d.totals.paidGross)} />
            <Tile icon={<AlertCircle className="h-5 w-5 text-amber-500" />} label={t("Не оплачено")} value={zl(d.totals.unpaidGross)} sub={t("{n} фактур", { n: d.totals.unpaidCount })} tone={d.totals.unpaidGross > 0 ? "text-amber-600" : undefined} />
            <Tile icon={<Clock className="h-5 w-5 text-orange-500" />} label={t("Протерміновано")} value={zl(d.totals.overdueGross)} sub={t("{n} фактур", { n: d.totals.overdueCount })} tone={d.totals.overdueCount > 0 ? "text-orange-600" : undefined} />
            <Tile icon={<Landmark className="h-5 w-5 text-sky-500" />} label={t("Переказ")} value={zl(d.totals.przelewGross)} sub={t("{n} фактур", { n: d.totals.przelewCount })} />
            <Tile icon={<Banknote className="h-5 w-5 text-emerald-500" />} label={t("Готівка")} value={zl(d.totals.gotowkaGross)} sub={t("{n} фактур", { n: d.totals.gotowkaCount })} />
            <Tile icon={<FileText className="h-5 w-5 text-slate-400" />} label={t("Показано")} value={String(rows.length)} sub={t("з {n}", { n: d.rows.length })} />
          </div>

          {catBreakdown.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="mr-1 text-slate-400">{t("Категорії:")}</span>
              {catBreakdown.map(([key, v]) => (
                <button key={key} onClick={() => setCatFilter(catFilter === key ? "" : key)}
                  className={`rounded-full border px-2 py-0.5 tabular-nums transition ${catFilter === key ? "border-red-400 font-semibold ring-1 ring-red-300" : "border-transparent hover:brightness-95"} ${badgeClass(catColor(key))}`}>
                  {catIcon(key) && <span className="mr-0.5">{catIcon(key)}</span>}{t(catLabel(key))} · {zl(v.gross)} <span className="opacity-60">({v.n})</span>
                </button>
              ))}
              {catFilter && <button className="ml-1 text-slate-400 underline hover:text-slate-600" onClick={() => setCatFilter("")}>{t("зняти фільтр")}</button>}
            </div>
          )}

          <Card className="overflow-x-auto p-0">
            {!rows.length ? <Empty>{t("Нічого не знайдено")}</Empty> : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                  <th className="px-3 py-2.5">{t("Дата")}</th>
                  <th className="px-2 py-2.5">{t("Номер")}</th>
                  <th className="px-2 py-2.5">{t("Постачальник")}</th>
                  <th className="px-2 py-2.5 text-right">{t("Брутто")}</th>
                  <th className="px-2 py-2.5">{t("Категорія")}</th>
                  <th className="px-2 py-2.5">{t("Спосіб")}</th>
                  <th className="px-2 py-2.5">{t("Оплата")}</th>
                  <th className="px-2 py-2.5" />
                </tr></thead>
                <tbody>
                  {rows.map(r => {
                    const isAgreement = r.origin === "agreement";
                    return (
                    <tr key={r.key} className={`border-b border-slate-100 hover:bg-slate-50/60 ${r.dupOfKsefId ? "opacity-50" : ""} ${!r.driveFileId ? "bg-rose-50/60" : r.overdue ? "bg-orange-50/60" : ""}`}>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-slate-500" title={r.issueDate ?? ""}>
                        {dm(r.issueDate)}
                        {!companyId && <div className="text-[10px] text-slate-400">{r.firm ?? ""}</div>}
                      </td>
                      <td className="px-2 py-1.5">
                        {isAgreement ? (
                          r.driveFileId ? (
                            <a href={`https://drive.google.com/file/d/${r.driveFileId}/view`} target="_blank" rel="noreferrer"
                              className="block max-w-[150px] truncate text-xs font-medium text-sky-700 hover:underline" title={t("відкрити скан умови на Google Drive")}>
                              {agreementDisplayName(r)}
                            </a>
                          ) : (
                            <div className="max-w-[150px] truncate text-xs font-medium text-slate-700" title={agreementDisplayName(r)}>{agreementDisplayName(r)}</div>
                          )
                        ) : r.driveFileId ? (
                          <a href={`https://drive.google.com/file/d/${r.drivePdfId ?? r.driveFileId}/view`} target="_blank" rel="noreferrer"
                            className="block max-w-[150px] truncate text-xs font-medium text-sky-700 hover:underline" title={t("відкрити фактуру на Google Drive")}>
                            {r.number ?? "—"}
                          </a>
                        ) : (
                          <div className="max-w-[150px] truncate text-xs font-medium text-slate-700" title={r.number ?? ""}>{r.number ?? "—"}</div>
                        )}
                        <div className="mt-0.5 flex items-center gap-1">
                          <span className={`rounded px-1 py-0.5 text-[10px] font-semibold ${SOURCE_BADGE[r.source]!.cls}`}>{t(SOURCE_BADGE[r.source]!.label)}</span>
                          {isAgreement && r.agreementKind && (
                            <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-semibold text-slate-500">{t(AGREEMENT_KIND_LABEL[r.agreementKind])}</span>
                          )}
                          {r.isProforma && <span className="rounded bg-fuchsia-100 px-1 py-0.5 text-[10px] font-semibold text-fuchsia-700" title={t("проформа — не фіскальний документ")}>{t("проформа")}</span>}
                          {!r.driveFileId && (
                            <span className="max-w-[110px] truncate rounded bg-rose-100 px-1 py-0.5 text-[10px] font-semibold text-rose-700"
                              title={r.driveError ? r.driveError : isAgreement ? t("скан умови ще не залито в архів") : t("ще не синковано з Drive (крон 06:00 або кнопка «Синк KSeF»)")}>
                              {t("нема на Drive")}{r.driveError ? `: ${r.driveError}` : ""}
                            </span>
                          )}
                          {r.dupOfKsefId && <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-700" title={t("та сама фактура вже є з KSeF — цей рядок не рахується в підсумках")}>{t("дубль KSeF")}</span>}
                          {!isAgreement && (
                            <button onClick={() => void patchRow(r, { cleaning: !r.cleaning })}
                              className={`rounded px-1 py-0.5 text-[10px] font-semibold ${r.cleaning ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-400 hover:bg-slate-200"}`}
                              title={t("видаток бізнесу прибирання — потрапляє у розділ «Прибирання» → Видатки (вспульнота привʼязується там)")}>
                              🧹{r.cleaning ? ` ${t("прибирання")}` : ""}
                            </button>
                          )}
                          {r.hasFile && (
                            <a href={isAgreement ? `/api/agreements/${r.agreementId}/file` : `/api/cost-invoices/${r.id}/file`} target="_blank" rel="noreferrer" className="inline-flex items-center text-[10px] text-red-600 hover:underline">
                              {t("файл")} <ExternalLink className="ml-0.5 h-3 w-3" />
                            </a>
                          )}
                          {noteEditingKey === r.key ? (
                            <span className="inline-flex items-center gap-1">
                              <input autoFocus type="text" value={noteDraft} onChange={e => setNoteDraft(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") void saveNote(r); if (e.key === "Escape") setNoteEditingKey(null); }}
                                placeholder={t("нотатка…")} className="w-32 rounded border border-amber-300 px-1 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-amber-400" />
                              <button onClick={() => void saveNote(r)} className="text-emerald-600 hover:text-emerald-700" title={t("Зберегти")}><CheckCircle2 className="h-3.5 w-3.5" /></button>
                              <button onClick={() => setNoteEditingKey(null)} className="text-slate-400 hover:text-slate-600" title={t("Скасувати")}>×</button>
                            </span>
                          ) : (
                            <span className="group relative inline-flex">
                              <button onClick={() => startNoteEdit(r)}
                                className={`rounded px-0.5 py-0.5 text-xs leading-none ${r.note ? "" : "opacity-30 grayscale hover:opacity-70 hover:grayscale-0"}`}
                                title={r.note ? undefined : t("Додати нотатку")}>
                                📝
                              </button>
                              {r.note && (
                                <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden w-max max-w-[240px] -translate-x-1/2 whitespace-pre-line rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] leading-relaxed text-white shadow-xl group-hover:block">
                                  {r.note}
                                </div>
                              )}
                            </span>
                          )}
                        </div>
                        {r.addedBy && (
                          <button className="mt-0.5 block text-[10px] text-slate-400 hover:text-slate-600 hover:underline"
                            title={t("клік — історія змін")} onClick={() => setAuditFor(auditTargetFor(r))}>
                            {t("додав(-ла)")} {r.addedBy}{r.addedAt ? ` · ${new Date(r.addedAt).toLocaleDateString("uk-UA")}` : ""}
                          </button>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="max-w-[170px] truncate text-xs text-slate-700" title={`${r.seller ?? ""}${r.sellerNip ? ` · NIP ${r.sellerNip}` : ""}`}>{r.seller ?? "—"}</div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right text-xs font-medium tabular-nums">
                        {isAgreement ? (
                          <span className="inline-flex items-center gap-1">
                            <input key={r.key} type="text" defaultValue={r.gross.toFixed(2)} title={t("клік — скоригувати суму за цей місяць (умова не змінюється)")}
                              onBlur={e => {
                                const v = Number(e.target.value.replace(/\s/g, "").replace(",", "."));
                                if (Number.isFinite(v) && v > 0 && Math.abs(v - r.gross) > 0.001) void patchRow(r, { amount: v });
                                else e.target.value = r.gross.toFixed(2);
                              }}
                              className="w-16 rounded border border-transparent bg-transparent text-right text-xs font-medium tabular-nums hover:border-slate-300 focus:border-sky-400 focus:outline-none" />
                            <span className="text-slate-400">zł</span>
                          </span>
                        ) : zl(r.gross)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        {isAgreement ? (
                          <span className="text-xs text-slate-500" title={t("категорія умови — редагується в «Умови»")}>
                            {catIcon(r.category) ? `${catIcon(r.category)} ` : ""}{t(catLabel(r.category))}
                          </span>
                        ) : (
                          <select
                            value={r.categorySource === "manual" ? r.category : ""}
                            onChange={e => void patchRow(r, { expenseCategory: e.target.value || null })}
                            className={`max-w-[130px] cursor-pointer truncate rounded border-0 bg-transparent p-0 text-xs focus:ring-0 ${r.categorySource === "manual" ? "font-medium text-sky-700" : "text-slate-500"}`}
                            title={r.categorySource === "manual" ? t("категорію вибрано вручну") : t("категорія авто (правила/патерни) — можна змінити")}>
                            <option value="">{catIcon(r.category) ? `${catIcon(r.category)} ` : ""}{t(catLabel(r.category))}{r.categorySource === "auto" ? ` (${t("авто")})` : ""}</option>
                            {(d.categories ?? []).map(c => <option key={c.key} value={c.key}>{c.icon ? `${c.icon} ` : ""}{t(c.label)}</option>)}
                            <option value="other">🗂️ {t("Інше")}</option>
                          </select>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        {(
                          <>
                            <button onClick={() => cycleMethod(r)}
                              className={`rounded px-1.5 py-0.5 text-sm ${r.paymentMethod === "gotowka" ? "bg-emerald-50 hover:bg-emerald-100" : r.paymentMethod === "przelew" ? "bg-sky-50 hover:bg-sky-100" : "bg-slate-100 text-slate-400 hover:bg-slate-200"}`}
                              title={`${r.paymentMethod === "gotowka" ? t("готівка") : r.paymentMethod === "przelew" ? t("переказ") : "—"}${r.paymentMethod && r.paymentMethodSource === "auto" ? ` (${t("авто")})` : ""} · ${t("клік — змінити: переказ → готівка → авто")}`}>
                              {r.paymentMethod === "gotowka" ? "💵" : r.paymentMethod === "przelew" ? "🏦" : "—"}
                            </button>
                            {r.paymentMethod === "gotowka" && (
                              <label className="mt-0.5 flex cursor-pointer items-center gap-1 text-[10px] text-slate-500" title={t("відмітка кшєнгової: фактура внесена в готівковий рапорт")}>
                                <input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-300" checked={r.cashReport}
                                  onChange={() => void patchRow(r, { cashReport: !r.cashReport })} />
                                {t("рапорт")}
                              </label>
                            )}
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        {(
                          <>
                            <button onClick={() => togglePaid(r)}
                              className={`rounded px-1.5 py-0.5 text-xs font-medium ${r.paid ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-amber-50 text-amber-700 hover:bg-amber-100"}`}
                              title={`${r.paid ? `${t("оплачена")} ${r.paidDate ?? ""}${r.paidSource === "bank" ? ` (${t("витяг")})` : r.paidSource === "register" ? ` (${t("реєстр")})` : r.paidSource === "manual" ? ` (${t("вручну")})` : ""}` : t("не оплачена")} · ${t("клік — змінити статус оплати")}`}>
                              {r.paid ? `✓ ${dm(r.paidDate)}` : `✗ ${t("ні")}`}
                            </button>
                            {/* термін оплати — рядком під статусом, редагований для KSeF */}
                            <div className="mt-0.5 flex items-center gap-1 text-[10px]">
                              {r.origin === "ksef" ? (
                                <input type="date" value={r.dueDate ?? ""} onChange={e => void patchRow(r, { dueDate: e.target.value || null })}
                                  title={r.overdue ? t("прострочено") : t("термін оплати (з XML фактури; можна виправити)")}
                                  className={`w-24 rounded border border-transparent bg-transparent p-0 text-[10px] hover:border-slate-300 ${r.overdue ? "font-semibold text-orange-600" : "text-slate-400"}`} />
                              ) : (
                                r.dueDate && <span className={r.overdue ? "font-semibold text-orange-600" : "text-slate-400"} title={r.overdue ? t("прострочено") : t("Термін оплати")}>{t("до")} {dm(r.dueDate)}</span>
                              )}
                              {r.overdue && <span title={t("прострочено")}>⚠️</span>}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">
                        <button className="p-1 text-slate-300 hover:text-slate-600" title={t("Історія змін (хто додав / змінив / затвердив)")}
                          onClick={() => setAuditFor(auditTargetFor(r))}>
                          <History className="h-4 w-4" />
                        </button>
                        {!isAgreement && !r.driveFileId && (
                          <button className="p-1 text-slate-300 hover:text-sky-600 disabled:animate-pulse" disabled={pushing === r.key}
                            title={t("Залити на Drive зараз (KSeF-рядку заодно підтягне термін оплати)")}
                            onClick={() => void pushDrive(r)}>
                            <UploadCloud className="h-4 w-4" />
                          </button>
                        )}
                        {r.origin === "local" && (r.source === "manual" || r.source === "scan") && (
                          <>
                            <button className="p-1 text-slate-300 hover:text-slate-600" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></button>
                            <button className="p-1 text-slate-300 hover:text-rose-500" onClick={async () => {
                              if (!confirm(t("Видалити фактуру №{n}?", { n: r.number ?? "" }))) return;
                              try { await del(`/cost-invoices/${r.id}`); invalidate(); } catch (e: any) { toast.error(e?.message || "error"); }
                            }}><Trash2 className="h-4 w-4" /></button>
                          </>
                        )}
                        {isAgreement && (
                          <button className="p-1 text-slate-300 hover:text-slate-600" title={t("Редагувати запис цього місяця (сума, оплата, спосіб)")}
                            onClick={() => setEditingCharge(r)}><Pencil className="h-4 w-4" /></button>
                        )}
                        {isAgreement && (
                          <button className="p-1 text-slate-300 hover:text-rose-500" title={t("Видалити запис цього місяця (сама умова лишиться)")}
                            onClick={async () => {
                              if (!confirm(t("Видалити запис-витрату за {m}? Сама умова лишиться.", { m: r.serviceMonth ?? "" }))) return;
                              try { await del(`/agreements/charges/${r.id}`); invalidate(); } catch (e: any) { toast.error(e?.message || "error"); }
                            }}><Trash2 className="h-4 w-4" /></button>
                        )}
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
            )}
          </Card>
          <p className="mt-3 text-xs text-slate-400">
            {t("KSeF-фактури приходять автоматично; «вручну» — внесені тут; «скан» — з бота (кнопка «📄 Фактура») або кнопкою «Скан». Оплата «витяг» проставляється банківським матчингом сама.")}
            {" "}{t("Усі фактури архівуються PDF-ами на Google Drive (Faktury kosztowe → рік → місяць → фірма), імʼя файла = номер + постачальник. Червоний рядок = файла ще немає на Drive (причина — в бейджі).")}
          </p>
        </>
      )}

      {auditFor && <InvoiceAuditModal target={auditFor} onClose={() => setAuditFor(null)} />}

      {(adding || editing) && (
        <InvoiceModal
          row={editing}
          prefill={editing ? null : prefill}
          initialFile={editing ? null : scanFile}
          companies={d?.companies ?? []}
          cities={d?.cities ?? []}
          categories={d?.categories ?? []}
          onClose={() => { setAdding(false); setEditing(null); setPrefill(null); setScanFile(null); }}
          onSaved={() => { setAdding(false); setEditing(null); setPrefill(null); setScanFile(null); invalidate(); }}
        />
      )}

      {editingCharge && (
        <ChargeModal row={editingCharge} onClose={() => setEditingCharge(null)}
          onSaved={() => { setEditingCharge(null); invalidate(); }} />
      )}

      {managingAgreements && (
        <AgreementsModal
          companies={d?.companies ?? []}
          categories={d?.categories ?? []}
          onClose={() => setManagingAgreements(false)}
          onChanged={invalidate}
        />
      )}
      </>)}
    </>
  );
}

// PDF рендеримо самі через pdf.js (канвасами) — вбудований переглядач браузера
// може бути налаштований «скачувати PDF», і превʼю тоді не показується взагалі.
function PdfPreview({ url }: { url: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url" as any)).default as string;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const doc = await pdfjs.getDocument({ url }).promise;
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = "";
        const pages = Math.min(doc.numPages, 3);
        for (let i = 1; i <= pages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1.6 });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width; canvas.height = vp.height;
          canvas.style.width = "100%";
          canvas.className = "mb-2 rounded border border-slate-200 bg-white";
          if (cancelled || !ref.current) return;
          ref.current.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp } as any).promise;
        }
        if (doc.numPages > pages && ref.current && !cancelled) {
          const more = document.createElement("div");
          more.className = "pb-2 text-center text-xs text-slate-400";
          more.textContent = `+${doc.numPages - pages}`;
          ref.current.appendChild(more);
        }
      } catch { if (!cancelled) setErr(true); }
    })();
    return () => { cancelled = true; };
  }, [url]);
  if (err) return <div className="p-4 text-sm text-slate-400">{t("Не вдалося показати PDF — відкрий через лінк «файл».")}</div>;
  return <div ref={ref} className="max-h-[560px] overflow-y-auto p-2" />;
}

function Tile({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400">{icon}{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tone ?? "text-slate-800"}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </Card>
  );
}

function InvoiceModal({ row, prefill, initialFile, companies, cities, categories, onClose, onSaved }: {
  row: Row | null; prefill?: Partial<Row> | null; initialFile?: File | null;
  companies: { id: number; name: string }[]; cities: string[];
  categories: { key: string; label: string; icon: string | null; color: string | null }[]; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const src = row ?? prefill;
  const [f, setF] = useState({
    companyId: src?.companyId ? String(src.companyId) : "",
    issueDate: src?.issueDate ?? new Date().toISOString().slice(0, 10),
    number: src?.number ?? "",
    seller: src?.seller ?? "",
    sellerNip: src?.sellerNip ?? "",
    amount: src?.gross ? String(src.gross) : "",
    dueDate: row?.dueDate ?? "",
    note: row?.note ?? "",
    paid: row?.paid ?? false,
    paidDate: row?.paidDate ?? "",
    hostelId: row?.hostelId ? String(row.hostelId) : "",
    vehicleId: row?.vehicleId ? String(row.vehicleId) : "",
    city: row?.city ?? "",
    serviceMonth: row?.serviceMonth ?? "",
    cleaning: row?.cleaning ?? false,
    isProforma: row?.isProforma ?? false,
    // "" = авто-категорія (правила/патерни по постачальнику)
    expenseCategory: row?.categorySource === "manual" ? row.category : "",
  });
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setF(p => ({ ...p, [k]: v }));
  const hostels = useQuery<{ id: number; name: string; city: string; active: boolean }[]>({
    queryKey: ["hostel-options"], queryFn: () => get("/hostels/options"), staleTime: 60_000,
  });
  const vehicleOpts = useQuery<{ id: number; plate: string; brandModel: string | null }[]>({
    queryKey: ["vehicles"], queryFn: () => get("/vehicles"), staleTime: 60_000,
  });

  // превʼю: свіжовибраний файл або збережений скан — завжди через blob-URL,
  // щоб браузер рендерив інлайн (PDF у iframe), а не пропонував скачати
  const [preview, setPreview] = useState<{ url: string; isImage: boolean } | null>(null);
  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    (async () => {
      if (file) {
        revoke = URL.createObjectURL(file);
        setPreview({ url: revoke, isImage: file.type.startsWith("image/") });
      } else if (row?.hasFile) {
        try {
          const r = await fetch(`/api/cost-invoices/${row.id}/file`, { credentials: "include" });
          if (!r.ok || cancelled) return;
          const blob = await r.blob();
          revoke = URL.createObjectURL(blob);
          if (!cancelled) setPreview({ url: revoke, isImage: (blob.type || "").startsWith("image/") });
        } catch { /* без превʼю */ }
      } else setPreview(null);
    })();
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [file, row?.id, row?.hasFile]);

  const save = async () => {
    if (!f.companyId || !f.issueDate || !f.number.trim() || !f.amount) { toast.error(t("Фірма, дата, номер і сума — обов'язкові")); return; }
    // ручна фактура без скана не зберігається (вимога 26.08) — файл їде в архів на Drive
    if (!row && !file) { toast.error(t("Додай фото або скан фактури — без файла не зберігаємо")); return; }
    setSaving(true);
    try {
      const body = {
        companyId: Number(f.companyId), issueDate: f.issueDate, number: f.number.trim(),
        seller: f.seller.trim() || null, sellerNip: f.sellerNip.trim() || null,
        amount: f.amount, dueDate: f.dueDate || null, note: f.note.trim() || null,
        paid: f.paid, paidDate: f.paid ? (f.paidDate || undefined) : undefined,
        hostelId: f.hostelId ? Number(f.hostelId) : null,
        vehicleId: f.vehicleId ? Number(f.vehicleId) : null,
        city: f.city.trim() || null,
        serviceMonth: f.serviceMonth || null,
        cleaning: f.cleaning,
        isProforma: f.isProforma,
        expenseCategory: f.expenseCategory || null,
      };
      const saved = row ? await patch(`/cost-invoices/${row.id}`, body) : await post("/cost-invoices", body);
      if (file) {
        const fd = new FormData();
        fd.append("file", await shrinkImageFile(file));
        await upload(`/cost-invoices/${saved.id ?? row?.id}/file`, fd); // кидає реальний текст помилки сервера
      }
      toast.success(row ? t("Збережено") : t("Фактуру додано"));
      onSaved();
    } catch (e: any) { toast.error(e?.message || "error"); }
    finally { setSaving(false); }
  };

  return (
    <Modal open title={row ? t("Редагувати фактуру") : t("Нова фактура")} onClose={onClose} size="xl">
      <div className={`grid gap-4 ${preview ? "lg:grid-cols-[1fr_380px]" : ""}`}>
      <div className="grid h-fit grid-cols-2 gap-3">
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Фірма (наша)")} *</span>
          <Select value={f.companyId} onChange={e => set("companyId", e.target.value)}>
            <option value="">—</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Дата виставлення")} *</span>
          <Input type="date" value={f.issueDate} onChange={e => set("issueDate", e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Номер фактури")} *</span>
          <Input value={f.number} onChange={e => set("number", e.target.value)} placeholder="FV 123/2026" /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Сума брутто")} *</span>
          <Input value={f.amount} onChange={e => set("amount", e.target.value)} placeholder="1234,56" /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Постачальник (хто виставив)")}</span>
          <Input value={f.seller} onChange={e => set("seller", e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">NIP</span>
          <Input value={f.sellerNip} onChange={e => set("sellerNip", e.target.value)} placeholder="1234567890" /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Термін оплати")}</span>
          <Input type="date" value={f.dueDate} onChange={e => set("dueDate", e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Нотатка")}</span>
          <Input value={f.note} onChange={e => set("note", e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("За який місяць (P&L)")}</span>
          <Input type="month" value={f.serviceMonth} onChange={e => set("serviceMonth", e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Категорія витрат")}</span>
          <Select value={f.expenseCategory} onChange={e => set("expenseCategory", e.target.value)}>
            <option value="">{t("— авто (правила/патерни) —")}</option>
            {categories.map(c => <option key={c.key} value={c.key}>{c.icon ? `${c.icon} ` : ""}{t(c.label)}</option>)}
            <option value="other">🗂️ {t("Інше")}</option>
          </Select></label>
        {(hostels.data?.length ?? 0) > 0 && (
          <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Хостел (оренда/медіа)")}</span>
            <Select value={f.hostelId} onChange={e => set("hostelId", e.target.value)}>
              <option value="">—</option>
              {hostels.data!.map(h => <option key={h.id} value={h.id}>{h.city} · {h.name}</option>)}
            </Select></label>
        )}
        {(vehicleOpts.data?.length ?? 0) > 0 && (
          <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Авто (лізинг/сервіс)")}</span>
            <Select value={f.vehicleId} onChange={e => set("vehicleId", e.target.value)}>
              <option value="">—</option>
              {vehicleOpts.data!.map(v => <option key={v.id} value={v.id}>{v.brandModel ?? ""} {v.plate}</option>)}
            </Select></label>
        )}
        {!f.hostelId && (
          <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Місто (cost-center для P&L)")}</span>
            <Input list="ci-cities" value={f.city} onChange={e => set("city", e.target.value)} placeholder="—" />
            <datalist id="ci-cities">{cities.map(c => <option key={c} value={c} />)}</datalist></label>
        )}
        <label className="col-span-2 flex items-center gap-2 pt-1 text-sm text-slate-600">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={f.paid} onChange={e => set("paid", e.target.checked)} />
          {t("Оплачена")}
          {f.paid && <Input type="date" value={f.paidDate} onChange={e => set("paidDate", e.target.value)} className="w-40" />}
        </label>
        <label className="col-span-2 flex items-center gap-2 text-sm text-slate-600" title={t("потрапляє у розділ «Прибирання» → Видатки")}>
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={f.cleaning} onChange={e => set("cleaning", e.target.checked)} />
          🧹 {t("Видаток бізнесу прибирання")}
        </label>
        <label className="col-span-2 flex items-center gap-2 text-sm text-slate-600" title={t("нефіскальний документ — в архіві на Drive йде в окрему підпапку Proformy")}>
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={f.isProforma} onChange={e => set("isProforma", e.target.checked)} />
          {t("Проформа")}
        </label>
        <label className="col-span-2 block"><span className="mb-1 block text-xs text-slate-500">{t("Файл (PDF/фото), необов'язково")}</span>
          {file && <div className="mb-1 text-xs text-emerald-700">📎 {file.name} <button type="button" className="ml-1 text-slate-400 hover:text-rose-500" onClick={() => setFile(null)}>×</button></div>}
          <input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} className="text-sm text-slate-500" /></label>
      </div>
      {preview && (
        <div className="min-h-[420px] overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {preview.isImage
            ? <img src={preview.url} alt="" className="h-full max-h-[560px] w-full object-contain" />
            : <PdfPreview url={preview.url} />}
        </div>
      )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
        <Button disabled={saving} onClick={save}>{row ? t("Зберегти") : t("Додати")}</Button>
      </div>
    </Modal>
  );
}

// ── «Умови» (агрименти/договори): одноразові/на термін/безстрокові зобов'язання,
// що щомісяця самі генерують запис-витрату (agreement_charges) на /cost-invoices.
type VatRate = "23" | "8" | "zw";
interface AgreementCondition {
  id: number; companyId: number; firm: string | null;
  title: string; counterparty: string | null; category: string;
  kind: AgreementKind; amount: number; vatRate: VatRate;
  paymentMethod: PayMethod; // дефолт для записів місяців (точково перебивається у списку)
  city: string | null; startMonth: string; endMonth: string | null;
  filePath: string | null; driveFileId: string | null; driveError: string | null; note: string | null;
  active: boolean; hasFile: boolean; status: "active" | "scheduled" | "ended" | "deleted";
}
const AGREEMENT_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  active: { label: "чинна", cls: "bg-emerald-100 text-emerald-700" },
  scheduled: { label: "ще не почалась", cls: "bg-sky-100 text-sky-700" },
  ended: { label: "завершена", cls: "bg-slate-100 text-slate-500" },
  deleted: { label: "видалена", cls: "bg-rose-100 text-rose-700" },
};
const VAT_LABEL: Record<VatRate, string> = { "23": "23%", "8": "8%", zw: "zw." };
// список YYYY-MM від from до to включно (дзеркало services/agreementConditions.ts monthRange)
function monthRangeClient(from: string, to: string): string[] {
  if (!from || !to || from > to) return [];
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  let cur = `${y}-${String(m).padStart(2, "0")}`;
  while (cur <= to && out.length < 600) {
    out.push(cur);
    m++; if (m > 12) { m = 1; y++; }
    cur = `${y}-${String(m).padStart(2, "0")}`;
  }
  return out;
}

// Запис умови за місяць — форма як у ручної фактури: сума, нотатка, спосіб оплати,
// «Оплачена» + дата. Сама умова (категорія, контрагент, термін) правиться в «Умови».
function ChargeModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [f, setF] = useState({
    amount: String(row.gross),
    note: row.note ?? "",
    paymentMethod: (row.paymentMethodSource === "manual" ? row.paymentMethod : "") ?? "",
    paid: row.paid,
    paidDate: row.paidDate ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setF(p => ({ ...p, [k]: v }));
  const save = async () => {
    setSaving(true);
    try {
      await patch(`/agreements/charges/${row.id}`, {
        amount: f.amount, note: f.note.trim() || null,
        paymentMethod: f.paymentMethod || null,
        paid: f.paid, paidDate: f.paid ? (f.paidDate || undefined) : undefined,
      });
      toast.success(t("Збережено"));
      onSaved();
    } catch (e: any) { toast.error(e?.message || "error"); }
    finally { setSaving(false); }
  };
  return (
    <Modal open title={`${t("Запис умови")} · ${row.serviceMonth ?? ""}`} onClose={onClose}>
      <div className="mb-3 text-sm text-slate-600">{row.seller ? `${row.seller} · ` : ""}{t("умова")} #{row.agreementId}</div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Сума (брутто)")}</span>
          <Input value={f.amount} onChange={e => set("amount", e.target.value)} title={t("клік — скоригувати суму за цей місяць (умова не змінюється)")} /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Спосіб оплати")}</span>
          <Select value={f.paymentMethod} onChange={e => set("paymentMethod", e.target.value)}>
            <option value="">{t("авто")}{row.paymentMethodSource === "auto" && row.paymentMethod ? ` (${row.paymentMethod === "gotowka" ? `💵 ${t("готівка")}` : `🏦 ${t("переказ")}`})` : ""}</option>
            <option value="przelew">🏦 {t("переказ")}</option>
            <option value="gotowka">💵 {t("готівка")}</option>
          </Select></label>
        <label className="col-span-2 block"><span className="mb-1 block text-xs text-slate-500">{t("Нотатка")}</span>
          <Input value={f.note} onChange={e => set("note", e.target.value)} /></label>
        <label className="col-span-2 flex items-center gap-2 pt-1 text-sm text-slate-600">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={f.paid} onChange={e => set("paid", e.target.checked)} />
          {t("Оплачена")}
          {f.paid && <Input type="date" value={f.paidDate} onChange={e => set("paidDate", e.target.value)} className="w-40" />}
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
        <Button disabled={saving} onClick={save}>{t("Зберегти")}</Button>
      </div>
    </Modal>
  );
}

function AgreementsModal({ companies, categories, onClose, onChanged }: {
  companies: { id: number; name: string }[];
  categories: { key: string; label: string; icon: string | null; color: string | null }[];
  onClose: () => void; onChanged: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [companyId, setCompanyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgreementCondition | null>(null);
  const [auditFor, setAuditFor] = useState<AuditTarget | null>(null);
  const [genFor, setGenFor] = useState<number | null>(null); // точковий бекфіл одного місяця
  const [genMonth, setGenMonth] = useState("");
  const runGenerate = async (agreementId: number) => {
    if (!genMonth) return;
    try {
      const r = await post(`/agreements/${agreementId}/generate`, { month: genMonth });
      if (r?.created) toast.success(t("Додано за {m}", { m: genMonth }));
      else toast.info(t("За {m} вже є запис або місяць поза межами умови", { m: genMonth }));
      setGenFor(null); setGenMonth("");
      refresh();
    } catch (e: any) { toast.error(e?.message || "error"); }
  };
  const q = useQuery<{ rows: AgreementCondition[] }>({
    queryKey: ["agreements", companyId],
    queryFn: () => get(`/agreements${companyId ? `?companyId=${companyId}` : ""}`),
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["agreements"] }); onChanged(); };
  const catLabel = (k: string) => categories.find(c => c.key === k)?.label ?? (k === "other" ? "Інше" : k);
  const catIcon = (k: string) => categories.find(c => c.key === k)?.icon ?? (k === "other" ? "🗂️" : "");

  return (
    <Modal open title={t("Умови")} onClose={onClose} size="xl">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-40">
          <option value="">{t("Всі фірми")}</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Button onClick={() => setCreating(true)}><Plus className="mr-1 h-4 w-4" />{t("Додати умову")}</Button>
      </div>
      {q.isFetching && !q.data ? <Spinner /> : !q.data?.rows.length ? <Empty>{t("Умов ще нема")}</Empty> : (
        <div className="max-h-[65vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
              <th className="px-2 py-2">{t("Назва")}</th>
              <th className="px-2 py-2">{t("Тип")}</th>
              <th className="px-2 py-2">{t("Категорія")}</th>
              <th className="px-2 py-2 text-right">{t("Сума/міс")}</th>
              <th className="px-2 py-2">{t("Період")}</th>
              <th className="px-2 py-2">{t("Статус")}</th>
              <th className="px-2 py-2" />
            </tr></thead>
            <tbody>
              {q.data.rows.map(a => (
                <tr key={a.id} className="border-b border-slate-100">
                  <td className="px-2 py-1.5">
                    <div className="max-w-[160px] truncate text-xs font-medium text-slate-700" title={a.title}>{a.title}</div>
                    {!companyId && <div className="text-[10px] text-slate-400">{a.firm ?? ""}</div>}
                    {a.hasFile && (
                      <a href={`/api/agreements/${a.id}/file`} target="_blank" rel="noreferrer" className="inline-flex items-center text-[10px] text-red-600 hover:underline">
                        {t("файл")} <ExternalLink className="ml-0.5 h-3 w-3" />
                      </a>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-slate-500">{t(AGREEMENT_KIND_LABEL[a.kind])}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-slate-500">{catIcon(a.category)} {t(catLabel(a.category))}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right text-xs font-medium tabular-nums">
                    {zl(a.amount)} <span className="text-[10px] font-normal text-slate-400">{t("брутто")} · {VAT_LABEL[a.vatRate]}{a.paymentMethod === "gotowka" ? " · 💵" : a.paymentMethod === "przelew" ? " · 🏦" : ""}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-slate-500">
                    {a.startMonth}{a.kind !== "one_time" && ` – ${a.endMonth ?? "…"}`}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${AGREEMENT_STATUS_BADGE[a.status]!.cls}`}>{t(AGREEMENT_STATUS_BADGE[a.status]!.label)}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">
                    {genFor === a.id ? (
                      <span className="inline-flex items-center gap-1">
                        <input type="month" value={genMonth} onChange={e => setGenMonth(e.target.value)} className="w-28 rounded border border-slate-300 px-1 py-0.5 text-xs" />
                        <button className="p-1 text-emerald-600 hover:text-emerald-700" title={t("Додати")} onClick={() => void runGenerate(a.id)}><Plus className="h-4 w-4" /></button>
                        <button className="p-1 text-slate-300 hover:text-slate-500" title={t("Скасувати")} onClick={() => { setGenFor(null); setGenMonth(""); }}>×</button>
                      </span>
                    ) : (
                      <button className="p-1 text-slate-300 hover:text-slate-600" title={t("Додати запис за конкретний місяць (напр. пропущений при створенні)")}
                        onClick={() => { setGenFor(a.id); setGenMonth(""); }}>
                        <CalendarPlus className="h-4 w-4" />
                      </button>
                    )}
                    <button className="p-1 text-slate-300 hover:text-slate-600" title={t("Історія дій")}
                      onClick={() => setAuditFor({ kind: "agreement", entity: "condition", id: a.id, label: a.title })}>
                      <History className="h-4 w-4" />
                    </button>
                    {a.active && (
                      <button className="p-1 text-slate-300 hover:text-slate-600" title={t("Редагувати / достроково завершити")} onClick={() => setEditing(a)}>
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}
                    {a.active && (
                      <button className="p-1 text-slate-300 hover:text-rose-500" title={t("Видалити умову (історія лишиться)")}
                        onClick={async () => {
                          if (!confirm(t("Видалити умову «{n}»? Уже згенеровані записи-витрати лишаться.", { n: a.title }))) return;
                          try { await del(`/agreements/${a.id}`); refresh(); } catch (e: any) { toast.error(e?.message || "error"); }
                        }}><Ban className="h-4 w-4" /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {auditFor && <InvoiceAuditModal target={auditFor} onClose={() => setAuditFor(null)} />}
      {(creating || editing) && (
        <AgreementFormModal
          row={editing} companies={companies} categories={categories}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); refresh(); }}
        />
      )}
    </Modal>
  );
}

function AgreementFormModal({ row, companies, categories, onClose, onSaved }: {
  row: AgreementCondition | null;
  companies: { id: number; name: string }[];
  categories: { key: string; label: string; icon: string | null; color: string | null }[];
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [f, setF] = useState({
    companyId: row?.companyId ? String(row.companyId) : "",
    counterparty: row?.counterparty ?? "",
    category: row?.category ?? "",
    kind: row?.kind ?? "fixed_term" as AgreementKind,
    amount: row ? String(row.amount) : "",
    vatRate: (row?.vatRate ?? "23") as VatRate,
    paymentMethod: (row?.paymentMethod ?? "") as "" | "przelew" | "gotowka",
    city: row?.city ?? "",
    startMonth: row?.startMonth ?? thisMonth,
    endMonth: row?.endMonth ?? "",
    note: row?.note ?? "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setF(p => ({ ...p, [k]: v }));

  // умова заднім числом (лише при створенні) — прев'ю місяців, які отримають
  // запис у списку фактур, з можливістю зняти зайве
  const backfillRange = useMemo(() => {
    if (row) return [];
    const to = f.kind === "one_time" ? f.startMonth
      : f.kind === "fixed_term" && f.endMonth && f.endMonth < thisMonth ? f.endMonth
      : thisMonth;
    return monthRangeClient(f.startMonth, to);
  }, [row, f.kind, f.startMonth, f.endMonth, thisMonth]);
  // пік показуємо лише коли є ГЕНУЇННО минулий місяць — «діє з поточного» не
  // потребує вибору, той місяць і так згенерується стандартним шляхом
  const showBackfillPicker = backfillRange.some(m => m < thisMonth);
  const [excludedMonths, setExcludedMonths] = useState<Set<string>>(new Set());
  const toggleMonth = (m: string) => setExcludedMonths(prev => {
    const next = new Set(prev);
    next.has(m) ? next.delete(m) : next.add(m);
    return next;
  });

  const save = async () => {
    if (!f.companyId || !f.category || !f.amount || !f.startMonth) {
      toast.error(t("Фірма, категорія, сума і місяць «діє з» — обов'язкові")); return;
    }
    if (f.kind === "fixed_term" && !f.endMonth) { toast.error(t("Для умови «на термін» задай місяць завершення")); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        companyId: Number(f.companyId), counterparty: f.counterparty.trim() || null,
        category: f.category, amount: f.amount, vatRate: f.vatRate,
        paymentMethod: f.paymentMethod || null,
        city: f.city.trim() || null, note: f.note.trim() || null,
      };
      if (!row) {
        body.kind = f.kind; body.startMonth = f.startMonth;
        if (showBackfillPicker) body.backfillMonths = backfillRange.filter(m => !excludedMonths.has(m));
      }
      if (f.kind !== "one_time") body.endMonth = f.kind === "fixed_term" ? f.endMonth : (row ? f.endMonth || null : null);
      const saved = row ? await patch(`/agreements/${row.id}`, body) : await post("/agreements", body);
      if (file) {
        const fd = new FormData();
        fd.append("file", await shrinkImageFile(file));
        await upload(`/agreements/${saved.id ?? row?.id}/file`, fd); // кидає реальний текст помилки сервера
      }
      toast.success(row ? t("Збережено") : t("Умову додано"));
      onSaved();
    } catch (e: any) { toast.error(e?.message || "error"); }
    finally { setSaving(false); }
  };

  return (
    <Modal open title={row ? t("Редагувати умову") : t("Нова умова")} onClose={onClose} size="lg">
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Фірма (наша)")} *</span>
          <Select value={f.companyId} onChange={e => set("companyId", e.target.value)} disabled={!!row}>
            <option value="">—</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Контрагент")}</span>
          <Input value={f.counterparty} onChange={e => set("counterparty", e.target.value)} placeholder={t("напр. власник офісу")}
            title={t("Назва умови в списку складається сама: категорія + контрагент")} /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Категорія")} *</span>
          <Select value={f.category} onChange={e => set("category", e.target.value)}>
            <option value="">—</option>
            {categories.map(c => <option key={c.key} value={c.key}>{c.icon ? `${c.icon} ` : ""}{t(c.label)}</option>)}
            <option value="other">🗂️ {t("Інше")}</option>
          </Select></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Тип умови")} *</span>
          <Select value={f.kind} onChange={e => set("kind", e.target.value)} disabled={!!row}>
            <option value="one_time">{t("Разова")}</option>
            <option value="fixed_term">{t("На термін")}</option>
            <option value="indefinite">{t("Безстрокова")}</option>
          </Select></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">
          {f.kind === "one_time" ? t("Місяць послуги") : t("Діє з")} *</span>
          <Input type="month" value={f.startMonth} onChange={e => set("startMonth", e.target.value)} disabled={!!row} /></label>
        {f.kind === "fixed_term" && (
          <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Діє до")} *</span>
            <Input type="month" value={f.endMonth} onChange={e => set("endMonth", e.target.value)} /></label>
        )}
        {f.kind === "indefinite" && row && (
          <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Завершити достроково (порожньо = діє далі)")}</span>
            <Input type="month" value={f.endMonth} onChange={e => set("endMonth", e.target.value)} /></label>
        )}
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Сума (брутто)")} *</span>
          <Input value={f.amount} onChange={e => set("amount", e.target.value)} placeholder="1234,56"
            title={t("Завжди сума брутто — як на документі")} /></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Ставка ВАТ у сумі")}</span>
          <Select value={f.vatRate} onChange={e => set("vatRate", e.target.value)}>
            <option value="23">23%</option>
            <option value="8">8%</option>
            <option value="zw">{t("zwolnione (без ВАТ)")}</option>
          </Select></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Спосіб оплати")}</span>
          <Select value={f.paymentMethod} onChange={e => set("paymentMethod", e.target.value)}
            title={t("дефолт для всіх місяців умови; окремий місяць можна перебити в списку фактур")}>
            <option value="">—</option>
            <option value="przelew">🏦 {t("переказ")}</option>
            <option value="gotowka">💵 {t("готівка")}</option>
          </Select></label>
        <label className="block"><span className="mb-1 block text-xs text-slate-500">{t("Місто (cost-center для P&L)")}</span>
          <Input value={f.city} onChange={e => set("city", e.target.value)} /></label>
        <label className="col-span-2 block"><span className="mb-1 block text-xs text-slate-500">{t("Нотатка")}</span>
          <Input value={f.note} onChange={e => set("note", e.target.value)} /></label>
        {showBackfillPicker && (
          <div className="col-span-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="mb-2 text-xs font-medium text-amber-800">
              {t("Умова діє заднім числом — ці місяці отримають запис у списку фактур (зніми зайве):")}
            </div>
            <div className="flex flex-wrap gap-2">
              {backfillRange.map(m => (
                <label key={m} className="flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-1 text-xs">
                  <input type="checkbox" checked={!excludedMonths.has(m)} onChange={() => toggleMonth(m)} />
                  {m}
                </label>
              ))}
            </div>
          </div>
        )}
        <label className="col-span-2 block"><span className="mb-1 block text-xs text-slate-500">{t("Скан умови (PDF/фото)")}</span>
          {file && <div className="mb-1 text-xs text-emerald-700">📎 {file.name} <button type="button" className="ml-1 text-slate-400 hover:text-rose-500" onClick={() => setFile(null)}>×</button></div>}
          {!file && row?.hasFile && <div className="mb-1 text-xs text-slate-500">📎 {t("скан уже завантажено")}</div>}
          <input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} className="text-sm text-slate-500" /></label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
        <Button disabled={saving} onClick={save}>{row ? t("Зберегти") : t("Додати")}</Button>
      </div>
    </Modal>
  );
}
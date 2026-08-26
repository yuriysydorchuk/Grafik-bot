// «Фактури» (/cost-invoices) — робочий модуль фактур коштових: KSeF-закупівлі +
// внесені вручну/скановані ботом в одному списку зі статусами оплат. Доступ:
// viewFinance або costInvoices (роль «бухгалтерія»).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, FileText, CheckCircle2, AlertCircle, Receipt, ExternalLink, Pencil, Trash2, ScanLine, RefreshCw, Banknote, Landmark, Clock, UploadCloud, History } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { InvoiceAuditModal } from "../components/InvoiceAuditModal";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { KsefSales } from "./Ksef";
import { badgeClass } from "../lib/colors";

type PayMethod = "przelew" | "gotowka" | null;
interface Row {
  key: string; origin: "ksef" | "local"; id: number;
  source: "ksef" | "manual" | "scan" | "sheet";
  companyId: number | null; firm: string | null;
  issueDate: string | null; number: string | null;
  seller: string | null; sellerNip: string | null;
  gross: number; dueDate: string | null;
  paid: boolean; paidDate: string | null; paidSource: string | null;
  note: string | null; hasFile: boolean; dupOfKsefId: number | null;
  hostelId: number | null; vehicleId: number | null; city: string | null;
  paymentMethod: PayMethod; paymentMethodSource: "manual" | "auto" | null;
  cashReport: boolean; cleaning: boolean; cleaningProjectId: number | null; overdue: boolean;
  driveFileId: string | null; drivePdfId: string | null; driveError: string | null;
  addedBy: string | null; addedAt: string | null;
  category: string; categorySource: "manual" | "auto";
}
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
const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  ksef: { label: "KSeF", cls: "bg-violet-100 text-violet-700" },
  manual: { label: "вручну", cls: "bg-sky-100 text-sky-700" },
  scan: { label: "скан", cls: "bg-emerald-100 text-emerald-700" },
  sheet: { label: "таблиця", cls: "bg-slate-100 text-slate-500" },
};

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
  const [source, setSource] = useState("");   // "" | ksef | manual | scan | sheet
  const [catFilter, setCatFilter] = useState(""); // ключ категорії з розбивки-чіпсів
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [prefill, setPrefill] = useState<Partial<Row> | null>(null);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [auditFor, setAuditFor] = useState<Row | null>(null); // модалка «Історія фактури»
  const fileInput = useRef<HTMLInputElement>(null);

  // «Скан»: файл → /cost-invoices/scan → модалка з розпізнаними полями і файлом
  const scanPick = async (file: File) => {
    setScanning(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
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
    if (source) r = r.filter(x => x.source === source);
    if (catFilter) r = r.filter(x => x.category === catFilter);
    if (q.trim().length >= 2) {
      const needle = q.trim().toLowerCase();
      r = r.filter(x => `${x.number} ${x.seller} ${x.sellerNip} ${x.note}`.toLowerCase().includes(needle));
    }
    return r;
  }, [d, status, source, catFilter, q]);

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
      await patch(r.origin === "ksef" ? `/cost-invoices/ksef/${r.id}` : `/cost-invoices/${r.id}`, body);
      invalidate();
    } catch (e: any) { toast.error(e?.message || "error"); }
  };
  const togglePaid = (r: Row) => patchRow(r, { paid: !r.paid });
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
          <div className="mb-1 text-xs text-slate-500">{t("Джерело")}</div>
          <Select value={source} onChange={e => setSource(e.target.value)} className="w-36">
            <option value="">{t("Всі")}</option>
            <option value="ksef">KSeF</option>
            <option value="manual">{t("вручну")}</option>
            <option value="scan">{t("скан")}</option>
          </Select>
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
                  {rows.map(r => (
                    <tr key={r.key} className={`border-b border-slate-100 hover:bg-slate-50/60 ${r.dupOfKsefId ? "opacity-50" : ""} ${!r.driveFileId ? "bg-rose-50/60" : r.overdue ? "bg-orange-50/60" : ""}`}>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-slate-500">
                        {r.issueDate ?? "—"}
                        {!companyId && <div className="text-[10px] text-slate-400">{r.firm ?? ""}</div>}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.driveFileId ? (
                          <a href={`https://drive.google.com/file/d/${r.drivePdfId ?? r.driveFileId}/view`} target="_blank" rel="noreferrer"
                            className="block max-w-[150px] truncate text-xs font-medium text-sky-700 hover:underline" title={t("відкрити фактуру на Google Drive")}>
                            {r.number ?? "—"}
                          </a>
                        ) : (
                          <div className="max-w-[150px] truncate text-xs font-medium text-slate-700" title={r.number ?? ""}>{r.number ?? "—"}</div>
                        )}
                        <div className="mt-0.5 flex items-center gap-1">
                          <span className={`rounded px-1 py-0.5 text-[10px] font-semibold ${SOURCE_BADGE[r.source]!.cls}`}>{t(SOURCE_BADGE[r.source]!.label)}</span>
                          {!r.driveFileId && (
                            <span className="max-w-[110px] truncate rounded bg-rose-100 px-1 py-0.5 text-[10px] font-semibold text-rose-700"
                              title={r.driveError ? r.driveError : t("ще не синковано з Drive (крон 06:00 або кнопка «Синк KSeF»)")}>
                              {t("нема на Drive")}{r.driveError ? `: ${r.driveError}` : ""}
                            </span>
                          )}
                          {r.dupOfKsefId && <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-700" title={t("та сама фактура вже є з KSeF — цей рядок не рахується в підсумках")}>{t("дубль KSeF")}</span>}
                          <button onClick={() => void patchRow(r, { cleaning: !r.cleaning })}
                            className={`rounded px-1 py-0.5 text-[10px] font-semibold ${r.cleaning ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-400 hover:bg-slate-200"}`}
                            title={t("видаток бізнесу прибирання — потрапляє у розділ «Прибирання» → Видатки (вспульнота привʼязується там)")}>
                            🧹{r.cleaning ? ` ${t("прибирання")}` : ""}
                          </button>
                          {r.hasFile && (
                            <a href={`/api/cost-invoices/${r.id}/file`} target="_blank" rel="noreferrer" className="inline-flex items-center text-[10px] text-red-600 hover:underline">
                              {t("файл")} <ExternalLink className="ml-0.5 h-3 w-3" />
                            </a>
                          )}
                        </div>
                        {r.addedBy && (
                          <button className="mt-0.5 block text-[10px] text-slate-400 hover:text-slate-600 hover:underline"
                            title={t("клік — історія змін фактури")} onClick={() => setAuditFor(r)}>
                            {t("додав(-ла)")} {r.addedBy}{r.addedAt ? ` · ${new Date(r.addedAt).toLocaleDateString("uk-UA")}` : ""}
                          </button>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="max-w-[200px] truncate text-xs text-slate-700" title={`${r.seller ?? ""}${r.sellerNip ? ` · NIP ${r.sellerNip}` : ""}`}>{r.seller ?? "—"}</div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right text-xs font-medium tabular-nums">{zl(r.gross)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <select
                          value={r.categorySource === "manual" ? r.category : ""}
                          onChange={e => void patchRow(r, { expenseCategory: e.target.value || null })}
                          className={`max-w-[150px] cursor-pointer truncate rounded border-0 bg-transparent p-0 text-xs focus:ring-0 ${r.categorySource === "manual" ? "font-medium text-sky-700" : "text-slate-500"}`}
                          title={r.categorySource === "manual" ? t("категорію вибрано вручну") : t("категорія авто (правила/патерни) — можна змінити")}>
                          <option value="">{catIcon(r.category) ? `${catIcon(r.category)} ` : ""}{t(catLabel(r.category))}{r.categorySource === "auto" ? ` (${t("авто")})` : ""}</option>
                          {(d.categories ?? []).map(c => <option key={c.key} value={c.key}>{c.icon ? `${c.icon} ` : ""}{t(c.label)}</option>)}
                          <option value="other">🗂️ {t("Інше")}</option>
                        </select>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <button onClick={() => cycleMethod(r)}
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${r.paymentMethod === "gotowka" ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : r.paymentMethod === "przelew" ? "bg-sky-50 text-sky-700 hover:bg-sky-100" : "bg-slate-100 text-slate-400 hover:bg-slate-200"}`}
                          title={t("клік — змінити: переказ → готівка → авто")}>
                          {r.paymentMethod === "gotowka" ? `💵 ${t("готівка")}` : r.paymentMethod === "przelew" ? `🏦 ${t("переказ")}` : "—"}
                        </button>
                        {r.paymentMethod && r.paymentMethodSource === "auto" && <span className="ml-1 text-[10px] text-slate-400">{t("авто")}</span>}
                        {r.paymentMethod === "gotowka" && (
                          <label className="mt-0.5 flex cursor-pointer items-center gap-1 text-[11px] text-slate-500" title={t("відмітка кшєнгової: фактура внесена в готівковий рапорт")}>
                            <input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-300" checked={r.cashReport}
                              onChange={() => void patchRow(r, { cashReport: !r.cashReport })} />
                            {t("рапорт готівковий")}
                          </label>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <button onClick={() => togglePaid(r)}
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${r.paid ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-amber-50 text-amber-700 hover:bg-amber-100"}`}
                          title={t("клік — змінити статус оплати")}>
                          {r.paid ? `✓ ${r.paidDate ?? t("оплачена")}` : t("не оплачена")}
                        </button>
                        {r.paid && r.paidSource === "bank" && <span className="ml-1 text-[10px] text-slate-400">{t("витяг")}</span>}
                        {r.paid && r.paidSource === "register" && <span className="ml-1 text-[10px] text-sky-500">{t("реєстр")}</span>}
                        {r.paid && r.paidSource === "manual" && <span className="ml-1 text-[10px] text-violet-500">{t("вручну")}</span>}
                        {/* термін оплати — рядком під статусом, редагований для KSeF */}
                        <div className="mt-0.5 flex items-center gap-1 text-[11px]">
                          {r.origin === "ksef" ? (
                            <input type="date" value={r.dueDate ?? ""} onChange={e => void patchRow(r, { dueDate: e.target.value || null })}
                              title={t("термін оплати (з XML фактури; можна виправити)")}
                              className={`w-28 rounded border border-transparent bg-transparent p-0 text-[11px] hover:border-slate-300 ${r.overdue ? "font-semibold text-orange-600" : "text-slate-400"}`} />
                          ) : (
                            r.dueDate && <span className={r.overdue ? "font-semibold text-orange-600" : "text-slate-400"}>{t("до")} {r.dueDate}</span>
                          )}
                          {r.overdue && <span className="font-semibold text-orange-600">{t("прострочено")}</span>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">
                        <button className="p-1 text-slate-300 hover:text-slate-600" title={t("Історія змін (хто додав / змінив / затвердив)")}
                          onClick={() => setAuditFor(r)}>
                          <History className="h-4 w-4" />
                        </button>
                        {!r.driveFileId && (
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
                      </td>
                    </tr>
                  ))}
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
    cleaning: row?.cleaning ?? false,
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
        cleaning: f.cleaning,
        expenseCategory: f.expenseCategory || null,
      };
      const saved = row ? await patch(`/cost-invoices/${row.id}`, body) : await post("/cost-invoices", body);
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        await fetch(`/api/cost-invoices/${saved.id ?? row?.id}/file`, { method: "POST", body: fd, credentials: "include", headers: { "X-Requested-With": "grafik" } })
          .then(r => { if (!r.ok) throw new Error("upload failed"); });
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
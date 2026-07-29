// «Фактури» (/cost-invoices) — робочий модуль фактур коштових: KSeF-закупівлі +
// внесені вручну/скановані ботом в одному списку зі статусами оплат. Доступ:
// viewFinance або costInvoices (роль «бухгалтерія»).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, FileText, CheckCircle2, AlertCircle, Receipt, ExternalLink, Pencil, Trash2, ScanLine } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

interface Row {
  key: string; origin: "ksef" | "local"; id: number;
  source: "ksef" | "manual" | "scan" | "sheet";
  companyId: number | null; firm: string | null;
  issueDate: string | null; number: string | null;
  seller: string | null; sellerNip: string | null;
  gross: number; dueDate: string | null;
  paid: boolean; paidDate: string | null; paidSource: string | null;
  note: string | null; hasFile: boolean; dupOfKsefId: number | null;
}
interface Resp {
  month: string; rows: Row[];
  totals: { count: number; gross: number; paidGross: number; unpaidGross: number; unpaidCount: number };
  companies: { id: number; name: string }[];
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
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [companyId, setCompanyId] = useState("");
  const [status, setStatus] = useState("");   // "" | paid | unpaid
  const [source, setSource] = useState("");   // "" | ksef | manual | scan | sheet
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [prefill, setPrefill] = useState<Partial<Row> | null>(null);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
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

  const months = useQuery<{ months: string[] }>({ queryKey: ["ci-months"], queryFn: () => get("/cost-invoices/months") });
  const data = useQuery<Resp>({
    queryKey: ["cost-invoices", month, companyId],
    queryFn: () => get(`/cost-invoices?month=${month}${companyId ? `&companyId=${companyId}` : ""}`),
  });
  const d = data.data;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["cost-invoices"] });

  const rows = useMemo(() => {
    let r = d?.rows ?? [];
    if (status) r = r.filter(x => (status === "paid") === x.paid);
    if (source) r = r.filter(x => x.source === source);
    if (q.trim().length >= 2) {
      const needle = q.trim().toLowerCase();
      r = r.filter(x => `${x.number} ${x.seller} ${x.sellerNip} ${x.note}`.toLowerCase().includes(needle));
    }
    return r;
  }, [d, status, source, q]);

  const togglePaid = async (r: Row) => {
    try {
      if (r.origin === "ksef") await patch(`/cost-invoices/ksef/${r.id}`, { paid: !r.paid });
      else await patch(`/cost-invoices/${r.id}`, { paid: !r.paid });
      invalidate();
    } catch (e: any) { toast.error(e?.message || "error"); }
  };

  return (
    <>
      <PageHeader title={t("Фактури коштові")} subtitle={t("KSeF-закупівлі + внесені вручну і скани з бота — оплати в одному місці")} />

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
            <Tile icon={<FileText className="h-5 w-5 text-slate-400" />} label={t("Показано")} value={String(rows.length)} sub={t("з {n}", { n: d.rows.length })} />
          </div>

          <Card className="overflow-x-auto p-0">
            {!rows.length ? <Empty>{t("Нічого не знайдено")}</Empty> : (
              <table className="w-full min-w-[880px] text-sm">
                <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                  <th className="px-4 py-2.5">{t("Дата")}</th>
                  <th className="px-3 py-2.5">{t("Номер")}</th>
                  <th className="px-3 py-2.5">{t("Постачальник")}</th>
                  {!companyId && <th className="px-3 py-2.5">{t("Фірма")}</th>}
                  <th className="px-3 py-2.5 text-right">{t("Брутто")}</th>
                  <th className="px-3 py-2.5">{t("Термін")}</th>
                  <th className="px-3 py-2.5">{t("Оплата")}</th>
                  <th className="px-3 py-2.5" />
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.key} className={`border-b border-slate-100 hover:bg-slate-50/60 ${r.dupOfKsefId ? "opacity-50" : ""}`}>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-500">{r.issueDate ?? "—"}</td>
                      <td className="px-3 py-2">
                        <div className="max-w-[190px] truncate font-medium text-slate-700" title={r.number ?? ""}>{r.number ?? "—"}</div>
                        <div className="mt-0.5 flex items-center gap-1">
                          <span className={`rounded px-1 py-0.5 text-[10px] font-semibold ${SOURCE_BADGE[r.source]!.cls}`}>{t(SOURCE_BADGE[r.source]!.label)}</span>
                          {r.dupOfKsefId && <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-700" title={t("та сама фактура вже є з KSeF — цей рядок не рахується в підсумках")}>{t("дубль KSeF")}</span>}
                          {r.hasFile && (
                            <a href={`/api/cost-invoices/${r.id}/file`} target="_blank" rel="noreferrer" className="inline-flex items-center text-[10px] text-red-600 hover:underline">
                              {t("файл")} <ExternalLink className="ml-0.5 h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="max-w-[260px] truncate text-slate-700" title={r.seller ?? ""}>{r.seller ?? "—"}</div>
                        {r.sellerNip && <div className="text-xs tabular-nums text-slate-400">NIP {r.sellerNip}</div>}
                      </td>
                      {!companyId && <td className="px-3 py-2 text-slate-500">{r.firm ?? "—"}</td>}
                      <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{zl(r.gross)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                        {r.dueDate ?? "—"}
                        {!r.paid && r.dueDate && r.dueDate < new Date().toISOString().slice(0, 10) && <span className="ml-1 font-semibold text-rose-600">{t("прострочено")}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <button onClick={() => togglePaid(r)}
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${r.paid ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-amber-50 text-amber-700 hover:bg-amber-100"}`}
                          title={t("клік — змінити статус оплати")}>
                          {r.paid ? `✓ ${r.paidDate ?? t("оплачена")}` : t("не оплачена")}
                        </button>
                        {r.paid && r.paidSource === "bank" && <span className="ml-1 text-[10px] text-slate-400">{t("витяг")}</span>}
                        {r.paid && r.paidSource === "register" && <span className="ml-1 text-[10px] text-sky-500">{t("реєстр")}</span>}
                        {r.paid && r.paidSource === "manual" && <span className="ml-1 text-[10px] text-violet-500">{t("вручну")}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
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
          </p>
        </>
      )}

      {(adding || editing) && (
        <InvoiceModal
          row={editing}
          prefill={editing ? null : prefill}
          initialFile={editing ? null : scanFile}
          companies={d?.companies ?? []}
          onClose={() => { setAdding(false); setEditing(null); setPrefill(null); setScanFile(null); }}
          onSaved={() => { setAdding(false); setEditing(null); setPrefill(null); setScanFile(null); invalidate(); }}
        />
      )}
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

function InvoiceModal({ row, prefill, initialFile, companies, onClose, onSaved }: {
  row: Row | null; prefill?: Partial<Row> | null; initialFile?: File | null;
  companies: { id: number; name: string }[]; onClose: () => void; onSaved: () => void;
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
  });
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setF(p => ({ ...p, [k]: v }));

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
    setSaving(true);
    try {
      const body = {
        companyId: Number(f.companyId), issueDate: f.issueDate, number: f.number.trim(),
        seller: f.seller.trim() || null, sellerNip: f.sellerNip.trim() || null,
        amount: f.amount, dueDate: f.dueDate || null, note: f.note.trim() || null,
        paid: f.paid, paidDate: f.paid ? (f.paidDate || undefined) : undefined,
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
        <label className="col-span-2 flex items-center gap-2 pt-1 text-sm text-slate-600">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={f.paid} onChange={e => set("paid", e.target.checked)} />
          {t("Оплачена")}
          {f.paid && <Input type="date" value={f.paidDate} onChange={e => set("paidDate", e.target.value)} className="w-40" />}
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
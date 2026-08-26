// «KSeF» (/ksef) — sales invoices per revenue month: totals per client,
// payment status (bank-matched by invoice number in the transfer title, with a
// manual override). Feeds P&L revenue (netto per client).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw, TrendingUp, FileText, CheckCircle2, AlertCircle, UploadCloud, History } from "lucide-react";
import { get, post, patch } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { InvoiceAuditModal, type AuditTarget } from "../components/InvoiceAuditModal";
import { useT } from "../lib/i18n";

interface Inv {
  id: number; firm: string; invoiceNumber: string; issueDate: string; buyerName: string | null; clientLabel: string | null;
  sellerName: string | null;
  net: number; vat: number; gross: number; currency: string; revenueMonth: string;
  paid: boolean; effPaidDate: string | null; paidSource: "bank" | "manual" | "register" | "korekta" | null;
  driveFileId: string | null; drivePdfId: string | null; driveError: string | null;
}

// номер → файл в архіві на Google Drive (стандартний XML з KSeF)
function InvNumber({ inv }: { inv: Inv }) {
  const t = useT();
  if (!inv.driveFileId) return <span title={inv.driveError ?? undefined}>{inv.invoiceNumber}</span>;
  return (
    <a href={`https://drive.google.com/file/d/${inv.drivePdfId ?? inv.driveFileId}/view`} target="_blank" rel="noreferrer"
      className="text-sky-700 hover:underline" title={t("відкрити фактуру на Google Drive")}>
      {inv.invoiceNumber}
    </a>
  );
}

// маркер «перенесена на Drive / ні»; без onPush — лише індикатор (модалка)
function DriveCell({ inv, pushing, onPush }: { inv: Inv; pushing?: boolean; onPush?: () => void }) {
  const t = useT();
  if (inv.driveFileId) return (
    <a href={`https://drive.google.com/file/d/${inv.drivePdfId ?? inv.driveFileId}/view`} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:underline" title={t("на Drive — відкрити")}>
      <CheckCircle2 className="h-3.5 w-3.5" />Drive
    </a>
  );
  if (!onPush) return <span className="text-xs font-medium text-rose-600" title={inv.driveError ?? undefined}>{t("нема на Drive")}</span>;
  return (
    <button onClick={onPush} disabled={pushing}
      className="inline-flex items-center gap-1 rounded bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-600 hover:bg-rose-100 disabled:animate-pulse"
      title={inv.driveError ? `${t("нема на Drive")}: ${inv.driveError}` : t("ще не на Drive — клік, щоб залити зараз")}>
      <UploadCloud className="h-3.5 w-3.5" />{t("залити")}
    </button>
  );
}
interface Data {
  month: string;
  invoices: Inv[];
  byClient: { client: string; count: number; net: number; gross: number; unpaidGross: number }[];
  totals: { count: number; net: number; vat: number; gross: number; paidGross: number; unpaidGross: number };
  firms: string[];
}

const zl = (n: number | null | undefined) => n == null ? "—" : `${n.toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const MONTHS_UK = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthLabel = (m: string) => { const [y, mm] = m.split("-"); return `${MONTHS_UK[Number(mm) - 1]} ${y}`; };

// Вбудовується розділом «Фактури спшедажові» на /cost-invoices (26.08.2026;
// окрема сторінка /ksef видалена, закупівлі-«сирі» покриває розділ закупових).
export function KsefSales() {
  const t = useT();
  const qc = useQueryClient();
  const kind = "sale" as const;
  const isPurchase = false;
  const months = useQuery<{ months: string[] }>({ queryKey: ["ksef-months", kind], queryFn: () => get(`/ksef/months?kind=${kind}`) });
  const [month, setMonth] = useState("");
  const [firm, setFirm] = useState("");
  const [search, setSearch] = useState("");
  const [party, setParty] = useState(""); // counterparty picked in the by-client/by-supplier table
  const [busy, setBusy] = useState(false);
  const [monthPushing, setMonthPushing] = useState(false);
  const [pushingId, setPushingId] = useState<number | null>(null);
  const [auditFor, setAuditFor] = useState<AuditTarget | null>(null); // модалка «Історія фактури»
  const active = month || months.data?.months[0] || "";
  const q = useQuery<Data>({
    queryKey: ["ksef", kind, active], queryFn: () => get(`/ksef?month=${active}&kind=${kind}`), enabled: !!active,
    // поки місяць заливається на Drive — рядки зеленіють поступово
    refetchInterval: monthPushing ? 4000 : false,
  });
  const d = q.data;
  const invalidate = () => ["ksef", "ksef-months", "pnl", "pnl-months"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  const partyOf = (i: Inv) => (isPurchase ? i.sellerName ?? "—" : i.clientLabel ?? i.buyerName ?? "—");

  const syncNow = async () => { setBusy(true); try { await post("/ksef/sync", {}); invalidate(); } finally { setBusy(false); } };
  const togglePaid = async (inv: Inv) => { await patch(`/ksef/invoices/${inv.id}`, { paid: !inv.paid }); invalidate(); };

  // архів на Drive: одна фактура (кнопка в рядку) або весь місяць вкладки
  const missingOnDrive = (d?.invoices ?? []).filter(i => !i.driveFileId).length;
  const pushOne = async (inv: Inv) => {
    setPushingId(inv.id);
    try {
      const r = await post(`/ksef/invoices/${inv.id}/drive`, {});
      if (r?.driveFileId) toast.success(t("Фактура на Drive"));
      else toast.error(r?.driveError || t("Не вдалося залити на Drive"));
      invalidate();
    } catch (e: any) { toast.error(e?.message || "error"); }
    finally { setPushingId(null); }
  };
  const pushMonth = async () => {
    setMonthPushing(true);
    try {
      const r = await post("/ksef/drive-month", { month: active, kind });
      if (r?.failed || r?.errors?.length) {
        toast.warning(t("Drive: залито {u}, помилок {f}", { u: r?.uploaded ?? 0, f: (r?.failed ?? 0) + (r?.errors?.length ?? 0) }) + (r?.errors?.[0] ? ` — ${r.errors[0]}` : ""));
      } else toast.success(t("Drive: залито {u}, помилок {f}", { u: r?.uploaded ?? 0, f: 0 }));
      invalidate();
    } catch (e: any) { toast.error(e?.message || "error"); }
    finally { setMonthPushing(false); }
  };

  const s = search.trim().toUpperCase();
  const shown = (d?.invoices ?? []).filter(i =>
    (!firm || i.firm === firm) &&
    (!s || i.invoiceNumber.toUpperCase().includes(s) || (i.buyerName ?? "").toUpperCase().includes(s) || (i.clientLabel ?? "").toUpperCase().includes(s) || (i.sellerName ?? "").toUpperCase().includes(s)));
  const partyInvoices = party ? shown.filter(i => partyOf(i) === party) : [];
  const sum = (f: (i: Inv) => number) => Math.round(shown.reduce((a, i) => a + f(i), 0) * 100) / 100;
  // metrics and the by-client table follow the firm/search filter, so they are
  // recomputed here from the filtered rows instead of the server-wide d.totals
  const totals: Data["totals"] = {
    count: shown.length, net: sum(i => i.net), vat: sum(i => i.vat), gross: sum(i => i.gross),
    paidGross: sum(i => (i.paid ? i.gross : 0)), unpaidGross: sum(i => (i.paid ? 0 : i.gross)),
  };
  const byClient: Data["byClient"] = [...shown.reduce((m, i) => {
    const g = m.get(partyOf(i)) ?? { client: partyOf(i), count: 0, net: 0, gross: 0, unpaidGross: 0 };
    g.count++; g.net += i.net; g.gross += i.gross; if (!i.paid) g.unpaidGross += i.gross;
    return m.set(g.client, g);
  }, new Map<string, Data["byClient"][number]>()).values()].sort((a, b) => b.net - a.net);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{isPurchase ? t("Місяць (за датою виставлення)") : t("Місяць P&L (робота за)")}</div>
          <Select value={active} onChange={e => { setMonth(e.target.value); setParty(""); }} className="w-44">
            {(months.data?.months ?? []).map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </Select>
        </div>
        {(d?.firms.length ?? 0) > 1 && (
          <div>
            <div className="mb-1 text-xs text-slate-500">{t("Фірма")}</div>
            <Select value={firm} onChange={e => setFirm(e.target.value)} className="w-32">
              <option value="">{t("Всі")}</option>
              {d!.firms.map(f => <option key={f} value={f}>{f}</option>)}
            </Select>
          </div>
        )}
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={isPurchase ? t("Пошук: номер, постачальник…") : t("Пошук: номер, покупець…")} className="h-9 w-56" />
        <div className="ml-auto flex items-end gap-2">
          {(d?.invoices.length ?? 0) > 0 && missingOnDrive === 0 && (
            <span className="pb-2 text-xs font-medium text-emerald-600">☁️ {t("Всі фактури збережено на Google Диск")} ({d!.invoices.length})</span>
          )}
          {missingOnDrive > 0 && (
            <Button variant="secondary" onClick={pushMonth} disabled={monthPushing}
              title={t("Залити на Drive всі фактури цього місяця, крім уже залитих")}>
              <UploadCloud className={`mr-1 h-4 w-4 ${monthPushing ? "animate-pulse" : ""}`} />
              {monthPushing ? t("Заливаю…") : t("Місяць на Drive ({n})", { n: missingOnDrive })}
            </Button>
          )}
          <Button variant="ghost" onClick={syncNow} disabled={busy}>
            <RefreshCw className={`mr-1 h-4 w-4 ${busy ? "animate-spin" : ""}`} />{t("Синк з KSeF")}
          </Button>
        </div>
      </div>

      {q.isFetching && !d ? <Spinner /> : !d || !d.invoices.length ? (
        <Empty>{t("Немає фактур — натисни «Синк з KSeF» (потрібні KSEF_TOKEN_* у середовищі)")}</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Metric label={t("Фактур")} value={String(totals.count)} icon={<FileText className="h-5 w-5 text-slate-400" />} />
            <Metric label={isPurchase ? t("Витрати netto") : t("Дохід netto")} value={zl(totals.net)} icon={<TrendingUp className={`h-5 w-5 ${isPurchase ? "text-rose-500" : "text-emerald-500"}`} />} />
            <Metric label="VAT" value={zl(totals.vat)} icon={<FileText className="h-5 w-5 text-slate-400" />} />
            <Metric label={t("Оплачено (brutto)")} value={zl(totals.paidGross)} icon={<CheckCircle2 className="h-5 w-5 text-emerald-500" />} />
            <Metric label={t("Не оплачено (brutto)")} value={zl(totals.unpaidGross)} icon={<AlertCircle className="h-5 w-5 text-amber-500" />} />
          </div>

          {/* per-counterparty totals */}
          <Card className="mt-4 p-0">
            <div className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-700">
              {isPurchase ? t("По постачальниках") : t("По клієнтах")}
              <span className="ml-2 text-xs font-normal text-slate-400">{t("клік — вікно з фактурами контрагента")}</span>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <th className="px-4 py-2 text-left">{isPurchase ? t("Постачальник") : t("Клієнт")}</th>
                <th className="px-3 py-2 text-right">{t("Фактур")}</th>
                <th className="px-3 py-2 text-right">Netto</th>
                <th className="px-3 py-2 text-right">Brutto</th>
                <th className="px-4 py-2 text-right">{t("З них не оплачено")}</th>
              </tr></thead>
              <tbody>
                {byClient.map(c => (
                  <tr key={c.client} onClick={() => setParty(c.client)}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-1.5 font-medium text-slate-700">{c.client}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{c.count}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(c.net)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{zl(c.gross)}</td>
                    <td className={`whitespace-nowrap px-4 py-1.5 text-right tabular-nums ${c.unpaidGross ? "text-amber-600" : "text-slate-400"}`}>{c.unpaidGross ? zl(c.unpaidGross) : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
                <td className="px-4 py-2">{t("Разом")}</td>
                <td className="px-3 py-2 text-right tabular-nums">{totals.count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{zl(totals.net)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{zl(totals.gross)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{zl(totals.unpaidGross)}</td>
              </tr></tfoot>
            </table>
            <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              {isPurchase
                ? t("Закупівлі — довідково, у P&L не йдуть (собівартість рахується зі сводних і фактур витрат).")
                : t("Netto по клієнтах автоматично йде в P&L цього місяця (фактура, виставлена в червні за травень, — у травень).")}
            </div>
          </Card>

          {party && (
            <PartyModal party={party} invoices={partyInvoices} onToggle={togglePaid} onClose={() => setParty("")} />
          )}
          {auditFor && <InvoiceAuditModal target={auditFor} onClose={() => setAuditFor(null)} />}

          {/* invoices */}
          <Card className="mt-4 p-0">
            <div className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-700">{t("Фактури")} ({shown.length})</div>
            <div className="max-h-[560px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white"><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                  <th className="px-4 py-2 text-left">№</th>
                  <th className="px-3 py-2 text-left">{t("Дата")}</th>
                  <th className="px-3 py-2 text-left">{t("Фірма")}</th>
                  <th className="px-3 py-2 text-left">{isPurchase ? t("Постачальник") : t("Покупець")}</th>
                  <th className="px-3 py-2 text-right">Netto</th>
                  <th className="px-3 py-2 text-right">VAT</th>
                  <th className="px-3 py-2 text-right">Brutto</th>
                  <th className="px-3 py-2 text-left">Drive</th>
                  <th className="px-4 py-2 text-left">{t("Оплата")}</th>
                </tr></thead>
                <tbody>
                  {shown.map(inv => (
                    <tr key={inv.id} className="border-b border-slate-100 last:border-0">
                      <td className="whitespace-nowrap px-4 py-1.5 font-medium text-slate-700"><InvNumber inv={inv} /></td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{inv.issueDate}</td>
                      <td className="px-3 py-1.5 text-slate-600">{inv.firm}</td>
                      <td className="px-3 py-1.5 text-slate-600" title={(isPurchase ? inv.sellerName : inv.buyerName) ?? undefined}>
                        {isPurchase ? inv.sellerName : inv.clientLabel ?? inv.buyerName}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(inv.net)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{zl(inv.vat)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(inv.gross)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        <DriveCell inv={inv} pushing={pushingId === inv.id} onPush={() => void pushOne(inv)} />
                        <button className="ml-1 p-0.5 align-middle text-slate-300 hover:text-slate-600"
                          title={t("Історія змін (хто додав / змінив / затвердив)")}
                          onClick={() => setAuditFor({ origin: "ksef", id: inv.id, number: inv.invoiceNumber })}>
                          <History className="h-3.5 w-3.5" />
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-4 py-1.5">
                        <button onClick={() => togglePaid(inv)} title={inv.paidSource === "bank" ? t("знайдено у витягу — клік, щоб перекрити вручну") : t("клік — змінити вручну")}
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${inv.paid ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-amber-50 text-amber-700 hover:bg-amber-100"}`}>
                          {inv.paid ? `✓ ${inv.effPaidDate ?? t("оплачена")}` : t("не оплачена")}
                        </button>
                        {inv.paidSource === "bank" && <span className="ml-1 text-[10px] text-slate-400">{t("витяг")}</span>}
                        {inv.paidSource === "register" && <span className="ml-1 text-[10px] text-sky-500" title={t("оплату підтверджує реєстр Faktury Kosztowe (готівка або переказ без номера)")}>{t("реєстр")}</span>}
                        {inv.paidSource === "korekta" && <span className="ml-1 text-[10px] text-slate-500" title={t("занулена коректою (звʼязок через KSeF)")}>{t("коректа")}</span>}
                        {inv.paidSource === "manual" && <span className="ml-1 text-[10px] text-violet-500">{t("вручну")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
                  <td className="px-4 py-2">{t("Разом")} ({shown.length})</td>
                  <td className="px-3 py-2" /><td className="px-3 py-2" /><td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right tabular-nums">{zl(sum(i => i.net))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{zl(sum(i => i.vat))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{zl(sum(i => i.gross))}</td>
                  <td className="px-3 py-2" /><td className="px-4 py-2" />
                </tr></tfoot>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              {isPurchase
                ? t("Оплата: «витяг» — номер фактури знайдено в назві нашого вихідного переказу з точною сумою; «реєстр» — оплачено за реєстром Faktury Kosztowe (готівка / переказ без номера); решта позначається вручну кнопкою.")
                : t("Оплата: «витяг» — номер фактури знайдено в назві вхідного переказу цієї фірми; вручну — позначено кнопкою. Клік по статусу перемикає вручну, повторний клік повертає авто-стан.")}
            </div>
          </Card>
        </>
      )}
    </>
  );
}

// Pop-up with one counterparty's invoices of the month — mark paid right here.
function PartyModal({ party, invoices, onToggle, onClose }: { party: string; invoices: Inv[]; onToggle: (inv: Inv) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const sum = (f: (i: Inv) => number) => Math.round(invoices.reduce((a, i) => a + f(i), 0) * 100) / 100;
  const unpaid = invoices.filter(i => !i.paid);
  return (
    <Modal open title={party} onClose={onClose} size="xl">
      <div className="mb-3 text-sm text-slate-500">
        {t("{n} фактур", { n: invoices.length })} · {zl(sum(i => i.gross))} brutto
        {unpaid.length > 0 && <span className="text-amber-600"> · {t("не оплачено {n} на {v}", { n: unpaid.length, v: zl(sum(i => (i.paid ? 0 : i.gross))) })}</span>}
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white"><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
            <th className="px-3 py-2 text-left">№</th>
            <th className="px-3 py-2 text-left">{t("Дата")}</th>
            <th className="px-3 py-2 text-left">{t("Фірма")}</th>
            <th className="px-3 py-2 text-right">Netto</th>
            <th className="px-3 py-2 text-right">Brutto</th>
            <th className="px-3 py-2 text-left">Drive</th>
            <th className="px-3 py-2 text-left">{t("Оплата")}</th>
          </tr></thead>
          <tbody>
            {invoices.map(inv => (
              <tr key={inv.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-3 py-1.5 font-medium text-slate-700"><InvNumber inv={inv} /></td>
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{inv.issueDate}</td>
                <td className="px-3 py-1.5 text-slate-600">{inv.firm}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(inv.net)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(inv.gross)}</td>
                <td className="whitespace-nowrap px-3 py-1.5"><DriveCell inv={inv} /></td>
                <td className="whitespace-nowrap px-3 py-1.5">
                  <button onClick={() => onToggle(inv)} title={inv.paidSource === "bank" ? t("знайдено у витягу — клік, щоб перекрити вручну") : t("клік — змінити вручну")}
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${inv.paid ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-amber-50 text-amber-700 hover:bg-amber-100"}`}>
                    {inv.paid ? `✓ ${inv.effPaidDate ?? t("оплачена")}` : t("не оплачена")}
                  </button>
                  {inv.paidSource === "bank" && <span className="ml-1 text-[10px] text-slate-400">{t("витяг")}</span>}
                  {inv.paidSource === "register" && <span className="ml-1 text-[10px] text-sky-500">{t("реєстр")}</span>}
                  {inv.paidSource === "korekta" && <span className="ml-1 text-[10px] text-slate-500">{t("коректа")}</span>}
                  {inv.paidSource === "manual" && <span className="ml-1 text-[10px] text-violet-500">{t("вручну")}</span>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50"><tr className="border-t border-slate-300 font-semibold text-slate-800">
            <td colSpan={3} className="px-3 py-2">{t("Разом")} ({invoices.length})</td>
            <td className="px-3 py-2 text-right tabular-nums">{zl(sum(i => i.net))}</td>
            <td className="px-3 py-2 text-right tabular-nums">{zl(sum(i => i.gross))}</td>
            <td className="px-3 py-2" /><td className="px-3 py-2" />
          </tr></tfoot>
        </table>
      </div>
    </Modal>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">{label}</div>
        {icon}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-slate-800">{value}</div>
    </Card>
  );
}

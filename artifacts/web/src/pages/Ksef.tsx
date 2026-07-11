// «KSeF» (/ksef) — sales invoices per revenue month: totals per client,
// payment status (bank-matched by invoice number in the transfer title, with a
// manual override). Feeds P&L revenue (netto per client).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, TrendingUp, FileText, CheckCircle2, AlertCircle } from "lucide-react";
import { get, post, patch } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

interface Inv {
  id: number; firm: string; invoiceNumber: string; issueDate: string; buyerName: string | null; clientLabel: string | null;
  net: number; vat: number; gross: number; currency: string; revenueMonth: string;
  paid: boolean; effPaidDate: string | null; paidSource: "bank" | "manual" | null;
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

export default function Ksef() {
  const t = useT();
  const qc = useQueryClient();
  const months = useQuery<{ months: string[] }>({ queryKey: ["ksef-months"], queryFn: () => get("/ksef/months") });
  const [month, setMonth] = useState("");
  const [firm, setFirm] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const active = month || months.data?.months[0] || "";
  const q = useQuery<Data>({ queryKey: ["ksef", active], queryFn: () => get(`/ksef?month=${active}`), enabled: !!active });
  const d = q.data;
  const invalidate = () => ["ksef", "ksef-months", "pnl", "pnl-months"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));

  const syncNow = async () => { setBusy(true); try { await post("/ksef/sync", {}); invalidate(); } finally { setBusy(false); } };
  const togglePaid = async (inv: Inv) => { await patch(`/ksef/invoices/${inv.id}`, { paid: !inv.paid }); invalidate(); };

  const s = search.trim().toUpperCase();
  const shown = (d?.invoices ?? []).filter(i =>
    (!firm || i.firm === firm) &&
    (!s || i.invoiceNumber.toUpperCase().includes(s) || (i.buyerName ?? "").toUpperCase().includes(s) || (i.clientLabel ?? "").toUpperCase().includes(s)));
  const sum = (f: (i: Inv) => number) => Math.round(shown.reduce((a, i) => a + f(i), 0) * 100) / 100;

  return (
    <>
      <PageHeader title="KSeF" subtitle={t("Продажні фактури з Krajowy System e-Faktur: доходи по клієнтах (netto → P&L) і статус оплат")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Місяць P&L (робота за)")}</div>
          <Select value={active} onChange={e => setMonth(e.target.value)} className="w-44">
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
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("Пошук: номер, покупець…")} className="h-9 w-56" />
        <div className="ml-auto">
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
            <Metric label={t("Фактур")} value={String(d.totals.count)} icon={<FileText className="h-5 w-5 text-slate-400" />} />
            <Metric label={t("Дохід netto")} value={zl(d.totals.net)} icon={<TrendingUp className="h-5 w-5 text-emerald-500" />} />
            <Metric label="VAT" value={zl(d.totals.vat)} icon={<FileText className="h-5 w-5 text-slate-400" />} />
            <Metric label={t("Оплачено (brutto)")} value={zl(d.totals.paidGross)} icon={<CheckCircle2 className="h-5 w-5 text-emerald-500" />} />
            <Metric label={t("Не оплачено (brutto)")} value={zl(d.totals.unpaidGross)} icon={<AlertCircle className="h-5 w-5 text-amber-500" />} />
          </div>

          {/* per-client totals */}
          <Card className="mt-4 p-0">
            <div className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-700">{t("По клієнтах")}</div>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <th className="px-4 py-2 text-left">{t("Клієнт")}</th>
                <th className="px-3 py-2 text-right">{t("Фактур")}</th>
                <th className="px-3 py-2 text-right">Netto</th>
                <th className="px-3 py-2 text-right">Brutto</th>
                <th className="px-4 py-2 text-right">{t("З них не оплачено")}</th>
              </tr></thead>
              <tbody>
                {d.byClient.map(c => (
                  <tr key={c.client} className="border-b border-slate-100 last:border-0">
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
                <td className="px-3 py-2 text-right tabular-nums">{d.totals.count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.net)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{zl(d.totals.gross)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{zl(d.totals.unpaidGross)}</td>
              </tr></tfoot>
            </table>
            <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              {t("Netto по клієнтах автоматично йде в P&L цього місяця (фактура, виставлена в червні за травень, — у травень).")}
            </div>
          </Card>

          {/* invoices */}
          <Card className="mt-4 p-0">
            <div className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-700">{t("Фактури")} ({shown.length})</div>
            <div className="max-h-[560px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white"><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                  <th className="px-4 py-2 text-left">№</th>
                  <th className="px-3 py-2 text-left">{t("Дата")}</th>
                  <th className="px-3 py-2 text-left">{t("Фірма")}</th>
                  <th className="px-3 py-2 text-left">{t("Покупець")}</th>
                  <th className="px-3 py-2 text-right">Netto</th>
                  <th className="px-3 py-2 text-right">VAT</th>
                  <th className="px-3 py-2 text-right">Brutto</th>
                  <th className="px-4 py-2 text-left">{t("Оплата")}</th>
                </tr></thead>
                <tbody>
                  {shown.map(inv => (
                    <tr key={inv.id} className="border-b border-slate-100 last:border-0">
                      <td className="whitespace-nowrap px-4 py-1.5 font-medium text-slate-700">{inv.invoiceNumber}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{inv.issueDate}</td>
                      <td className="px-3 py-1.5 text-slate-600">{inv.firm}</td>
                      <td className="px-3 py-1.5 text-slate-600" title={inv.buyerName ?? undefined}>
                        {inv.clientLabel ?? inv.buyerName}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(inv.net)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500">{zl(inv.vat)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{zl(inv.gross)}</td>
                      <td className="whitespace-nowrap px-4 py-1.5">
                        <button onClick={() => togglePaid(inv)} title={inv.paidSource === "bank" ? t("знайдено у витягу — клік, щоб перекрити вручну") : t("клік — змінити вручну")}
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${inv.paid ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-amber-50 text-amber-700 hover:bg-amber-100"}`}>
                          {inv.paid ? `✓ ${inv.effPaidDate ?? t("оплачена")}` : t("не оплачена")}
                        </button>
                        {inv.paidSource === "bank" && <span className="ml-1 text-[10px] text-slate-400">{t("витяг")}</span>}
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
                  <td className="px-4 py-2" />
                </tr></tfoot>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              {t("Оплата: «витяг» — номер фактури знайдено в назві вхідного переказу цієї фірми; вручну — позначено кнопкою. Клік по статусу перемикає вручну, повторний клік повертає авто-стан.")}
            </div>
          </Card>
        </>
      )}
    </>
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

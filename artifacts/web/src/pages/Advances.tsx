// «Аванси» (залічки) — ведення виплат авансів «як у таблиці»: групи виплат
// 15-го/30-го (ставляться автоматично датою затвердження, можна переносити),
// всередині групи — місто → фірма → фабрика. Подача: працівник у боті (pending →
// затвердження) або офіс з цієї сторінки (одразу «передано до виплати»).
// Виплата: авто по банківському переказу (services/advances.ts) або вручну
// з вибором переказ/готівка. IBAN працівника — з профілю, клік = копіювання.
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, Banknote, Landmark, Plus, Copy, ArrowLeftRight, Building2, CalendarClock, Stethoscope, Download, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, type AdvanceRequest } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Modal, Button, Input, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { monthOptions } from "../lib/dates";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { NatFlag } from "../lib/nationality";

const STATUS_COLOR: Record<string, "amber" | "blue" | "rose" | "green"> = {
  pending: "amber", approved: "blue", rejected: "rose", paid: "green",
};
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtIban = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y!, m! - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });

// Місяць, до якого рядок належить у розрізі сторінки: група виплати для
// затверджених/виплачених (легасі без групи — місяць подачі), для решти — подача.
const rowMonth = (r: AdvanceRequest) =>
  (r.status === "approved" || r.status === "paid") && r.payoutMonth ? r.payoutMonth : r.createdAt.slice(0, 7);

export default function Advances() {
  const t = useT();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "approved" | "paid" | "rejected">("all");
  const [rejecting, setRejecting] = useState<AdvanceRequest | null>(null);
  const [reason, setReason] = useState("");
  const [paying, setPaying] = useState<AdvanceRequest | null>(null);
  const [moving, setMoving] = useState<AdvanceRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { data = [], isFetching } = useQuery<AdvanceRequest[]>({ queryKey: ["advances"], queryFn: () => get("/advances") });

  // місяці — стандартні останні 6 + всі, що реально є в даних (вкл. майбутні групи виплат)
  const months = useMemo(() => {
    const base = monthOptions();
    const seen = new Set(base.map(m => m.value));
    for (const r of data) {
      const v = rowMonth(r);
      if (!seen.has(v)) { seen.add(v); base.push({ value: v, label: monthLabel(v) }); }
    }
    return base.sort((a, b) => b.value.localeCompare(a.value));
  }, [data]);
  const [month, setMonth] = useState(() => monthOptions()[0]!.value);

  const STATUS_LABEL: Record<string, string> = {
    pending: t("На розгляді"), approved: t("Передано до виплати"), rejected: t("Відхилено"), paid: t("Виплачено"),
  };
  const inv = () => qc.invalidateQueries({ queryKey: ["advances"] });
  const act = useMutation({
    mutationFn: (v: { id: number; action: "approve" | "reject" | "paid"; note?: string; method?: "transfer" | "cash" }) =>
      post(`/advances/${v.id}/${v.action}`, v.note != null ? { note: v.note } : v.method != null ? { method: v.method } : undefined),
    onSuccess: (_d, v) => { inv(); toast.success(v.action === "approve" ? t("Передано до виплати") : v.action === "reject" ? t("Відхилено") : t("Позначено виплаченим")); },
    onError: (e: any) => toast.error(e.message),
  });
  const confirmReject = () => {
    if (!rejecting) return;
    act.mutate({ id: rejecting.id, action: "reject", note: reason.trim() });
    setRejecting(null); setReason("");
  };
  const copyIban = (iban: string) => {
    navigator.clipboard.writeText(iban).then(
      () => toast.success(t("Номер рахунку скопійовано")),
      () => toast.error(t("Не вдалося скопіювати")),
    );
  };

  // запити на розгляді — завжди зверху, незалежно від вибраного місяця
  const pending = data.filter(r => r.status === "pending");
  const monthRows = useMemo(() => data.filter(r => r.status !== "pending" && rowMonth(r) === month), [data, month]);
  const rows = useMemo(() => filter === "all" ? monthRows : monthRows.filter(r => r.status === filter), [monthRows, filter]);
  const totals = useMemo(() => {
    const sum = (s: string) => r2(monthRows.filter(r => r.status === s).reduce((a, r) => a + r.amount, 0));
    return { requested: r2(pending.reduce((a, r) => a + r.amount, 0)), approved: sum("approved"), paid: sum("paid") };
  }, [monthRows, pending]);

  // група («15» | «30» | без) → місто → фірма → фабрика → рядки
  const sumOf = (list: AdvanceRequest[]) => r2(list.reduce((a, r) => a + r.amount, 0));
  type FirmMap = Map<string, Map<string, AdvanceRequest[]>>;
  const groups = useMemo(() => {
    const byGroup = new Map<string, Map<string, FirmMap>>();
    for (const r of rows) {
      if (r.status === "rejected") continue; // відхилені — окремою секцією внизу
      const g = r.payoutGroup ?? "—";
      const cities = byGroup.get(g) ?? byGroup.set(g, new Map()).get(g)!;
      const firms = cities.get(r.city || "—") ?? cities.set(r.city || "—", new Map()).get(r.city || "—")!;
      const facs = firms.get(r.company ?? "—") ?? firms.set(r.company ?? "—", new Map()).get(r.company ?? "—")!;
      const list = facs.get(r.factory ?? t("Без фабрики")) ?? facs.set(r.factory ?? t("Без фабрики"), []).get(r.factory ?? t("Без фабрики"))!;
      list.push(r);
    }
    for (const cities of byGroup.values()) for (const firms of cities.values()) for (const facs of firms.values())
      for (const list of facs.values())
        list.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "pl") || a.createdAt.localeCompare(b.createdAt));
    return byGroup;
  }, [rows, t]);
  const rejected = rows.filter(r => r.status === "rejected");
  const groupOrder = ["15", "30", "—"].filter(g => groups.has(g));
  const flatOf = (cities: Map<string, FirmMap>) => [...cities.values()].flatMap(f => [...f.values()].flatMap(m => [...m.values()].flat()));

  const rowCells = (r: AdvanceRequest) => (
    <tr key={r.id} className="hover:bg-slate-50">
      <td className="px-4 py-2 pl-10">
        <div className="font-medium text-slate-700">{r.name ?? "—"}</div>
        {r.iban ? (
          <button onClick={() => copyIban(r.iban!)} title={t("Натисни, щоб скопіювати")}
            className="mt-0.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs tabular-nums text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            {fmtIban(r.iban)} <Copy className="h-3 w-3" />
          </button>
        ) : (
          <div className="mt-0.5 text-xs text-amber-500">{t("немає рахунку в профілі")}</div>
        )}
      </td>
      <td className="px-4 py-2 text-slate-500">
        {fmtDate(r.createdAt)}
        {r.status === "paid" && r.paidAt && (
          <div className="text-xs text-emerald-600">
            💸 {fmtDate(r.paidAt)}
            {r.paidTxnId != null ? <span title={t("позначено автоматично за банківським переказом")}> · {t("авто")}</span>
              : r.paidMethod === "cash" ? <span> · {t("готівка")}</span>
              : r.paidMethod === "transfer" ? <span> · {t("переказ")}</span> : null}
            {r.paidTxnId == null && (
              <span className="text-slate-400" title={t("хто позначив виплату")}> · {r.paidByName ?? t("вручну (не зафіксовано ким)")}</span>
            )}
          </div>
        )}
      </td>
      <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-700">{r.amount} zł</td>
      <td className="px-4 py-2 text-slate-600">
        {r.comment || (!r.adminNote && !r.decidedByName && <span className="text-slate-300">—</span>)}
        {r.decidedByName && <div className="text-xs text-slate-400">✍️ {r.decidedByName}</div>}
        {r.status === "rejected" && r.adminNote && <div className="mt-0.5 text-xs text-rose-600">⛔ {r.adminNote}</div>}
      </td>
      <td className="px-4 py-2">
        <Badge color={STATUS_COLOR[r.status]}>{STATUS_LABEL[r.status]}</Badge>
        {r.status === "paid" && r.svodniMonth && (
          <div className="mt-0.5"><Badge color="slate">{t("сводна")} {r.svodniMonth}</Badge></div>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        {r.status === "approved" && (
          <div className="inline-flex items-center gap-1">
            <button onClick={() => setPaying(r)} disabled={act.isPending}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
              <Banknote className="h-4 w-4" /> {t("Виплачено")}
            </button>
            <button onClick={() => setMoving(r)} title={t("Перенести в іншу групу виплат")}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><ArrowLeftRight className="h-4 w-4" /></button>
            <button onClick={() => { setRejecting(r); setReason(""); }} title={t("Відхилити")}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-4 w-4" /></button>
          </div>
        )}
      </td>
    </tr>
  );

  const [tab, setTab] = useState<"adv" | "badania" | "svodni">("adv");
  const [gratOpen, setGratOpen] = useState(false);
  const me = useMe();
  const canGrat = can(me, "svodniSensitive");
  return (
    <>
      <PageHeader title={t("Аванси")} subtitle={t("Залічки: подача, групи виплат 15-го/30-го, виплата переказом чи готівкою")} />
      <div className="mb-4 flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm font-medium">
        {([["adv", t("Залічки")], ["badania", t("Бадання до зняття")], ["svodni", t("У сводну")]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 ${tab === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "badania" ? <BadaniaTab /> : tab === "svodni" ? <SvodniTransferTab /> : <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        <Select value={filter} onChange={e => setFilter(e.target.value as any)} className="w-48">
          <option value="all">{t("Усі")}</option>
          <option value="approved">{t("Передано до виплати")}</option>
          <option value="paid">{t("Виплачено")}</option>
          <option value="rejected">{t("Відхилено")}</option>
        </Select>
        <Button onClick={() => setSubmitting(true)}><Plus className="h-4 w-4" /> {t("Подати залічку")}</Button>
        {canGrat && (
          <Button variant="secondary" onClick={() => setGratOpen(true)} title={t("Файл для імпорту naliczeń у Gratyfikant nexo")}>
            <FileSpreadsheet className="h-4 w-4" /> Gratyfikant
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Badge color="amber">{t("На розгляді:")} {totals.requested} zł</Badge>
          <Badge color="blue">{t("До виплати:")} {totals.approved} zł</Badge>
          <Badge color="green">{t("Виплачено:")} {totals.paid} zł</Badge>
        </div>
      </div>

      {pending.length > 0 && (
        <Card className="mb-5 border-amber-200 bg-amber-50/40 p-4">
          <div className="mb-2 text-sm font-semibold text-slate-700">💰 {t("Запити на розгляді")} ({pending.length})</div>
          <div className="space-y-2">
            {pending.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-700">{r.name ?? "—"} {r.factory && <Badge color="slate">{r.factory}</Badge>}</div>
                  <div className="text-sm text-slate-500">{fmtDate(r.createdAt)} · <span className="font-semibold text-slate-700">{r.amount} zł</span></div>
                  {r.comment && <div className="mt-0.5 text-sm text-slate-600">📝 {r.comment}</div>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => act.mutate({ id: r.id, action: "approve" })} disabled={act.isPending} className="flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"><Check className="h-4 w-4" /> {t("Затвердити")}</button>
                  <button onClick={() => { setRejecting(r); setReason(""); }} disabled={act.isPending} className="flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"><X className="h-4 w-4" /> {t("Відхилити")}</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {isFetching && !data.length ? <Spinner /> : !groupOrder.length && !rejected.length ? <Empty>{t("За цей місяць авансів немає")}</Empty> : (
        <div className="space-y-6">
          {groupOrder.map(g => {
            const cities = groups.get(g)!;
            const all = flatOf(cities);
            return (
              <div key={g}>
                <div className="mb-2 flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-slate-400" />
                  <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">
                    {g === "—" ? t("Без групи виплати") : t(g === "15" ? "Виплата 15-го" : "Виплата 30-го")}
                  </h2>
                  <Badge color="slate">{all.length}</Badge>
                  <span className="text-sm font-semibold tabular-nums text-slate-600">{sumOf(all).toFixed(2)} zł</span>
                </div>
                <div className="space-y-4">
                  {[...cities.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([city, firms]) => (
                    <Card key={city} className="overflow-hidden">
                      <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
                        <Landmark className="h-4 w-4 text-slate-400" />
                        <span className="text-sm font-bold tracking-tight text-slate-800">{t(city)}</span>
                        <Badge color="slate">{[...firms.values()].flatMap(m => [...m.values()]).reduce((a, rs) => a + rs.length, 0)}</Badge>
                        <span className="ml-auto text-sm font-semibold tabular-nums text-slate-700">
                          {sumOf([...firms.values()].flatMap(m => [...m.values()].flat())).toFixed(2)} zł
                        </span>
                      </div>
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                          <tr>
                            <th className="px-4 py-2">{t("Працівник")}</th><th className="px-4 py-2">{t("Дата")}</th>
                            <th className="px-4 py-2 text-right">{t("Сума")}</th><th className="px-4 py-2">{t("Коментар / хто подав")}</th>
                            <th className="px-4 py-2">{t("Статус")}</th><th className="px-4 py-2"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {[...firms.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([firm, facs]) => [
                            <tr key={`c-${firm}`} className="bg-slate-100/70">
                              <td colSpan={2} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                                <span className="inline-flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" /> {firm}</span>
                              </td>
                              <td className="px-4 py-1.5 text-right text-[11px] font-semibold tabular-nums text-slate-600">{sumOf([...facs.values()].flat()).toFixed(2)} zł</td>
                              <td colSpan={3} />
                            </tr>,
                            ...[...facs.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([factory, list]) => [
                              <tr key={`f-${firm}-${factory}`} className="bg-slate-50/80">
                                <td colSpan={2} className="px-4 py-1.5 pl-8 text-[11px] font-bold uppercase tracking-wide text-slate-500">{factory}</td>
                                <td className="px-4 py-1.5 text-right text-[11px] font-semibold tabular-nums text-slate-500">{sumOf(list).toFixed(2)} zł</td>
                                <td colSpan={3} />
                              </tr>,
                              ...list.map(rowCells),
                            ]),
                          ])}
                        </tbody>
                      </table>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}

          {rejected.length > 0 && (filter === "all" || filter === "rejected") && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">{t("Відхилені")}</h2>
                <Badge color="rose">{rejected.length}</Badge>
              </div>
              <Card className="overflow-hidden">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100">{rejected.map(rowCells)}</tbody>
                </table>
              </Card>
            </div>
          )}
        </div>
      )}

      {rejecting && (
        <Modal open onClose={() => setRejecting(null)} title={t("Відхилити аванс")}>
          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              {rejecting.name ?? "—"} · <span className="font-semibold">{rejecting.amount} zł</span>
            </div>
            <div>
              <Label>{t("Причина відхилення (необов'язково)")}</Label>
              <Input value={reason} onChange={e => setReason(e.target.value)} placeholder={t("Напр.: перевищено ліміт авансів")} autoFocus />
              <p className="mt-1 text-xs text-slate-400">{t("Працівник отримає це повідомлення в Telegram.")}</p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setRejecting(null)}>{t("Скасувати")}</Button>
              <Button loading={act.isPending} onClick={confirmReject}>{t("Відхилити")}</Button>
            </div>
          </div>
        </Modal>
      )}

      {paying && (
        <Modal open onClose={() => setPaying(null)} title={t("Позначити виплаченим")}>
          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              {paying.name ?? "—"} · <span className="font-semibold">{paying.amount} zł</span>
            </div>
            <p className="text-sm text-slate-500">{t("Як виплачено аванс?")}</p>
            <div className="grid grid-cols-2 gap-2">
              <Button loading={act.isPending} onClick={() => { act.mutate({ id: paying.id, action: "paid", method: "transfer" }); setPaying(null); }}>
                💳 {t("Переказ")}
              </Button>
              <Button variant="secondary" loading={act.isPending} onClick={() => { act.mutate({ id: paying.id, action: "paid", method: "cash" }); setPaying(null); }}>
                💵 {t("Готівка")}
              </Button>
            </div>
            <p className="text-xs text-slate-400">{t("Дата виплати — сьогодні. Перекази з банку позначаються автоматично, вручну відмічай лише те, чого банк не бачить.")}</p>
          </div>
        </Modal>
      )}

      {moving && <MoveModal row={moving} onClose={() => setMoving(null)} onSaved={() => { setMoving(null); inv(); }} />}
      {submitting && <SubmitModal onClose={() => setSubmitting(false)} onSaved={() => { setSubmitting(false); inv(); }} />}
      {gratOpen && <GratyfikantZaliczkiModal month={month} rows={monthRows} onClose={() => setGratOpen(false)} />}
      </>}
    </>
  );
}

// ─── Бадання до зняття: незняті залічки за медогляд → Zaliczka BD сводної ────
type BadaniaPendingRow = { id: number; workerId: number; workerName: string; nationality: string | null; amount: number; enteredAt: string; note: string | null };
type BadaniaDeductedRow = BadaniaPendingRow & { deductedAt: string | null; deductedMonth: string | null };
const curMonthWarsaw = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" }).slice(0, 7);
const fmtDateStr = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

// Історія знятих: місяць сводної, дата, кнопка «↩ Відмінити» — віднімає суму
// з клітинки Zaliczka BD тієї сводної (залочена вкладка — відмова) і повертає
// запис у «до зняття». Зняте вручну (без місяця) відміняється в профілі.
function BadaniaDeductedList() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const canSvodni = can(me, "svodni");
  const { data, isLoading } = useQuery<{ rows: BadaniaDeductedRow[]; total: number }>({
    queryKey: ["badania-deducted"], queryFn: () => get("/badania/deducted"),
  });
  const undo = useMutation({
    mutationFn: (id: number) => post<{ month: string; subtracted: { factoryLabel: string; newValue: number | null } | null; warning: string | null }>("/svodni/undo-badania-deduction", { id }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["badania-deducted"] });
      qc.invalidateQueries({ queryKey: ["badania-pending"] });
      if (d.warning) toast.warning(d.warning, { duration: 10000 });
      else toast.success(t("Відмінено"), { description: `${d.subtracted!.factoryLabel} (${d.month}): Zaliczka BD → ${d.subtracted!.newValue ?? 0} zł` });
    },
    onError: (e: any) => toast.error(e.message, { duration: e.status === 409 ? 12000 : undefined }),
  });
  if (isLoading) return <Spinner />;
  if (!data?.rows.length) return <Card><Empty>{t("Ще нічого не знято")}</Empty></Card>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-130 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
          <tr>
            <th className="px-3 py-2.5">{t("Працівник")}</th>
            <th className="px-3 py-2.5 text-right">{t("Сума")}</th>
            <th className="px-3 py-2.5">{t("вписано")}</th>
            <th className="px-3 py-2.5">{t("Знято")}</th>
            <th className="px-3 py-2.5"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.rows.map(r => (
            <tr key={r.id} className="hover:bg-slate-50">
              <td className="px-3 py-2">
                <Link href={`/workers/${r.workerId}`} className="font-medium text-slate-700 hover:text-red-600 hover:underline">{r.workerName}</Link>
                <NatFlag value={r.nationality} className="ml-1 cursor-default" />
              </td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-700">{r.amount} zł</td>
              <td className="px-3 py-2 tabular-nums text-slate-500">{fmtDateStr(r.enteredAt)}</td>
              <td className="px-3 py-2 text-slate-600">
                {r.deductedAt ? fmtDateStr(r.deductedAt) : "—"}
                {r.deductedMonth
                  ? <Badge color="green">{t("сводна")} {r.deductedMonth}</Badge>
                  : <span className="ml-1.5 text-xs text-slate-400">{t("вручну")}</span>}
              </td>
              <td className="px-3 py-2 text-right">
                {r.deductedMonth != null && canSvodni && (
                  <button className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    onClick={async () => { if (await confirm({ title: t("Відмінити зняття?"), message: `${r.workerName} · ${r.amount} zł — ${t("сума віднімається з клітинки Zaliczka BD сводної")} ${r.deductedMonth}. ${t("Запис повернеться у «до зняття».")}`, danger: true, confirmText: t("Відмінити") })) undo.mutate(r.id); }}>
                    ↩ {t("Відмінити")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function BadaniaTab() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const canSvodni = can(me, "svodni");
  const [month, setMonth] = useState(curMonthWarsaw());
  const [sel, setSel] = useState<Set<number>>(new Set());
  const { data, isLoading } = useQuery<{ rows: BadaniaPendingRow[]; total: number }>({
    queryKey: ["badania-pending"], queryFn: () => get("/badania/pending"),
  });
  // типово вибрані всі — «перенести всі» це просто кнопка без зняття галочок
  useEffect(() => { if (data) setSel(new Set(data.rows.map(r => r.id))); }, [data]);
  const toggle = (id: number) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = (data?.rows.length ?? 0) > 0 && sel.size === data!.rows.length;
  const selSum = r2((data?.rows ?? []).filter(r => sel.has(r.id)).reduce((a, r) => a + r.amount, 0));
  // місяці на вибір — РЕАЛЬНІ місяці сводних (щоб перенесення цілило в наявну
  // вкладку); поточний місяць завжди в списку як фолбек
  const { data: svodniMonths } = useQuery<{ months: string[] }>({
    queryKey: ["svodni-months"], queryFn: () => get("/svodni/months"), enabled: canSvodni,
  });
  const months = useMemo(
    () => [...new Set([curMonthWarsaw(), ...(svodniMonths?.months ?? [])])].sort().reverse(),
    [svodniMonths]);
  const apply = useMutation({
    mutationFn: () => post<{ updated: number; itemsMarked: number; verified: number; verifyMismatches: { workerName: string; expected: number | null; actual: number | null }[]; skippedLocked: number; unmatched: { workerName: string | null; amount: number }[] }>(
      "/svodni/apply-badania-deductions", { month, ids: [...sel] }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["badania-pending"] });
      const parts = [`${t("оновлено рядків")}: ${d.updated}`, `${t("позицій знято")}: ${d.itemsMarked}`, `${t("звірено")}: ${d.verified - d.verifyMismatches.length}/${d.verified} ✓`];
      if (d.skippedLocked) parts.push(`${t("пропущено затверджених")}: ${d.skippedLocked}`);
      toast.success(t("Перенесено до сводної"), { description: parts.join(", ") });
      if (d.verifyMismatches.length) {
        toast.error(`${t("Самозвірка не зійшлася")}: ${d.verifyMismatches.length}`, {
          description: d.verifyMismatches.slice(0, 6).map(v => `${v.workerName}: ${v.expected ?? 0} ≠ ${v.actual ?? 0}`).join(", "), duration: 15000,
        });
      }
      if (d.unmatched.length) {
        toast.warning(`${t("Без рядка сводної")}: ${d.unmatched.length}`, {
          description: d.unmatched.slice(0, 6).map(u => u.workerName ?? "—").join(", ") + (d.unmatched.length > 6 ? "…" : ""), duration: 12000,
        });
      }
    },
    onError: (e: any) => toast.error(e.message),
  });
  const fmtD = fmtDateStr;
  const [view, setView] = useState<"pending" | "deducted">("pending");
  const viewSwitch = (
    <div className="flex w-fit gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
      {([["pending", t("До зняття")], ["deducted", t("Зняті")]] as const).map(([k, label]) => (
        <button key={k} onClick={() => setView(k)}
          className={`rounded-md px-2.5 py-1 ${view === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
          {label}
        </button>
      ))}
    </div>
  );
  if (view === "deducted") {
    return (
      <>
        <div className="mb-3 flex flex-wrap items-center gap-3">{viewSwitch}</div>
        <BadaniaDeductedList />
      </>
    );
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {viewSwitch}
        <span className="text-sm text-slate-500">
          <Stethoscope className="mr-1 inline h-4 w-4 text-red-600" />
          {t("до зняття")}: <b>{(data?.total ?? 0).toFixed(2)} zł</b> · {data?.rows.length ?? 0} {t("людей")}
        </span>
        {canSvodni && (
          <div className="ml-auto flex items-center gap-2">
            <Select value={month} onChange={e => setMonth(e.target.value)} className="w-36">
              {months.map(m => <option key={m} value={m}>{m}</option>)}
            </Select>
            <Button loading={apply.isPending} disabled={!sel.size}
              onClick={async () => { if (await confirm({ title: t("Перенести залічки за бадання до сводної?"), message: t("Суми вибраних ляжуть у колонку Zaliczka BD рядка основної фабрики людини за вибраний місяць (додаються до наявних). Затверджені вкладки пропускаються."), confirmText: t("Перенести") })) apply.mutate(); }}>
              → {allSelected ? t("Перенести всі") : `${t("Перенести вибрані")} (${sel.size})`} · {selSum.toFixed(2)} zł
            </Button>
          </div>
        )}
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? <Spinner /> : !data?.rows.length ? <Empty>{t("Немає незнятих залічок за бадання")}</Empty> : (
          <table className="w-full min-w-120 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="w-8 px-3 py-2.5">
                  <input type="checkbox" className="accent-red-600" checked={allSelected}
                    onChange={() => setSel(allSelected ? new Set() : new Set(data.rows.map(r => r.id)))} />
                </th>
                <th className="px-3 py-2.5">{t("Працівник")}</th>
                <th className="px-3 py-2.5 text-right">{t("Сума")}</th>
                <th className="px-3 py-2.5">{t("вписано")}</th>
                <th className="px-3 py-2.5">{t("Нотатка")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map(r => (
                <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => toggle(r.id)}>
                  <td className="px-3 py-2"><input type="checkbox" className="accent-red-600" checked={sel.has(r.id)} onChange={() => toggle(r.id)} onClick={e => e.stopPropagation()} /></td>
                  <td className="px-3 py-2">
                    <Link href={`/workers/${r.workerId}`} onClick={e => e.stopPropagation()}
                      className="font-medium text-slate-700 hover:text-red-600 hover:underline">{r.workerName}</Link>
                    <NatFlag value={r.nationality} className="ml-1 cursor-default" />
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-700">{r.amount} zł</td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{fmtD(r.enteredAt)}</td>
                  <td className="max-w-50 truncate px-3 py-2 text-xs text-slate-400" title={r.note ?? undefined}>{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

// Ліста залічок до Gratyfikant nexo (дзеркало модалки сводних): фірма (один
// підмiot за раз) → група 15/30 → превʼю людей з сумами й попередженнями
// (без PESEL / умова — знімок з Налаштувань → Gratyfikant), галочки прибирають
// непотрібних, файл — Імʼя | PESEL | Дата виплати | Сума (без заголовка).
type GratZalPreviewRow = { rowId: number; name: string; pesel: string; factoryLabel: string | null; kwota: number; warnings: string[] };
const GRAT_WARN: Record<string, string> = {
  no_pesel: "без PESEL",
  umowa_none: "немає умови",
  umowa_expired: "умова скінчилась",
  umowa_other_firm: "умова в іншій фірмі",
};
function GratyfikantZaliczkiModal({ month, rows, onClose }: {
  month: string; rows: AdvanceRequest[]; onClose: () => void;
}) {
  const t = useT();
  // кандидати — «передано до виплати» вибраного місяця; фірма = фірма працівника
  const eligible = useMemo(() => rows.filter(r => r.status === "approved"), [rows]);
  const [group, setGroup] = useState<"15" | "30">(() =>
    eligible.some(r => r.payoutGroup === "15") || !eligible.some(r => r.payoutGroup === "30") ? "15" : "30");
  const inGroup = useMemo(() => eligible.filter(r => r.payoutGroup === group), [eligible, group]);
  const firms = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of inGroup) if (r.company) m.set(r.company, (m.get(r.company) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [inGroup]);
  const [firm, setFirm] = useState<string>(() => firms[0]?.[0] ?? "");
  useEffect(() => { if (firm && !firms.some(([f]) => f === firm)) setFirm(firms[0]?.[0] ?? ""); }, [firms, firm]);
  const params = new URLSearchParams({ month, group, firm });
  const { data: preview, isLoading } = useQuery<{
    payDate: string; umowySnapshot: boolean; rows: GratZalPreviewRow[]; totals: { count: number; sum: number };
  }>({
    queryKey: ["grat-zal-preview", month, group, firm],
    queryFn: () => get(`/advances/gratyfikant-preview?${params.toString()}`),
    enabled: !!firm,
  });
  const [payDate, setPayDate] = useState("");
  const [checked, setChecked] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!preview) return;
    setPayDate(preview.payDate);
    // дефолт: відзначені всі без попереджень; попереджені — зняті
    setChecked(new Set(preview.rows.filter(r => !r.warnings.length).map(r => r.rowId)));
  }, [preview]);
  const toggle = (id: number) => setChecked(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const selRows = (preview?.rows ?? []).filter(r => checked.has(r.rowId));
  const selSum = r2(selRows.reduce((a, r) => a + r.kwota, 0));
  const dl = new URLSearchParams(params);
  dl.set("payDate", payDate);
  dl.set("rows", selRows.map(r => r.rowId).join(","));
  return (
    <Modal open onClose={onClose} title={t("Ліста залічок до Gratyfikanta")}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Група")}</div>
            <div className="flex gap-1.5">
              {(["15", "30"] as const).map(g => (
                <button key={g} onClick={() => setGroup(g)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${group === g ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  {t(g === "15" ? "Виплата 15-го" : "Виплата 30-го")}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Фірма (podmiot)")}</div>
            <div className="flex flex-wrap gap-1.5">
              {firms.length ? firms.map(([f, n]) => (
                <button key={f} onClick={() => setFirm(f)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${firm === f ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  {f} · {n}
                </button>
              )) : <span className="text-sm text-slate-400">{t("у групі немає залічок «передано до виплати»")}</span>}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Дата виплати")}</div>
            <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm focus:border-red-400 focus:outline-none" />
          </div>
        </div>
        {preview && !preview.umowySnapshot && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {t("Знімок умов ще не завантажено (Налаштування → Gratyfikant) — попередження про умови недоступні.")}
          </p>
        )}
        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
          {isLoading ? <div className="p-4"><Spinner /></div> : (
            <table className="w-full text-sm">
              <tbody>
                {(preview?.rows ?? []).map(r => (
                  <tr key={r.rowId} className={`border-b border-slate-100 last:border-0 ${checked.has(r.rowId) ? "" : "opacity-50"}`}>
                    <td className="w-8 px-2 py-1.5"><input type="checkbox" checked={checked.has(r.rowId)} onChange={() => toggle(r.rowId)} /></td>
                    <td className="px-2 py-1.5">{r.name}
                      {r.warnings.map(w => (
                        <span key={w} className="ml-1.5 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 ring-1 ring-rose-200">{t(GRAT_WARN[w] ?? w)}</span>
                      ))}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-xs text-slate-500">{r.pesel || "—"}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-400">{r.factoryLabel}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.kwota.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-sm text-slate-500">
            {t("Вибрано")}: <b>{selRows.length}</b> / {preview?.rows.length ?? 0} · {t("разом")}: <b className="tabular-nums">{selSum.toFixed(2)}</b>
          </span>
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          {selRows.length > 0 && payDate ? (
            <a href={`/api/advances/gratyfikant?${dl.toString()}`} onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700">
              <Download className="h-4 w-4" /> {t("Скачати лісту")}
            </a>
          ) : (
            <span className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-400">
              <Download className="h-4 w-4" /> {t("Скачати лісту")}
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Вкладка «У сводну»: масове перенесення ВИПЛАЧЕНИХ залічок у колонку Zaliczka
// сводної після звірки (from-hours залічки не заповнює). Дзеркало вкладки
// бадань: галочки → перенести у вибраний місяць; «перенесені» — з відміною ↩.
type SvodniPendingAdvance = {
  id: number; workerId: number; workerName: string | null; nationality: string | null;
  company: string | null; factory: string | null; amount: number;
  payoutMonth: string | null; payoutGroup: string | null;
  paidAt: string | null; paidMethod: string | null; paidTxnId: number | null;
};
type SvodniAppliedAdvance = {
  id: number; workerId: number; workerName: string | null; nationality: string | null;
  amount: number; paidAt: string | null; svodniMonth: string; svodniAppliedAt: string | null;
};

function SvodniAppliedList() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const canSvodni = can(me, "svodni");
  const { data, isLoading } = useQuery<{ rows: SvodniAppliedAdvance[] }>({
    queryKey: ["adv-svodni-applied"], queryFn: () => get("/advances/svodni-applied"),
  });
  const undo = useMutation({
    mutationFn: (id: number) => post<{ month: string; subtracted: { factoryLabel: string; newValue: number | null } | null; warning: string | null }>("/svodni/undo-zaliczka", { id }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["adv-svodni-applied"] });
      qc.invalidateQueries({ queryKey: ["adv-svodni-pending"] });
      qc.invalidateQueries({ queryKey: ["advances"] });
      if (d.warning) toast.warning(d.warning, { duration: 10000 });
      else toast.success(t("Відмінено"), { description: `${d.subtracted!.factoryLabel} (${d.month}): Zaliczka → ${d.subtracted!.newValue ?? 0} zł` });
    },
    onError: (e: any) => toast.error(e.message, { duration: e.status === 409 ? 12000 : undefined }),
  });
  if (isLoading) return <Spinner />;
  if (!data?.rows.length) return <Card><Empty>{t("Ще нічого не перенесено")}</Empty></Card>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-130 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
          <tr>
            <th className="px-3 py-2.5">{t("Працівник")}</th>
            <th className="px-3 py-2.5 text-right">{t("Сума")}</th>
            <th className="px-3 py-2.5">{t("Виплачено")}</th>
            <th className="px-3 py-2.5">{t("Перенесено")}</th>
            <th className="px-3 py-2.5"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.rows.map(r => (
            <tr key={r.id} className="hover:bg-slate-50">
              <td className="px-3 py-2">
                <Link href={`/workers/${r.workerId}`} className="font-medium text-slate-700 hover:text-red-600 hover:underline">{r.workerName ?? "—"}</Link>
                <NatFlag value={r.nationality} className="ml-1 cursor-default" />
              </td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-700">{r.amount} zł</td>
              <td className="px-3 py-2 tabular-nums text-slate-500">{r.paidAt ? fmtDate(r.paidAt) : "—"}</td>
              <td className="px-3 py-2 text-slate-600">
                {r.svodniAppliedAt ? fmtDateStr(r.svodniAppliedAt) : "—"}
                <Badge color="green">{t("сводна")} {r.svodniMonth}</Badge>
              </td>
              <td className="px-3 py-2 text-right">
                {canSvodni && (
                  <button className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    onClick={async () => { if (await confirm({ title: t("Відмінити перенесення?"), message: `${r.workerName ?? "—"} · ${r.amount} zł — ${t("сума віднімається з клітинки Zaliczka сводної")} ${r.svodniMonth}. ${t("Аванс лишиться виплаченим і повернеться в «до перенесення».")}`, danger: true, confirmText: t("Відмінити") })) undo.mutate(r.id); }}>
                    ↩ {t("Відмінити")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function SvodniTransferTab() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const canSvodni = can(me, "svodni");
  const [month, setMonth] = useState(curMonthWarsaw());
  const [sel, setSel] = useState<Set<number>>(new Set());
  const { data, isLoading } = useQuery<{ rows: SvodniPendingAdvance[]; total: number }>({
    queryKey: ["adv-svodni-pending"], queryFn: () => get("/advances/svodni-pending"),
  });
  // типово вибрані всі виплачені — оператор знімає зайве
  useEffect(() => { if (data) setSel(new Set(data.rows.map(r => r.id))); }, [data]);
  const toggle = (id: number) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = (data?.rows.length ?? 0) > 0 && sel.size === data!.rows.length;
  const selSum = r2((data?.rows ?? []).filter(r => sel.has(r.id)).reduce((a, r) => a + r.amount, 0));
  // місяці на вибір — реальні місяці сводних (перенесення цілить у наявну вкладку)
  const { data: svodniMonths } = useQuery<{ months: string[] }>({
    queryKey: ["svodni-months"], queryFn: () => get("/svodni/months"), enabled: canSvodni,
  });
  const months = useMemo(
    () => [...new Set([curMonthWarsaw(), ...(svodniMonths?.months ?? [])])].sort().reverse(),
    [svodniMonths]);
  const apply = useMutation({
    mutationFn: () => post<{ updated: number; itemsMarked: number; verified: number; verifyMismatches: { workerName: string; expected: number | null; actual: number | null }[]; skippedLocked: number; unmatched: { workerName: string | null; amount: number }[] }>(
      "/svodni/apply-zaliczki", { month, ids: [...sel] }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["adv-svodni-pending"] });
      qc.invalidateQueries({ queryKey: ["adv-svodni-applied"] });
      qc.invalidateQueries({ queryKey: ["advances"] });
      const parts = [`${t("оновлено рядків")}: ${d.updated}`, `${t("залічок перенесено")}: ${d.itemsMarked}`, `${t("звірено")}: ${d.verified - d.verifyMismatches.length}/${d.verified} ✓`];
      if (d.skippedLocked) parts.push(`${t("пропущено затверджених")}: ${d.skippedLocked}`);
      toast.success(t("Перенесено до сводної"), { description: parts.join(", ") });
      if (d.verifyMismatches.length) {
        toast.error(`${t("Самозвірка не зійшлася")}: ${d.verifyMismatches.length}`, {
          description: d.verifyMismatches.slice(0, 6).map(v => `${v.workerName}: ${v.expected ?? 0} ≠ ${v.actual ?? 0}`).join(", "), duration: 15000,
        });
      }
      if (d.unmatched.length) {
        toast.warning(`${t("Без рядка сводної")}: ${d.unmatched.length}`, {
          description: d.unmatched.slice(0, 6).map(u => u.workerName ?? "—").join(", ") + (d.unmatched.length > 6 ? "…" : ""), duration: 12000,
        });
      }
    },
    onError: (e: any) => toast.error(e.message),
  });
  const [view, setView] = useState<"pending" | "applied">("pending");
  const viewSwitch = (
    <div className="flex w-fit gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
      {([["pending", t("До перенесення")], ["applied", t("Перенесені")]] as const).map(([k, label]) => (
        <button key={k} onClick={() => setView(k)}
          className={`rounded-md px-2.5 py-1 ${view === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
          {label}
        </button>
      ))}
    </div>
  );
  if (view === "applied") {
    return (
      <>
        <div className="mb-3 flex flex-wrap items-center gap-3">{viewSwitch}</div>
        <SvodniAppliedList />
      </>
    );
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {viewSwitch}
        <span className="text-sm text-slate-500">
          <Banknote className="mr-1 inline h-4 w-4 text-red-600" />
          {t("виплачені, ще не в сводній")}: <b>{(data?.total ?? 0).toFixed(2)} zł</b> · {data?.rows.length ?? 0}
        </span>
        {canSvodni && (
          <div className="ml-auto flex items-center gap-2">
            <Select value={month} onChange={e => setMonth(e.target.value)} className="w-36">
              {months.map(m => <option key={m} value={m}>{m}</option>)}
            </Select>
            <Button loading={apply.isPending} disabled={!sel.size}
              onClick={async () => { if (await confirm({ title: t("Перенести залічки до сводної?"), message: t("Суми вибраних ляжуть у колонку Zaliczka рядка фабрики запиту (нема — основної фабрики) за вибраний місяць, додаючись до наявних. Затверджені вкладки пропускаються."), confirmText: t("Перенести") })) apply.mutate(); }}>
              → {allSelected ? t("Перенести всі") : `${t("Перенести вибрані")} (${sel.size})`} · {selSum.toFixed(2)} zł
            </Button>
          </div>
        )}
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? <Spinner /> : !data?.rows.length ? <Empty>{t("Немає виплачених залічок до перенесення")}</Empty> : (
          <table className="w-full min-w-130 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="w-8 px-3 py-2.5">
                  <input type="checkbox" className="accent-red-600" checked={allSelected}
                    onChange={() => setSel(allSelected ? new Set() : new Set(data.rows.map(r => r.id)))} />
                </th>
                <th className="px-3 py-2.5">{t("Працівник")}</th>
                <th className="px-3 py-2.5">{t("Фабрика")}</th>
                <th className="px-3 py-2.5 text-right">{t("Сума")}</th>
                <th className="px-3 py-2.5">{t("Група")}</th>
                <th className="px-3 py-2.5">{t("Виплачено")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map(r => (
                <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => toggle(r.id)}>
                  <td className="px-3 py-2"><input type="checkbox" className="accent-red-600" checked={sel.has(r.id)} onChange={() => toggle(r.id)} onClick={e => e.stopPropagation()} /></td>
                  <td className="px-3 py-2">
                    <Link href={`/workers/${r.workerId}`} onClick={e => e.stopPropagation()}
                      className="font-medium text-slate-700 hover:text-red-600 hover:underline">{r.workerName ?? "—"}</Link>
                    <NatFlag value={r.nationality} className="ml-1 cursor-default" />
                    {r.company && <span className="ml-1.5 text-xs text-slate-400">{r.company}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.factory ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-700">{r.amount} zł</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {r.payoutMonth ? `${r.payoutMonth} · ${r.payoutGroup ?? "—"}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {r.paidAt ? fmtDate(r.paidAt) : "—"}
                    {r.paidTxnId != null ? <span className="ml-1 text-emerald-600">{t("авто")}</span>
                      : r.paidMethod === "cash" ? <span className="ml-1">💵</span>
                      : r.paidMethod === "transfer" ? <span className="ml-1">💳</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

// Перенесення авансу в іншу групу виплат (місяць + 15/30) + зміна фабрики
// запиту (з якої ЗП знімається залічка; перенесення в сводну цілить у її рядок).
function MoveModal({ row, onClose, onSaved }: { row: AdvanceRequest; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const cur = row.payoutMonth ?? monthOptions()[0]!.value;
  const [m, setM] = useState(cur);
  const [g, setG] = useState<"15" | "30">(row.payoutGroup === "30" ? "30" : "15");
  const [facId, setFacId] = useState(row.factoryId != null ? String(row.factoryId) : "");
  const { data: factories = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  // місяці на вибір: поточна група, місяць подачі та ±1 від них
  const opts = useMemo(() => {
    const set = new Set([cur, addMonths(cur, 1), addMonths(cur, -1), row.createdAt.slice(0, 7), monthOptions()[0]!.value]);
    return [...set].sort().reverse();
  }, [cur, row.createdAt]);
  const save = useMutation({
    mutationFn: () => patch(`/advances/${row.id}`, {
      payoutMonth: m, payoutGroup: g,
      ...(String(row.factoryId ?? "") !== facId ? { factoryId: facId ? Number(facId) : null } : {}),
    }),
    onSuccess: () => { toast.success(t("Перенесено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Перенести в іншу групу виплат")}>
      <div className="space-y-3">
        <div className="text-sm text-slate-600">{row.name ?? "—"} · <span className="font-semibold">{row.amount} zł</span></div>
        <div className="flex gap-2">
          <div className="flex-1">
            <Label>{t("Місяць")}</Label>
            <Select value={m} onChange={e => setM(e.target.value)}>
              {opts.map(o => <option key={o} value={o}>{monthLabel(o)}</option>)}
            </Select>
          </div>
          <div className="flex-1">
            <Label>{t("Група")}</Label>
            <Select value={g} onChange={e => setG(e.target.value as "15" | "30")}>
              <option value="15">{t("Виплата 15-го")}</option>
              <option value="30">{t("Виплата 30-го")}</option>
            </Select>
          </div>
        </div>
        <div>
          <Label>{t("Фабрика запиту (з якої ЗП зняти)")}</Label>
          <Select value={facId} onChange={e => setFacId(e.target.value)}>
            <option value="">{t("— авто (основна фабрика місяця) —")}</option>
            {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>{t("Перенести")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Офісна подача залічки: одразу «передано до виплати» від імені подавача.
function SubmitModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [comment, setComment] = useState("");
  const [facId, setFacId] = useState("");
  const { data: workers } = useQuery<{ id: number; fullName: string; factoryId?: number | null; factoryName?: string | null; isActive?: boolean }[]>({
    queryKey: ["workers"], queryFn: () => get("/workers"),
  });
  const { data: factories = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const save = useMutation({
    mutationFn: () => post("/advances", {
      workerId, amount: Number(amount.replace(",", ".")), comment: comment.trim() || undefined,
      ...(facId ? { factoryId: Number(facId) } : {}),
    }),
    onSuccess: () => { toast.success(t("Передано до виплати")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  const needle = q.trim().toLowerCase();
  const found = needle.length >= 2 ? (workers ?? []).filter(w => w.fullName.toLowerCase().includes(needle)).slice(0, 8) : [];
  const sel = (workers ?? []).find(w => w.id === workerId);
  const amountNum = Number(amount.replace(",", "."));
  return (
    <Modal open onClose={onClose} title={t("Подати залічку")}>
      <div className="space-y-3">
        <div>
          <Label>{t("Працівник")}</Label>
          {sel ? (
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <span className="font-medium">{sel.fullName}</span>
              {sel.factoryName && <span className="text-xs text-slate-400">{sel.factoryName}</span>}
              <button className="ml-auto text-xs text-slate-400 hover:text-rose-500" onClick={() => setWorkerId(null)}>✕</button>
            </div>
          ) : (
            <>
              <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("Пошук по імені…")} autoFocus />
              {found.length > 0 && (
                <div className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {found.map(w => (
                    <button key={w.id} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-red-50"
                      onClick={() => { setWorkerId(w.id); setFacId(w.factoryId != null ? String(w.factoryId) : ""); }}>
                      {w.fullName}
                      {w.factoryName && <span className="text-xs text-slate-400">{w.factoryName}</span>}
                      {w.isActive === false && <Badge color="rose">{t("звільнений")}</Badge>}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div>
          <Label>{t("Фабрика запиту (з якої ЗП зняти)")}</Label>
          <Select value={facId} onChange={e => setFacId(e.target.value)}>
            <option value="">{t("— авто (основна фабрика місяця) —")}</option>
            {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </div>
        <div><Label>{t("Сума, zł")}</Label><Input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="200" /></div>
        <div><Label>{t("Коментар (необов'язково)")}</Label><Input value={comment} onChange={e => setComment(e.target.value)} /></div>
        <p className="text-xs text-slate-400">{t("Залічка одразу стане «передано до виплати» — група 15-го/30-го за сьогоднішньою датою. Працівник отримає повідомлення в Telegram.")}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!workerId || !isFinite(amountNum) || amountNum <= 0} onClick={() => save.mutate()}>{t("Подати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// «Аванси» (залічки) — ведення виплат авансів «як у таблиці»: групи виплат
// 15-го/30-го (ставляться автоматично датою затвердження, можна переносити),
// всередині групи — місто → фірма → фабрика. Подача: працівник у боті (pending →
// затвердження) або офіс з цієї сторінки (одразу «передано до виплати»).
// Виплата: авто по банківському переказу (services/advances.ts) або вручну
// з вибором переказ/готівка. IBAN працівника — з профілю, клік = копіювання.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, Banknote, Landmark, Plus, Copy, ArrowLeftRight, Building2, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, type AdvanceRequest } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Modal, Button, Input, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { monthOptions } from "../lib/dates";
import { useT } from "../lib/i18n";

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
          </div>
        )}
      </td>
      <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-700">{r.amount} zł</td>
      <td className="px-4 py-2 text-slate-600">
        {r.comment || (!r.adminNote && !r.decidedByName && <span className="text-slate-300">—</span>)}
        {r.decidedByName && <div className="text-xs text-slate-400">✍️ {r.decidedByName}</div>}
        {r.status === "rejected" && r.adminNote && <div className="mt-0.5 text-xs text-rose-600">⛔ {r.adminNote}</div>}
      </td>
      <td className="px-4 py-2"><Badge color={STATUS_COLOR[r.status]}>{STATUS_LABEL[r.status]}</Badge></td>
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

  return (
    <>
      <PageHeader title={t("Аванси")} subtitle={t("Залічки: подача, групи виплат 15-го/30-го, виплата переказом чи готівкою")} />
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
    </>
  );
}

// Перенесення авансу в іншу групу виплат (місяць + 15/30).
function MoveModal({ row, onClose, onSaved }: { row: AdvanceRequest; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const cur = row.payoutMonth ?? monthOptions()[0]!.value;
  const [m, setM] = useState(cur);
  const [g, setG] = useState<"15" | "30">(row.payoutGroup === "30" ? "30" : "15");
  // місяці на вибір: поточна група, місяць подачі та ±1 від них
  const opts = useMemo(() => {
    const set = new Set([cur, addMonths(cur, 1), addMonths(cur, -1), row.createdAt.slice(0, 7), monthOptions()[0]!.value]);
    return [...set].sort().reverse();
  }, [cur, row.createdAt]);
  const save = useMutation({
    mutationFn: () => patch(`/advances/${row.id}`, { payoutMonth: m, payoutGroup: g }),
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
  const { data: workers } = useQuery<{ id: number; fullName: string; factoryName?: string | null; isActive?: boolean }[]>({
    queryKey: ["workers"], queryFn: () => get("/workers"),
  });
  const save = useMutation({
    mutationFn: () => post("/advances", { workerId, amount: Number(amount.replace(",", ".")), comment: comment.trim() || undefined }),
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
                    <button key={w.id} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-red-50" onClick={() => setWorkerId(w.id)}>
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

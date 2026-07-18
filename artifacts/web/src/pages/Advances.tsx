// «Аванси» — запити працівників на аванс. Аванс належить місяцю, в якому був
// зроблений запит (createdAt); всередині місяця — групування місто → фабрика
// (місто фабрики бекенд бере з історії сводних, як у from-hours).
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, Banknote, Landmark } from "lucide-react";
import { toast } from "sonner";
import { get, post, type AdvanceRequest } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Modal, Button, Input, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { monthOptions } from "../lib/dates";
import { useT } from "../lib/i18n";

const STATUS_COLOR: Record<string, "amber" | "blue" | "rose" | "green"> = {
  pending: "amber", approved: "blue", rejected: "rose", paid: "green",
};
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
const r2 = (n: number) => Math.round(n * 100) / 100;

export default function Advances() {
  const t = useT();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected" | "paid">("all");
  const [rejecting, setRejecting] = useState<AdvanceRequest | null>(null);
  const [reason, setReason] = useState("");
  const { data = [], isFetching } = useQuery<AdvanceRequest[]>({ queryKey: ["advances"], queryFn: () => get("/advances") });

  // місяці — стандартні останні 6 + всі, що реально є в даних (старі запити не губляться)
  const months = useMemo(() => {
    const base = monthOptions();
    const seen = new Set(base.map(m => m.value));
    for (const r of data) {
      const v = r.createdAt.slice(0, 7);
      if (!seen.has(v)) {
        seen.add(v);
        base.push({ value: v, label: new Date(`${v}-01T00:00:00`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" }) });
      }
    }
    return base.sort((a, b) => b.value.localeCompare(a.value));
  }, [data]);
  const [month, setMonth] = useState(() => monthOptions()[0]!.value);

  const STATUS_LABEL: Record<string, string> = {
    pending: t("На розгляді"), approved: t("Затверджено"), rejected: t("Відхилено"), paid: t("Виплачено"),
  };
  const inv = () => qc.invalidateQueries({ queryKey: ["advances"] });
  const act = useMutation({
    mutationFn: (v: { id: number; action: "approve" | "reject" | "paid"; note?: string }) =>
      post(`/advances/${v.id}/${v.action}`, v.note != null ? { note: v.note } : undefined),
    onSuccess: (_d, v) => { inv(); toast.success(v.action === "approve" ? t("Затверджено") : v.action === "reject" ? t("Відхилено") : t("Позначено виплаченим")); },
    onError: (e: any) => toast.error(e.message),
  });
  const confirmReject = () => {
    if (!rejecting) return;
    act.mutate({ id: rejecting.id, action: "reject", note: reason.trim() });
    setRejecting(null); setReason("");
  };

  // запити на розгляді — завжди зверху, незалежно від вибраного місяця
  const pending = data.filter(r => r.status === "pending");
  const monthRows = useMemo(() => data.filter(r => r.createdAt.slice(0, 7) === month), [data, month]);
  const rows = useMemo(() => filter === "all" ? monthRows : monthRows.filter(r => r.status === filter), [monthRows, filter]);
  const totals = useMemo(() => {
    const sum = (s: string) => r2(monthRows.filter(r => r.status === s).reduce((a, r) => a + r.amount, 0));
    return { requested: sum("pending"), approved: sum("approved"), paid: sum("paid") };
  }, [monthRows]);

  // місто → фабрика → рядки (сортування: місто, фабрика, ім'я pl)
  const groups = useMemo(() => {
    const byCity = new Map<string, Map<string, AdvanceRequest[]>>();
    for (const r of rows) {
      const c = r.city || "—";
      const f = r.factory ?? t("Без фабрики");
      const m = byCity.get(c) ?? byCity.set(c, new Map()).get(c)!;
      (m.get(f) ?? m.set(f, []).get(f)!).push(r);
    }
    for (const m of byCity.values()) for (const list of m.values())
      list.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "pl") || a.createdAt.localeCompare(b.createdAt));
    return [...byCity.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, t]);

  const sumOf = (list: AdvanceRequest[]) => r2(list.reduce((a, r) => a + r.amount, 0));

  return (
    <>
      <PageHeader title={t("Аванси")} subtitle={t("Запити працівників на аванс — розгляд, затвердження, виплата")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        <Select value={filter} onChange={e => setFilter(e.target.value as any)} className="w-48">
          <option value="all">{t("Усі")}</option>
          <option value="pending">{t("На розгляді")}</option>
          <option value="approved">{t("Затверджено")}</option>
          <option value="paid">{t("Виплачено")}</option>
          <option value="rejected">{t("Відхилено")}</option>
        </Select>
        <div className="flex gap-2">
          <Badge color="amber">{t("На розгляді:")} {totals.requested} zł</Badge>
          <Badge color="blue">{t("Затверджено:")} {totals.approved} zł</Badge>
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

      {isFetching && !data.length ? <Spinner /> : !groups.length ? <Empty>{t("За цей місяць авансів немає")}</Empty> : (
        <div className="space-y-5">
          {groups.map(([city, byFactory]) => (
            <Card key={city} className="overflow-hidden">
              <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
                <Landmark className="h-4 w-4 text-slate-400" />
                <span className="text-sm font-bold tracking-tight text-slate-800">{t(city)}</span>
                <Badge color="slate">{[...byFactory.values()].reduce((a, rs) => a + rs.length, 0)}</Badge>
                <span className="ml-auto text-sm font-semibold tabular-nums text-slate-700">
                  {sumOf([...byFactory.values()].flat()).toFixed(2)} zł
                </span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-2">{t("Працівник")}</th><th className="px-4 py-2">{t("Дата")}</th>
                    <th className="px-4 py-2 text-right">{t("Сума")}</th><th className="px-4 py-2">{t("Коментар")}</th>
                    <th className="px-4 py-2">{t("Статус")}</th><th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[...byFactory.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([factory, list]) => [
                    <tr key={`f-${factory}`} className="bg-slate-50/80">
                      <td colSpan={2} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">{factory}</td>
                      <td className="px-4 py-1.5 text-right text-[11px] font-semibold tabular-nums text-slate-500">{sumOf(list).toFixed(2)} zł</td>
                      <td colSpan={3} />
                    </tr>,
                    ...list.map(r => (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2 pl-8 font-medium text-slate-700">{r.name ?? "—"}</td>
                        <td className="px-4 py-2 text-slate-500">
                          {fmtDate(r.createdAt)}
                          {r.status === "paid" && r.paidAt && r.paidAt.slice(0, 10) !== r.createdAt.slice(0, 10) && (
                            <div className="text-xs text-emerald-600">💸 {fmtDate(r.paidAt)}</div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-700">{r.amount} zł</td>
                        <td className="px-4 py-2 text-slate-600">
                          {r.comment || (!r.adminNote && <span className="text-slate-300">—</span>)}
                          {r.status === "rejected" && r.adminNote && <div className="mt-0.5 text-xs text-rose-600">⛔ {r.adminNote}</div>}
                        </td>
                        <td className="px-4 py-2"><Badge color={STATUS_COLOR[r.status]}>{STATUS_LABEL[r.status]}</Badge></td>
                        <td className="px-4 py-2 text-right">
                          {r.status === "approved" && (
                            <button onClick={() => act.mutate({ id: r.id, action: "paid" })} disabled={act.isPending} className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"><Banknote className="h-4 w-4" /> {t("Виплачено")}</button>
                          )}
                        </td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </Card>
          ))}
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
    </>
  );
}

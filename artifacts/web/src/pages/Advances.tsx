import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, Banknote } from "lucide-react";
import { toast } from "sonner";
import { get, post, type AdvanceRequest } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

const STATUS_COLOR: Record<string, "amber" | "blue" | "rose" | "green"> = {
  pending: "amber", approved: "blue", rejected: "rose", paid: "green",
};
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });

export default function Advances() {
  const t = useT();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected" | "paid">("all");
  const { data = [], isFetching } = useQuery<AdvanceRequest[]>({ queryKey: ["advances"], queryFn: () => get("/advances") });

  const STATUS_LABEL: Record<string, string> = {
    pending: t("На розгляді"), approved: t("Затверджено"), rejected: t("Відхилено"), paid: t("Виплачено"),
  };
  const inv = () => qc.invalidateQueries({ queryKey: ["advances"] });
  const act = useMutation({
    mutationFn: (v: { id: number; action: "approve" | "reject" | "paid" }) => post(`/advances/${v.id}/${v.action}`),
    onSuccess: (_d, v) => { inv(); toast.success(v.action === "approve" ? t("Затверджено") : v.action === "reject" ? t("Відхилено") : t("Позначено виплаченим")); },
    onError: (e: any) => toast.error(e.message),
  });

  const pending = data.filter(r => r.status === "pending");
  const rows = useMemo(() => filter === "all" ? data : data.filter(r => r.status === filter), [data, filter]);
  const totals = useMemo(() => {
    const sum = (s: string) => data.filter(r => r.status === s).reduce((a, r) => a + r.amount, 0);
    return { requested: sum("pending"), approved: sum("approved"), paid: sum("paid") };
  }, [data]);

  return (
    <>
      <PageHeader title={t("Аванси")} subtitle={t("Запити працівників на аванс — розгляд, затвердження, виплата")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
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
                  <button onClick={() => act.mutate({ id: r.id, action: "reject" })} disabled={act.isPending} className="flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"><X className="h-4 w-4" /> {t("Відхилити")}</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {isFetching && !data.length ? <Spinner /> : !rows.length ? <Empty>{t("Немає запитів на аванс")}</Empty> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2.5">{t("Дата")}</th><th className="px-4 py-2.5">{t("Працівник")}</th>
                <th className="px-4 py-2.5">{t("Фабрика")}</th><th className="px-4 py-2.5 text-right">{t("Сума")}</th>
                <th className="px-4 py-2.5">{t("Коментар")}</th><th className="px-4 py-2.5">{t("Статус")}</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-500">{fmtDate(r.createdAt)}</td>
                  <td className="px-4 py-2.5 font-medium text-slate-700">{r.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-500">{r.factory ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-slate-700">{r.amount} zł</td>
                  <td className="px-4 py-2.5 text-slate-600">{r.comment || <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5"><Badge color={STATUS_COLOR[r.status]}>{STATUS_LABEL[r.status]}</Badge></td>
                  <td className="px-4 py-2.5 text-right">
                    {r.status === "approved" && (
                      <button onClick={() => act.mutate({ id: r.id, action: "paid" })} disabled={act.isPending} className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"><Banknote className="h-4 w-4" /> {t("Виплачено")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

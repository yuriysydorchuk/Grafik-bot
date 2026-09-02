// «Документи й підписання» (/contracts, cap `workerDocs`) — інбокс умов
// (§10/§12 Етап 4 плану worker-docs-signing). Генерація й анкета — на
// сторінці профілю працівника (WorkerDetail.tsx); тут — загальний огляд і
// затвердження. Онлайн-підписання (send/sign) — наступний етап.
import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileSignature, Ban } from "lucide-react";
import { toast } from "sonner";
import { get, post } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";

type ContractRow = {
  id: number; workerId: number; factoryId: number | null; status: string;
  dateFrom: string | null; dateTo: string | null; generatedAt: string | null;
  approvedAt: string | null; sentAt: string | null; signedAt: string | null;
  workerName: string | null; factoryName: string | null;
};

const CONTRACT_STATUS: Record<string, { label: string; color: "slate" | "blue" | "green" | "amber" | "rose" }> = {
  draft: { label: "чернетка", color: "slate" },
  pending_approval: { label: "на розгляді", color: "amber" },
  approved: { label: "затверджено", color: "blue" },
  sent: { label: "надіслано", color: "blue" },
  viewed: { label: "переглянуто", color: "blue" },
  signed: { label: "підписано", color: "green" },
  declined: { label: "відхилено", color: "rose" },
  cancelled: { label: "скасовано", color: "slate" },
  superseded: { label: "замінено", color: "slate" },
  expired: { label: "прострочено", color: "rose" },
};
const STATUS_OPTIONS = ["pending_approval", "draft", "approved", "sent", "signed", ""] as const;

export default function Contracts() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [status, setStatus] = useState<string>("pending_approval");
  const { data: rows = [], isLoading } = useQuery<ContractRow[]>({
    queryKey: ["contracts", status], queryFn: () => get(`/contracts${status ? `?status=${status}` : ""}`),
  });
  const inv = () => qc.invalidateQueries({ queryKey: ["contracts"] });
  const approve = useMutation({ mutationFn: (id: number) => post(`/contracts/${id}/approve`), onSuccess: () => { inv(); toast.success(t("Затверджено")); }, onError: (e: any) => toast.error(e.message) });
  const cancel = useMutation({ mutationFn: (id: number) => post(`/contracts/${id}/cancel`), onSuccess: () => { inv(); toast.success(t("Скасовано")); }, onError: (e: any) => toast.error(e.message) });
  const send = useMutation({
    mutationFn: (id: number) => post<{ notified: boolean; link: string | null }>(`/contracts/${id}/send`),
    onSuccess: r => { inv(); toast.success(r.notified ? t("Надіслано працівнику в Telegram") : t("Токен створено, але Telegram не надіслано — скопіюй лінк вручну")); if (r.link && !r.notified) navigator.clipboard?.writeText(r.link).catch(() => {}); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader title={t("Документи й умови")} subtitle={t("Умови на затвердженні та історія генерації — у розробці")} />
      <Card className="mb-4 flex items-center gap-2 px-4 py-2.5">
        <Label>{t("Статус")}</Label>
        <Select value={status} onChange={e => setStatus(e.target.value)} className="w-56">
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s ? t(CONTRACT_STATUS[s]?.label ?? s) : t("усі")}</option>)}
        </Select>
      </Card>
      <Card className="overflow-hidden">
        {isLoading ? <Spinner /> : rows.length ? (
          <div>
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2 text-sm">
              <FileSignature className="h-4 w-4 text-slate-400" />
              <h3 className="text-sm font-semibold text-slate-700">{t("Умови")}</h3>
            </div>
            {rows.map(c => {
              const st = CONTRACT_STATUS[c.status] ?? CONTRACT_STATUS.draft!;
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-2 border-b border-slate-50 px-4 py-2.5 text-sm last:border-0">
                  <Link href={`/workers/${c.workerId}`} className="font-medium text-slate-700 hover:text-red-600 hover:underline">{c.workerName ?? `#${c.workerId}`}</Link>
                  {c.factoryName && <span className="text-slate-400">· {c.factoryName}</span>}
                  <Badge color={st.color}>{t(st.label)}</Badge>
                  <span className="text-slate-500">{c.dateFrom ?? "—"}{c.dateTo ? ` → ${c.dateTo}` : ""}</span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {(c.status === "draft" || c.status === "pending_approval") && (
                      <button onClick={() => approve.mutate(c.id)} disabled={approve.isPending} className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">{t("Затвердити")}</button>
                    )}
                    {c.status === "approved" && (
                      <button onClick={() => send.mutate(c.id)} disabled={send.isPending} className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">{t("Надіслати на підпис")}</button>
                    )}
                    {!["signed", "cancelled", "superseded", "expired", "declined"].includes(c.status) && (
                      <button onClick={async () => { if (await confirm({ title: t("Скасувати умову?"), danger: true, confirmText: t("Скасувати") })) cancel.mutate(c.id); }}
                        className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Скасувати")}><Ban className="h-3.5 w-3.5" /></button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : <Empty>{t("Немає умов з цим статусом.")}</Empty>}
      </Card>
    </div>
  );
}

// «Обʼєднати з дублем» (22.10.2026): пошук другого профілю (GET /search), вибір, який
// лишається, превʼю (GET /workers/:keep/merge-preview — що переїде, що задвоїться/загубиться)
// і підтвердження (POST /workers/:keep/merge). Дубль видаляється, усе переїжджає в той, що
// лишається; подія — у його «Історії змін». Бекенд — services/workerMerge.ts.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { AlertTriangle, GitMerge } from "lucide-react";
import { get, post } from "../lib/api";
import { Button, Modal, Input, Spinner } from "./ui";
import { useT } from "../lib/i18n";

type Hit = { kind: string; id: number; title: string; subtitle: string | null; inactive?: boolean };
type Side = { id: number; fullName: string; workerCode: string | null; isActive: boolean; telegramId: string | null; factoryName: string | null; createdAt: string };
type Preview = { keep: Side; drop: Side; moves: { label: string; count: number }[]; warnings: string[] };

export function MergeWorkerModal({ worker, onClose }: { worker: { id: number; fullName: string }; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  // підставляємо прізвище — дубль зазвичай з тим самим прізвищем (інше написання імені/порядок)
  const [q, setQ] = useState(worker.fullName.split(/\s+/)[0] ?? "");
  const [other, setOther] = useState<Hit | null>(null);
  const [keepThis, setKeepThis] = useState(true);
  const { data: found, isFetching } = useQuery({
    queryKey: ["merge-search", q],
    queryFn: () => get<{ hits: Hit[] }>(`/search?q=${encodeURIComponent(q.trim())}`),
    enabled: !other && q.trim().length >= 2,
  });
  const hits = (found?.hits ?? []).filter(h => h.kind === "worker" && h.id !== worker.id);
  const keepId = other ? (keepThis ? worker.id : other.id) : null;
  const dropId = other ? (keepThis ? other.id : worker.id) : null;
  const { data: preview, isLoading: previewLoading, error: previewError } = useQuery({
    queryKey: ["merge-preview", keepId, dropId],
    queryFn: () => get<Preview>(`/workers/${keepId}/merge-preview?dropId=${dropId}`),
    enabled: keepId != null && dropId != null,
  });
  const merge = useMutation({
    mutationFn: () => post(`/workers/${keepId}/merge`, { dropId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workers"] });
      qc.invalidateQueries({ queryKey: ["worker"] });
      qc.invalidateQueries({ queryKey: ["worker-changes"] });
      toast.success(t("Профілі обʼєднано"));
      onClose();
      if (keepId !== worker.id) navigate(`/workers/${keepId}`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const sideCard = (s: Side | undefined, label: string, keep: boolean) => (
    <div className={`flex-1 rounded-lg border p-3 text-sm ${keep ? "border-emerald-300 bg-emerald-50/60" : "border-rose-200 bg-rose-50/50"}`}>
      <div className={`mb-1 text-xs font-semibold uppercase tracking-wide ${keep ? "text-emerald-700" : "text-rose-600"}`}>{label}</div>
      {s ? (
        <>
          <div className="font-medium text-slate-800">{s.fullName}</div>
          <div className="text-xs text-slate-500">{[s.workerCode, s.factoryName].filter(Boolean).join(" · ") || "—"}</div>
          <div className="mt-1 text-xs text-slate-500">
            {s.isActive ? t("активний") : t("звільнений")} · Telegram: {s.telegramId ?? "—"} · {t("додано")} {s.createdAt}
          </div>
        </>
      ) : <Spinner />}
    </div>
  );

  return (
    <Modal open onClose={onClose} title={t("Обʼєднати з дублем")} size="lg">
      {!other ? (
        <>
          <p className="mb-2 text-sm text-slate-500">{t("Знайдіть другий профіль цієї ж людини (імʼя, код, PESEL).")}</p>
          <Input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t("Пошук працівника…")} />
          <div className="mt-2 max-h-[50vh] divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {isFetching && !hits.length ? <div className="p-3"><Spinner /></div>
              : !hits.length ? <div className="p-3 text-sm text-slate-400">{q.trim().length < 2 ? t("Введіть щонайменше 2 символи") : t("Нічого не знайдено")}</div>
              : hits.map(h => (
                <button key={h.id} type="button" onClick={() => setOther(h)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50">
                  <span className={`flex-1 ${h.inactive ? "text-slate-400" : "text-slate-700"}`}>{h.title}</span>
                  {h.subtitle && <span className="text-xs text-slate-400">{h.subtitle}</span>}
                  {h.inactive && <span className="text-xs text-slate-400">{t("звільнений")}</span>}
                </button>
              ))}
          </div>
        </>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-500">{t("Який профіль лишається?")}</span>
            <label className="inline-flex items-center gap-1.5"><input type="radio" checked={keepThis} onChange={() => setKeepThis(true)} /> {worker.fullName} <span className="text-slate-400">#{worker.id}</span></label>
            <label className="inline-flex items-center gap-1.5"><input type="radio" checked={!keepThis} onChange={() => setKeepThis(false)} /> {other.title} <span className="text-slate-400">#{other.id}</span></label>
            <button type="button" onClick={() => { setOther(null); setKeepThis(true); }} className="ml-auto text-xs text-slate-400 hover:text-red-600">{t("обрати інший профіль")}</button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {sideCard(preview?.keep, t("Лишається"), true)}
            {sideCard(preview?.drop, t("Буде видалено (дубль)"), false)}
          </div>
          {previewLoading ? <div className="mt-3"><Spinner /></div> : previewError ? (
            <div className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{(previewError as Error).message}</div>
          ) : preview && (
            <>
              <div className="mt-3 text-sm text-slate-600">
                <span className="font-medium">{t("З дубля переїде")}:</span>{" "}
                {preview.moves.length ? preview.moves.map(m => `${t(m.label)} ${m.count}`).join(" · ") : t("записів немає")}
                <div className="mt-1 text-xs text-slate-400">{t("Порожні поля профілю, що лишається, доповняться з дубля; подія буде в «Історії змін».")}</div>
              </div>
              {preview.warnings.length > 0 && (
                <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                  {preview.warnings.map(w => <li key={w} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}</li>)}
                </ul>
              )}
            </>
          )}
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
            <Button variant="danger" disabled={!preview} loading={merge.isPending} onClick={() => merge.mutate()}>
              <GitMerge className="h-4 w-4" /> {t("Обʼєднати — дубль буде видалено")}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

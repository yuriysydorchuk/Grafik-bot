// /feedback — зголошення з панелі (лише головний адмін): дошка/список з фільтрами, картка
// (опис, вкладення, крихти, контекст, коментарі, дії), «Пакет для Claude» (ZIP) та
// «Імпорт результату» тріажу (docs/tasks/2026-10-29-feedback-module.md).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Package, Upload, Copy, ListTodo, ThumbsUp, Paperclip, MessageSquare, CircleDot, ExternalLink, LayoutGrid, List } from "lucide-react";
import { get, patch, post, upload } from "../lib/api";
import { Card, Spinner, Badge, Button, Modal, Textarea, Select, Empty, cn } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { ZoomImage } from "../components/ZoomImage";
import { SearchBox } from "../components/SearchBox";
import { useT, type TFn } from "../lib/i18n";
import { useSessionState } from "../lib/nav";
import { useConfirm } from "../components/confirm";
import {
  KIND_LABEL, KIND_ICON, SEVERITY_LABEL, STATUS_LABEL, STATUS_BADGE, TONE_BORDER, toneOf, fmtDT, reportMarkdown,
  type ListRow, type Facets, type ReportCard, type Counters, type FeedbackStatus, type FeedbackSeverity, type FeedbackKind,
} from "../lib/feedbackApi";

// drop — статус, який отримує картка, перетягнута в колонку
const COLS: { key: string; label: string; statuses: FeedbackStatus[]; drop: FeedbackStatus }[] = [
  { key: "new", label: "Нові", statuses: ["new"], drop: "new" },
  { key: "review", label: "На розгляді", statuses: ["review", "clarify"], drop: "review" },
  { key: "work", label: "У плані / в роботі", statuses: ["planned", "in_progress"], drop: "planned" },
  { key: "fixed", label: "Виправлено · чекає підтвердження", statuses: ["fixed"], drop: "fixed" },
];
const STATUS_FILTERS: { v: string; label: string }[] = [
  { v: "open", label: "відкриті" }, { v: "new", label: "нові" }, { v: "review,clarify", label: "на розгляді" }, { v: "planned,in_progress", label: "у плані / в роботі" },
  { v: "fixed", label: "виправлено" }, { v: "confirmed", label: "підтверджено" }, { v: "rejected,duplicate,exists", label: "відхилено / дубль / уже є" }, { v: "all", label: "усі" },
];

export default function Feedback() {
  const t = useT();
  const qc = useQueryClient();
  const [loc, navigate] = useLocation();
  const [status, setStatus] = useSessionState("fb.status", "open");
  const [kind, setKind] = useSessionState("fb.kind", "");
  const [page, setPage] = useSessionState("fb.page", "");
  const [author, setAuthor] = useSessionState("fb.author", "");
  const [build, setBuild] = useSessionState("fb.build", "");
  const [q, setQ] = useSessionState("fb.q", "");
  const [view, setView] = useSessionState<"board" | "list">("fb.view", "board");
  const [openId, setOpenId] = useState<number | null>(() => Number(new URLSearchParams(window.location.search).get("id")) || null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const qs = useMemo(() => { const p = new URLSearchParams(); p.set("status", status); if (kind) p.set("kind", kind); if (page) p.set("page", page); if (author) p.set("author", author); if (build) p.set("build", build); if (q.trim()) p.set("q", q.trim()); return p.toString(); }, [status, kind, page, author, build, q]);
  const { data, isLoading } = useQuery<{ rows: ListRow[]; facets: Facets }>({ queryKey: ["feedback-list", qs], queryFn: () => get(`/feedback/admin/list?${qs}`), refetchInterval: 60_000 });
  const { data: counters } = useQuery<Counters>({ queryKey: ["feedback-counters"], queryFn: () => get("/feedback/admin/counters"), refetchInterval: 60_000 });
  const inv = () => { qc.invalidateQueries({ queryKey: ["feedback-list"] }); qc.invalidateQueries({ queryKey: ["feedback-counters"] }); qc.invalidateQueries({ queryKey: ["feedback-card"] }); };
  const imp = useMutation({
    mutationFn: (f: File) => { const fd = new FormData(); fd.append("file", f); return upload<{ applied: number[]; skipped: { id: number; reason: string }[] }>("/feedback/admin/import", fd); },
    onSuccess: r => { inv(); toast.success(t("Імпортовано: {a}, пропущено: {s}", { a: r.applied.length, s: r.skipped.length })); if (r.skipped.length) toast.info(r.skipped.map(s => `#${s.id}: ${s.reason}`).join("\n")); },
    onError: (e: any) => toast.error(e.message),
  });
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get("id")); if (id && id !== openId) setOpenId(id); }, [loc]); // eslint-disable-line react-hooks/exhaustive-deps
  // перетягування картки між колонками дошки → статус
  const move = useMutation({ mutationFn: (v: { id: number; status: FeedbackStatus }) => patch(`/feedback/admin/${v.id}`, { status: v.status }), onSuccess: () => { inv(); toast.success(t("Статус змінено")); }, onError: (e: any) => toast.error(e.message) });
  const onDrop = (col: typeof COLS[number]) => (e: React.DragEvent) => {
    e.preventDefault(); setOverCol(null);
    const id = Number(e.dataTransfer.getData("text/feedback-id")); const r = rows.find(x => x.id === id);
    if (!id || !r || col.statuses.includes(r.status)) return;
    move.mutate({ id, status: col.drop });
  };
  // перед пакетом — попередження про незамазані скріншоти з фінансових сторінок
  const downloadPack = async () => {
    try {
      const { warnings } = await get<{ warnings: { id: number; page: string; attachments: number }[] }>(`/feedback/admin/pack-check?${qs}`);
      if (warnings.length) {
        const ok = await confirm({ title: t("Незамазані скріншоти з фінансових сторінок"), message: `${warnings.map(w => `#${w.id} · ${t(w.page)} · ${w.attachments}`).join(", ")}. ${t("Пакет піде в Claude разом із ними. Продовжити?")}`, confirmText: t("Скачати все одно"), danger: true });
        if (!ok) return;
      }
      window.location.href = `/api/feedback/admin/pack.zip?${qs}`;
    } catch (e: any) { toast.error(e.message); }
  };

  const rows = data?.rows ?? [];
  const chip = (n: number | undefined, label: string, cls: string) => (n ? <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", cls)}>{n} {label}</span> : null);

  return (
    <>
      <PageHeader title={t("Зголошення")} subtitle={t("Проблеми й побажання користувачів панелі. Розбір — сесією Claude (/feedback-triage), результат імпортується сюди.")}
        action={<div className="flex flex-wrap items-center gap-2">
          {chip(counters?.new, t("нових"), "bg-red-100 text-red-700")}{chip(counters?.blocks, t("блокує"), "bg-rose-100 text-rose-700")}{chip(counters?.stale, t("без відповіді >7 дн"), "bg-amber-100 text-amber-700")}{chip(counters?.awaiting, t("чекають підтвердження"), "bg-sky-100 text-sky-700")}
          <Button variant="secondary" onClick={downloadPack}><Package className="h-4 w-4" />{t("Пакет для Claude")}</Button>
          <Button variant="secondary" loading={imp.isPending} onClick={() => importRef.current?.click()}><Upload className="h-4 w-4" />{t("Імпорт результату")}</Button>
          <input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) imp.mutate(f); e.target.value = ""; }} />
        </div>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={status} onChange={e => setStatus(e.target.value)} className="w-auto">{STATUS_FILTERS.map(s => <option key={s.v} value={s.v}>{t("Статус")}: {t(s.label)}</option>)}</Select>
        <Select value={kind} onChange={e => setKind(e.target.value)} className="w-auto"><option value="">{t("Тип")}: {t("усі")}</option>{(["bug", "wish", "question"] as FeedbackKind[]).map(k => <option key={k} value={k}>{KIND_ICON[k]} {t(KIND_LABEL[k])}</option>)}</Select>
        <Select value={page} onChange={e => setPage(e.target.value)} className="w-auto"><option value="">{t("Сторінка")}: {t("усі")}</option>{data?.facets.pages.map(p => <option key={p.path} value={p.path}>{t(p.label ?? p.path)} ({p.n})</option>)}</Select>
        <Select value={author} onChange={e => setAuthor(e.target.value)} className="w-auto"><option value="">{t("Автор")}: {t("усі")}</option>{data?.facets.authors.map(a => <option key={a.id} value={a.id}>{a.name} ({a.n})</option>)}</Select>
        <Select value={build} onChange={e => setBuild(e.target.value)} className="w-auto"><option value="">{t("Збірка")}: {t("усі")}</option>{data?.facets.builds.map(b => <option key={b.build} value={b.build}>{b.build} ({b.n})</option>)}</Select>
        <div className="min-w-48 flex-1"><SearchBox value={q} onChange={setQ} placeholder={t("Пошук за текстом або №…")} /></div>
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          <button onClick={() => setView("board")} className={cn("rounded-md p-1.5", view === "board" ? "bg-red-600 text-white" : "text-slate-500 hover:bg-slate-50")} title={t("Дошка")}><LayoutGrid className="h-4 w-4" /></button>
          <button onClick={() => setView("list")} className={cn("rounded-md p-1.5", view === "list" ? "bg-red-600 text-white" : "text-slate-500 hover:bg-slate-50")} title={t("Список")}><List className="h-4 w-4" /></button>
        </div>
      </div>

      {isLoading ? <Spinner /> : !rows.length ? <Card><Empty>{t("Зголошень за цими фільтрами немає")}</Empty></Card> : view === "board" && status === "open" ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {COLS.map(c => { const items = rows.filter(r => c.statuses.includes(r.status)); return (
            <div key={c.key} onDragOver={e => { e.preventDefault(); if (overCol !== c.key) setOverCol(c.key); }} onDragLeave={() => setOverCol(null)} onDrop={onDrop(c)}
              className={cn("min-h-40 rounded-xl bg-slate-100/70 p-2 transition", overCol === c.key && "bg-red-50 ring-2 ring-red-300")}>
              <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t(c.label)} · {items.length}</div>
              <div className="space-y-2">{items.map(r => <RowCard key={r.id} r={r} t={t} onOpen={() => setOpenId(r.id)} />)}</div>
            </div>); })}
        </div>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-3 py-2.5">#</th><th className="px-3 py-2.5">{t("Зголошення")}</th><th className="px-3 py-2.5">{t("Сторінка")}</th><th className="px-3 py-2.5">{t("Автор")}</th><th className="px-3 py-2.5">{t("Статус")}</th><th className="px-3 py-2.5">{t("Збірка")}</th><th className="px-3 py-2.5">{t("Створено")}</th><th className="px-3 py-2.5"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenId(r.id)}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{r.id}</td>
                  <td className="px-3 py-2"><span className="mr-1">{KIND_ICON[r.kind]}</span>{r.title}{r.severity && <span className="ml-2 text-xs text-slate-400">{t(SEVERITY_LABEL[r.severity])}</span>}</td>
                  <td className="px-3 py-2 text-slate-500">{r.pageLabel ? t(r.pageLabel) : r.pagePath ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{r.authorName}</td>
                  <td className="px-3 py-2"><Badge color={STATUS_BADGE[r.status]}>{t(STATUS_LABEL[r.status])}</Badge></td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{r.buildVersion?.split(" ")[0] ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500 tabular-nums">{fmtDT(r.createdAt)}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{r.votes ? `👍 ${r.votes} ` : ""}{r.attachments ? `📎${r.attachments} ` : ""}{r.comments ? `💬${r.comments}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {openId != null && <ReportModal id={openId} onClose={() => { setOpenId(null); if (new URLSearchParams(window.location.search).get("id")) navigate("/feedback", { replace: true }); }} onChanged={inv} t={t} />}
    </>
  );
}

function RowCard({ r, t, onOpen }: { r: ListRow; t: TFn; onOpen: () => void }) {
  return (
    <button onClick={onOpen} draggable onDragStart={e => { e.dataTransfer.setData("text/feedback-id", String(r.id)); e.dataTransfer.effectAllowed = "move"; }}
      className={cn("w-full cursor-grab rounded-lg border border-slate-200 border-l-[3px] bg-white px-2.5 py-2 text-left text-xs shadow-sm hover:bg-slate-50 active:cursor-grabbing", TONE_BORDER[toneOf(r.kind, r.severity)])}>
      <div className="flex items-start gap-1.5"><span className="font-semibold text-slate-700">#{r.id}</span><span className="min-w-0 flex-1 font-medium text-slate-800">{r.title}</span></div>
      <div className="mt-1 text-slate-400">{r.pageLabel ? t(r.pageLabel) : r.pagePath ?? t("загальне")} · {r.authorName} · {fmtDT(r.createdAt)}{r.origin !== "widget" && " · ⚡"}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {r.kind === "bug" && r.severity ? <Badge color={r.severity === "blocks" ? "rose" : r.severity === "hinders" ? "amber" : "blue"}>{t(SEVERITY_LABEL[r.severity])}</Badge> : <Badge color="slate">{t(KIND_LABEL[r.kind])}</Badge>}
        {(r.status === "clarify" || r.status === "in_progress" || r.status === "planned") && <Badge color={STATUS_BADGE[r.status]}>{t(STATUS_LABEL[r.status])}</Badge>}
        <span className="ml-auto flex items-center gap-1.5 text-slate-400">{r.votes > 0 && <span><ThumbsUp className="inline h-3 w-3" /> {r.votes}</span>}{r.attachments > 0 && <Paperclip className="h-3 w-3" />}{r.recorded && <CircleDot className="h-3 w-3 text-rose-500" />}{r.comments > 0 && <span><MessageSquare className="inline h-3 w-3" /> {r.comments}</span>}{r.taskId && <ListTodo className="h-3 w-3" />}</span>
      </div>
    </button>
  );
}

function ReportModal({ id, onClose, onChanged, t }: { id: number; onClose: () => void; onChanged: () => void; t: TFn }) {
  const { data: r, isLoading, refetch } = useQuery<ReportCard>({ queryKey: ["feedback-card", id], queryFn: () => get(`/feedback/${id}`) });
  const [reply, setReply] = useState("");
  const [dup, setDup] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
  const done = () => { refetch(); onChanged(); };
  const act = useMutation({ mutationFn: (body: Record<string, unknown>) => patch(`/feedback/admin/${id}`, body), onSuccess: () => { done(); setReply(""); toast.success(t("Збережено")); }, onError: (e: any) => toast.error(e.message) });
  const ask = useMutation({ mutationFn: (kind: "answer" | "question") => post(`/feedback/${id}/comments`, { body: reply, kind }), onSuccess: () => { done(); setReply(""); toast.success(t("Надіслано автору")); }, onError: (e: any) => toast.error(e.message) });
  const task = useMutation({ mutationFn: () => post<{ taskId: number }>(`/feedback/admin/${id}/task`), onSuccess: r => { done(); toast.success(t("Задача #{n} створена", { n: r.taskId })); }, onError: (e: any) => toast.error(e.message) });
  const copy = async () => { if (!r) return; try { await navigator.clipboard.writeText(reportMarkdown(r)); toast.success(t("Скопійовано")); } catch { toast.error(t("Не вдалося скопіювати")); } };
  const setStatus = (status: FeedbackStatus) => {
    if (status === "duplicate") { const n = Number(dup); if (!n) { toast.error(t("Вкажіть № оригіналу")); return; } act.mutate({ status, duplicateOfId: n, reply: reply.trim() || undefined }); return; }
    act.mutate({ status, reply: reply.trim() || undefined });
  };
  const c = r?.context ?? {};
  return (
    <Modal open onClose={onClose} title={r ? `#${r.id} · ${r.title}` : `#${id}`} size="xl">
      {isLoading || !r ? <Spinner /> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge color={STATUS_BADGE[r.status]}>{t(STATUS_LABEL[r.status])}</Badge>
            <span className="text-xs text-slate-500">{KIND_ICON[r.kind]} {t(KIND_LABEL[r.kind])}{r.severity ? ` · ${t(SEVERITY_LABEL[r.severity])}` : ""}</span>
            {r.kind === "bug" && <Select value={r.severity ?? ""} onChange={e => act.mutate({ severity: e.target.value || null })} className="w-auto py-1 text-xs">{(["blocks", "hinders", "minor"] as FeedbackSeverity[]).map(s => <option key={s} value={s}>{t(SEVERITY_LABEL[s])}</option>)}</Select>}
            <span className="ml-auto flex flex-wrap gap-1.5">
              {(r.status === "new" || r.status === "clarify") && <Button className="px-2.5 py-1 text-xs" onClick={() => setStatus("review")}>✔ {t("Прийняти")}</Button>}
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => task.mutate()} disabled={!!r.taskId}><ListTodo className="h-3.5 w-3.5" />{r.taskId ? `${t("Задача")} #${r.taskId}` : t("Зробити задачею")}</Button>
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={copy}><Copy className="h-3.5 w-3.5" />{t("Копіювати для Claude")}</Button>
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_280px]">
            <div className="min-w-0 space-y-3">
              <Card className="p-4 text-sm">
                {r.clientError && <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 p-2 font-mono text-[11px] text-rose-700">⚡ {r.clientError.message}{r.clientError.source ? ` — ${r.clientError.source}` : ""}{r.clientError.stack && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-rose-600/80">{r.clientError.stack}</pre>}</div>}
                {r.steps && <p className="mb-2"><span className="text-xs font-semibold uppercase text-slate-400">{t("Що робили")}: </span>{r.steps}</p>}
                <p className="whitespace-pre-wrap"><span className="text-xs font-semibold uppercase text-slate-400">{r.kind === "bug" ? t("Що сталось") : r.kind === "wish" ? t("Побажання") : t("Запитання")}: </span>{r.description}</p>
                {r.expected && <p className="mt-2"><span className="text-xs font-semibold uppercase text-slate-400">{t("Очікували")}: </span>{r.expected}</p>}
              </Card>
              {r.attachments.length > 0 && (
                <Card className="p-4">
                  <div className="mb-2 text-xs font-semibold uppercase text-slate-400">{t("Вкладення")}</div>
                  <div className="flex flex-wrap gap-2">
                    {r.attachments.map(a => (
                      <div key={a.id} className="w-44 text-[11px] text-slate-600">
                        {a.mime.startsWith("image/") ? <img src={a.url} alt={a.name} onClick={() => setZoom(a.url)} className="h-28 w-44 cursor-zoom-in rounded-lg border border-slate-200 object-cover object-top" /> : <a href={a.url} target="_blank" rel="noreferrer" className="flex h-28 w-44 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500"><ExternalLink className="mr-1 h-4 w-4" />PDF</a>}
                        <div className="mt-1 truncate">{a.kind === "screenshot" ? "📸" : a.kind === "pin" ? "👆" : "📎"} {a.kind === "pin" && a.meta ? <span className="font-mono">{String((a.meta as any).tag)} «{String((a.meta as any).text ?? "").slice(0, 30)}»</span> : a.name}</div>
                        {a.kind === "pin" && a.meta && <div className="truncate font-mono text-[10px] text-slate-400" title={String((a.meta as any).selector)}>{String((a.meta as any).selector)}</div>}
                      </div>
                    ))}
                  </div>
                </Card>
              )}
              {r.breadcrumbs.length > 0 && (
                <Card className="p-4">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-slate-400">{t("Крихти")} ({r.breadcrumbs.length}){r.recorded && <Badge color="rose">⏺ {t("запис")}</Badge>}</div>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-slate-50 p-2 font-mono text-[11px] leading-relaxed text-slate-700">
                    {r.breadcrumbs.map((b, i) => { const bad = (b.status ?? 0) >= 400 || b.type === "error" || b.type === "console"; return <div key={i} className={cn(bad && "text-rose-600")}><span className="text-slate-400">{b.t.slice(11, 19)}</span>  {b.type.padEnd(7)} {b.text}{b.status != null ? `  ${b.status}` : ""}{b.ms != null ? `  ${b.ms}ms` : ""}{b.reqId ? <button onClick={() => navigator.clipboard.writeText(b.reqId!).then(() => toast.success("req.id " + t("скопійовано")))} className="ml-2 rounded bg-white px-1 ring-1 ring-slate-200 hover:bg-slate-100" title={t("копіювати req.id")}>req {b.reqId}</button> : null}</div>; })}
                  </pre>
                </Card>
              )}
              <Card className="p-4">
                <div className="mb-2 text-xs font-semibold uppercase text-slate-400">{t("Коментарі")}</div>
                <div className="space-y-1.5">
                  {r.comments.filter(cm => cm.kind !== "system").length === 0 && <div className="text-xs text-slate-400">{t("Поки без коментарів")}</div>}
                  {r.comments.filter(cm => cm.kind !== "system").map(cm => (
                    <div key={cm.id} className={cn("border-l-2 px-2.5 py-1 text-sm", cm.kind === "system" ? "border-slate-200 text-[11px] text-slate-400" : cm.kind === "answer" || cm.kind === "question" ? "border-red-400" : "border-sky-300")}>
                      {cm.kind !== "system" && <div className="text-[11px] text-slate-400"><b className="text-slate-600">{cm.adminName ?? t("система")}</b> · {fmtDT(cm.createdAt)} · {cm.via === "bot" ? "Telegram" : cm.via === "triage" ? t("тріаж") : t("панель")}{cm.kind === "question" && " · ❔"}</div>}
                      <div className={cn(cm.kind === "system" ? "" : "whitespace-pre-wrap text-slate-800")}>{cm.body}</div>
                    </div>
                  ))}
                </div>
                <Textarea value={reply} onChange={e => setReply(e.target.value)} rows={2} className="mt-2" placeholder={t("Написати автору… (піде в бот)")} />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button className="px-2.5 py-1 text-xs" disabled={!reply.trim()} loading={ask.isPending} onClick={() => ask.mutate("answer")}>💬 {t("Відповісти")}</Button>
                  <Button variant="secondary" className="px-2.5 py-1 text-xs" disabled={!reply.trim()} loading={ask.isPending} onClick={() => ask.mutate("question")}>❔ {t("Уточнити")}</Button>
                  <span className="mx-1 self-center text-xs text-slate-300">|</span>
                  <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setStatus("planned")}>{t("У план")}</Button>
                  <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setStatus("in_progress")}>{t("В роботу")}</Button>
                  <Button variant="success" className="px-2.5 py-1 text-xs" onClick={() => setStatus("fixed")}>{t("Виправлено")}</Button>
                  <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setStatus("exists")}>{t("Уже є")}</Button>
                  <Button variant="danger" className="px-2.5 py-1 text-xs" onClick={() => setStatus("rejected")}>✖ {t("Відхилити")}</Button>
                  <span className="inline-flex items-center gap-1"><input value={dup} onChange={e => setDup(e.target.value)} placeholder="№" className="w-14 rounded-md border border-slate-200 px-1.5 py-1 text-xs" /><Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setStatus("duplicate")}>⧉ {t("Дубль")}</Button></span>
                </div>
                <div className="mt-1 text-[11px] text-slate-400">{t("Текст у полі вище піде автору разом зі зміною статусу.")}</div>
              </Card>
            </div>

            <div className="space-y-3">
              <Card className="p-4 text-xs">
                <div className="mb-2 font-semibold uppercase text-slate-400">{t("Контекст")}</div>
                <KV k={t("Автор")} v={`${r.authorName} · ${c.roleLabel ?? ""}`} />
                {c.scope && <KV k={t("Скоуп")} v={[...(c.scope.cities ?? []), ...(c.scope.factoryIds?.length ? [`${c.scope.factoryIds.length} ${t("фабрик")}`] : [])].join(", ") || "—"} />}
                <KV k={t("Сторінка")} v={r.aboutPage ? `${r.pageLabel ? t(r.pageLabel) : ""} ${r.pagePath ?? ""}`.trim() : r.pagePath ? `${t("інша")}: ${r.pageLabel ?? r.pagePath}` : t("загальне")} />
                {r.pageUrl && <KV k="URL" v={<a href={r.pageUrl} target="_blank" rel="noreferrer" className="break-all text-sky-700 hover:underline">{r.pageUrl.replace(/^https?:\/\/[^/]+/, "")}</a>} />}
                {r.pageFilters && Object.keys(r.pageFilters).length > 0 && <KV k={t("Фільтри")} v={Object.entries(r.pageFilters).map(([k, v]) => k === "selects" ? Object.entries(v as Record<string, string>).map(([a, b]) => `${a}: ${b}`).join(" · ") : `${k}=${String(v)}`).join(" · ")} />}
                <KV k={t("Збірка")} v={<span className="font-mono">{r.buildVersion ?? "?"}</span>} />
                <KV k={t("Браузер")} v={`${(c.ua ?? "").split(" · ")[0]} · ${c.platform ?? ""} · ${c.screen ?? ""}`} />
                <KV k={t("Тема / мова")} v={`${c.theme ?? ""} · ${c.lang ?? ""}`} />
                {c.session && <KV k={t("Сесія")} v={c.session} />}
                {c.failedRequests && c.failedRequests.length > 0 && <KV k={t("Невдалі запити")} v={c.failedRequests.map(f => `${f.method} ${f.path} ${f.status}${f.reqId ? ` (${f.reqId})` : ""}`).join("; ")} />}
                <KV k={t("Голоси")} v={r.votes.length ? `👍 ${r.votes.length} (${r.votes.map(v => v.name).join(", ")})` : "—"} />
                {r.duplicateOfId && <KV k={t("Дубль")} v={`→ #${r.duplicateOfId}`} />}
                {r.taskId && <KV k={t("Задача")} v={<a href={`/tasks?task=${r.taskId}`} className="text-sky-700 hover:underline">#{r.taskId}</a>} />}
                {r.triage && <KV k={t("Тріаж")} v={Object.entries(r.triage).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")} />}
                {r.deployedCommit && <KV k={t("Деплой")} v={<span className="font-mono">{r.deployedCommit}</span>} />}
                <KV k={t("Створено")} v={fmtDT(r.createdAt)} />
                {r.statusChangedAt && <KV k={t("Статус змінено")} v={fmtDT(r.statusChangedAt)} />}
                {r.confirmRequestedAt && !r.confirmedAt && <KV k={t("Чекає підтвердження з")} v={fmtDT(r.confirmRequestedAt)} />}
              </Card>
              <Card className="p-4 text-xs">
                <div className="mb-2 font-semibold uppercase text-slate-400">{t("Журнал")}</div>
                <div className="space-y-1 text-[11px] text-slate-500">
                  {r.comments.filter(cm => cm.kind === "system").map(cm => <div key={cm.id}><span className="tabular-nums text-slate-400">{fmtDT(cm.createdAt)}</span> · {cm.body}{cm.adminName ? ` · ${cm.adminName}` : ""}{cm.via === "bot" ? " · Telegram" : cm.via === "triage" ? ` · ${t("тріаж")}` : ""}</div>)}
                </div>
              </Card>
              <Card className="p-3 text-[11px] text-slate-500"><b>{t("Закриється сама, коли")}</b> {t("після «виправлено» автор натисне «Працює» або промовчить потрібну кількість днів (Налаштування → Зголошення).")}</Card>
            </div>
          </div>
        </div>
      )}
      {zoom && <Modal open onClose={() => setZoom(null)} title={t("Скріншот")} size="2xl"><ZoomImage src={zoom} className="h-[75vh]" downloadUrl={zoom} /></Modal>}
    </Modal>
  );
}
function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3 border-b border-dashed border-slate-100 py-1"><span className="shrink-0 text-slate-400">{k}</span><span className="min-w-0 text-right text-slate-700">{v}</span></div>;
}

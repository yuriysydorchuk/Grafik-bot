// Віджет зголошень (docs/tasks/2026-10-29-feedback-module.md): кнопка в куті кожної сторінки →
// тип → «про цю сторінку?» → опис + вкладення (скріншот з анотаціями, пін на елемент, запис дій,
// файл) → POST /feedback + вкладення. Вкладки «Мої» (статуси, відповіді, підтвердження) і
// «На цій сторінці» (чужі відкриті, «у мене теж»). Тост «Зголосити?» після падіння/5xx
// (подія grafik:feedback-prompt з lib/breadcrumbs.ts), відкриття з ErrorBoundary
// (grafik:feedback-open). Alt+F. Усе всередині позначено data-feedback-widget (не в крихтах
// і не в скріншоті).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { domToBlob } from "modern-screenshot";
import { Bug, Camera, MousePointerClick, CircleDot, Paperclip, X, ChevronLeft, Send, ThumbsUp, Square } from "lucide-react";
import { get, post, del, upload, type Me } from "../lib/api";
import { useT, type TFn } from "../lib/i18n";
import { resolvedDark } from "../lib/theme";
import { snapshot, startRecording, stopRecording, isRecording, recordingStartedAt, onRecordingChange, pageFilters, record, type FeedbackPrompt } from "../lib/breadcrumbs";
import { KIND_LABEL, KIND_ICON, SEVERITY_LABEL, STATUS_LABEL, STATUS_BADGE, TONE_BORDER, toneOf, fmtDT, type FeedbackKind, type FeedbackSeverity, type MyReport, type PageReport, type SimilarReport } from "../lib/feedbackApi";
import { Badge, Button, Textarea, cn } from "./ui";
import { FeedbackAnnotator } from "./FeedbackAnnotator";
import { NAV_PAGES } from "./navPages";

type Pending = { kind: "screenshot" | "pin" | "upload"; blob: Blob; name: string; meta?: Record<string, unknown>; preview?: string; label: string };
type Prefill = { origin: "error" | "api5xx"; clientError: { message: string; stack?: string; source?: string } };

// Селектор елемента для «показати де»: tag#id.cls.cls:nth-of-type(n), ≤4 рівні (Tailwind-класи
// довгі — беремо до двох коротких).
function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 4) {
    let s = cur.tagName.toLowerCase();
    if (cur.id) { s += `#${cur.id}`; parts.unshift(s); break; }
    const cls = [...cur.classList].filter(c => c.length <= 14 && !/[:[\]/]/.test(c)).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    const parent: Element | null = cur.parentElement;
    if (parent) { const tag = cur.tagName; const same = [...parent.children].filter(ch => ch.tagName === tag); const idx = same.indexOf(cur); if (same.length > 1) s += `:nth-of-type(${idx + 1})`; }
    parts.unshift(s);
    cur = parent;
  }
  return parts.join(" > ");
}
const elText = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
// «сесія 2 год 10 хв» — скільки людина вже працює в панелі (з /auth/me sessionSince)
const sessionAge = (since: string | null | undefined) => { if (!since) return undefined; const m = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60000)); return m >= 60 ? `${Math.floor(m / 60)} год ${m % 60} хв` : `${m} хв`; };
const ua = () => { const u = navigator.userAgent; const b = /Edg\/(\d+)/.exec(u) ? `Edge ${/Edg\/(\d+)/.exec(u)![1]}` : /Chrome\/(\d+)/.exec(u) ? `Chrome ${/Chrome\/(\d+)/.exec(u)![1]}` : /Firefox\/(\d+)/.exec(u) ? `Firefox ${/Firefox\/(\d+)/.exec(u)![1]}` : /Safari\//.test(u) ? "Safari" : "браузер"; const os = /Windows/.test(u) ? "Windows" : /Mac OS/.test(u) ? "macOS" : /Android/.test(u) ? "Android" : /iPhone|iPad/.test(u) ? "iOS" : /Linux/.test(u) ? "Linux" : ""; return { b, os }; };

export function FeedbackWidget({ me }: { me: Me }) {
  const t = useT();
  const qc = useQueryClient();
  const [loc] = useLocation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"new" | "mine" | "page">("new");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [severity, setSeverity] = useState<FeedbackSeverity>("hinders");
  const [about, setAbout] = useState<"this" | "other" | "general">("this");
  const [otherPage, setOtherPage] = useState<string>("");
  const [description, setDescription] = useState(""); const [steps, setSteps] = useState(""); const [expected, setExpected] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [recording, setRecording] = useState(isRecording());
  const [recSec, setRecSec] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [annot, setAnnot] = useState<string | null>(null);
  const [pinMode, setPinMode] = useState(false);
  const [pinRect, setPinRect] = useState<DOMRect | null>(null);
  const [showCtx, setShowCtx] = useState(false);
  const [similar, setSimilar] = useState<SimilarReport[]>([]);
  const [joined, setJoined] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [draftId, setDraftId] = useState<number | null>(null); // зголошення вже створене, впало завантаження вкладень → повтор лише довантажує
  const fileRef = useRef<HTMLInputElement>(null);
  const pinEl = useRef<Element | null>(null);

  const { data: mine } = useQuery<{ reports: MyReport[]; unread: number; widgetOff?: boolean }>({ queryKey: ["feedback-mine"], queryFn: () => get("/feedback/mine"), refetchInterval: 120_000, staleTime: 60_000 });
  const { data: pageList } = useQuery<PageReport[]>({ queryKey: ["feedback-page", loc], queryFn: () => get(`/feedback/page?path=${encodeURIComponent(loc)}`), enabled: open && tab === "page" });
  const pageLabel = useMemo(() => NAV_PAGES.find(p => p.href !== "/" && (loc === p.href || loc.startsWith(p.href + "/")))?.label ?? NAV_PAGES.find(p => p.href === loc)?.label ?? loc, [loc]);
  const unread = mine?.unread ?? 0;

  const reset = useCallback(() => { setDraftId(null); setStep(1); setKind("bug"); setSeverity("hinders"); setAbout("this"); setOtherPage(""); setDescription(""); setSteps(""); setExpected(""); setPending([]); setPrefill(null); setSimilar([]); setJoined(null); setShowCtx(false); }, []);
  const openWith = useCallback((p?: Prefill) => { setOpen(true); setTab("new"); if (p) { reset(); setPrefill(p); setKind("bug"); setSeverity("blocks"); setAbout("this"); setStep(3); setDescription(p.origin === "error" ? t("Сторінка впала з помилкою: {m}", { m: p.clientError.message.slice(0, 160) }) : t("Сервер відповів помилкою: {m}", { m: p.clientError.message })); } }, [reset, t]);

  // події: тост після падіння/5xx, відкриття з ErrorBoundary, Alt+F, таймер запису
  useEffect(() => {
    const onPrompt = (e: Event) => {
      const d = (e as CustomEvent<FeedbackPrompt>).detail;
      toast.error(d.origin === "error" ? t("Щось зламалось на цій сторінці.") : t("Сервер відповів помилкою."), {
        description: t("Помилка й ваші останні дії вже зібрані."), duration: 12_000,
        action: { label: t("Зголосити"), onClick: () => openWith({ origin: d.origin, clientError: { message: d.message, stack: d.stack, source: d.source } }) },
      });
    };
    const onOpen = (e: Event) => { const d = (e as CustomEvent<Prefill | undefined>).detail; openWith(d ?? undefined); };
    const onKey = (e: KeyboardEvent) => { if (e.altKey && (e.key === "f" || e.key === "F" || e.key === "а" || e.key === "А")) { e.preventDefault(); setOpen(o => !o); } if (e.key === "Escape" && pinMode) setPinMode(false); };
    window.addEventListener("grafik:feedback-prompt", onPrompt); window.addEventListener("grafik:feedback-open", onOpen); window.addEventListener("keydown", onKey);
    const off = onRecordingChange(setRecording);
    return () => { window.removeEventListener("grafik:feedback-prompt", onPrompt); window.removeEventListener("grafik:feedback-open", onOpen); window.removeEventListener("keydown", onKey); off(); };
  }, [openWith, pinMode, t]);
  useEffect(() => { if (!recording) return; const i = setInterval(() => setRecSec(Math.floor((Date.now() - (recordingStartedAt() ?? Date.now())) / 1000)), 1000); return () => clearInterval(i); }, [recording]);
  useEffect(() => { if (open && tab === "mine" && unread) post("/feedback/mine/seen").then(() => qc.invalidateQueries({ queryKey: ["feedback-mine"] })).catch(() => {}); }, [open, tab, unread, qc]);
  // підказка дубля
  useEffect(() => {
    if (!open || step !== 3 || description.trim().length < 8) { setSimilar([]); return; }
    const h = setTimeout(() => { get<SimilarReport[]>(`/feedback/similar?path=${encodeURIComponent(about === "this" ? loc : about === "other" ? otherPage : "")}&q=${encodeURIComponent(description.trim().slice(0, 200))}`).then(setSimilar).catch(() => setSimilar([])); }, 500);
    return () => clearTimeout(h);
  }, [open, step, description, about, otherPage, loc]);

  // ── вкладення ──
  const screenshot = async () => {
    setCapturing(true);
    await new Promise(r => setTimeout(r, 80));
    const started = Date.now();
    try {
      // лише видима область (а не вся довжелезна сторінка): клон зсувається на scroll,
      // полотно обмежене вікном — інакше на списку з сотнями рядків знімок триває десятки секунд
      const scale = Math.min(1, 1600 / Math.max(1, window.innerWidth));
      const capture = domToBlob(document.documentElement, {
        type: "image/png", scale, width: window.innerWidth, height: window.innerHeight,
        style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`, transformOrigin: "top left" },
        filter: (n: Node) => !(n instanceof Element && n.hasAttribute("data-feedback-widget")),
      });
      const blob = await Promise.race([capture, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 25_000))]);
      record({ type: "rec", text: `📸 скріншот ${Math.round((Date.now() - started) / 100) / 10}s` });
      setAnnot(URL.createObjectURL(blob));
    } catch (e: any) { toast.error(t("Не вдалося зробити скріншот") + (e?.message ? `: ${e.message}` : "")); }
    finally { setCapturing(false); }
  };
  const onAnnotated = (blob: Blob, meta: { annotations: number; blurred: boolean; width: number; height: number }) => {
    if (annot) URL.revokeObjectURL(annot);
    setAnnot(null);
    setPending(p => [...p.filter(x => x.kind !== "screenshot"), { kind: "screenshot", blob, name: `screenshot-${Date.now()}.png`, meta: { ...meta, viewport: `${window.innerWidth}×${window.innerHeight}` }, preview: URL.createObjectURL(blob), label: `📸 ${t("скріншот")}${meta.annotations ? ` · ${meta.annotations}` : ""}${meta.blurred ? " · ▒" : ""}` }]);
    record({ type: "rec", text: "📸 скріншот додано до зголошення" });
  };
  const pinMove = (e: React.MouseEvent) => {
    const els = document.elementsFromPoint(e.clientX, e.clientY).filter(x => !x.closest("[data-feedback-widget]") && x !== document.documentElement && x !== document.body);
    const el = els[0] ?? null; pinEl.current = el; setPinRect(el ? el.getBoundingClientRect() : null);
  };
  const pinClick = async () => {
    const el = pinEl.current; setPinMode(false); setPinRect(null);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const meta = { selector: cssPath(el), text: elText(el), tag: el.tagName.toLowerCase(), rect: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) }, page: `${window.innerWidth}×${window.innerHeight}` };
    let blob: Blob | null = null;
    try { blob = await domToBlob(el as HTMLElement, { type: "image/png", scale: Math.min(1, 400 / Math.max(1, r.width)) }); } catch { blob = null; }
    const label = `👆 ${meta.tag} «${meta.text.slice(0, 30) || meta.selector.slice(-30)}»`;
    setPending(p => [...p.filter(x => x.kind !== "pin"), { kind: "pin", blob: blob ?? new Blob([JSON.stringify(meta)], { type: "application/json" }), name: `pin-${Date.now()}.png`, meta, preview: blob ? URL.createObjectURL(blob) : undefined, label }]);
    record({ type: "rec", text: `👆 пін: ${meta.selector} «${meta.text.slice(0, 40)}»` });
  };
  const addFiles = (files: FileList | File[]) => {
    const list = [...files].filter(f => /^image\/|application\/pdf/.test(f.type)).slice(0, 4);
    setPending(p => [...p, ...list.map(f => ({ kind: "upload" as const, blob: f, name: f.name, preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined, label: `📎 ${f.name.slice(0, 24)}` }))]);
  };
  const onPaste = (e: React.ClipboardEvent) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); addFiles(fs); } };

  // ── відправка ──
  const submit = async () => {
    if (description.trim().length < 5 && !prefill) { toast.error(t("Опишіть, будь ласка, детальніше")); return; }
    setSending(true);
    try {
      const snap = snapshot();
      const { b, os } = ua();
      const pagePath = about === "this" ? loc : about === "other" ? otherPage || null : null;
      const r = draftId ? { id: draftId } : await post<{ id: number }>("/feedback", {
        kind, severity: kind === "bug" ? severity : null, aboutPage: about === "this",
        pagePath, pageLabel: about === "this" ? pageLabel : about === "other" ? NAV_PAGES.find(p => p.href === otherPage)?.label ?? null : null,
        pageUrl: about === "this" ? location.href : null, pageFilters: about === "this" ? pageFilters() : null,
        description: description.trim(), steps: kind === "bug" ? steps.trim() || null : null, expected: kind === "bug" ? expected.trim() || null : null,
        origin: prefill?.origin ?? "widget", clientError: prefill?.clientError ?? null,
        context: { scope: me.scope ?? null, ua: `${b} · ${navigator.userAgent.slice(0, 120)}`, platform: os, session: sessionAge(me.sessionSince), screen: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}`, theme: resolvedDark() ? "dark" : "light", lang: (() => { try { return localStorage.getItem("lang") ?? "uk"; } catch { return "uk"; } })(), pageTitle: document.title, failedRequests: snap.failedRequests, consoleErrors: snap.consoleErrors },
        breadcrumbs: snap.breadcrumbs, recorded: snap.recorded, buildVersion: me.buildVersion ?? (typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null),
      });
      setDraftId(r.id);
      if (pending.length) {
        const fd = new FormData();
        for (const p of pending) fd.append("files", p.blob, p.name);
        fd.append("meta", JSON.stringify(pending.map(p => ({ kind: p.kind, meta: p.meta ?? null }))));
        await upload(`/feedback/${r.id}/attachments`, fd);
      }
      if (isRecording()) stopRecording("sent");
      toast.success(t("Дякуємо! Зголошення №{n} передано", { n: r.id }));
      reset(); setOpen(false);
      qc.invalidateQueries({ queryKey: ["feedback-mine"] });
    } catch (e: any) { toast.error(`${e?.message ?? t("Не вдалося надіслати")}${draftId ? ` · ${t("зголошення вже створене, повторіть надсилання вкладень")}` : ""}`); }
    finally { setSending(false); }
  };
  const vote = async (id: number, on: boolean, key: unknown[]) => { try { if (on) await post(`/feedback/${id}/vote`); else await del(`/feedback/${id}/vote`); qc.invalidateQueries({ queryKey: key }); } catch (e: any) { toast.error(e.message); } };
  const join = async (id: number) => { await vote(id, true, ["feedback-page"]); setJoined(id); toast.success(t("Приєднано до №{n}", { n: id })); };

  if (mine?.widgetOff) return null;
  const tone = TONE_BORDER[toneOf(kind, severity)];

  return (
    <div data-feedback-widget="" className={cn(capturing && "hidden")}>
      {/* пін-режим */}
      {pinMode && (
        <div className="fixed inset-0 z-[70] cursor-crosshair bg-slate-900/30" onMouseMove={pinMove} onClick={pinClick}>
          <div className="pointer-events-none fixed left-1/2 top-3 -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 shadow">{t("Клікніть на елемент, якого стосується проблема")} · Esc</div>
          {pinRect && <div className="pointer-events-none fixed rounded-sm outline outline-[3px] outline-red-600 outline-offset-2" style={{ left: pinRect.left, top: pinRect.top, width: pinRect.width, height: pinRect.height }} />}
        </div>
      )}
      <FeedbackAnnotator src={annot} open={!!annot} onClose={() => { if (annot) URL.revokeObjectURL(annot); setAnnot(null); }} onDone={onAnnotated} />

      {/* запис дій — пілюля над кнопкою */}
      {recording && (
        <div className="fixed bottom-20 right-5 z-[45] flex items-center gap-2 rounded-full border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 shadow-lg">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-600" /> {t("Запис дій")} {Math.floor(recSec / 60)}:{String(recSec % 60).padStart(2, "0")}
          <button onClick={() => stopRecording("user")} className="ml-1 rounded-md bg-white px-1.5 py-0.5 text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100"><Square className="inline h-3 w-3" /> {t("Стоп")}</button>
        </div>
      )}

      {/* кнопка */}
      <button onClick={() => setOpen(o => !o)} title={`${t("Зголосити проблему або побажання")} (Alt+F)`}
        className="fixed bottom-5 right-5 z-[45] flex h-11 w-11 items-center justify-center rounded-full bg-red-600 text-white shadow-lg shadow-red-600/30 transition hover:bg-red-700 print:hidden">
        {open ? <X className="h-5 w-5" /> : <Bug className="h-5 w-5" />}
        {!open && unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-sky-600 px-1.5 text-[10px] font-bold leading-4 text-white ring-2 ring-white">{unread}</span>}
      </button>

      {/* панель */}
      {open && (
        <div className="fixed bottom-20 right-5 z-[45] flex max-h-[min(80vh,640px)] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20">
          <div className="flex items-center gap-1 border-b border-slate-100 px-2 pt-2">
            {([["new", t("Нове")], ["mine", `${t("Мої")}${mine?.reports.length ? ` · ${mine.reports.length}` : ""}`], ["page", t("На цій сторінці")]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={cn("-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium", tab === k ? "border-red-600 text-red-700" : "border-transparent text-slate-500 hover:text-slate-700")}>{l}{k === "mine" && unread > 0 && <span className="ml-1 rounded-full bg-sky-600 px-1.5 text-[10px] text-white">{unread}</span>}</button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {tab === "new" && (
              <>
                <div className="mb-2 flex items-center gap-2">
                  {step > 1 && <button onClick={() => setStep(s => (s - 1) as 1 | 2 | 3)} className="rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><ChevronLeft className="h-4 w-4" /></button>}
                  <div className="text-sm font-semibold text-slate-800">{step === 1 ? t("Що зголошуємо?") : step === 2 ? t("Це стосується сторінки, де ви зараз?") : `${KIND_ICON[kind]} ${t(KIND_LABEL[kind])}${kind === "bug" ? ` · ${t(SEVERITY_LABEL[severity])}` : ""}`}</div>
                  <span className="ml-auto text-[11px] text-slate-400">{t("крок {a} з 3", { a: step })}</span>
                </div>
                <div className="mb-3 flex gap-1">{[1, 2, 3].map(i => <i key={i} className={cn("h-0.5 flex-1 rounded", i <= step ? "bg-red-600" : "bg-slate-200")} />)}</div>

                {step === 1 && (
                  <div className="space-y-1.5">
                    {(["bug", "wish", "question"] as FeedbackKind[]).map(k => (
                      <button key={k} onClick={() => { setKind(k); if (k !== "bug") setStep(2); }} className={cn("flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm", kind === k ? "border-red-500 bg-red-50 text-red-800" : "border-slate-200 hover:bg-slate-50")}>
                        <span>{KIND_ICON[k]}</span><span className="font-medium">{t(KIND_LABEL[k])}</span>
                        <span className="ml-auto text-[11px] text-slate-400">{k === "bug" ? t("щось не працює") : k === "wish" ? t("хочу, щоб було") : t("як зробити?")}</span>
                      </button>
                    ))}
                    {kind === "bug" && (
                      <div className="pt-1">
                        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">{t("Наскільки заважає")}</div>
                        <div className="flex gap-1.5">
                          {(["blocks", "hinders", "minor"] as FeedbackSeverity[]).map(s => <button key={s} onClick={() => setSeverity(s)} className={cn("flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium", severity === s ? (s === "blocks" ? "border-rose-500 bg-rose-50 text-rose-700" : s === "hinders" ? "border-amber-500 bg-amber-50 text-amber-700" : "border-sky-500 bg-sky-50 text-sky-700") : "border-slate-200 text-slate-600 hover:bg-slate-50")}>{t(SEVERITY_LABEL[s])}</button>)}
                        </div>
                        <Button className="mt-3 w-full" onClick={() => setStep(2)}>{t("Далі")} →</Button>
                      </div>
                    )}
                  </div>
                )}

                {step === 2 && (
                  <div className="space-y-1.5">
                    <button onClick={() => { setAbout("this"); setStep(3); }} className={cn("w-full rounded-lg border px-3 py-2 text-left text-sm", about === "this" ? "border-red-500 bg-red-50" : "border-slate-200 hover:bg-slate-50")}>
                      <div className="font-medium text-slate-800">✔ {t("Так")}, «{t(pageLabel)}»</div>
                      <div className="text-[11px] text-slate-400">{t("URL і фільтри додадуться самі")}</div>
                    </button>
                    <div className={cn("rounded-lg border px-3 py-2 text-sm", about === "other" ? "border-red-500 bg-red-50" : "border-slate-200")}>
                      <div className="font-medium text-slate-800">{t("Ні, інша сторінка")}</div>
                      <select value={otherPage} onChange={e => { setOtherPage(e.target.value); setAbout("other"); if (e.target.value) setStep(3); }} className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm">
                        <option value="">{t("Оберіть сторінку…")}</option>
                        {NAV_PAGES.map(p => <option key={p.href} value={p.href}>{t(p.label)}</option>)}
                      </select>
                    </div>
                    <button onClick={() => { setAbout("general"); setStep(3); }} className={cn("w-full rounded-lg border px-3 py-2 text-left text-sm font-medium text-slate-800", about === "general" ? "border-red-500 bg-red-50" : "border-slate-200 hover:bg-slate-50")}>{t("Загальне (не про сторінку)")}</button>
                  </div>
                )}

                {step === 3 && (
                  <div className="space-y-2">
                    {prefill && <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">⚡ {t("Помилка й останні дії вже прикріплені")}: <span className="font-mono">{prefill.clientError.message.slice(0, 90)}</span></div>}
                    {kind === "bug" && <Field label={t("Що робили")} value={steps} onChange={setSteps} rows={2} t={t} />}
                    <Field label={kind === "bug" ? t("Що сталось") : kind === "wish" ? t("Що хотілось би") : t("Запитання")} value={description} onChange={setDescription} rows={3} t={t} onPaste={onPaste} autoFocus />
                    {kind === "bug" && <Field label={`${t("Що очікували")} (${t("необовʼязково")})`} value={expected} onChange={setExpected} rows={2} t={t} />}
                    {similar.length > 0 && joined !== similar[0]!.id && (
                      <div className="rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-2 text-xs text-sky-900">
                        <div><b>{t("Схоже на №{n}", { n: similar[0]!.id })}</b> «{similar[0]!.title.slice(0, 60)}» · {t(STATUS_LABEL[similar[0]!.status])}{similar[0]!.votes ? ` · 👍 ${similar[0]!.votes}` : ""}</div>
                        {!similar[0]!.mine && <button onClick={() => join(similar[0]!.id)} className="mt-1 rounded-md bg-white px-2 py-1 font-medium text-sky-800 ring-1 ring-sky-200 hover:bg-sky-100"><ThumbsUp className="mr-1 inline h-3 w-3" />{t("У мене теж")}</button>}
                        <span className="ml-2 text-sky-700/70">{t("або продовжуйте — це буде нове зголошення")}</span>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <Tool onClick={screenshot} icon={<Camera className="h-3.5 w-3.5" />} label={t("Скріншот")} on={pending.some(p => p.kind === "screenshot")} />
                      <Tool onClick={() => setPinMode(true)} icon={<MousePointerClick className="h-3.5 w-3.5" />} label={t("Показати де")} on={pending.some(p => p.kind === "pin")} />
                      <Tool onClick={() => (recording ? stopRecording("user") : startRecording())} icon={<CircleDot className={cn("h-3.5 w-3.5", recording && "text-rose-600")} />} label={recording ? t("Стоп запис") : t("Записати дії")} on={recording} />
                      <Tool onClick={() => fileRef.current?.click()} icon={<Paperclip className="h-3.5 w-3.5" />} label={t("Файл")} />
                      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
                    </div>
                    {pending.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {pending.map((p, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-1 pr-1.5 text-[11px] text-slate-700">
                            {p.preview ? <img src={p.preview} alt="" className="h-5 w-7 rounded object-cover" /> : null}{p.label}
                            <button onClick={() => setPending(x => x.filter((_, j) => j !== i))} className="rounded-full p-0.5 hover:bg-slate-200"><X className="h-3 w-3" /></button>
                          </span>
                        ))}
                      </div>
                    )}
                    <button onClick={() => setShowCtx(s => !s)} className="text-[11px] text-slate-400 underline-offset-2 hover:underline">{t("Додасться автоматично")}: {t("роль")} «{me.roleLabel}», {t("браузер, останні дії й запити, помилки")} · {showCtx ? t("сховати") : t("показати")}</button>
                    {showCtx && <ContextPreview me={me} t={t} />}
                    <Button className="w-full" loading={sending} onClick={submit}><Send className="h-4 w-4" />{t("Надіслати")}</Button>
                  </div>
                )}
              </>
            )}

            {tab === "mine" && <MineList reports={mine?.reports ?? []} t={t} onChanged={() => qc.invalidateQueries({ queryKey: ["feedback-mine"] })} />}

            {tab === "page" && (
              <div className="space-y-1.5">
                <div className="text-[11px] text-slate-400">{t("Відкриті зголошення по сторінці")} «{t(pageLabel)}»</div>
                {!pageList?.length && <div className="py-6 text-center text-sm text-slate-400">{t("Поки нічого")}</div>}
                {pageList?.map(r => (
                  <div key={r.id} className={cn("rounded-lg border border-slate-200 border-l-[3px] px-2.5 py-1.5 text-xs", TONE_BORDER[toneOf(r.kind, r.severity)])}>
                    <div className="flex items-start gap-1.5"><span className="font-semibold text-slate-700">#{r.id}</span><span className="min-w-0 flex-1 text-slate-800">{r.title}</span></div>
                    <div className="mt-1 flex items-center gap-2"><Badge color={STATUS_BADGE[r.status]}>{t(STATUS_LABEL[r.status])}</Badge>{r.mine && <span className="text-slate-400">{t("моє")}</span>}
                      <button onClick={() => vote(r.id, !r.voted, ["feedback-page"])} className={cn("ml-auto rounded-md px-1.5 py-0.5 font-medium ring-1", r.voted ? "bg-sky-600 text-white ring-sky-600" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}><ThumbsUp className="mr-1 inline h-3 w-3" />{r.votes}</button></div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className={cn("h-1", tab === "new" ? tone.replace("border-l-", "bg-") : "bg-slate-100")} />
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, rows, t, onPaste, autoFocus }: { label: string; value: string; onChange: (v: string) => void; rows: number; t: TFn; onPaste?: (e: React.ClipboardEvent) => void; autoFocus?: boolean }) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] font-medium text-slate-500">{label}</div>
      <Textarea value={value} onChange={e => onChange(e.target.value)} rows={rows} onPaste={onPaste} autoFocus={autoFocus} className="text-sm" placeholder={t("Кілька слів своїми словами…")} />
    </div>
  );
}
function Tool({ onClick, icon, label, on }: { onClick: () => void; icon: React.ReactNode; label: string; on?: boolean }) {
  return <button onClick={onClick} className={cn("inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium", on ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}>{icon}{label}</button>;
}
function ContextPreview({ me, t }: { me: Me; t: TFn }) {
  const snap = snapshot(); const { b, os } = ua();
  return (
    <div className="rounded-lg bg-slate-50 p-2 text-[11px] text-slate-600">
      <div>{t("Хто")}: {me.name} · {me.roleLabel}{me.scope ? ` · ${[...me.scope.cities].join(", ")}` : ""}</div>
      <div>{t("Чим")}: {b} · {os} · {window.innerWidth}×{window.innerHeight} · {resolvedDark() ? "dark" : "light"} · {t("збірка")} {me.buildVersion ?? "?"}{me.sessionSince ? ` · ${t("сесія")} ${sessionAge(me.sessionSince)}` : ""}</div>
      <div>{t("Крихти")}: {snap.breadcrumbs.length} · {t("невдалих запитів")}: {snap.failedRequests.length} · {t("помилок")}: {snap.consoleErrors.length}</div>
      <div className="mt-1 text-slate-400">{t("Значення текстових полів не записуються.")}</div>
    </div>
  );
}

function MineList({ reports, t, onChanged }: { reports: MyReport[]; t: TFn; onChanged: () => void }) {
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (id: number, kind: "comment" | "no") => {
    if (!text.trim()) return;
    setBusy(true);
    try { if (kind === "comment") await post(`/feedback/${id}/comments`, { body: text }); else await post(`/feedback/${id}/confirm`, { ok: false, note: text }); setText(""); setReplyFor(null); onChanged(); toast.success(t("Надіслано")); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  const ok = async (id: number) => { try { await post(`/feedback/${id}/confirm`, { ok: true }); onChanged(); toast.success(t("Дякуємо!")); } catch (e: any) { toast.error(e.message); } };
  if (!reports.length) return <div className="py-8 text-center text-sm text-slate-400">{t("Ви ще нічого не зголошували")}</div>;
  return (
    <div className="space-y-1.5">
      {reports.map(r => (
        <div key={r.id} className={cn("rounded-lg border border-slate-200 border-l-[3px] px-2.5 py-1.5 text-xs", TONE_BORDER[toneOf(r.kind, r.severity)], r.unread && "bg-sky-50/50")}>
          <div className="flex items-start gap-1.5"><span className="font-semibold text-slate-700">#{r.id}</span><span className="min-w-0 flex-1 text-slate-800">{r.title}</span>{r.unread && <span className="rounded-full bg-sky-600 px-1.5 text-[10px] text-white">{t("нове")}</span>}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-slate-400"><Badge color={STATUS_BADGE[r.status]}>{t(STATUS_LABEL[r.status])}</Badge>{r.pageLabel && <span>· {t(r.pageLabel)}</span>}<span>· {fmtDT(r.createdAt)}</span>{r.votes > 0 && <span>· 👍 {r.votes}</span>}{r.duplicateOfId && <span>· → #{r.duplicateOfId}</span>}</div>
          {r.status === "clarify" && r.lastQuestion && <div className="mt-1 rounded bg-amber-50 px-2 py-1 text-amber-800">❔ {r.lastQuestion}</div>}
          {r.reply && r.status !== "clarify" && <div className="mt-1 rounded bg-slate-50 px-2 py-1 text-slate-600">💬 {r.reply}</div>}
          {r.status === "fixed" && replyFor !== r.id && <div className="mt-1.5 flex gap-1.5"><button onClick={() => ok(r.id)} className="rounded-md bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-700">✔ {t("Працює")}</button><button onClick={() => { setReplyFor(r.id); setText(""); }} className="rounded-md bg-white px-2 py-1 font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">✖ {t("Досі ні")}</button></div>}
          {(r.status === "clarify" || ["review", "new", "planned", "in_progress"].includes(r.status)) && replyFor !== r.id && <button onClick={() => { setReplyFor(r.id); setText(""); }} className="mt-1 text-slate-500 underline-offset-2 hover:underline">{r.status === "clarify" ? t("Відповісти") : t("Дописати")}</button>}
          {replyFor === r.id && (
            <div className="mt-1.5">
              <Textarea value={text} onChange={e => setText(e.target.value)} rows={2} autoFocus className="text-xs" />
              <div className="mt-1 flex gap-1.5"><Button className="px-2.5 py-1 text-xs" loading={busy} onClick={() => send(r.id, r.status === "fixed" ? "no" : "comment")}>{t("Надіслати")}</Button><Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setReplyFor(null)}>{t("Скасувати")}</Button></div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

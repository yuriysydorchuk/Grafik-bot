// «Хлібні крихти» для зголошень (docs/tasks/2026-10-29-feedback-module.md): кільцевий буфер
// останніх дій у вкладці — кліки (тип елемента + текст, БЕЗ значень інпутів), переходи між
// сторінками, запити до API (метод, шлях, статус, час, X-Request-Id), помилки JS/консолі.
// Нічого не шлеться само: буфер іде на сервер лише разом зі зголошенням (snapshot()).
// «Записати дії» лише ставить маркер «з цього моменту» — як «перемотка» в Jam.
export type Crumb = { t: string; type: "click" | "nav" | "api" | "error" | "console" | "rec" | "input"; text: string; status?: number; ms?: number; reqId?: string };
export type FeedbackPrompt = { origin: "error" | "api5xx"; message: string; stack?: string; source?: string };

const MAX = 200;
const WINDOW_MS = 5 * 60_000;
const REC_MAX_MS = 3 * 60_000;
const buf: Crumb[] = [];
let recordingSince: number | null = null;
let recTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
const listeners = new Set<(on: boolean) => void>();

export function record(c: Omit<Crumb, "t">): void {
  buf.push({ t: new Date().toISOString(), ...c });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

export function isRecording(): boolean { return recordingSince != null; }
export function recordingStartedAt(): number | null { return recordingSince; }
export function onRecordingChange(fn: (on: boolean) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function startRecording(): void {
  recordingSince = Date.now();
  record({ type: "rec", text: "⏺ запис дій розпочато користувачем" });
  if (recTimer) clearTimeout(recTimer);
  recTimer = setTimeout(() => stopRecording("auto"), REC_MAX_MS);
  listeners.forEach(fn => fn(true));
}
export function stopRecording(why: "user" | "auto" | "sent" = "user"): void {
  if (recordingSince == null) return;
  record({ type: "rec", text: why === "auto" ? "⏹ запис зупинено автоматично (3 хв)" : why === "sent" ? "⏹ запис надіслано" : "⏹ запис зупинено" });
  recordingSince = null;
  if (recTimer) { clearTimeout(recTimer); recTimer = null; }
  listeners.forEach(fn => fn(false));
}

// Знімок для зголошення: від маркера запису (якщо є) або останні 5 хв, але не більше 120 подій.
export function snapshot() {
  const since = recordingSince ?? Date.now() - WINDOW_MS;
  const crumbs = buf.filter(c => Date.parse(c.t) >= since).slice(-120);
  const failedRequests = buf.filter(c => c.type === "api" && (c.status ?? 0) >= 400).slice(-10)
    .map(c => { const [method, ...rest] = c.text.split(" "); return { method: method ?? "", path: rest.join(" "), status: c.status ?? 0, reqId: c.reqId, t: c.t }; });
  const consoleErrors = buf.filter(c => c.type === "error" || c.type === "console").slice(-10).map(c => ({ message: c.text, t: c.t }));
  return { breadcrumbs: crumbs, failedRequests, consoleErrors, recorded: recordingSince != null };
}

// ── збір ────────────────────────────────────────────────────────────────────
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const aria = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder");
  let text = "";
  if (tag === "select") text = (el as HTMLSelectElement).selectedOptions[0]?.text ?? "";
  else if (tag === "input") { const i = el as HTMLInputElement; text = i.type === "checkbox" || i.type === "radio" ? (i.checked ? "☑" : "☐") : ""; }
  else text = (el as HTMLElement).innerText ?? el.textContent ?? "";
  text = text.replace(/\s+/g, " ").trim();
  const label = aria ? `${clip(text, 40)}${text ? " " : ""}[${clip(aria, 30)}]` : clip(text, 40);
  return label ? `${tag} «${label}»` : tag;
}
const INTERACTIVE = "button,a,select,input,textarea,[role=button],[role=tab],[role=menuitem],summary,label";

function reqIdOf(e: unknown): string | undefined {
  const s = e instanceof Error ? e.stack ?? "" : "";
  return s ? undefined : undefined;
}

export function installBreadcrumbs(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // кліки по інтерактивних елементах (capture — до будь-яких stopPropagation)
  document.addEventListener("click", e => {
    const target = e.target as Element | null;
    const el = target?.closest?.(INTERACTIVE) ?? target;
    if (!el || (el as HTMLElement).closest?.("[data-feedback-widget]")) return;
    record({ type: "click", text: describe(el) });
  }, true);
  // зміна select/checkbox (значення текстових полів НЕ пишемо)
  document.addEventListener("change", e => {
    const el = e.target as Element | null;
    if (!el || (el as HTMLElement).closest?.("[data-feedback-widget]")) return;
    const tag = el.tagName?.toLowerCase();
    if (tag === "select" || (tag === "input" && ["checkbox", "radio", "date", "month", "week"].includes((el as HTMLInputElement).type))) record({ type: "input", text: `${describe(el)} → ${tag === "select" ? (el as HTMLSelectElement).selectedOptions[0]?.text ?? "" : (el as HTMLInputElement).type === "checkbox" ? ((el as HTMLInputElement).checked ? "☑" : "☐") : (el as HTMLInputElement).value}` });
  }, true);
  // помилки JS
  window.addEventListener("error", e => {
    const msg = e.message || String(e.error ?? "error");
    const src = e.filename ? `${e.filename.split("/").pop()}:${e.lineno}` : undefined;
    record({ type: "error", text: `${clip(msg, 300)}${src ? ` — ${src}` : ""}` });
    prompt({ origin: "error", message: msg, stack: clip(String(e.error?.stack ?? ""), 1500), source: src });
  });
  window.addEventListener("unhandledrejection", e => {
    const r = e.reason;
    const msg = r instanceof Error ? r.message : String(r ?? "rejection");
    if (/unauthorized|csrf/i.test(msg)) return;
    record({ type: "error", text: `unhandled: ${clip(msg, 300)}` });
    void reqIdOf(r);
  });
  // console.error → крихта (без рекурсії: пишемо лише в буфер)
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try { record({ type: "console", text: clip(args.map(a => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "), 300) }); } catch { /* ignore */ }
    orig(...args);
  };
  record({ type: "nav", text: `${location.pathname}${location.search}` });
}

// Підказка «Зголосити?» після падіння: віджет слухає цю подію і показує тост.
let lastPrompt = 0;
export function prompt(detail: FeedbackPrompt): void {
  const now = Date.now();
  if (now - lastPrompt < 15_000) return; // не спамити тостами при каскаді помилок
  lastPrompt = now;
  window.dispatchEvent(new CustomEvent<FeedbackPrompt>("grafik:feedback-prompt", { detail }));
}

// Контекст сторінки для зголошення: query-параметри + підписи вибраних select-ів у <main>.
export function pageFilters(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(location.search)) out[k] = v;
  const selects: Record<string, string> = {};
  let n = 0;
  for (const sel of document.querySelectorAll<HTMLSelectElement>("main select")) {
    if (n >= 8) break;
    const txt = sel.selectedOptions[0]?.text?.trim();
    if (!txt || txt === "—") continue;
    const lbl = sel.getAttribute("aria-label") || sel.getAttribute("title") || sel.id || (sel.labels?.[0]?.innerText?.trim()) || sel.name || `select${n + 1}`;
    selects[clip(lbl, 30)] = clip(txt, 50);
    n++;
  }
  if (n) out.selects = selects;
  return out;
}

// Типи та словники модуля «Зголошення» (routes/feedback.ts). Укр-рядки — ключі i18n.
export type FeedbackKind = "bug" | "wish" | "question";
export type FeedbackSeverity = "blocks" | "hinders" | "minor";
export type FeedbackStatus = "new" | "review" | "clarify" | "planned" | "in_progress" | "fixed" | "confirmed" | "rejected" | "duplicate" | "exists";

export const KIND_LABEL: Record<FeedbackKind, string> = { bug: "Проблема", wish: "Побажання", question: "Питання" };
export const KIND_ICON: Record<FeedbackKind, string> = { bug: "🐞", wish: "💡", question: "❓" };
export const SEVERITY_LABEL: Record<FeedbackSeverity, string> = { blocks: "блокує роботу", hinders: "заважає", minor: "дрібниця" };
export const STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: "нове", review: "на розгляді", clarify: "треба уточнити", planned: "у плані", in_progress: "в роботі",
  fixed: "виправлено", confirmed: "підтверджено", rejected: "відхилено", duplicate: "дубль", exists: "уже є",
};
export const STATUS_BADGE: Record<FeedbackStatus, "slate" | "blue" | "amber" | "green" | "rose" | "red"> = {
  new: "red", review: "amber", clarify: "amber", planned: "blue", in_progress: "blue", fixed: "green", confirmed: "green", rejected: "slate", duplicate: "slate", exists: "slate",
};
export const OPEN_STATUSES: FeedbackStatus[] = ["new", "review", "clarify", "planned", "in_progress", "fixed"];
// лівий бордер картки (Tailwind v4: класи буквально)
export const TONE_BORDER = {
  blocks: "border-l-rose-500", hinders: "border-l-amber-400", minor: "border-l-sky-400", wish: "border-l-violet-400", question: "border-l-blue-400",
} as const;
export const toneOf = (kind: FeedbackKind, severity: FeedbackSeverity | null | undefined): keyof typeof TONE_BORDER => (kind === "bug" ? (severity ?? "hinders") : kind);

export interface MyReport {
  id: number; kind: FeedbackKind; severity: FeedbackSeverity | null; status: FeedbackStatus; title: string;
  pagePath: string | null; pageLabel: string | null; reply: string | null; createdAt: string; updatedAt: string;
  duplicateOfId: number | null; unread: boolean; votes: number; lastQuestion: string | null;
}
export interface PageReport { id: number; kind: FeedbackKind; severity: FeedbackSeverity | null; status: FeedbackStatus; title: string; createdAt: string; votes: number; voted: boolean; mine: boolean }
export interface SimilarReport { id: number; kind: FeedbackKind; status: FeedbackStatus; title: string; pageLabel: string | null; votes: number; mine: boolean }
export interface ListRow {
  id: number; kind: FeedbackKind; severity: FeedbackSeverity | null; status: FeedbackStatus; title: string;
  pagePath: string | null; pageLabel: string | null; origin: string; authorAdminId: number; authorName: string | null; buildVersion: string | null;
  createdAt: string; updatedAt: string; statusChangedAt: string | null; lastAdminActivityAt: string | null; confirmRequestedAt: string | null;
  duplicateOfId: number | null; taskId: number | null; recorded: boolean; votes: number; attachments: number; comments: number;
}
export interface Facets { pages: { path: string; label: string | null; n: number }[]; authors: { id: number; name: string; n: number }[]; builds: { build: string; n: number }[] }
export interface Crumb { t: string; type: string; text: string; status?: number; ms?: number; reqId?: string }
export interface Attachment { id: number; kind: "screenshot" | "pin" | "upload"; name: string; mime: string; size: number; meta: Record<string, unknown> | null; url: string }
export interface Comment { id: number; adminId: number | null; adminName: string | null; kind: "comment" | "answer" | "question" | "system"; body: string; via: string; createdAt: string }
export interface ReportCard {
  id: number; kind: FeedbackKind; severity: FeedbackSeverity | null; status: FeedbackStatus; title: string; description: string; steps: string | null; expected: string | null;
  aboutPage: boolean; pagePath: string | null; pageLabel: string | null; pageUrl: string | null; pageFilters: Record<string, unknown> | null;
  origin: string; clientError: { message: string; stack?: string; source?: string } | null;
  context: { role?: string; roleLabel?: string; scope?: { cities: string[]; factoryIds: number[] } | null; ua?: string; platform?: string; screen?: string; theme?: string; lang?: string; pageTitle?: string; session?: string; failedRequests?: { method: string; path: string; status: number; reqId?: string; t: string }[]; consoleErrors?: { message: string; t: string }[] };
  breadcrumbs: Crumb[]; recorded: boolean; buildVersion: string | null; authorAdminId: number; authorName: string; mine: boolean;
  reply: string | null; duplicateOfId: number | null; taskId: number | null; triage: Record<string, unknown> | null; deployedCommit: string | null;
  statusChangedAt: string | null; confirmRequestedAt: string | null; confirmedAt: string | null; createdAt: string; updatedAt: string;
  attachments: Attachment[]; comments: Comment[]; votes: { adminId: number; name: string | null }[];
}
export interface Counters { new: number; stale: number; awaiting: number; open: number; blocks: number; closed30: number; avgDays: number | null }
export interface FeedbackSettings { instantKinds: string[]; remindDays: number; confirmDays: number; widgetOffRoles: string[]; dedupHint: boolean; packWarn: boolean }

export const fmtDT = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

// Markdown одного зголошення для буфера обміну («Копіювати для Claude»).
export function reportMarkdown(r: ReportCard): string {
  const L: string[] = [];
  L.push(`# Зголошення #${r.id} · ${KIND_LABEL[r.kind]}${r.severity ? ` · ${SEVERITY_LABEL[r.severity]}` : ""} · ${STATUS_LABEL[r.status]}`);
  L.push(`Автор: ${r.authorName} (${r.context?.roleLabel ?? ""}) · ${fmtDT(r.createdAt)} · збірка ${r.buildVersion ?? "?"}`);
  L.push(`Сторінка: ${r.pageLabel ?? r.pagePath ?? "загальне"} · ${r.pageUrl ?? ""}`);
  if (r.pageFilters && Object.keys(r.pageFilters).length) L.push(`Фільтри: ${JSON.stringify(r.pageFilters)}`);
  L.push("");
  L.push(`**Заголовок:** ${r.title}`);
  if (r.steps) L.push(`**Що робили:** ${r.steps}`);
  L.push(`**Що сталось / суть:** ${r.description}`);
  if (r.expected) L.push(`**Очікували:** ${r.expected}`);
  if (r.clientError) L.push(`**Помилка:** ${r.clientError.message}${r.clientError.source ? ` (${r.clientError.source})` : ""}\n\`\`\`\n${r.clientError.stack ?? ""}\n\`\`\``);
  const c = r.context ?? {};
  L.push(""); L.push(`Контекст: ${[c.ua, c.platform, c.screen, c.theme, c.lang].filter(Boolean).join(" · ")}`);
  if (c.failedRequests?.length) L.push(`Невдалі запити: ${c.failedRequests.map(f => `${f.method} ${f.path} ${f.status}${f.reqId ? ` req=${f.reqId}` : ""}`).join("; ")}`);
  if (r.breadcrumbs?.length) { L.push(""); L.push("Крихти:"); L.push("```"); for (const b of r.breadcrumbs) L.push(`${b.t.slice(11, 19)}  ${b.type.padEnd(7)} ${b.text}${b.status != null ? `  ${b.status}` : ""}${b.ms != null ? `  ${b.ms}ms` : ""}${b.reqId ? `  req=${b.reqId}` : ""}`); L.push("```"); }
  if (r.attachments?.length) L.push(`Вкладення: ${r.attachments.map(a => `${a.kind} ${a.name}${a.meta && (a.meta as any).selector ? ` [${(a.meta as any).selector} «${(a.meta as any).text ?? ""}»]` : ""}`).join("; ")}`);
  const com = (r.comments ?? []).filter(x => x.kind !== "system");
  if (com.length) { L.push(""); L.push("Коментарі:"); for (const x of com) L.push(`- ${fmtDT(x.createdAt)} ${x.adminName ?? "система"} (${x.kind}): ${x.body}`); }
  return L.join("\n");
}

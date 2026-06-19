// Lightweight production alerting: short Telegram messages on errors, on top of
// structured pino logging. Best-effort by design — sending an alert must NEVER
// throw into the caller (API request / bot update / cron job).
//
// Safety rules enforced here:
//   - never include secrets/tokens/connection strings or personal data;
//   - de-duplicate identical errors and rate-limit to avoid alert storms;
//   - alerts are sent through the SAME Telegraf bot (outgoing API call only —
//     no extra polling instance), so this respects the single-instance rule.
//
// Config (env, no hardcoding):
//   ALERTS_ENABLED          "true" to enable (default: disabled)
//   ALERT_TELEGRAM_CHAT_ID  primary recipient chat id
//   ALERT_COOLDOWN_SECONDS  per-error cooldown, default 300
import { eq } from "drizzle-orm";
import { db, adminsTable } from "@workspace/db";
import { bot } from "../bot/instance";
import { logger } from "./logger";

export type AlertInput = {
  service: "api" | "bot" | "cron" | "process" | "startup"; // where it happened
  kind?: string;        // error type / category (e.g. err.name, "uncaughtException")
  source?: string;      // route or job, e.g. "POST /api/workers" or "weeklyReminder"
  message?: string;     // raw message — sanitized + truncated before sending
  fatal?: boolean;      // marks process-fatal errors
};

// ── Config ──────────────────────────────────────────────────────────────────
const alertsEnabled = (): boolean => (process.env.ALERTS_ENABLED ?? "").toLowerCase() === "true";
const cooldownMs = (): number => {
  const n = Number(process.env.ALERT_COOLDOWN_SECONDS);
  return (Number.isFinite(n) && n >= 0 ? n : 300) * 1000;
};

// Internal anti-storm limits (not env — keep the surface minimal).
const MAX_ALERTS_PER_WINDOW = 10;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LEN = 300;

// ── State (in-memory; resets on restart — acceptable) ─────────────────────────
const lastSentByKey = new Map<string, number>();   // dedup key → last send (ms)
const suppressedByKey = new Map<string, number>();  // dedup key → skipped count
let windowStart = 0;
let windowCount = 0;
let globalSuppressed = 0;
let cachedFallbackChatId: string | null | undefined; // undefined = not looked up yet

// ── Sanitization: strip anything secret-ish, drop PII risk, truncate ──────────
function sanitize(raw: string | undefined): string {
  if (!raw) return "";
  let s = String(raw).replace(/\s+/g, " ").trim();
  s = s
    .replace(/\b\d{8,10}:AA[\w-]{30,}\b/g, "[token]")             // telegram bot token
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[db-url]")             // connection string
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")            // long secrets/hashes
    .replace(/(password|secret|token|api[_-]?key)=\S+/gi, "$1=[redacted]");
  if (s.length > MAX_MESSAGE_LEN) s = s.slice(0, MAX_MESSAGE_LEN) + "…";
  return s;
}

function dedupKey(a: AlertInput): string {
  // Collapse identical errors: drop digits from message so id-varying errors group.
  const msg = (a.message ?? "").replace(/\d+/g, "#").slice(0, 80);
  return `${a.service}|${a.kind ?? ""}|${a.source ?? ""}|${msg}`;
}

// Resolve recipient: ALERT_TELEGRAM_CHAT_ID first; else fall back to the main
// admin's Telegram id (looked up lazily + cached; never throws).
async function resolveChatId(): Promise<string | null> {
  const explicit = process.env.ALERT_TELEGRAM_CHAT_ID?.trim();
  if (explicit) return explicit;
  if (cachedFallbackChatId !== undefined) return cachedFallbackChatId;
  try {
    const [main] = await db.select({ tid: adminsTable.telegramId })
      .from(adminsTable).where(eq(adminsTable.isMain, true)).limit(1);
    cachedFallbackChatId = main?.tid ?? null;
  } catch {
    cachedFallbackChatId = null;
  }
  return cachedFallbackChatId;
}

function formatText(a: AlertInput, extraSuppressed: number): string {
  const time = new Date().toLocaleString("uk-UA", { timeZone: "Europe/Warsaw", hour12: false });
  const head = `${a.fatal ? "🛑" : "🚨"} grafik-bot · ${a.service}`;
  const lines = [head];
  const sub = [a.kind, a.source].filter(Boolean).join(" @ ");
  if (sub) lines.push(sub);
  const msg = sanitize(a.message);
  if (msg) lines.push(msg);
  lines.push(`🕒 ${time}`);
  if (extraSuppressed > 0) lines.push(`(+${extraSuppressed} similar suppressed)`);
  return lines.join("\n");
}

// ── Core: best-effort alert. Always safe to call. ─────────────────────────────
export async function sendAlert(input: AlertInput): Promise<void> {
  // Structured log regardless of whether alerting is enabled.
  logger.error({ alert: { service: input.service, kind: input.kind, source: input.source }, msg: sanitize(input.message) }, "alert");

  if (!alertsEnabled()) return;

  const now = Date.now();
  const key = dedupKey(input);

  // Per-error cooldown.
  const last = lastSentByKey.get(key);
  if (last !== undefined && now - last < cooldownMs()) {
    suppressedByKey.set(key, (suppressedByKey.get(key) ?? 0) + 1);
    return;
  }

  // Global rate cap (sliding window).
  if (now - windowStart > RATE_WINDOW_MS) { windowStart = now; windowCount = 0; }
  if (windowCount >= MAX_ALERTS_PER_WINDOW) { globalSuppressed++; return; }

  const chatId = await resolveChatId();
  if (!chatId) {
    logger.warn("alert not sent: no ALERT_TELEGRAM_CHAT_ID and no main admin");
    return;
  }

  const extraSuppressed = (suppressedByKey.get(key) ?? 0) + (globalSuppressed > 0 ? globalSuppressed : 0);
  try {
    await bot.telegram.sendMessage(chatId, formatText(input, extraSuppressed));
    lastSentByKey.set(key, now);
    suppressedByKey.delete(key);
    globalSuppressed = 0;
    windowCount++;
  } catch (e) {
    // Never recurse into alerting on a failed alert — just log.
    logger.error({ err: e }, "failed to send alert");
  }
}

// Startup notification (only when alerting is enabled) — surfaces pm2 restarts.
export async function sendStartupAlert(): Promise<void> {
  if (!alertsEnabled()) return;
  await sendAlert({ service: "startup", kind: "started", message: "service started (or restarted)" });
}

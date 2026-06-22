import { Telegraf } from "telegraf";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const bot = new Telegraf(token);

// ── Safe-send fallback (parse_mode) ───────────────────────────────────────────
// Telegram rejects a payload whose parse_mode markup is malformed
// ("400: can't parse entities") — e.g. a user name with an unbalanced * or _.
// We wrap `callApi`, the single chokepoint EVERY Telegram method goes through
// (sendMessage, editMessageText, sendPhoto caption, …) — and `ctx.reply`/edits too —
// so on that specific error we retry once with parse_mode stripped (plain text).
// The message still goes out and bot.catch isn't triggered. Retries only after a
// real failure, so a successful first call never produces a duplicate. Other
// payloads (e.g. getUpdates — no parse_mode) are untouched.
const _origCallApi: (...args: any[]) => Promise<any> = bot.telegram.callApi.bind(bot.telegram);
(bot.telegram as any).callApi = async (method: string, payload: any, ...rest: any[]) => {
  try {
    return await _origCallApi(method, payload, ...rest);
  } catch (e: any) {
    const desc: string = e?.response?.description ?? e?.description ?? e?.message ?? "";
    if (payload?.parse_mode && typeof desc === "string" && desc.includes("can't parse entities")) {
      const { parse_mode, ...clean } = payload;
      return await _origCallApi(method, clean, ...rest); // retry without formatting
    }
    throw e;
  }
};

// Best-effort "is the bot polling" flag for /api/healthz — set by index.ts around
// bot.launch(). Avoids an extra Telegram API call on every healthcheck.
let _botLaunched = false;
export const isBotLaunched = (): boolean => _botLaunched;
export const setBotLaunched = (v: boolean): void => { _botLaunched = v; };

import { Telegraf } from "telegraf";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const bot = new Telegraf(token);

// ── Safe send fallback ────────────────────────────────────────────────────────
// Telegram rejects a message whose parse_mode markup is malformed
// ("400: can't parse entities") — e.g. a user name with an unbalanced * or _ in a
// Markdown message. Retry the SAME send once as plain text so the message still
// goes out (and bot.catch isn't triggered). Only retries after a real failure, so
// a successful first send never produces a duplicate. Wrapping telegram.sendMessage
// also covers ctx.reply (it routes through this method).
const _origSendMessage = bot.telegram.sendMessage.bind(bot.telegram);
bot.telegram.sendMessage = (async (chatId: any, text: any, extra?: any) => {
  try {
    return await _origSendMessage(chatId, text, extra);
  } catch (e: any) {
    const desc: string = e?.response?.description ?? e?.description ?? e?.message ?? "";
    if (extra?.parse_mode && typeof desc === "string" && desc.includes("can't parse entities")) {
      const { parse_mode, ...rest } = extra;
      return await _origSendMessage(chatId, text, rest); // resend without formatting
    }
    throw e;
  }
}) as typeof bot.telegram.sendMessage;

// Best-effort "is the bot polling" flag for /api/healthz — set by index.ts around
// bot.launch(). Avoids an extra Telegram API call on every healthcheck.
let _botLaunched = false;
export const isBotLaunched = (): boolean => _botLaunched;
export const setBotLaunched = (v: boolean): void => { _botLaunched = v; };

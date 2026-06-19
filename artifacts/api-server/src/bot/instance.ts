import { Telegraf } from "telegraf";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const bot = new Telegraf(token);

// Best-effort "is the bot polling" flag for /api/healthz — set by index.ts around
// bot.launch(). Avoids an extra Telegram API call on every healthcheck.
let _botLaunched = false;
export const isBotLaunched = (): boolean => _botLaunched;
export const setBotLaunched = (v: boolean): void => { _botLaunched = v; };

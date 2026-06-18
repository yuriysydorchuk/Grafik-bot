import { Telegraf } from "telegraf";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const bot = new Telegraf(token);

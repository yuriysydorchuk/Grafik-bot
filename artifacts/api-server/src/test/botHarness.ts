// Bot-flow test harness. Reuses the DB harness (env + test Postgres) and drives the REAL
// registered Telegraf handlers via bot.handleUpdate(fakeUpdate) — no production refactor.
// Every outgoing Telegram call is captured at the single chokepoint (telegram.callApi),
// so nothing hits the network and tests can assert what the bot "replied".
import "./harness.ts"; // ensures env.ts ran (token/DB) before the bot instance loads
import { bot } from "../bot/index.ts";

// Fake botInfo so handleUpdate never calls getMe (which would hit the network).
(bot as any).botInfo = {
  id: 1, is_bot: true, first_name: "TestBot", username: "test_bot",
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
};

export type Sent = { method: string; chatId: unknown; text?: string; extra?: any };
export const sent: Sent[] = [];
export function resetSent(): void { sent.length = 0; }
// Convenience: concatenated text of everything the bot sent during a step.
export const sentText = (): string => sent.map(s => s.text ?? "").join("\n");

// Intercept at the Telegram PROTOTYPE's single chokepoint. Telegraf builds a per-update
// telegram/context, so patching the bot.telegram instance isn't enough — the prototype
// covers every instance. No network; every outgoing call is captured by method name.
const TelegramProto: any = Object.getPrototypeOf(bot.telegram);
TelegramProto.callApi = async function (method: string, payload: any = {}) {
  if (method === "getMe") return (bot as any).botInfo;
  if (method === "sendMessage" || method === "editMessageText")
    sent.push({ method, chatId: payload.chat_id, text: payload.text, extra: payload });
  else if (method === "sendPhoto")
    sent.push({ method, chatId: payload.chat_id, text: payload.caption, extra: payload });
  else sent.push({ method, chatId: payload.chat_id, extra: payload });
  return { message_id: sent.length, date: 0, chat: { id: payload.chat_id } };
};

let updateId = 1;
const from = (tid: string) => ({ id: Number(tid), is_bot: false, first_name: "User", language_code: "uk" });
const chat = (tid: string) => ({ id: Number(tid), type: "private" as const });

async function handle(u: Record<string, unknown>): Promise<void> {
  await bot.handleUpdate({ update_id: updateId++, ...u } as any);
}

// Plain text message (drives bot.on("text") / bot.hears).
export function sendText(tid: string, text: string): Promise<void> {
  return handle({ message: { message_id: updateId, date: 0, chat: chat(tid), from: from(tid), text } });
}

// Deep-link / command: "/start <payload>" so Telegraf populates ctx.startPayload.
export function sendStart(tid: string, payload = ""): Promise<void> {
  const text = payload ? `/start ${payload}` : "/start";
  return handle({ message: { message_id: updateId, date: 0, chat: chat(tid), from: from(tid), text, entities: [{ type: "bot_command", offset: 0, length: 6 }] } });
}

// Inline-button press (drives bot.action).
export function pressButton(tid: string, data: string): Promise<void> {
  return handle({ callback_query: { id: String(updateId), from: from(tid), chat_instance: "1", data, message: { message_id: 1, date: 0, chat: chat(tid), from: { id: 1, is_bot: true, first_name: "TestBot" }, text: "…" } } });
}

export { hasTestDb, resetDb, closeDb, db } from "./harness.ts";

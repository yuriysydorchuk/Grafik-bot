import type { DayOfWeek, Shift } from "@workspace/db";

export const DAY_UK: Record<DayOfWeek, string> = {
  mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Нд",
};

export const SHIFT_SHORT: Record<Shift, string> = {
  "1": "1 зміна", "2": "2 зміна", "3": "3 зміна", "4": "4 зміна", "5": "5 зміна", "6": "6 зміна",
};

// Escape text for Telegram HTML parse mode
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Make free-form text (names, company, position) safe to embed in Telegram legacy
// Markdown (parse_mode: "Markdown"). Legacy Markdown has NO escape mechanism, so a
// value containing * _ ` [ ] breaks parsing ("can't parse entities"). We strip
// those entity-starting characters — display-only, the stored data is untouched.
export function mdSafe(text: string | null | undefined): string {
  return String(text ?? "").replace(/[*_`\[\]]/g, "");
}

// Split a message into Telegram-safe chunks (max 4000 chars, split on newlines)
export function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

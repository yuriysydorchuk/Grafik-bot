// Дзеркало web/src/lib/iban.ts: NRB без префікса — «61 1090 1014 …», з країною — «PL61 1090 …».
export function fmtIban(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/\s+/g, "").toUpperCase();
  if (!s) return "";
  if (/^[A-Z]{2}/.test(s)) return s.replace(/(.{4})/g, "$1 ").trim();
  return `${s.slice(0, 2)} ${s.slice(2).replace(/(.{4})/g, "$1 ")}`.trim();
}

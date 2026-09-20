// Показ номера рахунку (рішення власника 20.09.2026): польський NRB без префікса —
// «61 1090 1014 0000 0712 1981 2874» (2 цифри контрольної суми, далі по 4);
// з кодом країни (PL/UA…) — «PL61 1090 1014 …» (по 4 від початку, як друкують банки).
// Те саме на сервері — api-server/src/lib/iban.ts (плейсхолдер format:iban у шаблонах).
export function fmtIban(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/\s+/g, "").toUpperCase();
  if (!s) return "";
  if (/^[A-Z]{2}/.test(s)) return s.replace(/(.{4})/g, "$1 ").trim();
  return `${s.slice(0, 2)} ${s.slice(2).replace(/(.{4})/g, "$1 ")}`.trim();
}

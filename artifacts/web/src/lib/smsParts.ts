// Лічильник частин SMS для панелі — та сама логіка, що на бекенді (services/sms/phone.ts smsParts):
// GSM-7 160/153, будь-який інший знак (кирилиця, ł ą ę ś ż) → UCS-2 70/67, розширені GSM-знаки по 2.
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";
export function smsParts(text: string): { encoding: "GSM-7" | "UCS-2"; chars: number; parts: number } {
  let gsm = true, len = 0;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) len += 1;
    else if (GSM_EXT.includes(ch)) len += 2;
    else { gsm = false; break; }
  }
  if (gsm) return { encoding: "GSM-7", chars: len, parts: len <= 160 ? 1 : Math.ceil(len / 153) };
  const n = [...text].length;
  return { encoding: "UCS-2", chars: n, parts: n <= 70 ? 1 : Math.ceil(n / 67) };
}
export const SMS_STATUS_LABEL: Record<string, string> = {
  queued: "у черзі", sent: "відправлено", delivered: "доставлено", failed: "не доставлено", viewed: "відкрив сторінку", cta: "зацікавлений (обдзвонити)", bot: "у боті", form: "анкета", hired: "на зміні", skipped: "пропущено",
};
export const SMS_STATUS_COLOR: Record<string, "slate" | "green" | "amber" | "blue" | "rose"> = {
  queued: "slate", sent: "slate", delivered: "blue", failed: "rose", viewed: "amber", cta: "amber", bot: "blue", form: "green", hired: "green", skipped: "slate",
};
export const SMS_CAMPAIGN_STATUS: Record<string, { label: string; color: "slate" | "green" | "amber" | "blue" | "rose" }> = {
  draft: { label: "чернетка", color: "slate" }, test: { label: "тест", color: "amber" }, sending: { label: "відправляється", color: "blue" }, paused: { label: "пауза", color: "amber" }, sent: { label: "відправлено", color: "green" }, closed: { label: "закрита", color: "slate" },
};

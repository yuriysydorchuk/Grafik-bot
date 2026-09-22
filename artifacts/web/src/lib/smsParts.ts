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
export const SMS_EVENT_LABEL: Record<string, string> = {
  sent: "SMS відправлено", failed: "SMS не доставлено", delivered: "SMS доставлено", view: "відкрив сторінку", lang: "перемкнув мову",
  open_vacancy: "розгорнув вакансію", open_service: "розгорнув послугу", open_faq: "відкрив питання", interested: "🔥 мене цікавить", interested_ref: "🔥 хочу привести друга", friend: "🎁 порекомендував друга",
  cta_call: "📞 натиснув «подзвонити»", cta_wa: "натиснув WhatsApp", cta_viber: "натиснув Viber", cta_bot: "натиснув Telegram",
  link_maps: "відкрив мапу", link_site: "перейшов на сайт", link_insta: "відкрив Instagram", link_fb: "відкрив Facebook", link_vacancies: "усі вакансії на сайті", link_reviews: "відгуки в Google",
  bot_start: "зайшов у бот", remind: "нагадування в бот", referral_bot: "«приведи друга» в бот",
};

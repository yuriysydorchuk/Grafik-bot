// Телефони для SMS-кампаній: нормалізація в E.164, перевірка «мобільний PL/UA/BY»
// (за діапазонами операторів), підозрілі послідовності, підрахунок частин SMS.
// Ті самі правила, що у звірці Drive-контактів (scratch-drive-build2.py phone_check),
// щоб число «пройшли перевірку» у панелі збігалось із таблицею.

export type PhoneCheck = { type: string; smsOk: "так" | "ні" | "закордон" };

const PL_MOBILE = ["45", "50", "51", "53", "57", "60", "66", "69", "72", "73", "78", "79", "88"];
const UA_MOBILE = ["39", "50", "63", "66", "67", "68", "73", "75", "77", "91", "92", "93", "94", "95", "96", "97", "98", "99"];
const BY_MOBILE = ["25", "29", "33", "44"];

// Код країни → очікувана кількість цифр після нього (лише те, що трапляється в базі).
const CC: Record<string, number> = {
  "48": 9, "380": 9, "375": 9, "7": 10, "995": 9, "370": 8, "371": 8, "372": 7, "373": 8, "374": 8, "994": 9, "998": 9, "996": 9, "992": 9,
  "993": 8, "90": 10, "91": 10, "92": 10, "880": 10, "977": 10, "63": 10, "84": 9, "49": 10, "420": 9, "421": 9, "44": 10, "39": 10, "34": 9,
  "33": 9, "31": 9, "32": 9, "40": 9, "359": 9, "36": 9, "971": 9, "1": 10, "62": 10, "94": 9, "234": 10, "233": 9, "254": 9, "20": 10,
  "212": 9, "216": 8, "355": 9, "381": 9, "385": 9, "386": 8, "43": 10, "41": 9, "46": 9, "47": 8, "45": 8, "358": 9, "351": 9, "30": 10,
  "353": 9, "972": 9, "966": 9, "974": 8, "965": 8, "60": 9, "65": 8, "66": 9, "86": 11, "81": 10, "82": 10, "55": 11, "52": 10, "54": 10,
  "57": 10, "27": 9, "251": 9, "255": 9, "256": 9, "98": 10, "93": 9, "964": 10, "963": 9, "961": 8, "962": 9, "976": 8, "855": 9, "95": 9,
  "263": 9, "260": 9, "265": 9, "250": 9, "257": 8, "213": 9, "58": 10, "51": 9, "56": 9, "593": 9, "970": 9, "252": 8, "249": 9, "237": 9,
  "225": 10, "221": 9, "228": 8, "229": 8, "243": 9, "973": 8, "968": 8,
};

// Будь-який запис («+48 573 000 214», «573000214», «0673000214», «48573000214») → E.164 або null.
export function normalizePhone(raw: string): string | null {
  let s = String(raw ?? "").replace(/[\s().\-]/g, "");
  const plus = s.startsWith("+");
  s = s.replace(/^\+/, "");
  if (s.startsWith("00")) s = s.slice(2);
  if (!/^\d{8,15}$/.test(s)) return null;
  if (plus || s.length > 10) {
    for (const len of [3, 2, 1]) {
      const cc = s.slice(0, len);
      const n = CC[cc];
      if (n && s.length === len + n) return "+" + s;
    }
    return null;
  }
  if (s.length === 9 && PL_MOBILE.includes(s.slice(0, 2))) return "+48" + s;
  if (s.length === 10 && s.startsWith("0") && UA_MOBILE.includes(s.slice(1, 3))) return "+380" + s.slice(1);
  return null;
}

function suspicious(d: string): string {
  if (/(\d)\1{5,}/.test(d)) return "повтор цифри 6+";
  if (/(0123456|1234567|2345678|3456789|9876543|8765432|7654321|6543210)/.test(d)) return "послідовність цифр";
  if (d.endsWith("00000")) return "закінчується на 00000";
  return "";
}

// Тип номера і придатність для SMS (лише мобільні PL/UA/BY йдуть у розсилку).
export function phoneCheck(e164: string): PhoneCheck {
  const d = e164.replace(/^\+/, "");
  if (d.startsWith("48")) {
    const n = d.slice(2);
    if (n.length !== 9 || n.startsWith("0")) return { type: "невалідний PL", smsOk: "ні" };
    const s = suspicious(n); if (s) return { type: `підозрілий (${s})`, smsOk: "ні" };
    if (PL_MOBILE.includes(n.slice(0, 2))) return { type: "мобільний PL", smsOk: "так" };
    if (n.startsWith("70")) return { type: "PL преміум 70x", smsOk: "ні" };
    if (n.startsWith("80")) return { type: "PL безкоштовний 80x", smsOk: "ні" };
    if (n.startsWith("21") || n.startsWith("39")) return { type: "PL VoIP", smsOk: "ні" };
    return { type: "стаціонарний PL", smsOk: "ні" };
  }
  if (d.startsWith("380")) {
    const n = d.slice(3);
    if (n.length !== 9) return { type: "невалідний UA", smsOk: "ні" };
    const s = suspicious(n); if (s) return { type: `підозрілий (${s})`, smsOk: "ні" };
    return UA_MOBILE.includes(n.slice(0, 2)) ? { type: "мобільний UA", smsOk: "так" } : { type: "стаціонарний UA", smsOk: "ні" };
  }
  if (d.startsWith("375")) {
    const n = d.slice(3);
    const s = suspicious(n); if (s) return { type: `підозрілий (${s})`, smsOk: "ні" };
    return BY_MOBILE.includes(n.slice(0, 2)) ? { type: "мобільний BY", smsOk: "так" } : { type: "стаціонарний BY", smsOk: "ні" };
  }
  const s = suspicious(d); if (s) return { type: `підозрілий (${s})`, smsOk: "ні" };
  return { type: "закордонний", smsOk: "закордон" };
}

export const phoneCountry = (e164: string): "PL" | "UA" | "BY" | "other" =>
  e164.startsWith("+48") ? "PL" : e164.startsWith("+380") ? "UA" : e164.startsWith("+375") ? "BY" : "other";

// ── Частини SMS ────────────────────────────────────────────────────────────
// GSM-7: 160 знаків в 1 SMS, далі по 153. Будь-який знак поза GSM-7 (кирилиця, ł ą ę ś ż…)
// переводить ВСЕ повідомлення в UCS-2: 70 / 67. Знаки з розширеної GSM-таблиці рахуються за 2.
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

// Підстановка полів у текст: {імʼя}/{name}/{имя} і {лінк}/{link}/{ссылка}. Без імені — звертання зникає разом з комою.
export function renderSmsText(template: string, vars: { name?: string | null; link: string }): string {
  let t = template;
  const name = (vars.name ?? "").trim();
  t = t.replace(/\{(імʼя|ім'я|імя|name|имя)\}\s*,?\s*/giu, name ? `${name}, ` : "");
  t = t.replace(/\{(лінк|link|ссылка|посилання)\}/giu, vars.link);
  return t.replace(/\s+/g, " ").trim();
}

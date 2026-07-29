// Розпізнавання фактур через Google Document AI (той самий інвойс-процесор, що в
// боті Faktury — проєкт invoice-bot-123, локація eu). Фото/PDF → чернетка фактури:
// постачальник (+NIP), номер, дата виставлення, брутто, наша фірма (по NIP покупця).
// Чисті хелпери мапінгу (entitiesToDraft, sanitizeAmount, …) — під тестами docai.test.ts.
import fs from "node:fs";
import { google } from "googleapis";
import { logger } from "../lib/logger";

// ── Чисті хелпери ──────────────────────────────────────────────────────────────

export type DocAiEntity = {
  type?: string | null;
  mentionText?: string | null;
  confidence?: number | null;
  normalizedValue?: { text?: string | null } | null;
  properties?: DocAiEntity[] | null;
};

export type InvoiceDraft = {
  seller: string | null;
  sellerNip: string | null;
  customerNip: string | null;
  number: string | null;
  issueDate: string | null; // ISO YYYY-MM-DD
  gross: number | null;
  net: number | null;
};

// Польські формати сум: "12 345,67", "12.345,67", "12345.67" → число
export function sanitizeAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d.,\s]/g, "").trim();
  if (!s) return null;
  s = s.replace(/\s/g, "");
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");      // 12.345,67 → 12345.67
  else if (lastDot > lastComma) s = s.replace(/,/g, "");                    // 12,345.67 → 12345.67
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export const normNip = (s: string | null | undefined): string | null => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 10 ? d : null;
};

// "31.07.2026" | "2026-07-31" | "31/07/2026" → ISO
export function normDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return null;
}

const SUPPLIER_TYPES = new Set(["supplier", "seller", "sprzedawca", "wystawca", "dostawca"]);
const CUSTOMER_TYPES = new Set(["buyer", "customer", "receiver", "recipient", "nabywca", "odbiorca"]);

// Мапінг сутностей інвойс-процесора в чернетку (порт flatten_entities з бота Faktury)
export function entitiesToDraft(entities: DocAiEntity[], fullText = ""): InvoiceDraft {
  const best: Record<string, { v: string; conf: number }> = {};
  const keep = (key: string, val: string | null | undefined, conf: number | null | undefined) => {
    const v = (val ?? "").trim();
    if (!v) return;
    if (!best[key] || (conf ?? 0) >= best[key]!.conf) best[key] = { v, conf: conf ?? 0 };
  };
  const valOf = (e: DocAiEntity) => e.normalizedValue?.text || e.mentionText || "";

  for (const ent of entities) {
    const etype = (ent.type ?? "").toLowerCase();
    if (SUPPLIER_TYPES.has(etype) || CUSTOMER_TYPES.has(etype)) {
      const prefix = SUPPLIER_TYPES.has(etype) ? "supplier" : "customer";
      keep(`${prefix}_name`, valOf(ent), ent.confidence);
      for (const p of ent.properties ?? []) {
        const ptype = (p.type ?? "").toLowerCase();
        if (ptype === "name" || ptype === "company_name") keep(`${prefix}_name`, valOf(p), p.confidence);
        if (["tax_id", "vat_id", "vat", "nip"].includes(ptype)) keep(`${prefix}_tax_id`, valOf(p), p.confidence);
      }
      continue;
    }
    if (etype && etype !== "line_item") keep(etype, valOf(ent), ent.confidence);
  }
  const g = (k: string) => best[k]?.v ?? null;

  // дата: normalized ISO від процесора; фолбек — «data wystawienia» у тексті
  let issueDate = normDate(g("invoice_date"));
  if (!issueDate) {
    const m = fullText.match(/wystawieni\w*\D{0,20}?(\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}-\d{2}-\d{2})/i);
    if (m) issueDate = normDate(m[1]);
  }
  // номер: invoice_id; фолбек — рядок після "Faktura (VAT) nr"
  let number = g("invoice_id");
  if (!number) {
    const m = fullText.match(/FAKTURA(?:\s+VAT)?\s*(?:NR|NUMER)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/._ ]{2,30})/i);
    if (m) number = m[1]!.trim().replace(/\s+/g, " ");
  }
  return {
    seller: g("supplier_name"),
    sellerNip: normNip(g("supplier_tax_id")),
    customerNip: normNip(g("customer_tax_id")),
    number: number?.trim() || null,
    issueDate,
    gross: sanitizeAmount(g("total_amount")) ?? sanitizeAmount(g("grand_total")) ?? sanitizeAmount(g("amount_due")),
    net: sanitizeAmount(g("net_amount")) ?? sanitizeAmount(g("subtotal")),
  };
}

// Наша фірма-покупець: NIP покупця з сутностей; фолбек — свій NIP у тексті,
// який НЕ дорівнює NIP-у постачальника.
export function detectOurCompany(
  draft: InvoiceDraft,
  fullText: string,
  companies: { id: number; nip: string | null }[],
): number | null {
  const byNip = new Map(companies.filter(c => normNip(c.nip)).map(c => [normNip(c.nip)!, c.id]));
  if (draft.customerNip && byNip.has(draft.customerNip)) return byNip.get(draft.customerNip)!;
  const found = new Set<number>();
  for (const [nip, id] of byNip) {
    if (nip === draft.sellerNip) continue;
    if (new RegExp(nip.split("").join("[\\s-]?")).test(fullText)) found.add(id);
  }
  return found.size === 1 ? [...found][0]! : null;
}

// ── I/O: виклик Document AI ────────────────────────────────────────────────────
export const docaiConfigured = (): boolean => !!(process.env.DOCAI_PROCESSOR && process.env.GOOGLE_DOCAI_KEY_FILE);

export async function processInvoice(buffer: Buffer, mimeType: string): Promise<{ draft: InvoiceDraft; fullText: string }> {
  const processor = process.env.DOCAI_PROCESSOR;
  const keyFile = process.env.GOOGLE_DOCAI_KEY_FILE;
  if (!processor || !keyFile || !fs.existsSync(keyFile)) throw new Error("Document AI не налаштований (DOCAI_PROCESSOR / GOOGLE_DOCAI_KEY_FILE)");
  const location = processor.match(/locations\/([a-z0-9-]+)\//)?.[1] ?? "eu";
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const res: any = await client.request({
    url: `https://${location}-documentai.googleapis.com/v1/${processor}:process`,
    method: "POST",
    data: { rawDocument: { content: buffer.toString("base64"), mimeType }, skipHumanReview: true },
  });
  const doc = res.data?.document ?? {};
  const fullText: string = doc.text ?? "";
  const draft = entitiesToDraft((doc.entities ?? []) as DocAiEntity[], fullText);
  logger.info({ number: draft.number, gross: draft.gross, sellerNip: draft.sellerNip }, "docai invoice parsed");
  return { draft, fullText };
}
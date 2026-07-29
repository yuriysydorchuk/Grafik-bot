// «📄 Фактура» — скан фактури коштової в боті (порт функціонала бота Faktury):
// офісний адмін шле фото/PDF → Google Document AI → чернетка з інлайн-редактором
// (фірма/постачальник/номер/дата/сума) → збереження в модуль /cost-invoices
// (invoices, source='scan') разом із файлом. Реєструється РАНІШЕ за загальні
// bot.on("photo"/"document"/"text") — тому всі свої хендлери пропускають чужі
// стани далі через next().
import { Markup, type Telegraf } from "telegraf";
import path from "node:path";
import fs from "node:fs";
import { db, companiesTable, adminsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { INVOICES_DIR, makeStoredName } from "../../lib/uploads";
import { setState, getState, clearState } from "../state";
import { getAdmin } from "../roles";
import { t, tb, bhears, oLang, type Lang } from "../i18n";
import { docaiConfigured, processInvoice, detectOurCompany, normDate, sanitizeAmount } from "../../services/docai";
import { createScannedInvoice } from "../../routes/costInvoices";

const cancelKb = (lang: Lang) => Markup.keyboard([[t(lang, "hr.cancel")]]).resize();
const S_FILE = "invoice_scan:file";
const S_EDIT = "invoice_scan:edit"; // data.field = що редагуємо

type ScanDraft = {
  companyId: number | null;
  seller: string | null; sellerNip: string | null;
  number: string | null; issueDate: string | null; gross: number | null;
  fileRel: string; fileName: string;
};

const fmtGross = (g: number | null) => (g == null ? "—" : g.toLocaleString("pl-PL", { minimumFractionDigits: 2 }));

async function activeCompanies() {
  return (await db.select({ id: companiesTable.id, name: companiesTable.name, nip: companiesTable.nip })
    .from(companiesTable).where(eq(companiesTable.isActive, true)))
    .filter(c => ["ES", "ESO", "Klinex"].includes(c.name));
}

function draftText(al: Lang, d: ScanDraft, coName: string | null): string {
  const warn = !d.companyId || !d.number || !d.issueDate || !d.gross ? tb(al, "\n\n⚠️ Заповни поля з «—», інакше не збережеться.") : "";
  return tb(al,
    "📄 Розпізнана фактура:\n\n• Фірма (наша): {co}\n• Постачальник: {seller}\n• NIP постачальника: {nip}\n• Номер: {num}\n• Дата виставлення: {date}\n• Брутто: {gross} zł",
    {
      co: coName ?? "—", seller: d.seller ?? "—", nip: d.sellerNip ?? "—",
      num: d.number ?? "—", date: d.issueDate ?? "—", gross: fmtGross(d.gross),
    }) + warn;
}

function draftKb(al: Lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(tb(al, "🏢 Фірма"), "invsc:co"), Markup.button.callback(tb(al, "🏭 Постачальник"), "invsc:e:seller")],
    [Markup.button.callback(tb(al, "🔢 Номер"), "invsc:e:number"), Markup.button.callback(tb(al, "📅 Дата"), "invsc:e:issueDate")],
    [Markup.button.callback(tb(al, "💰 Сума (брутто)"), "invsc:e:gross"), Markup.button.callback(tb(al, "🧾 NIP"), "invsc:e:sellerNip")],
    [Markup.button.callback(tb(al, "✅ Зберегти"), "invsc:save"), Markup.button.callback(tb(al, "✖️ Скасувати"), "invsc:cancel")],
  ]);
}

async function showDraft(ctx: any, al: Lang, d: ScanDraft) {
  const companies = await activeCompanies();
  const coName = companies.find(c => c.id === d.companyId)?.name ?? null;
  return ctx.reply(draftText(al, d, coName), draftKb(al));
}

const dropTmpFile = (rel: string | undefined) => {
  if (!rel) return;
  const abs = path.resolve(INVOICES_DIR, "..", rel);
  fs.promises.rm(abs, { force: true }).catch(() => {});
};

export function registerInvoiceScan(bot: Telegraf<any>) {
  // старт флоу
  bot.hears(bhears("📄 Фактура"), async (ctx, next) => {
    const tid = String(ctx.from.id);
    const admin = await getAdmin(tid);
    if (!admin) return next();
    const al = oLang(admin);
    if (!docaiConfigured()) return ctx.reply(tb(al, "Сканер не налаштований на цьому сервері."));
    setState(tid, S_FILE, {});
    return ctx.reply(tb(al, "Надішли фото або PDF фактури — розпізнаю і покажу чернетку."), cancelKb(al));
  });

  const handleFile = async (ctx: any, fileId: string, mime: string, fileName: string) => {
    const tid = String(ctx.from.id);
    const admin = await getAdmin(tid);
    if (!admin) return;
    const al = oLang(admin);
    await ctx.reply(tb(al, "🔎 Розпізнаю…"));
    try {
      const link = await ctx.telegram.getFileLink(fileId);
      const buf = Buffer.from(await (await fetch(link.href)).arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) return ctx.reply(tb(al, "Файл завеликий (до 15 МБ)."));
      const { draft, fullText } = await processInvoice(buf, mime);
      const companies = await activeCompanies();
      const companyId = detectOurCompany(draft, fullText, companies);
      // файл зберігаємо одразу (у стані тримаємо лише шлях)
      const stored = makeStoredName(fileName);
      fs.mkdirSync(INVOICES_DIR, { recursive: true });
      fs.writeFileSync(path.join(INVOICES_DIR, stored), buf);
      const d: ScanDraft = {
        companyId, seller: draft.seller, sellerNip: draft.sellerNip,
        number: draft.number, issueDate: draft.issueDate, gross: draft.gross,
        fileRel: path.join("invoices", stored), fileName,
      };
      setState(tid, S_EDIT, { draft: d });
      return showDraft(ctx, al, d);
    } catch (e: any) {
      logger.warn({ err: e?.message }, "invoice scan failed");
      clearState(tid);
      return ctx.reply(tb(al, "Не вдалося розпізнати ({err}). Спробуй ще раз: «📄 Фактура».", { err: String(e?.message ?? e).slice(0, 120) }));
    }
  };

  bot.on("photo", async (ctx, next) => {
    const state = getState(String(ctx.from.id));
    if (state?.action !== S_FILE) return next();
    clearState(String(ctx.from.id));
    const photo = ctx.message.photo.at(-1)!;
    return handleFile(ctx, photo.file_id, "image/jpeg", "scan.jpg");
  });

  bot.on("document", async (ctx, next) => {
    const state = getState(String(ctx.from.id));
    if (state?.action !== S_FILE) return next();
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? "";
    if (!mime.startsWith("image/") && mime !== "application/pdf") {
      const al = oLang(await getAdmin(String(ctx.from.id)));
      return ctx.reply(tb(al, "Потрібен PDF або фото."));
    }
    clearState(String(ctx.from.id));
    return handleFile(ctx, doc.file_id, mime, doc.file_name ?? "scan.pdf");
  });

  // інлайн-редактор
  bot.action(/^invsc:(.+)$/, async (ctx, next) => {
    const tid = String(ctx.from!.id);
    const state = getState(tid);
    if (state?.action !== S_EDIT) { await ctx.answerCbQuery().catch(() => {}); return next(); }
    const d: ScanDraft = state.data.draft;
    const admin = await getAdmin(tid);
    const al = oLang(admin);
    const cmd = (ctx.match as RegExpMatchArray)[1]!;
    await ctx.answerCbQuery().catch(() => {});

    if (cmd === "cancel") {
      dropTmpFile(d.fileRel);
      clearState(tid);
      return ctx.reply(tb(al, "Скасовано."));
    }
    if (cmd === "co") {
      // цикл по фірмах
      const companies = await activeCompanies();
      const idx = companies.findIndex(c => c.id === d.companyId);
      d.companyId = companies[(idx + 1) % companies.length]!.id;
      setState(tid, S_EDIT, { draft: d });
      const coName = companies.find(c => c.id === d.companyId)?.name ?? null;
      return ctx.editMessageText(draftText(al, d, coName), draftKb(al)).catch(() => showDraft(ctx, al, d));
    }
    if (cmd === "save") {
      if (!d.companyId || !d.number || !d.issueDate || !d.gross) {
        return ctx.reply(tb(al, "⚠️ Бракує обовʼязкових полів (фірма, номер, дата, сума) — заповни через кнопки."));
      }
      const [adm] = await db.select({ id: adminsTable.id }).from(adminsTable).where(eq(adminsTable.telegramId, tid));
      const id = await createScannedInvoice({
        companyId: d.companyId, issueDate: d.issueDate, number: d.number,
        seller: d.seller, sellerNip: d.sellerNip, amount: d.gross,
        fileRel: d.fileRel, createdBy: adm?.id ?? null,
      });
      clearState(tid);
      return ctx.reply(tb(al, "✅ Фактуру збережено (№{num}, {gross} zł). Вона вже на сторінці «Фактури» панелі.", { num: d.number, gross: fmtGross(d.gross) }));
    }
    if (cmd.startsWith("e:")) {
      const field = cmd.slice(2);
      setState(tid, S_EDIT, { draft: d, field });
      const prompts: Record<string, string> = {
        seller: "Введи назву постачальника:",
        sellerNip: "Введи NIP постачальника (10 цифр):",
        number: "Введи номер фактури:",
        issueDate: "Введи дату виставлення (дд.мм.рррр):",
        gross: "Введи суму брутто (напр. 1234,56):",
      };
      return ctx.reply(tb(al, prompts[field] ?? "Введи значення:"), cancelKb(al));
    }
    return undefined;
  });

  // текстові відповіді редактора
  bot.on("text", async (ctx, next) => {
    const tid = String(ctx.from.id);
    const state = getState(tid);
    if (state?.action !== S_EDIT || !state.data.field) return next();
    const text = ctx.message.text.trim();
    if (bhears("✖️ Скасувати").includes(text) || text === t("uk", "hr.cancel") || text === t("en", "hr.cancel")) return next(); // глобальний cancel
    const d: ScanDraft = state.data.draft;
    const admin = await getAdmin(tid);
    const al = oLang(admin);
    const field = String(state.data.field);

    if (field === "issueDate") {
      const iso = normDate(text);
      if (!iso) return ctx.reply(tb(al, "Формат дати: дд.мм.рррр (напр. 23.07.2026)"));
      d.issueDate = iso;
    } else if (field === "gross") {
      const n = sanitizeAmount(text);
      if (!n) return ctx.reply(tb(al, "Не схоже на суму. Приклад: 1234,56"));
      d.gross = n;
    } else if (field === "sellerNip") {
      const nip = text.replace(/\D/g, "");
      if (nip.length !== 10) return ctx.reply(tb(al, "NIP — 10 цифр."));
      d.sellerNip = nip;
    } else if (field === "number") {
      if (!text) return ctx.reply(tb(al, "Номер не може бути порожнім."));
      d.number = text;
    } else if (field === "seller") {
      d.seller = text || null;
    }
    setState(tid, S_EDIT, { draft: d });
    return showDraft(ctx, al, d);
  });
}
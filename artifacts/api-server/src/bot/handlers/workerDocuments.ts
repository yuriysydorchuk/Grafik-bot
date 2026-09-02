// «📄 Документи» — самообслуговування працівника (§6 плану worker-docs-signing,
// пункт 4 запиту: «в профілі мають зберігатися всі документи... працівник додає
// їх сам через бота»). Показує список типів документів зі статусами, дозволяє
// самозавантажити фото/PDF (→ status=pending, офіс перевіряє в панелі —
// існуючий модуль WorkerDocuments) і надсилає лінк на веб-анкету (та сама
// сторінка, що після скану паспорта — /passport-scan/:token — просто з
// purpose=anketa одразу відкриває крок анкети, без кроку сканування).
// Анкета раніше була окремим розмовним флоу прямо в чаті (текст+кнопки) —
// прибрано: три паралельні реалізації (веб після скану, панель, бот-чат)
// однієї форми — зайва складність, і в чаті нема пошуку/списків (urząd
// skarbowy, NFZ), як на сайті.
//
// Реєструється РАНІШЕ за глобальний cancel-хендлер (bot.hears(trAll("hr.cancel"))
// в index.ts) — свої photo/document-хендлери пропускають чужі стани й
// команду скасування далі через next() (зразок: invoiceScan.ts, passportScan.ts).
import { Markup, type Telegraf } from "telegraf";
import { db, documentTypesTable, workerDocumentsTable, factoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { setState, getState, clearState } from "../state";
import { getWorker } from "../roles";
import { t, trAll, asLang, type Lang } from "../i18n";
import { workerMenu } from "../menus";
import { applyWorkerDocumentUpload } from "../../services/workerDocuments";
import { createAnketaToken, passportScanLink } from "../../routes/passportScan";

const cancelKb = (lang: Lang) => Markup.keyboard([[t(lang, "hr.cancel")]]).resize();
const S_UPLOAD = "worker_docs:upload"; // data.docTypeId

// Той самий трим меню за налаштуваннями фабрики, що workerMenuFor у index.ts
// (не експортується звідти — уникаємо циклічного імпорту, дублюємо невеликий блок).
async function menuFor(worker: { factoryId?: number | null } | null, lang: Lang) {
  if (!worker?.factoryId) return workerMenu(lang);
  const [f] = await db.select({ availability: factoriesTable.usesAvailability, hours: factoriesTable.showWorkerHours, scheduling: factoriesTable.usesScheduling })
    .from(factoriesTable).where(eq(factoriesTable.id, worker.factoryId));
  return workerMenu(lang, f ? { availability: f.availability && f.scheduling, hours: f.hours } : {});
}

const isExpired = (iso: string | null): boolean => !!iso && new Date(iso + "T00:00:00").getTime() < Date.now();

async function showDocumentsList(ctx: any, workerId: number, lang: Lang) {
  const types = await db.select().from(documentTypesTable).orderBy(documentTypesTable.sortOrder);
  const docs = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.workerId, workerId));
  const byType = new Map(docs.filter(d => d.docTypeId != null).map(d => [d.docTypeId as number, d]));

  if (!types.length) return ctx.reply(t(lang, "docs.title") + "\n\n" + t(lang, "docs.none"));

  const lines: string[] = [t(lang, "docs.title"), ""];
  const buttons: any[][] = [];
  for (const ty of types) {
    const doc = byType.get(ty.id);
    const expired = doc && (doc.status === "expired" || isExpired(doc.expiresAt));
    const status = doc ? (expired ? "expired" : doc.status) : "missing";
    const label = t(lang, `docs.status.${status}`);
    lines.push(`• ${ty.name}${ty.required ? t(lang, "docs.required") : ""} — ${label}`);
    if (status === "missing" || status === "expired") {
      buttons.push([Markup.button.callback(t(lang, "docs.addBtn", { name: ty.name }), `wdoc:up:${ty.id}`)]);
    }
  }
  buttons.push([Markup.button.callback(t(lang, "docs.fillAnketaBtn"), "wdoc:ank")]);
  return ctx.reply(lines.join("\n"), Markup.inlineKeyboard(buttons));
}

export function registerWorkerDocuments(bot: Telegraf<any>) {
  bot.hears(trAll("menu.documents"), async (ctx, next) => {
    const tid = String(ctx.from.id);
    const worker = await getWorker(tid);
    if (!worker) return next();
    return showDocumentsList(ctx, worker.id, asLang(worker.language));
  });

  bot.action(/^wdoc:up:(\d+)$/, async (ctx, next) => {
    const tid = String(ctx.from!.id);
    const worker = await getWorker(tid);
    if (!worker) { await ctx.answerCbQuery().catch(() => {}); return next(); }
    await ctx.answerCbQuery().catch(() => {});
    const lang = asLang(worker.language);
    const docTypeId = Number((ctx.match as RegExpMatchArray)[1]);
    const [ty] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, docTypeId));
    if (!ty) return;
    setState(tid, S_UPLOAD, { docTypeId });
    return ctx.reply(t(lang, "docs.uploadPrompt", { name: ty.name }), cancelKb(lang));
  });

  bot.action("wdoc:ank", async (ctx, next) => {
    const tid = String(ctx.from!.id);
    const worker = await getWorker(tid);
    if (!worker) { await ctx.answerCbQuery().catch(() => {}); return next(); }
    await ctx.answerCbQuery().catch(() => {});
    const lang = asLang(worker.language);
    const token = await createAnketaToken(worker.id);
    return ctx.reply(t(lang, "docs.anketaLink", { link: passportScanLink(token) }));
  });

  const handleUploadFile = async (ctx: any, fileId: string, mime: string, fileName: string) => {
    const tid = String(ctx.from.id);
    const state = getState(tid);
    const docTypeId = Number(state?.data?.docTypeId);
    const worker = await getWorker(tid);
    if (!worker) return;
    const lang = asLang(worker.language);
    clearState(tid);
    try {
      const link = await ctx.telegram.getFileLink(fileId);
      const buf = Buffer.from(await (await fetch(link.href)).arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) return ctx.reply(t(lang, "docs.badFile"));
      const { title } = await applyWorkerDocumentUpload(worker.id, docTypeId, buf, fileName);
      await ctx.reply(t(lang, "docs.saved", { name: title }), await menuFor(worker, lang));
    } catch (e: any) {
      logger.warn({ err: e?.message, workerId: worker.id }, "worker document self-upload failed");
      return ctx.reply(t(lang, "docs.badFile"));
    }
  };

  bot.on("photo", async (ctx, next) => {
    const state = getState(String(ctx.from.id));
    if (state?.action !== S_UPLOAD) return next();
    const photo = ctx.message.photo.at(-1)!;
    return handleUploadFile(ctx, photo.file_id, "image/jpeg", "document.jpg");
  });

  bot.on("document", async (ctx, next) => {
    const state = getState(String(ctx.from.id));
    if (state?.action !== S_UPLOAD) return next();
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? "";
    if (!mime.startsWith("image/") && mime !== "application/pdf") {
      const worker = await getWorker(String(ctx.from.id));
      return ctx.reply(t(asLang(worker?.language), "docs.badFile"));
    }
    return handleUploadFile(ctx, doc.file_id, mime, doc.file_name ?? "document.pdf");
  });
}

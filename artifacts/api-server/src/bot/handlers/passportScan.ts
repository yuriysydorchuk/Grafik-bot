// «🪪 Паспорт» — офісний скан паспорта в боті (cap workerDocs, модуль
// worker-docs-signing у розробці). Два випадки:
// 1) Скан для ІСНУЮЧОГО працівника (доповнити анкету) — досі через бот: адмін
//    обирає працівника (пошук за іменем/кодом через matchWorker), шле фото/PDF
//    → Google Vision API (TEXT_DETECTION) + MRZ-парсер → чернетка анкети (OCR
//    лише ПРОПОНУЄ, офіс підтверджує окремо на сторінці профілю).
// 2) «🆕 Новий кандидат» — фото В ТЕЛЕГРАМ більше НЕ приймається (власник:
//    незручно). Бот видає лінк на публічну веб-сторінку /passport-scan/:token
//    (камера прямо в браузері, рамка-підказка, екран підтвердження з
//    можливістю виправити розпізнане) — routes/passportScan.ts.
// Реєструється РАНІШЕ за загальні bot.on("photo"/"document"/"text") — тому
// свої хендлери пропускають чужі стани далі через next() (зразок:
// bot/handlers/invoiceScan.ts).
import { Markup, type Telegraf } from "telegraf";
import { db, workersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { setState, getState, clearState } from "../state";
import { getAdmin, adminHasCap, adminMenuFor } from "../roles";
import { t, tb, bhears, oLang, type Lang } from "../i18n";
import { matchWorker, type WorkerLike } from "../workerMatch";
import { passportOcrConfigured } from "../../services/docai";
import { applyPassportScan } from "../../routes/contracts";
import { createOfficeScanToken, passportScanLink } from "../../routes/passportScan";

const cancelKb = (lang: Lang) => Markup.keyboard([[t(lang, "hr.cancel")]]).resize();
const S_PICK = "passport_scan:pick";
const S_FILE = "passport_scan:file"; // data.workerId

async function activeWorkers(): Promise<(WorkerLike & { isActive: boolean })[]> {
  return db.select({ id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode, isActive: workersTable.isActive })
    .from(workersTable).where(eq(workersTable.isActive, true));
}

function pickKb(candidates: WorkerLike[]) {
  return Markup.inlineKeyboard(candidates.map(c => [Markup.button.callback(c.fullName, `pscan:pick:${c.id}`)]));
}

export function registerPassportScan(bot: Telegraf<any>) {
  bot.hears(bhears("🪪 Паспорт"), async (ctx, next) => {
    const tid = String(ctx.from.id);
    const admin = await getAdmin(tid);
    if (!admin) return next();
    const al = oLang(admin);
    if (!(await adminHasCap(admin, "workerDocs"))) {
      return ctx.reply(tb(al, "⛔️ Документи й підписання недоступні для твоєї ролі. Доступ вмикає головний адмін у налаштуваннях ролей."), await adminMenuFor(admin, al));
    }
    if (!passportOcrConfigured()) return ctx.reply(tb(al, "OCR паспорта не налаштований на цьому сервері."));
    setState(tid, S_PICK, {});
    await ctx.reply(tb(al, "Кого зі списку скануємо? Введи ім'я або код працівника:"), cancelKb(al));
    return ctx.reply(tb(al, "Або:"), Markup.inlineKeyboard([[Markup.button.callback(tb(al, "🆕 Новий кандидат"), "pscan:new")]]));
  });

  bot.action("pscan:new", async (ctx, next) => {
    const tid = String(ctx.from!.id);
    const state = getState(tid);
    if (state?.action !== S_PICK) { await ctx.answerCbQuery().catch(() => {}); return next(); }
    await ctx.answerCbQuery().catch(() => {});
    clearState(tid);
    const admin = await getAdmin(tid);
    const al = oLang(admin);
    const token = await createOfficeScanToken(admin!.id);
    return ctx.reply(tb(al,
      "📷 Відкрий цю сторінку на телефоні кандидата (чи своєму) — там камера й рамка-підказка для паспорта, дійсна 30 хв:\n{link}\n\nПрофіль створиться автоматично після сканування, я напишу сюди, коли буде готово.",
      { link: passportScanLink(token) }));
  });

  bot.on("text", async (ctx, next) => {
    const tid = String(ctx.from.id);
    const state = getState(tid);
    if (state?.action !== S_PICK) return next();
    const text = ctx.message.text.trim();
    const admin = await getAdmin(tid);
    const al = oLang(admin);
    if (bhears("✖️ Скасувати").includes(text) || text === t("uk", "hr.cancel") || text === t("en", "hr.cancel")) return next(); // глобальний cancel

    const workers = await activeWorkers();
    const { confident, candidates } = matchWorker(text, workers);
    if (confident) {
      setState(tid, S_FILE, { workerId: confident.id });
      return ctx.reply(tb(al, "Обрано: {name}. Надішли фото або PDF паспорта.", { name: confident.fullName }), cancelKb(al));
    }
    if (candidates.length) {
      return ctx.reply(tb(al, "Не впевнений — обери зі списку:"), pickKb(candidates));
    }
    return ctx.reply(tb(al, "Не знайшов такого працівника. Спробуй ще раз, або «✖️ Скасувати»."), cancelKb(al));
  });

  bot.action(/^pscan:pick:(\d+)$/, async (ctx, next) => {
    const tid = String(ctx.from!.id);
    const state = getState(tid);
    if (state?.action !== S_PICK) { await ctx.answerCbQuery().catch(() => {}); return next(); }
    await ctx.answerCbQuery().catch(() => {});
    const workerId = Number((ctx.match as RegExpMatchArray)[1]);
    const admin = await getAdmin(tid);
    const al = oLang(admin);
    const [w] = await db.select({ id: workersTable.id, fullName: workersTable.fullName }).from(workersTable)
      .where(and(eq(workersTable.id, workerId), eq(workersTable.isActive, true)));
    if (!w) return ctx.reply(tb(al, "Працівника не знайдено."));
    setState(tid, S_FILE, { workerId: w.id });
    return ctx.reply(tb(al, "Обрано: {name}. Надішли фото або PDF паспорта.", { name: w.fullName }), cancelKb(al));
  });

  const handleFile = async (ctx: any, fileId: string, mime: string, fileName: string) => {
    const tid = String(ctx.from.id);
    const state = getState(tid);
    const workerId = Number(state?.data?.workerId);
    const admin = await getAdmin(tid);
    if (!admin) return;
    const al = oLang(admin);
    clearState(tid);
    await ctx.reply(tb(al, "🔎 Розпізнаю…"));
    try {
      const link = await ctx.telegram.getFileLink(fileId);
      const buf = Buffer.from(await (await fetch(link.href)).arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) return ctx.reply(tb(al, "Файл завеликий (до 15 МБ)."));

      const { draft, mrz } = await applyPassportScan(workerId, buf, fileName);
      const mrzNote = mrz
        ? (mrz.documentNumberValid && mrz.compositeValid ? tb(al, "\n✅ MRZ-зона валідна (чек-суми збігаються).") : tb(al, "\n⚠️ MRZ-зона знайдена, але чек-суми не збігаються — перевір скан."))
        : "";
      return ctx.reply(tb(al,
        "📄 Розпізнано паспорт:\n\n• Номер: {num}\n• Громадянство: {citz}\n• Дійсний до: {exp}\n\nДані внесено в анкету — перевір і підтверди на сторінці працівника в панелі.{mrz}",
        { num: draft.passportNumber ?? "—", citz: draft.citizenship ?? "—", exp: draft.passportExpiresAt ?? "—", mrz: mrzNote }));
    } catch (e: any) {
      // Стан лишаємо на файл-крок — досить просто надіслати фото ще раз, без
      // перенавігації через меню «🪪 Паспорт».
      setState(tid, S_FILE, { workerId });
      return ctx.reply(tb(al, "Не вдалося розпізнати ({err}). Спробуй надіслати фото ще раз:", { err: String(e?.message ?? e).slice(0, 120) }), cancelKb(al));
    }
  };

  bot.on("photo", async (ctx, next) => {
    const state = getState(String(ctx.from.id));
    if (state?.action !== S_FILE) return next();
    const photo = ctx.message.photo.at(-1)!;
    return handleFile(ctx, photo.file_id, "image/jpeg", "passport.jpg");
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
    return handleFile(ctx, doc.file_id, mime, doc.file_name ?? "passport.pdf");
  });
}

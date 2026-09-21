// SMS-кампанії — панельний API (батч 3). Гейт скоуплений по префіксу (CLAUDE.md).
// Перегляд/створення/імпорт — editData; запуск відправки, тест-SMS і ручний батч — лише
// головний адмін (гроші, незворотно). Імпорт — xlsx з мапінгом колонок (перший крок dry-run).
import { Router, type IRouter } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import XLSX from "xlsx";
import { db, factoriesTable, candidatesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { authRequired, requireCap, requireMainAdmin, type AuthedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  createCampaign, updateCampaign, getCampaign, listCampaigns, setCampaignStatus, importRecipients, campaignStats, campaignCandidateCount,
  listRecipients, recipientEvents, renderForRecipient, recipientLink, smsDashboardSummary, DEFAULT_SCHEDULE, SMS_LANGS, SMS_TOKEN_LEN,
  type ImportRow, type CampaignInput,
} from "../services/sms/campaigns";
import { getSmsProvider, smsLinkBase, SMS_SENDER, type SmsProviderName } from "../services/sms/provider";
import { sendCampaignBatch, sendTestSms, isSmsCampaignInFlight } from "../services/sms/sender";
import { smsParts, normalizePhone } from "../services/sms/phone";
import { notifyActiveWorkersReferral, pendingActiveWorkers } from "../services/sms/automation";

const router: IRouter = Router();
router.use("/sms-campaigns", authRequired, requireCap("editData"));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const me = (req: AuthedRequest) => req.admin?.adminId ?? null;

async function withStats(c: NonNullable<Awaited<ReturnType<typeof getCampaign>>>) {
  const [stats, candidates, activeWorkersPending] = await Promise.all([campaignStats(c), campaignCandidateCount(c.id), pendingActiveWorkers(c.id)]);
  const factoryId = (c.offer as any)?.factoryId;
  const fac = factoryId ? (await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, Number(factoryId))))[0] : null;
  return { ...c, stats, candidates, activeWorkersPending, factoryName: fac?.name ?? null, inFlight: isSmsCampaignInFlight(c.id) };
}

router.get("/sms-campaigns", async (_req, res) => {
  const list = await listCampaigns();
  res.json({ campaigns: await Promise.all(list.map(withStats)), summary: await smsDashboardSummary() });
});

router.get("/sms-campaigns/settings", async (_req, res) => {
  res.json({
    providers: (["smsapi", "smsfly"] as SmsProviderName[]).map((n) => { const p = getSmsProvider(n); return { name: n, configured: p.configured(), pricePl: p.price("+48500000000"), priceUa: p.price("+380500000000") }; }),
    sender: SMS_SENDER(), linkBase: smsLinkBase(), defaults: DEFAULT_SCHEDULE, langs: SMS_LANGS, officePhone: process.env.SMS_OFFICE_PHONE || "",
  });
});

router.post("/sms-campaigns", async (req, res) => {
  const b = req.body ?? {};
  if (!String(b.name ?? "").trim()) { res.status(400).json({ error: "Вкажіть назву кампанії" }); return; }
  const c = await createCampaign(b as CampaignInput, me(req as AuthedRequest));
  res.json(await withStats(c));
});

router.get("/sms-campaigns/:id", async (req, res) => {
  const c = await getCampaign(Number(req.params.id));
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  res.json(await withStats(c));
});

router.patch("/sms-campaigns/:id", async (req, res) => {
  const c = await updateCampaign(Number(req.params.id), req.body ?? {});
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  res.json(await withStats(c));
});

// Прев'ю тексту для мови: підстановка імені/лінка + частини SMS (лічильник у модалці рахує так само, як провайдер).
router.post("/sms-campaigns/preview-text", async (req, res) => {
  const text = String(req.body?.text ?? "");
  const rendered = text.replace(/\{(імʼя|ім'я|імя|name|имя)\}/giu, String(req.body?.name ?? "Oksana")).replace(/\{(лінк|link|ссылка|посилання)\}/giu, `${smsLinkBase()}/r/${"7KQ2M9X1".slice(0, SMS_TOKEN_LEN)}`);
  res.json({ rendered, ...smsParts(rendered) });
});

// ── Імпорт з xlsx: крок 1 (dry=1) — колонки, вгадане зіставлення, підсумок; крок 2 — запис ─
const GUESS: Record<string, RegExp> = {
  phone: /^(телефон|phone|tel|numer|номер)/i, name: /^(повне імʼя|імʼя прізвище|імʼя|імя|імʼя$|name|imię|imie|піб|фио)/i, lastName: /^(прізвище|nazwisko|surname)/i,
  lang: /^(мова|lang|język)/i, segment: /^(хто це|сегмент|segment|категорія)/i, year: /^(рік|year|від коли)/i,
};
router.post("/sms-campaigns/:id/import", upload.single("file"), async (req, res) => {
  const id = Number(req.params.id);
  const c = await getCampaign(id);
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  if (!req.file) { res.status(400).json({ error: "Файл не отримано" }); return; }
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(req.file.buffer, { type: "buffer" }); } catch { res.status(400).json({ error: "Не вдалося прочитати xlsx" }); return; }
  const wanted = String(req.body?.sheet ?? "");
  const sheetName = wb.SheetNames.includes(wanted) ? wanted : (wb.SheetNames.find((n) => /перевірен|телефон|phones/i.test(n)) ?? wb.SheetNames[0]!);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName]!, { defval: "" });
  const columns = rows.length ? Object.keys(rows[0]!) : [];
  const guessed: Record<string, string> = {};
  for (const [field, re] of Object.entries(GUESS)) { const col = columns.find((cn) => re.test(cn.trim())); if (col) guessed[field] = col; }
  let mapping: Record<string, string> = {};
  try { mapping = req.body?.mapping ? JSON.parse(req.body.mapping) : {}; } catch { /* ignore */ }
  const map = { ...guessed, ...mapping };
  const dry = req.body?.dry === "1" || req.body?.dry === "true";
  if (!map.phone) { res.json({ sheet: sheetName, sheets: wb.SheetNames, columns, guessed, total: rows.length, sample: rows.slice(0, 5), error: "Не знайдено колонку з телефоном — оберіть її вручну" }); return; }
  const opts = { includeUa: req.body?.includeUa === "1", uaMinYear: Number(req.body?.uaMinYear) || 2024, skipAlreadySent: req.body?.skipAlreadySent !== "0", dry };
  const yearsOk = (req.body?.years ? String(req.body.years).split(",").map(Number).filter(Number.isFinite) : []);
  const langsOk = (req.body?.langs ? String(req.body.langs).split(",").filter(Boolean) : []);
  const segOk = (req.body?.segments ? String(req.body.segments).split("|").filter(Boolean) : []);
  const items: ImportRow[] = [];
  let filteredOut = 0;
  for (const r of rows) {
    const year = map.year ? Number(String(r[map.year] ?? "").slice(0, 4)) : null;
    const lang = map.lang ? String(r[map.lang] ?? "") : "";
    const seg = map.segment ? String(r[map.segment] ?? "") : "";
    if ((yearsOk.length && !(year && yearsOk.includes(year))) || (langsOk.length && !langsOk.some((l) => lang.toLowerCase().startsWith(l))) || (segOk.length && !segOk.some((s) => seg.startsWith(s)))) { filteredOut++; continue; }
    const name = [r[map.name], map.lastName ? r[map.lastName] : ""].map((v) => String(v ?? "").trim()).filter(Boolean).join(" ");
    items.push({ phone: String(r[map.phone] ?? ""), name, lang, segment: seg, year: Number.isFinite(year as number) ? year : null, sourceFile: `${req.file.originalname} · ${sheetName}` });
  }
  const summary = await importRecipients(id, items, opts);
  res.json({ sheet: sheetName, sheets: wb.SheetNames, columns, guessed, mapping: map, total: rows.length, filteredOut, summary, dry });
});

router.get("/sms-campaigns/:id/recipients", async (req, res) => {
  const r = await listRecipients(Number(req.params.id), {
    status: String(req.query.status ?? "") || undefined, lang: String(req.query.lang ?? "") || undefined, q: String(req.query.q ?? "").trim() || undefined,
    limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0,
  });
  const candIds = r.rows.map((x) => x.candidateId).filter((x): x is number => !!x);
  const cands = candIds.length ? await db.select({ id: candidatesTable.id, stage: candidatesTable.stage }).from(candidatesTable).where(inArray(candidatesTable.id, candIds)) : [];
  const stage = new Map(cands.map((x) => [x.id, x.stage]));
  res.json({ total: r.total, rows: r.rows.map((x) => ({ ...x, link: recipientLink(x.token), candidateStage: x.candidateId ? stage.get(x.candidateId) ?? null : null })) });
});

router.get("/sms-campaigns/:id/recipients/:rid/events", async (req, res) => {
  res.json(await recipientEvents(Number(req.params.rid)));
});

// Експорт отримувачів зі статусами (звірка з кабінетом провайдера).
router.get("/sms-campaigns/:id/export.xlsx", async (req, res) => {
  const c = await getCampaign(Number(req.params.id));
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  const status = String(req.query.status ?? "") || undefined;
  const { rows } = await listRecipients(c.id, { limit: 100000, status });
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(status === "cta" ? "Zainteresowani" : "Odbiorcy");
  ws.columns = [
    { header: "Telefon", key: "phone", width: 16 }, { header: "Imię i nazwisko", key: "name", width: 28 }, { header: "Język", key: "lang", width: 6 }, { header: "Segment", key: "segment", width: 22 },
    { header: "Rok", key: "year", width: 6 }, { header: "Status", key: "status", width: 12 }, { header: "Powód pominięcia", key: "skippedReason", width: 16 }, { header: "Wysłano", key: "sentAt", width: 18 },
    { header: "Dostarczono", key: "deliveredAt", width: 18 }, { header: "Błąd", key: "failReason", width: 24 }, { header: "Otwarto stronę", key: "viewedAt", width: 18 }, { header: "W bocie", key: "botAt", width: 18 },
    { header: "Części SMS", key: "parts", width: 8 }, { header: "ID u dostawcy", key: "providerMsgId", width: 18 }, { header: "Link", key: "link", width: 40 },
  ];
  for (const r of rows) ws.addRow({ ...r, name: (r.name ?? "").toLocaleUpperCase("pl-PL"), link: recipientLink(r.token) });
  ws.getRow(1).font = { bold: true };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`SMS-${c.name}.xlsx`)}`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

// ── Стани: запуск/тест — головний адмін; пауза/закриття — editData ───────────
router.post("/sms-campaigns/:id/start", requireMainAdmin, async (req, res) => {
  const c = await getCampaign(Number(req.params.id));
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  const mode = req.body?.mode === "test" ? "test" : "sending";
  const texts = c.texts as Record<string, string>;
  if (!texts.uk && !texts.ru && !texts.en) { res.status(400).json({ error: "Немає тексту SMS" }); return; }
  if (!getSmsProvider(c.provider as SmsProviderName).configured()) { res.status(400).json({ error: `Провайдер ${c.provider} не налаштований (ключ у .env)` }); return; }
  const stats = await campaignStats(c);
  if (!stats.queued) { res.status(400).json({ error: "Черга порожня — імпортуйте отримувачів" }); return; }
  const updated = await setCampaignStatus(c.id, mode);
  logger.info({ campaignId: c.id, mode, by: me(req as AuthedRequest) }, "SMS campaign started");
  res.json(await withStats(updated!));
});
// «Приведи друга» активним працівникам з імпорту — через бот (реферальна розсилка з чинними умовами), не SMS.
router.post("/sms-campaigns/:id/referral-active", async (req, res) => {
  const c = await getCampaign(Number(req.params.id));
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  try { res.json(await notifyActiveWorkersReferral(c.id)); }
  catch (e: any) {
    if (e?.message === "campaign_in_progress") { res.status(409).json({ error: "Реферальна розсилка вже триває — зачекайте" }); return; }
    throw e;
  }
});

router.post("/sms-campaigns/:id/pause", async (req, res) => {
  const c = await setCampaignStatus(Number(req.params.id), "paused");
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  res.json(await withStats(c));
});
router.post("/sms-campaigns/:id/close", async (req, res) => {
  const c = await setCampaignStatus(Number(req.params.id), "closed");
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  res.json(await withStats(c));
});
// Ручний батч поза вікном (лише головний адмін): тест-кампанія на 300 або догнати чергу.
router.post("/sms-campaigns/:id/send-batch", requireMainAdmin, async (req, res) => {
  const c = await getCampaign(Number(req.params.id));
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  if (!["sending", "test", "paused"].includes(c.status)) { res.status(400).json({ error: "Спершу запустіть кампанію" }); return; }
  const r = await sendCampaignBatch(c, { force: true, limit: Number(req.body?.limit) || undefined });
  res.json(r);
});
router.post("/sms-campaigns/:id/test-sms", requireMainAdmin, async (req, res) => {
  const c = await getCampaign(Number(req.params.id));
  if (!c) { res.status(404).json({ error: "Кампанію не знайдено" }); return; }
  const phone = normalizePhone(String(req.body?.phone ?? ""));
  if (!phone) { res.status(400).json({ error: "Невалідний номер" }); return; }
  const r = await sendTestSms(c, phone, String(req.body?.lang ?? "uk"), String(req.body?.name ?? "Test"));
  res.json(r);
});

export default router;

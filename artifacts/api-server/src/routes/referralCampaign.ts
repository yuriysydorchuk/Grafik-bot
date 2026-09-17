// Рекрутинг-кампанія «приведи друга» — API для сторінки /broadcast (вкладка «Кампанія»).
// Гейт скоуплений по префіксу (CLAUDE.md: голий router.use(requireCap) зачіпає сусідні роутери).
import { Router, type IRouter } from "express";
import { authRequired, requireCap } from "../lib/auth";
import { asLang, LANGS } from "../bot/i18n";
import {
  REFERRAL_CAMPAIGN_DEFAULTS, campaignRecipients, parseCampaignParams, renderCampaign, sendReferralCampaign, isCampaignInProgress,
} from "../services/referralCampaign";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use("/referral-campaign", authRequired, requireCap("editData"));

// Дефолтні параметри + адресати з прапорцями (офіс/адмін/звільнений) — веб сам збирає список.
router.get("/referral-campaign", async (_req, res) => {
  const recipients = await campaignRecipients();
  res.json({ defaults: REFERRAL_CAMPAIGN_DEFAULTS, languages: LANGS, recipients });
});

// Прев'ю обох повідомлень мовою `lang` для умовного адресата (активний/звільнений).
router.post("/referral-campaign/preview", async (req, res) => {
  const p = parseCampaignParams(req.body?.params);
  const lang = asLang(req.body?.lang);
  const isActive = req.body?.isActive !== false;
  const r = renderCampaign(lang, p, { fullName: "Jan Kowalski", firstName: "Jan", isActive }, "ES-7K3MX", process.env.TELEGRAM_BOT_USERNAME);
  res.json(r);
});

// Відправка обраним. Реальні повідомлення людям — лише з панелі після підтвердження.
router.post("/referral-campaign/send", async (req, res) => {
  const ids: number[] = Array.isArray(req.body?.workerIds) ? req.body.workerIds.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) { res.status(400).json({ error: "Оберіть отримувачів" }); return; }
  if (isCampaignInProgress()) { res.status(409).json({ error: "Розсилка вже триває — зачекайте її завершення" }); return; }
  const p = parseCampaignParams(req.body?.params);
  try {
    const r = await sendReferralCampaign(ids, p);
    logger.info({ notified: r.notified, skipped: r.skipped, failed: r.failed.length }, "referral campaign sent");
    res.json(r);
  } catch (e) {
    logger.error({ err: e }, "referral campaign failed");
    res.status(500).json({ error: "Помилка розсилки" });
  }
});

export default router;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import adminApiRouter from "./admin-api";
import bankRouter from "./bank";
import cashRouter from "./cash";
import cashflowRouter from "./cashflow";
import cfoRouter from "./cfo";
import obligationsRouter from "./obligations";
import invoicesRouter from "./invoices";
import costInvoicesRouter from "./costInvoices";
import agreementsRouter from "./agreements";
import pnlRouter from "./pnl";
import analyticsRouter from "./analytics";
import payrollRouter from "./payroll";
import svodniRouter from "./svodni";
import hostelsRouter from "./hostels";
import penaltiesRouter from "./penalties";
import ksefRouter from "./ksef";
import cleaningRouter from "./cleaning";
import fuelRouter from "./fuel";
import securityRouter from "./security";
import fleetRouter from "./fleet";
import transportRouter from "./transport";
import clothingRouter from "./clothing";
import gratyfikantRouter from "./gratyfikant";
import contractsRouter from "./contracts";
import documentTemplatesRouter from "./documentTemplates";
import legalizationRouter from "./legalization";
import documentDeliveryRouter from "./documentDelivery";
import residenceCardScanRouter from "./residenceCardScan";
import signRouter from "./sign";
import passportScanRouter from "./passportScan";

const router: IRouter = Router();

router.use(healthRouter);
// Публічні токен-роути підписання — БЕЗ authRequired (§5 плану worker-docs-
// signing), свій rate-limit у sign.ts. МУСИТЬ монтуватись РАНІШЕ за будь-який
// роутер з неупакованим router.use(authRequired)/requireCap(...) (fleet,
// transport, svodni, contracts, …) — інакше їхній блоковий гейт перехоплює
// /sign/* запити раніше, ніж вони дістануться сюди, і 401-ить публічну
// сторінку (саме так і сталося при першому підключенні — фіксовано тестом).
router.use(signRouter);
router.use(passportScanRouter);
router.use(authRouter);
router.use(adminApiRouter);
router.use(fleetRouter);
router.use(transportRouter);
router.use(clothingRouter);
router.use(gratyfikantRouter);
// Авторизаційні use-гейти фінансових роутерів скоуплені по префіксах шляхів
// (напр. router.use("/bank", requireCap(...))) — неупакований router.use() в Express
// зачіпав би і прохідні запити до всіх роутерів, змонтованих нижче (латентний баг
// до 12.08.2026: роль без viewFinance не діставалась до /cash, /cost-invoices, /fuel)
router.use(svodniRouter);
router.use(hostelsRouter);
router.use(penaltiesRouter);
router.use(bankRouter);
router.use(cashRouter);
router.use(cashflowRouter);
router.use(cfoRouter);
router.use(obligationsRouter);
router.use(invoicesRouter);
router.use(costInvoicesRouter);
router.use(agreementsRouter);
router.use(pnlRouter);
router.use(analyticsRouter);
router.use(payrollRouter);
router.use(ksefRouter);
router.use(cleaningRouter);
router.use(fuelRouter);
router.use(securityRouter);
router.use(contractsRouter);
router.use(documentTemplatesRouter);
router.use(legalizationRouter);
router.use(documentDeliveryRouter);
router.use(residenceCardScanRouter);

export default router;

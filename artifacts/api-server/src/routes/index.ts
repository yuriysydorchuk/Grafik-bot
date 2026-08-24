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
import pnlRouter from "./pnl";
import analyticsRouter from "./analytics";
import payrollRouter from "./payroll";
import svodniRouter from "./svodni";
import hostelsRouter from "./hostels";
import penaltiesRouter from "./penalties";
import ksefRouter from "./ksef";
import fuelRouter from "./fuel";
import securityRouter from "./security";
import fleetRouter from "./fleet";
import transportRouter from "./transport";
import clothingRouter from "./clothing";
import gratyfikantRouter from "./gratyfikant";

const router: IRouter = Router();

router.use(healthRouter);
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
router.use(pnlRouter);
router.use(analyticsRouter);
router.use(payrollRouter);
router.use(ksefRouter);
router.use(fuelRouter);
router.use(securityRouter);

export default router;

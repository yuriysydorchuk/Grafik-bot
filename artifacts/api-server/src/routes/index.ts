import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import adminApiRouter from "./admin-api";
import bankRouter from "./bank";
import cashRouter from "./cash";
import cashflowRouter from "./cashflow";
import obligationsRouter from "./obligations";
import invoicesRouter from "./invoices";
import pnlRouter from "./pnl";
import payrollRouter from "./payroll";
import svodniRouter from "./svodni";
import ksefRouter from "./ksef";
import securityRouter from "./security";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(adminApiRouter);
// ВАЖЛИВО: до фінансових роутерів — ті вішають глобальні use-гейти (viewFinance/owner),
// які в Express зачепили б і всі наступні роутери
router.use(svodniRouter);
router.use(bankRouter);
router.use(cashRouter);
router.use(cashflowRouter);
router.use(obligationsRouter);
router.use(invoicesRouter);
router.use(pnlRouter);
router.use(payrollRouter);
router.use(ksefRouter);
router.use(securityRouter);

export default router;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import adminApiRouter from "./admin-api";
import bankRouter from "./bank";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(adminApiRouter);
router.use(bankRouter);

export default router;

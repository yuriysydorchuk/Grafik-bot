import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import adminApiRouter from "./admin-api";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(adminApiRouter);

export default router;

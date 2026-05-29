import { Router, type IRouter } from "express";
import { bot } from "../bot";

const router: IRouter = Router();

router.post("/webhook", async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch {
    res.sendStatus(500);
  }
});

export default router;

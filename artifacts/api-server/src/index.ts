import app from "./app";
import { logger } from "./lib/logger";
import { bot } from "./bot";
import { setBotLaunched } from "./bot/instance";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { loadStates } from "./bot/state";
import { ensureUploadDirs } from "./lib/uploads";
import { sendAlert, sendStartupAlert } from "./lib/alerts";
import { ensureReferralFunnel, backfillOrphanReferralCandidates } from "./services/funnels";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  // Global safety nets — log + best-effort alert.
  // unhandledRejection: keep running; uncaughtException: exit so pm2 restarts.
  process.on("unhandledRejection", (reason: any) => {
    logger.error({ err: reason }, "unhandledRejection");
    void sendAlert({ service: "process", kind: "unhandledRejection", message: reason?.message ?? String(reason) });
  });
  process.on("uncaughtException", (err: any) => {
    logger.fatal({ err }, "uncaughtException — exiting for pm2 restart");
    const hardExit = setTimeout(() => process.exit(1), 3000);
    hardExit.unref?.();
    void sendAlert({ service: "process", kind: "uncaughtException", message: err?.message ?? String(err), fatal: true })
      .catch(() => {})
      .finally(() => process.exit(1));
  });

  app.listen(port, async (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");

    // Ensure local upload directories exist (worker documents, etc.)
    ensureUploadDirs();

    // The referral funnel is built-in and must exist, else referral candidates
    // land with funnel_id = null and never show on the board. Ensure + self-heal.
    try {
      const refFunnelId = await ensureReferralFunnel();
      await backfillOrphanReferralCandidates(refFunnelId);
    } catch (e) {
      logger.error({ err: e }, "ensureReferralFunnel failed");
    }

    // Restore persisted conversation states so in-progress flows survive restarts
    await loadStates();

    // Мінімальна ставка року для сводних (налаштування) — в кеш формул
    void import("./services/svodniSettings").then(m => m.loadKsiegMinRates());

    // Start bot in polling mode — bot.launch() returns a Promise that only
    // resolves when polling stops, so we must not await it here.
    bot.launch().catch((e) => {
      setBotLaunched(false);
      logger.error({ err: e }, "Telegram bot polling error");
    });
    setBotLaunched(true); // optimistic; flipped to false above if launch rejects
    logger.info("Telegram bot started in polling mode");

    // Start weekly reminder scheduler (every Sunday at 18:00 Kyiv time)
    startScheduler();

    // Startup alert (no-op unless ALERTS_ENABLED=true) — surfaces pm2 restarts.
    void sendStartupAlert();
  });

  // Graceful shutdown
  process.once("SIGINT", () => {
    logger.info("SIGINT received, shutting down");
    stopScheduler();
    bot.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down");
    stopScheduler();
    bot.stop("SIGTERM");
  });
}

// Разові сервісні команди без підняття сервера/бота (прод: node dist/index.mjs <cmd>).
//   archive-invoices --month=YYYY-MM [--kind=sale|purchase] [--dry]  — залити/розкласти архів фактур місяця на Drive
//   (relocate: вже залиті звіряються з поточною структурою папок; --dry — лише план)
async function cli(argv: string[]): Promise<boolean> {
  const [cmd, ...rest] = argv;
  if (cmd !== "archive-invoices") return false;
  const month = rest.find(a => a.startsWith("--month="))?.slice(8);
  const kindArg = rest.find(a => a.startsWith("--kind="))?.slice(7);
  const kind = kindArg === "sale" || kindArg === "purchase" ? kindArg : undefined;
  if (!month || !/^\d{4}-\d{2}$/.test(month) || (kindArg && !kind)) throw new Error("usage: archive-invoices --month=YYYY-MM [--kind=sale|purchase] [--dry]");
  const { archiveInvoicesToDrive } = await import("./services/invoiceArchive");
  const r = await archiveInvoicesToDrive({ month, kind, relocate: true, dryRun: rest.includes("--dry") });
  for (const line of r.plan ?? []) console.log(line);
  console.log(JSON.stringify({ ...r, plan: undefined }));
  return true;
}

cli(process.argv.slice(2)).then((handled) => {
  if (handled) process.exit(0);
  return main();
}).catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});

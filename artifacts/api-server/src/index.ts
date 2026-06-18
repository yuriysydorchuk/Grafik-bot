import app from "./app";
import { logger } from "./lib/logger";
import { bot } from "./bot";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { loadStates } from "./bot/state";
import { ensureUploadDirs } from "./lib/uploads";

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
  app.listen(port, async (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");

    // Ensure local upload directories exist (worker documents, etc.)
    ensureUploadDirs();

    // Restore persisted conversation states so in-progress flows survive restarts
    await loadStates();

    // Start bot in polling mode — bot.launch() returns a Promise that only
    // resolves when polling stops, so we must not await it here.
    bot.launch().catch((e) => {
      logger.error({ err: e }, "Telegram bot polling error");
    });
    logger.info("Telegram bot started in polling mode");

    // Start weekly reminder scheduler (every Sunday at 18:00 Kyiv time)
    startScheduler();
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

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});

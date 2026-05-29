import app from "./app";
import { logger } from "./lib/logger";
import { bot } from "./bot";

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

    // Start bot in polling mode (no webhook needed for development)
    try {
      await bot.launch();
      logger.info("Telegram bot started in polling mode");
    } catch (e) {
      logger.error({ err: e }, "Failed to start Telegram bot");
    }
  });

  // Graceful shutdown
  process.once("SIGINT", () => {
    logger.info("SIGINT received, shutting down bot");
    bot.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down bot");
    bot.stop("SIGTERM");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});

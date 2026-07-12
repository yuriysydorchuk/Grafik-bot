// Side-effect-only module. Imported FIRST by the integration harness so the DB client and
// the Express app read the right env at module-evaluation time (ESM evaluates imported
// modules depth-first in source order, so this runs before any `@workspace/db` import).
//
// Integration tests run ONLY when TEST_DATABASE_URL is set, and they force DATABASE_URL to
// point at THAT database — never at whatever DATABASE_URL a developer happens to have
// exported (which could be real dev data). Without TEST_DATABASE_URL the tests self-skip.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
// The Telegraf instance requires a token at construction (no network — launch is never
// called in tests). A dummy value is enough for the routes under test.
process.env.TELEGRAM_BOT_TOKEN ||= "test:integration";
// Keep the session secret deterministic across the app and the cookie minted in tests.
process.env.SESSION_SECRET ||= "integration-test-secret";
// Silence request logging noise during tests unless explicitly overridden.
process.env.LOG_LEVEL ||= "silent";
// Skip the external geo lookup (best-effort network call) during tests.
process.env.GEOIP_ENABLED ||= "0";
// Keep uploaded test files out of the repo tree.
process.env.UPLOADS_DIR ||= "/tmp/grafik-test-uploads";

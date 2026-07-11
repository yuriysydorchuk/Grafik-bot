import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sendAlert } from "./lib/alerts";

const app: Express = express();

// Behind a reverse proxy (Nginx/Caddy) in production — needed for correct client IP
// (rate limiting) and for `secure` cookies to be set over the proxied HTTPS connection.
app.set("trust proxy", 1);

// Security headers. CSP is disabled to avoid breaking the SPA's inline styles;
// HSTS and the rest apply (HSTS is only emitted over HTTPS).
app.use(helmet({ contentSecurityPolicy: false }));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// The panel is served same-origin by this server, so cross-origin requests are
// blocked by default. Set CORS_ORIGINS (comma-separated) only if you need them.
const corsOrigins = process.env.CORS_ORIGINS?.split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins?.length ? corsOrigins : false, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CSRF defense-in-depth: state-changing requests must carry a custom header the
// browser only lets same-origin JS set (a cross-site <form> POST cannot). SameSite=Lax
// already blocks most cross-site cookie sends; this closes the residual gap without a
// token round-trip. Login/2FA are exempt — they run before a session cookie exists.
app.use("/api", (req, res, next) => {
  const unsafe = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  const authPost = req.path === "/auth/login" || req.path === "/auth/verify-2fa";
  if (unsafe && !authPost && req.get("X-Requested-With") !== "grafik") {
    return res.status(403).json({ error: "csrf" });
  }
  return next();
});

app.use("/api", router);

// ─── Serve the built web panel (artifacts/web/dist) ────────────────────────────
const webDist = process.env.WEB_DIST
  ? path.resolve(process.env.WEB_DIST)
  : path.resolve(process.cwd(), "artifacts/web/dist");

if (fs.existsSync(path.join(webDist, "index.html"))) {
  app.use(express.static(webDist));
  // SPA fallback: any non-API GET serves index.html
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
  logger.info({ webDist }, "Serving web panel");
} else {
  logger.warn({ webDist }, "Web panel build not found — run `pnpm --filter @workspace/web build`");
}

// ─── Global API error handler (must be registered last) ─────────────────────────
// Express 5 forwards errors from async route handlers here. Logs the full error
// (with stack) to pino, fires a short best-effort alert, and returns a generic
// 500 — the client never sees stack traces or internal details.
const errorHandler: express.ErrorRequestHandler = (err, req, res, _next) => {
  const path = req.url?.split("?")[0];
  logger.error({ err, method: req.method, url: path }, "unhandled API error");
  void sendAlert({ service: "api", kind: (err as any)?.name, source: `${req.method} ${path}`, message: (err as any)?.message });
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

export default app;

import type { Request } from "express";
import { logger } from "./logger";

// Client IP — relies on app.set("trust proxy", 1) so req.ip is the real client behind Caddy.
export function clientIp(req: Request): string | null {
  return (req.ip || (req.socket && req.socket.remoteAddress) || null) as string | null;
}

// Tiny User-Agent → "Browser на OS" label. Deliberately dependency-free and best-effort
// (an admin panel doesn't need pixel-perfect UA parsing).
export function parseDevice(ua: string | undefined | null): string | null {
  if (!ua) return null;
  const os =
    /Windows/i.test(ua) ? "Windows" :
    /iPhone|iPad|iPod/i.test(ua) ? "iOS" :
    /Android/i.test(ua) ? "Android" :
    /Mac OS X|Macintosh/i.test(ua) ? "macOS" :
    /Linux/i.test(ua) ? "Linux" : null;
  const browser =
    /Edg\//i.test(ua) ? "Edge" :
    /OPR\/|Opera/i.test(ua) ? "Opera" :
    /Chrome\//i.test(ua) ? "Chrome" :
    /Firefox\//i.test(ua) ? "Firefox" :
    /Safari\//i.test(ua) ? "Safari" : null;
  if (browser && os) return `${browser} на ${os}`;
  return browser || os || ua.slice(0, 40);
}

// A private / loopback address never resolves to a public location — skip the lookup.
// Exported for testing: this predicate gates the outbound geo lookup (SSRF-adjacent).
export function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/, "");
  return (
    v === "127.0.0.1" || v === "::1" || v === "localhost" ||
    /^10\./.test(v) || /^192\.168\./.test(v) || /^169\.254\./.test(v) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^f[cd]/i.test(v)
  );
}

// Best-effort city/country from IP via a keyless HTTPS service. Never throws, short timeout;
// returns null on any failure, for private IPs, or when disabled via GEOIP_ENABLED=0.
export async function lookupGeo(ip: string | null | undefined): Promise<string | null> {
  const flag = (process.env.GEOIP_ENABLED ?? "1").toLowerCase();
  if (flag === "0" || flag === "false") return null;
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, "");
  if (isPrivateIp(clean)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(clean)}?fields=success,city,country`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { success?: boolean; city?: string; country?: string };
    if (!data?.success) return null;
    const parts = [data.city, data.country].filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  } catch (e) {
    logger.debug({ err: e }, "geoip lookup failed");
    return null;
  }
}

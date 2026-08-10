// Здоровʼя сервера: 15-хвилинний семплінг CPU/RAM + тижневий дайджест власнику в бот.
// Семпли живуть у settings ролінг-вікном 7 днів (переживають рестарти pm2, без зміни
// схеми БД). Диск/розмір БД/uploads міряються в момент звіту; критично заповнений
// диск (≥90%) алертиться одразу з семплінгу — переповнення кладе і БД, і бекапи.
// `sendAlert`/`bot` імпортуються ліниво: їх модулі кидають без TELEGRAM_BOT_TOKEN,
// а чисті функції звідси ганяє юніт-тест без бот-оточення.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, settingsTable, adminsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { UPLOADS_ROOT } from "../lib/uploads";
import { warsawDateStr } from "../bot/time";

// t = epoch-секунди; l = 1-хв loadavg; ma/mt = MemAvailable/MemTotal у МБ
export type StatSample = { t: number; l: number; ma: number; mt: number };

const SAMPLES_KEY = "server_stats_samples";
const WINDOW_DAYS = 7;
const MAX_SAMPLES = 800; // 7 днів × 96 семплів/день ≈ 672 + запас
const DISK_ALERT_PCT = 90;

// ── Чисті функції (під тестами) ───────────────────────────────────────────────

export function trimSamples(samples: StatSample[], nowSec: number): StatSample[] {
  const cutoff = nowSec - WINDOW_DAYS * 24 * 3600;
  const kept = samples.filter((s) => Number.isFinite(s.t) && s.t >= cutoff && s.t <= nowSec + 60);
  return kept.length > MAX_SAMPLES ? kept.slice(kept.length - MAX_SAMPLES) : kept;
}

export type WeekAggregates = {
  count: number;
  avgLoadPct: number; maxLoadPct: number;       // load у % від кількості ядер
  avgMemUsedPct: number; maxMemUsedPct: number;
  memTotalMb: number;
};

export function aggregateSamples(samples: StatSample[], cores: number): WeekAggregates | null {
  const valid = samples.filter((s) => s.mt > 0 && s.l >= 0);
  if (!valid.length) return null;
  const loadPct = valid.map((s) => (s.l / Math.max(1, cores)) * 100);
  const memUsedPct = valid.map((s) => ((s.mt - s.ma) / s.mt) * 100);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    count: valid.length,
    avgLoadPct: Math.round(avg(loadPct)),
    maxLoadPct: Math.round(Math.max(...loadPct)),
    avgMemUsedPct: Math.round(avg(memUsedPct)),
    maxMemUsedPct: Math.round(Math.max(...memUsedPct)),
    memTotalMb: valid[valid.length - 1]!.mt,
  };
}

export type Verdict = { level: "ok" | "warn" | "crit"; reasons: string[] };

// Пороги: диск ≥90% / стабільний load ≥70% на ядро / RAM ≥90% — «час покращувати»;
// диск ≥80% / load сер. ≥50% чи пік ≥90% / RAM сер. ≥80% — «варто стежити».
export function serverVerdict(diskUsedPct: number | null, agg: WeekAggregates | null): Verdict {
  const warn: string[] = [];
  const crit: string[] = [];
  if (diskUsedPct != null) {
    if (diskUsedPct >= 90) crit.push(`диск заповнено на ${diskUsedPct}%`);
    else if (diskUsedPct >= 80) warn.push(`диск заповнено на ${diskUsedPct}%`);
  }
  if (agg) {
    if (agg.avgLoadPct >= 70) crit.push(`CPU стабільно перевантажений (у середньому ${agg.avgLoadPct}%)`);
    else if (agg.avgLoadPct >= 50 || agg.maxLoadPct >= 90) warn.push(`підвищене навантаження CPU (сер. ${agg.avgLoadPct}%, пік ${agg.maxLoadPct}%)`);
    if (agg.avgMemUsedPct >= 90) crit.push(`RAM майже вичерпана (у середньому ${agg.avgMemUsedPct}%)`);
    else if (agg.avgMemUsedPct >= 80) warn.push(`високе використання RAM (сер. ${agg.avgMemUsedPct}%)`);
  }
  if (crit.length) return { level: "crit", reasons: [...crit, ...warn] };
  if (warn.length) return { level: "warn", reasons: warn };
  return { level: "ok", reasons: [] };
}

export function fmtGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb < 1) return `${Math.max(1, Math.round(gb * 1024))} MB`;
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d} дн ${h} год`;
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} год ${m} хв` : `${m} хв`;
}

// ── Виміри системи ────────────────────────────────────────────────────────────

// MemAvailable з /proc/meminfo — чесна метрика на Linux (os.freemem() не враховує
// page cache і на здоровому сервері показує «майже нуль»). Фолбек на os.freemem()
// лишається для локальної розробки поза Linux.
export function readMemInfo(): { totalMb: number; availableMb: number } {
  try {
    const txt = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (re: RegExp) => { const m = txt.match(re); return m ? Number(m[1]) : NaN; };
    const totalMb = Math.round(kb(/^MemTotal:\s+(\d+)/m) / 1024);
    const availableMb = Math.round(kb(/^MemAvailable:\s+(\d+)/m) / 1024);
    if (Number.isFinite(totalMb) && Number.isFinite(availableMb)) return { totalMb, availableMb };
  } catch { /* не Linux — фолбек нижче */ }
  return { totalMb: Math.round(os.totalmem() / 1024 ** 2), availableMb: Math.round(os.freemem() / 1024 ** 2) };
}

export type DiskInfo = { totalBytes: number; availBytes: number; usedBytes: number; usedPct: number };

// use% рахується як у df: used / (used + avail) — root-резерв файлової системи
// не зараховується ні у вільне, ні у використане.
async function readDisk(): Promise<DiskInfo | null> {
  try {
    const s = await fs.promises.statfs("/");
    const usedBytes = (s.blocks - s.bfree) * s.bsize;
    const availBytes = s.bavail * s.bsize;
    return {
      totalBytes: s.blocks * s.bsize,
      availBytes,
      usedBytes,
      usedPct: Math.round((usedBytes / Math.max(1, usedBytes + availBytes)) * 100),
    };
  } catch (e: any) {
    logger.warn({ err: e?.message }, "server stats: statfs failed");
    return null;
  }
}

async function dirSizeBytes(root: string): Promise<number | null> {
  try {
    let total = 0;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += (await fs.promises.stat(p)).size;
      }
    }
    return total;
  } catch { return null; }
}

async function dbSizeBytes(): Promise<number | null> {
  try {
    const r: any = await db.execute(sql`SELECT pg_database_size(current_database()) AS size`);
    const n = Number(((r.rows ?? r) as any[])[0]?.size);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// ── Сховище семплів (settings, ролінг 7 днів) ─────────────────────────────────

async function loadSamples(): Promise<StatSample[]> {
  try {
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, SAMPLES_KEY));
    if (!row) return [];
    const parsed = JSON.parse(row.value) as { samples?: StatSample[] };
    return Array.isArray(parsed.samples) ? parsed.samples : [];
  } catch { return []; }
}

async function saveSamples(samples: StatSample[]): Promise<void> {
  const value = JSON.stringify({ samples });
  await db.insert(settingsTable).values({ key: SAMPLES_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

// ── Крон-входи ────────────────────────────────────────────────────────────────

let diskAlertedOn = ""; // Warsaw-дата останнього диск-алерту: раз на день, не раз на 15 хв

export async function sampleServerStats(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const mem = readMemInfo();
  const sample: StatSample = {
    t: nowSec,
    l: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    ma: mem.availableMb,
    mt: mem.totalMb,
  };
  const samples = trimSamples([...(await loadSamples()), sample], nowSec);
  await saveSamples(samples);

  const disk = await readDisk();
  if (disk && disk.usedPct >= DISK_ALERT_PCT) {
    const today = warsawDateStr();
    if (diskAlertedOn !== today) {
      diskAlertedOn = today;
      const { sendAlert } = await import("../lib/alerts");
      void sendAlert({
        service: "cron", kind: "disk-space", source: "serverStats",
        message: `Диск заповнено на ${disk.usedPct}% — вільно ${fmtGb(disk.availBytes)}`,
      });
    }
  }
}

const dm = (dateStr: string) => dateStr.slice(5).split("-").reverse().join("."); // YYYY-MM-DD → DD.MM

// YYYY-MM-DD − N днів рядковою арифметикою (без toISOString — прод у Europe/Berlin)
function minusDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! - days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// Збірка тексту дайджесту — окремо від відправки (смоук-скрипти друкують без бота).
export async function buildWeeklyServerReportText(): Promise<{ text: string; samples: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const samples = trimSamples(await loadSamples(), nowSec);
  const cores = os.cpus().length;
  const agg = aggregateSamples(samples, cores);
  const disk = await readDisk();
  const [dbBytes, uploadsBytes] = await Promise.all([dbSizeBytes(), dirSizeBytes(UPLOADS_ROOT)]);

  const today = warsawDateStr();
  const lines: string[] = [`🖥 Сервер · тиждень ${dm(minusDaysStr(today, 7))}–${dm(minusDaysStr(today, 1))}`, ""];

  if (disk) lines.push(`💾 Диск: ${fmtGb(disk.usedBytes)} з ${fmtGb(disk.totalBytes)} (${disk.usedPct}%), вільно ${fmtGb(disk.availBytes)}`);
  else lines.push("💾 Диск: не вдалося виміряти");
  if (dbBytes != null) lines.push(`   ├ База даних: ${fmtGb(dbBytes)}`);
  if (uploadsBytes != null) lines.push(`   └ uploads: ${fmtGb(uploadsBytes)}`);

  if (agg) {
    const coreWord = cores === 1 ? "ядро" : cores >= 2 && cores <= 4 ? "ядра" : "ядер";
    lines.push(`⚙️ CPU (${cores} ${coreWord}): серед. ${agg.avgLoadPct}%, пік ${agg.maxLoadPct}%`);
    lines.push(`🧠 RAM ${fmtGb(agg.memTotalMb * 1024 ** 2)}: серед. використано ${agg.avgMemUsedPct}%, пік ${agg.maxMemUsedPct}%`);
  } else {
    lines.push("⚙️ CPU/RAM: семплів ще немає — зберуться протягом тижня");
  }
  lines.push(`⏱ Аптайм: сервер ${fmtUptime(os.uptime())}, процес ${fmtUptime(process.uptime())}`);

  lines.push("");
  const v = serverVerdict(disk?.usedPct ?? null, agg);
  if (v.level === "ok") lines.push("✅ Запасу достатньо — покращення не потрібне");
  else if (v.level === "warn") lines.push(`⚠️ Варто стежити: ${v.reasons.join("; ")}`);
  else lines.push(`🔴 Час покращувати: ${v.reasons.join("; ")}`);

  return { text: lines.join("\n"), samples: samples.length };
}

// Тижневий дайджест (пн 08:00 Warsaw) головному адміну. Best-effort: помилка
// відправки не валить крон.
export async function sendWeeklyServerReport(): Promise<void> {
  const { text, samples } = await buildWeeklyServerReportText();

  const { bot } = await import("../bot");
  const mains = await db.select().from(adminsTable).where(eq(adminsTable.isMain, true));
  let sent = 0;
  for (const a of mains) {
    if (!a.telegramId) continue;
    try { await bot.telegram.sendMessage(a.telegramId, text); sent++; }
    catch (e: any) { logger.warn({ err: e?.message }, "server stats report send failed"); }
  }
  logger.info({ samples, recipients: sent }, "Weekly server stats report sent");
}

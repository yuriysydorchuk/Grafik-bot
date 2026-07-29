// CFO-модуль («фінансовий директор»): місячні перевірки, які раніше робилися
// очима. Всі ЦИФРИ рахує код (звірка кешфлоу↔баланс, P&L vs кеш, маржі по
// клієнтах з MoM) — АІ-шар (Claude API) лише ІНТЕРПРЕТУЄ готові числа і вмикається
// наявністю ANTHROPIC_API_KEY. Налаштування (поріг маржі, адресати розсилки) —
// у settings; висновки зберігаються в cfo_reports.
import { db, cfoReportsTable, settingsTable, adminsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { computeCashflow } from "../routes/cashflow";
import { unpaidInvoicesAt } from "../routes/invoices";
import { ksefReceivablesAt } from "./ksef";

const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];
const r2 = (n: number) => Math.round(n * 100) / 100;

export const prevMonthOf = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

// ── Налаштування ───────────────────────────────────────────────────────────────
export type CfoSettings = { marginThreshold: number; recipientAdminIds: number[] };
const SETTINGS_KEY = "cfo_settings";

export async function getCfoSettings(): Promise<CfoSettings> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, SETTINGS_KEY));
  const def: CfoSettings = { marginThreshold: 10, recipientAdminIds: [] };
  if (!row) return def;
  try { return { ...def, ...JSON.parse(row.value) }; } catch { return def; }
}

export async function saveCfoSettings(s: CfoSettings): Promise<void> {
  const value = JSON.stringify(s);
  await db.insert(settingsTable).values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

// ── Маржі по клієнтах (P&L) ────────────────────────────────────────────────────
export type ClientMargin = {
  label: string;
  revenue: number; cogs: number; margin: number; marginPct: number | null;
  prevRevenue: number; prevMargin: number; prevMarginPct: number | null;
  revenueDelta: number; marginPctDelta: number | null;
  low: boolean; isNew: boolean; gone: boolean;
};

async function pnlByClient(month: string): Promise<Map<string, { revenue: number; cogs: number }>> {
  const rows = rowsOf(await db.execute(sql`
    SELECT label, section, coalesce(sum(amount), 0) AS total
    FROM pnl_entries WHERE period_month = ${month} AND section IN ('revenue', 'cogs')
    GROUP BY 1, 2`));
  const map = new Map<string, { revenue: number; cogs: number }>();
  for (const r of rows) {
    const c = map.get(String(r.label)) ?? map.set(String(r.label), { revenue: 0, cogs: 0 }).get(String(r.label))!;
    if (r.section === "revenue") c.revenue = r2(c.revenue + Number(r.total));
    else c.cogs = r2(c.cogs + Number(r.total));
  }
  return map;
}

async function fixedCosts(month: string): Promise<number> {
  const r = rowsOf(await db.execute(sql`
    SELECT coalesce(sum(amount), 0) AS total FROM pnl_entries
    WHERE period_month = ${month} AND section = 'fixed'`));
  return r2(Number(r[0]?.total ?? 0));
}

export async function computeMargins(month: string, threshold: number) {
  const [cur, prev] = await Promise.all([pnlByClient(month), pnlByClient(prevMonthOf(month))]);
  const labels = new Set([...cur.keys(), ...prev.keys()]);
  const clients: ClientMargin[] = [];
  for (const label of labels) {
    const c = cur.get(label) ?? { revenue: 0, cogs: 0 };
    const p = prev.get(label) ?? { revenue: 0, cogs: 0 };
    const margin = r2(c.revenue - c.cogs);
    const prevMargin = r2(p.revenue - p.cogs);
    const marginPct = c.revenue > 0 ? r2((margin / c.revenue) * 100) : null;
    const prevMarginPct = p.revenue > 0 ? r2((prevMargin / p.revenue) * 100) : null;
    clients.push({
      label,
      revenue: c.revenue, cogs: c.cogs, margin, marginPct,
      prevRevenue: p.revenue, prevMargin, prevMarginPct,
      revenueDelta: r2(c.revenue - p.revenue),
      marginPctDelta: marginPct != null && prevMarginPct != null ? r2(marginPct - prevMarginPct) : null,
      low: marginPct != null && marginPct < threshold,
      isNew: c.revenue > 0 && p.revenue === 0,
      gone: c.revenue === 0 && p.revenue > 0,
    });
  }
  clients.sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = r2(clients.reduce((s, c) => s + c.revenue, 0));
  const totalMargin = r2(clients.reduce((s, c) => s + c.margin, 0));
  const fixed = await fixedCosts(month);
  return {
    clients, threshold,
    totals: {
      revenue: totalRevenue, margin: totalMargin,
      marginPct: totalRevenue > 0 ? r2((totalMargin / totalRevenue) * 100) : null,
      fixed, profit: r2(totalMargin - fixed),
    },
  };
}

// ── Повний набір даних місяця ──────────────────────────────────────────────────
export async function buildCfoData(month: string) {
  const [y, m] = month.split("-") as [string, string];
  const settings = await getCfoSettings();
  const [cf, margins, recvEnd, unpaidEnd, recvStart, unpaidStart] = await Promise.all([
    computeCashflow(y, m),
    computeMargins(month, settings.marginThreshold),
    ksefReceivablesAt(lastDayOf(month)), unpaidInvoicesAt(lastDayOf(month)),
    ksefReceivablesAt(lastDayOf(prevMonthOf(month))), unpaidInvoicesAt(lastDayOf(prevMonthOf(month))),
  ]);

  const reconciliation = {
    opening: cf.opening, closing: cf.closing, delta: cf.delta,
    computedClosing: cf.reconcile.computedClosing,
    residual: cf.reconcile.residual, // 0 (±заокруглення) = кешфлоу сходиться з балансом
    inflows: cf.inflows, expensesTotal: cf.expensesTotal, ownersTotal: cf.ownersTotal,
    internal: cf.internal,
  };

  // P&L (акруал) vs кеш (каса): різницю пояснюють виплати власникам (не в P&L),
  // зміна дебіторки (виставлено, але не оплачено) і кредиторки (нараховано, не сплачено)
  const receivablesChange = r2(recvEnd.total - recvStart.total);
  const payablesChange = r2(unpaidEnd.total - unpaidStart.total);
  const pnlVsCash = {
    pnlProfit: margins.totals.profit,
    cashDelta: cf.delta,
    difference: r2(margins.totals.profit - cf.delta),
    factors: {
      ownersPayouts: cf.ownersTotal,          // забрали власники — з кешу, не з P&L
      receivablesChange,                       // + = продали більше, ніж отримали грошей
      payablesChange,                          // + = нарахували витрат більше, ніж заплатили
      vatRefund: cf.inflows.vatRefund,
    },
  };

  return { month, reconciliation, pnlVsCash, margins };
}

const lastDayOf = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// ── АІ-висновок (Claude API) ───────────────────────────────────────────────────
export const cfoAiConfigured = (): boolean => !!process.env.ANTHROPIC_API_KEY;
const AI_MODEL = "claude-opus-4-8";

export async function runCfoAnalysis(month: string, auto = false): Promise<{ id: number; content: string }> {
  if (!cfoAiConfigured()) throw new Error("АІ-аналіз не налаштований: додай ANTHROPIC_API_KEY у .env");
  const data = await buildCfoData(month);

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system:
      "Ти — фінансовий директор кадрової агенції Euro Support (Польща: постачання працівників на фабрики, 3 юрособи: ES, ESO, Klinex). " +
      "Тобі дають ГОТОВІ, точні цифри місяця (zł): звірку кешфлоу з балансом, порівняння P&L з рухом грошей і маржі по клієнтах-проєктах з порівнянням до минулого місяця. " +
      "Нічого не перераховуй і не вигадуй чисел — лише інтерпретуй надані. " +
      "Напиши стислий висновок українською в markdown із розділами: 1) Звірка (чи сходиться; якщо residual суттєвий — що перевірити), 2) P&L vs гроші (куди поділась різниця), 3) Проєкти (маломаржинальні — конкретні клієнти і що з ними робити; значні зміни MoM; нові/зниклі), 4) Головні 3 дії на наступний місяць. " +
      "Пиши по суті, без води, числа наводь точно як у даних. Контекст бізнесу: собівартість клієнта = повна ЗП працівників (брутто+податки), дохід — нетто без VAT; " +
      "зарплати виплачуються в наступному місяці (M+1), тож велика різниця P&L↔кеш — здебільшого нарахована, але ще не виплачена ЗП місяця; це нормально і не є проблемою, якщо стабільно. " +
      "Дрібні клієнти WSPOLNOTA… — сегмент прибирання (cleaning), їх поява/зникнення в списку — сезонний шум.",
    messages: [{ role: "user", content: `Дані за ${month}:\n${JSON.stringify(data)}` }],
  });

  const content = response.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map(b => b.text).join("\n").trim();
  if (!content) throw new Error("Порожня відповідь моделі");
  const [row] = await db.insert(cfoReportsTable)
    .values({ periodMonth: month, content, model: AI_MODEL, auto })
    .returning({ id: cfoReportsTable.id });
  logger.info({ month, tokens: response.usage }, "cfo analysis saved");
  return { id: row!.id, content };
}

export async function listCfoReports(month?: string) {
  const conds = month ? eq(cfoReportsTable.periodMonth, month) : undefined;
  return db.select().from(cfoReportsTable).where(conds).orderBy(desc(cfoReportsTable.id)).limit(24);
}

// ── Місячний звіт у бот (1-го числа за попередній місяць) ─────────────────────
const fmt = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export function cfoSummaryText(data: Awaited<ReturnType<typeof buildCfoData>>): string {
  const r = data.reconciliation;
  const lines: string[] = [];
  lines.push(`📊 CFO-звірка за ${data.month}`);
  lines.push("");
  const okRes = Math.abs(r.residual) <= 5;
  lines.push(`${okRes ? "✅" : "⚠️"} Звірка: початок ${fmt(r.opening.total)} + кешфлоу ${fmt(r.delta)} → кінець ${fmt(r.closing.total)} zł` +
    (okRes ? " (сходиться)" : `; НЕВ'ЯЗКА ${fmt(r.residual)} zł — глянь /cfo`));
  lines.push(`💰 P&L прибуток ${fmt(data.pnlVsCash.pnlProfit)} zł vs кеш ${fmt(data.pnlVsCash.cashDelta)} zł (власникам ${fmt(data.pnlVsCash.factors.ownersPayouts)}, Δдебіторки ${fmt(data.pnlVsCash.factors.receivablesChange)})`);
  const low = data.margins.clients.filter(c => c.low && !c.gone);
  if (low.length) lines.push(`🔻 Маржа <${data.margins.threshold}%: ${low.map(c => `${c.label} (${c.marginPct}%)`).join(", ")}`);
  const drops = data.margins.clients.filter(c => (c.marginPctDelta ?? 0) <= -5 && !c.gone);
  if (drops.length) lines.push(`📉 Падіння маржі: ${drops.map(c => `${c.label} (${c.prevMarginPct}%→${c.marginPct}%)`).join(", ")}`);
  // списки обрізаємо найбільшими за обігом — дрібні wspólnoty не мають топити звіт
  const gone = data.margins.clients.filter(c => c.gone).sort((a, b) => b.prevRevenue - a.prevRevenue);
  if (gone.length) lines.push(`🚪 Зникли: ${gone.slice(0, 5).map(c => c.label).join(", ")}${gone.length > 5 ? ` +ще ${gone.length - 5}` : ""}`);
  const news = data.margins.clients.filter(c => c.isNew);
  if (news.length) lines.push(`🆕 Нові: ${news.slice(0, 5).map(c => `${c.label} (${c.marginPct ?? "?"}%)`).join(", ")}${news.length > 5 ? ` +ще ${news.length - 5}` : ""}`);
  lines.push(`Разом: дохід ${fmt(data.margins.totals.revenue)}, маржа ${fmt(data.margins.totals.margin)} (${data.margins.totals.marginPct ?? "?"}%), прибуток ${fmt(data.margins.totals.profit)} zł`);
  return lines.join("\n");
}

export async function sendMonthlyCfoReport(): Promise<void> {
  const now = new Date();
  const month = prevMonthOf(now.toISOString().slice(0, 7));
  const settings = await getCfoSettings();
  if (!settings.recipientAdminIds.length) { logger.info("cfo monthly report: no recipients configured"); return; }
  const data = await buildCfoData(month);
  let text = cfoSummaryText(data);
  if (cfoAiConfigured()) {
    try {
      const { content } = await runCfoAnalysis(month, true);
      text += `\n\n🤖 Висновок фін.директора:\n${content.slice(0, 2500)}${content.length > 2500 ? "\n… (повний — на /cfo)" : ""}`;
    } catch (e: any) { logger.warn({ err: e?.message }, "cfo auto analysis failed"); }
  }
  const { bot } = await import("../bot/instance");
  const admins = await db.select().from(adminsTable);
  for (const id of settings.recipientAdminIds) {
    const a = admins.find(x => x.id === id);
    if (!a?.telegramId) continue;
    try { await bot.telegram.sendMessage(a.telegramId, text); }
    catch (e: any) { logger.warn({ adminId: id, err: e?.message }, "cfo report send failed"); }
  }
}
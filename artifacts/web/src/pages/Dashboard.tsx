import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  Users, Truck, Factory, ArrowRight, AlertTriangle, CalendarRange, CheckCircle2, Zap, UserX, Send,
  FileClock, CalendarOff, ClipboardCheck, HandCoins, Link2Off, CalendarX2, type LucideIcon,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
  PieChart, Pie, Cell,
} from "recharts";
import { get, post, DAY_UK, SHIFT_UK, type DayCode, type ShiftCode } from "../lib/api";
import { Card, Spinner, Badge, Button, cn } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { WeeklyWizard } from "../components/WeeklyWizard";
import { LiveShifts } from "../components/LiveShifts";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT, type TFn } from "../lib/i18n";

interface MissingWorker { id: number; fullName: string; telegramId: string | null; factoryName: string | null }

interface Attention {
  pendingAbsences: number; hoursDisputes: number; pendingAdvances: number;
  unlinkedUnplanned: number; unmarkedAttendance: number; driverGaps: number;
  availabilityMissing: number;
}

interface Overview {
  counts: { workers: number; workersLinked: number; drivers: number; driversLinked: number; factories: number };
  currentWeek: string; nextWeek: string; focusWeek: string; focusWeekLabel: string;
  planning: { factoryId: number; name: string; ordered: number; assigned: number; available: number; status: string }[];
  shortages: { factory: string; day: DayCode; shift: ShiftCode; needed: number; assigned: number; short: number }[];
  attendance: { label: string; present: number; absent: number; scheduled: number; total: number } | null;
  recentWeeks: { weekStart: string; status: string; label: string; entries: number }[];
}

const statusBadge = (s: string, t: TFn) =>
  s === "approved" ? <Badge color="green">{t("Затверджено")}</Badge>
  : s === "draft" ? <Badge color="amber">{t("Чернетка")}</Badge>
  : <Badge>—</Badge>;

export default function Dashboard() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Overview>({ queryKey: ["dashboard"], queryFn: () => get("/dashboard"), refetchInterval: 60000 });
  const { data: attn } = useQuery<Attention>({ queryKey: ["attention"], queryFn: () => get("/attention"), refetchInterval: 60000 });
  const focusWeek = data?.focusWeek;
  const { data: missing = [] } = useQuery<MissingWorker[]>({
    queryKey: ["missing", focusWeek], enabled: !!focusWeek,
    queryFn: () => get(`/availability/missing?weekStart=${focusWeek}`),
  });
  const confirm = useConfirm();
  const me = useMe();
  const canRemind = can(me, "editData");
  const remind = useMutation({
    mutationFn: () => post("/availability/remind", { weekStart: focusWeek }),
    onSuccess: (r: any) => toast.success(t("Нагадування надіслано"), { description: `✅ ${r.notified}${r.skipped ? ` · ⚠️ ${t("без Telegram")}: ${r.skipped}` : ""}` }),
    onError: (e: any) => toast.error(e.message),
  });
  const generate = useMutation({
    mutationFn: (factoryId: number) => post("/schedule/generate", { weekStart: focusWeek, factoryId }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["dashboard"] }); toast.success(t("Згенеровано: {n} призначень", { n: r.totalAssigned })); },
    onError: (e: any) => toast.error(e.message),
  });
  const approve = useMutation({
    mutationFn: () => post("/schedule/approve", { weekStart: focusWeek }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["dashboard"] }); toast.success(t("Графік затверджено"), { description: (r.messages ?? []).join(" · ") }); },
    onError: (e: any) => toast.error(e.message),
  });
  if (isLoading || !data) return <Spinner />;

  const kpis = [
    { label: t("Працівники"), value: data.counts.workers, sub: t("{n} у Telegram", { n: data.counts.workersLinked }), icon: Users, href: "/workers", color: "text-red-600 bg-red-50" },
    { label: t("Водії"), value: data.counts.drivers, sub: t("{n} у Telegram", { n: data.counts.driversLinked }), icon: Truck, href: "/drivers", color: "text-sky-600 bg-sky-50" },
    { label: t("Фабрики"), value: data.counts.factories, sub: t("активні"), icon: Factory, href: "/factories", color: "text-emerald-600 bg-emerald-50" },
  ];

  const totalOrdered = data.planning.reduce((s, p) => s + p.ordered, 0);
  const totalAssigned = data.planning.reduce((s, p) => s + p.assigned, 0);
  const readiness = totalOrdered ? Math.round((Math.min(totalAssigned, totalOrdered) / totalOrdered) * 100) : 0;

  const att = data.attendance;
  const attData = att ? [
    { name: t("Присутні"), value: att.present, color: "#10b981" },
    { name: t("Відсутні"), value: att.absent, color: "#f43f5e" },
    { name: t("Заплановані"), value: att.scheduled, color: "#cbd5e1" },
  ].filter(d => d.value > 0) : [];
  const attRate = att && att.present + att.absent > 0 ? Math.round((att.present / (att.present + att.absent)) * 100) : null;

  return (
    <>
      <PageHeader title={t("Огляд")} subtitle={t("Поточний тиждень {a} · наступний {b}", { a: data.currentWeek, b: data.nextWeek })} />

      {attn && <AttentionPanel a={attn} />}

      <LiveShifts />

      <WeeklyWizard
        weekLabel={data.focusWeekLabel} focusWeek={data.focusWeek}
        ordersTotal={totalOrdered} assignedTotal={totalAssigned}
        filledCount={Math.max(0, data.counts.workers - missing.length)} totalWorkers={data.counts.workers}
        weekStatus={data.planning[0]?.status ?? "none"} planning={data.planning}
        generatingId={generate.isPending ? (generate.variables as number) : null} onGenerate={(id) => generate.mutate(id)}
        approving={approve.isPending}
        onApprove={async () => { if (await confirm({ title: t("Затвердити графік?"), message: t("Графік збережеться на Google Drive і піде на email клієнта."), confirmText: t("Затвердити") })) approve.mutate(); }}
      />

      {/* KPI + readiness */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map(c => (
          <Link key={c.label} href={c.href}>
            <Card className="p-5 transition hover:shadow-md">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-sm text-slate-500">{c.label}</div>
                  <div className="mt-1 text-3xl font-bold text-slate-800">{c.value}</div>
                  <div className="mt-1 text-xs text-slate-400">{c.sub}</div>
                </div>
                <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${c.color}`}><c.icon className="h-5 w-5" /></div>
              </div>
            </Card>
          </Link>
        ))}
        <Card className="p-5">
          <div className="text-sm text-slate-500">{t("Готовність наст. тижня")}</div>
          <div className="mt-1 flex items-end gap-2">
            <span className="text-3xl font-bold text-slate-800">{readiness}%</span>
            <span className="mb-1 text-xs text-slate-400">{totalAssigned}/{totalOrdered} {t("місць")}</span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full ${readiness >= 100 ? "bg-emerald-500" : readiness >= 60 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${Math.min(readiness, 100)}%` }} />
          </div>
        </Card>
      </div>

      {/* Planning chart + attendance donut */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><CalendarRange className="h-4 w-4" /> {t("Наступний тиждень — по фабриках")} ({data.focusWeekLabel})</h3>
          <p className="mb-4 text-xs text-slate-400">{t("Замовлено / Призначено / Заявили доступність")}</p>
          {data.planning.length === 0 ? <Empty>{t("Немає фабрик")}</Empty> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.planning} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef2f7" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: "#94a3b8" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 13 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="ordered" name={t("Замовлено")} fill="#94a3b8" radius={[4, 4, 0, 0]} maxBarSize={40} />
                <Bar dataKey="assigned" name={t("Призначено")} fill="#e11d2a" radius={[4, 4, 0, 0]} maxBarSize={40} />
                <Bar dataKey="available" name={t("Доступні")} fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card className="p-5">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><CheckCircle2 className="h-4 w-4" /> {t("Явка")}</h3>
          <p className="mb-2 text-xs text-slate-400">{att ? att.label : t("немає затвердженого тижня")}</p>
          {!att || att.total === 0 ? <Empty>{t("Немає даних")}</Empty> : (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={attData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={2}>
                    {attData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 13 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-1 space-y-1 text-sm">
                <Row dot="#10b981" label={t("Присутні")} value={att.present} />
                <Row dot="#f43f5e" label={t("Відсутні")} value={att.absent} />
                <Row dot="#cbd5e1" label={t("Заплановані")} value={att.scheduled} />
                {attRate !== null && <div className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-500">{t("Надійність явки:")} <b className="text-slate-700">{attRate}%</b></div>}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Shortages + recent weeks */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700"><AlertTriangle className="h-4 w-4 text-amber-500" /> {t("Нестачі — наст. тиждень")}</h3>
            <Link href="/schedule" className="flex items-center gap-1 text-sm text-red-600 hover:underline">{t("Графік")} <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          {data.shortages.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-emerald-600">{t("✅ Нестач немає (або графік ще не згенеровано)")}</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr><th className="px-4 py-2">{t("Фабрика")}</th><th className="px-4 py-2">{t("День")}</th><th className="px-4 py-2">{t("Зміна")}</th><th className="px-4 py-2 text-right">{t("Бракує")}</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.shortages.slice(0, 12).map((s, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2 font-medium text-slate-700">{s.factory}</td>
                    <td className="px-4 py-2 text-slate-500">{DAY_UK[s.day]}</td>
                    <td className="px-4 py-2 text-slate-500">{SHIFT_UK[s.shift]}</td>
                    <td className="px-4 py-2 text-right"><Badge color="rose">−{s.short}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700"><CalendarRange className="h-4 w-4" /> {t("Останні тижні")}</h3>
            <Link href="/schedule" className="flex items-center gap-1 text-sm text-red-600 hover:underline">{t("Усі")} <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          {data.recentWeeks.length === 0 ? <div className="px-5 py-8 text-center text-sm text-slate-400">{t("Немає графіків")}</div> : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr><th className="px-4 py-2">{t("Тиждень")}</th><th className="px-4 py-2 text-center">{t("Призначень")}</th><th className="px-4 py-2 text-right">{t("Статус")}</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.recentWeeks.map((w, i) => (
                  <tr key={i} className="cursor-pointer hover:bg-slate-50" onClick={() => (location.href = `/schedule?week=${w.weekStart}`)}>
                    <td className="px-4 py-2 font-medium text-red-600">{w.label}</td>
                    <td className="px-4 py-2 text-center text-slate-500">{w.entries}</td>
                    <td className="px-4 py-2 text-right">{statusBadge(w.status, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* Who hasn't filled availability for next week */}
      <Card className="mt-6 overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700"><UserX className="h-4 w-4 text-amber-500" /> {t("Не заповнили доступність — наст. тиждень")}</h3>
          <div className="flex items-center gap-2">
            {canRemind && missing.length > 0 && (
              <Button variant="secondary" loading={remind.isPending}
                onClick={async () => {
                  const n = missing.filter(w => w.telegramId).length;
                  const msg = n > 0
                    ? t("{n} із {total} прац. мають Telegram і отримають нагадування заповнити доступність на наступний тиждень.", { n, total: missing.length })
                    : t("Жоден із {total} прац. не приєднаний до Telegram — нагадування нікому не надійде.", { total: missing.length });
                  if (await confirm({ title: t("Надіслати нагадування?"), message: msg, confirmText: t("Надіслати") })) remind.mutate();
                }}>
                <Send className="h-3.5 w-3.5" /> {t("Нагадати всім")}
              </Button>
            )}
            <Badge color={missing.length ? "amber" : "green"}>{missing.length}</Badge>
          </div>
        </div>
        {missing.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-emerald-600">{t("✅ Усі активні працівники заповнили")}</div>
        ) : (
          <div className="flex flex-wrap gap-2 p-4">
            {missing.map(w => (
              <span key={w.id} className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2.5 py-1 text-sm text-slate-600">
                {w.fullName}{!w.telegramId && <span title={t("не приєднаний до Telegram")} className="text-amber-500">⚠️</span>}
              </span>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

// «Потребує уваги»: clickable tiles with counts of open items; hidden when zero.
const ATTN_TONE = {
  rose: { tile: "border-rose-200 bg-rose-50/50 hover:bg-rose-50", icon: "bg-rose-100 text-rose-600" },
  amber: { tile: "border-amber-200 bg-amber-50/50 hover:bg-amber-50", icon: "bg-amber-100 text-amber-600" },
} as const;

function AttentionPanel({ a }: { a: Attention }) {
  const t = useT();
  const all: { count: number; label: string; href: string; icon: LucideIcon; tone: keyof typeof ATTN_TONE }[] = [
    { count: a.unmarkedAttendance, label: t("змін без відмітки присутності"), href: "/schedule", icon: ClipboardCheck, tone: "rose" },
    { count: a.driverGaps, label: t("змін без водія (завіз)"), href: "/schedule", icon: Truck, tone: "rose" },
    { count: a.hoursDisputes, label: t("непідтверджені коригування годин"), href: "/hours", icon: FileClock, tone: "rose" },
    { count: a.pendingAbsences, label: t("запити на вихідні очікують"), href: "/absences", icon: CalendarOff, tone: "amber" },
    { count: a.pendingAdvances, label: t("запити на аванс очікують"), href: "/advances", icon: HandCoins, tone: "amber" },
    { count: a.unlinkedUnplanned, label: t("позапланові без привʼязки"), href: "/schedule", icon: Link2Off, tone: "amber" },
    { count: a.availabilityMissing, label: t("не заповнили диспозиційність (наст. тиждень)"), href: "/availability", icon: CalendarX2, tone: "amber" },
  ];
  const items = all.filter(i => i.count > 0);

  if (!items.length) return (
    <Card className="mb-6 flex items-center gap-2 border-emerald-200 bg-emerald-50/60 p-4 text-sm font-medium text-emerald-700">
      <CheckCircle2 className="h-5 w-5 shrink-0" /> {t("Все під контролем — незакритих питань немає")}
    </Card>
  );

  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <h3 className="text-sm font-semibold text-slate-700">{t("Потребує уваги")}</h3>
        <Badge color="amber">{items.length}</Badge>
      </div>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map(i => (
          <Link key={i.label} href={i.href}>
            <div className={cn("flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition", ATTN_TONE[i.tone].tile)}>
              <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", ATTN_TONE[i.tone].icon)}>
                <i.icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="text-xl font-bold leading-tight text-slate-800">{i.count}</div>
                <div className="text-xs leading-snug text-slate-500">{i.label}</div>
              </div>
              <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-slate-300" />
            </div>
          </Link>
        ))}
      </div>
    </Card>
  );
}
function Row({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-slate-600"><span className="h-2.5 w-2.5 rounded-full" style={{ background: dot }} /> {label}</span>
      <span className="font-medium text-slate-800">{value}</span>
    </div>
  );
}

function Empty({ children }: { children: any }) {
  return <div className="flex h-40 items-center justify-center text-sm text-slate-400">{children}</div>;
}

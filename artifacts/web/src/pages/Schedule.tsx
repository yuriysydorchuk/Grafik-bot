import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Zap, CheckCircle2, RefreshCw, Download, Send, X, GripVertical, Users, Check, Pencil, Link2 } from "lucide-react";
import { toast } from "sonner";
import {
  get, post, patch, del, type Factory, type ScheduleEntry, type OrderRequirement, type Worker,
  DAYS, DAY_FULL, SHIFT_UK, type DayCode, type ShiftCode,
} from "../lib/api";
import { upcomingWeeks, dayDate } from "../lib/dates";
import { useConfirm } from "../components/confirm";
import { usePersisted, useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { WeekSelect } from "../components/WeekSelect";
import { Button, Select, Card, Badge, Empty, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { dotClass, badgeClass, genderIcon, genderClass } from "../lib/colors";
import { useT } from "../lib/i18n";

type ReserveItem = { workerId: number; name: string; code: string | null; positionId?: number | null; gender?: string | null };
type PositionLite = { id: number; name: string; color: string };
type SchedResp = {
  week: { id: number; weekStart: string; status: string } | null;
  entries: ScheduleEntry[];
  reserve: Record<string, ReserveItem[]>;
  available: Record<string, ReserveItem[]>;
  approved: boolean;
  factory: { shiftCount: number; usesAvailability: boolean; genMode?: string; usesPositions?: boolean; usesGender?: boolean } | null;
  assignments: Record<string, { driverId: number; driverName: string | null }>;
  drivers: { id: number; name: string }[];
  orders: Record<string, number>;
  orderReq: Record<string, OrderRequirement[]>;
  positions: PositionLite[];
  unplanned: Record<string, { id: number; name: string; workerId: number | null }[]>;
  absenceByWorker: Record<string, { status: string; reason: string | null }>;
  substituteFor: Record<string, string>;
};
type DragData =
  | { kind: "entry"; id: number; day: DayCode; shift: ShiftCode }
  | { kind: "reserve"; workerId: number; day: DayCode; shift: ShiftCode }
  | { kind: "available"; workerId: number; day: DayCode };

const SHIFT_CODES: ShiftCode[] = ["1", "2", "3", "4", "5", "6"];
const gridColsClass = (n: number) =>
  n <= 1 ? "md:grid-cols-1" : n === 2 ? "md:grid-cols-2" : n === 3 ? "md:grid-cols-3" : "md:grid-cols-3 lg:grid-cols-4";

const shiftDot: Record<ShiftCode, string> = { "1": "bg-sky-500", "2": "bg-amber-500", "3": "bg-violet-500", "4": "bg-emerald-500", "5": "bg-pink-500", "6": "bg-cyan-500" };


export default function Schedule() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });

  const [factoryId, setFactoryId] = usePersisted<string>("sel.factory", "");
  const urlWeek = new URLSearchParams(location.search).get("week") ?? "";
  const [weekStart, setWeekStart] = useState(urlWeek || upcomingWeeks()[0]!.value);
  const [over, setOver] = useState("");
  const [approveOpen, setApproveOpen] = useState(false);
  const [addTo, setAddTo] = useState<{ day: DayCode; shift: ShiftCode } | null>(null); // manual add (incl. past shifts)
  const [addQuery, setAddQuery] = useState("");
  const [linkTo, setLinkTo] = useState<{ id: number; name: string; day: DayCode; shift: ShiftCode } | null>(null); // link a free-text unplanned extra to a real worker
  const [linkQuery, setLinkQuery] = useState("");

  useEffect(() => { if (!factoryId && factories.length) setFactoryId(String(factories[0]!.id)); }, [factories]);

  const { data, isFetching } = useQuery<SchedResp>({
    queryKey: ["schedule", factoryId, weekStart], enabled: !!factoryId && !!weekStart,
    queryFn: () => get(`/schedule?weekStart=${weekStart}&factoryId=${factoryId}`),
  });
  const reload = () => qc.invalidateQueries({ queryKey: ["schedule"] });
  // All active workers of this factory — for manually adding someone (e.g. found out after the shift).
  const { data: allWorkers = [] } = useQuery<Worker[]>({ queryKey: ["workers"], queryFn: () => get("/workers"), enabled: !!factoryId });
  const factoryWorkers = allWorkers.filter(w => w.isActive && String(w.factoryId) === factoryId);

  const factory = factories.find(f => String(f.id) === factoryId);
  const facName = factory?.name ?? "";
  const me = useMe();
  const week = data?.week;
  const approved = !!data?.approved;
  const editable = can(me, "editData"); // driver = read-only
  // worked shifts are locked per-cell until you tap "edit" on that specific shift
  const [editCells, setEditCells] = useState<Set<string>>(new Set());
  const toggleEditCell = (key: string) => setEditCells(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  // reset per-cell edit toggles when switching week/factory (keys would otherwise leak across views)
  useEffect(() => { setEditCells(new Set()); }, [weekStart, factoryId]);
  const entries = data?.entries ?? [];
  const reserve = data?.reserve ?? {};
  const available = data?.available ?? {};
  const orders = data?.orders ?? {};
  const orderReq = data?.orderReq ?? {};
  const positions = data?.positions ?? [];
  const posById = new Map(positions.map(p => [p.id, p]));
  const posName = (id: number | null | undefined) => id == null ? t("Без посади") : (posById.get(id)?.name ?? "?");
  const posColor = (id: number | null | undefined) => id == null ? "slate" : (posById.get(id)?.color ?? "slate");
  const unplanned = data?.unplanned ?? {};
  const absenceByWorker = data?.absenceByWorker ?? {};
  const substituteFor = data?.substituteFor ?? {};
  // A shift "has happened" once its start time has passed → show actuals, lock editing.
  const factoryShiftsArr = factory?.shifts ?? [];
  // Compare in Warsaw wall-clock (independent of the viewer's timezone)
  const warsawNowMs = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" })).getTime();
  const shiftStarted = (dayIndex: number, shift: ShiftCode) => {
    const t = factoryShiftsArr[Number(shift) - 1]?.start;
    if (!t) return false;
    const d = new Date(weekStart + "T00:00:00");
    d.setDate(d.getDate() + dayIndex);
    const [h, m] = t.split(":").map(Number);
    d.setHours(h ?? 0, m ?? 0, 0, 0);
    return warsawNowMs() >= d.getTime();
  };
  const usesAvailability = data?.factory?.usesAvailability ?? factory?.usesAvailability ?? true;
  const usesPositions = data?.factory?.usesPositions ?? factory?.usesPositions ?? false;
  const usesGender = data?.factory?.usesGender ?? factory?.usesGender ?? false;
  const shiftCount = data?.factory?.shiftCount ?? factory?.shiftCount ?? 3;
  // Segregate a shift's workers by position (factory order) then gender, with group labels.
  const grank = (g?: string | null) => g === "female" ? 0 : g === "male" ? 1 : 2;
  const byName = (a: ScheduleEntry, b: ScheduleEntry) => (a.workerName ?? "").localeCompare(b.workerName ?? "", "pl");
  const posOrderIds: (number | null)[] = (() => {
    const fromFac = (factory?.positions ?? []).map(p => p.positionId);
    return [...(fromFac.length ? fromFac : positions.map(p => p.id)), null];
  })();
  // Flat comparators mirroring groupEntries order: position (factory order) → gender → name.
  const nameCmp = (a?: string | null, b?: string | null) => (a ?? "").localeCompare(b ?? "", "pl");
  const prank = (pid?: number | null) => { const i = posOrderIds.indexOf(pid ?? null); return i === -1 ? posOrderIds.length : i; };
  const byGroupThenName = (a: ScheduleEntry, b: ScheduleEntry) =>
    (usesPositions ? prank(a.positionId) - prank(b.positionId) : 0) || (usesGender ? grank(a.gender) - grank(b.gender) : 0) || byName(a, b);
  const poolOrder = (a: ReserveItem, b: ReserveItem) =>
    (usesPositions ? prank(a.positionId) - prank(b.positionId) : 0) || (usesGender ? grank(a.gender) - grank(b.gender) : 0) || nameCmp(a.name, b.name);
  const groupEntries = (items: ScheduleEntry[]): { key: string; label: string | null; color: string; items: ScheduleEntry[] }[] => {
    if (!usesPositions && !usesGender) return [{ key: "all", label: null, color: "slate", items: [...items].sort(byName) }];
    if (usesPositions) {
      return posOrderIds.map(pid => ({
        key: String(pid), label: pid == null ? t("Без посади") : posName(pid), color: posColor(pid),
        items: items.filter(e => (e.positionId ?? null) === pid).sort((a, b) => (usesGender ? grank(a.gender) - grank(b.gender) : 0) || byName(a, b)),
      })).filter(g => g.items.length > 0);
    }
    return ([["female", t("Жінки")], ["male", t("Чоловіки")], [null, "—"]] as const).map(([g, label]) => ({
      key: String(g), label, color: "slate", items: items.filter(e => (e.gender ?? null) === g).sort(byName),
    })).filter(g => g.items.length > 0);
  };
  const shifts = SHIFT_CODES.slice(0, shiftCount);
  const hasContent = entries.length > 0 || Object.keys(reserve).length > 0 || Object.values(available).some(a => a.length > 0);

  const generate = useMutation({ mutationFn: () => post("/schedule/generate", { weekStart, factoryId: Number(factoryId) }),
    onSuccess: (r: any) => { reload(); toast.success(t("Згенеровано: {n} призначень", { n: r.totalAssigned }), { description: (r.shortages ?? []).length ? t("Є нестачі ({n})", { n: r.shortages.length }) : t("Усі замовлення виконані") }); },
    onError: (e: any) => toast.error(e.message) });
  const approve = useMutation({ mutationFn: (sendEmail: boolean) => post("/schedule/approve", { weekStart, factoryId: Number(factoryId), sendEmail }),
    onSuccess: (r: any) => { reload(); setApproveOpen(false); toast.success(t("Затверджено"), { description: (r.messages ?? []).join(" · ") }); }, onError: (e: any) => toast.error(e.message) });
  const notify = useMutation({ mutationFn: () => post("/schedule/notify", { weekStart, factoryId: Number(factoryId) }),
    onSuccess: (r: any) => toast.success(t("Розіслано"), { description: `${t("Працівників:")} ${r.workersNotified} · ${t("водій:")} ${r.driverNotified ? t("так") : "—"}${r.workersSkipped ? ` · ${t("без TG:")} ${r.workersSkipped}` : ""}` }), onError: (e: any) => toast.error(e.message) });
  const notifyDay = useMutation({ mutationFn: (day: DayCode) => post("/schedule/notify", { weekStart, factoryId: Number(factoryId), day }),
    onSuccess: (r: any) => toast.success(t("Розіслано"), { description: `${t("Працівників:")} ${r.workersNotified}` }), onError: (e: any) => toast.error(e.message) });
  const addEntry = useMutation({ mutationFn: (v: { workerId: number; day: DayCode; shift: ShiftCode }) => post("/schedule/entry", { weekStart, factoryId: Number(factoryId), ...v }), onSuccess: reload, onError: (e: any) => toast.error(e.message) });
  const moveEntry = useMutation({ mutationFn: (v: { id: number; shift: ShiftCode }) => patch(`/schedule/entry/${v.id}`, { shift: v.shift }), onSuccess: reload, onError: (e: any) => toast.error(e.message) });
  const removeEntry = useMutation({ mutationFn: (id: number) => del(`/schedule/entry/${id}`), onSuccess: reload });
  const setStatus = useMutation({ mutationFn: (v: { id: number; status: string }) => patch(`/schedule/entry/${v.id}/status`, { status: v.status }), onSuccess: reload, onError: (e: any) => toast.error(e.message) });
  const linkUnplanned = useMutation({ mutationFn: (v: { id: number; workerId: number }) => post(`/unplanned/${v.id}/link`, { workerId: v.workerId }),
    onSuccess: () => { reload(); toast.success(t("Прив'язано")); }, onError: (e: any) => toast.error(e.message) });

  const byDayShift = (d: DayCode, s: ShiftCode) => entries.filter(e => e.day === d && e.shift === s);

  // ── drag-and-drop (payload travels in dataTransfer) ──
  const startDrag = (e: React.DragEvent, payload: DragData) => {
    if (!editable) { e.preventDefault(); return; }
    e.dataTransfer.setData("text/plain", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDrop = (day: DayCode, shift: ShiftCode, zone: "assigned" | "reserve") => (e: React.DragEvent) => {
    e.preventDefault(); setOver("");
    if (!editable) return;
    let p: DragData;
    try { p = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
    if (!p || p.day !== day) return; // only within the same day
    if (zone === "assigned") {
      if (p.kind === "reserve" || p.kind === "available") addEntry.mutate({ workerId: p.workerId, day, shift });
      else if (p.shift !== shift) moveEntry.mutate({ id: p.id, shift });
    } else if (p.kind === "entry") {
      removeEntry.mutate(p.id);
    }
  };
  const overProps = (k: string) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (over !== k) setOver(k); },
    onDragLeave: () => setOver(o => (o === k ? "" : o)),
  });

  return (
    <>
      <PageHeader title={t("Графіки")} subtitle={facName ? t("Фабрика: {name}", { name: facName }) : undefined} />

      {/* Week picker (buttons) */}
      <WeekSelect value={weekStart} onChange={setWeekStart} className="mb-4" />

      {/* Factory + actions */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={factoryId} onChange={e => setFactoryId(e.target.value)} className="w-44">
          {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
        {approved ? <Badge color="green">{t("Затверджено")}</Badge> : week ? <Badge color="amber">{t("Чернетка")}</Badge> : <Badge>{t("Немає графіку")}</Badge>}
        {!editable && <Badge color="slate">{t("Лише перегляд")}</Badge>}
        <div className="flex-1" />
        {editable && <>
          <Button variant="secondary" loading={generate.isPending}
            onClick={async () => { if (entries.length && !(await confirm({ title: t("Перегенерувати?"), message: t("Майбутні зміни буде перескладено. Уже відпрацьовані (минулі) зміни залишаться без змін."), danger: true, confirmText: t("Перегенерувати") }))) return; generate.mutate(); }}>
            {entries.length ? <RefreshCw className="h-4 w-4" /> : <Zap className="h-4 w-4" />} {entries.length ? t("Перегенерувати") : t("Згенерувати")}
          </Button>
          <a href={`/api/schedule/excel?weekStart=${weekStart}&factoryId=${factoryId}`}
            className={`inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 ${entries.length ? "" : "pointer-events-none opacity-50"}`}>
            <Download className="h-4 w-4" /> Excel
          </a>
          <Button variant="secondary" loading={notify.isPending} disabled={!entries.length}
            onClick={async () => { if (await confirm({ title: t("Розіслати в Telegram?"), message: t("Працівникам фабрики «{name}» прийде їхній графік, а головному водію — повний список.", { name: facName }), confirmText: t("Розіслати") })) notify.mutate(); }}>
            <Send className="h-4 w-4" /> {t("Розіслати")}
          </Button>
          <Button variant={approved ? "secondary" : "success"} disabled={!entries.length} onClick={() => setApproveOpen(true)}>
            <CheckCircle2 className="h-4 w-4" /> {approved ? t("Затвердити зміни") : t("Затвердити")}
          </Button>
        </>}
      </div>

      {isFetching && <div className="mb-2 h-0.5 animate-pulse rounded bg-red-400" />}
      {editable && hasContent && <p className="mb-3 text-xs text-slate-400">💡 {t("Перетягуйте людей між змінами")}{usesAvailability ? t(", запасом") : ""} {t("та списком вільних.")} {approved && t("Графік затверджено — заміни теж можна вносити.")}</p>}

      {!hasContent ? (
        <Empty>{usesAvailability
          ? t("Графіку ще немає. Перевірте замовлення й доступність, тоді натисніть «Згенерувати».")
          : t("Немає активних працівників цієї фабрики. Додайте працівників і замовлення, тоді «Згенерувати» або перетягніть вручну.")}</Empty>
      ) : (
        <div className="space-y-4">
          {DAYS.map((day, di) => {
            const dayAvail = available[day] ?? [];
            return (
              <Card key={day} className="overflow-hidden">
                <div className="flex items-baseline gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2">
                  <span className="text-sm font-semibold text-slate-700">{DAY_FULL[day]}</span>
                  <span className="text-xs font-medium text-slate-400">{dayDate(weekStart, di)}</span>
                  {entries.some(e => e.day === day) && (
                    <div className="ml-auto flex items-center gap-1">
                      <a
                        href={`/api/schedule/excel?weekStart=${weekStart}&factoryId=${factoryId}&day=${day}`}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                        title={t("Скачати графік на цей день")}>
                        <Download className="h-3 w-3" /> {t("Скачати")}
                      </a>
                      <button
                        className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                        disabled={notifyDay.isPending}
                        title={t("Розіслати графік на цей день працівникам")}
                        onClick={async () => { if (await confirm({ title: t("Розіслати на {day}?", { day: DAY_FULL[day] }), message: t("Працівникам, що мають зміну цього дня, прийде повідомлення."), confirmText: t("Розіслати") })) notifyDay.mutate(day); }}>
                        <Send className="h-3 w-3" /> {t("Розіслати")}
                      </button>
                    </div>
                  )}
                </div>
                <div className={`grid grid-cols-1 divide-y divide-slate-100 ${gridColsClass(shiftCount)} md:divide-x md:divide-y-0`}>
                  {shifts.map(shift => {
                    const list = byDayShift(day, shift);
                    const res = reserve[`${day}-${shift}`] ?? [];
                    const aKey = `${day}-${shift}-a`, rKey = `${day}-${shift}-r`;
                    const ordered = orders[`${day}-${shift}`] ?? 0;
                    const inShift = list.length;
                    const short = ordered > 0 && inShift < ordered;
                    const filled = ordered > 0 ? Math.min(100, Math.round((inShift / ordered) * 100)) : 0;
                    const isPast = shiftStarted(di, shift);
                    const cellEditing = editable && editCells.has(`${day}-${shift}`);
                    const extras = unplanned[`${day}-${shift}`] ?? [];
                    return (
                      <div key={shift} className="p-3">
                        <div className="mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`h-2.5 w-2.5 rounded-full ${shiftDot[shift]}`} />
                            <span className="text-xs font-medium text-slate-600">{SHIFT_UK[shift]}</span>
                            {isPast && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{t("відбулась")}</span>}
                            <span
                              title={ordered > 0 ? t("У зміні {a} із {b} замовлених", { a: inShift, b: ordered }) : t("У зміні {a} · замовлення немає", { a: inShift })}
                              className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                                short ? "bg-amber-50 text-amber-700" : ordered > 0 ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                              }`}>
                              <Users className="h-3 w-3" />{inShift}{ordered > 0 && <span className="font-medium opacity-60">/{ordered}</span>}
                            </span>
                          </div>
                          {ordered > 0 && (
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                                <div className={`h-full rounded-full ${short ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${filled}%` }} />
                              </div>
                              {short && <span className="shrink-0 text-[10px] font-semibold text-amber-600">{t("бракує")} {ordered - inShift}</span>}
                            </div>
                          )}
                          {(usesPositions || usesGender) && (() => {
                            // Per-position actual counts (with gender split) + the order target.
                            const reqLines = orderReq[`${day}-${shift}`] ?? [];
                            const groups = new Map<number | null, { total: number; m: number; f: number }>();
                            for (const e of list) {
                              const k = usesPositions ? (e.positionId ?? null) : null;
                              const g = groups.get(k) ?? { total: 0, m: 0, f: 0 };
                              g.total++; if (e.gender === "male") g.m++; else if (e.gender === "female") g.f++;
                              groups.set(k, g);
                            }
                            if (groups.size === 0 && reqLines.length === 0) return null;
                            return (
                              <div className="mt-1.5 space-y-1">
                                {groups.size > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {[...groups.entries()].map(([pid, g]) => (
                                      <span key={pid ?? "none"} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeClass(posColor(pid))}`}>
                                        {usesPositions && <span className={`h-1.5 w-1.5 rounded-full ${dotClass(posColor(pid))}`} />}{usesPositions ? posName(pid) : t("Усього")} {g.total}
                                        {usesGender && (g.f > 0 || g.m > 0) && <span className="opacity-70">({g.f > 0 && `${g.f}K`}{g.f > 0 && g.m > 0 && " "}{g.m > 0 && `${g.m}M`})</span>}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {reqLines.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
                                    <span className="font-medium uppercase tracking-wide">{t("ціль")}:</span>
                                    {reqLines.map((l, i) => (
                                      <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">
                                        {l.count}{l.gender !== "any" && genderIcon(l.gender)} {l.positionId == null ? t("будь-яка") : posName(l.positionId)}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                        {isPast ? (
                          /* Shift already happened — "what actually happened" (editable attendance) */
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between px-0.5">
                              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{t("Явка")}</span>
                              {editable && (list.length > 0 || extras.length > 0) && (
                                <button onClick={() => toggleEditCell(`${day}-${shift}`)}
                                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${cellEditing ? "border-amber-300 bg-amber-50 text-amber-700" : "border-slate-200 text-slate-400 hover:bg-slate-50 hover:text-slate-600"}`}>
                                  <Pencil className="h-3 w-3" /> {cellEditing ? t("Готово") : t("Редагувати")}
                                </button>
                              )}
                            </div>
                            {[...list].sort(byGroupThenName).map(e => {
                              const present = e.status === "present", absent = e.status === "absent";
                              const tint = present ? "border-emerald-200 bg-emerald-50/60" : absent ? "border-rose-200 bg-rose-50/60" : "border-slate-200 bg-white";
                              return (
                                <div key={e.id} title={e.pickedUpByName ? t("Забрав: {name}", { name: e.pickedUpByName }) : undefined}
                                  className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${tint}`}>
                                  {usesPositions && e.positionId != null && <span title={posName(e.positionId)} className={`h-2 w-2 shrink-0 rounded-full ${dotClass(posColor(e.positionId))}`} />}
                                  <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{e.workerName}</span>
                                  {usesGender && e.gender && <span className={`shrink-0 text-xs font-semibold ${genderClass(e.gender)}`}>{genderIcon(e.gender)}</span>}
                                  {cellEditing ? (
                                    <span className="flex shrink-0 overflow-hidden rounded-lg border border-slate-200">
                                      <button title={t("Вийшов")} onClick={() => setStatus.mutate({ id: e.id, status: present ? "scheduled" : "present" })}
                                        className={`flex h-6 w-7 items-center justify-center transition ${present ? "bg-emerald-500 text-white" : "bg-white text-slate-300 hover:bg-emerald-50 hover:text-emerald-600"}`}><Check className="h-3.5 w-3.5" /></button>
                                      <button title={t("Не вийшов")} onClick={() => setStatus.mutate({ id: e.id, status: absent ? "scheduled" : "absent" })}
                                        className={`flex h-6 w-7 items-center justify-center border-l border-slate-200 transition ${absent ? "bg-rose-500 text-white" : "bg-white text-slate-300 hover:bg-rose-50 hover:text-rose-600"}`}><X className="h-3.5 w-3.5" /></button>
                                    </span>
                                  ) : (
                                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${present ? "bg-emerald-100 text-emerald-700" : absent ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-500"}`}>
                                      {present ? t("вийшов") : absent ? t("не вийшов") : t("не відмічено")}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                            {extras.map((u, i) => (
                              <div key={`u${i}`} className="flex items-center gap-2 rounded-lg border border-dashed border-sky-300 bg-sky-50/60 px-2 py-1.5 text-sm">
                                <span className="min-w-0 flex-1 truncate font-medium text-sky-700">{u.name}</span>
                                {u.workerId == null && editable ? (
                                  <button onClick={() => { setLinkTo({ id: u.id, name: u.name, day, shift }); setLinkQuery(""); }}
                                    title={t("Водій вписав ім'я вручну — прив'яжіть працівника з бази")}
                                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100">
                                    <Link2 className="h-3 w-3" /> {t("прив'язати")}
                                  </button>
                                ) : (
                                  <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-600">{t("➕ додатковий")}</span>
                                )}
                              </div>
                            ))}
                            {!list.length && !extras.length && <div className="px-2 py-1 text-xs text-slate-300">{t("— нікого —")}</div>}
                            {(list.length > 0 || extras.length > 0) && (
                              <div className="flex flex-wrap gap-1.5 px-0.5 pt-0.5 text-[11px]">
                                <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">{list.filter(e => e.status === "present").length} {t("вийшли")}</span>
                                <span className="rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-700">{list.filter(e => e.status === "absent").length} {t("ні")}</span>
                                {list.some(e => e.status === "scheduled") && <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-500">{list.filter(e => e.status === "scheduled").length} {t("не відмічено")}</span>}
                                {extras.length > 0 && <span className="rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-600">+{extras.length} {t("додатк.")}</span>}
                              </div>
                            )}
                            {editable && (
                              <button onClick={() => { setAddTo({ day, shift }); setAddQuery(""); }}
                                className="mt-1 w-full rounded-lg border border-dashed border-slate-300 py-1 text-[11px] font-medium text-slate-400 hover:border-red-300 hover:text-red-600">
                                ➕ {t("Додати людину")}
                              </button>
                            )}
                          </div>
                        ) : (
                        <div {...overProps(aKey)} onDrop={handleDrop(day, shift, "assigned")}
                          className={`min-h-12 space-y-1.5 rounded-lg p-1 transition ${over === aKey ? "bg-red-50 ring-2 ring-red-200" : ""}`}>
                          {groupEntries(list).map(grp => (
                            <div key={grp.key} className="space-y-1">
                              {grp.label && (usesPositions || usesGender) && (
                                <div className="flex items-center gap-1 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                                  {usesPositions && grp.key !== "all" && grp.key !== "null" && <span className={`h-1.5 w-1.5 rounded-full ${dotClass(grp.color)}`} />}
                                  {grp.label} <span className="opacity-60">· {grp.items.length}</span>
                                </div>
                              )}
                              {grp.items.map(e => {
                                const abs = absenceByWorker[`${e.workerId}-${day}-${shift}`];
                                const subFor = substituteFor[`${e.workerId}-${day}-${shift}`];
                                const off = abs && (abs.status === "accepted" || abs.status === "substituted"); // confirmed absence
                                const tip = off ? `${t("Відсутній")}${abs?.reason ? ` — ${abs.reason}` : ""}` : abs?.status === "pending" ? `${t("Відпрошується (не підтверджено)")}${abs.reason ? ` — ${abs.reason}` : ""}` : subFor ? t("Замість {name}", { name: subFor }) : undefined;
                                return (
                                <div key={e.id} draggable={editable} onDragStart={ev => startDrag(ev, { kind: "entry", id: e.id, day, shift })} onDragEnd={() => setOver("")}
                                  title={tip}
                                  className={`group flex items-center gap-1.5 rounded-lg border px-2 py-1 text-sm ${off ? "border-rose-200 bg-rose-50/40" : subFor ? "border-emerald-200 bg-emerald-50/30" : "border-slate-200 bg-white"} ${editable ? "cursor-grab hover:border-red-300 active:cursor-grabbing" : ""}`}>
                                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                                  {usesPositions && e.positionId != null && <span title={posName(e.positionId)} className={`h-2 w-2 shrink-0 rounded-full ${dotClass(posColor(e.positionId))}`} />}
                                  <span className={`min-w-0 flex-1 truncate ${off ? "text-rose-600 line-through decoration-rose-400" : "text-slate-700"}`}>{e.workerName}</span>
                                  {usesGender && e.gender && <span className={`shrink-0 text-xs font-semibold ${genderClass(e.gender)}`}>{genderIcon(e.gender)}</span>}
                                  {abs?.status === "pending" && <span className="shrink-0 text-xs" title={tip}>🙋</span>}
                                  {subFor && <span className="shrink-0 truncate text-[11px] text-emerald-600" style={{ maxWidth: "6.5rem" }}>↪ {subFor.split(" ")[0]}</span>}
                                  {editable && <button onClick={() => removeEntry.mutate(e.id)} className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>}
                                </div>
                                );
                              })}
                            </div>
                          ))}
                          {!list.length && <div className="px-2 py-1 text-xs text-slate-300">{t("— нікого —")}</div>}
                        </div>
                        )}
                        {usesAvailability && !isPast && (
                          <div className="mt-2">
                            <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">{t("Запас")} ({res.length})</div>
                            <div {...overProps(rKey)} onDrop={handleDrop(day, shift, "reserve")}
                              className={`min-h-10 space-y-1 rounded-lg border border-dashed p-1 transition ${over === rKey ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}>
                              {[...res].sort(poolOrder).map(r => (
                                <div key={r.workerId} draggable={editable} onDragStart={ev => startDrag(ev, { kind: "reserve", workerId: r.workerId, day, shift })} onDragEnd={() => setOver("")}
                                  className={`flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm ${editable ? "cursor-grab hover:border-emerald-300 active:cursor-grabbing" : ""}`}>
                                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                                  {usesPositions && r.positionId != null && <span title={posName(r.positionId)} className={`h-2 w-2 shrink-0 rounded-full ${dotClass(posColor(r.positionId))}`} />}
                                  <span className="min-w-0 flex-1 truncate text-slate-600">{r.name}</span>
                                  {usesGender && r.gender && <span className={`shrink-0 text-xs font-semibold ${genderClass(r.gender)}`}>{genderIcon(r.gender)}</span>}
                                  {editable && <button onClick={() => addEntry.mutate({ workerId: r.workerId, day, shift })} className="shrink-0 rounded px-1 text-xs text-emerald-600 hover:bg-emerald-50">+</button>}
                                </div>
                              ))}
                              {!res.length && <div className="px-2 py-1 text-[11px] text-slate-300">{t("перетягни сюди, щоб прибрати")}</div>}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {dayAvail.length > 0 && (
                  <details className="border-t border-slate-100 px-3 py-2">
                    <summary className="cursor-pointer select-none text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {t("Вільні працівники")} ({dayAvail.length}) — {t("перетягни у зміну")}
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {[...dayAvail].sort((a, b) => nameCmp(a.name, b.name)).map(w => (
                        <div key={w.workerId} draggable={editable} onDragStart={ev => startDrag(ev, { kind: "available", workerId: w.workerId, day })} onDragEnd={() => setOver("")}
                          className={`flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 ${editable ? "cursor-grab hover:border-red-300 active:cursor-grabbing" : ""}`}>
                          <GripVertical className="h-3 w-3 shrink-0 text-slate-300" />
                          <span className="truncate">{w.name}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {approveOpen && <ApproveModal factoryName={facName} clientEmail={factory?.clientEmail ?? null} loading={approve.isPending} onClose={() => setApproveOpen(false)} onApprove={(sendEmail) => approve.mutate(sendEmail)} />}

      {addTo && (() => {
        const inShiftIds = new Set(byDayShift(addTo.day, addTo.shift).map(e => e.workerId));
        const q = addQuery.trim().toLowerCase();
        const cands = factoryWorkers
          .filter(w => !inShiftIds.has(w.id))
          .filter(w => !q || w.fullName.toLowerCase().includes(q) || (w.workerCode ?? "").includes(q))
          .sort((a, b) => a.fullName.localeCompare(b.fullName, "pl"))
          .slice(0, 50);
        return (
          <Modal open onClose={() => setAddTo(null)} title={`${t("Додати людину")} — ${DAY_FULL[addTo.day]} · ${SHIFT_UK[addTo.shift]}`}>
            <div className="space-y-3">
              <input autoFocus value={addQuery} onChange={e => setAddQuery(e.target.value)} placeholder={t("Пошук за іменем або кодом")}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-red-300 focus:outline-none" />
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {cands.length === 0 ? <Empty>{t("Нікого не знайдено")}</Empty> : cands.map(w => (
                  <button key={w.id} disabled={addEntry.isPending}
                    onClick={() => { addEntry.mutate({ workerId: w.id, day: addTo.day, shift: addTo.shift }); setAddTo(null); }}
                    className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-red-300 hover:bg-red-50 disabled:opacity-50">
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{w.fullName}</span>
                    {w.workerCode && <span className="shrink-0 font-mono text-xs text-slate-400">{w.workerCode}</span>}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-400">{t("Людину буде додано до зміни; статус «вийшов» позначте в явці.")}</p>
            </div>
          </Modal>
        );
      })()}

      {linkTo && (() => {
        const q = linkQuery.trim().toLowerCase();
        // Not limited to this factory: the driver may have picked up someone assigned elsewhere.
        const cands = allWorkers
          .filter(w => w.isActive)
          .filter(w => !q || w.fullName.toLowerCase().includes(q) || (w.workerCode ?? "").includes(q))
          .sort((a, b) => a.fullName.localeCompare(b.fullName, "pl"))
          .slice(0, 50);
        return (
          <Modal open onClose={() => setLinkTo(null)} title={`${t("Прив'язати «{name}»", { name: linkTo.name })} — ${DAY_FULL[linkTo.day]} · ${SHIFT_UK[linkTo.shift]}`}>
            <div className="space-y-3">
              <input autoFocus value={linkQuery} onChange={e => setLinkQuery(e.target.value)} placeholder={t("Пошук за іменем або кодом")}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-red-300 focus:outline-none" />
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {cands.length === 0 ? <Empty>{t("Нікого не знайдено")}</Empty> : cands.map(w => (
                  <button key={w.id} disabled={linkUnplanned.isPending}
                    onClick={() => { linkUnplanned.mutate({ id: linkTo.id, workerId: w.id }); setLinkTo(null); }}
                    className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-red-300 hover:bg-red-50 disabled:opacity-50">
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{w.fullName}</span>
                    {w.workerCode && <span className="shrink-0 font-mono text-xs text-slate-400">{w.workerCode}</span>}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-400">{t("Запис водія буде прив'язано до працівника, і в явці з'явиться «вийшов».")}</p>
            </div>
          </Modal>
        );
      })()}
    </>
  );
}

function ApproveModal({ factoryName, clientEmail, loading, onClose, onApprove }: {
  factoryName: string; clientEmail: string | null; loading: boolean; onClose: () => void; onApprove: (sendEmail: boolean) => void;
}) {
  const t = useT();
  const [sendEmail, setSendEmail] = useState(false);
  return (
    <Modal open onClose={onClose} title={t("Затвердити графік — {name}", { name: factoryName })}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t("Графік цієї фабрики буде")} <b>{t("збережено на Google Drive")}</b> (Excel). {t("Інші фабрики не зачіпаються.")}</p>
        <label className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${clientEmail ? "border-slate-200" : "border-slate-100 bg-slate-50 opacity-60"}`}>
          <input type="checkbox" className="mt-0.5" disabled={!clientEmail} checked={sendEmail} onChange={e => setSendEmail(e.target.checked)} />
          <span>
            <span className="font-medium text-slate-700">{t("Надіслати на email клієнта")}</span>
            <span className="block text-xs text-slate-500">{clientEmail ? clientEmail : t("email клієнта не вказано (додайте у Фабриках)")}</span>
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button variant="success" loading={loading} onClick={() => onApprove(sendEmail)}>{t("Затвердити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

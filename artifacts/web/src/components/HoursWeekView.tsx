// Вкладка тижня в Обліку годин для фабрики з тижневим обліком (factories.weekly_hours,
// 26.10.2026): по людях — дні Пн–Нд (запис графіку, відмітка старт/кінець, зміна з рапорту,
// години фабрики), три колонки годин (їх відмітки / рапорт / фабрика), різниці, статус
// запиту, «все ок» по тижню, нагадування не подавшим, імпорт тижня, правка відмітки офісом.
// Дані — GET /hours/weeks (routes/hoursWeekly.ts); тиждень завжди цілий Пн–Нд.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BellRing, Check, Upload as UploadIcon, Camera, Pencil, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch } from "../lib/api";
import { Spinner, Badge, Button, Input, Modal, Label } from "./ui";
import { useT } from "../lib/i18n";

type DayCell = {
  date: string;
  entry?: { id: number; shift: string; status: string; hours: number; weekApproved: boolean };
  log?: { id: number; status: string; startedAt: string | null; endedAt: string | null; hours: number | null; startSource: string | null; endSource: string | null };
  report?: { shift: string | null; hours: number };
  factory?: number;
};
export type WeekRow = {
  workerId: number; name: string; code: string | null; isActive: boolean; hasTelegram: boolean;
  days: Record<string, DayCell>; hours: number; hoursUnapproved: number;
  report: { id: number; hoursReported: number | null; daysSum: number; photoLink: string | null; requestSentAt: string | null; remindSentAt: string | null; submittedAt: string | null } | null;
  factory: { id: number; hours: number; daysSum: number; hasDays: boolean; source: string; confirmed: boolean } | null;
};
export type WeekData = { weekStart: string; label: string; dates: string[]; weekApproved: boolean; rows: WeekRow[]; requested: number; submitted: number };
export type WeeksResponse = { factory: { id: number; name: string; shiftCount: number }; month: string; weeks: WeekData[] };

const round = (n: number) => Math.round(n * 100) / 100;
const DAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
// момент (ISO) → настінний Warsaw «HH:MM» / «YYYY-MM-DDTHH:MM» (для datetime-local)
const wallHM = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString("uk-UA", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" }) : "—";
const wallLocal = (iso: string | null) => iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Warsaw" }).slice(0, 16).replace(" ", "T") : "";

export const weeksKey = (factoryId: number, month: string) => ["hours-weeks", factoryId, month] as const;

/** Понеділки тижнів, що мають хоч один день місяця — для підвкладок до завантаження даних. */
export function weeksOfMonth(month: string): { weekStart: string; label: string }[] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y!, m! - 1, 1);
  const dow = first.getDay();
  const mon = new Date(first); mon.setDate(first.getDate() + (dow === 0 ? -6 : 1 - dow));
  const out: { weekStart: string; label: string }[] = [];
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  for (const d = mon; d.getMonth() === m! - 1 || (d.getFullYear() === y && d.getMonth() < m! - 1); d.setDate(d.getDate() + 7)) {
    const ws = fmt(d); const e = new Date(d); e.setDate(d.getDate() + 6);
    out.push({ weekStart: ws, label: `${ddmm(ws)}–${ddmm(fmt(e))}` });
  }
  return out;
}

type DiffState = "match" | "mismatch" | "partial" | "none";
const DIFF_CELL: Record<DiffState, string> = { match: "bg-emerald-50", mismatch: "bg-red-50", partial: "bg-amber-50/60", none: "" };
function diffOf(r: WeekRow): DiffState {
  const rep = r.report?.submittedAt ? r.report.hoursReported : null, fac = r.factory?.hours ?? null;
  if (rep == null && fac == null) return "none";
  if (rep == null || fac == null) return fac != null && r.factory?.confirmed ? "match" : "partial";
  if (Math.abs(rep - fac) <= 0.01) return "match";
  return r.factory?.confirmed ? "match" : "mismatch";
}

export function HoursWeekView({ factoryId, month, weekStart, canEdit, onImport }: {
  factoryId: number; month: string; weekStart: string; canEdit: boolean; onImport: (weekStart: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isFetching } = useQuery<WeeksResponse>({ queryKey: weeksKey(factoryId, month), queryFn: () => get(`/hours/weeks?factoryId=${factoryId}&month=${month}`) });
  const week = data?.weeks.find(w => w.weekStart === weekStart);
  const invalidate = () => { qc.invalidateQueries({ queryKey: weeksKey(factoryId, month) }); qc.invalidateQueries({ queryKey: ["hours", month] }); };
  const remind = useMutation({
    mutationFn: (workerIds?: number[]) => post<{ notified: number; skipped: number }>("/hours/weeks/remind", { factoryId, weekStart, workerIds }),
    onSuccess: r => { toast.success(t("Надіслано: {n}, пропущено: {s}", { n: r.notified, s: r.skipped })); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const confirm = useMutation({
    mutationFn: (v: { workerId: number; confirmed: boolean }) => post("/hours/weeks/confirm", { factoryId, weekStart, ...v }),
    onSuccess: invalidate, onError: (e: any) => toast.error(e.message),
  });
  const [editCell, setEditCell] = useState<{ row: WeekRow; cell: DayCell } | null>(null);
  const totals = useMemo(() => {
    const rows = week?.rows ?? [];
    return {
      hours: round(rows.reduce((s, r) => s + r.hours, 0)),
      report: round(rows.reduce((s, r) => s + (r.report?.submittedAt ? r.report.hoursReported ?? 0 : 0), 0)),
      factory: round(rows.reduce((s, r) => s + (r.factory?.hours ?? 0), 0)),
    };
  }, [week]);
  if (!data && isFetching) return <div className="p-6"><Spinner /></div>;
  if (!week) return <div className="p-6 text-sm text-slate-500">{t("Немає даних за цей тиждень")}</div>;
  const notSubmitted = week.rows.filter(r => !r.report?.submittedAt && r.hasTelegram && r.isActive).map(r => r.workerId);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/60 px-4 py-2 text-xs">
        <Badge color="slate">{t("Тиждень")} {week.label}</Badge>
        {!week.weekApproved && <span title={t("Години з відміток рахуються в місяць лише після затвердження тижня графіку")}><Badge color="amber">{t("тиждень не затверджено")}</Badge></span>}
        <Badge color="blue">{t("Подали рапорт:")} {week.submitted}/{week.rows.length}</Badge>
        <Badge color="green">{t("Їх години:")} {totals.hours}</Badge>
        <Badge color="blue">{t("Рапорт:")} {totals.report}</Badge>
        <Badge color="amber">{t("Фабрика:")} {totals.factory}</Badge>
        {canEdit && (
          <span className="ml-auto inline-flex flex-wrap items-center gap-2">
            <button onClick={() => remind.mutate(notSubmitted)} disabled={remind.isPending || !notSubmitted.length}
              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50"
              title={t("Нагадати в бот усім, хто ще не подав години за цей тиждень")}>
              <BellRing className="h-3.5 w-3.5" /> {t("Нагадати не подавшим")} ({notSubmitted.length})
            </button>
            <button onClick={() => onImport(weekStart)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 font-medium text-amber-700 hover:bg-amber-100"
              title={t("Імпорт годин фабрики за цей тиждень: Excel з днями або вставка «імʼя; пн; вт; …; нд»")}>
              <UploadIcon className="h-3.5 w-3.5" /> {t("Імпорт тижня")}
            </button>
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">{t("Працівник")}</th>
              {week.dates.map((d, i) => <th key={d} className={`px-2 py-2.5 text-center ${i === 0 ? "border-l-2 border-slate-300" : ""} ${i >= 5 ? "bg-slate-200/60" : ""}`}>{t(DAY_SHORT[i]!)}<br /><span className="font-normal normal-case text-slate-400">{ddmm(d)}</span></th>)}
              <th className="border-l-2 border-slate-300 bg-emerald-100/60 px-3 py-2.5 text-right text-emerald-800" title={t("Σ відміток (закриті зміни) затвердженого тижня")}>{t("Їх години")}</th>
              <th className="bg-sky-100/70 px-3 py-2.5 text-right text-sky-800" title={t("Тотал, який працівник вписав сам; у дужках — сума по вибраних змінах")}>{t("Рапорт")}</th>
              <th className="bg-sky-100/70 px-3 py-2.5 text-right text-sky-800">{t("Фабрика")}</th>
              <th className="px-2 py-2.5 text-center" title={t("Рапорт − фабрика")}>Δ</th>
              <th className="px-2 py-2.5 text-center">{t("Запит")}</th>
              <th className="px-2 py-2.5 text-center" title={t("Розбіжність перевірена вручну — все ок")}>✓</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {week.rows.map(r => {
              const ds = diffOf(r);
              const rep = r.report?.submittedAt ? r.report.hoursReported : null;
              const fac = r.factory?.hours ?? null;
              return (
                <tr key={r.workerId} className={`hover:bg-slate-50/60 ${r.isActive ? "" : "text-slate-400"}`}>
                  <td className="px-4 py-1.5 font-medium text-slate-700">{r.name}{r.code && <span className="ml-1.5 text-xs text-slate-400">{r.code}</span>}{!r.hasTelegram && <span className="ml-1.5 text-xs text-amber-600" title={t("Не підключений до бота — запити не отримує")}>⚠︎</span>}</td>
                  {week.dates.map((d, i) => {
                    const c = r.days[d];
                    return (
                      <td key={d} onClick={() => canEdit && c?.entry && setEditCell({ row: r, cell: c })}
                        className={`px-1.5 py-1 text-center align-top text-xs ${i === 0 ? "border-l-2 border-slate-200" : ""} ${i >= 5 ? "bg-slate-50" : ""} ${canEdit && c?.entry ? "cursor-pointer hover:bg-sky-50" : ""}`}>
                        <DayCellView c={c} />
                      </td>
                    );
                  })}
                  <td className="border-l-2 border-slate-200 bg-emerald-50/40 px-3 py-1.5 text-right font-semibold text-emerald-700">
                    {r.hours || (r.hoursUnapproved ? <span className="text-amber-600" title={t("тиждень не затверджено")}>({r.hoursUnapproved})</span> : <span className="text-slate-300">0</span>)}
                  </td>
                  <td className={`px-3 py-1.5 text-right ${DIFF_CELL[ds]}`}>
                    {rep != null ? (
                      <span className="inline-flex items-center justify-end gap-1.5">
                        <span className="font-semibold text-slate-700">{rep}</span>
                        {r.report && Math.abs(r.report.daysSum - rep) > 0.01 && <span className="text-[11px] text-amber-600" title={t("Сума по вибраних змінах відрізняється від вписаного тоталу")}>({r.report.daysSum})</span>}
                        {r.report?.photoLink && <a href={r.report.photoLink} target="_blank" rel="noreferrer" className="text-sky-600 hover:text-sky-800" title={t("Фото рапорту")} onClick={e => e.stopPropagation()}><Camera className="h-3.5 w-3.5" /></a>}
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className={`px-3 py-1.5 text-right ${DIFF_CELL[ds]}`}>
                    <FactoryWeekCell factoryId={factoryId} weekStart={weekStart} row={r} canEdit={canEdit} onSaved={invalidate} />
                  </td>
                  <td className={`px-2 py-1.5 text-center text-xs ${ds === "mismatch" ? "font-semibold text-red-600" : "text-slate-400"}`}>
                    {rep != null && fac != null ? round(rep - fac) || "0" : ""}
                  </td>
                  <td className="px-2 py-1.5 text-center text-xs">
                    {r.report?.submittedAt ? <span className="text-emerald-600" title={new Date(r.report.submittedAt).toLocaleString("uk-UA")}>✅ {t("подав")}</span>
                      : r.report?.remindSentAt ? <span className="text-amber-600">{t("нагадано")}</span>
                      : r.report?.requestSentAt ? <span className="text-sky-600">{t("надіслано")}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {fac != null && (
                      <button disabled={!canEdit || confirm.isPending} onClick={() => confirm.mutate({ workerId: r.workerId, confirmed: !r.factory?.confirmed })}
                        className={`rounded p-1 ${r.factory?.confirmed ? "bg-emerald-100 text-emerald-700" : "text-slate-300 hover:bg-slate-100 hover:text-slate-600"}`} title={t("Все ок (перевірено вручну)")}>
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-slate-50 text-xs font-semibold text-slate-600">
            <tr>
              <td className="px-4 py-2">{t("Разом")}: {week.rows.length} {t("людей")}</td>
              {week.dates.map(d => <td key={d} className="px-2 py-2 text-center text-slate-500">{round(week.rows.reduce((s, r) => s + ((r.days[d]?.entry?.status === "present" ? r.days[d]!.entry!.hours : 0)), 0)) || ""}</td>)}
              <td className="border-l-2 border-slate-200 px-3 py-2 text-right text-emerald-700">{totals.hours}</td>
              <td className="px-3 py-2 text-right text-sky-700">{totals.report}</td>
              <td className="px-3 py-2 text-right text-sky-700">{totals.factory}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
      {editCell && <LogEditModal factoryId={factoryId} month={month} row={editCell.row} cell={editCell.cell} onClose={() => setEditCell(null)} />}
    </div>
  );
}

const LOG_TONE: Record<string, string> = {
  closed: "text-emerald-700", auto: "text-orange-600", open: "text-sky-600", absent: "text-red-600", pending: "text-slate-400", expired: "text-slate-400",
};
function DayCellView({ c }: { c?: DayCell }) {
  const t = useT();
  if (!c || (!c.entry && !c.report?.shift && c.factory == null)) return <span className="text-slate-200">·</span>;
  const l = c.log;
  const logTitle = l ? `${wallHM(l.startedAt)}–${wallHM(l.endedAt)}${l.status === "auto" ? ` · ${t("не закрив за 24 год — зараховано 1 год")}` : l.status === "expired" ? ` · ${t("не відмітив початок")}` : ""}` : "";
  return (
    <div className="leading-tight">
      {c.entry ? (
        <div className={`font-semibold ${c.entry.status === "absent" ? "text-red-600" : l ? LOG_TONE[l.status] ?? "" : "text-slate-600"}`} title={logTitle || (c.entry.status === "present" ? t("явка (без відмітки)") : "")}>
          {c.entry.shift}{t("зм")}
          {c.entry.status === "absent" ? " ✕" : l?.status === "closed" || l?.status === "auto" ? ` ${l.hours}` : l?.status === "open" ? " …" : c.entry.status === "present" ? ` ${c.entry.hours}` : ""}
          {l?.status === "auto" && <AlertTriangle className="ml-0.5 inline h-3 w-3" />}
        </div>
      ) : null}
      {(c.report?.shift || c.factory != null) && (
        <div className="text-[10px] text-slate-400">
          {c.report?.shift && <span title={t("зміна з рапорту працівника")}>📝{c.report.shift}</span>}
          {c.report?.shift && c.factory != null && " "}
          {c.factory != null && <span title={t("години фабрики за день")}>🏭{c.factory}</span>}
        </div>
      )}
    </div>
  );
}

// Клітинка годин фабрики за тиждень — число, Enter зберігає, порожнє прибирає рядок
function FactoryWeekCell({ factoryId, weekStart, row, canEdit, onSaved }: { factoryId: number; weekStart: string; row: WeekRow; canEdit: boolean; onSaved: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const save = useMutation({
    mutationFn: (hours: string | null) => post("/hours/weeks/factory", { factoryId, weekStart, workerId: row.workerId, hours }),
    onSuccess: () => { setEditing(false); onSaved(); }, onError: (e: any) => toast.error(e.message),
  });
  const f = row.factory;
  if (editing) {
    return (
      <Input autoFocus value={val} onChange={e => setVal(e.target.value)} className="w-20 text-right" inputMode="decimal"
        onKeyDown={e => { if (e.key === "Enter") save.mutate(val.trim() === "" ? null : val.trim()); if (e.key === "Escape") setEditing(false); }}
        onBlur={() => setEditing(false)} />
    );
  }
  return (
    <button disabled={!canEdit} onClick={() => { setVal(f ? String(f.hours) : ""); setEditing(true); }}
      className="group inline-flex items-center justify-end gap-1 rounded px-1 hover:bg-white disabled:cursor-default"
      title={f ? `${t("Джерело")}: ${f.source}${f.hasDays ? ` · ${t("по днях")}: ${f.daysSum}` : ` · ${t("без розбивки по днях")}`}` : t("Вписати години фабрики за тиждень")}>
      {f ? <span className="font-semibold text-slate-700">{f.hours}</span> : <span className="text-slate-300">—</span>}
      {f && !f.hasDays && <span className="text-[10px] text-amber-500" title={t("Без розбивки по днях: тиждень на межі місяця піде цілком у місяць четверга")}>∑</span>}
      {canEdit && <Pencil className="invisible h-3 w-3 text-slate-400 group-hover:visible" />}
    </button>
  );
}

// Правка дня офісом: відмітка (старт/кінець → години) або години/статус запису графіку без відмітки
function LogEditModal({ factoryId, month, row, cell, onClose }: { factoryId: number; month: string; row: WeekRow; cell: DayCell; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const l = cell.log;
  const [startedAt, setStartedAt] = useState(wallLocal(l?.startedAt ?? null));
  const [endedAt, setEndedAt] = useState(wallLocal(l?.endedAt ?? null));
  const [hours, setHours] = useState(String(l?.hours ?? cell.entry?.hours ?? ""));
  const [status, setStatus] = useState(cell.entry?.status ?? "scheduled");
  const invalidate = () => { qc.invalidateQueries({ queryKey: weeksKey(factoryId, month) }); qc.invalidateQueries({ queryKey: ["hours", month] }); };
  const save = useMutation({
    mutationFn: async () => {
      if (l && (l.status === "open" || l.status === "closed" || l.status === "auto")) {
        await patch(`/hours/shift-logs/${l.id}`, {
          startedAt: startedAt ? startedAt.replace("T", " ") : null, endedAt: endedAt ? endedAt.replace("T", " ") : null,
          hours: hours.trim() ? Number(hours.replace(",", ".")) : null,
        });
      } else if (cell.entry) {
        await patch(`/worker-days/entry/${cell.entry.id}`, { status, hoursOverride: status === "present" && hours.trim() ? Number(hours.replace(",", ".")) : null });
      }
    },
    onSuccess: () => { toast.success(t("Збережено")); invalidate(); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const hasLog = !!l && (l.status === "open" || l.status === "closed" || l.status === "auto");
  return (
    <Modal open onClose={onClose} title={`${row.name} · ${ddmm(cell.date)}${cell.entry ? ` · ${cell.entry.shift} ${t("зм")}` : ""}`} size="md">
      <div className="space-y-3">
        {l && <div className="text-xs text-slate-500">{t("Відмітка")}: {t(`log.${l.status}`)}{l.startSource ? ` · ${t("старт")}: ${t(`src.${l.startSource}`)}` : ""}{l.endSource ? ` · ${t("кінець")}: ${t(`src.${l.endSource}`)}` : ""}</div>}
        {hasLog ? (
          <>
            <div><Label>{t("Початок (Warsaw)")}</Label><Input type="datetime-local" value={startedAt} onChange={e => setStartedAt(e.target.value)} /></div>
            <div><Label>{t("Кінець (Warsaw)")}</Label><Input type="datetime-local" value={endedAt} onChange={e => setEndedAt(e.target.value)} /></div>
            <div><Label>{t("Години (порожнє = з часу)")}</Label><Input value={hours} onChange={e => setHours(e.target.value)} inputMode="decimal" /></div>
            <p className="text-xs text-slate-400">{t("Години пишуться у запис графіку (явка + години) — їх побачать місяць і сводна.")}</p>
          </>
        ) : (
          <>
            <div>
              <Label>{t("Статус")}</Label>
              <select value={status} onChange={e => setStatus(e.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                <option value="scheduled">{t("заплановано")}</option>
                <option value="present">{t("явка")}</option>
                <option value="absent">{t("відсутній")}</option>
              </select>
            </div>
            {status === "present" && <div><Label>{t("Години")}</Label><Input value={hours} onChange={e => setHours(e.target.value)} inputMode="decimal" /></div>}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

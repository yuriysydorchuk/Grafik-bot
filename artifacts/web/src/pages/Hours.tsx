import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Factory as FactoryIcon, AlertTriangle, BellRing, CheckCircle2, Clock, Columns3, Download, Check, Send, X, XCircle, Pencil, Plus, Trash2, Upload as UploadIcon, Mail, RotateCcw, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { get, post, del, upload } from "../lib/api";
import { monthOptions } from "../lib/dates";
import { Card, Spinner, Select, Empty, Badge, Button, Input, Modal, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { WorkerDaysModal } from "../components/DetailModals";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT, useLang } from "../lib/i18n";
import { useOrderPref, orderBy, useDragOrder } from "../lib/prefs";
import { FIRM_TAB } from "../lib/colors";

interface Dispute { workerId: number; status: string }

// Значення дня «годин з фабрики»: разом за день або { "№зміни": год } (ewidencja I/II/III)
type FacDayVal = number | Record<string, number>;
const facDayTotal = (v: FacDayVal) => typeof v === "number" ? v : Object.values(v).reduce((s, h) => s + h, 0);

interface HourRow {
  workerId: number; name: string; code: string | null; factoryId: number | null; factory: string | null;
  firm?: string | null; // наша юрособа фабрики (ES/ESO/Klinex) — колір вкладки
  city: string; factoryShiftCount: number; byShift: Record<string, number>; shifts: number; hours: number;
  reportHours?: number | null; reportSubmitted?: boolean; reportLink?: string | null;
  factoryHours?: number | null; factoryDays?: Record<string, FacDayVal> | null; factoryConfirmed?: boolean; clientEmail?: string | null;
  createdViaImport?: boolean; // профіль створений «створити профіль» в імпорті годин → можна 🗑 зі списку
  // запит «підтверди свої години» в бот і відповідь працівника
  askSentAt?: string | null; askHours?: number | null;
  workerResponse?: "confirmed" | "dispute" | null; workerResponseAt?: string | null; workerNote?: string | null;
  note?: string | null; // ручна замітка графіка/офісу (hours_notes)
  unlegalized?: boolean; // без форми легалізації або oczekuje — лише з cap svodni
  rate?: number; gross?: number; net?: number; laborCost?: number; reportNet?: number | null; reportGross?: number | null; // owner only
}
interface Group { key: string; name: string; factoryId: number | null; firm: string | null; city: string; n: number; rows: HourRow[]; shifts: number; hours: number; net: number }
// активний працівник, прихований з місяця (hours_month_exclusions)
interface ExcludedInfo { workerId: number; name: string; factoryId: number | null; reason: string }
const EXCL_REASON_LABEL: Record<string, string> = { manual: "прибрано", vacation: "відпустка", not_started: "ще не приступив" };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

// Звірка «рапорт працівника vs години фабрики» для підсвітки рядка:
// match — обидва є і збігаються (±0.01), mismatch — розходяться, partial — є лише одне.
// Розбіжність, підтверджену вручну («все ок», factoryConfirmed) — світимо зеленим.
type DiffState = "match" | "mismatch" | "partial" | "none";
function diffState(w: HourRow): DiffState {
  const rep = w.reportHours ?? null, fac = w.factoryHours ?? null;
  if (rep == null && fac == null) return "none";
  // фабричні години є, а свого рапорту ще нема — ручне «все ок» теж зеленить
  if (rep == null || fac == null) return fac != null && w.factoryConfirmed ? "match" : "partial";
  if (Math.abs(rep - fac) <= 0.01) return "match";
  return w.factoryConfirmed ? "match" : "mismatch";
}
const DIFF_CELL: Record<DiffState, string> = {
  match: "bg-emerald-50", mismatch: "bg-red-50", partial: "bg-amber-50/60", none: "bg-sky-50/40",
};

// Каталог колонок таблиці в дефолтному порядку (drag за заголовок переставляє,
// «×» ховає — суто відображення: суми, редагування і Excel-експорт не залежать).
// shiftBlock = колонки «1/2/3 зм» одним цілим (їх кількість різна по фабриках).
const HOURS_COLS: [string, string][] = [
  ["code", "Код"], ["shiftBlock", "Розбивка по змінах"], ["totalShifts", "Усього змін"], ["hours", "Години"],
  ["report", "Години з рапорту"], ["factory", "Години з фабрики"], ["ack", "Підтв. працівника"], ["note", "Замітки"],
  ["rate", "Ставка"], ["net", "ЗП нетто"], ["reportNet", "ЗП по рапорту"],
];
const HOURS_COL_KEYS = HOURS_COLS.map(([k]) => k);
const OWNER_COL_KEYS = new Set(["rate", "net", "reportNet"]);

export default function Hours() {
  const t = useT();
  const { lang } = useLang();
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const me = useMe();
  const isOwner = me?.role === "owner";
  // Місяць і вкладки живуть в URL (?m=&city=&fac=) — оновлення сторінки
  // повертає на те саме місце, а не на «всі фабрики, поточний місяць»
  const [month, setMonth] = useState(() => {
    // URL → localStorage → поточний: перехід через меню (без query) не скидає місяць
    const m = new URLSearchParams(window.location.search).get("m") ?? localStorage.getItem("hours.month");
    return m && months.some(x => x.value === m) ? m : months[0]!.value;
  });
  const [cityTab, setCityTab] = useState(() => new URLSearchParams(window.location.search).get("city") ?? "");   // "" = всі міста
  const [facTab, setFacTab] = useState(() => new URLSearchParams(window.location.search).get("fac") ?? "");      // ключ групи ("" = всі фабрики)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (month !== months[0]!.value) p.set("m", month); else p.delete("m");
    if (cityTab) p.set("city", cityTab); else p.delete("city");
    if (facTab) p.set("fac", facTab); else p.delete("fac");
    const q = p.toString();
    window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
    try { localStorage.setItem("hours.month", month); } catch { /* ignore */ }
  }, [month, cityTab, facTab, months]);
  const [sel, setSel] = useState<{ id: number; name: string } | null>(null);
  // Ключі груп, для яких відкриті модалки (сам Group береться свіжим із query —
  // так лист/превʼю живо перераховуються після правок годин)
  const [importKey, setImportKey] = useState<string | null>(null);
  const [facKeysKey, setFacKeysKey] = useState<string | null>(null); // модалка «Ключі фабрики» (особисті номери працівників)
  const [emailKey, setEmailKey] = useState<string | null>(null);
  const [notifyKey, setNotifyKey] = useState<string | null>(null); // розсилка «підтверди свої години» у бот
  // Excel-експорт: модалка вибору стовпчиків (+ фільтр «лише помилки»); factoryId=null → всі фабрики
  const [exportTo, setExportTo] = useState<{ factoryId: number | null; name: string } | null>(null);
  // Імпорт файла фабрики, якої ще НЕМАЄ у вкладках місяця (перший імпорт:
  // жодних явок/рапортів — вкладка зʼявиться після збереження годин).
  // Типовий кейс — Eurocash: графік не ведеться в системі, всі дані з файлу.
  const [importFacId, setImportFacId] = useState<number | null>(null);
  // мультивибір рядків (по людині) → групові дії: прибрати зі списку місяця / звільнити з датою
  const [selWorkers, setSelWorkers] = useState<Record<number, boolean>>({});
  useEffect(() => setSelWorkers({}), [month]);
  const [fireIds, setFireIds] = useState<number[] | null>(null);       // модалка звільнення
  const [hiddenFor, setHiddenFor] = useState<{ factoryId: number | null; name: string } | null>(null); // модалка «приховані»
  const [leftoverKey, setLeftoverKey] = useState<string | null>(null); // «залишки» після імпорту годин
  const { data: allFactories = [] } = useQuery<{ id: number; name: string; city?: string | null }[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const monthLabel = months.find(m => m.value === month)?.label ?? month;
  const { data, isFetching } = useQuery<{ month: string; workers: HourRow[]; excluded?: ExcludedInfo[]; svodniDone?: number[]; totalHours: number; totalShifts: number; totalReportHours: number; totalFactoryHours?: number; totalNet?: number; totalReportNet?: number }>({
    queryKey: ["hours", month], queryFn: () => get(`/hours?month=${month}`),
  });
  const { data: disputes = [] } = useQuery<Dispute[]>({ queryKey: ["hours-reports"], queryFn: () => get("/hours-reports") });
  const openByWorker = useMemo(() => new Set(disputes.filter(d => d.status === "new").map(d => d.workerId)), [disputes]);
  const canEdit = can(me, "editData");
  // Видалення випадково створеного дубля прямо зі списку (лише рядки без
  // жодної зміни місяця — профілі з реальними явками так не приберуться)
  const canDelete = can(me, "deleteWorkers");
  const qc = useQueryClient();
  const delWorker = useMutation({
    mutationFn: (id: number) => del(`/workers/${id}`),
    onSuccess: () => {
      toast.success(t("Профіль видалено"));
      qc.invalidateQueries({ queryKey: ["hours", month] });
      qc.invalidateQueries({ queryKey: ["workers"] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  const selIds = useMemo(() => Object.entries(selWorkers).filter(([, v]) => v).map(([k]) => Number(k)), [selWorkers]);
  const nameById = useMemo(() => new Map((data?.workers ?? []).map(w => [w.workerId, w.name])), [data]);
  // «Прибрати зі списку місяця»: ховає лише порожній авто-рядок людини; реальні
  // дані (явки/рапорт/години фабрики) повертають рядок автоматично
  const excludeSel = useMutation({
    mutationFn: (p: { workerIds: number[]; reason: string }) =>
      post<{ saved: number }>("/hours/exclusions", { month, items: p.workerIds.map(id => ({ workerId: id, reason: p.reason })) }),
    onSuccess: (r) => {
      toast.success(t("Приховано зі списку місяця: {n}", { n: r.saved }));
      setSelWorkers({});
      qc.invalidateQueries({ queryKey: ["hours", month] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  // Очистити колонку «Години з фабрики» вкладки — перед завантаженням нового файла
  const clearFactoryHours = useMutation({
    mutationFn: (g: Group) => post<{ cleared: number }>("/hours/factory-clear", {
      month, factoryId: g.factoryId,
      workerIds: g.rows.filter(w => w.factoryHours != null).map(w => w.workerId),
    }),
    onSuccess: (r) => {
      toast.success(t("Очищено годин фабрики: {n}", { n: r.cleared }));
      qc.invalidateQueries({ queryKey: ["hours", month] });
      qc.invalidateQueries({ queryKey: ["hours-day-compare"] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  const remind = useMutation({
    // Server picks the report month by the collection window (first days of a month → prev month)
    mutationFn: () => post<{ notified: number; total: number; month: string }>("/hours/report-remind", {}),
    onSuccess: (r) => toast.success(t("Нагадування про рапорт надіслано: {n} з {total}", { n: r.notified, total: r.total }), {
      description: months.find(m => m.value === r.month)?.label ?? r.month,
    }),
    onError: (e: any) => toast.error(e.message),
  });
  // «Години підтверджені → до сводної»: весь місяць, одне місто або одна фабрика.
  // Джерело годин вибирається в модалці: рапорти працівників / години з
  // фабрики / чисті явки.
  const [svodniAsk, setSvodniAsk] = useState<{ label: string; scope: { factoryId?: number; city?: string } } | null>(null);
  const [svodniSource, setSvodniSource] = useState<"reports" | "factory" | "attendance">("reports");
  const toSvodni = useMutation({
    mutationFn: (v: { factoryId?: number; city?: string; source: string; workerIds?: number[] }) =>
      post<{ created: number; updated: number; workers: number; noNettoRate: number; skippedLocked: number; noCity: string[]; verified: number; verifyMismatches: { name: string; label: string; expected: number; actual: number | null }[]; eurocashUnmatched?: { name: string; reason: string }[]; debtCarried?: { name: string; factoryLabel: string; amount: number }[]; debtUnmatched?: { name: string; factoryLabel: string; amount: number }[] }>("/svodni/from-hours", { month, ...v }),
    onSuccess: (r) => {
      // самозвірка бекенду: передані години ↔ що реально видно в сводній
      if (r.verifyMismatches?.length) {
        toast.error(t("⚠️ Після запису розійшлись години ({n}): {list}", {
          n: r.verifyMismatches.length,
          list: r.verifyMismatches.slice(0, 5).map(m => `${m.name} ${m.expected}→${m.actual ?? "—"}`).join(", "),
        }));
      }
      // Eurocash: кому не вдалося порахувати ставку від порогу — і чому
      if (r.eurocashUnmatched?.length) {
        toast.error(t("⚠️ Eurocash: ставка не проставлена ({n}): {list}", {
          n: r.eurocashUnmatched.length,
          list: r.eurocashUnmatched.slice(0, 5).map(m => `${m.name} — ${m.reason}`).join("; "),
        }));
      }
      // борги минулого місяця (мінусові виплати), які не вдалося перенести
      if (r.debtUnmatched?.length) {
        toast.warning(t("⚠️ Борг минулого місяця не перенесено ({n}): {list}", {
          n: r.debtUnmatched.length,
          list: r.debtUnmatched.slice(0, 5).map(m => `${m.name} ${m.amount} zł (${m.factoryLabel})`).join("; "),
        }));
      }
      const debtSum = (r.debtCarried ?? []).reduce((a, d) => a + d.amount, 0);
      toast.success(t("Сводна {month}: створено {c}, оновлено {u}", { month, c: r.created, u: r.updated }), {
        description: [
          r.verified && !r.verifyMismatches?.length ? t("Перевірка: {n} рядків — години в сводній збігаються", { n: r.verified }) : null,
          r.debtCarried?.length ? t("Перенесено боргів з минулого місяця: {n} (разом {sum} zł)", { n: r.debtCarried.length, sum: Math.round(debtSum * 100) / 100 }) : null,
          r.noNettoRate ? t("Без ставки нетто (виплата не порахована): {n} — заповни в профілі чи сводній", { n: r.noNettoRate }) : null,
          r.skippedLocked ? t("Пропущено затверджених фабрик: {n}", { n: r.skippedLocked }) : null,
          r.noCity?.length ? t("Місто фабрики невідоме (пропущено): {list} — фабрика ще не зустрічалась ні в сводних, ні в Зарплатах", { list: r.noCity.join(", ") }) : null,
        ].filter(Boolean).join(" · ") || undefined,
      });
      setSvodniAsk(null);
      qc.invalidateQueries({ queryKey: ["hours", month] }); // маркер ✓ «перенесено» на вкладках
    },
    onError: (e: any) => toast.error(e.message),
  });
  const confirmToSvodni = (label: string, scope: { factoryId?: number; city?: string }) => setSvodniAsk({ label, scope });

  const groups = useMemo<Group[]>(() => {
    // Одна вкладка на фабрику: фабрика шле одну евіденцію на всіх, незалежно
    // від фірм працівників. multi_firm стосується лише сводної (from-hours
    // пише фірму в рядок — групи фірм усередині однієї вкладки).
    const map = new Map<string, Group>();
    for (const r of data?.workers ?? []) {
      const key = r.factoryId != null ? `f${r.factoryId}` : "none";
      if (!map.has(key)) map.set(key, {
        key,
        name: r.factory ?? t("Без фабрики"),
        factoryId: r.factoryId, firm: r.firm ?? null, city: r.city,
        n: Math.max(1, r.factoryShiftCount || 1), rows: [], shifts: 0, hours: 0, net: 0,
      });
      const g = map.get(key)!;
      g.rows.push(r); g.shifts += r.shifts; g.hours += r.hours; g.net += r.net ?? 0;
    }
    return [...map.values()];
  }, [data]);
  // Персональний порядок вкладок (drag-and-drop, живе в admins.web_prefs)
  const [cityOrder, saveCityOrder] = useOrderPref("order.hours.cities");
  const [facOrder, saveFacOrder] = useOrderPref("order.hours.factories");
  // Персональний порядок і видимість колонок таблиці (той самий механізм, що
  // для вкладок — живе в admins.web_prefs, їде за користувачем між пристроями)
  const [colOrder, saveColOrder] = useOrderPref("order.hours.cols");
  const [hiddenColsArr, saveHiddenCols] = useOrderPref("hidden.hours.cols");
  const hiddenCols = useMemo(() => new Set(hiddenColsArr), [hiddenColsArr]);
  const toggleCol = (k: string) => saveHiddenCols(hiddenCols.has(k) ? hiddenColsArr.filter(x => x !== k) : [...hiddenColsArr, k]);
  const [showCols, setShowCols] = useState(false); // панель чипсів «Колонки»
  const colKeys = useMemo(
    () => orderBy(HOURS_COL_KEYS.filter(k => isOwner || !OWNER_COL_KEYS.has(k)), k => k, colOrder).filter(k => !hiddenCols.has(k)),
    [colOrder, isOwner, hiddenCols]);
  const colDrag = useDragOrder(colKeys, saveColOrder);
  // місто → його фабрики (для заголовків і кнопки «місто → до сводної»)
  const cityGroups = useMemo(() => {
    const map = new Map<string, Group[]>();
    for (const g of orderBy(groups, x => x.key, facOrder)) (map.get(g.city) ?? map.set(g.city, []).get(g.city)!).push(g);
    // «Без міста» — завжди в кінці, решта міст за алфавітом; далі — порядок користувача
    const last = (c: string) => c === "Без міста" ? 1 : 0;
    const sorted = [...map.entries()].sort((a, b) => last(a[0]) - last(b[0]) || a[0].localeCompare(b[0]));
    return orderBy(sorted, ([c]) => c, cityOrder);
  }, [groups, cityOrder, facOrder]);
  // Вкладки: місто → фабрики в ньому; невалідний вибір (інший місяць) тихо падає на «всі»
  const cities = cityGroups.map(([c]) => c);
  const effCity = cities.includes(cityTab) ? cityTab : "";
  const orderedGroups = useMemo(() => cityGroups.flatMap(([, gs]) => gs), [cityGroups]);
  const facTabs = useMemo(() => orderedGroups.filter(g => !effCity || g.city === effCity), [orderedGroups, effCity]);
  // Drag по повному списку (не лише видимому місту) — порядок інших міст не губиться
  const cityDrag = useDragOrder(cities, saveCityOrder);
  const facDrag = useDragOrder(orderedGroups.map(g => g.key), saveFacOrder);
  const effFac = facTabs.some(g => g.key === facTab) ? facTab : "";
  const shownCityGroups = useMemo(() => cityGroups
    .filter(([c]) => !effCity || c === effCity)
    .map(([c, gs]) => [c, gs.filter(g => !effFac || g.key === effFac)] as const)
    .filter(([, gs]) => gs.length > 0), [cityGroups, effCity, effFac]);

  const round = (n: number) => Math.round(n * 100) / 100;
  // Унікальні люди місяця (рядки — пари працівник+фабрика, переведені мають 2+)
  const totalPeople = useMemo(() => new Set((data?.workers ?? []).map(w => w.workerId)).size, [data]);

  return (
    <>
      <PageHeader title={t("Облік годин")} subtitle={t("Відпрацьовані зміни й фактичні години за місяць (із затвердженого графіку)")} />
      {/* Controls + city/factory tabs pinned under the top bar while tables scroll
          (md+ only) — same pattern as Schedule: top-[52px] = desktop top-bar height − 1px,
          -mx-8/px-8 undo the main padding so the opaque strip spans full width. */}
      <div className="mb-4 md:sticky md:top-[52px] md:z-20 md:-mx-8 md:bg-page md:px-8 md:pb-3 md:pt-2 md:shadow-[0_6px_10px_-8px_rgb(15_23_42/0.12)]">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        {data && (
          <div className="flex gap-2">
            <Badge color="slate">{t("Людей:")} {totalPeople}</Badge>
            <Badge color="slate">{t("Усього змін:")} {data.totalShifts}</Badge>
            <Badge color="green">{t("Усього годин:")} {round(data.totalHours)}</Badge>
            {isOwner && data.totalNet != null && <Badge color="green">{t("ЗП нетто:")} {round(data.totalNet)} zł</Badge>}
            <Badge color="blue">{t("Годин з рапорту:")} {round(data.totalReportHours ?? 0)}</Badge>
            <Badge color="amber">{t("Годин з фабрики:")} {round(data.totalFactoryHours ?? 0)}</Badge>
            {isOwner && data.totalReportNet != null && <Badge color="blue">{t("ЗП по рапорту:")} {round(data.totalReportNet)} zł</Badge>}
          </div>
        )}
        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            {can(me, "svodni") && (
              <Button loading={toSvodni.isPending}
                onClick={() => confirmToSvodni(`${monthLabel} — ${t("всі фабрики")}`, {})}>
                <Check className="h-4 w-4" /> {t("Години підтверджені → до сводної")}
              </Button>
            )}
            <Button variant="secondary" loading={remind.isPending} onClick={() => remind.mutate()}><BellRing className="h-4 w-4" /> {t("Нагадати про рапорт")}</Button>
            <button onClick={() => setExportTo({ factoryId: null, name: t("всі фабрики") })} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" /> {t("Excel рапорту")}</button>
            {/* перший імпорт місяця: фабрика без вкладки (немає явок/рапортів) —
                вибір зі списку відкриває ту саму модалку імпорту */}
            <Select value="" onChange={e => { const id = Number(e.target.value); if (id) setImportFacId(id); }}
              className="w-52" title={t("Імпорт годин з файла фабрики або вставленого списку")}>
              <option value="">{t("Імпорт файла фабрики…")}</option>
              {allFactories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </div>
        )}
      </div>

      {/* Вкладки міст + фабрик вибраного міста — фільтрують список нижче */}
      {cities.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl bg-slate-100 p-1">
              {[...cities, ""].map(c => (
                <button key={c || "all"} onClick={() => { setCityTab(c); setFacTab(""); }}
                  {...(c ? { ...cityDrag(c), title: t("Перетягни, щоб змінити порядок") } : {})}
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${effCity === c ? "bg-white text-red-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                  {c ? t(c) : t("Всі міста")}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
            {[null, ...facTabs].map(g => {
              const active = effFac === (g?.key ?? "");
              const fc = g?.firm ? FIRM_TAB[g.firm] : undefined;
              return (
                <button key={g?.key ?? "all"} onClick={() => setFacTab(g?.key ?? "")}
                  {...(g ? { ...facDrag(g.key), title: t("Перетягни, щоб змінити порядок") } : {})}
                  className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition ${
                    active ? "border-red-600 bg-red-600 text-white shadow-sm"
                    : fc ? fc.idle
                    : "border-slate-200 bg-white text-slate-600 hover:border-red-300"}`}>
                  {fc && <span className={`h-2 w-2 shrink-0 rounded-full ${fc.dot} ${active ? "ring-1 ring-white/80" : ""}`} />}
                  {g ? g.name : t("Всі фабрики")}
                  {g && g.factoryId != null && data?.svodniDone?.includes(g.factoryId) && (
                    <span title={t("Перенесено до сводної")}
                      className={`shrink-0 rounded-full p-0.5 ${active ? "bg-white/25 text-white" : "bg-emerald-100 text-emerald-700"}`}>
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    </span>
                  )}
                  <span className={`rounded-full px-1.5 text-[10px] font-medium ${active ? "bg-red-500 text-red-50" : "bg-slate-100 text-slate-500"}`}>
                    {g ? g.rows.length : facTabs.reduce((s, x) => s + x.rows.length, 0)}
                  </span>
                </button>
              );
            })}
          </div>
          {/* видимість колонок таблиць — персональна, як і порядок (× на заголовку теж ховає) */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button onClick={() => setShowCols(v => !v)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${showCols ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
              <Columns3 className="h-3.5 w-3.5" /> {t("Колонки")}
              {hiddenCols.size > 0 && (
                <span className="rounded-full bg-rose-100 px-1.5 text-[10px] font-semibold text-rose-700" title={t("Приховано колонок — клікни, щоб показати список")}>
                  −{hiddenCols.size}
                </span>
              )}
            </button>
            {showCols && (
              <>
                {HOURS_COLS.filter(([k]) => isOwner || !OWNER_COL_KEYS.has(k)).map(([k, label]) => {
                  const off = hiddenCols.has(k);
                  return (
                    <button key={k} onClick={() => toggleCol(k)}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                        off ? "bg-slate-100 text-slate-400 line-through hover:text-slate-600" : "bg-red-50 text-red-700 ring-1 ring-red-200"}`}>
                      {t(label)}
                    </button>
                  );
                })}
                {hiddenCols.size > 0 && (
                  <button className="text-[11px] text-red-600 hover:underline" onClick={() => saveHiddenCols([])}>{t("показати всі")}</button>
                )}
              </>
            )}
          </div>
        </>
      )}
      </div>{/* /sticky header */}

      {openByWorker.size > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-2.5 text-sm text-amber-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{openByWorker.size} {t(openByWorker.size === 1 ? "працівник має скаргу" : "працівників мають скарги")} {t("на години — позначені ⚠️. Клікніть на них, щоб переглянути й затвердити.")}</span>
        </div>
      )}

      {isFetching && !data ? <Spinner /> : !groups.length ? <Empty>{t("За цей місяць немає затверджених змін")}</Empty> : (
        <div className="space-y-12">
          {shownCityGroups.map(([city, cityGs]) => (
          <div key={city}>
            <div className="mb-3 flex items-center gap-2.5 border-b-2 border-slate-200 pb-2">
              <span className="h-5 w-1.5 rounded-full bg-red-600" />
              <h2 className="text-lg font-bold tracking-tight text-slate-900">{t(city)}</h2>
              <Badge color="slate">{cityGs.length} {t("фабрик")}</Badge>
              <Badge color="slate">{new Set(cityGs.flatMap(g => g.rows.map(w => w.workerId))).size} {t("людей")}</Badge>
              <Badge color="green">{round(cityGs.reduce((s, g) => s + g.hours, 0))} {t("год")}</Badge>
              {/* при відкритій вкладці ОДНІЄЇ фабрики міську кнопку ховаємо —
                  вона висить прямо над таблицею і її плутали з фабричною
                  (переносила все місто замість 3 рядків вкладки) */}
              {can(me, "svodni") && canEdit && !effFac && (
                <button onClick={() => confirmToSvodni(city, { city })} disabled={toSvodni.isPending}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
                  <Check className="h-3.5 w-3.5" /> {t("Місто → до сводної")}
                </button>
              )}
            </div>
            <div className="space-y-8">
          {cityGs.map(g => {
            const cols = Array.from({ length: g.n }, (_, i) => String(i + 1));
            // Заголовок колонки: drag переставляє, «×» (на ховері) ховає; reactKey —
            // для клітинок shiftBlock, де кілька th належать одній логічній колонці
            const colTh = (key: string, className: string, label: ReactNode, opts?: { title?: string; reactKey?: string }) => (
              <th key={opts?.reactKey ?? key} {...colDrag(key)} title={opts?.title ?? t("Перетягни, щоб змінити порядок")}
                className={`group/th cursor-grab ${className}`}>
                <span className="inline-flex items-center gap-1">
                  {label}
                  <button type="button" onClick={() => toggleCol(key)} title={t("Сховати колонку")}
                    className="invisible rounded px-0.5 text-slate-300 hover:bg-slate-200 hover:text-slate-600 group-hover/th:visible">×</button>
                </span>
              </th>
            );
            // Опис колонок: порядок задає colKeys (drag за заголовок), рендер клітинок — 1:1 як раніше
            const colDefs: Record<string, { th: () => ReactNode; td: (w: HourRow) => ReactNode; foot: () => ReactNode }> = {
              code: {
                th: () => colTh("code", "px-4 py-2.5", t("Код")),
                td: w => <td key="code" className="px-4 py-1.5 text-slate-400">{w.code ?? "—"}</td>,
                foot: () => <td key="code" />,
              },
              shiftBlock: {
                th: () => <Fragment key="shiftBlock">{cols.map((c, ci) => colTh("shiftBlock", `px-3 py-2.5 text-center ${ci === 0 ? "border-l-2 border-slate-300" : ""}`, `${c} ${t("зм")}`, { reactKey: c }))}</Fragment>,
                td: w => <Fragment key="shiftBlock">{cols.map((c, ci) => <td key={c} className={`px-3 py-1.5 text-center text-slate-600 ${ci === 0 ? "border-l-2 border-slate-200" : ""}`}>{w.byShift[c] || <span className="text-slate-300">0</span>}</td>)}</Fragment>,
                foot: () => <Fragment key="shiftBlock">{cols.map(c => <td key={c} />)}</Fragment>,
              },
              totalShifts: {
                th: () => colTh("totalShifts", "border-l-2 border-slate-300 px-4 py-2.5 text-center", t("Усього змін")),
                td: w => <td key="totalShifts" className="border-l-2 border-slate-200 px-4 py-1.5 text-center font-medium text-slate-700">{w.shifts}</td>,
                foot: () => <td key="totalShifts" className="px-4 py-2.5 text-center">{g.shifts}</td>,
              },
              hours: {
                th: () => colTh("hours", "bg-emerald-100/60 px-4 py-2.5 text-right text-emerald-800", t("Години")),
                td: w => <td key="hours" className="bg-emerald-50/40 px-4 py-1.5 text-right font-semibold text-emerald-700">{round(w.hours)} {t("год")}</td>,
                foot: () => <td key="hours" className="px-4 py-2.5 text-right text-emerald-700">{round(g.hours)} {t("год")}</td>,
              },
              report: {
                th: () => colTh("report", "border-l-2 border-slate-300 bg-sky-100/70 px-4 py-2.5 text-right text-sky-800", t("Години з рапорту")),
                td: w => <td key="report" className={`border-l-2 border-slate-200 px-4 py-1.5 text-right ${DIFF_CELL[diffState(w)]}`} onClick={e => e.stopPropagation()}><ReportHoursCell w={w} month={month} canEdit={canEdit} /></td>,
                foot: () => <td key="report" className="px-4 py-2.5 text-right text-slate-600">{round(g.rows.reduce((s, w) => s + (w.reportHours ?? 0), 0))} {t("год")}</td>,
              },
              factory: {
                th: () => colTh("factory", "bg-sky-100/70 px-4 py-2.5 text-right text-sky-800", t("Години з фабрики")),
                td: w => <td key="factory" className={`px-4 py-1.5 text-right ${DIFF_CELL[diffState(w)]}`} onClick={e => e.stopPropagation()}><FactoryHoursCell w={w} month={month} canEdit={canEdit} /></td>,
                foot: () => <td key="factory" className="px-4 py-2.5 text-right text-slate-600">{round(g.rows.reduce((s, w) => s + (w.factoryHours ?? 0), 0))} {t("год")}</td>,
              },
              ack: {
                th: () => colTh("ack", "bg-sky-100/70 px-3 py-2.5 text-center text-sky-800", t("Підтв. працівника"), { title: t("Відповідь працівника на запит підтвердження годин у боті") }),
                td: w => <td key="ack" className={`px-3 py-1.5 text-center ${DIFF_CELL[diffState(w)]}`} onClick={e => e.stopPropagation()}><WorkerAckCell w={w} /></td>,
                foot: () => (
                  <td key="ack" className="px-3 py-2.5 text-center text-xs text-slate-500">
                    {g.rows.some(w => w.askSentAt) && `${g.rows.filter(w => w.workerResponse === "confirmed").length}/${g.rows.filter(w => w.askSentAt).length}`}
                  </td>
                ),
              },
              note: {
                th: () => colTh("note", "border-l-2 border-slate-300 px-3 py-2.5", t("Замітки")),
                td: w => <td key="note" className="max-w-[16rem] border-l-2 border-slate-200 px-3 py-1.5" onClick={e => e.stopPropagation()}><NoteCell w={w} month={month} canEdit={canEdit} /></td>,
                foot: () => <td key="note" />,
              },
              rate: {
                th: () => colTh("rate", "border-l-2 border-slate-300 bg-violet-100/60 px-3 py-2.5 text-right text-violet-800", t("Ставка")),
                td: w => <td key="rate" className="border-l-2 border-slate-200 bg-violet-50/40 px-3 py-1.5 text-right text-slate-500">{w.rate ?? "—"}</td>,
                foot: () => <td key="rate" />,
              },
              net: {
                th: () => colTh("net", "bg-emerald-100/60 px-4 py-2.5 text-right text-emerald-800", t("ЗП нетто")),
                td: w => <td key="net" className="bg-emerald-50/40 px-4 py-1.5 text-right font-semibold text-slate-700">{round(w.net ?? 0)} zł</td>,
                foot: () => <td key="net" className="px-4 py-2.5 text-right text-emerald-700">{round(g.net)} zł</td>,
              },
              reportNet: {
                th: () => colTh("reportNet", "bg-blue-100/60 px-4 py-2.5 text-right text-blue-800", t("ЗП по рапорту")),
                td: w => <td key="reportNet" className="bg-blue-50/40 px-4 py-1.5 text-right font-semibold text-blue-700">{w.reportNet != null ? `${round(w.reportNet)} zł` : "—"}</td>,
                foot: () => <td key="reportNet" className="px-4 py-2.5 text-right text-blue-700">{round(g.rows.reduce((s, w) => s + (w.reportNet ?? 0), 0))} zł</td>,
              },
            };
            return (
              <Card key={g.key} className="overflow-hidden">
                {/* хедер фабрики — всередині картки, щоб таблиці сусідніх фабрик не зливались */}
                <div className="flex flex-wrap items-center gap-2 border-b-2 border-slate-200 bg-gradient-to-r from-red-50/70 via-slate-50 to-white px-4 py-3">
                  <FactoryIcon className="h-4 w-4 text-red-500" />
                  <h2 className="text-[15px] font-bold tracking-tight text-slate-800">{g.name}</h2>
                  <Badge color="slate">{g.rows.length} {t("людей")}</Badge>
                  <Badge color="slate">{g.shifts} {t("змін")}</Badge>
                  <Badge color="green">{round(g.hours)} {t("год")}</Badge>
                  {isOwner && <Badge color="green">{round(g.net)} {t("zł нетто")}</Badge>}
                  <span className="ml-auto inline-flex flex-wrap items-center gap-2">
                  {can(me, "svodni") && canEdit && g.factoryId != null && (
                    <button onClick={() => confirmToSvodni(g.name, { factoryId: g.factoryId! })} disabled={toSvodni.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
                      <Check className="h-3.5 w-3.5" /> {t("До сводної")}
                    </button>
                  )}
                  {canEdit && g.factoryId != null && (
                    <button onClick={() => setImportKey(g.key)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
                      title={t("Імпорт годин з файла фабрики або вставленого списку")}>
                      <UploadIcon className="h-3.5 w-3.5" /> {t("Імпорт годин фабрики")}
                    </button>
                  )}
                  {canEdit && g.factoryId != null && (
                    <button onClick={() => setFacKeysKey(g.key)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      title={t("Ключі фабрики: особисті номери працівників у системі фабрики — імпорт годин матчить по них")}>
                      <KeyRound className="h-3.5 w-3.5" /> {t("Ключі")}
                    </button>
                  )}
                  {(() => {
                    const hid = (data?.excluded ?? []).filter(e => e.factoryId === g.factoryId);
                    return hid.length > 0 ? (
                      <button onClick={() => setHiddenFor({ factoryId: g.factoryId, name: g.name })}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                        title={t("Приховані з цього місяця працівники (прибрані вручну / відпустка / ще не приступили)")}>
                        {t("приховано {n}", { n: hid.length })}
                      </button>
                    ) : null;
                  })()}
                  {canEdit && g.factoryId != null && g.rows.some(w => w.factoryHours != null) && (
                    <button onClick={() => setNotifyKey(g.key)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-100"
                      title={t("Розіслати людям їх години фабрики на підтвердження в бот")}>
                      <Send className="h-3.5 w-3.5" /> {t("На підтвердження людям")}
                    </button>
                  )}
                  {canEdit && g.factoryId != null && g.rows.some(w => w.factoryHours != null) && (
                    <button onClick={() => {
                        const n = g.rows.filter(w => w.factoryHours != null).length;
                        if (window.confirm(t("Очистити години фабрики для «{name}»? Приберуться значення {n} людей разом з розбивками й підтвердженнями. Рапорти працівників не чіпаються.", { name: g.name, n }))) clearFactoryHours.mutate(g);
                      }} disabled={clearFactoryHours.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:border-rose-300 hover:text-rose-600 disabled:opacity-50"
                      title={t("Очистити колонку «Години з фабрики», щоб завантажити новий файл")}>
                      <RotateCcw className="h-3.5 w-3.5" /> {t("Очистити години фабрики")}
                    </button>
                  )}
                  {canEdit && g.factoryId != null && g.rows.some(w => diffState(w) === "mismatch") && (
                    <button onClick={() => setEmailKey(g.key)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                      title={t("Згенерувати лист клієнту про розбіжності годин")}>
                      <Mail className="h-3.5 w-3.5" /> {t("Лист про розбіжності")}
                      <span className="rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white">{g.rows.filter(w => diffState(w) === "mismatch").length}</span>
                    </button>
                  )}
                  {canEdit && g.factoryId != null && (
                    <button onClick={() => setExportTo({ factoryId: g.factoryId!, name: g.name })} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50" title={t("Excel рапорту по фабриці")}><Download className="h-3.5 w-3.5" /> {t("Excel рапорту")}</button>
                  )}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[15px]">
                    <thead className="border-b-2 border-slate-200 bg-slate-100/80 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        {canEdit && <th className="w-8 px-2 py-2.5" />}
                        <th className="px-4 py-2.5">{t("Працівник")}</th>
                        {colKeys.map(k => colDefs[k]!.th())}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {/* клік відкриває деталі; виділення тексту (копіювання імені) — ні */}
                      {g.rows.map(w => (
                        <tr key={`${w.workerId}-${w.factoryId ?? 0}`} onClick={() => { if (window.getSelection()?.toString()) return; setSel({ id: w.workerId, name: w.name }); }}
                          className={`cursor-pointer ${w.unlegalized ? "bg-rose-50/70 hover:bg-rose-100/60" : "even:bg-slate-50/60 hover:bg-red-50/40"}`}>
                          {canEdit && (
                            <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                              <input type="checkbox" checked={!!selWorkers[w.workerId]} onChange={e => setSelWorkers(s => ({ ...s, [w.workerId]: e.target.checked }))} className="h-4 w-4 accent-red-600" />
                            </td>
                          )}
                          {/* імʼя завжди одним рядком: задовге ріжеться, повне — у тултіпі */}
                          <td className="max-w-[15rem] px-4 py-1.5 font-medium text-red-700">
                            <span className="flex items-center gap-1" title={w.name}>
                              {openByWorker.has(w.workerId) && <span className="shrink-0" title={t("Є скарга на години")}><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /></span>}
                              <span className="min-w-0 truncate underline-offset-2 hover:underline">{w.name}</span>
                              {w.unlegalized && (
                                <span className="shrink-0 rounded bg-rose-100 px-1 py-0.5 text-[10px] font-semibold text-rose-700"
                                  title={t("Не оформлений або не поданий (oczekuje) — потрібна легалізація")}>
                                  {t("не оформл.")}
                                </span>
                              )}
                              {canDelete && w.createdViaImport && w.shifts === 0 && (
                                <button onClick={e => {
                                    e.stopPropagation();
                                    if (window.confirm(t("Видалити профіль «{name}» повністю? Це прибере його рапорти, години фабрики й документи. Дія незворотна.", { name: w.name }))) delWorker.mutate(w.workerId);
                                  }} disabled={delWorker.isPending} title={t("Видалити профіль (випадковий дубль)")}
                                  className="shrink-0 rounded p-0.5 text-slate-300 hover:text-rose-600 disabled:opacity-50">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </span>
                          </td>
                          {colKeys.map(k => colDefs[k]!.td(w))}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold text-slate-800">
                        {canEdit && <td className="px-2 py-2.5" />}
                        <td className="whitespace-nowrap px-4 py-2.5">{t("Разом по фабриці")}</td>
                        {colKeys.map(k => colDefs[k]!.foot())}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>
            );
          })}
            </div>
          </div>
          ))}
        </div>
      )}
      {svodniAsk && (() => {
        // Попередження перед перенесенням. Джерело авторитетне: запис (навіть 0)
        // переноситься як є; фолбек на явки — лише коли запису НЕМАЄ.
        const scopeRows = groups
          .filter(g => svodniAsk.scope.factoryId != null ? g.factoryId === svodniAsk.scope.factoryId
            : svodniAsk.scope.city ? g.city === svodniAsk.scope.city : true)
          .flatMap(g => g.rows);
        const pos = (n: number | null | undefined) => (n != null && n > 0 ? n : null);
        // сирі значення джерела: number (вкл. 0 = запис із нулем) або null (запису нема)
        const srcRaw = (w: HourRow): number | null => svodniSource === "reports" ? w.reportHours ?? null
          : svodniSource === "factory" ? w.factoryHours ?? null
          : pos(w.hours);
        const otherHas = (w: HourRow) => (svodniSource !== "reports" && pos(w.reportHours) != null)
          || (svodniSource !== "factory" && pos(w.factoryHours) != null)
          || (svodniSource !== "attendance" && w.hours > 0);
        const zeroes = scopeRows.filter(w => srcRaw(w) === 0 && otherHas(w));            // перенесеться 0
        const fallback = scopeRows.filter(w => srcRaw(w) == null && w.hours > 0 && svodniSource !== "attendance"); // підуть явки
        const dropped = scopeRows.filter(w => srcRaw(w) == null && !(w.hours > 0) && otherHas(w)); // не потраплять
        // скільки людей реально поїде цим перенесенням (для кнопки)
        const nTransfer = scopeRows.filter(w => srcRaw(w) != null || w.hours > 0).length;
        return (
        <Modal open onClose={() => setSvodniAsk(null)} title={`${t("Години підтверджені → до сводної")} — ${svodniAsk.label}`} size="lg">
          <p className="mb-3 text-sm text-slate-500">{t("Перенести підтверджені години до сводної: {what}? Рядки створяться/оновляться з даними з профілів.", { what: svodniAsk.label })}</p>
          <div className="space-y-2">
            {([
              ["reports", t("Рапорти працівників"), t("що людина здала в бот; пара без рапорту — наші явки (як завжди)")],
              ["factory", t("Години з фабрики"), t("колонка «Години з фабрики» (евіденція/імпорт); без запису — наші явки")],
              ["attendance", t("Наші явки"), t("лише затверджений графік — явки, підтверджені водієм/графіковою")],
            ] as const).map(([v, label, hint]) => (
              <label key={v} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 transition ${svodniSource === v ? "border-red-300 bg-red-50/50" : "border-slate-200 hover:border-slate-300"}`}>
                <input type="radio" name="svodni-source" checked={svodniSource === v} onChange={() => setSvodniSource(v)} className="mt-0.5 accent-red-600" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-700">{label}</span>
                  <span className="block text-xs text-slate-400">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          {zeroes.length > 0 && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50/60 px-3 py-2 text-sm text-red-700">
              <span className="font-medium">{t("У джерелі стоїть 0 — у сводну піде 0 год, хоча в інших стовпчиках години є ({n}):", { n: zeroes.length })}</span>{" "}
              {zeroes.slice(0, 12).map(w => `${w.name} (${t("явки")}: ${round(w.hours)}${w.factoryHours != null && svodniSource !== "factory" ? `, ${t("фабрика")}: ${w.factoryHours}` : ""}${w.reportHours != null && svodniSource !== "reports" ? `, ${t("рапорт")}: ${w.reportHours}` : ""})`).join(", ")}{zeroes.length > 12 ? "…" : ""}
            </div>
          )}
          {fallback.length > 0 && (
            <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-700">
              <span className="font-medium">{t("Запису в джерелі немає — підуть наші явки ({n}):", { n: fallback.length })}</span>{" "}
              {fallback.slice(0, 12).map(w => `${w.name} (${round(w.hours)} ${t("год")})`).join(", ")}{fallback.length > 12 ? "…" : ""}
            </div>
          )}
          {dropped.length > 0 && (
            <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
              <span className="font-medium">{t("Немає ні запису в джерелі, ні явок — не потраплять у сводну ({n}):", { n: dropped.length })}</span>{" "}
              {dropped.slice(0, 12).map(w => w.name).join(", ")}{dropped.length > 12 ? "…" : ""}
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSvodniAsk(null)}>{t("Скасувати")}</Button>
            <Button onClick={() => toSvodni.mutate({
                ...svodniAsk.scope, source: svodniSource,
                // точний список людей видимого скоупу: фірмова вкладка шле лише
                // своїх, сміттєві пари поза вкладкою скоуп не роздують
                workerIds: [...new Set(scopeRows.map(w => w.workerId))],
              })} loading={toSvodni.isPending}>
              <Check className="h-4 w-4" /> {t("Перенести ({n} людей)", { n: nTransfer })}
            </Button>
          </div>
        </Modal>
        );
      })()}
      {sel && <WorkerDaysModal workerId={sel.id} name={sel.name} month={month} monthLabel={monthLabel} onClose={() => setSel(null)} />}
      {exportTo && <ExportExcelModal month={month} monthLabel={monthLabel} target={exportTo} onClose={() => setExportTo(null)} />}
      {(() => {
        const ng = notifyKey ? groups.find(g => g.key === notifyKey) : null;
        return ng?.factoryId != null ? <NotifyAskModal group={ng} month={month} onClose={() => setNotifyKey(null)} /> : null;
      })()}
      {(() => {
        const kg = facKeysKey ? groups.find(g => g.key === facKeysKey) : null;
        return kg?.factoryId != null ? <FactoryKeysModal group={kg} onClose={() => setFacKeysKey(null)} /> : null;
      })()}
      {selIds.length > 0 && canEdit && (
        <div className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 shadow-lg">
          <span className="text-sm font-medium text-slate-700">{t("Вибрано: {n}", { n: selIds.length })}</span>
          <button onClick={() => excludeSel.mutate({ workerIds: selIds, reason: "manual" })} disabled={excludeSel.isPending}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            title={t("Прибрати порожні рядки цих людей з поточного місяця (реальні дані повернуть рядок)")}>
            {t("Прибрати зі списку місяця")}
          </button>
          <button onClick={() => setFireIds(selIds)}
            className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100">
            {t("Звільнити…")}
          </button>
          <button onClick={() => setSelWorkers({})} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
        </div>
      )}
      {fireIds && (
        <FireWorkersModal workers={fireIds.map(id => ({ id, name: nameById.get(id) ?? `#${id}` }))}
          onClose={() => setFireIds(null)} onDone={() => setSelWorkers({})} />
      )}
      {hiddenFor && (
        <HiddenWorkersModal name={hiddenFor.name} month={month}
          items={(data?.excluded ?? []).filter(e => e.factoryId === hiddenFor.factoryId)}
          onClose={() => setHiddenFor(null)} />
      )}
      {leftoverKey && !isFetching && (() => {
        const lg = groups.find(g => g.key === leftoverKey);
        const leftovers = lg ? lg.rows.filter(r => r.shifts === 0 && r.reportHours == null && r.factoryHours == null) : [];
        return lg && leftovers.length > 0
          ? <LeftoversModal group={lg} leftovers={leftovers} month={month} onClose={() => setLeftoverKey(null)} />
          : null;
      })()}
      {(() => {
        // групи беруться свіжими з query — правки годин живо оновлюють модалки
        const ig = importKey ? groups.find(g => g.key === importKey) : null;
        const eg = emailKey ? groups.find(g => g.key === emailKey) : null;
        return (
          <>
            {ig?.factoryId != null && <ImportHoursModal group={ig} month={month} onClose={() => setImportKey(null)}
              // Eurocash: файл фабрики несе все для сводної (пороги/нічні/потроненя)
              // — після збереження годин одразу переносимо вкладку в сводну.
              // Після імпорту — «залишки» вкладки (люди без годин): що з ними робити
              onApplied={fmt => { setLeftoverKey(ig.key); if (fmt === "eurocash" && can(me, "svodni")) toSvodni.mutate({ factoryId: ig.factoryId!, source: "factory" }); }} />}
            {eg?.factoryId != null && <DiscrepancyEmailModal group={eg} month={month} onClose={() => setEmailKey(null)} />}
          </>
        );
      })()}
      {importFacId != null && (() => {
        // імпорт з тулбара: реальна група місяця, якщо вкладка вже є, інакше
        // синтетична порожня (перший імпорт — вкладка виникне після збереження)
        const f = allFactories.find(x => x.id === importFacId);
        const g: Group = groups.find(x => x.factoryId === importFacId && !x.firm)
          ?? { key: `f${importFacId}`, name: f?.name ?? `#${importFacId}`, factoryId: importFacId, firm: null, city: f?.city ?? "", n: 1, rows: [], shifts: 0, hours: 0, net: 0 };
        return <ImportHoursModal group={g} month={month} onClose={() => setImportFacId(null)}
          onApplied={fmt => { setLeftoverKey(g.key); if (fmt === "eurocash" && can(me, "svodni")) toSvodni.mutate({ factoryId: importFacId, source: "factory" }); }} />;
      })()}
    </>
  );
}

// Excel-експорт обліку годин: вибір стовпчиків + перемикач «лише рядки з помилками»
// (розбіжність рапорт ↔ фабрика, як підсвітка в таблиці). Формує URL /hours/report-excel.
function ExportExcelModal({ month, monthLabel, target, onClose }: {
  month: string; monthLabel: string; target: { factoryId: number | null; name: string }; onClose: () => void;
}) {
  const t = useT();
  const COLS: { key: string; label: string }[] = [
    { key: "code", label: t("Код") },
    { key: "name", label: t("Працівник") },
    { key: "factory", label: t("Фабрика") },
    { key: "shifts", label: t("Зміни") },
    { key: "hours", label: t("Години (графік)") },
    { key: "report", label: t("Години з рапорту") },
    { key: "factoryHours", label: t("Години з фабрики") },
    { key: "diff", label: t("Різниця") },
    { key: "status", label: t("Статус рапорту") },
    { key: "workerConfirm", label: t("Підтв. працівника") },
    { key: "note", label: t("Замітки") },
  ];
  const [checked, setChecked] = useState<Set<string>>(new Set(COLS.map(c => c.key)));
  const [errorsOnly, setErrorsOnly] = useState(false);
  const toggle = (k: string) => setChecked(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const download = () => {
    const p = new URLSearchParams({ month, cols: COLS.map(c => c.key).filter(k => checked.has(k)).join(",") });
    if (target.factoryId != null) p.set("factoryId", String(target.factoryId));
    if (errorsOnly) p.set("errorsOnly", "1");
    window.location.href = `/api/hours/report-excel?${p.toString()}`;
    onClose();
  };
  return (
    <Modal open onClose={onClose} title={`${t("Excel обліку годин")} — ${target.name} · ${monthLabel}`}>
      <div className="space-y-4">
        <div>
          <Label>{t("Стовпчики")}</Label>
          <div className="mt-1 grid grid-cols-2 gap-1.5">
            {COLS.map(c => (
              <label key={c.key} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
                <input type="checkbox" checked={checked.has(c.key)} onChange={() => toggle(c.key)} />
                <span className="text-slate-700">{c.label}</span>
              </label>
            ))}
          </div>
        </div>
        <label className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50/40 p-3 text-sm">
          <input type="checkbox" className="mt-0.5" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} />
          <span>
            <span className="font-medium text-slate-700">{t("Лише рядки з помилками")}</span>
            <span className="block text-xs text-slate-500">{t("Тільки пари, де години з рапорту й від фабрики розходяться або одного з джерел бракує.")}</span>
          </span>
        </label>
        <p className="text-xs text-slate-400">{t("Файл формується польською (заголовки колонок).")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button disabled={checked.size === 0} onClick={download}><Download className="h-4 w-4" /> {t("Скачати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Клітинка «Години з фабрики»: показ + inline-редагування (дзеркало ReportHoursCell);
// при розбіжності з рапортом показує Δ.
function FactoryHoursCell({ w, month, canEdit }: { w: HourRow; month: string; canEdit: boolean }) {
  const t = useT();
  const { lang } = useLang();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showDays, setShowDays] = useState(false);
  const [val, setVal] = useState("");
  const save = useMutation({
    mutationFn: (hours: string | null) => post("/hours/factory", { workerId: w.workerId, month, hours, factoryId: w.factoryId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hours", month] }); qc.invalidateQueries({ queryKey: ["hours-day-compare"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const st = diffState(w);
  const diff = w.reportHours != null && w.factoryHours != null ? Math.round((w.factoryHours - w.reportHours) * 100) / 100 : null;
  // «сира» розбіжність (без урахування ручного підтвердження) — для галочки «все ок»
  const rawMismatch = diff != null && Math.abs(diff) > 0.01;
  const confirmMut = useMutation({
    mutationFn: (confirmed: boolean) => post("/hours/factory-confirm", { workerId: w.workerId, month, factoryId: w.factoryId, confirmed }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hours", month] }),
    onError: (e: any) => toast.error(e.message),
  });
  const dayEntries = useMemo(
    () => Object.entries(w.factoryDays ?? {}).sort((a, b) => a[0].localeCompare(b[0])),
    [w.factoryDays],
  );
  const inner = (
    <>
      {w.factoryHours} {t("год")}
      {st === "mismatch" && diff != null && <span className="ml-1 text-xs font-medium text-red-500">({diff > 0 ? "+" : ""}{diff})</span>}
      {rawMismatch && w.factoryConfirmed && <span className="ml-1 text-xs font-medium text-emerald-600">({diff! > 0 ? "+" : ""}{diff})</span>}
      {st === "match" && <Check className="ml-1 inline h-3.5 w-3.5 text-emerald-500" />}
    </>
  );
  const color = st === "mismatch" ? "text-red-700" : st === "match" ? "text-emerald-700" : "text-slate-700";
  // число завжди клікабельне (і після підтвердження теж) — модалка деталей
  // відкривається навіть без розбивки: там її можна набрати вручну
  const shown = w.factoryHours != null
    ? <button onClick={() => setShowDays(true)} title={t("Показати розбивку по днях від фабрики")}
        className={`font-semibold underline decoration-dotted underline-offset-2 hover:opacity-75 ${color}`}>{inner}</button>
    : <span className="text-slate-300">—</span>;
  // Модалка «дні від фабрики» — той самий патерн, що у першій колонці «Години»
  // (WorkerDaysModal): рядок = день+зміна, число завжди в інлайн-полі (✓
  // з'являється при зміні), 🗑 прибирає запис, знизу «Додати зміну». Кожна
  // правка шле повну розбивку — сервер перераховує підсумок місяця з неї.
  const nShifts = useMemo(() => {
    let n = Math.max(1, w.factoryShiftCount || 1);
    for (const [, v] of dayEntries) if (typeof v === "object") for (const k of Object.keys(v)) n = Math.max(n, Number(k) || 0);
    return Math.min(6, n);
  }, [dayEntries, w.factoryShiftCount]);
  // плоский список записів: день-обʼєкт (ewidencja) → рядок на кожну зміну;
  // день-число (матриця/lista) → один рядок без № зміни
  const facEntries = useMemo(() => {
    const out: { date: string; shift: string | null; hours: number }[] = [];
    for (const [date, v] of dayEntries) {
      if (typeof v === "number") out.push({ date, shift: null, hours: v });
      else for (const [s, h] of Object.entries(v).sort((a, b) => Number(a[0]) - Number(b[0]))) out.push({ date, shift: s, hours: h });
    }
    return out; // dayEntries уже відсортовані за датою
  }, [dayEntries]);
  const saveDays = useMutation({
    mutationFn: (days: Record<string, FacDayVal>) => post("/hours/factory", { workerId: w.workerId, month, factoryId: w.factoryId, days }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hours", month] }); qc.invalidateQueries({ queryKey: ["hours-day-compare"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  // повна копія розбивки + точкова правка; дні, що лишились без змін, — геть
  const rebuildDays = (mut: (days: Record<string, FacDayVal>) => void): Record<string, FacDayVal> => {
    const days: Record<string, FacDayVal> = JSON.parse(JSON.stringify(w.factoryDays ?? {}));
    mut(days);
    for (const [d, v] of Object.entries(days)) if (typeof v === "object" && !Object.keys(v).length) delete days[d];
    return days;
  };
  const setEntryHours = (e: { date: string; shift: string | null }, hours: number) => saveDays.mutate(rebuildDays(days => {
    if (e.shift == null) days[e.date] = hours;
    else {
      const day = typeof days[e.date] === "object" ? days[e.date] as Record<string, number> : {};
      day[e.shift] = hours;
      days[e.date] = day;
    }
  }));
  const removeEntry = (e: { date: string; shift: string | null }) => {
    if (facEntries.length <= 1) { toast.error(t("Останній запис — щоб прибрати години фабрики повністю, очисти число олівцем у таблиці")); return; }
    saveDays.mutate(rebuildDays(days => {
      if (e.shift == null) delete days[e.date];
      else { const day = days[e.date]; if (typeof day === "object") delete day[e.shift]; }
    }));
  };
  const totalShown = facEntries.length
    ? Math.round(facEntries.reduce((s, e) => s + e.hours, 0) * 100) / 100
    : w.factoryHours ?? 0; // без розбивки — показуємо загальне число рядка
  const daysModal = showDays && (
    <Modal open onClose={() => setShowDays(false)} title={`${w.name} — ${t("дні від фабрики")}`} size="lg">
      <div className="mb-3 flex flex-wrap gap-2">
        <Badge color="green">{t("Години:")} {totalShown}</Badge>
        <Badge color="slate">{dayEntries.length} {t("дн.")}</Badge>
      </div>
      {canEdit && facEntries.length > 0 && <p className="mb-1 text-xs text-slate-400">{t("Натисни на число годин, щоб змінити (з'явиться ✓). 🗑 — прибрати день/зміну.")}</p>}
      {!facEntries.length && (
        <p className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-4 text-center text-sm text-slate-400">
          {t("Файл фабрики не мав розбивки по днях — години внесені одним числом. Додані нижче дні створять розбивку (підсумок місяця стане сумою днів).")}
        </p>
      )}
      {facEntries.length > 0 && <div className="max-h-[55vh] overflow-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">{t("Дата")}</th>
              <th className="px-3 py-2">{t("Зміна")}</th>
              <th className="px-3 py-2 text-right">{t("Години")}</th>
              {canEdit && <th className="px-2 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {facEntries.map(e => (
              <tr key={`${e.date}|${e.shift ?? "-"}`} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-medium text-slate-700">
                  {e.date.slice(8, 10)}.{e.date.slice(5, 7)}
                  <span className="ml-1.5 text-xs font-normal text-slate-400">{new Date(`${e.date}T00:00:00`).toLocaleDateString(lang === "en" ? "en-US" : "uk-UA", { weekday: "short" })}</span>
                </td>
                <td className="px-3 py-2 text-slate-500">{e.shift != null ? `${e.shift} ${t("зм")}` : "—"}</td>
                <td className="px-2 py-2 text-right">
                  {canEdit
                    ? <FacHoursInput key={`${e.date}|${e.shift ?? "-"}|${e.hours}`} value={e.hours} onSave={h => setEntryHours(e, h)} />
                    : <span className="font-medium text-slate-700">{e.hours}</span>}
                </td>
                {canEdit && (
                  <td className="px-2 py-2 text-right">
                    <button onClick={() => removeEntry(e)} disabled={saveDays.isPending} title={t("Прибрати день/зміну")}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold text-slate-700">
              <td className="px-3 py-2" colSpan={2}>{t("Разом")} · {dayEntries.length} {t("дн.")}</td>
              <td className="px-2 py-2 text-right">{totalShown}</td>
              {canEdit && <td />}
            </tr>
          </tfoot>
        </table>
      </div>}
      {canEdit && <AddFactoryDayRow nShifts={nShifts} month={month} pending={saveDays.isPending}
        onAdd={(date, shift, hours) => saveDays.mutate(rebuildDays(days => {
          if (shift == null) days[date] = hours;
          else {
            const day = typeof days[date] === "object" ? days[date] as Record<string, number> : {};
            day[shift] = hours;
            days[date] = day;
          }
        }))} />}
    </Modal>
  );
  if (!canEdit) return <>{shown}{daysModal}</>;
  if (editing) {
    const submit = () => save.mutate(val.replace(",", ".").trim() || null);
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <Input value={val} onChange={e => setVal(e.target.value)} inputMode="decimal" placeholder="0–500" className="w-20 text-right" autoFocus
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") setEditing(false); }} />
        <button onClick={submit} disabled={save.isPending} className="rounded-md p-1 text-emerald-600 hover:bg-emerald-50"><Check className="h-4 w-4" /></button>
        <button onClick={() => setEditing(false)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {shown}
      {w.factoryHours != null && (rawMismatch || w.reportHours == null) && (
        <button onClick={() => confirmMut.mutate(!w.factoryConfirmed)} disabled={confirmMut.isPending}
          title={w.factoryConfirmed ? t("Зняти підтвердження розбіжності")
            : w.reportHours == null ? t("Підтвердити години фабрики без рапорту працівника — все ок")
            : t("Підтвердити: розбіжність перевірено, все ок")}
          className={`rounded-md p-0.5 ${w.factoryConfirmed ? "text-emerald-600 hover:text-slate-400" : "text-slate-300 hover:text-emerald-600"}`}>
          <CheckCircle2 className="h-3.5 w-3.5" />
        </button>
      )}
      <button onClick={() => { setVal(w.factoryHours != null ? String(w.factoryHours) : ""); setEditing(true); }} className="rounded-md p-0.5 text-slate-300 hover:text-red-600" title={t("Вписати години фабрики")}><Pencil className="h-3.5 w-3.5" /></button>
      {daysModal}
    </span>
  );
}

// Колонка «Підтв. працівника»: відповідь людини на запит «підтверди свої
// години» в боті. Галочка/хрестик/годинник, пояснення — у тултіпі.
function WorkerAckCell({ w }: { w: HourRow }) {
  const t = useT();
  const fmtD = (s?: string | null) => s ? new Date(s).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" }) : "";
  if (w.workerResponse === "confirmed") {
    // людина підтверджувала askHours; якщо колонку потім змінили — жовтимо
    const stale = w.askHours != null && w.factoryHours != null && Math.abs(w.askHours - w.factoryHours) > 0.01;
    return (
      <span title={`${t("Підтвердив(ла) {date} · {hours} год", { date: fmtD(w.workerResponseAt), hours: w.askHours ?? w.factoryHours ?? "" })}${stale ? ` · ${t("увага: зараз у колонці {h} год", { h: w.factoryHours! })}` : ""}`}>
        <CheckCircle2 className={`inline h-4 w-4 ${stale ? "text-amber-500" : "text-emerald-500"}`} />
      </span>
    );
  }
  if (w.workerResponse === "dispute") {
    return (
      <span title={t("Зголосив(ла) помилку {date}: {note}", { date: fmtD(w.workerResponseAt), note: w.workerNote || t("без пояснення") })}>
        <XCircle className="inline h-4 w-4 text-red-500" />
      </span>
    );
  }
  if (w.askSentAt) {
    return (
      <span title={t("Запит надіслано {date}, чекаємо відповіді", { date: fmtD(w.askSentAt) })}>
        <Clock className="inline h-4 w-4 text-slate-300" />
      </span>
    );
  }
  return <span className="text-slate-200">—</span>;
}

// Розсилка «підтверди свої години» в бот: чекбокс-список людей вкладки з
// годинами фабрики → POST /hours/factory-notify.
function NotifyAskModal({ group, month, onClose }: { group: Group; month: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const rows = useMemo(() => group.rows.filter(w => w.factoryHours != null), [group]);
  const [checked, setChecked] = useState<Record<number, boolean>>(() => Object.fromEntries(rows.map(w => [w.workerId, true])));
  const n = rows.filter(w => checked[w.workerId]).length;
  const allOn = n === rows.length;
  const send = useMutation({
    mutationFn: () => post<{ sent: number; skipped: number }>("/hours/factory-notify", {
      month, factoryId: group.factoryId, workerIds: rows.filter(w => checked[w.workerId]).map(w => w.workerId),
    }),
    onSuccess: (r) => {
      toast.success(t("Надіслано запитів: {sent}", { sent: r.sent }), {
        description: r.skipped ? t("Пропущено (без Telegram або без годин): {n}", { n: r.skipped }) : undefined,
      });
      qc.invalidateQueries({ queryKey: ["hours", month] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={`${t("Години на підтвердження людям")} — ${group.name} · ${month}`} size="lg">
      <p className="mb-2 text-sm text-slate-500">{t("Кожен вибраний отримає в бот свої години з колонки «Години з фабрики» з кнопками «✅ Все вірно» / «❌ Є помилка». Повторна розсилка скидає попередню відповідь.")}</p>
      <div className="max-h-[50vh] overflow-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2"><input type="checkbox" checked={allOn} className="h-4 w-4 accent-red-600"
                onChange={e => setChecked(Object.fromEntries(rows.map(w => [w.workerId, e.target.checked])))} /></th>
              <th className="px-3 py-2">{t("Працівник")}</th>
              <th className="px-3 py-2 text-right">{t("Години з фабрики")}</th>
              <th className="px-3 py-2 text-center">{t("Підтв. працівника")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(w => (
              <tr key={w.workerId} className="hover:bg-slate-50">
                <td className="px-3 py-2"><input type="checkbox" checked={!!checked[w.workerId]} className="h-4 w-4 accent-red-600"
                  onChange={e => setChecked(c => ({ ...c, [w.workerId]: e.target.checked }))} /></td>
                <td className="px-3 py-2 font-medium text-slate-700">{w.name}</td>
                <td className="px-3 py-2 text-right font-semibold text-slate-700">{w.factoryHours} {t("год")}</td>
                <td className="px-3 py-2 text-center"><WorkerAckCell w={w} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
        <Button onClick={() => send.mutate()} loading={send.isPending} disabled={!n}>
          <Send className="h-4 w-4" /> {t("Надіслати {n}", { n })}
        </Button>
      </div>
    </Modal>
  );
}

// Інлайн-поле годин запису дня/зміни — дзеркало HoursCell з WorkerDaysModal:
// ✓ з'являється, коли значення змінене
function FacHoursInput({ value, onSave }: { value: number; onSave: (h: number) => void }) {
  const t = useT();
  const [v, setV] = useState(String(value));
  const n = Number(v.replace(",", ".").trim());
  const valid = Number.isFinite(n) && n > 0 && n <= 24;
  const dirty = v.trim() !== String(value);
  const submit = () => { if (valid && dirty) onSave(Math.round(n * 100) / 100); };
  return (
    <span className="inline-flex items-center gap-1">
      <input value={v} onChange={e => setV(e.target.value)} inputMode="decimal"
        onKeyDown={e => { if (e.key === "Enter") submit(); }}
        className={`w-14 rounded-md border px-1.5 py-1 text-right text-sm ${dirty && !valid ? "border-rose-300 bg-rose-50/40" : "border-slate-200"}`} />
      {dirty && valid && <button onClick={submit} className="rounded-md bg-emerald-500 p-1 text-white hover:bg-emerald-600" title={t("Зберегти")}><Check className="h-3 w-3" /></button>}
    </span>
  );
}

// «Додати зміну» в розбивку днів фабрики — дзеркало AddShiftRow з WorkerDaysModal
function AddFactoryDayRow({ nShifts, month, onAdd, pending }: { nShifts: number; month: string; onAdd: (date: string, shift: string | null, hours: number) => void; pending: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [shift, setShift] = useState("1");
  const [hours, setHours] = useState("8");
  if (!open) return (
    <button onClick={() => setOpen(true)} className="mt-3 flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"><Plus className="h-4 w-4" /> {t("Додати зміну")}</button>
  );
  const n = Number(hours.replace(",", ".").trim());
  const valid = date.startsWith(`${month}-`) && Number.isFinite(n) && n > 0 && n <= 24;
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 p-3">
      <div><label className="mb-0.5 block text-xs text-slate-500">{t("Дата")}</label>
        <Input type="date" value={date} min={`${month}-01`} max={`${month}-31`} onChange={e => setDate(e.target.value)} className="w-40" /></div>
      <div><label className="mb-0.5 block text-xs text-slate-500">{t("Зміна")}</label>
        <Select value={shift} onChange={e => setShift(e.target.value)} className="w-28">
          {Array.from({ length: nShifts }, (_, i) => String(i + 1)).map(s => <option key={s} value={s}>{s} {t("зм")}</option>)}
          <option value="">{t("без № зміни")}</option>
        </Select></div>
      <div><label className="mb-0.5 block text-xs text-slate-500">{t("Години")}</label>
        <Input value={hours} onChange={e => setHours(e.target.value)} inputMode="decimal" className="w-20 text-right" /></div>
      <Button disabled={!valid || pending} onClick={() => { onAdd(date, shift || null, Math.round(n * 100) / 100); setOpen(false); setDate(""); }}>{t("Додати")}</Button>
      <button onClick={() => setOpen(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
    </div>
  );
}

// extras формату eurocash: нічні/продуктивність/ставка агенції/потроненя —
// зберігаються з годинами і їдуть у сводну (ставка від порогу продуктивності)
type EcExtras = { nocneH?: number; produktywnosc?: number; stawkaAgencji?: number; potracenia?: number; innePotracenia?: number; korekta?: number; koncowe?: number; nrOsobowy?: string };
interface ParsedRow { name: string; hours: number; days: Record<number, FacDayVal> | null; extras: EcExtras | null; key: string | null; byKey?: boolean; workerId: number | null; matchName: string | null; candidates: { id: number; name: string; active: boolean }[] }

// Імпорт годин фабрики: Excel-файл (3 формати) або вставлений список → превʼю
// з матчингом імен (bot/workerMatch) → масове збереження.
function ImportHoursModal({ group, month, onClose, onApplied }: { group: Group; month: string; onClose: () => void; onApplied?: (format: string | null) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [picked, setPicked] = useState<Record<number, number | null>>({});  // index → workerId
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  // Рядки файла без збігу і без кандидатів: «створити профіль» — нова людина
  // з евіденції створюється активною на фабриці й одразу отримує години
  const [createSel, setCreateSel] = useState<Record<number, boolean>>({});
  const [createCompanyId, setCreateCompanyId] = useState<number | "">("");
  const { data: companies = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const companyDefaulted = useRef(false);
  useEffect(() => {
    // дефолт фірми нових профілів — фірма вкладки (мульти-контрактні: Klinex/ES)
    if (companyDefaulted.current || !companies.length || !group.firm) return;
    const co = companies.find(c => c.name === group.firm);
    if (co) { setCreateCompanyId(co.id); companyDefaulted.current = true; }
  }, [companies, group.firm]);
  const [monthDetected, setMonthDetected] = useState<string | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [srcKind, setSrcKind] = useState<"excel" | "paste">("paste");
  const fileRef = useRef<HTMLInputElement>(null);
  const initPreview = (r: ParsedRow[], detected: string | null) => {
    setRows(r); setMonthDetected(detected);
    const p: Record<number, number | null> = {}, c: Record<number, boolean> = {};
    r.forEach((row, i) => { p[i] = row.workerId; c[i] = row.workerId != null && row.hours > 0; });
    setPicked(p); setChecked(c); setCreateSel({});
  };
  const parse = useMutation({
    mutationFn: async (file: File | null) => {
      setSrcKind(file ? "excel" : "paste");
      if (file) {
        const form = new FormData();
        form.append("file", file);
        form.append("month", month);
        if (group.factoryId != null) form.append("factoryId", String(group.factoryId)); // дубль-профілі: перевага тим, хто вже в обліку годин фабрики
        return upload<{ rows: ParsedRow[]; monthDetected: string | null; format: string }>("/hours/factory-parse", form);
      }
      return post<{ rows: ParsedRow[]; monthDetected: string | null; format: string }>("/hours/factory-parse", { month, text, factoryId: group.factoryId });
    },
    onSuccess: (r) => { setFormat(r.format ?? null); initPreview(r.rows, r.monthDetected); },
    onError: (e: any) => toast.error(e.message),
  });
  const apply = useMutation({
    mutationFn: () => {
      const out = (rows ?? [])
        .map((r, i) => ({ r, i }))
        .filter(({ i }) => checked[i] && (picked[i] != null || createSel[i]))
        .map(({ r, i }) => picked[i] != null
          ? { workerId: picked[i]!, hours: r.hours, days: r.days, extras: r.extras, key: r.key ?? undefined }
          : { create: true, name: r.name, hours: r.hours, days: r.days, extras: r.extras, key: r.key ?? undefined });
      return post<{ saved: number; skipped: number; created: number }>("/hours/factory-apply", {
        month, factoryId: group.factoryId, source: srcKind, rows: out,
        ...(createCompanyId !== "" ? { createCompanyId } : {}),
      });
    },
    onSuccess: (r) => {
      toast.success(t("Збережено годин фабрики: {n}", { n: r.saved }), {
        description: r.created ? t("Створено профілів: {n}", { n: r.created }) : undefined,
      });
      qc.invalidateQueries({ queryKey: ["hours", month] });
      qc.invalidateQueries({ queryKey: ["hours-day-compare"] });
      if (r.created) qc.invalidateQueries({ queryKey: ["workers"] });
      onApplied?.(format);
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const nSelected = rows ? rows.filter((_, i) => checked[i] && (picked[i] != null || createSel[i])).length : 0;
  const nCreate = rows ? rows.filter((_, i) => checked[i] && picked[i] == null && createSel[i]).length : 0;
  // «Чи це та сама людина?»: лише ті з обліку фабрики, у кого Є години з рапорту,
  // але ще НЕМАЄ збігу з таблицею фабрики — пропонуються в випадайці для
  // незматчених рядків файла (крім уже вибраних деінде)
  const pickedIds = useMemo(() => new Set(Object.values(picked).filter((v): v is number => v != null)), [picked]);
  const missingWorkers = useMemo(
    () => group.rows.filter(r => r.reportHours != null && r.factoryHours == null)
      .map(r => ({ id: r.workerId, name: r.name, reportHours: r.reportHours! })),
    [group],
  );
  const unmatchedMissing = missingWorkers.filter(w => !pickedIds.has(w.id));
  return (
    <Modal open onClose={onClose} title={`${t("Імпорт годин фабрики")} — ${group.name} · ${month}`} size="xl">
      {!rows ? (
        <div className="space-y-4">
          <div>
            <Label>{t("Excel-файл від фабрики (зведена таблиця, lista dni szczegółowo або ewidencja I/II/III)")}</Label>
            <input ref={fileRef} type="file" accept=".xls,.xlsx" className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-red-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-red-700 hover:file:bg-red-100"
              onChange={e => { const f = e.target.files?.[0]; if (f) parse.mutate(f); }} />
          </div>
          <div className="flex items-center gap-3 text-xs uppercase text-slate-400">
            <div className="h-px flex-1 bg-slate-200" />{t("або")}<div className="h-px flex-1 bg-slate-200" />
          </div>
          <div>
            <Label>{t("Вставити список «ім'я — години» або «ключ; ім'я; години» (по рядку на людину)")}</Label>
            <textarea value={text} onChange={e => setText(e.target.value)} rows={8}
              placeholder={"Kowalski Jan 168\nNowak Anna — 152,5\n1234; Wiśniewski Piotr; 140:30"}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-700 outline-none focus:border-red-300" />
            <div className="mt-2 flex justify-end">
              <Button onClick={() => parse.mutate(null)} loading={parse.isPending} disabled={!text.trim()}>{t("Розібрати")}</Button>
            </div>
          </div>
        </div>
      ) : (() => {
        const hasKeys = rows.some(r => r.key);
        return (
        <div className="space-y-3">
          {monthDetected && monthDetected !== month && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t("У файлі місяць {detected}, а вибрано {month} — перевір, чи той файл", { detected: monthDetected, month })}
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2" />
                  {hasKeys && <th className="px-3 py-2">{t("Ключ")}</th>}
                  <th className="px-3 py-2">{t("Ім'я у файлі")}</th>
                  <th className="px-3 py-2 text-right">{t("Години")}</th>
                  {format === "eurocash" && (
                    <>
                      <th className="px-3 py-2 text-right">{t("Нічні")}</th>
                      <th className="px-3 py-2 text-right">{t("Продуктивність")}</th>
                      <th className="px-3 py-2 text-right">{t("Ставка фабрики")}</th>
                      <th className="px-3 py-2 text-right">{t("Потроненя")}</th>
                    </>
                  )}
                  <th className="px-3 py-2">{t("Працівник у базі")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={i} className={checked[i] ? "" : "opacity-50"}>
                    <td className="px-3 py-2"><input type="checkbox" checked={!!checked[i]} onChange={e => setChecked(c => ({ ...c, [i]: e.target.checked }))} className="h-4 w-4 accent-red-600" /></td>
                    {hasKeys && <td className="px-3 py-2 tabular-nums text-slate-500">{r.key ?? "—"}</td>}
                    <td className="px-3 py-2 font-medium text-slate-700">{r.name}</td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-700">{r.hours}</td>
                    {format === "eurocash" && (
                      <>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">{r.extras?.nocneH ?? "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">{r.extras?.produktywnosc != null ? Math.round(r.extras.produktywnosc * 100) / 100 : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">{r.extras?.stawkaAgencji != null ? Math.round(r.extras.stawkaAgencji * 100) / 100 : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-red-600">{((r.extras?.potracenia ?? 0) + (r.extras?.innePotracenia ?? 0)) || "—"}</td>
                      </>
                    )}
                    <td className="px-3 py-2">
                      {r.workerId != null ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700" title={r.byKey ? t("Заматчено по ключу фабрики") : undefined}>
                          {r.byKey ? <KeyRound className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />} {r.matchName}
                        </span>
                      ) : (() => {
                        // «Чи це та сама людина?»: пропонуються ЛИШЕ люди з рапортом
                        // без збігу з фабрикою, найближчі за годинами — вгорі.
                        // Вибраний у ЦЬОМУ рядку лишається, вибрані в інших — ховаються.
                        // Плюс завжди доступна опція «створити профіль» — нова
                        // людина з файла фабрики, якої ще немає в базі.
                        const opts = missingWorkers
                          .filter(w => !pickedIds.has(w.id) || picked[i] === w.id)
                          .sort((a, b) => Math.abs(a.reportHours - r.hours) - Math.abs(b.reportHours - r.hours));
                        return (
                          <Select value={createSel[i] ? "__create__" : picked[i] ?? ""} onChange={e => {
                            const v = e.target.value;
                            if (v === "__create__") {
                              setCreateSel(s => ({ ...s, [i]: true }));
                              setPicked(p => ({ ...p, [i]: null }));
                              setChecked(c => ({ ...c, [i]: true })); // створюємо → одразу в список
                            } else {
                              const id = v ? Number(v) : null;
                              setCreateSel(s => ({ ...s, [i]: false }));
                              setPicked(p => ({ ...p, [i]: id }));
                              setChecked(c => ({ ...c, [i]: id != null })); // вибрав людину → одразу в список
                            }
                          }} className={`w-full ${createSel[i] ? "border-red-300 text-red-700" : ""}`}>
                            <option value="">{opts.length ? t("— вибери, якщо це та сама людина —") : t("не знайдено в базі")}</option>
                            <option value="__create__">{t("➕ Створити профіль «{name}»", { name: r.name })}</option>
                            {opts.map(w => <option key={w.id} value={w.id}>{w.name} — {w.reportHours} {t("год")} ({t("рапорт")})</option>)}
                          </Select>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nCreate > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50/60 px-3 py-2 text-sm text-red-700">
              <span className="font-medium">{t("Нові профілі ({n}) — фірма:", { n: nCreate })}</span>
              <Select value={createCompanyId} onChange={e => setCreateCompanyId(e.target.value ? Number(e.target.value) : "")} className="w-44">
                <option value="">{t("— без фірми —")}</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <span className="text-xs text-red-600">{t("Створяться активними на цій фабриці й одразу отримають години з файла.")}</span>
            </div>
          )}
          {unmatchedMissing.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-700">
              <span className="font-medium">{t("Є в обліку, але без годин фабрики ({n}):", { n: unmatchedMissing.length })}</span>{" "}
              {unmatchedMissing.map(w => `${w.name} (${w.reportHours} ${t("год")})`).join(", ")}
              <div className="mt-0.5 text-xs text-amber-600">{t("Якщо хтось із них є у файлі під іншим написанням — вибери його у випадайці відповідного рядка.")}</div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <button onClick={() => { setRows(null); setText(""); }} className="text-sm text-slate-500 underline-offset-2 hover:underline">{t("← Назад до вибору файла")}</button>
            <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!nSelected}>
              <Check className="h-4 w-4" /> {t("Зберегти {n} рядків", { n: nSelected })}
            </Button>
          </div>
        </div>
        );
      })()}
    </Modal>
  );
}

// Ключі фабрики: особисті номери працівників у системі фабрики (Nr Osobowy).
// Імпорт годин матчить рядки спершу по цих ключах — без fuzzy по імені.
// Масова заливка: вставлений список «ключ; ім'я» → превʼю з матчингом → збереження.
function FactoryKeysModal({ group, onClose }: { group: Group; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const factoryId = group.factoryId!;
  interface KeyItem { id: number; code: string; workerId: number; workerName: string | null; isActive: boolean | null }
  interface KeyRow { code: string; name: string; workerId: number | null; matchName: string | null; candidates: { id: number; name: string; active: boolean }[]; conflictName: string | null }
  const { data: keys = [] } = useQuery<KeyItem[]>({
    queryKey: ["factory-codes", factoryId],
    queryFn: () => get(`/hours/factory-codes?factoryId=${factoryId}`),
  });
  const [text, setText] = useState("");
  const [rows, setRows] = useState<KeyRow[] | null>(null);
  const [picked, setPicked] = useState<Record<number, number | null>>({});
  const parse = useMutation({
    mutationFn: () => post<{ rows: KeyRow[] }>("/hours/factory-codes-parse", { factoryId, text }),
    onSuccess: r => {
      setRows(r.rows);
      const p: Record<number, number | null> = {};
      r.rows.forEach((row, i) => { p[i] = row.workerId; });
      setPicked(p);
    },
    onError: (e: any) => toast.error(e.message),
  });
  const apply = useMutation({
    mutationFn: () => post<{ saved: number; conflicts: string[] }>("/hours/factory-codes-apply", {
      factoryId,
      rows: (rows ?? []).map((r, i) => ({ code: r.code, workerId: picked[i] })).filter(r => r.workerId != null),
    }),
    onSuccess: r => {
      toast.success(t("Збережено ключів: {n}", { n: r.saved }), {
        description: r.conflicts.length ? t("Зайняті іншими профілями: {codes}", { codes: r.conflicts.join(", ") }) : undefined,
      });
      qc.invalidateQueries({ queryKey: ["factory-codes", factoryId] });
      setRows(null); setText("");
    },
    onError: (e: any) => toast.error(e.message),
  });
  const removeKey = useMutation({
    mutationFn: (id: number) => del(`/hours/factory-codes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["factory-codes", factoryId] }),
    onError: (e: any) => toast.error(e.message),
  });
  const nSelected = rows ? rows.filter((_, i) => picked[i] != null).length : 0;
  return (
    <Modal open onClose={onClose} title={`${t("Ключі фабрики")} — ${group.name}`} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-slate-500">{t("Особисті номери працівників у системі фабрики. Імпорт годин матчить рядки «ключ; ім'я; години» спершу по цих ключах — надійніше за матч по імені.")}</p>
        {!rows ? (
          <>
            <div>
              <Label>{t("Вставити список «ключ; ім'я» (по рядку на людину)")}</Label>
              <textarea value={text} onChange={e => setText(e.target.value)} rows={6}
                placeholder={"1234; Kowalski Jan\n5678; Nowak Anna"}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-700 outline-none focus:border-red-300" />
              <div className="mt-2 flex justify-end">
                <Button onClick={() => parse.mutate()} loading={parse.isPending} disabled={!text.trim()}>{t("Розібрати")}</Button>
              </div>
            </div>
            {keys.length > 0 ? (
              <div className="max-h-[40vh] overflow-y-auto rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">{t("Ключ")}</th>
                      <th className="px-3 py-2">{t("Працівник")}</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {keys.map(k => (
                      <tr key={k.id}>
                        <td className="px-3 py-2 font-medium tabular-nums text-slate-700">{k.code}</td>
                        <td className="px-3 py-2 text-slate-700">{k.workerName ?? "—"}{k.isActive === false && <span className="ml-1.5 text-xs text-slate-400">({t("звільнений")})</span>}</td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={() => removeKey.mutate(k.id)} disabled={removeKey.isPending}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити ключ")}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-slate-400">{t("Ключів для цієї фабрики ще немає.")}</p>
            )}
          </>
        ) : (
          <>
            <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">{t("Ключ")}</th>
                    <th className="px-3 py-2">{t("Ім'я у файлі")}</th>
                    <th className="px-3 py-2">{t("Працівник у базі")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => (
                    <tr key={i} className={picked[i] != null ? "" : "opacity-60"}>
                      <td className="px-3 py-2 font-medium tabular-nums text-slate-700">{r.code}</td>
                      <td className="px-3 py-2 text-slate-700">{r.name}</td>
                      <td className="px-3 py-2">
                        {r.workerId != null && picked[i] === r.workerId ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700"><Check className="h-3.5 w-3.5" /> {r.matchName}</span>
                        ) : (
                          <Select value={picked[i] ?? ""} onChange={e => setPicked(p => ({ ...p, [i]: e.target.value ? Number(e.target.value) : null }))} className="w-full">
                            <option value="">{r.candidates.length ? t("— вибери, якщо це та сама людина —") : t("не знайдено в базі")}</option>
                            {r.candidates.map(c => <option key={c.id} value={c.id}>{c.name}{c.active ? "" : ` (${t("звільнений")})`}</option>)}
                          </Select>
                        )}
                        {r.conflictName && (
                          <div className="mt-0.5 text-xs text-amber-600">{t("Ключ зараз за: {name} — збереження пропустить його, спершу видали стару пару", { name: r.conflictName })}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <button onClick={() => setRows(null)} className="text-sm text-slate-500 underline-offset-2 hover:underline">{t("← Назад до списку")}</button>
              <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!nSelected}>
                <Check className="h-4 w-4" /> {t("Зберегти {n} ключів", { n: nSelected })}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// Звільнення вибраних із датою «від коли». Перед підтвердженням — перевірка
// конфліктів: якщо у людини є дані (явки/дні фабрики/рапорти) ПІЗНІШІ за дату
// звільнення, показується попередження. Дані після звільнення не видаляються —
// сводна позначає такий період як «не оформлений».
function FireWorkersModal({ workers, onClose, onDone }: { workers: { id: number; name: string }[]; onClose: () => void; onDone?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayStr());
  const { data: acts = [] } = useQuery<{ workerId: number; date: string; source: string }[]>({
    queryKey: ["last-activity", workers.map(w => w.id).sort().join(",")],
    queryFn: async () => (await post<{ last: { workerId: number; date: string; source: string }[] }>("/hours/last-activity", { workerIds: workers.map(w => w.id) })).last,
  });
  const actBy = useMemo(() => new Map(acts.map(a => [a.workerId, a])), [acts]);
  const conflicts = workers.filter(w => { const a = actBy.get(w.id); return a && a.date > date; });
  const fire = useMutation({
    mutationFn: async () => { for (const w of workers) await post(`/workers/${w.id}/fire`, { date }); },
    onSuccess: () => {
      toast.success(t("Звільнено: {n}", { n: workers.length }));
      qc.invalidateQueries({ queryKey: ["hours"] });
      qc.invalidateQueries({ queryKey: ["workers"] });
      onDone?.(); onClose();
    },
    onError: (e: any) => { toast.error(e.message); qc.invalidateQueries({ queryKey: ["hours"] }); },
  });
  return (
    <Modal open onClose={onClose} title={t("Звільнити: {n} людей", { n: workers.length })} size="md">
      <div className="space-y-3">
        <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700">
          {workers.map(w => <div key={w.id}>{w.name}</div>)}
        </div>
        <div>
          <Label>{t("Дата звільнення (від коли)")}</Label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 w-44" />
        </div>
        {conflicts.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-700">
            <span className="font-medium">{t("Є дані пізніші за дату звільнення — вони НЕ зникнуть, а сводна позначить цей період як «не оформлений»:")}</span>
            <ul className="mt-1 space-y-0.5">
              {conflicts.map(w => { const a = actBy.get(w.id)!; return <li key={w.id}>• {w.name} — {t("дані до {date} ({source})", { date: ddmm(a.date), source: t(a.source) })}</li>; })}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button onClick={() => fire.mutate()} loading={fire.isPending}>{t("Звільнити з {date}", { date: ddmm(date) })}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Приховані з місяця працівники вкладки (прибрані вручну / відпустка / ще не
// приступив) — список із поверненням у місяць.
function HiddenWorkersModal({ name, month, items, onClose }: { name: string; month: string; items: ExcludedInfo[]; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const unhide = useMutation({
    mutationFn: (workerIds: number[]) => post("/hours/exclusions-remove", { month, workerIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hours", month] }),
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={`${t("Приховані цього місяця")} — ${name}`} size="md">
      <div className="space-y-3">
        {items.length === 0 ? <Empty>{t("Нікого не приховано")}</Empty> : (
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {items.map(e => (
              <div key={e.workerId} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="font-medium text-slate-700">{e.name}</span>
                <Badge color="slate">{t(EXCL_REASON_LABEL[e.reason] ?? e.reason)}</Badge>
                <button onClick={() => unhide.mutate([e.workerId])} disabled={unhide.isPending}
                  className="ml-auto rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                  {t("Повернути")}
                </button>
              </div>
            ))}
          </div>
        )}
        {items.length > 1 && (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => unhide.mutate(items.map(i => i.workerId))} loading={unhide.isPending}>{t("Повернути всіх")}</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// «Залишки» після імпорту годин фабрики: активні люди вкладки БЕЗ годин з
// файлу, без рапорту і без явок місяця — ймовірно вже не працюють тут. По
// кожному вибір дії + масове застосування до всіх.
function LeftoversModal({ group, leftovers, month, onClose }: { group: Group; leftovers: HourRow[]; month: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  type Act = "keep" | "fire" | "vacation" | "not_started";
  const [action, setAction] = useState<Record<number, Act>>({});
  const [date, setDate] = useState(todayStr());
  const actOf = (id: number): Act => action[id] ?? "keep";
  const setAll = (a: Act) => setAction(Object.fromEntries(leftovers.map(r => [r.workerId, a])));
  const nFire = leftovers.filter(r => actOf(r.workerId) === "fire").length;
  const nHide = leftovers.filter(r => ["vacation", "not_started"].includes(actOf(r.workerId))).length;
  const apply = useMutation({
    mutationFn: async () => {
      const fireIds = leftovers.filter(r => actOf(r.workerId) === "fire").map(r => r.workerId);
      const excl = leftovers.filter(r => ["vacation", "not_started"].includes(actOf(r.workerId)))
        .map(r => ({ workerId: r.workerId, reason: actOf(r.workerId) }));
      for (const id of fireIds) await post(`/workers/${id}/fire`, { date });
      if (excl.length) await post("/hours/exclusions", { month, items: excl });
      return { fired: fireIds.length, hidden: excl.length };
    },
    onSuccess: (r) => {
      if (r.fired || r.hidden) toast.success(t("Готово: звільнено {f}, приховано {h}", { f: r.fired, h: r.hidden }));
      qc.invalidateQueries({ queryKey: ["hours", month] });
      qc.invalidateQueries({ queryKey: ["workers"] });
      onClose();
    },
    onError: (e: any) => { toast.error(e.message); qc.invalidateQueries({ queryKey: ["hours", month] }); },
  });
  const ACTS: [Act, string][] = [["keep", t("залишити")], ["fire", t("звільнити")], ["vacation", t("відпустка")], ["not_started", t("ще не приступив")]];
  return (
    <Modal open onClose={onClose} title={`${t("Люди без годин цього місяця")} — ${group.name}`} size="lg">
      <div className="space-y-3">
        <p className="text-sm text-slate-500">{t("Ці люди активні на вкладці, але не отримали годин з файлу фабрики, не здали рапорт і не мають явок місяця ({n}). Ймовірно, вже тут не працюють — вибери, що з ними зробити:", { n: leftovers.length })}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {t("Всім:")}
          {ACTS.map(([a, label]) => (
            <button key={a} onClick={() => setAll(a)}
              className={`rounded-lg border px-2 py-1 font-medium ${a === "fire" ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
              {label}
            </button>
          ))}
          <span className="ml-auto inline-flex items-center gap-1.5">
            {t("Дата звільнення")}
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-40" />
          </span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {leftovers.map(r => (
                <tr key={r.workerId} className={actOf(r.workerId) === "fire" ? "bg-rose-50/40" : ""}>
                  <td className="px-3 py-2 font-medium text-slate-700">{r.name}</td>
                  <td className="px-3 py-2 text-right">
                    <Select value={actOf(r.workerId)} onChange={e => setAction(s => ({ ...s, [r.workerId]: e.target.value as Act }))} className="w-44">
                      {ACTS.map(([a, label]) => <option key={a} value={a}>{label}</option>)}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">{nFire > 0 && t("Звільнено буде: {n} (з {date})", { n: nFire, date: ddmm(date) })}{nFire > 0 && nHide > 0 ? " · " : ""}{nHide > 0 && t("Приховано з місяця: {n}", { n: nHide })}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{t("Закрити")}</Button>
            <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!nFire && !nHide}>{t("Застосувати")}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Лист клієнту про розбіжності (польською): драфт генерується з поточних даних
// і живо оновлюється після правок годин, поки адмін не відредагував текст вручну.
function DiscrepancyEmailModal({ group, month, onClose }: { group: Group; month: string; onClose: () => void }) {
  const t = useT();
  const mismatches = useMemo(() => group.rows.filter(w => diffState(w) === "mismatch"), [group]);
  const monthPl = useMemo(() => new Date(`${month}-01T00:00:00`).toLocaleDateString("pl-PL", { month: "long", year: "numeric" }), [month]);
  // Позмінна звірка (рапорт = наші явки, файл фабрики має дні) — конкретні дні в лист
  interface DayDiff { date: string; our: number; ourShifts: string[]; factory: number }
  const { data: dayCmp } = useQuery<{ workers: { workerId: number; days: DayDiff[] }[] }>({
    queryKey: ["hours-day-compare", month, group.factoryId],
    queryFn: () => get(`/hours/day-compare?month=${month}&factoryId=${group.factoryId}`),
  });
  const dayByWorker = useMemo(() => new Map((dayCmp?.workers ?? []).map(w => [w.workerId, w.days])), [dayCmp]);
  const generated = useMemo(() => {
    const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
    const lines = mismatches.flatMap(w => {
      const diff = Math.round(((w.factoryHours ?? 0) - (w.reportHours ?? 0)) * 100) / 100;
      const head = `• ${w.name}: wg raportu pracownika ${w.reportHours} godz., wg zestawienia z Państwa strony ${w.factoryHours} godz. (różnica ${diff > 0 ? "+" : ""}${diff} godz.)`;
      const days = dayByWorker.get(w.workerId);
      if (!days?.length) return [head];
      return [head,
        "   Rozbieżne dni (wg potwierdzonych obecności):",
        ...days.map(d =>
          `   – ${ddmm(d.date)}: u nas ${d.our} godz.${d.ourShifts.length ? ` (zmiana ${d.ourShifts.join("+")})` : ""}, wg Państwa ${d.factory} godz.`),
      ];
    });
    return {
      subject: `Rozbieżności w godzinach — ${group.name} — ${monthPl}`,
      body: [
        "Dzień dobry,",
        "",
        `po weryfikacji godzin za ${monthPl} znaleźliśmy rozbieżności między raportami naszych pracowników a zestawieniem z Państwa strony:`,
        "",
        ...lines,
        "",
        "W załączeniu przesyłamy raporty pracowników jako potwierdzenie.",
        "",
        "Prosimy o weryfikację i informację zwrotną.",
        "",
        "Pozdrawiamy,",
        "Euro Support",
      ].join("\n"),
    };
  }, [mismatches, group.name, monthPl, dayByWorker]);
  // null = слідувати за згенерованим (живе оновлення); рядок = ручна правка
  const [customSubject, setCustomSubject] = useState<string | null>(null);
  const [customBody, setCustomBody] = useState<string | null>(null);
  const [to, setTo] = useState(() => group.rows.find(r => r.clientEmail)?.clientEmail ?? "");
  const subject = customSubject ?? generated.subject;
  const body = customBody ?? generated.body;
  const withReport = mismatches.filter(w => w.reportSubmitted && w.reportLink);
  const withoutReport = mismatches.filter(w => !(w.reportSubmitted && w.reportLink));
  const send = useMutation({
    mutationFn: () => post<{ sent: boolean; attached: number; missingReports: string[] }>("/hours/discrepancy-email", {
      month, factoryId: group.factoryId, to, subject, body, attachWorkerIds: withReport.map(w => w.workerId),
    }),
    onSuccess: (r) => {
      toast.success(t("Лист надіслано на {to} (вкладень: {n})", { to, n: r.attached }), {
        description: r.missingReports.length ? t("Без рапорту-доказу: {list}", { list: r.missingReports.join(", ") }) : undefined,
      });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={`${t("Лист про розбіжності")} — ${group.name} · ${month}`} size="xl">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Badge color="red">{mismatches.length} {t("розбіжностей")}</Badge>
          {(customSubject != null || customBody != null) ? (
            <button onClick={() => { setCustomSubject(null); setCustomBody(null); }} className="inline-flex items-center gap-1 text-xs text-slate-500 underline-offset-2 hover:underline">
              <RotateCcw className="h-3 w-3" /> {t("Скинути до згенерованого")}
            </button>
          ) : (
            <span className="text-xs text-slate-400">{t("Текст оновлюється автоматично при правках годин")}</span>
          )}
        </div>
        <div>
          <Label>{t("Кому (email клієнта)")}</Label>
          <Input value={to} onChange={e => setTo(e.target.value)} placeholder="klient@fabryka.pl" className="mt-1" />
        </div>
        <div>
          <Label>{t("Тема")}</Label>
          <Input value={subject} onChange={e => setCustomSubject(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label>{t("Текст листа")}</Label>
          <textarea value={body} onChange={e => setCustomBody(e.target.value)} rows={14}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-700 outline-none focus:border-red-300" />
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <div className="font-medium text-slate-700">{t("Вкладення (PDF-рапорти як докази):")} {withReport.length}</div>
          {withReport.length > 0 && <div className="mt-1">{withReport.map(w => w.name).join(", ")}</div>}
          {withoutReport.length > 0 && (
            <div className="mt-1 text-amber-700">{t("Без файла рапорту (не буде прикріплено):")} {withoutReport.map(w => w.name).join(", ")}</div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button onClick={() => { if (window.confirm(t("Надіслати лист клієнту на {to}?", { to }))) send.mutate(); }} loading={send.isPending} disabled={!to || !mismatches.length}>
            <Mail className="h-4 w-4" /> {t("Надіслати клієнту")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Ручна замітка рядка (hours_notes): вільний текст графіка/офісу — «підмінявся»,
// «перевірити з фабрикою» тощо. Порожнє значення при збереженні видаляє замітку.
function NoteCell({ w, month, canEdit }: { w: HourRow; month: string; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const save = useMutation({
    mutationFn: (note: string) => post("/hours/note", { workerId: w.workerId, month, note, factoryId: w.factoryId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hours", month] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  if (editing) {
    const submit = () => save.mutate(val.trim());
    return (
      <span className="flex items-center gap-1">
        <Input value={val} onChange={e => setVal(e.target.value)} maxLength={500} placeholder={t("Замітка…")} className="w-44" autoFocus
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") setEditing(false); }} />
        <button onClick={submit} disabled={save.isPending} className="rounded-md p-1 text-emerald-600 hover:bg-emerald-50"><Check className="h-4 w-4" /></button>
        <button onClick={() => setEditing(false)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      {w.note
        ? <span className="truncate text-slate-600" title={w.note}>{w.note}</span>
        : <span className="text-slate-300">—</span>}
      {canEdit && (
        <button onClick={() => { setVal(w.note ?? ""); setEditing(true); }}
          className="shrink-0 rounded-md p-0.5 text-slate-300 hover:text-red-600" title={t("Вписати замітку")}>
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  );
}

// Report-hours cell: read-only for non-editors; click-to-edit inline for admins so they
// can fill hours manually (e.g. for workers who submitted before this feature existed).
function ReportHoursCell({ w, month, canEdit }: { w: HourRow; month: string; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const save = useMutation({
    mutationFn: (hours: string | null) => post("/hours/report", { workerId: w.workerId, month, hours, factoryId: w.factoryId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hours", month] }); qc.invalidateQueries({ queryKey: ["hours-day-compare"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  // The hours value links to the submitted report file (Drive) when there is one.
  const linked = w.reportSubmitted
    ? (w.reportLink
        ? <a href={w.reportLink} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="font-semibold text-red-700 underline-offset-2 hover:underline" title={t("Відкрити рапорт")}>{w.reportHours} {t("год")}</a>
        : <span className="font-semibold text-slate-700">{w.reportHours} {t("год")}</span>)
    : <Badge color="amber">{t("не вислано")}</Badge>;
  if (!canEdit) return linked;
  if (editing) {
    const submit = () => save.mutate(val.replace(",", ".").trim() || null);
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <Input value={val} onChange={e => setVal(e.target.value)} inputMode="decimal" placeholder="0–400" className="w-20 text-right" autoFocus
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") setEditing(false); }} />
        <button onClick={submit} disabled={save.isPending} className="rounded-md p-1 text-emerald-600 hover:bg-emerald-50"><Check className="h-4 w-4" /></button>
        <button onClick={() => setEditing(false)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {linked}
      <button onClick={() => { setVal(w.reportHours != null ? String(w.reportHours) : ""); setEditing(true); }} className="rounded-md p-0.5 text-slate-300 hover:text-red-600" title={t("Вписати години")}><Pencil className="h-3.5 w-3.5" /></button>
    </span>
  );
}

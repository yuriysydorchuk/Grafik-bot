// «Зарплата по фабриках» у профілі працівника (01.10.2026) — щоб офіс швидко відповів
// людині «чому стільки». Лише читання сводної (GET /workers/:id/pay): картка на фабрику за
// місяць, клік — години × ставка нетто, нарахування, потрачення з джерелами (аванси, штрафи,
// пропуски, бадання, одяг, доїзд, хостел) і фінальна сума. Без konto/готівки.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Wallet, Lock } from "lucide-react";
import { get } from "../lib/api";
import { useT } from "../lib/i18n";
import { Card, Badge } from "./ui";
import { CLOTHING_TYPE_FALLBACK } from "../lib/clothingTypes";

type Line = { key: string; amount: number; qty?: number; per?: number };
type PayRow = {
  id: number; month: string; factoryId: number | null; factoryLabel: string; city: string; firm: string | null; locked: boolean;
  hours: number | null; shifts: number | null; rateNetto: number | null; facBonus: number | null;
  segments: { label: string | null; from: string | null; to: string | null; hours: number | null; rateNetto: number | null; base: number | null }[];
  base: number | null; additions: Line[]; deductions: Line[]; adjust: number | null;
  debtIn: { from: string | null; cols: Record<string, number> } | null; doWyplaty: number | null;
};
type Detail = { id: number; month: string | null; factoryId: number | null; amount: number | null } & Record<string, any>;
type PayResp = { months: string[]; rows: PayRow[]; details: Record<"zaliczka" | "kara" | "absences" | "badania" | "odziez" | "dojazd" | "hostel", Detail[]> };

// Підписи колонок сводної (укр-рядок-як-ключ для t())
const LABEL: Record<string, string> = {
  migawka: "Доплата (migawka)", premia: "Премія", dojazdPlus: "Доплата за доїзд", nocne: "Нічні години",
  premiaEs: "Премія ES за годину", oplataKierowcy: "Оплата за водіння", doplataEs: "Доплата ES", zwrotKosztow: "Повернення коштів",
  zaliczka: "Аванси", zaliczkaBd: "Бадання (Zaliczka BD)", hostel: "Хостел", odziez: "Одяг", dojazd: "Транспорт (доїзд)",
  kara: "Штрафи і пропуски", komornik: "Komornik", kaucja: "Кауція", potracenia: "Інші потрачення", badania: "Бадання",
  kartaPobytu: "Karta pobytu", karaKlient: "Штраф від клієнта", karaEs: "Штраф ES", zadluzenie: "Заборгованість", dokumenty: "Документи",
};

const zl = (v: number | null | undefined) => v == null ? "—" : `${(Math.round(v * 100) / 100).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const n2 = (v: number | null | undefined) => v == null ? "—" : (Math.round(v * 100) / 100).toLocaleString("pl-PL");
const d10 = (v: string | null | undefined) => v ? String(v).slice(0, 10) : "";

export function WorkerPayCard({ workerId }: { workerId: number }) {
  const t = useT();
  const { data, isLoading } = useQuery<PayResp>({ queryKey: ["worker-pay", workerId], queryFn: () => get(`/workers/${workerId}/pay`) });
  const [month, setMonth] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const months = data?.months.filter(m => data.rows.some(r => r.month === m)) ?? [];
  const cur = month && months.includes(month) ? month : months[0] ?? null;
  const rows = (data?.rows ?? []).filter(r => r.month === cur);
  const total = rows.reduce((a, r) => a + (r.doWyplaty ?? 0), 0);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-2.5">
        <Wallet className="h-4 w-4 text-slate-400" />
        <h3 className="text-sm font-semibold text-slate-700">{t("Зарплата по фабриках")}</h3>
        {months.length > 0 && (
          <div className="ml-auto flex max-w-full gap-1 overflow-x-auto">
            {months.slice(0, 12).map(m => (
              <button key={m} onClick={() => { setMonth(m); setOpen(null); }}
                className={m === cur ? "whitespace-nowrap rounded-lg bg-red-600 px-2 py-0.5 text-xs font-medium text-white" : "whitespace-nowrap rounded-lg px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100"}>
                {m}
              </button>
            ))}
          </div>
        )}
      </div>
      {isLoading ? <div className="px-5 py-3 text-sm text-slate-400">…</div>
        : !rows.length ? <div className="px-5 py-3 text-sm text-slate-400">{t("Рядків сводної ще немає")}</div>
        : (
          <div className="divide-y divide-slate-100">
            {rows.map(r => (
              <PayRowView key={r.id} r={r} details={data!.details} open={open === r.id} onToggle={() => setOpen(o => o === r.id ? null : r.id)} />
            ))}
            {rows.length > 1 && (
              <div className="flex items-center justify-between bg-slate-50 px-5 py-2 text-sm">
                <span className="text-slate-500">{t("Разом за {month}", { month: cur ?? "" })}</span>
                <span className="font-semibold tabular-nums text-emerald-700">{zl(total)}</span>
              </div>
            )}
          </div>
        )}
    </Card>
  );
}

function PayRowView({ r, details, open, onToggle }: { r: PayRow; details: PayResp["details"]; open: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <div>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-5 py-2.5 text-left hover:bg-slate-50">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-700">{r.factoryLabel}</div>
          <div className="text-xs text-slate-400">{r.city}{r.firm ? ` · ${r.firm}` : ""} · {n2(r.hours)} {t("год")} × {n2(r.rateNetto)} zł</div>
        </div>
        {r.locked
          ? <Badge color="green"><Lock className="mr-0.5 inline h-3 w-3" />{t("затверджено")}</Badge>
          : <Badge color="amber">{t("попередньо")}</Badge>}
        <span className="w-28 shrink-0 text-right text-sm font-semibold tabular-nums text-emerald-700">{zl(r.doWyplaty)}</span>
      </button>
      {open && <PayBreakdown r={r} details={details} />}
    </div>
  );
}

function PayBreakdown({ r, details }: { r: PayRow; details: PayResp["details"] }) {
  const t = useT();
  const mine = (list: Detail[]) => list.filter(d => d.month === r.month && (d.factoryId == null || d.factoryId === r.factoryId));
  // джерела потрачення: що саме сиділо в колонці
  const sourcesFor = (key: string): { text: string; amount: number | null }[] => {
    switch (key) {
      case "zaliczka": return mine(details.zaliczka).map(a => ({
        text: `${d10(a.paidAt ?? a.createdAt)}${a.paidMethod === "cash" ? ` · ${t("готівкою")}` : a.paidMethod === "transfer" ? ` · ${t("переказом")}` : ""}`, amount: a.amount }));
      case "kara": return [
        ...mine(details.kara).map(p => ({ text: p.note ? String(p.note) : t("Штраф"), amount: p.amount })),
        ...mine(details.absences).map(a => ({ text: t("Невиправданий пропуск {date}", { date: d10(a.date) }), amount: a.amount })),
      ];
      case "zaliczkaBd": case "badania": return mine(details.badania).map(b => ({ text: `${d10(b.enteredAt)}${b.note ? ` · ${b.note}` : ""}`, amount: b.amount }));
      case "odziez": return mine(details.odziez).map(c => ({ text: `${t(CLOTHING_TYPE_FALLBACK[c.itemType] ?? c.itemType)}${c.size ? ` (${c.size})` : ""}${c.issuedAt ? ` · ${d10(c.issuedAt)}` : ""}`, amount: c.amount }));
      case "dojazd": return mine(details.dojazd).map(d => ({ text: d.trips != null ? t("Поїздок: {n}", { n: d.trips }) : (d.note ?? t("Довіз")), amount: d.amount }));
      case "hostel": return mine(details.hostel).map(h => ({ text: h.note ? String(h.note) : t("Проживання"), amount: h.amount }));
      default: return [];
    }
  };
  const debtFor = (key: string) => r.debtIn?.cols?.[key] ?? r.debtIn?.cols?.[`extras.${key}`] ?? 0;
  const lineLabel = (l: Line) => {
    const base = t(LABEL[l.key] ?? l.key);
    if (l.key === "nocne" && l.qty) return `${base}: ${n2(l.qty)} ${t("год")} × ${n2(l.per)} zł`;
    if (l.key === "premiaEs" && l.qty) return `${base}: ${n2(l.qty)} ${t("год")} × ${n2(l.per)} zł`;
    return base;
  };

  return (
    <div className="space-y-3 bg-slate-50/60 px-5 pb-4 pt-1 text-sm">
      {/* Години × ставка */}
      <div>
        <div className="mb-1 text-xs font-semibold uppercase text-slate-400">{t("Години і ставка")}</div>
        {r.segments.length > 0 ? r.segments.map((s, i) => (
          <Row key={i} label={`${s.label ?? `${d10(s.from)} – ${d10(s.to)}`}: ${n2(s.hours)} ${t("год")} × ${n2(s.rateNetto)} zł`} amount={s.base} />
        )) : (
          <Row label={`${n2(r.hours)} ${t("год")}${r.shifts ? ` (${t("змін: {n}", { n: n2(r.shifts) })})` : ""} × ${n2(r.rateNetto)} zł ${t("нетто")}`} amount={r.base} />
        )}
        {r.facBonus ? <p className="mt-0.5 text-xs text-slate-400">{t("У ставці вже є бонус фабрики +{b} zł/год", { b: n2(r.facBonus) })}</p> : null}
      </div>

      {r.additions.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-400">{t("Нарахування і премії")}</div>
          {r.additions.map(l => <Row key={l.key} label={lineLabel(l)} amount={l.amount} sign="+" tone="text-emerald-700" />)}
        </div>
      )}

      {r.deductions.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-400">{t("Потрачення")}</div>
          {r.deductions.map(l => {
            const src = sourcesFor(l.key);
            const debt = debtFor(l.key);
            return (
              <div key={l.key}>
                <Row label={lineLabel(l)} amount={l.amount} sign="−" tone="text-rose-700" />
                {(src.length > 0 || debt > 0) && (
                  <ul className="mb-1 ml-4 space-y-0.5 border-l border-slate-200 pl-3 text-xs text-slate-500">
                    {src.map((s, i) => <li key={i} className="flex justify-between gap-3"><span className="min-w-0 truncate">{s.text}</span><span className="shrink-0 tabular-nums">{zl(s.amount)}</span></li>)}
                    {debt > 0 && <li className="flex justify-between gap-3"><span>{t("Борг, перенесений з {m}", { m: r.debtIn?.from ?? "" })}</span><span className="tabular-nums">{zl(debt)}</span></li>}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {r.adjust != null && (
        <Row label={t("Ручні правки сводної / інше")} amount={Math.abs(r.adjust)} sign={r.adjust > 0 ? "+" : "−"} tone="text-slate-600" />
      )}

      <div className="flex items-center justify-between border-t border-slate-200 pt-2">
        <span className="font-semibold text-slate-700">{t("До виплати")}</span>
        <span className="text-base font-bold tabular-nums text-emerald-700">{zl(r.doWyplaty)}</span>
      </div>
      {!r.locked && <p className="text-xs text-amber-600">{t("Сводна за цей місяць ще не затверджена — суми можуть змінитись.")}</p>}
    </div>
  );
}

function Row({ label, amount, sign, tone = "text-slate-700" }: { label: string; amount: number | null; sign?: "+" | "−"; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="min-w-0 text-slate-600">{label}</span>
      <span className={`shrink-0 tabular-nums ${tone}`}>{sign && amount != null ? `${sign} ` : ""}{zl(amount)}</span>
    </div>
  );
}

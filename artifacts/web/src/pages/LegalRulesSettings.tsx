// Налаштування → «Правила легальності»: картки людською мовою замість сирого
// журналу правил (відгук власника 04.09.2026: «щоб легше і зрозуміліше
// налаштовувати»). Кожна картка редагує одне правило legal_rules (code);
// «Зберегти» створює НОВУ ВЕРСІЮ з датою «діє з» (попередня закривається на
// бекенді, POST /legal-rules), історія версій — під карткою. Мапа статусів —
// теж картка (правило payroll.status_map поверх дефолтів коду,
// services/legalStatusMap.ts). Нетипові правила юриста — «Додаткові правила»
// зі старим JSON-редактором.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Scale, Check, ShieldQuestion, History, ChevronUp, ChevronDown, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, type LegalRule, type LegalStatusMap, type DocumentType, type PayrollGroupCode } from "../lib/api";
import { Card, Spinner, Input, Label, Button, Select, Badge, Modal, Textarea } from "../components/ui";
import { useT } from "../lib/i18n";
import { NATIONALITIES } from "../lib/nationality";
import { NAT_GROUP_LABEL } from "../lib/legality";
import { LEGAL_LABEL, LEGAL_STATUSES, type LegalStatus } from "../lib/legalStatus";

const RULE_KIND_LABEL: Record<LegalRule["kind"], string> = {
  basis_by_nationality: "підстава за громадянством", requirement: "вимога", obligation: "обов'язок",
  precedence: "пріоритет", global: "глобальний параметр",
};
const RULE_AXIS_LABEL: Record<string, string> = { stay: "Перебування", work: "Праця", both: "обидві", none: "—" };
const today = () => new Date().toLocaleDateString("sv-SE");
// Коди, які мають власну картку; решта — «Додаткові правила»
const CARD_CODES = new Set(["defaults.lead_days", "global.ukr_status_end", "obligation.ua_notification", "precedence.work_during_case", "defaults.evidence",
  "stay.pl_citizen", "stay.eu_citizen", "requirement.identity", "requirement.stay_non_eu", "requirement.work_non_eu", "payroll.status_map"]);

// чинна версія коду: effectiveTo null і вже діє; інакше найновіша
function currentOf(rules: LegalRule[], code: string): LegalRule | undefined {
  const td = today();
  const vs = rules.filter(r => r.code === code);
  return vs.find(r => r.isActive && r.effectiveTo === null && r.effectiveFrom <= td) ?? vs[0];
}

export function LegalRulesSettings() {
  const t = useT();
  const qc = useQueryClient();
  const { data: rules = [], isLoading } = useQuery<LegalRule[]>({ queryKey: ["legal-rules"], queryFn: () => get("/legal-rules") });
  const [advanced, setAdvanced] = useState<{ mode: "newRule" } | { mode: "newVersion"; rule: LegalRule } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const inv = () => { qc.invalidateQueries({ queryKey: ["legal-rules"] }); qc.invalidateQueries({ queryKey: ["legal-status-map"] }); };

  const extraCodes: string[] = [];
  for (const r of rules) if (!CARD_CODES.has(r.code) && !extraCodes.includes(r.code)) extraCodes.push(r.code);

  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-slate-500">
        {t("Правила, за якими система світить легальність і рахує групу виплат. Кожне збереження — нова версія з датою «діє з»; попередня закривається сама, історія лишається під карткою. Після збереження легальність усіх активних перераховується.")}
      </p>

      <StatusMapCard rules={rules} onSaved={inv} />
      <LeadDaysCard rules={rules} onSaved={inv} />
      <UkrCard rules={rules} onSaved={inv} />
      <UaNotificationCard rules={rules} onSaved={inv} />
      <TogglesCard rules={rules} onSaved={inv} />
      <CitizenshipCard rules={rules} onSaved={inv} />
      <RequirementsCard rules={rules} onSaved={inv} />

      <Card className="overflow-hidden">
        <button type="button" onClick={() => setShowAdvanced(v => !v)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
          {showAdvanced ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
          <span className="text-sm font-semibold text-slate-700">{t("Додаткові правила")}</span>
          <span className="text-xs text-slate-400">({extraCodes.length})</span>
          <span className="ml-auto text-xs text-slate-400">{t("нетипові правила юриста, JSON-редактор")}</span>
        </button>
        {showAdvanced && (
          <div className="space-y-2 border-t border-slate-100 p-3">
            {extraCodes.map(code => <RuleGroup key={code} code={code} versions={rules.filter(r => r.code === code)} onNewVersion={r => setAdvanced({ mode: "newVersion", rule: r })} />)}
            <Button variant="secondary" onClick={() => setAdvanced({ mode: "newRule" })}><Plus className="h-4 w-4" /> {t("Нове правило")}</Button>
          </div>
        )}
      </Card>

      {advanced && (
        <RuleModal mode={advanced.mode} rule={advanced.mode === "newVersion" ? advanced.rule : undefined}
          onClose={() => setAdvanced(null)} onSaved={() => { inv(); setAdvanced(null); }} />
      )}
    </div>
  );
}

// ── Каркас картки: заголовок, пояснення, вміст, «Зберегти» (→ VersionModal), історія ──
function RuleCard({ title, hint, code, rules, dirty, buildConditions, kind, axis, onSaved, onReset, children }: {
  title: string; hint: string; code: string; rules: LegalRule[]; dirty: boolean;
  buildConditions: () => Record<string, unknown>; kind: LegalRule["kind"]; axis: "stay" | "work" | "both" | null;
  onSaved: () => void; onReset: () => void; children: React.ReactNode;
}) {
  const t = useT();
  const [showHistory, setShowHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const versions = rules.filter(r => r.code === code);
  const current = currentOf(rules, code);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <Scale className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="text-sm font-semibold text-slate-700">{title}</span>
        {current ? (
          <span className="text-xs text-slate-400">
            {t("діє з {date}", { date: current.effectiveFrom })}
            {current.verifiedAt ? <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">{t("перевірено")}</span>
              : <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">{t("не перевірено")}</span>}
          </span>
        ) : <span className="text-xs text-slate-400">{t("значення за замовчуванням з коду")}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {dirty && <Button variant="secondary" className="px-2 py-1 text-xs" onClick={onReset}><RotateCcw className="h-3.5 w-3.5" /> {t("Скинути")}</Button>}
          <Button className="px-2.5 py-1 text-xs" disabled={!dirty} onClick={() => setSaving(true)}>{t("Зберегти")}</Button>
        </div>
      </div>
      <p className="border-t border-slate-100 px-4 pt-2 text-xs text-slate-500">{hint}</p>
      <div className="px-4 py-3">{children}</div>
      {versions.length > 0 && (
        <>
          <button type="button" onClick={() => setShowHistory(v => !v)} className="flex w-full items-center gap-1.5 border-t border-slate-100 px-4 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-50">
            <History className="h-3.5 w-3.5" /> {t("Історія версій")} ({versions.length})
          </button>
          {showHistory && versions.map(r => <RuleRow key={r.id} r={r} isCurrent={r.id === current?.id} />)}
        </>
      )}
      {saving && (
        <VersionModal code={code} kind={kind} axis={axis} conditions={buildConditions()} previous={current}
          onClose={() => setSaving(false)} onSaved={() => { setSaving(false); onSaved(); }} />
      )}
    </Card>
  );
}

// Дата «діє з», джерело, примітка, «перевірено» → POST /legal-rules (нова версія)
function VersionModal({ code, kind, axis, conditions, previous, onClose, onSaved }: {
  code: string; kind: LegalRule["kind"]; axis: "stay" | "work" | "both" | null; conditions: Record<string, unknown>;
  previous: LegalRule | undefined; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [source, setSource] = useState(previous?.source ?? "");
  const [note, setNote] = useState("");
  const [verified, setVerified] = useState(false);
  const save = useMutation({
    mutationFn: () => post("/legal-rules", { code, kind, axis, conditions, effectiveFrom, source: source.trim() || undefined, note: note.trim() || undefined, verified }),
    onSuccess: () => { toast.success(t("Версію збережено, легальність перераховується")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Зберегти нову версію")}>
      <div className="space-y-3">
        <div><Label>{t("Діє з")}</Label><Input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></div>
        <div><Label>{t("Джерело (URL або назва акта)")}</Label><Input value={source} onChange={e => setSource(e.target.value)} /></div>
        <div><Label>{t("Що змінено і чому")}</Label><Input value={note} onChange={e => setNote(e.target.value)} /></div>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} /> {t("перевірено юристом / власником")}
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!effectiveFrom} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// список чисел через кому ↔ масив
const numsToText = (a: unknown): string => Array.isArray(a) ? a.filter(x => typeof x === "number").join(", ") : "";
const textToNums = (s: string): number[] => s.split(/[,\s]+/).map(x => Number(x)).filter(x => Number.isFinite(x) && x >= 0);
const numOr = (v: unknown, d: number) => typeof v === "number" ? v : d;

// ── Строки та нагадування (defaults.lead_days) ──
function LeadDaysCard({ rules, onSaved }: { rules: LegalRule[]; onSaved: () => void }) {
  const t = useT();
  const cur = currentOf(rules, "defaults.lead_days");
  const c = cur?.conditions ?? {};
  const init = () => ({ documents: numsToText(c.documents) || "60, 30, 14, 7, 0", cases: String(numOr(c.cases, 30)), ukr: numsToText(c.ukr) || "90, 30", def: String(numOr(c.defaultLeadDays, 30)) });
  const [v, setV] = useState(init);
  useEffect(() => { setV(init()); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(v) !== JSON.stringify(init());
  const field = (label: string, key: keyof typeof v, w = "w-40", hint?: string) => (
    <div>
      <Label>{label}</Label>
      <Input value={v[key]} onChange={e => setV({ ...v, [key]: e.target.value })} className={w} />
      {hint && <div className="pt-0.5 text-[11px] text-slate-400">{hint}</div>}
    </div>
  );
  return (
    <RuleCard title={t("Строки та нагадування")} code="defaults.lead_days" kind="global" axis={null} rules={rules} dirty={dirty} onReset={() => setV(init())} onSaved={onSaved}
      hint={t("За скільки днів до кінця строку документ світиться «спливає» і йде нагадування. Кілька чисел через кому — кілька нагадувань.")}
      buildConditions={() => ({ documents: textToNums(v.documents), cases: Number(v.cases) || 30, ukr: textToNums(v.ukr), defaultLeadDays: Number(v.def) || 30 })}>
      <div className="grid gap-3 sm:grid-cols-2">
        {field(t("Документи: за скільки днів"), "documents", "w-56", t("дні через кому, напр. 60, 30, 14, 7, 0"))}
        {field(t("Справи в toku: за скільки днів"), "cases", "w-28")}
        {field(t("Кінець статусу UKR: за скільки днів"), "ukr", "w-40", t("дні через кому"))}
        {field(t("Якщо у типу документа свій строк не заданий"), "def", "w-28", t("днів до кінця"))}
      </div>
    </RuleCard>
  );
}

// ── Статус UKR (global.ukr_status_end) ──
function UkrCard({ rules, onSaved }: { rules: LegalRule[]; onSaved: () => void }) {
  const t = useT();
  const cur = currentOf(rules, "global.ukr_status_end");
  const init = () => String(cur?.conditions.date ?? "");
  const [date, setDate] = useState(init);
  useEffect(() => { setDate(init()); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <RuleCard title={t("Статус UKR — до якої дати діє")} code="global.ukr_status_end" kind="global" axis="stay" rules={rules} dirty={date !== init() && /^\d{4}-\d{2}-\d{2}$/.test(date)} onReset={() => setDate(init())} onSaved={onSaved}
      hint={t("Спецзакон для громадян України: до цієї дати статус UKR (PESEL UKR) дає легальне перебування без інших документів. Коли ustawa продовжить строк — впиши нову дату.")}
      buildConditions={() => ({ date })}>
      <div className="flex flex-wrap items-end gap-3">
        <div><Label>{t("Діє до")}</Label><Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-44" /></div>
        {cur?.source && <span className="pb-2 text-xs text-slate-400">{t("джерело")}: {cur.source}</span>}
      </div>
    </RuleCard>
  );
}

// ── Powiadomienie для громадян України (obligation.ua_notification) ──
function UaNotificationCard({ rules, onSaved }: { rules: LegalRule[]; onSaved: () => void }) {
  const t = useT();
  const cur = currentOf(rules, "obligation.ua_notification");
  const c = cur?.conditions ?? {};
  const init = () => ({ days: String(numOr(c.days, 7)), hard: c.hard === true });
  const [v, setV] = useState(init);
  useEffect(() => { setV(init()); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(v) !== JSON.stringify(init());
  return (
    <RuleCard title={t("Powiadomienie для громадян України")} code="obligation.ua_notification" kind="obligation" axis="work" rules={rules} dirty={dirty} onReset={() => setV(init())} onSaved={onSaved}
      hint={t("Роботодавець мусить подати powiadomienie до PUP протягом кількох днів від початку праці громадянина України. Прострочення можна показувати як попередження або вважати, що права на працю немає.")}
      buildConditions={() => ({ nationalities: (c.nationalities as string[] | undefined) ?? ["ua"], days: Number(v.days) || 7, docCode: (c.docCode as string | undefined) ?? "powiadomienie_ua", hard: v.hard })}>
      <div className="flex flex-wrap items-end gap-4">
        <div><Label>{t("Подати протягом (днів від початку праці)")}</Label><Input value={v.days} onChange={e => setV({ ...v, days: e.target.value })} className="w-24" /></div>
        <div className="flex flex-col gap-1 pb-1 text-sm text-slate-700">
          <label className="flex items-center gap-1.5"><input type="radio" checked={!v.hard} onChange={() => setV({ ...v, hard: false })} /> {t("прострочено — лише попередження і «потребує перевірки»")}</label>
          <label className="flex items-center gap-1.5"><input type="radio" checked={v.hard} onChange={() => setV({ ...v, hard: true })} /> {t("прострочено — права на працю немає (червоне)")}</label>
        </div>
      </div>
    </RuleCard>
  );
}

// ── Два перемикачі: праця під час провадження + документи з бота ──
function TogglesCard({ rules, onSaved }: { rules: LegalRule[]; onSaved: () => void }) {
  const t = useT();
  const curP = currentOf(rules, "precedence.work_during_case");
  const curE = currentOf(rules, "defaults.evidence");
  const initP = () => curP?.conditions.requiresPriorWorkBasis !== false;
  const initE = () => curE?.conditions.unverifiedCountsAsBasis === true;
  const [p, setP] = useState(initP);
  const [e, setE] = useState(initE);
  useEffect(() => { setP(initP()); }, [curP?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setE(initE()); }, [curE?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <RuleCard title={t("Праця під час провадження")} code="precedence.work_during_case" kind="precedence" axis="work" rules={rules} dirty={p !== initP()} onReset={() => setP(initP())} onSaved={onSaved}
        hint={t("Коли справа на карту побиту в toku (є zaświadczenie), працювати можна лише якщо право на працю було до подання. Без цієї галочки будь-яка відкрита справа дає «в toku» на праці.")}
        buildConditions={() => ({ requiresPriorWorkBasis: p })}>
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={p} onChange={ev => setP(ev.target.checked)} /> {t("дозволена лише якщо право на працю було до подання")}</label>
      </RuleCard>
      <RuleCard title={t("Документи, надіслані працівником")} code="defaults.evidence" kind="global" axis={null} rules={rules} dirty={e !== initE()} onReset={() => setE(initE())} onSaved={onSaved}
        hint={t("Фото з бота лягає «на перевірці». Поки офіс не підтвердив — воно не є підставою (рекомендовано). Галочка робить такі документи підставою одразу, з позначкою «потребує перевірки».")}
        buildConditions={() => ({ unverifiedCountsAsBasis: e })}>
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={e} onChange={ev => setE(ev.target.checked)} /> {t("рахувати підставою ще до перевірки офісом")}</label>
      </RuleCard>
    </div>
  );
}

// ── Без документів легально: громадянство PL / ЄС ──
const NAT_CHIP_VALUES = [{ value: "eu", label: "усі країни ЄС/ЄЕЗ" }, ...NATIONALITIES.map(n => ({ value: n.value, label: `${n.flag} ${n.label}` }))];
function NatChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  const [pick, setPick] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map(v => (
        <span key={v} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
          {v === "eu" ? t(NAT_GROUP_LABEL.eu ?? "усі країни ЄС/ЄЕЗ") : (NAT_CHIP_VALUES.find(x => x.value === v)?.label ?? v)}
          <button type="button" onClick={() => onChange(value.filter(x => x !== v))} className="text-slate-400 hover:text-rose-600">×</button>
        </span>
      ))}
      <Select value={pick} onChange={e => { if (e.target.value) { onChange([...value, e.target.value]); setPick(""); } }} className="w-44 py-1 text-xs">
        <option value="">{t("+ додати")}</option>
        {NAT_CHIP_VALUES.filter(x => !value.includes(x.value)).map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
      </Select>
    </div>
  );
}
function CitizenshipCard({ rules, onSaved }: { rules: LegalRule[]; onSaved: () => void }) {
  const t = useT();
  const curPl = currentOf(rules, "stay.pl_citizen");
  const curEu = currentOf(rules, "stay.eu_citizen");
  const initPl = () => ((curPl?.conditions.nationalities as string[] | undefined) ?? ["poland"]);
  const initEu = () => ((curEu?.conditions.nationalities as string[] | undefined) ?? ["eu"]);
  const [pl, setPl] = useState(initPl);
  const [eu, setEu] = useState(initEu);
  useEffect(() => { setPl(initPl()); }, [curPl?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setEu(initEu()); }, [curEu?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <RuleCard title={t("Громадяни Польщі")} code="stay.pl_citizen" kind="basis_by_nationality" axis="both" rules={rules} dirty={!same(pl, initPl())} onReset={() => setPl(initPl())} onSaved={onSaved}
        hint={t("Легальне перебування і праця без жодних документів. Дає старий статус «Поляк».")}
        buildConditions={() => ({ nationalities: pl })}>
        <NatChips value={pl} onChange={setPl} />
      </RuleCard>
      <RuleCard title={t("Громадяни ЄС / ЄЕЗ")} code="stay.eu_citizen" kind="basis_by_nationality" axis="both" rules={rules} dirty={!same(eu, initEu())} onReset={() => setEu(initEu())} onSaved={onSaved}
        hint={t("Перебування і праця без zezwolenia. «Усі країни ЄС/ЄЕЗ» = Польща, Румунія, інша країна ЄС з довідника національностей.")}
        buildConditions={() => ({ nationalities: eu })}>
        <NatChips value={eu} onChange={setEu} />
      </RuleCard>
    </div>
  );
}

// ── Обов'язкові документи ──
function RequirementsCard({ rules, onSaved }: { rules: LegalRule[]; onSaved: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: types = [] } = useQuery<DocumentType[]>({ queryKey: ["document-types"], queryFn: () => get("/document-types") });
  const cur = currentOf(rules, "requirement.identity");
  const init = () => ((cur?.conditions.anyOf as string[] | undefined) ?? ["passport", "id_card_pl", "id_card_eu"]);
  const [anyOf, setAnyOf] = useState(init);
  useEffect(() => { setAnyOf(init()); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const identityTypes = types.filter(ty => ty.code && (ty.category === "identity" || anyOf.includes(ty.code)));
  const stay = currentOf(rules, "requirement.stay_non_eu");
  const work = currentOf(rules, "requirement.work_non_eu");
  const toggle = useMutation({
    mutationFn: (v: { id: number; isActive: boolean }) => patch(`/legal-rules/${v.id}`, { isActive: v.isActive }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["legal-rules"] }); onSaved(); }, onError: (e: any) => toast.error(e.message),
  });
  return (
    <RuleCard title={t("Обов'язкові документи")} code="requirement.identity" kind="requirement" axis={null} rules={rules} dirty={JSON.stringify(anyOf) !== JSON.stringify(init())} onReset={() => setAnyOf(init())} onSaved={onSaved}
      hint={t("Чого бракує кожному: посвідчення особи (один з обраних типів) і, для громадян поза ЄС, підстава перебування та підстава праці. Без них рядок світить «бракує».")}
      buildConditions={() => ({ category: "identity", anyOf })}>
      <div className="space-y-3">
        <div>
          <Label>{t("Посвідчення особи — достатньо одного з")}</Label>
          <div className="flex flex-wrap gap-2 pt-1">
            {identityTypes.map(ty => (
              <label key={ty.id} className="flex items-center gap-1.5 rounded-lg border border-slate-100 px-2 py-1 text-sm text-slate-700">
                <input type="checkbox" checked={anyOf.includes(ty.code!)} onChange={e => setAnyOf(e.target.checked ? [...anyOf, ty.code!] : anyOf.filter(c => c !== ty.code))} /> {ty.name}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-slate-700">
          {[{ r: stay, label: t("Не-ЄС: потрібна підстава перебування") }, { r: work, label: t("Не-ЄС: потрібна підстава праці") }].map(({ r, label }) => (
            <label key={label} className="flex items-center gap-1.5">
              <input type="checkbox" checked={!!r?.isActive} disabled={!r || toggle.isPending} onChange={e => r && toggle.mutate({ id: r.id, isActive: e.target.checked })} /> {label}
              {!r && <span className="text-xs text-slate-400">({t("правила немає — додай у «Додаткових»")})</span>}
            </label>
          ))}
        </div>
      </div>
    </RuleCard>
  );
}

// ── Мапа статусів (payroll.status_map поверх дефолтів коду) ──
const GROUP_BADGE: Record<string, "green" | "blue" | "amber" | "slate"> = { C_registered: "green", B_student: "blue", A_cash: "amber", N_none: "slate" };
type MapDraft = {
  studentMaxAge: string;
  statuses: { status: string; group: PayrollGroupCode; precedence: string; manualOnly: boolean }[];
  docTypes: { typeCode: string; status: string; review: boolean; requiresEmployerMatch: boolean }[];
};
function StatusMapCard({ rules, onSaved }: { rules: LegalRule[]; onSaved: () => void }) {
  const t = useT();
  const { data, isLoading } = useQuery<LegalStatusMap>({ queryKey: ["legal-status-map"], queryFn: () => get("/legalization/status-map") });
  const [showDocs, setShowDocs] = useState(false);
  const init = useMemo<MapDraft | null>(() => data ? ({
    studentMaxAge: String(data.studentMaxAge),
    statuses: data.statuses.map(s => ({ status: s.status, group: s.group, precedence: String(s.precedence), manualOnly: s.manualOnly })),
    docTypes: data.docTypes.map(d => ({ typeCode: d.typeCode, status: d.status ?? "", review: d.review, requiresEmployerMatch: d.requiresEmployerMatch })),
  }) : null, [data]);
  const [v, setV] = useState<MapDraft | null>(null);
  useEffect(() => { setV(init); }, [init]);
  if (isLoading || !data || !v) return <Card className="p-4"><Spinner /></Card>;
  const dirty = JSON.stringify(v) !== JSON.stringify(init);
  const groupLabel = (code: string) => t(data.groups.find(g => g.code === code)?.label ?? code);
  const groupOfStatus = (status: string) => v.statuses.find(s => s.status === status)?.group ?? "C_registered";
  const setStatus = (i: number, p: Partial<MapDraft["statuses"][number]>) => setV({ ...v, statuses: v.statuses.map((s, k) => k === i ? { ...s, ...p } : s) });
  const setDoc = (i: number, p: Partial<MapDraft["docTypes"][number]>) => setV({ ...v, docTypes: v.docTypes.map((d, k) => k === i ? { ...d, ...p } : d) });
  return (
    <RuleCard title={t("Мапа статусів: група виплат ↔ статус ↔ документи")} code="payroll.status_map" kind="global" axis={null} rules={rules} dirty={dirty} onReset={() => setV(init)} onSaved={onSaved}
      hint={t("Якщо в людини є підтверджені документи — статус і група виплат виводяться з них за цією мапою; інакше береться статус зі старого блоку профілю. Довідка студента/учня + вік до межі → «Студент» (усе на konto), сильніше за інші підстави. Ані статусу, ані документів → «Не зголошений» (готівка).")}
      buildConditions={() => ({
        studentMaxAge: Number(v.studentMaxAge) || 26,
        statuses: v.statuses.map(s => ({ status: s.status, group: s.group, precedence: Number(s.precedence) || 0, manualOnly: s.manualOnly })),
        docTypes: v.docTypes.map(d => ({ typeCode: d.typeCode, status: d.status || null, group: d.status ? groupOfStatus(d.status) : "C_registered", review: d.review, requiresEmployerMatch: d.requiresEmployerMatch })),
      })}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {data.groups.map(g => (
            <div key={g.code} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5 text-xs">
              <Badge color={GROUP_BADGE[g.code] ?? "slate"}>{t(g.label)}</Badge>
              <span className="text-slate-500">{t(g.money)}</span>
            </div>
          ))}
          <div className="flex items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1 text-xs">
            <span className="text-slate-500">{t("Студент — до якого віку")}</span>
            <Input value={v.studentMaxAge} onChange={e => setV({ ...v, studentMaxAge: e.target.value })} className="w-16 py-0.5 text-xs" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="py-1 pr-3 font-semibold">{t("Старий статус")}</th>
                <th className="py-1 pr-3 font-semibold">{t("Група виплат")}</th>
                <th className="py-1 pr-3 font-semibold">{t("Пріоритет")}</th>
                <th className="py-1 pr-3 font-semibold">{t("Лише вручну")}</th>
                <th className="py-1 pr-3 font-semibold">{t("Виводиться з документів")}</th>
              </tr>
            </thead>
            <tbody>
              {v.statuses.map((s, i) => {
                const meta = data.statuses.find(x => x.status === s.status);
                return (
                  <tr key={s.status} className="border-t border-slate-50 align-middle">
                    <td className="py-1 pr-3 whitespace-nowrap font-medium text-slate-700" title={meta?.note ? t(meta.note) : undefined}>{t(LEGAL_LABEL[s.status as LegalStatus] ?? s.status)}</td>
                    <td className="py-1 pr-3">
                      <Select value={s.group} onChange={e => setStatus(i, { group: e.target.value as PayrollGroupCode })} className="w-40 py-1 text-xs">
                        {data.groups.map(g => <option key={g.code} value={g.code}>{t(g.label)}</option>)}
                      </Select>
                    </td>
                    <td className="py-1 pr-3"><Input value={s.precedence} onChange={e => setStatus(i, { precedence: e.target.value })} className="w-16 py-1 text-xs" disabled={s.manualOnly} /></td>
                    <td className="py-1 pr-3"><input type="checkbox" checked={s.manualOnly} onChange={e => setStatus(i, { manualOnly: e.target.checked })} /></td>
                    <td className="py-1 pr-3 text-xs text-slate-500">
                      {s.manualOnly ? <span className="text-amber-600">{t("лише вручну")}</span>
                        : v.docTypes.filter(d => d.status === s.status).map(d => data.docTypes.find(x => x.typeCode === d.typeCode)?.name ?? d.typeCode).join(", ")
                          || (meta?.docTypes.length === 0 && s.status === "polak" ? t("громадянство з профілю") : s.status === "oczekuje" ? t("справа в toku або нічого немає") : "—")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="pt-1 text-[11px] text-slate-400">{t("Пріоритет — коли документи дають кілька статусів однієї групи: береться менший номер. «Студент» перемагає завжди, якщо вік до межі.")}</p>
        </div>
        <button type="button" onClick={() => setShowDocs(x => !x)} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700">
          {showDocs ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} {t("Який документ який статус дає")} ({v.docTypes.length})
        </button>
        {showDocs && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="py-1 pr-3 font-semibold">{t("Документ")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("Дає статус")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("Група виплат")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("Потребує перевірки")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("Лише на нашу фірму")}</th>
                </tr>
              </thead>
              <tbody>
                {v.docTypes.map((d, i) => {
                  const meta = data.docTypes.find(x => x.typeCode === d.typeCode);
                  return (
                    <tr key={d.typeCode} className="border-t border-slate-50 align-middle">
                      <td className="py-1 pr-3 text-slate-700" title={meta?.condition ? t(meta.condition) : undefined}>{meta?.name ?? d.typeCode}{meta && !meta.inCatalog && <span className="ml-1 text-[10px] text-rose-500">{t("немає в каталозі")}</span>}</td>
                      <td className="py-1 pr-3">
                        <Select value={d.status} onChange={e => setDoc(i, { status: e.target.value })} className="w-48 py-1 text-xs">
                          <option value="">{t("— без відповідника")}</option>
                          {LEGAL_STATUSES.map(s => <option key={s} value={s}>{t(LEGAL_LABEL[s])}</option>)}
                        </Select>
                      </td>
                      <td className="py-1 pr-3"><Badge color={GROUP_BADGE[d.status ? groupOfStatus(d.status) : "C_registered"] ?? "slate"}>{groupLabel(d.status ? groupOfStatus(d.status) : "C_registered")}</Badge></td>
                      <td className="py-1 pr-3"><input type="checkbox" checked={d.review} onChange={e => setDoc(i, { review: e.target.checked })} /></td>
                      <td className="py-1 pr-3"><input type="checkbox" checked={d.requiresEmployerMatch} onChange={e => setDoc(i, { requiresEmployerMatch: e.target.checked })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </RuleCard>
  );
}

// ── Історія / додаткові правила (старий рядок і JSON-модалка) ──
function RuleGroup({ code, versions, onNewVersion }: { code: string; versions: LegalRule[]; onNewVersion: (r: LegalRule) => void }) {
  const t = useT();
  const [showOld, setShowOld] = useState(false);
  const current = currentOf(versions, code) ?? versions[0]!;
  const old = versions.filter(r => r.id !== current.id);
  return (
    <Card className="overflow-hidden">
      <RuleRow r={current} isCurrent onNewVersion={() => onNewVersion(current)} />
      {old.length > 0 && (
        <>
          <button onClick={() => setShowOld(v => !v)} className="flex w-full items-center gap-1.5 border-t border-slate-100 px-3 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-50">
            <History className="h-3.5 w-3.5" /> {showOld ? t("Сховати старі версії") : t("Старі версії")} ({old.length})
          </button>
          {showOld && old.map(r => <RuleRow key={r.id} r={r} onNewVersion={() => onNewVersion(r)} />)}
        </>
      )}
    </Card>
  );
}

function RuleRow({ r, isCurrent, onNewVersion }: { r: LegalRule; isCurrent?: boolean; onNewVersion?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [note, setNote] = useState(r.note ?? "");
  const inv = () => qc.invalidateQueries({ queryKey: ["legal-rules"] });
  const patchRule = useMutation({ mutationFn: (p: any) => patch(`/legal-rules/${r.id}`, p), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  return (
    <div className={`flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-slate-100 px-3 py-2 text-sm ${isCurrent ? "" : "bg-slate-50/60 text-slate-500"}`}>
      <div className="min-w-0">
        <div className="font-mono text-xs font-semibold text-slate-700">{r.code}</div>
        <div className="text-xs text-slate-400">{t(RULE_KIND_LABEL[r.kind])} · {t(RULE_AXIS_LABEL[r.axis ?? "none"] ?? r.axis ?? "—")}</div>
      </div>
      <code className="min-w-0 flex-1 truncate rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600" title={JSON.stringify(r.conditions)}>{JSON.stringify(r.conditions)}</code>
      <div className="shrink-0 text-xs text-slate-500">{r.effectiveFrom} → {r.effectiveTo ?? t("чинне")}</div>
      <div className="shrink-0 text-xs">
        {r.source ? (/^https?:\/\//.test(r.source) ? <a href={r.source} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{t("джерело")}</a> : <span className="text-slate-500">{r.source}</span>) : <span className="text-slate-300">—</span>}
      </div>
      <div className="shrink-0">
        {r.verifiedAt ? (
          <button onClick={() => patchRule.mutate({ verified: false })} className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100" title={t("Зняти підтвердження")}>
            <Check className="h-3 w-3" /> {new Date(r.verifiedAt).toLocaleDateString()}
          </button>
        ) : (
          <button onClick={() => patchRule.mutate({ verified: true })} className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100">
            <ShieldQuestion className="h-3 w-3" /> {t("не перевірено — Підтвердити")}
          </button>
        )}
      </div>
      <Input value={note} onChange={e => setNote(e.target.value)} onBlur={() => note !== (r.note ?? "") && patchRule.mutate({ note: note.trim() || null })}
        placeholder={t("примітка")} className="w-40 py-1 text-xs" />
      <label className="flex shrink-0 items-center gap-1 text-xs text-slate-500">
        <input type="checkbox" checked={r.isActive} onChange={e => patchRule.mutate({ isActive: e.target.checked })} /> {t("активне")}
      </label>
      {onNewVersion && <Button variant="secondary" className="ml-auto shrink-0 px-2 py-1 text-xs" onClick={onNewVersion}>{t("Нова версія")}</Button>}
    </div>
  );
}

function RuleModal({ mode, rule, onClose, onSaved }: { mode: "newRule" | "newVersion"; rule: LegalRule | undefined; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [code, setCode] = useState(rule?.code ?? "");
  const [kind, setKind] = useState<LegalRule["kind"]>(rule?.kind ?? "requirement");
  const [axis, setAxis] = useState<string>(rule?.axis ?? "none");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [conditions, setConditions] = useState(JSON.stringify(rule?.conditions ?? {}, null, 2));
  const [source, setSource] = useState(rule?.source ?? "");
  const [note, setNote] = useState("");
  const [verified, setVerified] = useState(false);
  const create = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try { parsed = JSON.parse(conditions); } catch { throw new Error(t("Умови — некоректний JSON")); }
      return post("/legal-rules", {
        code: code.trim(), kind, axis: axis === "none" ? null : axis, conditions: parsed,
        effectiveFrom, effectiveTo: effectiveTo || undefined, source: source.trim() || undefined, note: note.trim() || undefined, verified,
      });
    },
    onSuccess: () => { toast.success(t("Версію збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={mode === "newVersion" ? t("Нова версія — {code}", { code }) : t("Нове правило")}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>{t("Код (група.назва)")}</Label>
            <Input value={code} onChange={e => setCode(e.target.value)} placeholder="stay.pl_citizen" disabled={mode === "newVersion"} />
          </div>
          <div>
            <Label>{t("Вид")}</Label>
            <Select value={kind} onChange={e => setKind(e.target.value as LegalRule["kind"])} disabled={mode === "newVersion"}>
              {(Object.keys(RULE_KIND_LABEL) as LegalRule["kind"][]).map(k => <option key={k} value={k}>{t(RULE_KIND_LABEL[k])}</option>)}
            </Select>
          </div>
        </div>
        <div>
          <Label>{t("Вісь")}</Label>
          <Select value={axis} onChange={e => setAxis(e.target.value)} className="w-40">
            {["none", "stay", "work", "both"].map(a => <option key={a} value={a}>{t(RULE_AXIS_LABEL[a]!)}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{t("Діє з")}</Label><Input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></div>
          <div><Label>{t("Діє до (необов'язково)")}</Label><Input type="date" value={effectiveTo} onChange={e => setEffectiveTo(e.target.value)} /></div>
        </div>
        <div>
          <Label>{t("Умови (JSON)")}</Label>
          <Textarea value={conditions} onChange={e => setConditions(e.target.value)} rows={6} className="font-mono text-xs" />
        </div>
        <div><Label>{t("Джерело (URL або назва акта)")}</Label><Input value={source} onChange={e => setSource(e.target.value)} /></div>
        <div><Label>{t("Примітка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} /></div>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} /> {t("перевірено")}
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={create.isPending} disabled={!code.trim()} onClick={() => create.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

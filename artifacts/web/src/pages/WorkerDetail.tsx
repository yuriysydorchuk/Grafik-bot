import { useEffect, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Factory as FactoryIcon, Send, Clock, CalendarCheck, UserX, Activity, Gift,
  FileText, Plus, Pencil, Trash2, ExternalLink, AlertTriangle, Briefcase, Users, Upload, Car, Cake, IdCard, Wallet, BadgePlus, History, Home, KeyRound, Shirt, ShieldCheck, FileSignature, ChevronDown, ChevronUp, ChevronRight, Ban, Eye, Scale, RefreshCw, XCircle
} from "lucide-react";
import { ProfileChangeModal, CHANGE_FIELD_LABEL, PAYOUT_PREF_LABEL, fmtVal, type RequestChange } from "../components/ProfileChangeModal";
import { DocumentAuditModal } from "../components/DocumentAuditModal";
import { can } from "../lib/roles";
import { LEGAL_STATUSES, LEGAL_LABEL, LEGAL_BADGE, type LegalStatus } from "../lib/legalStatus";
import {
  get, post, put, patch, del, upload,
  type DocumentType, type WorkerDocument, type Worker, type Factory, type Company, type Gender,
  type WorkerLegality, type LegalityReason, type CaseStatus,
} from "../lib/api";
import {
  LEGALITY_LABEL, LEGALITY_BADGE, LEGALITY_DOT, AXIS_LABEL, CASE_STATUS_LABEL, DOC_CATEGORY_LABEL,
  MISMATCH_LABEL, REQUIRED_MISSING_LABEL, reasonText, daysUntil,
} from "../lib/legality";
import { Button, Card, Spinner, Badge, Empty, Modal, Input, Select, Label, SearchableSelect, Textarea } from "../components/ui";
import { WorkerModal } from "../components/WorkerModal";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { badgeClass, dotClass, genderIcon, genderClass } from "../lib/colors";
import { NatFlag, NATIONALITIES } from "../lib/nationality";
import { useClothingTypes } from "../lib/clothingTypes";
import { docTypeIcon } from "../lib/docTypeIcons";
import { TAX_OFFICES } from "../lib/taxOffices";
import { NFZ_BRANCHES } from "../lib/nfzBranches";

type BadaniaEntry = { id: number; amount: number; enteredAt: string; deducted: boolean; deductedAt: string | null; note: string | null };

interface WorkerProfile {
  id: number; fullName: string; workerCode: string | null; telegramId: string | null;
  factoryId: number | null; factoryName: string | null; companyId: number | null; companyName: string | null;
  positionId: number | null; positionName: string | null; positionColor: string | null;
  gender: string | null; fixedShift: string | null; selfTransport: boolean;
  selfTransportSince?: string | null;
  gratyfikantName?: string | null; pesel?: string | null; middleName?: string | null; firstName?: string | null; lastName?: string | null;
  badania?: BadaniaEntry[];
  nationality?: string | null;
  status: string; isActive: boolean; createdAt: string; firedAt: string | null; language: string | null;
  hourlyRate?: number; hourlyRateNetto?: number | null; positionRate?: number | null; effectiveRate?: number; isStudent?: boolean; under26?: boolean;
  birthDate?: string | null; legalStatus?: string | null; notifyHours?: number | null;
  employmentStartDate?: string | null;
  factoryCodes?: { factoryId: number; factoryName: string | null; code: string }[]; // ключі фабрик (Nr Osobowy); ведуться в Обліку годин → «🔑 Ключі»
  agramFactory?: boolean; agramStazBonus?: boolean; agramCashBonus?: boolean;
  cashBonusFactory?: boolean; // не-Agram бонусна фабрика (LST): лише нал-бонус
  note?: string | null; payoutPrefKind?: string | null; payoutPrefValue?: number | null;
  stats: { month: string; monthShifts: number; monthHours: number; monthAbsent: number; totalShifts: number; totalHours: number; totalAbsent: number; reliability: number | null; referralCount: number };
  factoryHistory: { factoryId: number | null; factoryName: string | null; shifts: number; hours: number; absent: number; firstDate: string; lastDate: string }[];
  recent: { date: string | null; factoryName: string | null; shift: string; status: string; hours: number }[];
}

// Компактний стат-тайл: сітка з gap-px на слейт-фоні дає волосяні розділювачі
// при будь-якому переносі рядів (divide-x/y ламаються на брейкпойнтах)
function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "rose" | "emerald" }) {
  return (
    <div className="min-w-0 bg-white px-3.5 py-2.5">
      <div className="truncate text-[11px] text-slate-400" title={label}>{label}</div>
      <div className={`mt-0.5 text-lg font-bold leading-6 tabular-nums ${tone === "rose" ? "text-rose-600" : tone === "emerald" ? "text-emerald-600" : "text-slate-800"}`}>
        {value}{sub && <span className="ml-1 text-xs font-normal text-slate-400">{sub}</span>}
      </div>
    </div>
  );
}

// Секція профілю: тонкий заголовок; без даних — один рядок тексту замість
// повнорозмірної заглушки (сторінка з порожніми блоками лишається компактною).
// Розгорнуто за замовчуванням (стара поведінка — 02.09.2026 власник відкотив
// суцільний акордеон, «виглядає по дибільному»; акордеон лишається доступним
// per-секційно через defaultOpen/шеврон, якщо колись знадобиться вибірково).
function Section({ icon: Icon, title, extra, action, empty, children, defaultOpen = true, summary }: {
  icon?: any; title: string; extra?: React.ReactNode; action?: React.ReactNode; empty?: string; children: React.ReactNode | null;
  defaultOpen?: boolean; summary?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="overflow-hidden">
      <div className={`flex flex-wrap items-center gap-2 px-5 py-2.5 ${open ? "border-b border-slate-100" : ""}`}>
        <button type="button" onClick={() => setOpen(o => !o)} className="flex min-w-0 items-center gap-1.5 text-left">
          {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
          {Icon && <Icon className="h-4 w-4 shrink-0 text-slate-400" />}
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        </button>
        {extra}
        {!open && summary && <span className="truncate text-xs text-slate-400">{summary}</span>}
        {action && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {open && (children ?? <div className="px-5 py-2 text-sm text-slate-400">{empty}</div>)}
    </Card>
  );
}

// Група полів інфо-картки з підзаголовком
function InfoGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 px-5 py-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      <div className="divide-y divide-slate-50">{children}</div>
    </div>
  );
}

export default function WorkerDetail() {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const isOwner = me?.role === "owner";
  const [, params] = useRoute("/workers/:id");
  const id = params?.id;
  const { data: w, isLoading, isError } = useQuery<WorkerProfile>({ queryKey: ["worker", id], queryFn: () => get(`/workers/${id}`), enabled: !!id });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const { data: positions = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["positions"], queryFn: () => get("/positions") });
  const [editing, setEditing] = useState(false);
  // інлайн-редагування прямо з профілю (без модалки «Редагувати»)
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const wpatch = useMutation({
    mutationFn: (p: Record<string, unknown>) => patch(`/workers/${id}`, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker", id] }); qc.invalidateQueries({ queryKey: ["workers"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  // зміна з датою набуття: свод-релевантні поля відкривають модалку «від коли +
  // що зачепить» замість прямого PATCH (лише для користувачів з cap svodni)
  const canSvodni = can(me, "svodni");
  const [pendingChange, setPendingChange] = useState<{ changes: Record<string, unknown>; title: string; from?: string } | null>(null);
  const requestChange = canSvodni ? (changes: Record<string, unknown>, title: string, from?: string) => setPendingChange({ changes, title, from }) : undefined;

  if (isLoading) return <Spinner />;
  if (isError || !w) return <Empty>{t("Працівника не знайдено")}</Empty>;

  // Shape the profile into the Worker form the shared modal expects.
  const workerForEdit: Worker = {
    id: w.id, fullName: w.fullName, workerCode: w.workerCode, telegramId: w.telegramId,
    factoryId: w.factoryId, factoryName: w.factoryName, companyId: w.companyId, companyName: w.companyName,
    positionId: w.positionId, positionName: w.positionName, positionColor: w.positionColor,
    gender: (w.gender as Gender | null) ?? null, fixedShift: w.fixedShift, selfTransport: w.selfTransport,
    selfTransportSince: w.selfTransportSince ?? null, nationality: w.nationality ?? null,
    gratyfikantName: w.gratyfikantName ?? null, pesel: w.pesel ?? null, middleName: w.middleName ?? null,
    status: w.status, isActive: w.isActive, language: w.language,
    hourlyRate: w.hourlyRate, isStudent: w.isStudent, under26: w.under26,
  };

  const st = w.stats;
  // опції посад для інлайн-селекта: фабрика з посадами → її список, інакше каталог
  const selFactory = factories.find(f => f.id === w.factoryId);
  const posOptions = ((selFactory?.usesPositions && (selFactory.positions?.length ?? 0) > 0 ? selFactory!.positions! : positions) as { id: number; name: string }[])
    .map(p => ({ value: String(p.id), label: p.name }));
  const statusBadge = (s: string) =>
    s === "present" ? <Badge color="green">{t("вийшов")}</Badge>
    : s === "absent" ? <Badge color="rose">{t("не вийшов")}</Badge>
    : <Badge color="slate">{t("заплановано")}</Badge>;

  return (
    <>
      <Link href="/workers" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" /> {t("До працівників")}</Link>

      {/* Єдина шапка-картка: ідентичність + лічильники текстом + групи полів.
          Всі поля редагуються інлайн; свод-релевантні (посада/ставка/студент,
          як у WorkerModal) для користувачів з cap svodni ідуть через модалку «Діє з» */}
      <Card className="mb-5 overflow-hidden p-0">
        <div className="flex flex-wrap items-start gap-3 px-5 py-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-100 text-lg font-bold text-red-700">
            {w.fullName?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold tracking-tight text-slate-800">
              {renaming ? (
                <span className="flex items-center gap-1.5">
                  <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { const v = nameDraft.trim(); if (v && v !== w.fullName) wpatch.mutate({ fullName: v }); setRenaming(false); }
                      if (e.key === "Escape") setRenaming(false);
                    }}
                    className="rounded-lg border border-slate-300 px-2 py-0.5 text-lg font-semibold text-slate-800 focus:border-red-400 focus:outline-none" />
                  <button className="text-xs font-medium text-emerald-600" onClick={() => { const v = nameDraft.trim(); if (v && v !== w.fullName) wpatch.mutate({ fullName: v }); setRenaming(false); }}>{t("Зберегти")}</button>
                  <button className="text-xs text-slate-400" onClick={() => setRenaming(false)}>{t("Скасувати")}</button>
                </span>
              ) : (
                <button className="group inline-flex items-center gap-1.5 text-left" title={t("Перейменувати")}
                  onClick={() => { setNameDraft(w.fullName); setRenaming(true); }}>
                  {w.fullName}
                  <Pencil className="h-3.5 w-3.5 text-slate-300 opacity-0 transition group-hover:opacity-100" />
                </button>
              )}
              <NatFlag value={w.nationality} className="cursor-default text-lg" />
              <span className={`text-lg font-semibold ${genderClass(w.gender)}`} title={t("Стать")}>
                <select value={w.gender ?? ""} onChange={e => wpatch.mutate({ gender: e.target.value || null })}
                  className="w-6 cursor-pointer appearance-none border-0 bg-transparent text-center font-semibold focus:outline-none">
                  <option value="">—</option>
                  <option value="male">{genderIcon("male")}</option>
                  <option value="female">{genderIcon("female")}</option>
                </select>
              </span>
              {!w.isActive && <Badge color="rose">{t("звільнений")}</Badge>}
            </h1>
            {/* Фірма/фабрика/посада — редаговані прямо тут (badge-select), щоб
                не дублювати те саме ще й рядками в групі «Робота» нижче. */}
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              {w.workerCode && <span className="font-mono">{w.workerCode}</span>}
              {w.positionName && <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass(w.positionColor ?? "slate")}`}><span className={`h-1.5 w-1.5 rounded-full ${dotClass(w.positionColor ?? "slate")}`} />{w.positionName}</span>}
              <InlineBadgeSelect value={w.companyId != null ? String(w.companyId) : ""} color="blue" none={t("— без фірми —")}
                onChange={v => wpatch.mutate({ companyId: v ? Number(v) : null })}
                options={companies.map(c => ({ value: String(c.id), label: c.name }))} />
              <InlineBadgeSelect value={w.factoryId != null ? String(w.factoryId) : ""} color="red" none={t("— без фабрики —")}
                onChange={v => wpatch.mutate({ factoryId: v ? Number(v) : null })}
                options={factories.map(f => ({ value: String(f.id), label: f.name }))} />
            </div>
            {/* лічильники — текстовим рядком замість окремої стрічки тайлів */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
              <span>{t("цей місяць")}: <b className="font-semibold text-slate-700">{st.monthShifts}</b> {t("зм")} · <b className="font-semibold text-slate-700">{st.monthHours}</b> {t("год")}</span>
              <span className="text-slate-300">|</span>
              <span>{t("всього")}: <b className="font-semibold text-slate-700">{st.totalShifts}</b> {t("зм")} · <b className="font-semibold text-slate-700">{st.totalHours}</b> {t("год")}</span>
              <span className="text-slate-300">|</span>
              <span>{t("надійність")} <b className={`font-semibold ${st.reliability != null && st.reliability >= 90 ? "text-emerald-600" : "text-slate-700"}`}>{st.reliability != null ? `${st.reliability}%` : "—"}</b></span>
              <span className="text-slate-300">|</span>
              <span>{t("невиходи")} <b className={`font-semibold ${st.totalAbsent > 0 ? "text-rose-600" : "text-slate-700"}`}>{st.totalAbsent}</b></span>
              <span className="text-slate-300">|</span>
              <span>{t("запросив друзів")}: <b className="font-semibold text-slate-700">{st.referralCount}</b></span>
            </div>
          </div>
          <Button variant="secondary" className="ml-auto shrink-0" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> {t("Редагувати")}</Button>
        </div>

        <div className="grid grid-cols-1 divide-y divide-slate-100 border-t border-slate-100 md:grid-cols-3 md:divide-x md:divide-y-0">
          <InfoGroup title={t("Робота")}>
            <InfoRow icon={Briefcase} label={t("Посада")}>
              <InlineSelect value={w.positionId != null ? String(w.positionId) : ""}
                onChange={v => { const p = v ? Number(v) : null; if (requestChange) requestChange({ positionId: p }, t("Посада")); else wpatch.mutate({ positionId: p }); }}
                options={posOptions} />
            </InfoRow>
            <InfoRow icon={CalendarCheck} label={t("Закріплена зміна")}>
              <InlineSelect value={w.fixedShift ?? ""} none={t("— немає —")} onChange={v => wpatch.mutate({ fixedShift: v || null })}
                options={["1", "2", "3"].map(s => ({ value: s, label: t("{n} зміна", { n: s }) }))} />
            </InfoRow>
            <InfoRow icon={Car} label={t("Транспорт")}>
              <InlineSelect value={w.selfTransport ? "self" : ""} none={t("Возить фірма")} onChange={v => wpatch.mutate({ selfTransport: v === "self" })}
                options={[{ value: "self", label: t("Доїжджає сам") }]} />
              {w.selfTransport && (
                <input type="date" value={w.selfTransportSince ?? ""} title={t("з")}
                  onChange={e => wpatch.mutate({ selfTransportSince: e.target.value || null })}
                  className="rounded border border-slate-200 px-1 py-0.5 text-xs text-slate-500" />
              )}
            </InfoRow>
            {(w.factoryCodes ?? []).length > 0 && (
              <Info icon={KeyRound} label={t("Ключі фабрики")}
                value={w.factoryCodes!.map(c => `${c.code}${c.factoryName ? ` (${c.factoryName})` : ""}`).join(", ")} />
            )}
            {/* Дата працевлаштування й поріг «нагадати про години» — про роботу
                й графік, не про гроші; перенесено з «Фінанси» для балансу колонок. */}
            <EmploymentDateRow workerId={w.id} date={w.employmentStartDate ?? null} readOnly={w.payoutPrefKind === undefined} onRequest={requestChange} />
            <NotifyHoursRow workerId={w.id} notifyHours={w.notifyHours ?? null} onRequest={requestChange} />
          </InfoGroup>
          <InfoGroup title={t("Особисте")}>
            <BirthDateRow workerId={w.id} birthDate={w.birthDate ?? null} under26Fallback={w.under26 ?? null} onRequest={requestChange} />
            {/* Порожні PESEL/друге ім'я — не показуємо рядок (менше інфи в профілі);
                заповнити все одно можна через «Редагувати» (WorkerModal). */}
            {w.pesel && (
              <InfoRow icon={KeyRound} label="PESEL">
                <InlineText value={w.pesel} placeholder={t("вказати")} width="w-32" onSave={v => wpatch.mutate({ pesel: v.trim() || null })} />
              </InfoRow>
            )}
            {w.middleName && (
              <InfoRow icon={IdCard} label={t("Друге ім'я")}>
                <InlineText value={w.middleName} placeholder={t("необов'язково")} width="w-32" onSave={v => wpatch.mutate({ middleName: v.trim() || null })} />
              </InfoRow>
            )}
            <LegalStatusRow workerId={w.id} legalStatus={(w.legalStatus as LegalStatus | null) ?? null} onRequest={requestChange} />
            <InfoRow icon={Users} label={t("Національність")}>
              <InlineSelect value={w.nationality ?? ""} onChange={v => wpatch.mutate({ nationality: v || null })}
                options={NATIONALITIES.map(n => ({ value: n.value, label: `${n.flag} ${t(n.label)}` }))} />
            </InfoRow>
            <InfoRow icon={Send} label="Telegram">
              <InlineText value={w.telegramId ?? ""} placeholder={t("не приєднаний")} width="w-32" onSave={v => wpatch.mutate({ telegramId: v.trim() || null })} />
            </InfoRow>
            <Info icon={CalendarCheck} label={t("Додано")} value={new Date(w.createdAt).toLocaleDateString("uk-UA")} />
          </InfoGroup>
          <InfoGroup title={t("Фінанси й облік")}>
            {isOwner ? (
              <>
                <InfoRow icon={Clock} label={t("Ставка")}>
                  <InlineText value={w.hourlyRate != null ? String(w.hourlyRate) : ""} placeholder={t("авто")} width="w-20"
                    onSave={v => {
                      const r = v.trim() === "" ? null : Number(v.replace(",", "."));
                      // підняття/зміна ставки — через «Діє з» (як WorkerModal); очищення до «авто» двигун не приймає → голий PATCH
                      if (requestChange && r != null && r !== (w.hourlyRate ?? null)) requestChange({ hourlyRate: r }, t("Ставка брутто"));
                      else wpatch.mutate({ hourlyRate: r });
                    }} />
                  <span className="text-xs font-normal text-slate-400">
                    {w.hourlyRate == null && `${t("авто")}${w.effectiveRate != null ? ` ${w.effectiveRate}` : ""} `}
                    zł/{t("год")}{w.positionRate != null ? ` · ${t("за посадою")}` : ""}{w.under26 ? " · <26" : ""}
                  </span>
                </InfoRow>
                <InfoRow icon={IdCard} label={t("Студент")}>
                  <input type="checkbox" checked={!!w.isStudent}
                    onChange={e => { if (requestChange) requestChange({ isStudent: e.target.checked }, t("Студент")); else wpatch.mutate({ isStudent: e.target.checked }); }} />
                </InfoRow>
              </>
            ) : (
              (w.hourlyRate != null || w.effectiveRate != null) && <Info icon={Clock} label={t("Ставка")} value={`${w.effectiveRate ?? w.hourlyRate} zł/${t("год")}${w.hourlyRate == null ? " · " + t("авто") : ""}${w.positionRate != null ? " · " + t("за посадою") : ""}${w.isStudent ? " · " + t("Студент") : ""}${w.under26 ? " · <26" : ""}`} />
            )}
            {w.payoutPrefKind !== undefined && (
              <PayoutPrefRow workerId={w.id} kind={w.payoutPrefKind ?? null} value={w.payoutPrefValue ?? null} onRequest={requestChange} />
            )}
            {(w.agramFactory || w.cashBonusFactory) && (
              <AgramBonusRow workerId={w.id} staz={!!w.agramStazBonus} cash={!!w.agramCashBonus} startDate={w.employmentStartDate ?? null} cashOnly={!w.agramFactory} onRequest={requestChange} />
            )}
            <BadaniaRow workerId={w.id} entries={w.badania ?? []} />
            {w.gratyfikantName && (
              <InfoRow icon={Briefcase} label={t("Імʼя в Gratyfikancie")}>
                <InlineText value={w.gratyfikantName} placeholder={t("вказати")} width="w-44" onSave={v => wpatch.mutate({ gratyfikantName: v.trim() || null })} />
              </InfoRow>
            )}
          </InfoGroup>
        </div>
        {w.note !== undefined && <NoteBlock workerId={w.id} note={w.note ?? null} />}
      </Card>

      {/* Секції у дві колонки на широких екранах: ліворуч — активність, праворуч — облікові блоки */}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <div className="min-w-0 space-y-5">
          {/* Employment history per factory (transfers / re-hires keep old factories visible) */}
          {(w.factoryHistory?.length ?? 0) > 0 && (
            <Section icon={FactoryIcon} title={t("Історія по фабриках")} summary={t("{n} фабрик", { n: w.factoryHistory.length })}>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                  <tr><th className="px-4 py-2">{t("Фабрика")}</th><th className="px-4 py-2">{t("Період")}</th><th className="px-4 py-2 text-center">{t("Зміни")}</th><th className="px-4 py-2 text-right">{t("Години")}</th><th className="px-4 py-2 text-right">{t("Невиходи")}</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {w.factoryHistory.map((f, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-4 py-1.5 font-medium text-slate-700">
                        {f.factoryName ?? t("Без фабрики")}
                        {f.factoryId != null && f.factoryId === w.factoryId && <span className="ml-2"><Badge color="green">{t("поточна")}</Badge></span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-1.5 text-slate-500">{f.firstDate} — {f.lastDate}</td>
                      <td className="px-4 py-1.5 text-center text-slate-600">{f.shifts}</td>
                      <td className="px-4 py-1.5 text-right font-medium text-emerald-700">{f.hours} {t("год")}</td>
                      <td className="px-4 py-1.5 text-right text-slate-600">{f.absent || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Section>
          )}

          {/* Recent shifts */}
          <Section icon={CalendarCheck} title={t("Останні зміни")} empty={t("Немає відпрацьованих змін")}
            summary={w.recent[0]?.date ? t("останнє {d}", { d: w.recent[0].date }) : undefined}>
            {!w.recent.length ? null : (
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-400">
                    <tr><th className="px-4 py-2">{t("Дата")}</th><th className="px-4 py-2">{t("Фабрика")}</th><th className="px-4 py-2">{t("Зміна")}</th><th className="px-4 py-2">{t("Статус")}</th><th className="px-4 py-2 text-right">{t("Години")}</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {w.recent.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="whitespace-nowrap px-4 py-1.5 font-medium text-slate-700">{r.date}</td>
                        <td className="px-4 py-1.5 text-slate-500">{r.factoryName ?? "—"}</td>
                        <td className="px-4 py-1.5 text-slate-500">{r.shift} {t("зм")}</td>
                        <td className="px-4 py-1.5">{statusBadge(r.status)}</td>
                        <td className="px-4 py-1.5 text-right text-slate-600">{r.hours || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Сводна по місяцях (cap svodni; konto/готівка приходять лише з svodniSensitive) */}
          {canSvodni && <WorkerSvodni workerId={w.id} />}

          {/* Історія змін профілю (журнал з датами набуття) + видалення зміни */}
          <ChangesTimeline workerId={w.id} canUndo={canSvodni} />
        </div>

        <div className="min-w-0 space-y-5">
          {can(me, "workerDocs") && <WorkerContracts workerId={w.id} factoryId={w.factoryId} factories={factories} />}
          <WorkerLegalitySection workerId={w.id} />
          <WorkerDocuments workerId={w.id} companies={companies} />
          <WorkerBankAccounts workerId={w.id} />
          <WorkerAdvances workerId={w.id} />
          <WorkerAbsences workerId={w.id} />
          {/* Хостел: де живе і скільки платить (довідник — сторінка /hostels) */}
          {canSvodni && <WorkerHostel workerId={w.id} />}
          {/* Одяг: видане зі складу магазину, вартість/зняття, повернення */}
          <WorkerClothing workerId={w.id} />
        </div>
      </div>

      {editing && (
        <WorkerModal worker={workerForEdit} factories={factories} companies={companies} isOwner={isOwner}
          onClose={() => setEditing(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["worker", id] }); qc.invalidateQueries({ queryKey: ["workers"] }); setEditing(false); }} />
      )}
      {pendingChange && (
        <ProfileChangeModal workerId={w.id} changes={pendingChange.changes} title={pendingChange.title}
          initialFrom={pendingChange.from} onClose={() => setPendingChange(null)} />
      )}
    </>
  );
}

// Рядок інфо-картки: підпис ліворуч, значення (текст або редактор) праворуч.
// flex-wrap: широкий редактор (select, чекбокси) переноситься ПІД підпис цілим
// рядком, а не налазить на нього (переповнення justify-end вилазить уліво)
function InfoRow({ icon: Icon, label, children, title }: { icon: any; label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1 text-sm">
      <span className="flex shrink-0 items-center gap-1.5 text-slate-400"><Icon className="h-3.5 w-3.5 shrink-0" />{label}</span>
      <span className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-right font-medium text-slate-700" title={title}>{children}</span>
    </div>
  );
}
function Info({ icon, label, value }: { icon: any; label: string; value: string }) {
  return <InfoRow icon={icon} label={label} title={value}><span className="truncate">{value}</span></InfoRow>;
}

// Текстове значення «клік → інпут» для інлайн-редагування рядка інфо-картки
function InlineText({ value, placeholder, width = "w-40", onSave }: { value: string; placeholder: string; width?: string; onSave: (v: string) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => { onSave(draft); setEditing(false); };
  if (!editing) return (
    <button className="max-w-full truncate font-medium text-slate-700 hover:text-red-600" title={value || undefined}
      onClick={() => { setDraft(value); setEditing(true); }}>
      {value || <span className="font-normal text-slate-400">{placeholder}</span>}
    </button>
  );
  return (
    <span className="flex items-center gap-1">
      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className={`${width} rounded border border-slate-300 px-1 py-0.5 text-xs`} />
      <button className="text-xs font-medium text-emerald-600" onClick={commit}>{t("Зберегти")}</button>
      <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
    </span>
  );
}

// Borderless-select для інлайн-редагування (стиль — як рядок форми легалізації)
function InlineSelect({ value, options, onChange, none = "—" }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; none?: string }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="max-w-full rounded border border-transparent bg-transparent py-0.5 pr-5 text-sm font-medium text-slate-700 hover:border-slate-300 focus:border-red-400 focus:outline-none">
      <option value="">{none}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// Той самий <select>, стилізований під бейдж — щоб фірма/фабрика/стать в
// шапці-ідентичності лишались редаговані, не дублюючись ще й рядком у
// «Робота» нижче (власник 03.09.2026: бейдж уже показує значення, другий
// рядок з тим самим — зайвий).
function InlineBadgeSelect({ value, options, onChange, color, none }: {
  value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; color: "blue" | "red" | "slate"; none: string;
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className={`rounded-full border-0 px-2 py-0.5 text-xs font-medium ${badgeClass(color)} cursor-pointer focus:outline-none focus:ring-2 focus:ring-red-300`}>
      <option value="">{none}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ─── Documents ────────────────────────────────────────────────────────────────
const DOC_STATUS: Record<string, { label: string; color: "green" | "rose" | "amber" | "slate" }> = {
  present: { label: "наявний", color: "green" },
  missing: { label: "відсутній", color: "rose" },
  expired: { label: "прострочений", color: "amber" },
  pending: { label: "очікується", color: "slate" },
};
const isExpired = (iso?: string | null) => !!iso && new Date(iso + "T00:00:00").getTime() < Date.now();

type Questionnaire = {
  id: number; workerId: number; status: string;
  passportNumber: string | null; passportCountry: string | null;
  passportIssuedAt: string | null; passportExpiresAt: string | null;
  birthPlace: string | null; sex: string | null; citizenship: string | null;
  addressRegistered: string | null; addressPl: string | null; postalCode: string | null; city: string | null;
  motherName: string | null; fatherName: string | null;
  bankName: string | null; bankIban: string | null; phone: string | null; email: string | null;
  taxOffice: string | null; nfzBranch: string | null;
  isStudent: boolean; schoolName: string | null;
  hasOtherEmployment: boolean; otherEmploymentNote: string | null;
  isRegisteredUnemployed: boolean;
  emergencyContact: string | null;
  nip: string | null; pit0: boolean;
  ankietaInnyPracodawca: boolean; ankietaEmeryt: boolean; ankietaRencista: boolean;
  ankietaNiepelnosprawnosc: boolean; ankietaSkladkaChorobowa: boolean;
  taxOfficeAddress: string | null;
  regWojewodztwo: string | null; regPowiat: string | null; regGmina: string | null; regMiejscowosc: string | null;
  regUlica: string | null; regNumerDomu: string | null; regKodPocztowy: string | null;
  zamWojewodztwo: string | null; zamPowiat: string | null; zamGmina: string | null; zamMiejscowosc: string | null;
  zamUlica: string | null; zamNumerDomu: string | null; zamKodPocztowy: string | null;
  submittedAt: string | null; verifiedAt: string | null;
};
const QUESTIONNAIRE_STATUS: Record<string, { label: string; color: "slate" | "blue" | "green" }> = {
  draft: { label: "чернетка", color: "slate" },
  submitted: { label: "подано", color: "blue" },
  verified: { label: "перевірено", color: "green" },
};

// Анкета працівника (паспорт + адмін-дані umowa zlecenie) — модуль
// «Документи й підписання». Це ІНСТРУМЕНТ ЗБОРУ ДАНИХ для генератора
// документів (здебільшого заповнює сам працівник лінком з бота), не окрема
// «сторінка профілю» — тому на самому профілі лише компактний рядок зі
// статусом і кнопкою, повна форма — в модалці (рішення власника 02.09.2026).
function WorkerQuestionnaire({ workerId }: { workerId: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { data: q, isLoading } = useQuery<Questionnaire | null>({ queryKey: ["worker-questionnaire", workerId], queryFn: () => get(`/workers/${workerId}/questionnaire`) });
  const st = QUESTIONNAIRE_STATUS[q?.status ?? "draft"]!;

  return (
    <>
      <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => setOpen(true)}>
        <IdCard className="h-3.5 w-3.5" /> {t("Анкета")} {!isLoading && <Badge color={st.color}>{t(st.label)}</Badge>}
      </Button>
      {open && <QuestionnaireModal workerId={workerId} onClose={() => setOpen(false)} />}
    </>
  );
}

function QuestionnaireModal({ workerId, onClose }: { workerId: number; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: q, isLoading } = useQuery<Questionnaire | null>({ queryKey: ["worker-questionnaire", workerId], queryFn: () => get(`/workers/${workerId}/questionnaire`) });
  // Ім'я/по-батькові/прізвище — поля workersTable (той самий поділ, що в
  // routes/passportScan.ts), не анкети; той самий "worker" кеш, що на сторінці
  // профілю ["worker", id] — React Query дедублює запит.
  const { data: worker } = useQuery<{ firstName?: string | null; middleName?: string | null; lastName?: string | null }>({ queryKey: ["worker", workerId], queryFn: () => get(`/workers/${workerId}`) });
  const [form, setForm] = useState<Record<string, any>>({});
  const [name, setName] = useState({ firstName: "", middleName: "", lastName: "" });
  useEffect(() => { setForm(q ?? {}); }, [q]);
  useEffect(() => { if (worker) setName({ firstName: worker.firstName ?? "", middleName: worker.middleName ?? "", lastName: worker.lastName ?? "" }); }, [worker]);
  const inv = () => qc.invalidateQueries({ queryKey: ["worker-questionnaire", workerId] });
  const save = useMutation({
    mutationFn: () => put(`/workers/${workerId}/questionnaire`, { ...form, ...name }),
    onSuccess: () => { inv(); qc.invalidateQueries({ queryKey: ["worker", workerId] }); toast.success(t("Анкету збережено")); },
    onError: (e: any) => toast.error(e.message),
  });
  const verify = useMutation({
    mutationFn: () => post(`/workers/${workerId}/questionnaire/verify`),
    onSuccess: () => { inv(); toast.success(t("Анкету підтверджено")); },
    onError: (e: any) => toast.error(e.message),
  });
  // OCR паспорта (Document AI): фото/скан → чернетка полів анкети. Не чіпає
  // вже підтверджені (verified) дані — сервер лише додає ocrRaw для довідки.
  const scanInputRef = useRef<HTMLInputElement>(null);
  const scan = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append("file", file); return upload<{ nameDraft?: { firstName: string | null; middleName: string | null; lastName: string | null } }>(`/workers/${workerId}/passport-scan`, fd); },
    onSuccess: (r) => {
      inv();
      // Не перезаписуємо те, що вже вписано в цій сесії — лише добираємо порожнє.
      if (r.nameDraft) setName(n => ({
        firstName: n.firstName || r.nameDraft!.firstName || "",
        middleName: n.middleName || r.nameDraft!.middleName || "",
        lastName: n.lastName || r.nameDraft!.lastName || "",
      }));
      toast.success(t("Паспорт розпізнано — перевір поля анкети"));
    },
    onError: (e: any) => toast.error(e.message),
  });
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));
  const setNameField = (k: keyof typeof name) => (v: string) => setName(n => ({ ...n, [k]: v }));
  const st = QUESTIONNAIRE_STATUS[q?.status ?? "draft"]!;

  return (
    <Modal open onClose={onClose} title={t("Анкета")} size="lg">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge color={st.color}>{t(st.label)}</Badge>
        <input ref={scanInputRef} type="file" accept="image/*,application/pdf" capture="environment" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) scan.mutate(f); e.target.value = ""; }} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="secondary" className="px-2 py-1 text-xs" disabled={scan.isPending} onClick={() => scanInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" /> {t("Сканувати паспорт")}
          </Button>
          <Button variant="secondary" className="px-2 py-1 text-xs" disabled={save.isPending} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
          {q && q.status !== "verified" && (
            <Button className="px-2 py-1 text-xs" disabled={verify.isPending} onClick={() => verify.mutate()}><ShieldCheck className="h-3.5 w-3.5" /> {t("Підтвердити")}</Button>
          )}
        </div>
      </div>
      {isLoading ? <Spinner /> : (
        <div className="grid max-h-[70vh] grid-cols-1 gap-3 overflow-y-auto pb-1 sm:grid-cols-2">
          <div><Label>{t("Ім'я")}</Label><Input value={name.firstName} onChange={e => setNameField("firstName")(e.target.value)} /></div>
          <div><Label>{t("Прізвище")}</Label><Input value={name.lastName} onChange={e => setNameField("lastName")(e.target.value)} /></div>
          <div><Label>{t("Друге ім'я")}</Label><Input value={name.middleName} onChange={e => setNameField("middleName")(e.target.value)} /></div>
          <div><Label>{t("Номер паспорта")}</Label><Input value={form.passportNumber ?? ""} onChange={e => set("passportNumber", e.target.value)} /></div>
          <div><Label>{t("Країна паспорта")}</Label><Input value={form.passportCountry ?? ""} onChange={e => set("passportCountry", e.target.value)} /></div>
          <div><Label>{t("Паспорт видано")}</Label><Input type="date" value={form.passportIssuedAt ?? ""} onChange={e => set("passportIssuedAt", e.target.value)} /></div>
          <div><Label>{t("Паспорт дійсний до")}</Label><Input type="date" value={form.passportExpiresAt ?? ""} onChange={e => set("passportExpiresAt", e.target.value)} /></div>
          <div><Label>{t("Місце народження")}</Label><Input value={form.birthPlace ?? ""} onChange={e => set("birthPlace", e.target.value)} /></div>
          <div>
            <Label>{t("Стать (документ)")}</Label>
            <Select value={form.sex ?? ""} onChange={e => set("sex", e.target.value)}>
              <option value="">—</option><option value="M">{t("Чоловіча")}</option><option value="F">{t("Жіноча")}</option>
            </Select>
          </div>
          <div><Label>{t("Громадянство")}</Label><Input value={form.citizenship ?? ""} onChange={e => set("citizenship", e.target.value)} /></div>
          <div><Label>{t("Адреса в Польщі")}</Label><Input value={form.addressPl ?? ""} onChange={e => set("addressPl", e.target.value)} /></div>
          <div><Label>{t("Поштовий індекс")}</Label><Input value={form.postalCode ?? ""} onChange={e => set("postalCode", e.target.value)} placeholder="00-000" /></div>
          <div><Label>{t("Місто/gmina")}</Label><Input value={form.city ?? ""} onChange={e => set("city", e.target.value)} /></div>
          <div>
            <Label>{t("Адреса замельдування")}</Label>
            <div className="flex gap-1.5">
              <Input value={form.addressRegistered ?? ""} onChange={e => set("addressRegistered", e.target.value)} />
              <button type="button" title={t("= адреса в Польщі")} onClick={() => set("addressRegistered", form.addressPl ?? "")}
                className="shrink-0 rounded-lg border border-slate-300 px-2 text-xs text-slate-500 hover:bg-slate-50">=PL</button>
            </div>
          </div>
          <div><Label>{t("Імʼя мами")}</Label><Input value={form.motherName ?? ""} onChange={e => set("motherName", e.target.value)} /></div>
          <div><Label>{t("Імʼя тата")}</Label><Input value={form.fatherName ?? ""} onChange={e => set("fatherName", e.target.value)} /></div>
          <div><Label>{t("Банк")}</Label><Input value={form.bankName ?? ""} onChange={e => set("bankName", e.target.value)} /></div>
          <div><Label>IBAN</Label><Input value={form.bankIban ?? ""} onChange={e => set("bankIban", e.target.value)} /></div>
          <div><Label>{t("Телефон")}</Label><Input value={form.phone ?? ""} onChange={e => set("phone", e.target.value)} /></div>
          <div><Label>Email</Label><Input value={form.email ?? ""} onChange={e => set("email", e.target.value)} /></div>
          <div><Label>{t("Urząd skarbowy")}</Label><SearchableSelect value={form.taxOffice ?? ""} onChange={v => set("taxOffice", v)} options={TAX_OFFICES} /></div>
          <div><Label>NFZ</Label><SearchableSelect value={form.nfzBranch ?? ""} onChange={v => set("nfzBranch", v)} options={NFZ_BRANCHES} /></div>
          <div className="sm:col-span-2"><Label>{t("Контакт для екстрених випадків")}</Label><Input value={form.emergencyContact ?? ""} onChange={e => set("emergencyContact", e.target.value)} /></div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={!!form.isStudent} onChange={e => set("isStudent", e.target.checked)} id={`q-student-${workerId}`} />
            <label htmlFor={`q-student-${workerId}`} className="text-sm text-slate-600">{t("Студент")}</label>
          </div>
          {form.isStudent && (
            <div><Label>{t("Навчальний заклад")}</Label><Input value={form.schoolName ?? ""} onChange={e => set("schoolName", e.target.value)} /></div>
          )}
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={!!form.hasOtherEmployment} onChange={e => set("hasOtherEmployment", e.target.checked)} id={`q-otherjob-${workerId}`} />
            <label htmlFor={`q-otherjob-${workerId}`} className="text-sm text-slate-600">{t("Є інша робота")}</label>
          </div>
          {form.hasOtherEmployment && (
            <div className="sm:col-span-2"><Label>{t("Деталі іншої зайнятості")}</Label><Input value={form.otherEmploymentNote ?? ""} onChange={e => set("otherEmploymentNote", e.target.value)} /></div>
          )}
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={!!form.isRegisteredUnemployed} onChange={e => set("isRegisteredUnemployed", e.target.checked)} id={`q-unemployed-${workerId}`} />
            <label htmlFor={`q-unemployed-${workerId}`} className="text-sm text-slate-600">{t("Зареєстрований(а) як безробітний(а) в PL")}</label>
          </div>

          <div className="sm:col-span-2 mt-2 border-t border-slate-100 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
            {t("Для ZUS / podatkowe")}
          </div>
          <div><Label>{t("NIP (необов'язково)")}</Label><Input value={form.nip ?? ""} onChange={e => set("nip", e.target.value)} /></div>
          <div><Label>{t("Адреса Urzędu Skarbowego")}</Label><Input value={form.taxOfficeAddress ?? ""} onChange={e => set("taxOfficeAddress", e.target.value)} /></div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={!!form.pit0} onChange={e => set("pit0", e.target.checked)} id={`q-pit0-${workerId}`} />
            <label htmlFor={`q-pit0-${workerId}`} className="text-sm text-slate-600">{t("Ulga dla młodych — 0% PIT (до 26 років)")}</label>
          </div>
          <div className="sm:col-span-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {([
              ["ankietaInnyPracodawca", "Інший роботодавець (ZUS)"],
              ["ankietaEmeryt", "Емерит"],
              ["ankietaRencista", "Рецист (інвалідність — пенсія)"],
              ["ankietaNiepelnosprawnosc", "Інвалідність"],
              ["ankietaSkladkaChorobowa", "Хоче хворобову складку (добровільно)"],
            ] as const).map(([k, label]) => (
              <div key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={!!form[k]} onChange={e => set(k, e.target.checked)} id={`q-${k}-${workerId}`} />
                <label htmlFor={`q-${k}-${workerId}`} className="text-sm text-slate-600">{t(label)}</label>
              </div>
            ))}
          </div>

          <div className="sm:col-span-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Адреса замельдування (гранульно)")}</div>
          {([
            ["regWojewodztwo", "Województwo"], ["regPowiat", "Powiat"], ["regGmina", "Gmina"], ["regMiejscowosc", "Miejscowość"],
            ["regUlica", "Ulica"], ["regNumerDomu", "Numer domu"], ["regKodPocztowy", "Kod pocztowy"],
          ] as const).map(([k, label]) => (
            <div key={k}><Label>{label}</Label><Input value={form[k] ?? ""} onChange={e => set(k, e.target.value)} /></div>
          ))}

          <div className="sm:col-span-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Адреса проживання (гранульно)")}</div>
          {([
            ["zamWojewodztwo", "Województwo"], ["zamPowiat", "Powiat"], ["zamGmina", "Gmina"], ["zamMiejscowosc", "Miejscowość"],
            ["zamUlica", "Ulica"], ["zamNumerDomu", "Numer domu"], ["zamKodPocztowy", "Kod pocztowy"],
          ] as const).map(([k, label]) => (
            <div key={k}><Label>{label}</Label><Input value={form[k] ?? ""} onChange={e => set(k, e.target.value)} /></div>
          ))}
        </div>
      )}
    </Modal>
  );
}

type ContractSummary = {
  id: number; workerId: number; factoryId: number | null; status: string;
  dateFrom: string | null; dateTo: string | null; generatedAt: string | null;
  approvedAt: string | null; sentAt: string | null; signedAt: string | null;
  companySignedAt: string | null; supersedesId: number | null;
};
type ContractFileRow = { id: number; title: string; sortOrder: number; unsignedSha256: string | null; signedSha256: string | null };
type DocSetItem = { id: number; kind: string; title: string };
const KIND_LABEL: Record<string, string> = {
  umowa: "Umowa", regulamin: "Regulamin", zus: "ZUS", tax: "Podatkowe", ppk: "PPK", bhp: "BHP",
  wniosek_konto: "Wniosek — konto", wniosek_reka: "Wniosek — do rąk", wniosek_zaliczki: "Wniosek — zaliczki",
  andros_extra: "Andros — додатковий", sprzatanie_umowa: "Sprzątanie", custom: "Інше",
};

// Компанія підписує ЛИШЕ після працівника (бізнес-правило) — worker_signed
// між "sent" і фінальним "signed".
const CONTRACT_STATUS: Record<string, { label: string; color: "slate" | "blue" | "green" | "amber" | "rose" }> = {
  draft: { label: "чернетка", color: "slate" },
  pending_approval: { label: "на розгляді", color: "amber" },
  approved: { label: "затверджено", color: "blue" },
  sent: { label: "надіслано", color: "blue" },
  viewed: { label: "переглянуто", color: "blue" },
  worker_signed: { label: "підписав працівник", color: "amber" },
  signed: { label: "підписано", color: "green" },
  declined: { label: "відхилено", color: "rose" },
  cancelled: { label: "скасовано", color: "slate" },
  superseded: { label: "замінено", color: "slate" },
  expired: { label: "прострочено", color: "rose" },
};

// Умови (umowa zlecenie + załączniki) — модуль «Документи й підписання»
// (/contracts) у розробці. Генерація вимагає підтверджену (verified) анкету
// (WorkerQuestionnaire вище) і набір шаблонів; workflow: draft → (одна кнопка
// «Надіслати на підпис») → sent → працівник підписує на /sign/:token →
// worker_signed → (finalize, компанія) → signed. submit/pending_approval/
// approve лишились на бекенді (окремі ендпоінти), але «Надіслати на підпис»
// працює прямо з draft — без обов'язкових проміжних кліків. Компанія НЕ може
// підписати раніше за працівника — «Підписати від компанії» з'являється лише
// в статусі worker_signed.
function WorkerContracts({ workerId, factoryId, factories }: { workerId: number; factoryId: number | null; factories: Factory[] }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: contracts = [], isLoading } = useQuery<ContractSummary[]>({ queryKey: ["worker-contracts", workerId], queryFn: () => get(`/workers/${workerId}/contracts`) });
  const [showNew, setShowNew] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["worker-contracts", workerId] });

  const cancelMut = useMutation({ mutationFn: (id: number) => post(`/contracts/${id}/cancel`), onSuccess: () => { inv(); toast.success(t("Скасовано")); }, onError: (e: any) => toast.error(e.message) });
  const finalize = useMutation({ mutationFn: (id: number) => post(`/contracts/${id}/finalize`), onSuccess: () => { inv(); toast.success(t("Підписано від компанії — пакет завершено")); }, onError: (e: any) => toast.error(e.message) });
  const send = useMutation({
    mutationFn: (id: number) => post<{ notified: boolean; link: string | null; bundledCount: number }>(`/contracts/${id}/send`),
    onSuccess: r => {
      inv();
      // bundledCount>0 — разом надіслано й інші sendable пакети цієї людини
      // (одна сесія підписання на весь комплект, не окремі лінки).
      const bundleNote = r.bundledCount > 0 ? ` (${t("разом з {n} іншим пакетом", { n: r.bundledCount })})` : "";
      toast.success((r.notified ? t("Надіслано працівнику в Telegram") : t("Токен створено, але Telegram не надіслано — скопіюй лінк вручну")) + bundleNote);
      if (r.link && !r.notified) navigator.clipboard?.writeText(r.link).catch(() => {});
    },
    onError: (e: any) => toast.error(e.message),
  });

  const renderRow = (c: ContractSummary) => {
    const st = CONTRACT_STATUS[c.status] ?? CONTRACT_STATUS.draft!;
    return (
      <div key={c.id} className="border-b border-slate-50 last:border-0">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
          <Badge color={st.color}>{t(st.label)}</Badge>
          {!c.dateFrom && !["declined", "cancelled", "superseded", "expired"].includes(c.status) ? (
            <EditContractDates contractId={c.id} onSaved={inv} />
          ) : (
            <span className="text-slate-600">{c.dateFrom ?? "—"}{c.dateTo ? ` → ${c.dateTo}` : ""}</span>
          )}
          {c.supersedesId && <span className="text-xs text-slate-400" title={t("Замінює попередній пакет")}>↺ #{c.supersedesId}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {["draft", "pending_approval", "approved"].includes(c.status) && (
              <button onClick={() => send.mutate(c.id)} disabled={send.isPending} className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">{t("Надіслати на підпис")}</button>
            )}
            {c.status === "worker_signed" && (
              <button onClick={() => finalize.mutate(c.id)} disabled={finalize.isPending} className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">{t("Підписати від компанії")}</button>
            )}
            {!["signed", "cancelled", "superseded", "expired", "declined"].includes(c.status) && (
              <button onClick={async () => { if (await confirm({ title: t("Скасувати пакет?"), danger: true, confirmText: t("Скасувати") })) cancelMut.mutate(c.id); }}
                className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Скасувати")}><Ban className="h-3.5 w-3.5" /></button>
            )}
            <button onClick={() => setExpanded(x => x === c.id ? null : c.id)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              {expanded === c.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
        {(c.signedAt || c.companySignedAt) && (
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 px-4 pb-2 text-xs text-slate-400">
            {c.signedAt && <span>{t("Підписав працівник")}: {new Date(c.signedAt).toLocaleString("uk-UA")}</span>}
            {c.companySignedAt && <span>{t("Підписала компанія")}: {new Date(c.companySignedAt).toLocaleString("uk-UA")}</span>}
          </div>
        )}
        {expanded === c.id && <ContractFilesList contractId={c.id} />}
      </div>
    );
  };

  // factoryId=null — сталий пакет (спільний для всіх фабрик, підписується
  // раз); factoryId задано — окремий ланцюг конкретної фабрики. Працівник
  // може мати кілька одночасно активних факторі-ланцюгів (§7 плану).
  const standard = contracts.filter(c => c.factoryId == null);
  // Дійсний = підписаний ПРАЦІВНИКОМ (worker_signed або вже фінальний signed)
  // і не прострочений по даті — доки такого нема, модалка генерації факторі-
  // пакета мусить пропонувати сталий пакет РАЗОМ (не лише окремим кроком).
  const today = new Date().toISOString().slice(0, 10);
  const validStandard = standard.find(c => (c.status === "worker_signed" || c.status === "signed") && (!c.dateTo || c.dateTo >= today));
  const byFactory = new Map<number, ContractSummary[]>();
  for (const c of contracts) if (c.factoryId != null) { const arr = byFactory.get(c.factoryId) ?? []; arr.push(c); byFactory.set(c.factoryId, arr); }

  return (
    <>
      <Section icon={FileSignature} title={t("Умови (Umowa)")}
        action={<>
          <WorkerQuestionnaire workerId={workerId} />
          <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => setShowNew(true)}><Plus className="h-3.5 w-3.5" /> {t("Згенерувати документи")}</Button>
        </>}
        empty={t("Документів ще немає.")}>
        {isLoading ? <Spinner /> : contracts.length ? (
          <div>
            {standard.length > 0 && (
              <div className="border-b border-slate-100">
                <div className="bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Стандартний пакет")} <span className="normal-case text-slate-400">({t("спільний для всіх фабрик")})</span></div>
                {standard.map(renderRow)}
              </div>
            )}
            {[...byFactory.entries()].map(([fid, list]) => (
              <div key={fid} className="border-b border-slate-100 last:border-0">
                <div className="bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{factories.find(f => f.id === fid)?.name ?? `#${fid}`}</div>
                {list.map(renderRow)}
              </div>
            ))}
          </div>
        ) : null}
      </Section>
      {showNew && (
        <GenerateDocumentsModal workerId={workerId} defaultFactoryId={factoryId} factories={factories}
          standardValid={!!validStandard} standardValidUntil={validStandard?.dateTo ?? null}
          onClose={() => setShowNew(false)} onSaved={() => { inv(); setShowNew(false); }} />
      )}
    </>
  );
}

// Умову можна згенерувати й підписати без дат (дозвіл на роботу часто
// оформлюють УЖЕ маючи підписану умову — дата стає відома постфактум) — тут
// дописуємо, щойно з'явиться, на будь-якому нетермінальному статусі. У draft
// це ще й перегенеровує PDF-файли; після — лише дані в БД, підписаний файл не
// чіпається (services/contracts.ts:updateContractDates).
function EditContractDates({ contractId, onSaved }: { contractId: number; onSaved: () => void }) {
  const t = useT();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const save = useMutation({
    mutationFn: () => patch(`/contracts/${contractId}/dates`, { dateFrom, dateTo: dateTo || null }),
    onSuccess: () => { toast.success(t("Дати збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-7 w-32 text-xs" />
      <span className="text-slate-400">→</span>
      <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-7 w-32 text-xs" />
      <button onClick={() => save.mutate()} disabled={!dateFrom || save.isPending}
        className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-50">
        {t("Зберегти дати")}
      </button>
    </div>
  );
}

// Клік по файлу розгортає PDF просто в рядку (canvas через pdf.js, як на
// /sign/:token) — без нової вкладки/скачування, щоб офіс міг перевірити
// зміст, не виходячи зі сторінки.
function ContractFilesList({ contractId }: { contractId: number }) {
  const t = useT();
  const { data, isLoading } = useQuery<{ files: ContractFileRow[] }>({ queryKey: ["contract-detail", contractId], queryFn: () => get(`/contracts/${contractId}`) });
  const [openFile, setOpenFile] = useState<number | null>(null);
  if (isLoading) return <div className="px-4 py-2"><Spinner /></div>;
  const files = data?.files ?? [];
  if (!files.length) return <div className="px-4 pb-2 text-xs text-slate-400">{t("Файлів ще немає.")}</div>;
  return (
    <div className="space-y-1 bg-slate-50/60 px-4 py-2">
      {files.map(f => (
        <div key={f.id}>
          <button type="button" onClick={() => setOpenFile(x => x === f.id ? null : f.id)}
            className="flex w-full items-center gap-1.5 text-left text-xs text-red-600 hover:underline">
            <Eye className="h-3 w-3" /> {f.title} {f.signedSha256 && <Badge color="green">{t("підписано")}</Badge>}
            {openFile === f.id ? <ChevronUp className="h-3 w-3 text-slate-400" /> : <ChevronDown className="h-3 w-3 text-slate-400" />}
          </button>
          {openFile === f.id && <ContractPdfPreview url={`/api/contracts/${contractId}/files/${f.id}`} />}
        </div>
      ))}
    </div>
  );
}

// PDF рендеримо самі через pdf.js (канвасами) — вбудований переглядач браузера
// може бути налаштований «скачувати PDF», і превʼю тоді не показується взагалі
// (той самий підхід, що CostInvoices.tsx PdfPreview і /sign/:token PdfPages).
function ContractPdfPreview({ url }: { url: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url" as any)).default as string;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const doc = await pdfjs.getDocument({ url }).promise;
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = "";
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1.4 });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width; canvas.height = vp.height;
          canvas.style.width = "100%";
          canvas.className = "mb-2 rounded border border-slate-200 bg-white";
          if (cancelled || !ref.current) return;
          ref.current.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp } as any).promise;
        }
      } catch (e: any) { if (!cancelled) setErr(String(e?.message ?? e).slice(0, 200)); }
    })();
    return () => { cancelled = true; };
  }, [url]);
  if (err) return <div className="px-1 py-2 text-xs text-rose-500">{t("Не вдалося показати PDF.")} {err}</div>;
  return <div ref={ref} className="max-h-[70vh] overflow-y-auto px-1 py-2" />;
}

// Фабрика обирається тут, не обов'язково worker.factoryId (§7 плану —
// декілька одночасно активних факторі-пакетів на працівника). "" у Select =
// сталий пакет (factoryId=null): ZUS/tax/PPK/BHP/wniosek. Чекліст авторезолвиться
// (factory > company > all), кожен пункт можна вручну зняти/додати перед генерацією.
const todayIso = () => new Date().toISOString().slice(0, 10);
const yearAheadIso = () => { const d = new Date(); d.setFullYear(d.getFullYear() + 1); return d.toISOString().slice(0, 10); };

function GenerateDocumentsModal({ workerId, defaultFactoryId, factories, standardValid, standardValidUntil, onClose, onSaved }: {
  workerId: number; defaultFactoryId: number | null; factories: Factory[];
  standardValid: boolean; standardValidUntil: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [factoryId, setFactoryId] = useState<string>(defaultFactoryId ? String(defaultFactoryId) : "");
  // Рік-наперед за замовчуванням — лише для сталого пакету (ZUS/tax/PPK/BHP/
  // wniosek): факторі-пакет (Umowa, іноді разом з Regulamin) цілком легально
  // йде БЕЗ дат (дата роботи невідома заздалегідь) — не форсувати тут дефолт.
  const [dateFrom, setDateFrom] = useState(defaultFactoryId ? "" : todayIso());
  const [dateTo, setDateTo] = useState(defaultFactoryId ? "" : yearAheadIso());
  const [rateOverride, setRateOverride] = useState("");
  const [payoutCash, setPayoutCash] = useState(false);
  const [checkedFactory, setCheckedFactory] = useState<Set<number>>(new Set());
  const [checkedStandard, setCheckedStandard] = useState<Set<number>>(new Set());
  const isStandard = factoryId === "";
  // Сталий пакет (ZUS/tax/PPK/BHP/wniosek) — спільний для ВСІХ фабрик; має
  // з'являтись у комплекті кожного разу, коли його ще нема чинного підписаного
  // варіанту, а не лише коли адмін явно обрав "— Стандартний пакет —".
  const needsStandardToo = !isStandard && !standardValid;
  const showStandardSection = isStandard || needsStandardToo;

  const { data: allTemplates = [] } = useQuery<{ id: number; kind: string; title: string; isActive: boolean }[]>({
    queryKey: ["document-templates-all"], queryFn: () => get("/document-templates"),
  });
  const factoryKinds = new Set(["umowa", "regulamin", "andros_extra", "sprzatanie_umowa"]);
  const factoryCandidates = allTemplates.filter(tp => tp.isActive && factoryKinds.has(tp.kind));
  const standardCandidates = allTemplates.filter(tp => tp.isActive && !factoryKinds.has(tp.kind));

  const { data: autoSetFactory = [], isFetching: autoFactoryLoading } = useQuery<DocSetItem[]>({
    queryKey: ["document-set", workerId, factoryId],
    queryFn: () => get(`/workers/${workerId}/document-set?factoryId=${factoryId}`),
    enabled: !isStandard,
  });
  const { data: autoSetStandard = [], isFetching: autoStandardLoading } = useQuery<DocSetItem[]>({
    queryKey: ["document-set", workerId, "standard"],
    queryFn: () => get(`/workers/${workerId}/document-set`),
    enabled: showStandardSection,
  });

  // Перше завантаження чекліста для обраної фабрики — попередньо відмічаємо
  // авторезолвлені пункти; повторні зміни адмін керує сам (не перезаписуємо
  // його ручний вибір при кожному рефетчі). Факторі- і стандартний чекліст
  // відмічаються незалежно (сталий може лишатись відміченим, поки перемикаєш
  // фабрики, факторі — перевідмічається щоразу під нову фабрику).
  const lastAutoFactoryKey = useRef<string | null>(null);
  if (!isStandard && lastAutoFactoryKey.current !== factoryId && !autoFactoryLoading) {
    lastAutoFactoryKey.current = factoryId;
    setCheckedFactory(new Set(autoSetFactory.map(x => x.id)));
  }
  const lastAutoStandardKey = useRef<string | null>(null);
  const standardKey = showStandardSection ? "on" : "off";
  if (showStandardSection && lastAutoStandardKey.current !== standardKey && !autoStandardLoading) {
    lastAutoStandardKey.current = standardKey;
    setCheckedStandard(new Set(autoSetStandard.map(x => x.id)));
  }

  const toggleIn = (setFn: (fn: (prev: Set<number>) => Set<number>) => void, list: typeof factoryCandidates) => (id: number, kind: string) => {
    setFn(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); return next; }
      next.add(id);
      // konto/reka взаємовиключні — галочка на одному знімає інший
      if (kind === "wniosek_konto" || kind === "wniosek_reka") {
        const other = list.find(c => c.id !== id && (c.kind === "wniosek_konto" || c.kind === "wniosek_reka"));
        if (other) next.delete(other.id);
      }
      return next;
    });
  };
  const toggleFactory = toggleIn(setCheckedFactory, factoryCandidates);
  const toggleStandard = toggleIn(setCheckedStandard, standardCandidates);

  const setPayoutMethod = useMutation({ mutationFn: (method: "konto" | "reka") => put(`/workers/${workerId}/questionnaire`, { payoutMethod: method }) });
  const onTogglePayout = (cash: boolean) => {
    setPayoutCash(cash);
    setPayoutMethod.mutate(cash ? "reka" : "konto");
    setCheckedStandard(prev => {
      const next = new Set(prev);
      const konto = standardCandidates.find(c => c.kind === "wniosek_konto");
      const reka = standardCandidates.find(c => c.kind === "wniosek_reka");
      if (cash) { if (konto) next.delete(konto.id); if (reka) next.add(reka.id); }
      else { if (reka) next.delete(reka.id); if (konto) next.add(konto.id); }
      return next;
    });
  };

  // Факторі- і сталий пакет — окремі ланцюги (contracts.factory_id відрізняється),
  // тож коли треба обидва разом — це два послідовні POST в одній дії адміна.
  const save = useMutation({
    mutationFn: async () => {
      if (!isStandard && checkedFactory.size > 0) {
        await post(`/workers/${workerId}/contracts`, {
          factoryId: Number(factoryId), templateIds: [...checkedFactory],
          dateFrom: dateFrom || null, dateTo: dateTo || null,
          contractRateBrutto: rateOverride.trim() === "" ? null : Number(rateOverride.replace(",", ".")),
        });
      }
      if (showStandardSection && checkedStandard.size > 0) {
        await post(`/workers/${workerId}/contracts`, {
          factoryId: null, templateIds: [...checkedStandard],
          dateFrom: dateFrom || null, dateTo: dateTo || null,
        });
      }
    },
    onSuccess: () => { toast.success(t("Документи згенеровано")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  const totalChecked = (!isStandard ? checkedFactory.size : 0) + (showStandardSection ? checkedStandard.size : 0);

  return (
    <Modal open onClose={onClose} title={t("Згенерувати документи")} size="lg">
      <div className="space-y-3">
        <div>
          <Label>{t("Фабрика")}</Label>
          <Select value={factoryId} onChange={e => setFactoryId(e.target.value)}>
            <option value="">{t("— Стандартний пакет (без фабрики) —")}</option>
            {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </div>

        {showStandardSection && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={payoutCash} onChange={e => onTogglePayout(e.target.checked)} />
            {t("Виплата готівкою (замість «на konto»)")}
          </label>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div><Label>{t("Діє від")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></div>
          <div><Label>{t("Діє до")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></div>
        </div>
        <div className="text-xs text-slate-400">
          {isStandard
            ? t("За замовчуванням — рік від сьогодні, можна відредагувати вручну.")
            : t("Для умови дати можна лишити порожніми й дописати пізніше, коли вони стануть відомі.")}
        </div>

        {!isStandard && (
          <div>
            <Label>{t("Ставка в умові для цього працівника (zł/год брутто)")}</Label>
            <Input value={rateOverride} onChange={e => setRateOverride(e.target.value)} placeholder={t("порожньо = ставка фабрики")} inputMode="decimal" className="w-40" />
            <p className="mt-1 text-xs text-slate-400">{t("Перекриває ставку «в умові» з налаштувань фабрики лише для цієї людини й цього пакета.")}</p>
          </div>
        )}

        {!isStandard && (
          <div>
            <Label>{t("Комплект документів фабрики")} {autoFactoryLoading && <Spinner />}</Label>
            <div className="max-h-56 divide-y divide-slate-50 overflow-y-auto rounded-lg border border-slate-200">
              {factoryCandidates.length === 0 && <div className="px-3 py-3 text-sm text-slate-400">{t("Немає шаблонів цього типу в бібліотеці.")}</div>}
              {factoryCandidates.map(c => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50">
                  <input type="checkbox" checked={checkedFactory.has(c.id)} onChange={() => toggleFactory(c.id, c.kind)} />
                  <Badge color="slate">{KIND_LABEL[c.kind] ?? c.kind}</Badge>
                  <span className="truncate text-slate-700">{c.title}</span>
                  {autoSetFactory.some(a => a.id === c.id) && <span className="ml-auto shrink-0 text-xs text-emerald-600">{t("авто")}</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        {showStandardSection && (
          <div>
            <Label>
              {t("Стандартний пакет")} <span className="font-normal text-slate-400">({t("спільний для всіх фабрик")})</span>
              {needsStandardToo && <span className="ml-1 font-normal text-amber-600">— {t("ще не підписаний, додається разом")}</span>}
              {" "}{autoStandardLoading && <Spinner />}
            </Label>
            <div className="max-h-56 divide-y divide-slate-50 overflow-y-auto rounded-lg border border-slate-200">
              {standardCandidates.length === 0 && <div className="px-3 py-3 text-sm text-slate-400">{t("Немає шаблонів цього типу в бібліотеці.")}</div>}
              {standardCandidates.map(c => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50">
                  <input type="checkbox" checked={checkedStandard.has(c.id)} onChange={() => toggleStandard(c.id, c.kind)} />
                  <Badge color="slate">{KIND_LABEL[c.kind] ?? c.kind}</Badge>
                  <span className="truncate text-slate-700">{c.title}</span>
                  {autoSetStandard.some(a => a.id === c.id) && <span className="ml-auto shrink-0 text-xs text-emerald-600">{t("авто")}</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        {!isStandard && !needsStandardToo && (
          <p className="text-xs text-emerald-600">
            ✓ {t("Стандартний пакет уже підписаний")}{standardValidUntil ? ` — ${t("дійсний до")} ${standardValidUntil}` : ` (${t("безстроково")})`}.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button disabled={totalChecked === 0 || save.isPending} onClick={() => save.mutate()}>{t("Згенерувати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Легалізація за документами (движок worker_legality) — три світлофори
// (перебування/праця/загалом), причини движка, найближчий термін, обов'язки
// (напр. powiadomienie), та підказка до старого поля «Форма легалізації»
// (LegalStatusRow нижче лишається окремим — легасі-поле НЕ автозаповнюється).
// Доступно на перегляд усім ролям (як GET .../legality); «Перерахувати» — cap legalization.
function WorkerLegalitySection({ workerId }: { workerId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const canLegal = can(me, "legalization");
  const { data: legality, isLoading } = useQuery<WorkerLegality | null>({
    queryKey: ["worker-legality", workerId], queryFn: () => get(`/workers/${workerId}/legality`),
  });
  const recompute = useMutation({
    mutationFn: () => post<WorkerLegality>(`/workers/${workerId}/legality/recompute`),
    onSuccess: (data) => { qc.setQueryData(["worker-legality", workerId], data); toast.success(t("Перераховано")); },
    onError: (e: any) => toast.error(e.message),
  });
  const recomputeBtn = canLegal && (
    <Button variant="secondary" className="px-2 py-1 text-xs" loading={recompute.isPending} onClick={() => recompute.mutate()}>
      <RefreshCw className="h-3.5 w-3.5" /> {t("Перерахувати")}
    </Button>
  );

  if (isLoading) return <Section icon={Scale} title={t("Легалізація")}><Spinner /></Section>;

  if (!legality) {
    return <Section icon={Scale} title={t("Легалізація")} action={recomputeBtn} empty={t("Ще не рахувалось")}>{null}</Section>;
  }

  const reasonsByAxis: Record<string, LegalityReason[]> = {};
  for (const r of legality.reasons) (reasonsByAxis[r.axis] ??= []).push(r);
  const severityCls = (sev: LegalityReason["severity"]) => sev === "block" ? "text-rose-600" : sev === "warn" ? "text-amber-600" : "text-slate-500";
  const dLeft = daysUntil(legality.nextExpiryAt);
  const ph = legality.payrollHints;
  const hints: string[] = [];
  if (ph) {
    // studentCertMissingOrExpired лише має сенс разом з studentByProfile — інакше «студент без zaświadczenia» вводить в оману нестудента
    if (ph.studentByProfile && ph.studentCertMissingOrExpired) hints.push(t("студент за профілем без чинного zaświadczenia"));
    if (ph.notifyHoursWithoutBasis) hints.push(t("години повідомлення без документа"));
    if (ph.hoursExceedNotify === true) hints.push(t("години > повідомлення"));
    if (ph.workBasisMissing) hints.push(t("оформлений без документа праці"));
  }

  return (
    <Section icon={Scale} title={t("Легалізація")} action={recomputeBtn}
      extra={legality.reviewRequired && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600">
          <AlertTriangle className="h-3 w-3" /> {t("потребує перевірки")}
        </span>
      )}>
      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap gap-2">
          {(["stay", "work", "overall"] as const).map(axis => (
            <div key={axis} className="flex items-center gap-1.5 rounded-lg border border-slate-100 px-2.5 py-1.5 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${LEGALITY_DOT[legality[axis]]}`} />
              <span className="text-xs text-slate-400">{t(AXIS_LABEL[axis])}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${LEGALITY_BADGE[legality[axis]]}`}>{t(LEGALITY_LABEL[legality[axis]])}</span>
            </div>
          ))}
        </div>

        {legality.reasons.length > 0 && (
          <div className="space-y-1.5">
            {(["stay", "work", "overall"] as const).filter(ax => reasonsByAxis[ax]?.length).map(ax => (
              <div key={ax}>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t(AXIS_LABEL[ax])}</div>
                {reasonsByAxis[ax]!.map((r, i) => <div key={i} className={`text-xs ${severityCls(r.severity)}`}>• {reasonText(t, r)}</div>)}
              </div>
            ))}
          </div>
        )}

        {(legality.nextExpiryAt || legality.requiredMissing.length > 0) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {legality.nextExpiryAt && (
              <span className={dLeft != null && dLeft < 0 ? "font-medium text-rose-600" : dLeft != null && dLeft <= 30 ? "font-medium text-amber-600" : "text-slate-500"}>
                {t("Наступний термін: {date} ({n} дн.)", { date: legality.nextExpiryAt, n: dLeft ?? "—" })}
              </span>
            )}
            {legality.requiredMissing.length > 0 && (
              <span className="font-medium text-rose-600">
                {t("Бракує: {list}", { list: legality.requiredMissing.map(m => t(REQUIRED_MISSING_LABEL[m] ?? m)).join(", ") })}
              </span>
            )}
          </div>
        )}

        {legality.obligations.length > 0 && (
          <div className="space-y-0.5">
            {legality.obligations.map((o, i) => {
              const label = o.params?.docCode === "powiadomienie_ua" ? t("Powiadomienie о працю UA: термін {dueAt}", { dueAt: o.dueAt }) : o.code;
              const stTxt = o.satisfied ? t("подано") : o.overdue ? t("прострочено") : t("очікує");
              const cls = o.satisfied ? "text-emerald-600" : o.overdue ? "text-rose-600" : "text-amber-600";
              return <div key={i} className="text-xs text-slate-600">{label} — <span className={`font-medium ${cls}`}>{stTxt}</span></div>;
            })}
          </div>
        )}

        {legality.derivedLegalStatus && (
          <div className={`rounded-lg border px-2.5 py-1.5 text-xs ${legality.legacyMismatchKind === "cross_class" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-100 bg-slate-50 text-slate-500"}`}>
            {t("За документами: {status} — {mismatch}", {
              status: t(LEGAL_LABEL[legality.derivedLegalStatus as LegalStatus] ?? legality.derivedLegalStatus),
              mismatch: t(MISMATCH_LABEL[legality.legacyMismatchKind] ?? legality.legacyMismatchKind),
            })}
            {legality.legacyMappingRequiresReview && (
              <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">{t("потребує перевірки")}</span>
            )}
          </div>
        )}

        {hints.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {hints.map((h, i) => <span key={i} className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">{h}</span>)}
          </div>
        )}
      </div>
    </Section>
  );
}

function WorkerDocuments({ workerId, companies }: { workerId: number; companies: Company[] }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const canLegal = can(me, "legalization");
  const confirm = useConfirm();
  const { data: types = [] } = useQuery<DocumentType[]>({ queryKey: ["document-types"], queryFn: () => get("/document-types") });
  const { data: docs = [], isLoading } = useQuery<WorkerDocument[]>({ queryKey: ["worker-docs", workerId], queryFn: () => get(`/workers/${workerId}/documents`) });
  const [editing, setEditing] = useState<WorkerDocument | null>(null);
  const [addFor, setAddFor] = useState<DocumentType | null | "custom">(null);
  const [preview, setPreview] = useState<WorkerDocument | null>(null);
  const [auditFor, setAuditFor] = useState<WorkerDocument | null>(null);
  const [rejecting, setRejecting] = useState<WorkerDocument | null>(null);
  // «Легалізація» на профілі рахує на льоту з кешу — будь-яка зміна документа
  // (нова, дата, статус, верифікація, відхилення) мусить скинути й цей кеш.
  const inv = () => { qc.invalidateQueries({ queryKey: ["worker-docs", workerId] }); qc.invalidateQueries({ queryKey: ["worker-legality", workerId] }); };
  const remove = useMutation({ mutationFn: (id: number) => del(`/worker-documents/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  const verify = useMutation({ mutationFn: (id: number) => post(`/worker-documents/${id}/verify`), onSuccess: () => { inv(); toast.success(t("Підтверджено")); }, onError: (e: any) => toast.error(e.message) });
  const reject = useMutation({
    mutationFn: (v: { id: number; note: string }) => post(`/worker-documents/${v.id}/reject`, { note: v.note }),
    onSuccess: () => { inv(); setRejecting(null); toast.success(t("Відхилено")); },
    onError: (e: any) => toast.error(e.message),
  });
  const request = useMutation({
    mutationFn: (docTypeId: number) => post(`/workers/${workerId}/documents/request`, { docTypeId }),
    onSuccess: () => { inv(); toast.success(t("Запит на подання надіслано")); },
    onError: (e: any) => toast.error(e.message),
  });
  // Запросити на скан паспорта (якщо ще нема) + анкету — anketa-токен,
  // routes/passportScan.ts сам вирішує чи показувати крок сканування.
  // Той самий best-effort патерн, що «Надіслати на підпис» у WorkerContracts.
  const docsInvite = useMutation({
    mutationFn: () => post<{ notified: boolean; link: string }>(`/workers/${workerId}/docs-invite`),
    onSuccess: r => {
      toast.success(r.notified ? t("Надіслано працівнику в Telegram") : t("Токен створено, але Telegram не надіслано — скопіюй лінк вручну"));
      if (r.link && !r.notified) navigator.clipboard?.writeText(r.link).catch(() => {});
    },
    onError: (e: any) => toast.error(e.message),
  });

  const docByType = new Map<number, WorkerDocument>();
  for (const d of docs) if (d.docTypeId != null) docByType.set(d.docTypeId, d);
  const extras = docs.filter(d => d.docTypeId == null || !types.some(ty => ty.id === d.docTypeId));

  const missingRequired = types.filter(ty => ty.required && !docByType.has(ty.id)).length;

  const row = (key: string, name: string, required: boolean, doc: WorkerDocument | undefined, type: DocumentType | null) => {
    const expired = doc && (doc.status === "expired" || isExpired(doc.expiresAt));
    const status = doc ? (expired && doc.status === "present" ? "expired" : doc.status) : "missing";
    const s = DOC_STATUS[status] ?? DOC_STATUS.missing;
    const Icon = docTypeIcon(type?.icon);
    const hasFile = !!doc?.fileName;
    // Термін дії — жовтий у межах 30 днів, rose коли вже минув (узгоджено з
    // похідним статусом "expired" вище, який теж рахує з isExpired).
    const dLeft = doc?.expiresAt ? daysUntil(doc.expiresAt) : null;
    const expiryCls = dLeft != null && dLeft < 0 ? "font-medium text-rose-600" : dLeft != null && dLeft <= 30 ? "font-medium text-amber-600" : "text-slate-400";
    const employerName = doc?.employerCompanyId != null ? (companies.find(c => c.id === doc.employerCompanyId)?.name ?? `#${doc.employerCompanyId}`) : null;
    return (
      <div key={key} className="border-b border-slate-50 px-4 py-2.5 text-sm last:border-0">
        <div className="flex flex-wrap items-center gap-2">
          {hasFile ? (
            <button type="button" onClick={() => setPreview(doc!)} className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-red-600" title={t("Відкрити")}>
              <Icon className="h-4 w-4" />
            </button>
          ) : <Icon className="h-4 w-4 shrink-0 text-slate-400" />}
          {hasFile ? (
            <button type="button" onClick={() => setPreview(doc!)} className="font-medium text-slate-700 hover:text-red-600 hover:underline">{name}</button>
          ) : <span className="font-medium text-slate-700">{name}</span>}
          {required && <span className="text-[10px] font-semibold uppercase text-amber-500">{t("обов'язковий")}</span>}
          <Badge color={s!.color}>{t(s!.label)}</Badge>
          {doc?.status === "pending" && <span className="text-xs font-medium text-blue-600">{t("⏳ на перевірці")}</span>}
          {doc?.source === "worker_bot" && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{t("з бота")}</span>}
          {doc?.caseStatus && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">{t(CASE_STATUS_LABEL[doc.caseStatus])}</span>}
          {employerName && <span className="text-xs text-slate-400">{employerName}</span>}
          {doc?.expiresAt && <span className={`text-xs ${expiryCls}`}>⏳ {doc.expiresAt}</span>}
          {doc?.number && <span className="text-xs text-slate-400">№ {doc.number}</span>}
          {hasFile && <a href={`/api/worker-documents/${doc!.id}/file`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-slate-400 hover:text-red-600 hover:underline" title={doc!.fileName ?? undefined}>{t("файл")} <ExternalLink className="h-3 w-3" /></a>}
          {doc?.fileUrl && <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-red-600 hover:underline">{t("посилання")} <ExternalLink className="h-3 w-3" /></a>}
          {doc?.note && <span className="truncate text-xs text-slate-400" title={doc.note}>📝 {doc.note}</span>}
          <div className="ml-auto flex shrink-0 gap-1">
            {doc ? (
              <>
                {canLegal && doc.status === "pending" && (
                  <>
                    <button onClick={() => verify.mutate(doc.id)} disabled={verify.isPending} className="rounded p-1 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600" title={t("Підтвердити")}><ShieldCheck className="h-3.5 w-3.5" /></button>
                    <button onClick={() => setRejecting(doc)} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Відхилити")}><XCircle className="h-3.5 w-3.5" /></button>
                  </>
                )}
                {canLegal && <button onClick={() => setAuditFor(doc)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Історія")}><History className="h-3.5 w-3.5" /></button>}
                <button onClick={() => setEditing(doc)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Редагувати")}><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={async () => { if (await confirm({ title: t("Видалити документ?"), danger: true, confirmText: t("Видалити") })) remove.mutate(doc.id); }} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
              </>
            ) : (
              <>
                {type && required && canLegal && (
                  <button onClick={() => request.mutate(type.id)} disabled={request.isPending} className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">{t("Попросити подати")}</button>
                )}
                <button onClick={() => setAddFor(type)} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"><Plus className="h-3.5 w-3.5" /> {t("Додати")}</button>
              </>
            )}
          </div>
        </div>
        {doc?.reviewNote && <div className="pl-6 pt-0.5 text-xs text-slate-400">📝 {doc.reviewNote}</div>}
      </div>
    );
  };

  return (
    <>
      <Section icon={FileText} title={t("Документи")}
        extra={missingRequired > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600"><AlertTriangle className="h-3 w-3" /> {t("бракує {n}", { n: missingRequired })}</span>}
        action={
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" className="px-2 py-1 text-xs" loading={docsInvite.isPending} onClick={() => docsInvite.mutate()}>{t("Запросити на скан+анкету")}</Button>
            <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => setAddFor("custom")}><Plus className="h-3.5 w-3.5" /> {t("Документ")}</Button>
          </div>
        }
        empty={t("Немає документів. Додайте типи в Налаштуваннях → Документи.")}>
        {isLoading ? <Spinner /> : (types.length || extras.length) ? (
          <div>
            {/* каталог має ~24 типи (сід легалізації) — показуємо лише обов'язкові та ті, що є в людини;
                решту додають через «+ Документ» (селект типу) */}
            {types.filter(ty => ty.required || docByType.has(ty.id)).map(ty => row(`ty${ty.id}`, ty.name, ty.required, docByType.get(ty.id), ty))}
            {extras.map(d => row(`ex${d.id}`, d.title, false, d, null))}
          </div>
        ) : null}
      </Section>
      {(addFor !== null || editing) && (
        <DocModal workerId={workerId} doc={editing} type={addFor === "custom" ? null : addFor} types={types} companies={companies}
          allDocs={docs} canLegal={canLegal}
          onClose={() => { setAddFor(null); setEditing(null); }} onSaved={() => { inv(); setAddFor(null); setEditing(null); }} />
      )}
      {preview && <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />}
      {rejecting && (
        <RejectDocModal doc={rejecting} loading={reject.isPending} onClose={() => setRejecting(null)}
          onReject={note => reject.mutate({ id: rejecting.id, note })} />
      )}
      {auditFor && <DocumentAuditModal documentId={auditFor.id} title={auditFor.title} onClose={() => setAuditFor(null)} />}
    </>
  );
}

// Відхилення документа на перевірці — причина обов'язкова (services/*: reject
// вимагає note, статус повертається на missing, щоб рядок знову засвітився).
function RejectDocModal({ doc, loading, onClose, onReject }: { doc: WorkerDocument; loading: boolean; onClose: () => void; onReject: (note: string) => void }) {
  const t = useT();
  const [note, setNote] = useState("");
  return (
    <Modal open onClose={onClose} title={t("Відхилити документ")}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{doc.title}</p>
        <div><Label>{t("Причина відхилення")}</Label><Textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder={t("Що не так із документом")} /></div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button variant="danger" loading={loading} disabled={!note.trim()} onClick={() => onReject(note.trim())}>{t("Відхилити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Клік по іконці/назві документа — перегляд одразу на сайті (фото/PDF —
// вбудовано, без переходу в нову вкладку). filePath уже віддається сервером з
// Content-Disposition: inline (routes/admin-api.ts), тож просте <img>/<iframe>
// на цей самий URL не тригерить завантаження.
function DocPreviewModal({ doc, onClose }: { doc: WorkerDocument; onClose: () => void }) {
  const t = useT();
  const url = `/api/worker-documents/${doc.id}/file`;
  const isImage = !!doc.fileMime?.startsWith("image/");
  const isPdf = doc.fileMime === "application/pdf";
  return (
    <Modal open onClose={onClose} title={doc.title} size="xl">
      {isImage ? (
        <img src={url} alt={doc.title} className="mx-auto max-h-[80vh] w-auto rounded-lg" />
      ) : isPdf ? (
        <iframe src={url} title={doc.title} className="h-[80vh] w-full rounded-lg border border-slate-200" />
      ) : (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-slate-500">{t("Перегляд неможливий для цього типу файлу.")}</p>
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-red-600 hover:underline">
            {t("Відкрити в новій вкладці")} <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}
    </Modal>
  );
}

// Банківські рахунки працівника: перекази на ці IBAN-и класифікуються у витягах
// як ЗП/аванси навіть без ключових слів у призначенні. Більшість підтягується
// автоматично з зарплатних переказів; тут — перегляд і ручні правки.
// «Основний» рахунок показується в авансах і піде у файл виплат онлайн-банкінгу.
function WorkerBankAccounts({ workerId }: { workerId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [iban, setIban] = useState("");
  const { data: rows = [], isLoading } = useQuery<{ id: number; iban: string; source: string; isPrimary: boolean }[]>({
    queryKey: ["worker-bank-accounts", workerId], queryFn: () => get(`/workers/${workerId}/bank-accounts`),
  });
  const inv = () => qc.invalidateQueries({ queryKey: ["worker-bank-accounts", workerId] });
  const add = useMutation({
    mutationFn: () => post(`/workers/${workerId}/bank-accounts`, { iban }),
    onSuccess: () => { inv(); setIban(""); toast.success(t("Рахунок додано")); },
    onError: (e: any) => toast.error(e.message),
  });
  const setPrimary = useMutation({
    mutationFn: (id: number) => post(`/worker-bank-accounts/${id}/primary`),
    onSuccess: inv, onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/worker-bank-accounts/${id}`), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const fmtIban = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

  return (
    <Section icon={Wallet} title={t("Банківські рахунки (для ЗП/авансів)")}>
      {isLoading ? <Spinner /> : (
        <div>
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-2 border-b border-slate-50 px-4 py-1.5 text-sm last:border-0">
              <span className="tabular-nums text-slate-700">{fmtIban(r.iban)}</span>
              <span className="text-[10px] uppercase text-slate-400">{r.source === "auto" ? t("авто") : t("ручна")}</span>
              {r.isPrimary ? (
                <Badge color="green">{t("основний")}</Badge>
              ) : (
                <button className="rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-emerald-50 hover:text-emerald-700"
                  onClick={() => setPrimary.mutate(r.id)} disabled={setPrimary.isPending}>
                  {t("зробити основним")}
                </button>
              )}
              <button className="ml-auto rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                onClick={async () => { if (await confirm({ title: t("Видалити рахунок?"), danger: true, confirmText: t("Видалити") })) remove.mutate(r.id); }}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {!rows.length && <div className="px-4 pt-2 text-sm text-slate-400">{t("Рахунків ще немає — підтягнуться з зарплатних переказів або додай вручну.")}</div>}
          <div className="flex items-center gap-2 px-4 py-2">
            <Input value={iban} onChange={e => setIban(e.target.value)} placeholder="PL00 0000…" className="w-72" />
            <Button variant="secondary" className="px-2 py-1 text-xs" disabled={iban.replace(/\W/g, "").length < 15 || add.isPending} onClick={() => add.mutate()}>
              <Plus className="h-3.5 w-3.5" /> {t("Додати")}
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function DocModal({ workerId, doc, type, types, companies, allDocs, canLegal, onClose, onSaved }: {
  workerId: number; doc: WorkerDocument | null; type: DocumentType | null; types: DocumentType[]; companies: Company[];
  allDocs: WorkerDocument[]; canLegal: boolean; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const isEdit = !!doc;
  const [docTypeId, setDocTypeId] = useState(doc?.docTypeId != null ? String(doc.docTypeId) : (type ? String(type.id) : ""));
  const [title, setTitle] = useState(doc?.title ?? type?.name ?? "");
  const [status, setStatus] = useState(doc?.status ?? "present");
  const [number, setNumber] = useState(doc?.number ?? "");
  const [expiresAt, setExpiresAt] = useState(doc?.expiresAt ?? "");
  const [fileUrl, setFileUrl] = useState(doc?.fileUrl ?? "");
  const [note, setNote] = useState(doc?.note ?? "");
  const [file, setFile] = useState<File | null>(null);
  // Легалізація: строки/справа/роботодавець — окремий PATCH .../legal (cap legalization).
  const [validFrom, setValidFrom] = useState(doc?.validFrom ?? "");
  const [issuedAt, setIssuedAt] = useState(doc?.issuedAt ?? "");
  const [issuer, setIssuer] = useState(doc?.issuer ?? "");
  const [employerCompanyId, setEmployerCompanyId] = useState(doc?.employerCompanyId != null ? String(doc.employerCompanyId) : "");
  const [caseStatus, setCaseStatus] = useState<CaseStatus | "">(doc?.caseStatus ?? "");
  const [submittedAt, setSubmittedAt] = useState(doc?.submittedAt ?? "");
  const [caseNumber, setCaseNumber] = useState(doc?.caseNumber ?? "");
  const [decisionAt, setDecisionAt] = useState(doc?.decisionAt ?? "");
  const [replacesDocumentId, setReplacesDocumentId] = useState(doc?.replacesDocumentId != null ? String(doc.replacesDocumentId) : "");
  const selectedType = types.find(ty => String(ty.id) === docTypeId) ?? type ?? null;
  const hasLegalData = !!(doc && (doc.validFrom || doc.issuedAt || doc.issuer || doc.employerCompanyId != null || doc.caseStatus || doc.submittedAt || doc.caseNumber || doc.decisionAt || doc.replacesDocumentId != null));
  const [legOpen, setLegOpen] = useState(selectedType?.category === "stay" || selectedType?.category === "work" || hasLegalData);
  // Неактивні типи — не пропонувати для НОВОГО документа, але лишити наявний
  // вибір видимим при редагуванні вже створеного документа цього типу.
  const typeOptions = types.filter(ty => ty.isActive !== false || String(ty.id) === docTypeId);

  const body = () => ({ docTypeId: docTypeId ? Number(docTypeId) : null, title: title.trim(), status, number, expiresAt: expiresAt || null, fileUrl, note });
  const legalBody = () => ({
    validFrom: validFrom || null, issuedAt: issuedAt || null, submittedAt: submittedAt || null, decisionAt: decisionAt || null, expiresAt: expiresAt || null,
    issuer: issuer.trim() || null, caseNumber: caseNumber.trim() || null,
    employerCompanyId: employerCompanyId ? Number(employerCompanyId) : null,
    caseStatus: caseStatus || null,
    replacesDocumentId: replacesDocumentId ? Number(replacesDocumentId) : null,
  });
  const save = useMutation({
    mutationFn: async () => {
      const saved: WorkerDocument = isEdit ? await patch(`/worker-documents/${doc!.id}`, body()) : await post(`/workers/${workerId}/documents`, body());
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        await upload(`/worker-documents/${saved.id}/file`, fd);
      }
      if (canLegal) await patch(`/worker-documents/${saved.id}/legal`, legalBody());
      return saved;
    },
    onSuccess: () => { toast.success(isEdit ? t("Збережено") : t("Додано")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={isEdit ? t("Редагувати документ") : t("Новий документ")}>
      <div className="space-y-3">
        <div><Label>{t("Тип документа")}</Label>
          <Select value={docTypeId} onChange={e => {
            setDocTypeId(e.target.value);
            const ty = types.find(x => String(x.id) === e.target.value);
            if (ty && !title.trim()) setTitle(ty.name);
            if (ty && (ty.category === "stay" || ty.category === "work")) setLegOpen(true);
          }}>
            <option value="">{t("— власний —")}</option>
            {typeOptions.map(ty => <option key={ty.id} value={ty.id}>{ty.name} — {t(DOC_CATEGORY_LABEL[ty.category])}</option>)}
          </Select>
        </div>
        <div><Label>{t("Назва")}</Label><Input value={title} onChange={e => setTitle(e.target.value)} placeholder={t("Назва документа")} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{t("Статус")}</Label>
            <Select value={status} onChange={e => setStatus(e.target.value)}>
              {Object.entries(DOC_STATUS).map(([k, v]) => <option key={k} value={k}>{t(v.label)}</option>)}
            </Select>
          </div>
          <div><Label>{t("Дійсний до")}</Label><Input type="date" value={expiresAt ?? ""} onChange={e => setExpiresAt(e.target.value)} /></div>
        </div>
        <div><Label>{t("Номер")}</Label><Input value={number} onChange={e => setNumber(e.target.value)} /></div>
        <div>
          <Label>{t("Файл")}</Label>
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 hover:bg-slate-50">
            <Upload className="h-4 w-4 shrink-0" />
            <span className="truncate">{file ? file.name : (doc?.fileName ? t("Замінити: {name}", { name: doc.fileName }) : t("Обрати файл (PDF, фото, docx)"))}</span>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx" className="hidden" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <div><Label>{t("Посилання на файл")}</Label><Input value={fileUrl} onChange={e => setFileUrl(e.target.value)} placeholder="https://drive…" /></div>
        <div><Label>{t("Нотатка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} /></div>

        {canLegal ? (
          <div className="rounded-lg border border-slate-200">
            <button type="button" onClick={() => setLegOpen(o => !o)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium text-slate-600">
              {legOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} <Scale className="h-3.5 w-3.5 text-slate-400" /> {t("Легалізація")}
            </button>
            {legOpen && (
              <div className="space-y-2 border-t border-slate-100 p-3">
                <div className="grid grid-cols-2 gap-2">
                  <div><Label>{t("Чинний з")}</Label><Input type="date" value={validFrom ?? ""} onChange={e => setValidFrom(e.target.value)} /></div>
                  <div><Label>{t("Дата видачі")}</Label><Input type="date" value={issuedAt ?? ""} onChange={e => setIssuedAt(e.target.value)} /></div>
                </div>
                <div><Label>{t("Видав")}</Label><Input value={issuer} onChange={e => setIssuer(e.target.value)} /></div>
                {selectedType?.requiresEmployerMatch && (
                  <div><Label>{t("Роботодавець")}</Label>
                    <Select value={employerCompanyId} onChange={e => setEmployerCompanyId(e.target.value)}>
                      <option value="">—</option>
                      {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                  </div>
                )}
                <div><Label>{t("Статус справи")}</Label>
                  <Select value={caseStatus} onChange={e => setCaseStatus(e.target.value as CaseStatus | "")}>
                    <option value="">—</option>
                    {(Object.keys(CASE_STATUS_LABEL) as CaseStatus[]).map(cs => <option key={cs} value={cs}>{t(CASE_STATUS_LABEL[cs])}</option>)}
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div><Label>{t("Подано")}</Label><Input type="date" value={submittedAt ?? ""} onChange={e => setSubmittedAt(e.target.value)} /></div>
                  <div><Label>{t("Рішення")}</Label><Input type="date" value={decisionAt ?? ""} onChange={e => setDecisionAt(e.target.value)} /></div>
                </div>
                <div><Label>{t("№ справи")}</Label><Input value={caseNumber} onChange={e => setCaseNumber(e.target.value)} /></div>
                <div><Label>{t("Поновлює")}</Label>
                  <Select value={replacesDocumentId} onChange={e => setReplacesDocumentId(e.target.value)}>
                    <option value="">—</option>
                    {allDocs.filter(d => d.id !== doc?.id).map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
                  </Select>
                </div>
              </div>
            )}
          </div>
        ) : hasLegalData ? (
          <div className="space-y-0.5 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs text-slate-500">
            {doc!.validFrom && <div>{t("Чинний з")}: {doc!.validFrom}</div>}
            {doc!.issuedAt && <div>{t("Дата видачі")}: {doc!.issuedAt}</div>}
            {doc!.issuer && <div>{t("Видав")}: {doc!.issuer}</div>}
            {doc!.caseStatus && <div>{t("Статус справи")}: {t(CASE_STATUS_LABEL[doc!.caseStatus])}</div>}
            {doc!.caseNumber && <div>{t("№ справи")}: {doc!.caseNumber}</div>}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => title.trim() && save.mutate()}>{isEdit ? t("Зберегти") : t("Додати")}</Button>
        </div>
      </div>
    </Modal>
  );
}


// Побажання по виплаті (лише svodniSensitive): найвищий пріоритет у розкладі
// konto/готівка — понад статус і год. oświadczenia (менше заробив → менша сума)
function PayoutPrefRow({ workerId, kind, value, onRequest }: { workerId: number; kind: string | null; value: number | null; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  // вибір типу з сумою (год/сума на конто) НЕ сабмітиться одразу: чекаємо суму
  // і шлемо тип+суму ОДНІЄЮ зміною (одна модалка «від коли», не дві)
  const [kindDraft, setKindDraft] = useState<string | null>(null);
  // ресинк із пропом: після скасування модалки/збереження інпут не має
  // показувати незастосоване значення як «збережене»
  useEffect(() => { setDraft(value == null ? "" : String(value)); setKindDraft(null); }, [value, kind]);
  const save = useMutation({
    mutationFn: (p: { payoutPrefKind?: string | null; payoutPrefValue?: number | null }) => patch(`/workers/${workerId}`, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const submit = (p: { payoutPrefKind?: string | null; payoutPrefValue?: number | null }) =>
    onRequest ? onRequest(p, t("Побажання по виплаті")) : save.mutate(p);
  const effKind = kindDraft ?? kind ?? "";
  const pickKind = (v: string) => {
    if (v === "hours" || v === "amount") {
      if (v === kind) { setKindDraft(null); return; } // без зміни
      setKindDraft(v); setDraft(""); // сума обовʼязкова — модалка після її вводу
    } else {
      setKindDraft(null);
      submit({ payoutPrefKind: v || null });
    }
  };
  const commitValue = () => {
    const v = draft === "" ? null : Number(draft);
    if (kindDraft) {
      // новий тип чекає суму: порожньо/розфокус без суми = скасування вибору
      if (v == null) { setKindDraft(null); setDraft(value == null ? "" : String(value)); return; }
      submit({ payoutPrefKind: kindDraft, payoutPrefValue: v });
      setKindDraft(null);
      if (onRequest) setDraft(value == null ? "" : String(value));
    } else if (v !== value) {
      submit({ payoutPrefValue: v });
      if (onRequest) setDraft(value == null ? "" : String(value));
    }
  };
  return (
    <InfoRow icon={Wallet} label={t("Побажання по виплаті")}>
      <select value={effKind} onChange={e => pickKind(e.target.value)}
        className="max-w-full rounded border border-transparent bg-transparent py-0.5 pr-5 text-sm font-medium text-slate-700 hover:border-slate-300 focus:border-red-400 focus:outline-none">
        <option value="">{t("— за правилами —")}</option>
        {Object.entries(PAYOUT_PREF_LABEL).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
      </select>
      {(effKind === "hours" || effKind === "amount") && (
        <input type="number" min={0} value={draft} autoFocus={!!kindDraft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") commitValue(); }}
          onBlur={commitValue}
          placeholder={effKind === "hours" ? t("год") : "zł"}
          className="w-24 rounded border border-slate-300 px-1 py-0.5 text-sm" />
      )}
      {kindDraft && <span className="text-xs text-slate-400">{t("впиши суму — далі одне підтвердження")}</span>}
    </InfoRow>
  );
}

// Примітка (лише svodniSensitive)
function NoteBlock({ workerId, note }: { workerId: number; note: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { note: draft.trim() || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <div className="border-t border-slate-100 px-5 py-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-600">
        <FileText className="h-3.5 w-3.5" /> {t("Примітка (закритий доступ)")}
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} rows={3}
            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-red-400 focus:outline-none" />
          <div className="flex gap-2">
            <button className="text-xs font-medium text-emerald-600" onClick={() => save.mutate()}>{t("Зберегти")}</button>
            <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-lg bg-amber-50/60 px-3 py-2 text-left text-sm text-slate-700 hover:bg-amber-50"
          onClick={() => { setDraft(note ?? ""); setEditing(true); }}>
          {note || <span className="text-slate-400">{t("додати примітку…")}</span>}
        </button>
      )}
    </div>
  );
}

// Форма легалізації: select із канонічних статусів (двосторонній синк зі сводними)
function LegalStatusRow({ workerId, legalStatus, onRequest }: { workerId: number; legalStatus: LegalStatus | null; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (v: string) => patch(`/workers/${workerId}`, { legalStatus: v || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const submit = (v: string) => onRequest ? onRequest({ legalStatus: v || null }, t("Форма легалізації")) : save.mutate(v);
  const badge = legalStatus ? LEGAL_BADGE[legalStatus] : null;
  return (
    <InfoRow icon={IdCard} label={t("Форма легалізації")}>
      <select value={legalStatus ?? ""} onChange={e => submit(e.target.value)}
        className="max-w-full rounded border border-transparent bg-transparent py-0.5 pr-5 text-sm font-medium text-slate-700 hover:border-slate-300 focus:border-red-400 focus:outline-none">
        <option value="">—</option>
        {LEGAL_STATUSES.map(s => <option key={s} value={s}>{t(LEGAL_LABEL[s])}</option>)}
      </select>
      {badge && <span className={`rounded px-1 text-[10px] font-medium ${badge.cls}`}>{badge.short}</span>}
    </InfoRow>
  );
}

// Години в повідомленні (powiadomienie — дозвіл на працю): показуються в сводній
function NotifyHoursRow({ workerId, notifyHours, onRequest }: { workerId: number; notifyHours: number | null; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { notifyHours: draft === "" ? null : Number(draft) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const submit = () => {
    if (onRequest) { onRequest({ notifyHours: draft === "" ? null : Number(draft) }, t("Год. у повідомленні")); setEditing(false); }
    else save.mutate();
  };
  return (
    <InfoRow icon={Clock} label={t("Год. у повідомленні")}>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="number" min={0} value={draft} onChange={e => setDraft(e.target.value)}
            className="w-20 rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={submit}>{t("Зберегти")}</button>
          <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
        </span>
      ) : (
        <button className="font-medium text-slate-700 hover:text-red-600"
          onClick={() => { setDraft(notifyHours == null ? "" : String(notifyHours)); setEditing(true); }}>
          {notifyHours != null ? `${notifyHours} ${t("год")}` : t("вказати")}
        </button>
      )}
    </InfoRow>
  );
}

// Залічки за бадання (медогляд): СПИСОК записів — кожен зі своєю сумою,
// датою «вписано» і статусом/датою «знято з ЗП». Додається нова, стара
// видаляється; позначка зняття перемикається кліком по бейджу.
function BadaniaRow({ workerId, entries }: { workerId: number; entries: BadaniaEntry[] }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inv = () => qc.invalidateQueries({ queryKey: ["worker"] });
  const add = useMutation({
    mutationFn: () => post(`/workers/${workerId}/badania`, { amount: Number(draft) }),
    onSuccess: () => { inv(); setAdding(false); setDraft(""); },
    onError: (e: any) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: (b: BadaniaEntry) => patch(`/worker-badania/${b.id}`, { deducted: !b.deducted }),
    onSuccess: inv, onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/worker-badania/${id}`),
    onSuccess: inv, onError: (e: any) => toast.error(e.message),
  });
  const fmtD = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  return (
    <InfoRow icon={IdCard} label={t("Залічки за бадання")}>
      {entries.map(b => (
        <span key={b.id} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-1.5 py-0.5">
          <span className="font-medium text-slate-700">{b.amount} зл</span>
          <span className="text-xs text-slate-400" title={`${t("вписано")} ${b.enteredAt}`}>{fmtD(b.enteredAt)}</span>
          <button title={t("Клікни, щоб перемкнути")} onClick={() => toggle.mutate(b)}>
            {b.deducted
              ? <Badge color="green">{t("знято")}{b.deductedAt ? ` ${fmtD(b.deductedAt)}` : ""}</Badge>
              : <Badge color="rose">{t("ще ні")}</Badge>}
          </button>
          <button title={t("Видалити")} className="text-slate-300 hover:text-rose-500"
            onClick={async () => { if (await confirm({ title: t("Видалити залічку за бадання?"), message: `${b.amount} зл · ${b.enteredAt}`, danger: true, confirmText: t("Видалити") })) remove.mutate(b.id); }}>✕</button>
        </span>
      ))}
      {adding ? (
        <span className="flex items-center gap-1">
          <input type="number" min={0} value={draft} onChange={e => setDraft(e.target.value)} autoFocus
            onKeyDown={e => { if (e.key === "Enter" && Number(draft) > 0) add.mutate(); }}
            className="w-20 rounded border border-slate-300 px-1 py-0.5 text-xs" placeholder={t("сума")} />
          <button className="text-xs font-medium text-emerald-600" onClick={() => Number(draft) > 0 && add.mutate()}>{t("Зберегти")}</button>
          <button className="text-xs text-slate-400" onClick={() => { setAdding(false); setDraft(""); }}>{t("Скасувати")}</button>
        </span>
      ) : (
        <button className="text-xs font-medium text-slate-400 hover:text-red-600" onClick={() => setAdding(true)}>+ {t("додати")}</button>
      )}
    </InfoRow>
  );
}

function BirthDateRow({ workerId, birthDate, under26Fallback, onRequest }: { workerId: number; birthDate: string | null; under26Fallback?: boolean | null; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(birthDate ?? "");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { birthDate: draft || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  // Дата народження впливає на сводні (пільга «до 26»: нетто студента = брутто),
  // тож іде через модалку превʼю — без неї рядки сводної лишались зі старим
  // under26, і студента до 26 система «не бачила» до пересейву статусу.
  // Дату набуття модалка НЕ питає: дата народження — факт, діє по всіх місяцях.
  const submit = () => {
    if (onRequest) { onRequest({ birthDate: draft || null }, t("Дата народження")); setEditing(false); }
    else save.mutate();
  };
  // вік — окрема властивість (не форма легалізації): з дати, без дати — з профілю
  const under26 = birthDate ? new Date(birthDate + "T00:00:00").getTime() > Date.now() - 26 * 365.25 * 86400000 : under26Fallback ?? null;
  return (
    <InfoRow icon={Cake} label={t("Дата народження")}>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="date" value={draft} onChange={e => setDraft(e.target.value)}
            className="rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={submit}>{t("Зберегти")}</button>
          <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
        </span>
      ) : (
        <button className="font-medium text-slate-700 hover:text-red-600" onClick={() => { setDraft(birthDate ?? ""); setEditing(true); }}>
          {birthDate ? new Date(birthDate + "T00:00:00").toLocaleDateString("uk-UA") : t("вказати")}
          {under26 != null && <span className={under26 ? "ml-1 rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-700" : "ml-1 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500"}>{under26 ? "<26" : "26+"}</span>}
        </button>
      )}
    </InfoRow>
  );
}

// Дата працевлаштування (усі працівники); на фабриках Agram від неї
// автоматично рахується стаж-бонус до ставки нетто
// readOnly: без доступу до кшєнгових даних (svodniSensitive) дата видима, але не редагується
function EmploymentDateRow({ workerId, date, readOnly, onRequest }: { workerId: number; date: string | null; readOnly?: boolean; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(date ?? "");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { employmentStartDate: draft || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const submit = () => {
    if (onRequest) { onRequest({ employmentStartDate: draft || null }, t("Дата працевлаштування")); setEditing(false); }
    else save.mutate();
  };
  return (
    <InfoRow icon={Briefcase} label={t("Дата працевлаштування")}>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="date" value={draft} onChange={e => setDraft(e.target.value)}
            className="rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={submit}>{t("Зберегти")}</button>
          <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
        </span>
      ) : readOnly ? (
        <span className="font-medium text-slate-700">
          {date ? new Date(date + "T00:00:00").toLocaleDateString("uk-UA") : "—"}
        </span>
      ) : (
        <button className="font-medium text-slate-700 hover:text-red-600" onClick={() => { setDraft(date ?? ""); setEditing(true); }}>
          {date ? new Date(date + "T00:00:00").toLocaleDateString("uk-UA") : t("вказати")}
        </button>
      )}
    </InfoRow>
  );
}

// Бонуси Agram (лише працівники фабрик Agram): галочки профілю. Сума стажу
// рахується автоматично від дати працевлаштування (+1 від 1 міс, +1.5 від 6;
// без дати — +1); нал — фіксований +1 зл/год до ставки нетто.
function AgramBonusRow({ workerId, staz, cash, startDate, cashOnly, onRequest }: { workerId: number; staz: boolean; cash: boolean; startDate: string | null; cashOnly?: boolean; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (p: { agramStazBonus?: boolean; agramCashBonus?: boolean }) => patch(`/workers/${workerId}`, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const groupLabel = cashOnly ? t("Бонус фабрики") : t("Бонуси Agram");
  const submit = (p: { agramStazBonus?: boolean; agramCashBonus?: boolean }) =>
    onRequest ? onRequest(p, groupLabel) : save.mutate(p);
  // поточний ярус стажу — на кінець поточного місяця (як рахує сводна)
  const stazRate = (() => {
    if (!startDate) return 1;
    // дзеркало серверного правила: дні стажу на кінець поточного місяця
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 12);
    const days = Math.round((end.getTime() - new Date(startDate + "T12:00:00").getTime()) / 86400000);
    return days >= 60 ? 1.5 : days >= 30 ? 1 : 0;
  })();
  return (
    <InfoRow icon={BadgePlus} label={groupLabel}>
      {!cashOnly && (
        <label className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-700">
          <input type="checkbox" checked={staz} onChange={e => submit({ agramStazBonus: e.target.checked })} />
          {t("Стаж")}
          <span className="text-xs text-slate-400" title={t("Стаж авто від дати: +1 зл/год від 30 днів, +1.5 від 60 (лише при 160+ год у місяці); без дати — +1")}>
            {staz ? `+${stazRate} zł/${t("год")}` : "+1…1.5"}{staz && !startDate ? ` · ${t("без дати")}` : ""}
          </span>
        </label>
      )}
      <label className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-700">
        <input type="checkbox" checked={cash} onChange={e => submit({ agramCashBonus: e.target.checked })} />
        {t("Частина ЗП налом")}
        <span className="text-xs text-slate-400">+1 zł/{t("год")}</span>
      </label>
    </InfoRow>
  );
}

// ─── Зміни з датою набуття: модалка превʼю + словники — components/ProfileChangeModal ──
// Хостел: історія проживань (hostel_stays) — де живе, з якої дати, скільки платить.
// Керування — на сторінці /hostels; тут лише перегляд (cap svodni).
function WorkerHostel({ workerId }: { workerId: number }) {
  const t = useT();
  const { data: stays } = useQuery<{
    stayId: number; hostelId: number; hostelName: string; city: string;
    fromDate: string; toDate: string | null; monthlyRate: number | null; note: string | null;
  }[]>({ queryKey: ["worker-hostel", workerId], queryFn: () => get(`/hostels/worker/${workerId}`) });
  if (!stays?.length) return null;
  const fmtD = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
  return (
    <Section icon={Home} title={t("Хостел")}
      action={<Link href="/hostels" className="text-xs text-slate-400 hover:text-red-600 hover:underline">{t("до хостелів")} →</Link>}>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-100">
          {[...stays].reverse().map(s => (
            <tr key={s.stayId} className="hover:bg-slate-50">
              <td className="px-4 py-1.5 font-medium text-slate-700">
                {s.hostelName} <span className="font-normal text-slate-400">· {t(s.city)}</span>
                {!s.toDate && <span className="ml-2"><Badge color="green">{t("живе")}</Badge></span>}
              </td>
              <td className="px-4 py-1.5 text-slate-500">{fmtD(s.fromDate)} — {s.toDate ? fmtD(s.toDate) : "…"}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-slate-600">{s.monthlyRate != null ? `${s.monthlyRate.toFixed(2)} zł/${t("міс")}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

// Одяг: видане (з магазину або вручну), вартість «маємо зняти» / фактично
// знято (місяць сводної), повернення на склад. Магазин і склад — сторінка /clothing.
type WorkerClothingItem = {
  id: number; itemType: string; size: string | null; condition: string | null; ownership: string | null;
  price: number | null; deducted: boolean; deductedAmount: number | null; deductedMonth: string | null;
  writtenOff: boolean; issuedAt: string | null; returnedAt: string | null; periodMonth: string | null; note: string | null;
};
type ClothingStockRow = { id: number; itemType: string; name: string | null; size: string | null; condition: string; price: number | null; qty: number; isActive: boolean };

function WorkerClothing({ workerId }: { workerId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { labelOf } = useClothingTypes();
  const [issuing, setIssuing] = useState(false);
  const [returning, setReturning] = useState<WorkerClothingItem | null>(null);
  const { data } = useQuery<{ rows: WorkerClothingItem[] }>({
    queryKey: ["worker-clothing", workerId], queryFn: () => get(`/clothing?workerId=${workerId}`),
  });
  const inv = () => { qc.invalidateQueries({ queryKey: ["worker-clothing", workerId] }); qc.invalidateQueries({ queryKey: ["clothing-stock"] }); };
  const rows = data?.rows ?? [];
  const fmtD = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
  // Нічого не видавалось — секція взагалі не рендериться (менше інфи в
  // профілі); видати перший одяг усе одно можна зі сторінки /clothing.
  if (!rows.length) return null;
  return (
    <>
    <Section icon={Shirt} title={t("Одяг")} empty={t("Одяг не видавався")}
      action={<>
        <Link href="/clothing" className="text-xs text-slate-400 hover:text-red-600 hover:underline">{t("до магазину")} →</Link>
        <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => setIssuing(true)}><Plus className="h-3.5 w-3.5" /> {t("Видати")}</Button>
      </>}>
      {!rows.length ? null : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-130 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2">{t("Що")}</th><th className="px-3 py-2">{t("Видано")}</th>
                <th className="px-3 py-2">{t("Повернуто")}</th><th className="px-3 py-2 text-right">{t("Маємо зняти")}</th>
                <th className="px-3 py-2">{t("Фактично знято")}</th><th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(i => (
                <tr key={i.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-700">
                    {t(labelOf(i.itemType))}
                    {i.size && <span className="ml-1 text-slate-400">· {i.size}</span>}
                    {i.condition && <span className="ml-1.5 align-middle">{i.condition === "new" ? <Badge color="blue">{t("новий")}</Badge> : <Badge color="slate">{t("БУ")}</Badge>}</span>}
                    {i.writtenOff && <span className="ml-1.5 align-middle"><Badge color="slate">{t("списано")}</Badge></span>}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{i.issuedAt ? fmtD(i.issuedAt) : i.periodMonth ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{i.returnedAt ? fmtD(i.returnedAt) : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{i.price != null ? `${i.price.toFixed(2)} зл` : "—"}</td>
                  <td className="px-3 py-2">
                    {i.deducted
                      ? <Badge color="green">{(i.deductedAmount ?? i.price)?.toFixed(2)} зл{i.deductedMonth ? ` · ${i.deductedMonth}` : ""}</Badge>
                      : i.returnedAt ? <span className="text-xs text-slate-400">{t("повернуто без зняття")}</span>
                      : i.price != null ? <Badge color="rose">{t("ще ні")}</Badge> : "—"}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {!i.returnedAt && (
                      <button className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        onClick={() => setReturning(i)}>
                        ↩ {t("Повернення")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
    {issuing && <IssueClothingModal workerId={workerId} onClose={() => setIssuing(false)} onSaved={() => { inv(); setIssuing(false); }} />}
    {returning && (
      <ReturnClothingModal itemId={returning.id} label={`${t(labelOf(returning.itemType))}${returning.size ? ` · ${returning.size}` : ""}`}
        onClose={() => setReturning(null)} onSaved={() => { inv(); setReturning(null); }} />
    )}
  </>
  );
}

// Повернення на склад: дата + стан, у якому річ вертається (нове чи БУ).
// Типово БУ — ношене нове стає вживаним; нерозпаковане можна повернути новим.
export function ReturnClothingModal({ itemId, label, onClose, onSaved }: {
  itemId: number; label: string; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [date, setDate] = useState(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }));
  const [condition, setCondition] = useState<"used" | "new">("used");
  const save = useMutation({
    mutationFn: () => post(`/clothing/${itemId}/return`, { date, condition }),
    onSuccess: () => { toast.success(t("Повернуто на склад")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Прийняти повернення?")}>
      <div className="space-y-3">
        <div className="text-sm text-slate-600">{label}</div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Дата повернення")}</Label><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
          <div><Label>{t("Повертається як")}</Label>
            <Select value={condition} onChange={e => setCondition(e.target.value as "used" | "new")}>
              <option value="used">{t("БУ")}</option>
              <option value="new">{t("новий")}</option>
            </Select>
          </div>
        </div>
        <p className="text-xs text-slate-400">{t("Річ додасться на склад у вибраному стані. Незняту вартість більше не буде видно у «до зняття».")}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>{t("Повернути")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Видача зі складу: з фіксованим працівником (профіль) або з вибором (сторінка «Одяг»)
export function IssueClothingModal({ workerId, onClose, onSaved }: { workerId?: number; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { data: stock = [] } = useQuery<ClothingStockRow[]>({ queryKey: ["clothing-stock"], queryFn: () => get("/clothing/stock") });
  const available = stock.filter(s => s.isActive && s.qty > 0);
  const [stockId, setStockId] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }));
  const [note, setNote] = useState("");
  const [pickedWorker, setPickedWorker] = useState("");
  const { data: workers = [] } = useQuery<{ id: number; fullName: string }[]>({
    queryKey: ["workers-light"], queryFn: () => get("/workers"), enabled: workerId == null,
  });
  const targetWorkerId = workerId ?? (pickedWorker ? Number(pickedWorker) : null);
  const { labelOf } = useClothingTypes();
  const sel = available.find(s => String(s.id) === stockId);
  const stockLabel = (s: ClothingStockRow) =>
    `${t(labelOf(s.itemType))}${s.name ? ` ${s.name}` : ""}${s.size ? ` · ${s.size}` : ""} · ${s.condition === "new" ? t("новий") : t("БУ")}${s.price != null ? ` · ${s.price.toFixed(2)} зл` : ""} · ${s.qty} ${t("шт")}`;
  const save = useMutation({
    mutationFn: () => post("/clothing/issue", {
      stockId: Number(stockId), workerId: targetWorkerId,
      ...(price.trim() !== "" ? { price: Number(price) } : {}), date, note,
    }),
    onSuccess: () => { toast.success(t("Видано")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Видати одяг зі складу")}>
      <div className="space-y-3">
        {workerId == null && (
          <div><Label>{t("Працівник")}</Label>
            <Select value={pickedWorker} onChange={e => setPickedWorker(e.target.value)}>
              <option value="">—</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.fullName}</option>)}
            </Select></div>
        )}
        <div><Label>{t("Позиція складу")}</Label>
          <Select value={stockId} onChange={e => { setStockId(e.target.value); setPrice(""); }}>
            <option value="">—</option>
            {available.map(s => <option key={s.id} value={s.id}>{stockLabel(s)}</option>)}
          </Select>
          {!available.length && <p className="mt-1 text-xs text-amber-600">{t("Склад порожній — додай позиції на сторінці «Одяг» → «Магазин».")}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Ціна зняття, зл")}</Label>
            <Input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder={sel?.price != null ? String(sel.price) : "0"} />
          </div>
          <div><Label>{t("Дата видачі")}</Label><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
        </div>
        <div><Label>{t("Нотатка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => stockId && targetWorkerId != null && save.mutate()}>{t("Видати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Історія змін профілю: журнал worker_changes (хто/що/коли, з якої дати діє)
function ChangesTimeline({ workerId, canUndo }: { workerId: number; canUndo?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  // «видалити зміну»: сервер повертає попереднє значення, перераховує зачеплені
  // сводні від дати набуття і зносить запис із журналу
  const removeChange = useMutation({
    mutationFn: (id: number) => del(`/svodni/profile-change/${id}`),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["worker"] });
      qc.invalidateQueries({ queryKey: ["worker-changes"] });
      qc.invalidateQueries({ queryKey: ["svodni"] });
      toast.success(r?.skippedLocked?.length
        ? t("Зміну видалено; затверджені місяці не чіпались: {m}", { m: r.skippedLocked.map((x: any) => x.month).join(", ") })
        : t("Зміну видалено, значення повернуто"));
    },
    onError: (e: any) => toast.error(e.message),
  });
  const { data: changes = [] } = useQuery<{
    id: number; field: string; oldValue: string | null; newValue: string | null;
    effectiveDate: string; appliedRows: { month: string }[] | null;
    skippedLocked: { month: string }[] | null; adminName: string | null; createdAt: string;
  }[]>({ queryKey: ["worker-changes", workerId], queryFn: () => get(`/workers/${workerId}/changes`) });
  // журнал зберігає id — для показу підтягуємо назви фабрик/посад
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: positions = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["positions"], queryFn: () => get("/positions") });
  const showVal = (field: string, v: string | null): string => {
    if (v == null || v === "") return "—";
    if (field === "factoryId") return factories.find(f => String(f.id) === v)?.name ?? v;
    if (field === "positionId") return positions.find(p => String(p.id) === v)?.name ?? v;
    return fmtVal(v, t);
  };
  if (!changes.length) return null;
  return (
    <Section icon={History} title={t("Історія змін")}>
      <div className="max-h-80 divide-y divide-slate-100 overflow-auto">
        {changes.map(c => (
          <div key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-5 py-2 text-sm">
            <span className="font-medium text-slate-700">{t(CHANGE_FIELD_LABEL[c.field] ?? c.field)}:</span>
            <span className="text-slate-500">{showVal(c.field, c.oldValue)} → <span className="font-medium text-slate-700">{showVal(c.field, c.newValue)}</span></span>
            <span className="rounded bg-sky-50 px-1.5 text-xs font-medium text-sky-700">{t("діє з")} {c.effectiveDate}</span>
            {!!c.appliedRows?.length && <span className="rounded bg-emerald-50 px-1.5 text-xs text-emerald-700">{t("сводні: {n}", { n: c.appliedRows.length })}</span>}
            {!!c.skippedLocked?.length && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-700">🔒 {c.skippedLocked.map(s => s.month).join(", ")}</span>}
            <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-slate-400">
              {c.adminName ?? "—"} · {new Date(c.createdAt).toLocaleDateString("uk-UA")}
              {canUndo && !["fired", "restored"].includes(c.field) && (
                <button type="button"
                  title={t("Видалити зміну: значення повернеться до попереднього, сводні перерахуються, запис зникне з історії")}
                  onClick={async () => {
                    if (await confirm({
                      title: t("Видалити зміну?"),
                      message: `${t(CHANGE_FIELD_LABEL[c.field] ?? c.field)}: ${showVal(c.field, c.newValue)} → ${showVal(c.field, c.oldValue)}. ${t("Профіль і зачеплені сводні повернуться до попереднього стану.")}`,
                      confirmText: t("Видалити"),
                    })) removeChange.mutate(c.id);
                  }}
                  className="rounded p-0.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── Аванси працівника (гейт editData — як /advances) ─────────────────────────
function WorkerAdvances({ workerId }: { workerId: number }) {
  const t = useT();
  const { data } = useQuery<{
    paidTotal: number;
    rows: { id: number; amount: number; status: string; comment: string | null; factory: string | null; payoutMonth: string | null; payoutGroup: string | null; paidAt: string | null; paidMethod: string | null; svodniMonth: string | null; createdAt: string }[];
  }>({ queryKey: ["worker-advances", workerId], queryFn: () => get(`/workers/${workerId}/advances`) });
  const rows = data?.rows ?? [];
  const STATUS: Record<string, { label: string; color: "amber" | "blue" | "rose" | "green" }> = {
    pending: { label: t("На розгляді"), color: "amber" }, approved: { label: t("Передано до виплати"), color: "blue" },
    rejected: { label: t("Відхилено"), color: "rose" }, paid: { label: t("Виплачено"), color: "green" },
  };
  const fmtD = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "2-digit" });
  // Авансів не було — секція взагалі не рендериться (менше інфи в профілі).
  if (!rows.length) return null;
  return (
    <Section icon={Wallet} title={t("Аванси")} empty={t("Авансів ще не було")}
      extra={data != null && data.paidTotal > 0 ? <span className="text-xs text-slate-400">{t("виплачено разом")} <b className="text-slate-600">{data.paidTotal} zł</b></span> : undefined}
      action={<Link href="/advances" className="text-xs text-slate-400 hover:text-red-600 hover:underline">{t("до авансів")} →</Link>}>
      {!rows.length ? null : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => {
                const s = STATUS[r.paidAt ? "paid" : r.status] ?? STATUS.pending;
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-1.5 text-slate-500">{fmtD(r.paidAt ?? r.createdAt)}</td>
                    <td className="px-3 py-1.5 text-right font-medium tabular-nums text-slate-700">{r.amount} zł</td>
                    <td className="px-3 py-1.5 text-slate-500" title={r.comment ?? undefined}>{r.factory ?? "—"}</td>
                    <td className="px-3 py-1.5"><Badge color={s!.color}>{s!.label}</Badge></td>
                    <td className="px-3 py-1.5 text-right text-xs text-slate-400">
                      {r.svodniMonth ? `${t("у сводній")} ${r.svodniMonth}` : r.payoutMonth ? `${t("група")} ${r.payoutGroup ?? "—"} · ${r.payoutMonth}` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ─── Пропуски і штрафи працівника (всі затверджені тижні) ─────────────────────
function WorkerAbsences({ workerId }: { workerId: number }) {
  const t = useT();
  const { data } = useQuery<{
    total: number; justified: number; penaltyTotal: number;
    absences: { entryId: number; factory: string | null; date: string; shift: string; reason: string | null; excused: boolean; justified: boolean; penalty: number; deductedMonth: string | null; deductedAmount: number | null }[];
  }>({ queryKey: ["worker-absences", workerId], queryFn: () => get(`/workers/${workerId}/absences`) });
  const rows = data?.absences ?? [];
  return (
    <Section icon={UserX} title={t("Пропуски і штрафи")} empty={t("Пропусків немає")}
      extra={data != null && rows.length > 0 ? (
        <span className="text-xs text-slate-400">
          {data.total}{data.justified > 0 ? ` (+${data.justified} ${t("виправд.")})` : ""} · {t("штрафи")} <b className="text-slate-600">{data.penaltyTotal} zł</b>
        </span>
      ) : undefined}
      action={<Link href="/absences" className="text-xs text-slate-400 hover:text-red-600 hover:underline">{t("до відсутностей")} →</Link>}>
      {!rows.length ? null : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {rows.map(a => (
                <tr key={a.entryId} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-1.5 text-slate-500">{a.date}</td>
                  <td className="px-3 py-1.5 text-slate-500">{a.factory ?? "—"} · {a.shift} {t("зм")}</td>
                  <td className="px-3 py-1.5">
                    {a.justified ? <Badge color="green">{t("виправдано")}</Badge>
                      : a.excused ? <Badge color="amber">{t("відпросився")}</Badge>
                      : <Badge color="rose">{t("не вийшов")}</Badge>}
                    {a.reason && <span className="ml-1.5 text-xs text-slate-400" title={a.reason}>{a.reason.length > 24 ? a.reason.slice(0, 24) + "…" : a.reason}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {a.penalty > 0 ? <span className="font-medium text-rose-600">−{a.penalty} zł</span> : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs text-slate-400">{a.deductedMonth ? `${t("у сводній")} ${a.deductedMonth}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ─── Сводна по місяцях (cap svodni; konto/готівка є в відповіді лише з svodniSensitive) ──
function WorkerSvodni({ workerId }: { workerId: number }) {
  const t = useT();
  type Row = { id: number; month: string; city: string; firm: string | null; factoryLabel: string; hours: number | null; shifts: number | null; rateNetto: number | null; premia: number | null; zaliczka: number | null; kara: number | null; doWyplaty: number | null; gotowka?: number | null; konto?: number | null };
  const { data: rows = [] } = useQuery<Row[]>({ queryKey: ["worker-svodni", workerId], queryFn: () => get(`/workers/${workerId}/svodni`) });
  const sensitive = rows.length > 0 && "konto" in rows[0]!;
  const num = (v: number | null | undefined) => v == null || v === 0 ? <span className="text-slate-300">—</span> : <span className="tabular-nums">{Math.round(v * 100) / 100}</span>;
  return (
    <Section icon={Activity} title={t("Сводна по місяцях")} empty={t("Рядків сводної ще немає")}
      action={<Link href="/svodni" className="text-xs text-slate-400 hover:text-red-600 hover:underline">{t("до сводних")} →</Link>}>
      {!rows.length ? null : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full min-w-130 text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2">{t("Місяць")}</th><th className="px-3 py-2">{t("Фабрика")}</th>
                <th className="px-3 py-2 text-right">{t("Год")}</th><th className="px-3 py-2 text-right">{t("Ставка")}</th>
                <th className="px-3 py-2 text-right">{t("До виплати")}</th>
                <th className="px-3 py-2 text-right">Premia</th><th className="px-3 py-2 text-right">Zaliczka</th>
                <th className="px-3 py-2 text-right">Kara</th>
                {sensitive && <th className="px-3 py-2 text-right">Konto</th>}
                {sensitive && <th className="px-3 py-2 text-right">{t("Готівка")}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-1.5 font-medium text-slate-700">{r.month}</td>
                  <td className="px-3 py-1.5 text-slate-500" title={`${r.city}${r.firm ? ` · ${r.firm}` : ""}`}>{r.factoryLabel}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{num(r.hours)}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{num(r.rateNetto)}</td>
                  <td className="px-3 py-1.5 text-right font-medium text-emerald-700">{num(r.doWyplaty)}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{num(r.premia)}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{num(r.zaliczka)}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{num(r.kara)}</td>
                  {sensitive && <td className="px-3 py-1.5 text-right text-slate-600">{num(r.konto)}</td>}
                  {sensitive && <td className="px-3 py-1.5 text-right text-slate-600">{num(r.gotowka)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

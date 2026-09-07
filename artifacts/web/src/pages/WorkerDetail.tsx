import { useEffect, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Factory as FactoryIcon, Send, Clock, CalendarCheck, UserX, Activity, Gift,
  FileText, Plus, Pencil, Trash2, ExternalLink, AlertTriangle, Briefcase, Users, Upload, Car, Cake, IdCard, Wallet, BadgePlus, History, Home, KeyRound, Shirt, ShieldCheck, FileSignature, ChevronDown, ChevronUp, ChevronRight, Ban, Eye, Scale, RefreshCw, XCircle,
  Download, Printer, Mail, ScanLine, UserCheck,
} from "lucide-react";
import { SendFileModal, printFile } from "../components/SendFileModal";
import { ResidenceCardScanModal } from "../components/ResidenceCardScanModal";
import { ProfileChangeModal, CHANGE_FIELD_LABEL, PAYOUT_PREF_LABEL, fmtVal, type RequestChange } from "../components/ProfileChangeModal";
import { DocumentAuditModal } from "../components/DocumentAuditModal";
import { can } from "../lib/roles";
import { LEGAL_STATUSES, LEGAL_LABEL, LEGAL_BADGE, type LegalStatus } from "../lib/legalStatus";
import {
  get, post, put, patch, del, upload,
  type DocumentType, type WorkerDocument, type Worker, type Factory, type Company, type Gender,
  type WorkerLegality, type LegalityReason, type CaseStatus, type LegalizationGlobals, type WorkerFactory,
} from "../lib/api";
import {
  LEGALITY_LABEL, LEGALITY_BADGE, LEGALITY_DOT, AXIS_LABEL, CASE_STATUS_LABEL, DOC_CATEGORY_LABEL,
  MISMATCH_LABEL, REQUIRED_MISSING_LABEL, NAT_GROUP_LABEL, reasonText, daysUntil,
} from "../lib/legality";
import { fieldsFor, typeMatchesNationality, isEuNationality, type DocField, type DocFieldKey } from "../lib/documentFields";
import { Button, Card, Spinner, Badge, Empty, Modal, Input, Select, Label, SearchableSelect, Textarea } from "../components/ui";
import { AbsenceFiles } from "../components/AbsenceFiles";
import { WorkerTasksBlock, WorkerUpcomingEvents } from "../components/TasksWidgets";
import { WorkerModal } from "../components/WorkerModal";
import { FireModal } from "./Workers";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { useLeadDays, expiryTone, expiryTextCls, leadDaysCache } from "../lib/leadDays";
import { useT } from "../lib/i18n";
import { badgeClass, dotClass, genderIcon, genderClass } from "../lib/colors";
import { NatFlag, NATIONALITIES, natLabel } from "../lib/nationality";
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
  firstWorkDate?: string | null;   // перший робочий день (авто з першої явки / графікова)
  terminationDate?: string | null; // запланована дата звільнення (виповідзення)
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
  // повернення звільненого прямо з профілю (той самий POST, що й у списку)
  const confirmDlg = useConfirm();
  const [firing, setFiring] = useState(false);
  const fire = useMutation({
    mutationFn: (v: { offerReport: boolean; date: string }) => post<{ reportOffered?: boolean }>(`/workers/${id}/fire`, v),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["worker", id] }); qc.invalidateQueries({ queryKey: ["workers"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setFiring(false); toast.success(t("Працівника звільнено"), { description: r?.reportOffered ? t("Пропозицію здати рапорт надіслано в бот") : undefined }); },
    onError: (e: any) => toast.error(e.message),
  });
  const restore = useMutation({
    mutationFn: () => post(`/workers/${id}/restore`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker", id] }); qc.invalidateQueries({ queryKey: ["workers"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); toast.success(t("Відновлено")); },
    onError: (e: any) => toast.error(e.message),
  });
  // зміна з датою набуття: свод-релевантні поля відкривають модалку «від коли +
  // що зачепить» замість прямого PATCH (лише для користувачів з cap svodni)
  const canSvodni = can(me, "svodni");
  // viewWorkers-only (напр. бухгалтерія): бачить картку, інлайн-поля — нередаговані
  const canEdit = can(me, "editData");
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
      {/* ?from=/schedule?week=… — повернення у графік, звідки клікнули по імені
          (тільки внутрішні шляхи, без відкритого редиректу) */}
      {(() => {
        const from = new URLSearchParams(window.location.search).get("from") ?? "";
        const isSchedule = from.startsWith("/schedule");
        return (
          <Link href={isSchedule ? from : "/workers"} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft className="h-4 w-4" /> {isSchedule ? t("До графіку") : t("До працівників")}
          </Link>
        );
      })()}

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
              {w.isActive && w.terminationDate && <Badge color="amber">{t("звільнення з")} {fmtDocDate(w.terminationDate)}</Badge>}
              {w.isActive && canEdit && (
                <button type="button" onClick={() => setFiring(true)} className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-100">
                  <UserX className="h-3.5 w-3.5" /> {t("Звільнити")}
                </button>
              )}
              {!w.isActive && (
                <button type="button" onClick={async () => {
                  if (await confirmDlg({ title: t("Відновити працівника?"), message: t("Профіль знову стане активним, історія і документи збережуться."), confirmText: t("Відновити") })) restore.mutate();
                }} className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100" disabled={restore.isPending}>
                  <UserCheck className="h-3.5 w-3.5" /> {t("Відновити")}
                </button>
              )}
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
              <WorkerFactoriesChips workerId={w.id} factories={factories} companies={companies} primaryFactoryId={w.factoryId} />
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
          {canEdit && <Button variant="secondary" className="ml-auto shrink-0" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> {t("Редагувати")}</Button>}
        </div>

        <div className="grid grid-cols-1 divide-y divide-slate-100 border-t border-slate-100 md:grid-cols-3 md:divide-x md:divide-y-0">
          <InfoGroup title={t("Робота")}>
            {/* Фірма/фабрика/стать — у шапці профілю (badge-select), не дублюємо рядками (редизайн 09.2026) */}
            <InfoRow icon={Briefcase} label={t("Посада")}>
              <InlineSelect value={w.positionId != null ? String(w.positionId) : ""}
                onChange={v => { const p = v ? Number(v) : null; if (requestChange) requestChange({ positionId: p }, t("Посада")); else wpatch.mutate({ positionId: p }); }}
                options={posOptions} disabled={!canEdit} />
            </InfoRow>
            <InfoRow icon={CalendarCheck} label={t("Закріплена зміна")}>
              <InlineSelect value={w.fixedShift ?? ""} none={t("— немає —")} onChange={v => wpatch.mutate({ fixedShift: v || null })}
                options={["1", "2", "3"].map(s => ({ value: s, label: t("{n} зміна", { n: s }) }))} disabled={!canEdit} />
            </InfoRow>
            <InfoRow icon={Car} label={t("Транспорт")}>
              <InlineSelect value={w.selfTransport ? "self" : ""} none={t("Возить фірма")} onChange={v => wpatch.mutate({ selfTransport: v === "self" })}
                options={[{ value: "self", label: t("Доїжджає сам") }]} disabled={!canEdit} />
              {w.selfTransport && (
                canEdit ? (
                  <input type="date" value={w.selfTransportSince ?? ""} title={t("з")}
                    onChange={e => wpatch.mutate({ selfTransportSince: e.target.value || null })}
                    className="rounded border border-slate-200 px-1 py-0.5 text-xs text-slate-500" />
                ) : w.selfTransportSince ? <span className="text-xs text-slate-400">{t("з")} {w.selfTransportSince}</span> : null
              )}
            </InfoRow>
            {(w.factoryCodes ?? []).length > 0 && (
              <Info icon={KeyRound} label={t("Ключі фабрики")}
                value={w.factoryCodes!.map(c => `${c.code}${c.factoryName ? ` (${c.factoryName})` : ""}`).join(", ")} />
            )}
            {/* Дата працевлаштування й поріг «нагадати про години» — про роботу
                й графік, не про гроші; перенесено з «Фінанси» для балансу колонок. */}
            <EmploymentDateRow workerId={w.id} date={w.employmentStartDate ?? null} readOnly={w.payoutPrefKind === undefined} onRequest={requestChange} />
            <FirstWorkDateRow workerId={w.id} date={w.firstWorkDate ?? null} readOnly={!canEdit} />
            {w.isActive && <TerminationRow workerId={w.id} date={w.terminationDate ?? null} readOnly={!canEdit} />}
            <NotifyHoursRow workerId={w.id} notifyHours={w.notifyHours ?? null} onRequest={requestChange} />
          </InfoGroup>
          <InfoGroup title={t("Особисте")}>
            <BirthDateRow workerId={w.id} birthDate={w.birthDate ?? null} under26Fallback={w.under26 ?? null} onRequest={requestChange} />
            {/* Порожні PESEL/друге ім'я — не показуємо рядок (менше інфи в профілі);
                заповнити все одно можна через «Редагувати» (WorkerModal). */}
            {w.pesel && (
              <InfoRow icon={KeyRound} label="PESEL">
                <InlineText value={w.pesel} placeholder={t("вказати")} width="w-32" onSave={v => wpatch.mutate({ pesel: v.trim() || null })} disabled={!canEdit} />
              </InfoRow>
            )}
            {w.middleName && (
              <InfoRow icon={IdCard} label={t("Друге ім'я")}>
                <InlineText value={w.middleName} placeholder={t("необов'язково")} width="w-32" onSave={v => wpatch.mutate({ middleName: v.trim() || null })} disabled={!canEdit} />
              </InfoRow>
            )}
            <LegalStatusRow workerId={w.id} legalStatus={(w.legalStatus as LegalStatus | null) ?? null} onRequest={requestChange} />
            <InfoRow icon={Users} label={t("Національність")}>
              <InlineSelect value={w.nationality ?? ""} onChange={v => wpatch.mutate({ nationality: v || null })}
                options={NATIONALITIES.map(n => ({ value: n.value, label: `${n.flag} ${t(n.label)}` }))} disabled={!canEdit} />
            </InfoRow>
            <InfoRow icon={Send} label="Telegram">
              <InlineText value={w.telegramId ?? ""} placeholder={t("не приєднаний")} width="w-32" onSave={v => wpatch.mutate({ telegramId: v.trim() || null })} disabled={!canEdit} />
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
                <InlineText value={w.gratyfikantName} placeholder={t("вказати")} width="w-44" onSave={v => wpatch.mutate({ gratyfikantName: v.trim() || null })} disabled={!canEdit} />
              </InfoRow>
            )}
          </InfoGroup>
        </div>
        {w.note !== undefined && <NoteBlock workerId={w.id} note={w.note ?? null} />}
      </Card>

      {/* Секції у дві колонки на широких екранах: ліворуч — активність, праворуч — облікові блоки */}
      {/* Легалізація і документи — один блок на всю ширину одразу під шапкою (рішення власника 03.09.2026) */}
      <div className="mb-5 space-y-5">
        <WorkerDocuments workerId={w.id} companies={companies} nationality={w.nationality ?? null} factoryId={w.factoryId} />
        {/* Умови — теж на всю ширину, одразу під легалізацією (рішення власника 05.09.2026) */}
        {can(me, "workerDocs") && <WorkerContracts workerId={w.id} factoryId={w.factoryId} factories={factories} />}
      </div>

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
          <WorkerUpcomingEvents workerId={w.id} factoryId={w.factoryId} />
          <WorkerTasksBlock workerId={w.id} factoryId={w.factoryId} />
          <WorkerBankAccounts workerId={w.id} />
          <WorkerAdvances workerId={w.id} />
          <WorkerAbsences workerId={w.id} />
          {/* Хостел: де живе і скільки платить (довідник — сторінка /hostels) */}
          {canSvodni && <WorkerHostel workerId={w.id} />}
          {/* Одяг: видане зі складу магазину, вартість/зняття, повернення */}
          <WorkerClothing workerId={w.id} />
        </div>
      </div>

      {firing && <FireModal worker={{ fullName: w.fullName, telegramId: w.telegramId }} loading={fire.isPending} onClose={() => setFiring(false)} onFire={(offerReport, date) => fire.mutate({ offerReport, date })} />}
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
function InlineText({ value, placeholder, width = "w-40", onSave, disabled }: { value: string; placeholder: string; width?: string; onSave: (v: string) => void; disabled?: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => { onSave(draft); setEditing(false); };
  if (disabled) return (
    <span className="max-w-full truncate font-medium text-slate-700" title={value || undefined}>
      {value || <span className="font-normal text-slate-400">{placeholder}</span>}
    </span>
  );
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
function InlineSelect({ value, options, onChange, none = "—", disabled }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; none?: string; disabled?: boolean }) {
  if (disabled) return (
    <span className="max-w-full truncate text-sm font-medium text-slate-700">{options.find(o => o.value === value)?.label ?? none}</span>
  );
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
  companyId: number | null; factoryName: string | null; companyName: string | null;
  files: { id: number; title: string; signed: boolean }[];
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
// Блок «Умови» (перероблено 05.09.2026 за зауваженням власника: «чинні й архів
// окремо, вигляд як в аналогічних системах»). Патерн Personio/BambooHR/HRappka:
// одна картка на роботодавця (фабрика · фірма) з ЧИННОЮ умовою, статусом,
// періодом, підписами і документами пакета; усе скасоване/замінене/прострочене —
// згорнутий «Архів» з лічильником. Фабрики працівника без чинної умови теж
// показуються карткою-заглушкою «немає чинної умови → Згенерувати», бо саме
// це підсвічує вісь «умова» движка легальності.
const CONTRACT_ARCHIVE_STATUSES = new Set(["declined", "cancelled", "superseded", "expired"]);
const CONTRACT_IN_PROGRESS = new Set(["draft", "pending_approval", "approved", "sent", "viewed", "worker_signed"]);
const isCurrentContract = (c: ContractSummary, today: string) =>
  !CONTRACT_ARCHIVE_STATUSES.has(c.status) && !(c.status === "signed" && !!c.dateTo && c.dateTo < today);
const fmtTs = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtPeriod = (c: { dateFrom: string | null; dateTo: string | null }) =>
  c.dateFrom ? `${fmtDocDate(c.dateFrom)} – ${c.dateTo ? fmtDocDate(c.dateTo) : "∞"}` : null;

type EmployerRef = { factoryId: number; factoryName: string; companyId: number | null; companyName: string | null; primary: boolean };

// Значення селекта «фабрика · фірма» одним кроком: звичайна фабрика — "12",
// мультифірмова (Sushi) — "21:3" (по рядку на кожну нашу фірму). Один список
// замість двох послідовних селектів (зауваження власника 05.09.2026).
type EmployerOption = { value: string; label: string; factoryId: number; companyId: number | null };
function employerOptions(factories: Factory[], allCompanies: Company[]): EmployerOption[] {
  const out: EmployerOption[] = [];
  const companies = allCompanies.filter(c => c.employsWorkers !== false); // RS/TS (JDG власників) умов не укладають
  for (const f of factories) {
    if (f.multiFirm) {
      for (const c of companies) out.push({ value: `${f.id}:${c.id}`, label: `${f.name} · ${c.name}`, factoryId: f.id, companyId: c.id });
    } else {
      const cn = f.companyName ?? companies.find(c => c.id === f.companyId)?.name ?? null;
      out.push({ value: String(f.id), label: cn ? `${f.name} · ${cn}` : f.name, factoryId: f.id, companyId: f.companyId ?? null });
    }
  }
  return out;
}
const employerValue = (factoryId: number | null, companyId: number | null, factories: Factory[]) => {
  if (factoryId == null) return "";
  const f = factories.find(x => x.id === factoryId);
  return f?.multiFirm && companyId != null ? `${factoryId}:${companyId}` : String(factoryId);
};

function WorkerContracts({ workerId, factoryId, factories }: { workerId: number; factoryId: number | null; factories: Factory[] }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: contracts = [], isLoading } = useQuery<ContractSummary[]>({ queryKey: ["worker-contracts", workerId], queryFn: () => get(`/workers/${workerId}/contracts`) });
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const { data: profile } = useQuery<{ companyId: number | null; companyName: string | null; factoryName: string | null }>({ queryKey: ["worker", String(workerId)], queryFn: () => get(`/workers/${workerId}`) });
  const { data: extraFactories = [] } = useQuery<WorkerFactory[]>({ queryKey: ["worker-factories", workerId], queryFn: () => get(`/workers/${workerId}/factories`) });
  // Вісь «умова» движка каже, на яку фабрику умови бракує — пропонуємо її в модалці генерації першою
  const { data: lgForSuggest } = useQuery<WorkerLegality | null>({ queryKey: ["worker-legality", workerId], queryFn: () => get(`/workers/${workerId}/legality`) });
  const suggestedFactoryId = (() => {
    const r = lgForSuggest?.reasons.find(x => (x.code === "contract_missing" || x.code === "contract_expired") && typeof x.params?.factoryId === "number");
    return r ? (r.params!.factoryId as number) : undefined;
  })();
  const [newFor, setNewFor] = useState<{ factoryId: number | null; companyId: number | null } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // deep-link з задачі («Як вирішити» → Згенерувати умову): /workers/:id?open=generate:<factoryId>
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("open")?.match(/^generate:(\d+)$/);
    if (m) setNewFor({ factoryId: Number(m[1]) || null, companyId: null });
  }, []);
  const inv = () => qc.invalidateQueries({ queryKey: ["worker-contracts", workerId] });

  const today = new Date().toLocaleDateString("sv-SE");
  const current = contracts.filter(c => isCurrentContract(c, today));
  const archive = contracts.filter(c => !isCurrentContract(c, today));
  const standard = current.filter(c => c.factoryId == null);
  const validStandard = standard.find(c => c.status === "worker_signed" || c.status === "signed");
  const byFactory = new Map<number, ContractSummary[]>();
  for (const c of current) if (c.factoryId != null) { const arr = byFactory.get(c.factoryId) ?? []; arr.push(c); byFactory.set(c.factoryId, arr); }

  // Роботодавці працівника: основна фабрика (фірма — з профілю) + активні додаткові
  const employers: EmployerRef[] = [];
  if (factoryId != null) {
    const f = factories.find(x => x.id === factoryId);
    const cid = f?.multiFirm ? (profile?.companyId ?? null) : (f?.companyId ?? profile?.companyId ?? null);
    employers.push({ factoryId, factoryName: f?.name ?? profile?.factoryName ?? `#${factoryId}`, companyId: cid, companyName: companies.find(c => c.id === cid)?.name ?? null, primary: true });
  }
  for (const r of extraFactories) {
    const inactive = (r.validFrom && r.validFrom > today) || (r.validTo && r.validTo < today);
    if (inactive || employers.some(e => e.factoryId === r.factoryId)) continue;
    employers.push({ factoryId: r.factoryId, factoryName: r.factoryName ?? `#${r.factoryId}`, companyId: r.companyId, companyName: r.companyName, primary: false });
  }
  const factoryIdsShown = new Set<number>([...employers.map(e => e.factoryId), ...byFactory.keys()]);
  const inProgressCount = current.filter(c => CONTRACT_IN_PROGRESS.has(c.status)).length;
  const signedCount = current.filter(c => c.status === "signed").length;
  const summary = [`${t("чинних")} ${signedCount}`, inProgressCount ? `${t("в роботі")} ${inProgressCount}` : null, archive.length ? `${t("архів")} ${archive.length}` : null].filter(Boolean).join(" · ");

  const openNew = (fid: number | null, cid: number | null) => setNewFor({ factoryId: fid, companyId: cid });
  const employerOf = (fid: number) => employers.find(e => e.factoryId === fid);

  return (
    <>
      <Section icon={FileSignature} title={t("Умови (Umowa)")} summary={summary}
        action={<>
          <WorkerQuestionnaire workerId={workerId} />
          <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => openNew(suggestedFactoryId ?? factoryId, null)}><Plus className="h-3.5 w-3.5" /> {t("Згенерувати документи")}</Button>
        </>}>
        {isLoading ? <div className="px-5 py-3"><Spinner /></div> : (
          <div className="divide-y divide-slate-100">
            {/* Сталий пакет — один рядок «підписаний / ні», деталі за розгортанням (підписується раз, спільний) */}
            <StandardPackageRow workerId={workerId} list={standard} onSaved={inv} onGenerate={() => openNew(null, null)} />
            {[...factoryIdsShown].map(fid => {
              const list = byFactory.get(fid) ?? [];
              const emp = employerOf(fid);
              const f = factories.find(x => x.id === fid);
              const companyName = emp?.companyName ?? list[0]?.companyName ?? null;
              return (
                <ContractChain key={fid} workerId={workerId}
                  title={f?.name ?? list[0]?.factoryName ?? `#${fid}`} companyName={companyName}
                  badge={emp?.primary ? t("основна") : emp ? t("додаткова") : t("не в списку фабрик")}
                  list={list} onSaved={inv}
                  emptyText={t("немає чинної умови")} emptyTone="warn"
                  onGenerate={() => openNew(fid, emp?.companyId ?? null)} />
              );
            })}
            {contracts.length === 0 && employers.length === 0 && (
              <div className="px-5 py-3 text-sm text-slate-400">{t("Документів ще немає.")}</div>
            )}
            {archive.length > 0 && (
              <div>
                <button type="button" onClick={() => setArchiveOpen(o => !o)} className="flex w-full items-center gap-1.5 px-5 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 hover:bg-slate-50">
                  {archiveOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {t("Архів")} <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold normal-case text-slate-500">{archive.length}</span>
                  <span className="font-normal normal-case tracking-normal">· {t("скасовані, замінені, прострочені")}</span>
                </button>
                {archiveOpen && (
                  <div className="divide-y divide-slate-50 border-t border-slate-100 bg-slate-50/40">
                    {archive.map(c => <ContractRow key={c.id} c={c} workerId={workerId} onSaved={inv} archived showTarget />)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Section>
      {newFor && (
        <GenerateDocumentsModal workerId={workerId} defaultFactoryId={newFor.factoryId} defaultCompanyId={newFor.companyId}
          factories={factories} employers={employers}
          standardValid={!!validStandard} standardValidUntil={validStandard?.dateTo ?? null}
          onClose={() => setNewFor(null)} onSaved={() => { inv(); setNewFor(null); }} />
      )}
    </>
  );
}

// Стандартний пакет (ZUS/PIT/PPK/BHP/wniosek) підписується за раз — тому один
// рядок: підписаний чи ні, коли, скільки документів; повні рядки з чипами і
// файлами — лише за розгортанням (зауваження власника 05.09.2026).
function StandardPackageRow({ workerId, list, onSaved, onGenerate }: { workerId: number; list: ContractSummary[]; onSaved: () => void; onGenerate: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const main = list.find(c => c.status === "signed") ?? list.find(c => c.status === "worker_signed") ?? [...list].sort((a, b) => b.id - a.id)[0] ?? null;
  const st = main ? (CONTRACT_STATUS[main.status] ?? CONTRACT_STATUS.draft!) : null;
  const summary = main ? [
    main.signedAt ? `${t("підписано")} ${fmtDocDate(main.signedAt.slice(0, 10))}` : main.sentAt ? `${t("надіслано")} ${fmtDocDate(main.sentAt.slice(0, 10))}` : main.generatedAt ? `${t("згенеровано")} ${fmtDocDate(main.generatedAt.slice(0, 10))}` : null,
    main.status === "signed" || main.status === "worker_signed" ? (main.dateTo ? `${t("дійсний до")} ${fmtDocDate(main.dateTo)}` : t("безстроково")) : null,
    `${main.files.length} ${t("док.")}`,
    list.length > 1 ? t("ще {n} у роботі", { n: list.length - 1 }) : null,
  ].filter(Boolean).join(" · ") : null;
  return (
    <div className="bg-slate-50/50 px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <button type="button" onClick={() => main && setOpen(o => !o)} className={`flex items-center gap-1.5 text-left ${main ? "" : "cursor-default"}`}>
          {main ? (open ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />) : <FileText className="h-4 w-4 text-slate-400" />}
          <span className="font-semibold text-slate-600">{t("Стандартний пакет")}</span>
        </button>
        <span className="text-xs text-slate-400">ZUS · PIT · PPK · BHP · wniosek</span>
        {st && main && <Badge color={st.color}>{t(st.label)}</Badge>}
        {summary && <span className="text-xs text-slate-500">{summary}</span>}
        {!main && (
          <span className="ml-auto flex items-center gap-2 text-xs text-slate-400">
            {t("ще не підписаний — додається до першої умови")}
            <button type="button" onClick={onGenerate} className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200">{t("Згенерувати")}</button>
          </span>
        )}
      </div>
      {open && main && (
        <div className="mt-2 space-y-2">
          {[...list].sort((a, b) => (a.status === "signed" ? -1 : b.status === "signed" ? 1 : b.id - a.id)).map(c => <ContractRow key={c.id} c={c} workerId={workerId} onSaved={onSaved} />)}
        </div>
      )}
    </div>
  );
}

// Картка одного роботодавця: шапка «фабрика · фірма» +
// рядки чинних умов. Підписана чинна + нова версія в роботі — обидві в тій самій
// картці (нова позначена «нова версія»).
function ContractChain({ workerId, title, subtitle, companyName, badge, list, muted, emptyText, emptyTone, onGenerate, onSaved }: {
  workerId: number; title: string; subtitle?: string; companyName?: string | null; badge?: string;
  list: ContractSummary[]; muted?: boolean; emptyText: string; emptyTone?: "warn"; onGenerate: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [showOlder, setShowOlder] = useState(false);
  const signed = list.filter(c => c.status === "signed");
  const rest = list.filter(c => c.status !== "signed").sort((a, b) => b.id - a.id);
  // є підписана чинна + кілька версій у роботі — показуємо лише найновішу, решту за кліком
  const olderHidden = signed.length > 0 && !showOlder ? rest.slice(1) : [];
  const ordered = [...signed, ...(olderHidden.length ? rest.slice(0, 1) : rest)];
  const empty = list.length === 0;
  return (
    <div className={`px-5 py-3 ${muted ? "bg-slate-50/50" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {muted ? <FileText className="h-4 w-4 shrink-0 text-slate-400" /> : <FactoryIcon className="h-4 w-4 shrink-0 text-slate-400" />}
        <span className={`text-sm font-semibold ${muted ? "text-slate-600" : "text-slate-800"}`}>{title}</span>
        {companyName && <Badge color="blue">{companyName}</Badge>}
        {badge && <span className="text-xs text-slate-400">{badge}</span>}
        {subtitle && <span className="text-xs text-slate-400">{subtitle}</span>}
        {empty && (
          <span className={`ml-auto flex items-center gap-2 text-xs ${emptyTone === "warn" ? "text-amber-600" : "text-slate-400"}`}>
            {emptyTone === "warn" && <AlertTriangle className="h-3.5 w-3.5" />}
            {emptyText}
            <button type="button" onClick={onGenerate} className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200">{t("Згенерувати")}</button>
          </span>
        )}
      </div>
      {!empty && (
        <div className="mt-2 space-y-2">
          {ordered.map(c => <ContractRow key={c.id} c={c} workerId={workerId} onSaved={onSaved} newVersion={signed.length > 0 && c.status !== "signed"} />)}
          {olderHidden.length > 0 && (
            <button type="button" onClick={() => setShowOlder(true)} className="text-xs text-slate-500 hover:text-slate-700 hover:underline">
              {t("ще {n} у роботі", { n: olderHidden.length })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Один рядок умови: статус · період (або «дати не вказані · вказати») · дії;
// нижче — підписи і документи пакета (чипи), «файли» розгортає перегляд/скачати/
// друк/надіслати. В архіві той самий рядок компактніший і з назвою фабрики.
function ContractRow({ c, workerId, onSaved, newVersion, archived, showTarget }: {
  c: ContractSummary; workerId: number; onSaved: () => void; newVersion?: boolean; archived?: boolean; showTarget?: boolean;
}) {
  const t = useT();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const [editDates, setEditDates] = useState(false);
  const st = CONTRACT_STATUS[c.status] ?? CONTRACT_STATUS.draft!;
  const terminal = ["signed", "cancelled", "superseded", "expired", "declined"].includes(c.status);
  const cancelMut = useMutation({ mutationFn: (id: number) => post(`/contracts/${id}/cancel`), onSuccess: () => { onSaved(); toast.success(t("Скасовано")); }, onError: (e: any) => toast.error(e.message) });
  const finalize = useMutation({ mutationFn: (id: number) => post(`/contracts/${id}/finalize`), onSuccess: () => { onSaved(); toast.success(t("Підписано від компанії — пакет завершено")); }, onError: (e: any) => toast.error(e.message) });
  const send = useMutation({
    mutationFn: (id: number) => post<{ notified: boolean; link: string | null; bundledCount: number }>(`/contracts/${id}/send`),
    onSuccess: r => {
      onSaved();
      // bundledCount>0 — разом надіслано й інші sendable пакети цієї людини
      // (одна сесія підписання на весь комплект, не окремі лінки).
      const bundleNote = r.bundledCount > 0 ? ` (${t("разом з {n} іншим пакетом", { n: r.bundledCount })})` : "";
      toast.success((r.notified ? t("Надіслано працівнику в Telegram") : t("Токен створено, але Telegram не надіслано — скопіюй лінк вручну")) + bundleNote);
      if (r.link && !r.notified) navigator.clipboard?.writeText(r.link).catch(() => {});
    },
    onError: (e: any) => toast.error(e.message),
  });
  const period = fmtPeriod(c);
  const signLine = [
    c.signedAt ? `${t("працівник підписав")} ${fmtTs(c.signedAt)}` : null,
    c.companySignedAt ? `${t("компанія")} ${fmtTs(c.companySignedAt)}` : null,
    !c.signedAt && c.sentAt ? `${t("надіслано")} ${fmtTs(c.sentAt)}` : null,
    !c.signedAt && !c.sentAt && c.generatedAt ? `${t("згенеровано")} ${fmtTs(c.generatedAt)}` : null,
  ].filter(Boolean).join(" · ");
  const files = c.files ?? [];
  const cls = archived ? "px-5 py-2" : `rounded-lg border px-3 py-2 ${c.status === "signed" ? "border-emerald-200 bg-emerald-50/40" : newVersion ? "border-dashed border-slate-300 bg-white" : "border-slate-200 bg-white"}`;
  return (
    <div className={cls}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Badge color={st.color}>{t(st.label)}</Badge>
        {newVersion && <span className="text-xs text-slate-500">{t("нова версія")}</span>}
        {showTarget && <span className="text-xs text-slate-600">{c.factoryId == null ? t("Стандартний пакет") : (c.factoryName ?? `#${c.factoryId}`)}{c.companyName ? ` · ${c.companyName}` : ""}</span>}
        {period ? (
          <span className="tabular-nums text-slate-700">{period}</span>
        ) : archived ? (
          <span className="text-xs text-slate-400">{t("без дат")}</span>
        ) : editDates ? (
          <EditContractDates contractId={c.id} onSaved={() => { setEditDates(false); onSaved(); }} onCancel={() => setEditDates(false)} />
        ) : (
          <span className="text-xs text-slate-400">
            {t("дати не вказані")}
            {!terminal && <> · <button type="button" onClick={() => setEditDates(true)} className="text-red-600 hover:underline">{t("вказати")}</button></>}
          </span>
        )}
        {c.supersedesId && <span className="text-xs text-slate-400" title={t("Замінює попередній пакет")}>↺ #{c.supersedesId}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!archived && ["draft", "pending_approval", "approved"].includes(c.status) && (
            <button onClick={() => { if (!c.dateFrom && !window.confirm(t("Дата початку умови не вказана — надіслати на підпис без дати? Дописати її можна буде пізніше."))) return; send.mutate(c.id); }} disabled={send.isPending} className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">{t("Надіслати на підпис")}</button>
          )}
          {!archived && c.status === "worker_signed" && (
            <button onClick={() => finalize.mutate(c.id)} disabled={finalize.isPending} className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">{t("Підписати від компанії")}</button>
          )}
          {!archived && !terminal && (
            <button onClick={async () => { if (await confirm({ title: t("Скасувати пакет?"), danger: true, confirmText: t("Скасувати") })) cancelMut.mutate(c.id); }}
              className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Скасувати")}><Ban className="h-3.5 w-3.5" /></button>
          )}
          <button onClick={() => setExpanded(x => !x)} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700" title={t("Файли пакета: перегляд, скачати, друк, надіслати")}>
            <FileText className="h-3.5 w-3.5" /> {t("файли")}
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {(signLine || files.length > 0) && !archived && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          {signLine && <span>{signLine}</span>}
          {files.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              {files.map(f => (
                <span key={f.id} className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 ${f.signed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-500"}`} title={f.signed ? t("підписано") : t("без підпису")}>
                  {f.signed && <ShieldCheck className="h-3 w-3" />}{f.title}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      {expanded && <div className="-mx-3 mt-1"><ContractFilesList contractId={c.id} workerId={workerId} /></div>}
    </div>
  );
}

// Умову можна згенерувати й підписати без дат (дозвіл на роботу часто
// оформлюють УЖЕ маючи підписану умову — дата стає відома постфактум) — тут
// дописуємо, щойно з'явиться, на будь-якому нетермінальному статусі. У draft
// це ще й перегенеровує PDF-файли; після — лише дані в БД, підписаний файл не
// чіпається (services/contracts.ts:updateContractDates).
function EditContractDates({ contractId, onSaved, onCancel }: { contractId: number; onSaved: () => void; onCancel?: () => void }) {
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
      <Input type="date" autoFocus value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-7 w-32 text-xs" />
      <span className="text-slate-400">→</span>
      <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-7 w-32 text-xs" />
      <button onClick={() => save.mutate()} disabled={!dateFrom || save.isPending}
        className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-50">
        {t("Зберегти дати")}
      </button>
      {onCancel && <button type="button" onClick={onCancel} className="rounded p-1 text-slate-400 hover:text-slate-600" title={t("Скасувати")}><XCircle className="h-3.5 w-3.5" /></button>}
    </div>
  );
}

// Клік по файлу розгортає PDF просто в рядку (canvas через pdf.js, як на
// /sign/:token) — без нової вкладки/скачування, щоб офіс міг перевірити
// зміст, не виходячи зі сторінки.
// Праворуч у рядку файла — скачати / друк / надіслати працівнику (Telegram або
// email; рішення власника 03.09.2026).
function ContractFilesList({ contractId, workerId }: { contractId: number; workerId: number }) {
  const t = useT();
  const { data, isLoading } = useQuery<{ files: ContractFileRow[] }>({ queryKey: ["contract-detail", contractId], queryFn: () => get(`/contracts/${contractId}`) });
  const [openFile, setOpenFile] = useState<number | null>(null);
  const [sendFor, setSendFor] = useState<ContractFileRow | null>(null);
  if (isLoading) return <div className="px-4 py-2"><Spinner /></div>;
  const files = data?.files ?? [];
  if (!files.length) return <div className="px-4 pb-2 text-xs text-slate-400">{t("Файлів ще немає.")}</div>;
  const fileUrl = (f: ContractFileRow) => `/api/contracts/${contractId}/files/${f.id}`;
  return (
    <div className="space-y-1 bg-slate-50/60 px-4 py-2">
      {files.map(f => (
        <div key={f.id}>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setOpenFile(x => x === f.id ? null : f.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-red-600 hover:underline">
              <Eye className="h-3 w-3 shrink-0" /> <span className="truncate">{f.title}</span> {f.signedSha256 && <Badge color="green">{t("підписано")}</Badge>}
              {openFile === f.id ? <ChevronUp className="h-3 w-3 shrink-0 text-slate-400" /> : <ChevronDown className="h-3 w-3 shrink-0 text-slate-400" />}
            </button>
            <span className="flex shrink-0 items-center gap-0.5">
              <a href={`${fileUrl(f)}?download=1`} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Скачати")}><Download className="h-3.5 w-3.5" /></a>
              <button type="button" onClick={() => printFile(fileUrl(f), "application/pdf")} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Друк")}><Printer className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setSendFor(f)} className="rounded p-1 text-slate-400 hover:bg-sky-50 hover:text-sky-600" title={t("Надіслати працівнику")}><Mail className="h-3.5 w-3.5" /></button>
            </span>
          </div>
          {openFile === f.id && <ContractPdfPreview url={fileUrl(f)} />}
        </div>
      ))}
      {sendFor && <SendFileModal workerId={workerId} title={sendFor.title} endpoint={`/contracts/${contractId}/files/${sendFor.id}/send`} onClose={() => setSendFor(null)} />}
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

function GenerateDocumentsModal({ workerId, defaultFactoryId, defaultCompanyId, factories, employers, standardValid, standardValidUntil, onClose, onSaved }: {
  workerId: number; defaultFactoryId: number | null; defaultCompanyId?: number | null; factories: Factory[]; employers: EmployerRef[];
  standardValid: boolean; standardValidUntil: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  // Фабрика і фірма умови — один селект (05.09.2026): звичайна фабрика — рядок
  // «Фабрика · фірма фабрики», мультифірмова (Sushi) — по рядку на кожну нашу
  // фірму. Фабрики працівника — зверху окремою групою.
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const { data: profile } = useQuery<{ companyId: number | null; firstWorkDate?: string | null; employmentStartDate?: string | null }>({ queryKey: ["worker", String(workerId)], queryFn: () => get(`/workers/${workerId}`) });
  const allOptions = employerOptions(factories, companies);
  const mineValues = new Set(employers.map(e => employerValue(e.factoryId, e.companyId, factories)));
  const mineOptions = allOptions.filter(o => mineValues.has(o.value));
  const otherOptions = allOptions.filter(o => !mineValues.has(o.value));
  const defaultFactory = factories.find(f => f.id === defaultFactoryId);
  const defaultCid = defaultCompanyId ?? employers.find(e => e.factoryId === defaultFactoryId)?.companyId ?? (defaultFactory?.multiFirm ? profile?.companyId : defaultFactory?.companyId) ?? null;
  const [sel, setSel] = useState<string>(employerValue(defaultFactoryId, defaultCid, factories));
  // мультифірмова фабрика без обраної фірми у профілі — дефолт підтягується, щойно профіль завантажився
  useEffect(() => {
    if (sel === "" || sel.includes(":")) return;
    const f = factories.find(x => String(x.id) === sel);
    if (f?.multiFirm) setSel(employerValue(f.id, defaultCid ?? profile?.companyId ?? companies[0]?.id ?? null, factories));
  }, [sel, profile?.companyId, companies.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const selOption = allOptions.find(o => o.value === sel);
  const factoryId = selOption ? String(selOption.factoryId) : "";
  const companyId = selOption?.companyId != null ? String(selOption.companyId) : "";
  const [showAllFactory, setShowAllFactory] = useState(false);
  const [showAllStandard, setShowAllStandard] = useState(false);
  // Рік-наперед за замовчуванням — лише для сталого пакету (ZUS/tax/PPK/BHP/
  // wniosek): факторі-пакет (Umowa, іноді разом з Regulamin) цілком легально
  // йде БЕЗ дат (дата роботи невідома заздалегідь) — не форсувати тут дефолт.
  const [dateFrom, setDateFrom] = useState(defaultFactoryId ? "" : todayIso());
  const [dateTo, setDateTo] = useState(defaultFactoryId ? "" : yearAheadIso());
  // факторі-пакет: «Діє від» підставляється з першого робочого дня / дати працевлаштування (рішення 08.09.2026) — порожнє лишається дозволеним
  const [dateTouched, setDateTouched] = useState(false);
  useEffect(() => {
    if (dateTouched || !defaultFactoryId) return;
    const d = profile?.firstWorkDate ?? profile?.employmentStartDate ?? null;
    if (d && !dateFrom) setDateFrom(d);
  }, [profile?.firstWorkDate, profile?.employmentStartDate]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Превʼю {%Czynności%}: звідки візьметься текст обов'язків (посада на фабриці / фабрика / назва посади)
  const { data: duties } = useQuery<{ text: string; source: "position" | "factory" | "position_name" | "none" }>({
    queryKey: ["contract-duties", workerId, factoryId],
    queryFn: () => get(`/workers/${workerId}/contract-duties?factoryId=${factoryId}`),
    enabled: !isStandard,
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
          companyId: companyId ? Number(companyId) : null,
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
          <Label>{t("Фабрика · фірма в умові")}</Label>
          <Select value={sel} onChange={e => setSel(e.target.value)}>
            <option value="">{t("— Стандартний пакет (без фабрики) —")}</option>
            {mineOptions.length > 0 && (
              <optgroup label={t("Фабрики працівника")}>
                {mineOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
            )}
            <optgroup label={mineOptions.length > 0 ? t("Інші фабрики") : t("Фабрики")}>
              {otherOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          </Select>
          {selOption && (
            <div className="pt-0.5 text-xs text-slate-400">
              {t("Реквізити в умові")}: <b className="font-medium text-slate-600">{companies.find(c => String(c.id) === companyId)?.name ?? "—"}</b>
              {factories.find(f => String(f.id) === factoryId)?.multiFirm && ` · ${t("мультифірмова фабрика — фірму обрано в списку вище")}`}
            </div>
          )}
        </div>

        {showStandardSection && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={payoutCash} onChange={e => onTogglePayout(e.target.checked)} />
            {t("Виплата готівкою (замість «на konto»)")}
          </label>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div><Label>{t("Діє від")}</Label><Input type="date" value={dateFrom} onChange={e => { setDateTouched(true); setDateFrom(e.target.value); }} /></div>
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

        {!isStandard && duties && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${duties.source === "position" || duties.source === "factory" ? "border-slate-200 bg-slate-50 text-slate-600" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
            <span className="font-medium">{t("Обов'язки в умові (Czynności)")}:</span> {duties.text || "—"}
            <span className="ml-1 opacity-70">
              · {duties.source === "position" ? t("з посади на фабриці")
                : duties.source === "factory" ? t("із загального поля фабрики")
                : duties.source === "position_name" ? t("лише назва посади — розпиши обов'язки в налаштуваннях фабрики")
                : t("не визначено — у працівника немає посади, а фабрика без опису")}
            </span>
          </div>
        )}

        {!isStandard && (
          <div>
            <Label>{t("Комплект документів фабрики")} {autoFactoryLoading && <Spinner />}</Label>
            <TemplateChecklist candidates={factoryCandidates} auto={autoSetFactory} checked={checkedFactory} onToggle={toggleFactory}
              showAll={showAllFactory} onShowAll={() => setShowAllFactory(true)} loading={autoFactoryLoading} />
          </div>
        )}

        {showStandardSection && (
          <div>
            <Label>
              {t("Стандартний пакет")} <span className="font-normal text-slate-400">({t("спільний для всіх фабрик")})</span>
              {needsStandardToo && <span className="ml-1 font-normal text-amber-600">— {t("ще не підписаний, додається разом")}</span>}
              {" "}{autoStandardLoading && <Spinner />}
            </Label>
            <TemplateChecklist candidates={standardCandidates} auto={autoSetStandard} checked={checkedStandard} onToggle={toggleStandard}
              showAll={showAllStandard} onShowAll={() => setShowAllStandard(true)} loading={autoStandardLoading} />
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

// Чекліст шаблонів: за замовчуванням лише підібраний комплект (авто) і те, що
// адмін уже відмітив; решта бібліотеки — за «додати інший шаблон» (інакше для
// Sushi у списку висіли всі 8 інструктажів Andros без галочок — зауваження 05.09.2026).
function TemplateChecklist({ candidates, auto, checked, onToggle, showAll, onShowAll, loading }: {
  candidates: { id: number; kind: string; title: string }[]; auto: DocSetItem[]; checked: Set<number>;
  onToggle: (id: number, kind: string) => void; showAll: boolean; onShowAll: () => void; loading: boolean;
}) {
  const t = useT();
  const isAuto = (id: number) => auto.some(a => a.id === id);
  const visible = showAll ? candidates : candidates.filter(c => isAuto(c.id) || checked.has(c.id));
  const hidden = candidates.length - visible.length;
  return (
    <div className="max-h-56 divide-y divide-slate-50 overflow-y-auto rounded-lg border border-slate-200">
      {candidates.length === 0 && <div className="px-3 py-3 text-sm text-slate-400">{t("Немає шаблонів цього типу в бібліотеці.")}</div>}
      {candidates.length > 0 && visible.length === 0 && !loading && <div className="px-3 py-3 text-sm text-slate-400">{t("Для цієї фабрики шаблон не підібрано — додай вручну.")}</div>}
      {visible.map(c => (
        <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50">
          <input type="checkbox" checked={checked.has(c.id)} onChange={() => onToggle(c.id, c.kind)} />
          <Badge color="slate">{KIND_LABEL[c.kind] ?? c.kind}</Badge>
          <span className="truncate text-slate-700">{c.title}</span>
          {isAuto(c.id) && <span className="ml-auto shrink-0 text-xs text-emerald-600">{t("авто")}</span>}
        </label>
      ))}
      {!showAll && hidden > 0 && (
        <button type="button" onClick={onShowAll} className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs text-slate-500 hover:bg-slate-50 hover:text-slate-700">
          <Plus className="h-3 w-3" /> {t("додати інший шаблон")} <span className="text-slate-400">({hidden})</span>
        </button>
      )}
    </div>
  );
}

// Легалізація за документами (движок worker_legality) — три світлофори
// (перебування/праця/загалом), причини движка, найближчий термін, обов'язки
// (напр. powiadomienie), та підказка до старого поля «Форма легалізації»
// (LegalStatusRow нижче лишається окремим — легасі-поле НЕ автозаповнюється).
// Доступно на перегляд усім ролям (як GET .../legality); «Перерахувати» — cap legalization.
// Додаткові фабрики працівника (worker_factories) — чипи поруч з основною фабрикою
// в шапці профілю. Умова потрібна на кожну активну (вісь «умова» движка); зміни в
// графіку на фабриці поза списком — попередження в блоці легалізації.
function WorkerFactoriesChips({ workerId, factories, companies, primaryFactoryId }: { workerId: number; factories: Factory[]; companies: Company[]; primaryFactoryId: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const canEdit = can(me, "editData") || can(me, "legalization");
  const { data: rows = [] } = useQuery<WorkerFactory[]>({ queryKey: ["worker-factories", workerId], queryFn: () => get(`/workers/${workerId}/factories`) });
  const [adding, setAdding] = useState(false);
  const inv = () => { qc.invalidateQueries({ queryKey: ["worker-factories", workerId] }); qc.invalidateQueries({ queryKey: ["worker-legality", workerId] }); };
  const add = useMutation({
    mutationFn: (v: { factoryId: number; companyId?: number }) => post(`/workers/${workerId}/factories`, v),
    onSuccess: () => { inv(); setAdding(false); }, onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/worker-factories/${id}`), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const today = new Date().toLocaleDateString("sv-SE");
  // Один крок: мультифірмова фабрика розкладена на «Фабрика · Фірма» по рядку
  // на кожну нашу фірму, звичайна — з фірмою фабрики в тому ж рядку.
  const options = employerOptions(factories.filter(f => f.id !== primaryFactoryId && !rows.some(r => r.factoryId === f.id)), companies);
  return (
    <>
      {rows.map(r => {
        const inactive = (r.validFrom && r.validFrom > today) || (r.validTo && r.validTo < today);
        return (
          <span key={r.id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${inactive ? "bg-slate-100 text-slate-400" : "bg-red-50 text-red-700"}`}
            title={[r.companyName ? `${t("роботодавець")}: ${r.companyName}` : null, r.validFrom ? `${t("від")} ${r.validFrom}` : null, r.validTo ? `${t("до")} ${r.validTo}` : null, r.note].filter(Boolean).join(" · ") || t("додаткова фабрика")}>
            +{r.factoryName ?? `#${r.factoryId}`}{r.companyName && <span className="font-normal opacity-70">· {r.companyName}</span>}
            {canEdit && <button type="button" onClick={() => remove.mutate(r.id)} className="text-red-300 hover:text-rose-600" title={t("Прибрати фабрику")}>×</button>}
          </span>
        );
      })}
      {canEdit && (adding ? (
        <Select autoFocus value="" onChange={e => {
          const o = options.find(x => x.value === e.target.value);
          if (o) add.mutate({ factoryId: o.factoryId, companyId: o.companyId ?? undefined }); else setAdding(false);
        }} onBlur={() => setAdding(false)} className="h-6 w-56 py-0 text-xs" title={t("Ще одна фабрика: умова потрібна на кожну")}>
          <option value="">{t("— фабрика · фірма —")}</option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-400 hover:border-slate-400 hover:text-slate-600" title={t("Ще одна фабрика: умова потрібна на кожну")}>
          + {t("фабрика")}
        </button>
      ))}
    </>
  );
}

// Шапка блоку «Легалізація і документи» (один блок із списком документів —
// рішення власника 03.09.2026: «легалізація док і легалізація — одне й те саме»).
// Світлофори побут/праця/разом, причини, наступний строк, обовʼязки. Без власної
// картки — рендериться всередині Section у WorkerDocuments.
// Статус для виплат (резолвер 06.09.2026): що реально йде у сводну і звідки —
// за документами (повністю оформлений) або ручне поле; плюс банер відкритої зміни
// за документами: «вплине на сводну» → Прийняти (превʼю ProfileChangeModal) / Відхилити.
function EffectiveStatusLine({ workerId, legality }: { workerId: number; legality: WorkerLegality }) {
  const t = useT();
  const qc = useQueryClient();
  const [review, setReview] = useState(false);
  const eff = legality.effectiveLegalStatus ?? null;
  const src = legality.effectiveSource ?? (eff ? "manual" : "none");
  const pending = legality.pendingEffectiveChange ?? null;
  const dismiss = useMutation({
    mutationFn: (id: number) => post(`/svodni/profile-change/${id}/dismiss`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker-legality", workerId] }); toast.success(t("Зміну відхилено — сводна без змін")); },
    onError: (e: any) => toast.error(e.message),
  });
  const label = (s: string | null) => s ? t(LEGAL_LABEL[s as LegalStatus] ?? s) : t("не зголошений");
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="font-semibold uppercase tracking-wide text-slate-400">{t("Для виплат")}</span>
        <span className={`rounded px-1.5 py-0.5 font-medium ${eff && LEGAL_BADGE[eff as LegalStatus] ? LEGAL_BADGE[eff as LegalStatus]!.cls : "bg-rose-50 text-rose-700"}`}>{label(eff)}</span>
        <span className="text-slate-400">
          · {src === "documents" ? t("за документами") : src === "manual" ? t("за ручним полем «Форма легалізації»") : t("без статусу і без повного комплекту документів")}
          {legality.effectiveSince && src === "documents" ? ` · ${t("з")} ${fmtDocDate(legality.effectiveSince)}` : ""}
        </span>
      </div>
      {pending && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            {t("Статус для виплат змінився за документами")}: <b>{label(pending.oldValue)}</b> → <b>{label(pending.newValue)}</b> {t("з")} {fmtDocDate(pending.effectiveDate)}.
            {" "}{t("Це вплине на сводну від цієї дати — переглянь і прийми або відхили.")}
          </span>
          <span className="ml-auto flex shrink-0 gap-1.5">
            <button type="button" onClick={() => setReview(true)} className="rounded-md bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-700">{t("Переглянути й прийняти")}</button>
            <button type="button" onClick={() => dismiss.mutate(pending.id)} disabled={dismiss.isPending} className="rounded-md border border-amber-300 bg-white px-2 py-1 font-medium text-amber-700 hover:bg-amber-100">{t("Відхилити")}</button>
          </span>
        </div>
      )}
      {review && pending && (
        <ProfileChangeModal workerId={workerId} changes={{ effectiveLegalStatus: pending.newValue }} title={t("Статус для виплат за документами → сводна")}
          initialFrom={pending.effectiveDate} onClose={() => { setReview(false); qc.invalidateQueries({ queryKey: ["worker-legality", workerId] }); }} />
      )}
    </div>
  );
}

function LegalitySummary({ workerId }: { workerId: number }) {
  const t = useT();
  const { data: legality, isLoading } = useQuery<WorkerLegality | null>({
    queryKey: ["worker-legality", workerId], queryFn: () => get(`/workers/${workerId}/legality`),
  });
  const ld = useLeadDays(); // хук — до умовних return (порядок хуків)

  if (isLoading) return <div className="px-4 py-3"><Spinner /></div>;
  if (!legality) return <div className="px-4 py-2 text-sm text-slate-400">{t("Легальність ще не рахувалась")}</div>;

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
      <div className="space-y-3 bg-slate-50/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {(["stay", "work", "contract", "overall"] as const).map(axis => (
            <div key={axis} className="flex items-center gap-1.5 rounded-lg border border-slate-100 bg-white px-2.5 py-1.5 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${LEGALITY_DOT[legality[axis]]}`} />
              <span className="text-xs text-slate-400">{t(AXIS_LABEL[axis])}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${LEGALITY_BADGE[legality[axis]]}`}>{t(LEGALITY_LABEL[legality[axis]])}</span>
            </div>
          ))}
          {legality.reviewRequired && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600">
              <AlertTriangle className="h-3 w-3" /> {t("потребує перевірки")}
            </span>
          )}
        </div>

        <EffectiveStatusLine workerId={workerId} legality={legality} />

        {legality.reasons.length > 0 && (
          <div className="space-y-1.5">
            {(["stay", "work", "contract", "overall"] as const).filter(ax => reasonsByAxis[ax]?.length).map(ax => (
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
              <span className={expiryTextCls(expiryTone(dLeft, ld))}>
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
  );
}

// ── Список документів: один слот = один рядок ───────────────────────────────
// Відгук власника 03.09.2026: «бачу і плитки, і список — має бути щось одне,
// легке, зрозуміле» — плитки прибрані, лишився єдиний список рядків. «Karta
// pobytu» і «Zezwolenie/Oświadczenie» — не фіксований тип, а «найкращий»
// (найпізніший строк) present-документ серед кількох кодів каталогу (людина
// могла мати кілька підстав одночасно, або підстава змінилась).
const KARTA_POBYTU_CODES = ["trc", "zezwolenie_jednolite", "karta_stalego_pobytu", "rezydent_ue", "status_ukr", "visa_d", "visa_c", "visa_free",
  "humanitarian_visa", "refugee_status", "subsidiary_protection", "humanitarian_stay", "tolerated_stay", "eu_family_member_card"];
const KARTA_POBYTU_SHORT: Record<string, string> = {
  trc: "TRC", zezwolenie_jednolite: "Zezwolenie jednolite", karta_stalego_pobytu: "Karta stałego pobytu",
  rezydent_ue: "Rezydent UE", status_ukr: "Status UKR", visa_d: "Wiza D", visa_c: "Wiza C", visa_free: "Ruch bezwizowy",
  humanitarian_visa: "Wiza humanitarna", refugee_status: "Status uchodźcy", subsidiary_protection: "Ochrona uzupełniająca",
  humanitarian_stay: "Pobyt humanitarny", tolerated_stay: "Pobyt tolerowany", eu_family_member_card: "Rodzina obywatela UE",
};
// Паспорт і карти побиту додаються ЛИШЕ через скан (рішення власника 04.09.2026):
// «+» у цих слотах відкриває сканер, у модалці «Документ» цих типів немає.
// Редагування вже доданого документа — як завжди.
const SCAN_ONLY_CODES = new Set<string>(["passport", "trc", "karta_stalego_pobytu", "rezydent_ue", "refugee_status", "subsidiary_protection", "humanitarian_stay", "tolerated_stay", "eu_family_member_card"]);
const ZEZWOLENIE_CODES = ["oswiadczenie", "zezwolenie_a", "zezwolenie_jednolite"];
const ZEZWOLENIE_SHORT: Record<string, string> = { oswiadczenie: "Oświadczenie", zezwolenie_a: "Zezwolenie A", zezwolenie_jednolite: "Zezwolenie jednolite" };
// Коди всіх 7 слотів — решта документів людини йде окремим списком «інші» нижче.
const SLOT_CODES = new Set<string>(["passport", ...KARTA_POBYTU_CODES, "student_cert", "powiadomienie_ua", ...ZEZWOLENIE_CODES, "medical_exam", "sanepid"]);

type DocRowState =
  | { kind: "notneeded" }
  | { kind: "empty"; requestedDoc: WorkerDocument | null }
  | { kind: "doc"; doc: WorkerDocument; type: DocumentType | null; expiresAt: string | null; indefinite: boolean; expired: boolean; pending: boolean };

// Найкращий документ слоту серед кодів: чинний (найпізніший строк) > прострочений
// (найпізніший) > на перевірці > запрошений (status=missing з POST .../request,
// лишає requestedAt) > немає. status_ukr рахує ефективний строк з
// globals.ukrStatusEnd, якщо в самого документа дата не проставлена.
function resolveDocSlot(items: { doc: WorkerDocument; type: DocumentType }[], codes: string[], globals?: LegalizationGlobals | null): DocRowState {
  const cands = items.filter(it => it.type.code && codes.includes(it.type.code));
  const real = cands.filter(it => it.doc.status !== "missing");
  if (real.length) {
    const withMeta = real.map(it => {
      const expiresAt = it.type.code === "status_ukr" ? (it.doc.expiresAt ?? globals?.ukrStatusEnd ?? null) : it.doc.expiresAt;
      const pending = it.doc.status === "pending";
      const expired = !pending && (it.doc.status === "expired" || isExpired(expiresAt));
      const indefinite = !it.type.hasExpiry && !expiresAt;
      return { ...it, expiresAt, pending, expired, indefinite };
    });
    const valid = withMeta.filter(m => !m.pending && !m.expired);
    if (valid.length) {
      valid.sort((a, b) => (a.indefinite !== b.indefinite ? (a.indefinite ? -1 : 1) : (b.expiresAt ?? "").localeCompare(a.expiresAt ?? "")));
      const best = valid[0]!;
      return { kind: "doc", doc: best.doc, type: best.type, expiresAt: best.expiresAt, indefinite: best.indefinite, expired: false, pending: false };
    }
    const expiredOnes = withMeta.filter(m => !m.pending && m.expired);
    if (expiredOnes.length) {
      expiredOnes.sort((a, b) => (b.expiresAt ?? "").localeCompare(a.expiresAt ?? ""));
      const best = expiredOnes[0]!;
      return { kind: "doc", doc: best.doc, type: best.type, expiresAt: best.expiresAt, indefinite: false, expired: true, pending: false };
    }
    const pendingOnes = withMeta.filter(m => m.pending);
    if (pendingOnes.length) {
      const best = pendingOnes[0]!;
      return { kind: "doc", doc: best.doc, type: best.type, expiresAt: best.expiresAt, indefinite: false, expired: false, pending: true };
    }
  }
  // немає реального документа — можливо, є «запрошений» (порожній рядок з /request, status=missing)
  const requested = cands.filter(it => it.doc.status === "missing" && it.doc.requestedAt).sort((a, b) => (b.doc.requestedAt ?? "").localeCompare(a.doc.requestedAt ?? ""));
  return { kind: "empty", requestedDoc: requested[0]?.doc ?? null };
}

// Документ поза слотами — рядок уже реально існує, навіть якщо статус missing
// (напр. відхилений скан з бота лишає reviewNote — важливо не ховати причину).
function otherDocState(doc: WorkerDocument, type: DocumentType | null, globals?: LegalizationGlobals | null): DocRowState {
  const expiresAt = type?.code === "status_ukr" ? (doc.expiresAt ?? globals?.ukrStatusEnd ?? null) : doc.expiresAt;
  const pending = doc.status === "pending";
  const expired = !pending && (doc.status === "expired" || isExpired(expiresAt));
  const indefinite = !!type && !type.hasExpiry && !expiresAt;
  return { kind: "doc", doc, type, expiresAt, indefinite, expired, pending };
}

const fmtDocDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const fmtShortDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const DOC_TONE_CLS = { ok: "text-green-600", soon: "text-yellow-600", urgent: "text-rose-600", expired: "text-rose-600", pending: "text-blue-600", muted: "text-slate-400", warn: "text-amber-600" } as const;

function docTone(s: Extract<DocRowState, { kind: "doc" }>): keyof typeof DOC_TONE_CLS {
  if (s.pending) return "pending";
  if (s.expired) return "expired";
  if (s.indefinite) return "muted";
  if (!s.expiresAt) return "warn";
  const tone = expiryTone(daysUntil(s.expiresAt), leadDaysCache); // жовта/червона зона з правила легальності
  return tone === "rose" ? "urgent" : tone === "amber" ? "soon" : "ok";
}

// Кнопка «Запросити» рядка: один тип-кандидат — надсилає одразу; кілька
// (Karta pobytu/Zezwolenie без визначеного типу) — маленький inline-вибір.
function SlotSendButton({ candidates, onPick, title }: { candidates: DocumentType[]; onPick: (docTypeId: number) => void; title: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(candidates[0]?.id ?? null);
  if (!candidates.length) return null;
  if (candidates.length === 1 || !open) {
    return <button type="button" onClick={() => (candidates.length === 1 ? onPick(candidates[0]!.id) : setOpen(true))} className="rounded p-1 text-slate-400 hover:bg-blue-50 hover:text-blue-600" title={title}><Send className="h-3.5 w-3.5" /></button>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Select value={pick ?? ""} onChange={e => setPick(Number(e.target.value))} className="w-auto rounded px-1.5 py-0.5 text-xs">
        {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
      <button type="button" onClick={() => { if (pick) { onPick(pick); setOpen(false); } }} className="rounded p-1 text-blue-600 hover:bg-blue-50" title={title}><Send className="h-3.5 w-3.5" /></button>
      <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-slate-400 hover:bg-slate-100" title={t("Скасувати")}><XCircle className="h-3.5 w-3.5" /></button>
    </span>
  );
}

// Один рядок документа: слот каталогу (кілька можливих типів) або вже наявний
// документ поза слотами — один макет на все.
function DocRow({ icon: Icon, label, subLabel, state, canLegal, companies, requestCandidates, requestTitle, onAdd, onEdit, onRequest, onHistory, onDelete, onVerify, onReject, onPreview, onSend, onScan, scanTitle }: {
  icon: any; label: string; subLabel?: string | null; state: DocRowState; canLegal: boolean; companies: Company[];
  requestCandidates?: DocumentType[]; requestTitle?: string;
  onAdd?: () => void; onEdit?: (doc: WorkerDocument) => void; onRequest?: (docTypeId: number) => void;
  onHistory?: (doc: WorkerDocument) => void; onDelete?: (doc: WorkerDocument) => void;
  onVerify?: (doc: WorkerDocument) => void; onReject?: (doc: WorkerDocument) => void; onPreview?: (doc: WorkerDocument) => void;
  onSend?: (doc: WorkerDocument) => void;
  onScan?: () => void; // «Сканувати» — слоти Paszport і Karta pobytu
  scanTitle?: string;
}) {
  const t = useT();
  if (state.kind === "notneeded") {
    return (
      <div className="flex items-center gap-2 border-b border-slate-50 px-4 py-2 text-sm text-slate-400 last:border-0">
        <Icon className="h-4 w-4 shrink-0 text-slate-300" />
        <span>{label}</span>
        <span className="ml-auto text-xs">{t("не потрібно")}</span>
      </div>
    );
  }
  if (state.kind === "empty") {
    const requestedAt = state.requestedDoc?.requestedAt ?? null;
    const reviewNote = state.requestedDoc?.reviewNote ?? null;
    return (
      <div className="border-b border-slate-50 px-4 py-2 text-sm last:border-0">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-slate-300" />
          <span className="font-medium text-slate-500">{label}</span>
          <span className="ml-auto flex items-center gap-2">
            <span className="text-xs text-slate-400">{t("немає")}</span>
            {requestedAt && <span className="text-xs font-medium text-blue-600" title={state.requestedDoc?.requestedBy == null ? t("автозапит системи в бот") : t("запит офісу")}>{t("запрошено {date}", { date: fmtShortDate(requestedAt) })}{state.requestedDoc?.requestedBy == null ? " 🤖" : ""}{(state.requestedDoc?.requestRemindCount ?? 0) > 0 ? ` · ${t("нагад.")} ${state.requestedDoc!.requestRemindCount}` : ""}</span>}
            <span className="flex items-center gap-0.5">
              {onScan && <button type="button" onClick={onScan} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={scanTitle ?? t("Сканувати карту")}><ScanLine className="h-3.5 w-3.5" /></button>}
              {onAdd && <button type="button" onClick={onAdd} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Додати")}><Plus className="h-3.5 w-3.5" /></button>}
              {requestCandidates && onRequest && <SlotSendButton candidates={requestCandidates} onPick={onRequest} title={requestTitle ?? t("Попросити подати")} />}
            </span>
          </span>
        </div>
        {reviewNote && <div className="pl-6 pt-0.5 text-xs text-rose-500">📝 {reviewNote}</div>}
      </div>
    );
  }
  const { doc, type } = state;
  const tone = docTone(state);
  const toneCls = DOC_TONE_CLS[tone];
  const dLeft = state.expiresAt ? daysUntil(state.expiresAt) : null;
  const stateText = state.pending ? t("⏳ на перевірці")
    : state.expired ? t("прострочено {date}", { date: fmtDocDate(state.expiresAt!) })
    : state.indefinite ? t("безстроково")
    : state.expiresAt ? (expiryTone(dLeft, leadDaysCache) ? t("до {date} · {n} дн.", { date: fmtDocDate(state.expiresAt), n: dLeft ?? "" }) : t("до {date}", { date: fmtDocDate(state.expiresAt) }))
    : t("дата не вказана");
  const hasFile = !!doc.fileName;
  const employerName = doc.employerCompanyId != null ? (companies.find(c => c.id === doc.employerCompanyId)?.name ?? `#${doc.employerCompanyId}`) : null;
  return (
    <div className="border-b border-slate-50 px-4 py-2 text-sm last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        {hasFile ? (
          <button type="button" onClick={() => onPreview?.(doc)} className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-red-600" title={t("Відкрити")}>
            <Icon className={`h-4 w-4 ${toneCls}`} />
          </button>
        ) : <Icon className={`h-4 w-4 shrink-0 ${toneCls}`} />}
        {hasFile ? (
          <button type="button" onClick={() => onPreview?.(doc)} className="font-medium text-slate-700 hover:text-red-600 hover:underline">{label}</button>
        ) : <span className="font-medium text-slate-700">{label}</span>}
        {subLabel && subLabel !== label && <span className="text-xs text-slate-400">{subLabel}</span>}
        {doc.source === "worker_bot" && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{t("з бота")}</span>}
        {doc.caseStatus && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">{t(CASE_STATUS_LABEL[doc.caseStatus])}</span>}
        {employerName && <span className="text-xs text-slate-400">{employerName}</span>}
        {doc.number && <span className="text-xs text-slate-400">№ {doc.number}</span>}
        {doc.fileUrl && <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-red-600 hover:underline">{t("посилання")} <ExternalLink className="h-3 w-3" /></a>}
        {doc.note && <span className="truncate text-xs text-slate-400" title={doc.note}>📝 {doc.note}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className={`text-xs font-medium ${toneCls}`}>{stateText}</span>
          <span className="flex items-center gap-0.5">
            {canLegal && doc.status === "pending" && onVerify && onReject && (
              <>
                <button onClick={() => onVerify(doc)} className="rounded p-1 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600" title={t("Підтвердити")}><ShieldCheck className="h-3.5 w-3.5" /></button>
                <button onClick={() => onReject(doc)} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Відхилити")}><XCircle className="h-3.5 w-3.5" /></button>
              </>
            )}
            {onScan && <button type="button" onClick={onScan} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={scanTitle ?? t("Сканувати карту")}><ScanLine className="h-3.5 w-3.5" /></button>}
            {hasFile && (
              <>
                <a href={`/api/worker-documents/${doc.id}/file?download=1`} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Скачати")}><Download className="h-3.5 w-3.5" /></a>
                <button onClick={() => printFile(`/api/worker-documents/${doc.id}/file`, doc.fileMime)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Друк")}><Printer className="h-3.5 w-3.5" /></button>
                {onSend && <button onClick={() => onSend(doc)} className="rounded p-1 text-slate-400 hover:bg-sky-50 hover:text-sky-600" title={t("Надіслати працівнику")}><Mail className="h-3.5 w-3.5" /></button>}
              </>
            )}
            {onEdit && <button onClick={() => onEdit(doc)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Редагувати")}><Pencil className="h-3.5 w-3.5" /></button>}
            {canLegal && onHistory && <button onClick={() => onHistory(doc)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Історія")}><History className="h-3.5 w-3.5" /></button>}
            {onDelete && <button onClick={() => onDelete(doc)} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-3.5 w-3.5" /></button>}
            {requestCandidates && onRequest && <SlotSendButton candidates={requestCandidates} onPick={onRequest} title={requestTitle ?? t("Попросити подати")} />}
          </span>
        </span>
      </div>
      {doc.reviewNote && <div className="pl-6 pt-0.5 text-xs text-rose-500">📝 {doc.reviewNote}</div>}
    </div>
  );
}

// Секція «Документи»: 7 фіксованих слотів (у порядку) + окремо решта
// документів людини, що в слоти не потрапили. Один макет рядка на все.
function DocSlotList({ types, docs, companies, nationality, requiresSanepid, globals, canLegal, onOpenDoc, onOpenEmpty, onRequest, onHistory, onDelete, onVerify, onReject, onPreview, onSend, onScanCard, onScanPassport }: {
  types: DocumentType[]; docs: WorkerDocument[]; companies: Company[]; nationality: string | null; requiresSanepid: boolean;
  globals: LegalizationGlobals | undefined; canLegal: boolean;
  onOpenDoc: (doc: WorkerDocument) => void; onOpenEmpty: (type: DocumentType | null, restrictCodes?: string[]) => void;
  onRequest: (docTypeId: number) => void; onHistory: (doc: WorkerDocument) => void; onDelete: (doc: WorkerDocument) => void;
  onVerify: (doc: WorkerDocument) => void; onReject: (doc: WorkerDocument) => void; onPreview: (doc: WorkerDocument) => void;
  onSend: (doc: WorkerDocument) => void;
  onScanCard: () => void;
  onScanPassport: () => void;
}) {
  const t = useT();
  const items = docs
    .map(d => ({ doc: d, type: types.find(ty => ty.id === d.docTypeId) }))
    .filter((it): it is { doc: WorkerDocument; type: DocumentType } => !!it.type);
  const byCode = (code: string) => types.find(ty => ty.code === code) ?? null;
  const notNeeded = isEuNationality(nationality);
  const requestTitle = t("Попросити подати");

  // Слот з фіксованим типом (Paszport/Student/Powiadomienie/Badania/Sanepid):
  // «Запросити» завжди пропонує саме цей тип (і коли документ уже є — «попросити
  // свіжий скан»); «Додати» редагує наявний missing-рядок запиту, якщо такий є,
  // інакше створює новий документ.
  const fixedSlot = (code: string, label: string, onScan?: () => void, scanTitle?: string) => {
    const type = byCode(code);
    if (!type) return null;
    const state = resolveDocSlot(items, [code], globals);
    const scanOnly = SCAN_ONLY_CODES.has(code) && !!onScan;
    const onAdd = () => (state.kind === "empty" && state.requestedDoc && !scanOnly) ? onOpenDoc(state.requestedDoc) : onOpenEmpty(type);
    return (
      <DocRow key={code} icon={docTypeIcon(type.icon)} label={label} state={state} canLegal={canLegal} companies={companies}
        requestCandidates={[type]} requestTitle={requestTitle}
        onAdd={scanOnly ? undefined : onAdd} onEdit={onOpenDoc} onRequest={onRequest} onHistory={onHistory} onDelete={onDelete}
        onVerify={onVerify} onReject={onReject} onPreview={onPreview} onSend={onSend} onScan={onScan} scanTitle={scanTitle} />
    );
  };

  // Слот з кількома можливими типами (Karta pobytu/Zezwolenie): тип не
  // фіксований — обирається серед кодів слоту (за замовчуванням ті, що
  // підходять громадянству) або береться з наявного/раніше запрошеного.
  const multiSlot = (key: string, label: string, codes: string[], shortNames: Record<string, string>, fallbackIcon: any, onScan?: () => void) => {
    const state: DocRowState = notNeeded ? { kind: "notneeded" } : resolveDocSlot(items, codes, globals);
    const icon = state.kind === "doc" ? docTypeIcon(state.type?.icon) : fallbackIcon;
    const subLabel = state.kind === "doc" && state.type?.code ? (shortNames[state.type.code] ?? state.type.name) : null;
    // «+» у слоті карти — лише не-карткові підстави (status UKR, візи, безвіз); самі карти — сканером
    const manualCodes = codes.filter(c => !SCAN_ONLY_CODES.has(c));
    const onAdd = () => (state.kind === "empty" && state.requestedDoc && !SCAN_ONLY_CODES.has(types.find(ty => ty.id === state.requestedDoc!.docTypeId)?.code ?? ""))
      ? onOpenDoc(state.requestedDoc) : onOpenEmpty(null, manualCodes);
    const slotTypes = types.filter(ty => ty.code && codes.includes(ty.code) && ty.isActive !== false);
    let candidates: DocumentType[] = [];
    if (state.kind === "doc" && state.type) candidates = [state.type];
    else if (state.kind === "empty" && state.requestedDoc?.docTypeId != null) candidates = slotTypes.filter(ty => ty.id === state.requestedDoc!.docTypeId);
    else if (state.kind === "empty") {
      const matching = slotTypes.filter(ty => typeMatchesNationality(ty, nationality));
      candidates = matching.length ? matching : slotTypes;
    }
    return (
      <DocRow key={key} icon={icon} label={label} subLabel={subLabel} state={state} canLegal={canLegal} companies={companies}
        requestCandidates={candidates} requestTitle={requestTitle}
        onAdd={state.kind !== "notneeded" ? onAdd : undefined} onEdit={onOpenDoc} onRequest={onRequest} onHistory={onHistory} onDelete={onDelete}
        onVerify={onVerify} onReject={onReject} onPreview={onPreview} onSend={onSend} onScan={state.kind !== "notneeded" ? onScan : undefined} />
    );
  };

  const otherDocs = [...docs]
    .filter(d => { const ty = d.docTypeId != null ? types.find(x => x.id === d.docTypeId) : null; return !ty?.code || !SLOT_CODES.has(ty.code); })
    .sort((a, b) => {
      const sa = types.find(ty => ty.id === a.docTypeId)?.sortOrder ?? 9999;
      const sb = types.find(ty => ty.id === b.docTypeId)?.sortOrder ?? 9999;
      return sa - sb || a.id - b.id;
    });

  return (
    <div>
      {fixedSlot("passport", t("Paszport"), onScanPassport, t("Сканувати паспорт"))}
      {multiSlot("karta", t("Karta pobytu"), KARTA_POBYTU_CODES, KARTA_POBYTU_SHORT, IdCard, onScanCard)}
      {fixedSlot("student_cert", t("Student"))}
      {nationality === "ukraine" && fixedSlot("powiadomienie_ua", t("Powiadomienie"))}
      {multiSlot("zezwolenie", t("Zezwolenie / Oświadczenie"), ZEZWOLENIE_CODES, ZEZWOLENIE_SHORT, FileSignature)}
      {fixedSlot("medical_exam", t("Badania"))}
      {requiresSanepid && fixedSlot("sanepid", t("Sanepid"))}
      {otherDocs.map(doc => {
        const type = doc.docTypeId != null ? types.find(ty => ty.id === doc.docTypeId) ?? null : null;
        return (
          <DocRow key={doc.id} icon={docTypeIcon(type?.icon)} label={type?.name ?? doc.title} state={otherDocState(doc, type, globals)}
            canLegal={canLegal} companies={companies}
            onEdit={onOpenDoc} onHistory={onHistory} onDelete={onDelete} onVerify={onVerify} onReject={onReject} onPreview={onPreview} onSend={onSend} />
        );
      })}
      <button type="button" onClick={() => onOpenEmpty(null)} className="w-full px-4 py-1.5 text-left text-xs text-slate-400 hover:text-slate-600">
        {t("+ інший документ")}
      </button>
    </div>
  );
}

// Модалка додавання/редагування: або редагуємо конкретний документ, або
// додаємо новий — з фіксованим типом (клік по плитці фіксованого слоту) або
// з обмеженим списком типів (клік по «Karta pobytu»/«Zezwolenie» — тип не
// фіксований, обирається серед кодів слоту, restrictCodes).
type DocModalState =
  | { mode: "add"; type: DocumentType | null; restrictCodes?: string[] }
  | { mode: "edit"; doc: WorkerDocument };

function WorkerDocuments({ workerId, companies, nationality, factoryId }: { workerId: number; companies: Company[]; nationality: string | null; factoryId: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const canLegal = can(me, "legalization");
  const confirm = useConfirm();
  const { data: types = [] } = useQuery<DocumentType[]>({ queryKey: ["document-types"], queryFn: () => get("/document-types") });
  const { data: docs = [], isLoading } = useQuery<WorkerDocument[]>({ queryKey: ["worker-docs", workerId], queryFn: () => get(`/workers/${workerId}/documents`) });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: globals } = useQuery<LegalizationGlobals>({ queryKey: ["legalization-globals"], queryFn: () => get("/legalization/globals") });
  const requiresSanepid = !!factories.find(f => f.id === factoryId)?.requiresSanepid;
  const [docModal, setDocModal] = useState<DocModalState | null>(null);
  const [preview, setPreview] = useState<WorkerDocument | null>(null);
  const [auditFor, setAuditFor] = useState<WorkerDocument | null>(null);
  const [rejecting, setRejecting] = useState<WorkerDocument | null>(null);
  const [sendFor, setSendFor] = useState<WorkerDocument | null>(null);
  const [scanCard, setScanCard] = useState(false);
  const passportInputRef = useRef<HTMLInputElement>(null);
  // deep-link з задачі («Як вирішити»): ?open=scan-card | add-doc | add-doc:<typeId>
  useEffect(() => {
    const o = new URLSearchParams(window.location.search).get("open");
    if (!o) return;
    if (o === "scan-card") setScanCard(true);
    const m = o.match(/^add-doc(?::(\d+))?$/);
    if (m && (types.length || !m[1])) setDocModal({ mode: "add", type: m[1] ? types.find(x => x.id === Number(m[1])) ?? null : null });
  }, [types.length]);
  const passportScan = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append("file", file); return upload(`/workers/${workerId}/passport-scan`, fd); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["worker-docs", workerId] }); qc.invalidateQueries({ queryKey: ["worker-legality", workerId] });
      qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-questionnaire", workerId] });
      toast.success(t("Паспорт розпізнано — документ і анкета оновлені"));
    },
    onError: (e: any) => toast.error(e.message),
  });
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

  const recompute = useMutation({
    mutationFn: () => post<WorkerLegality>(`/workers/${workerId}/legality/recompute`),
    onSuccess: (data) => { qc.setQueryData(["worker-legality", workerId], data); toast.success(t("Перераховано")); },
    onError: (e: any) => toast.error(e.message),
  });

  const docByType = new Map<number, WorkerDocument>();
  for (const d of docs) if (d.docTypeId != null) docByType.set(d.docTypeId, d);
  const missingRequired = types.filter(ty => ty.required && !docByType.has(ty.id)).length;

  return (
    <>
      <Section icon={Scale} title={t("Легалізація і документи")}
        extra={missingRequired > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600"><AlertTriangle className="h-3 w-3" /> {t("бракує {n}", { n: missingRequired })}</span>}
        action={
          <div className="flex items-center gap-1.5">
            {canLegal && (
              <Button variant="secondary" className="px-2 py-1 text-xs" loading={recompute.isPending} onClick={() => recompute.mutate()}>
                <RefreshCw className="h-3.5 w-3.5" /> {t("Перерахувати")}
              </Button>
            )}
            <Button variant="secondary" className="px-2 py-1 text-xs" loading={docsInvite.isPending} onClick={() => docsInvite.mutate()}>{t("Запросити на скан+анкету")}</Button>
            <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => setDocModal({ mode: "add", type: null })}><Plus className="h-3.5 w-3.5" /> {t("Документ")}</Button>
          </div>
        }
        empty={t("Немає документів. Додайте типи в Налаштуваннях → Документи.")}>
        <LegalitySummary workerId={workerId} />
        <div className="border-t border-slate-100" />
        {isLoading ? <Spinner /> : (
          <DocSlotList types={types} docs={docs} companies={companies} nationality={nationality} requiresSanepid={requiresSanepid} globals={globals} canLegal={canLegal}
            onOpenDoc={doc => setDocModal({ mode: "edit", doc })}
            onOpenEmpty={(type, restrictCodes) => setDocModal({ mode: "add", type, restrictCodes })}
            onRequest={docTypeId => request.mutate(docTypeId)}
            onHistory={doc => setAuditFor(doc)}
            onDelete={async doc => { if (await confirm({ title: t("Видалити документ?"), danger: true, confirmText: t("Видалити") })) remove.mutate(doc.id); }}
            onVerify={doc => verify.mutate(doc.id)}
            onReject={doc => setRejecting(doc)}
            onPreview={doc => setPreview(doc)}
            onSend={doc => setSendFor(doc)}
            onScanCard={() => setScanCard(true)}
            onScanPassport={() => passportInputRef.current?.click()} />
        )}
        {/* скан паспорта зі слоту — той самий POST /workers/:id/passport-scan, що в анкеті (OCR → документ + анкета + профіль) */}
        <input ref={passportInputRef} type="file" accept="image/*,application/pdf" capture="environment" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) passportScan.mutate(f); e.target.value = ""; }} />
      </Section>
      {sendFor && <SendFileModal workerId={workerId} title={sendFor.title} endpoint={`/worker-documents/${sendFor.id}/send`} onClose={() => setSendFor(null)} />}
      {scanCard && <ResidenceCardScanModal workerId={workerId} types={types} onClose={() => setScanCard(false)} onSaved={() => { inv(); setScanCard(false); }} />}
      {docModal && (
        <DocModal workerId={workerId}
          doc={docModal.mode === "edit" ? docModal.doc : null}
          type={docModal.mode === "add" ? docModal.type : null}
          restrictCodes={docModal.mode === "add" ? docModal.restrictCodes ?? null : null}
          types={types} companies={companies} allDocs={docs} canLegal={canLegal} nationality={nationality} globals={globals}
          onClose={() => setDocModal(null)} onSaved={() => { inv(); setDocModal(null); }} />
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

// код.status_ukr + деякі legal-поля (validFrom/issuedAt/.../laborMarketAccess) —
// шляються окремим PATCH .../legal і доступні лише canLegal; number/expiresAt/
// title/status — базові поля документа, редагує будь-хто з доступом до профілю.
const LEGAL_FIELD_KEYS = new Set<DocFieldKey>(["validFrom", "issuedAt", "issuer", "employerCompanyId", "caseStatus", "submittedAt", "caseNumber", "decisionAt", "laborMarketAccess"]);

// Чиста календарна арифметика через UTC-якір (без toISOString() від "зараз" —
// тут дата вже рядок, зсуву TZ немає; те саме, що daysUntil у lib/legality.ts).
function addDaysStr(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

// Поспарувати текст/дата-поля по 2 в рядок для компактності; company/caseStatus/
// boolean завжди на весь рядок (не пасують до вузької колонки).
function pairFields(fields: DocField[]): DocField[][] {
  const rows: DocField[][] = [];
  let buf: DocField[] = [];
  for (const f of fields) {
    if (f.kind === "text" || f.kind === "date") {
      buf.push(f);
      if (buf.length === 2) { rows.push(buf); buf = []; }
    } else {
      if (buf.length) { rows.push(buf); buf = []; }
      rows.push([f]);
    }
  }
  if (buf.length) rows.push(buf);
  return rows;
}

function DocModal({ workerId, doc, type, restrictCodes, types, companies, canLegal, nationality, globals, onClose, onSaved }: {
  workerId: number; doc: WorkerDocument | null; type: DocumentType | null; restrictCodes: string[] | null;
  types: DocumentType[]; companies: Company[]; allDocs: WorkerDocument[]; canLegal: boolean;
  nationality: string | null; globals: LegalizationGlobals | undefined; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const isEdit = !!doc;
  const [docTypeId, setDocTypeId] = useState(doc?.docTypeId != null ? String(doc.docTypeId) : (type ? String(type.id) : ""));
  const [title, setTitle] = useState(doc?.title ?? "");
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
  // caseStatus за замовчуванням "submitted" — лише для stay_case_certificate
  // (єдиний тип із цим полем у каталозі), не для решти типів документа.
  const [caseStatus, setCaseStatus] = useState<CaseStatus | "">(doc?.caseStatus ?? (!doc && type?.code === "stay_case_certificate" ? "submitted" : ""));
  const [submittedAt, setSubmittedAt] = useState(doc?.submittedAt ?? "");
  const [caseNumber, setCaseNumber] = useState(doc?.caseNumber ?? "");
  const [decisionAt, setDecisionAt] = useState(doc?.decisionAt ?? "");
  const [replacesDocumentId] = useState(doc?.replacesDocumentId != null ? String(doc.replacesDocumentId) : "");
  const [laborMarketAccess, setLaborMarketAccess] = useState<boolean>(!!(doc?.attrs?.laborMarketAccess));
  // Тип навчання (student_cert, attrs.studyMode) — select-поле, читається/пишеться
  // через getStr/setStr нижче, як звичайне текстове поле (щоб потрапляти в required-перевірку).
  const [studyMode, setStudyMode] = useState<string>((doc?.attrs?.studyMode as string | undefined) ?? "");
  const [purpose, setPurpose] = useState<string>((doc?.attrs?.purpose as string | undefined) ?? ""); // мета TRC (attrs.purpose)
  const [showAllTypes, setShowAllTypes] = useState(false);
  const selectedType = types.find(ty => String(ty.id) === docTypeId) ?? type ?? null;
  const fields = fieldsFor(selectedType);
  // «Власний» документ без каталожного типу або тип other — редагована назва
  // й ручний статус (present/missing/expired/pending); для каталожних типів
  // статус визначають дати й верифікація, поле ховаємо (відгук власника 03.09.2026).
  const isCustomType = !selectedType || selectedType.code === "other";
  const effectiveTitle = isCustomType ? title : selectedType!.name;
  const hasNumberField = fields.some(f => f.key === "number");

  // Список типів: обмежений слотом (restrictCodes), активний АБО вже обраний,
  // і — за замовчуванням — той, що підходить громадянству (перемикач знімає фільтр).
  const restrictSet = restrictCodes?.length ? new Set(restrictCodes) : null;
  const typeOptions = types.filter(ty => {
    if (String(ty.id) === docTypeId) return true;
    if (ty.isActive === false) return false;
    if (!doc && SCAN_ONLY_CODES.has(ty.code ?? "")) return false; // новий паспорт/карта — лише через скан
    if (restrictSet && !restrictSet.has(ty.code ?? "")) return false;
    if (!showAllTypes && !typeMatchesNationality(ty, nationality)) return false;
    return true;
  });
  const CATEGORY_ORDER = Object.keys(DOC_CATEGORY_LABEL) as (keyof typeof DOC_CATEGORY_LABEL)[];
  const groupedTypes = CATEGORY_ORDER.map(cat => ({ cat, list: typeOptions.filter(ty => ty.category === cat) })).filter(g => g.list.length > 0);
  const natsText = (ty: DocumentType) => ty.appliesToNationalities?.length
    ? ty.appliesToNationalities.map(g => t(NAT_GROUP_LABEL[g] ?? natLabel(g) ?? g)).join(", ")
    : t("усіх");
  const typeOptionLabel = (ty: DocumentType) => {
    const marks = `${ty.grantsStay ? "🏠" : ""}${ty.grantsWork ? "💼" : ""}`;
    return `${ty.name}${marks ? " " + marks : ""} — ${t("для")}: ${natsText(ty)}`;
  };

  const getStr = (key: DocFieldKey): string => {
    switch (key) {
      case "number": return number;
      case "validFrom": return validFrom ?? "";
      case "expiresAt": return expiresAt ?? "";
      case "issuedAt": return issuedAt ?? "";
      case "issuer": return issuer;
      case "caseNumber": return caseNumber;
      case "submittedAt": return submittedAt ?? "";
      case "decisionAt": return decisionAt ?? "";
      case "employerCompanyId": return employerCompanyId;
      case "studyMode": return studyMode;
      case "purpose": return purpose;
      default: return "";
    }
  };
  const setStr = (key: DocFieldKey, v: string) => {
    switch (key) {
      case "number": setNumber(v); break;
      case "issuedAt": setIssuedAt(v); break;
      case "issuer": setIssuer(v); break;
      case "caseNumber": setCaseNumber(v); break;
      case "submittedAt": setSubmittedAt(v); break;
      case "decisionAt": setDecisionAt(v); break;
      case "employerCompanyId": setEmployerCompanyId(v); break;
      case "studyMode": setStudyMode(v); break;
      case "purpose": setPurpose(v); break;
      case "expiresAt": setExpiresAt(v); break;
      case "validFrom": {
        setValidFrom(v);
        // oświadczenie: порожній «До» автопідставляється як «Від» + 730 днів.
        const expField = fields.find(f => f.key === "expiresAt");
        if (expField?.auto === "plus730" && !expiresAt && v) setExpiresAt(addDaysStr(v, 730));
        break;
      }
    }
  };
  const fieldDisabled = (f: DocField) => LEGAL_FIELD_KEYS.has(f.key) && !canLegal;

  const renderField = (f: DocField) => {
    const req = f.required && <span className="ml-1 text-rose-500">*</span>;
    if (f.auto === "ukrEnd") {
      return (
        <div key={f.key}>
          <Label>{t(f.label)}</Label>
          <Input value={globals?.ukrStatusEnd ?? ""} disabled />
          {f.hint && <p className="mt-0.5 text-[11px] text-slate-400">{t(f.hint)}: {globals?.ukrStatusEnd ?? "—"}</p>}
        </div>
      );
    }
    if (f.kind === "boolean") {
      return (
        <label key={f.key} className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={laborMarketAccess} disabled={fieldDisabled(f)} onChange={e => setLaborMarketAccess(e.target.checked)} />
          {t(f.label)}
        </label>
      );
    }
    if (f.kind === "select") {
      return (
        <div key={f.key}><Label>{t(f.label)}{req}</Label>
          <Select value={getStr(f.key)} disabled={fieldDisabled(f)} onChange={e => setStr(f.key, e.target.value)}>
            <option value="">—</option>
            {f.options?.map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
          </Select>
          {f.hint && <p className="mt-0.5 text-[11px] text-slate-400">{t(f.hint)}</p>}
        </div>
      );
    }
    if (f.kind === "company") {
      return (
        <div key={f.key}><Label>{t(f.label)}{req}</Label>
          <Select value={employerCompanyId} disabled={fieldDisabled(f)} onChange={e => setEmployerCompanyId(e.target.value)}>
            <option value="">—</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
      );
    }
    if (f.kind === "caseStatus") {
      return (
        <div key={f.key}><Label>{t(f.label)}{req}</Label>
          <Select value={caseStatus} disabled={fieldDisabled(f)} onChange={e => setCaseStatus(e.target.value as CaseStatus | "")}>
            <option value="">—</option>
            {(Object.keys(CASE_STATUS_LABEL) as CaseStatus[]).map(cs => <option key={cs} value={cs}>{t(CASE_STATUS_LABEL[cs])}</option>)}
          </Select>
        </div>
      );
    }
    return (
      <div key={f.key}><Label>{t(f.label)}{req}</Label>
        <Input type={f.kind === "date" ? "date" : "text"} value={getStr(f.key)} disabled={fieldDisabled(f)} onChange={e => setStr(f.key, e.target.value)} />
      </div>
    );
  };

  // number — лише для типів, де це поле є в DOC_FIELD_SPEC (відгук власника
  // 03.09.2026: «не показувати й не надсилати» там, де його нема в специ).
  // Статус для каталожних типів не редагується вручну (поле сховане) — але
  // «запрошений» рядок (status=missing з /request), заповнений і збережений
  // тут, автоматично стає present; pending/expired/present лишаються як є.
  const body = () => ({
    docTypeId: docTypeId ? Number(docTypeId) : null, title: effectiveTitle.trim(),
    status: !isCustomType && status === "missing" ? "present" : status,
    ...(hasNumberField ? { number } : {}),
    expiresAt: expiresAt || null, fileUrl, note,
  });
  const legalBody = () => ({
    validFrom: validFrom || null, issuedAt: issuedAt || null, submittedAt: submittedAt || null, decisionAt: decisionAt || null, expiresAt: expiresAt || null,
    issuer: issuer.trim() || null, caseNumber: caseNumber.trim() || null,
    employerCompanyId: employerCompanyId ? Number(employerCompanyId) : null,
    caseStatus: caseStatus || null,
    replacesDocumentId: replacesDocumentId ? Number(replacesDocumentId) : null,
    // усі типоспецифічні атрибути — одним обʼєктом (окремі spread-и затирали б один одного)
    ...(fields.some(f => f.key === "laborMarketAccess" || f.key === "studyMode" || f.key === "purpose") ? {
      attrs: {
        ...(fields.some(f => f.key === "laborMarketAccess") ? { laborMarketAccess } : {}),
        ...(fields.some(f => f.key === "studyMode") ? { studyMode: studyMode || null } : {}),
        ...(fields.some(f => f.key === "purpose") ? { purpose: purpose || null } : {}),
      },
    } : {}),
  });
  const save = useMutation({
    mutationFn: async () => {
      const missing = fields
        .filter(f => f.required && f.auto !== "ukrEnd" && f.kind !== "boolean" && !fieldDisabled(f) && !getStr(f.key).trim())
        .map(f => t(f.label));
      if (missing.length) throw new Error(t("Заповніть обов'язкові поля: {list}", { list: missing.join(", ") }));
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
            const val = e.target.value;
            setDocTypeId(val);
            if (!isEdit && !caseStatus) {
              const ty = types.find(x => String(x.id) === val);
              if (ty?.code === "stay_case_certificate") setCaseStatus("submitted");
            }
          }}>
            {!restrictSet && <option value="">{t("— власний —")}</option>}
            {groupedTypes.map(g => (
              <optgroup key={g.cat} label={t(DOC_CATEGORY_LABEL[g.cat])}>
                {g.list.map(ty => <option key={ty.id} value={ty.id}>{typeOptionLabel(ty)}</option>)}
              </optgroup>
            ))}
          </Select>
          {selectedType && (
            <p className="mt-1 text-xs text-slate-400">
              {t("Дає: {grants} · для: {nats}", {
                grants: [selectedType.grantsStay && t(AXIS_LABEL.stay), selectedType.grantsWork && t(AXIS_LABEL.work)].filter(Boolean).join(" / ") || "—",
                nats: natsText(selectedType),
              })}
            </p>
          )}
          <label className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={showAllTypes} onChange={e => setShowAllTypes(e.target.checked)} /> {t("Показати всі типи")}
          </label>
        </div>
        {isCustomType && (
          <>
            <div><Label>{t("Назва")}</Label><Input value={title} onChange={e => setTitle(e.target.value)} placeholder={t("Назва документа")} /></div>
            <div><Label>{t("Статус")}</Label>
              <Select value={status} onChange={e => setStatus(e.target.value)}>
                {Object.entries(DOC_STATUS).map(([k, v]) => <option key={k} value={k}>{t(v.label)}</option>)}
              </Select>
            </div>
          </>
        )}

        {pairFields(fields).map((row, i) => (
          <div key={i} className={row.length === 2 ? "grid grid-cols-2 gap-2" : ""}>
            {row.map(renderField)}
          </div>
        ))}

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

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => effectiveTitle.trim() && save.mutate()}>{isEdit ? t("Зберегти") : t("Додати")}</Button>
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
  // коли виплати йдуть за документами, ручне поле на гроші не впливає — підказка
  const { data: lg } = useQuery<WorkerLegality | null>({ queryKey: ["worker-legality", workerId], queryFn: () => get(`/workers/${workerId}/legality`) });
  const byDocs = lg?.effectiveSource === "documents";
  return (
    <InfoRow icon={IdCard} label={t("Форма легалізації")} title={byDocs ? t("Виплати зараз ідуть за документами — це поле на гроші не впливає, поки людина повністю оформлена") : undefined}>
      <select value={legalStatus ?? ""} onChange={e => submit(e.target.value)}
        className="max-w-full rounded border border-transparent bg-transparent py-0.5 pr-5 text-sm font-medium text-slate-700 hover:border-slate-300 focus:border-red-400 focus:outline-none">
        <option value="">—</option>
        {LEGAL_STATUSES.map(s => <option key={s} value={s}>{t(LEGAL_LABEL[s])}</option>)}
      </select>
      {badge && <span className={`rounded px-1 text-[10px] font-medium ${badge.cls}`}>{badge.short}</span>}
      {byDocs && <span className="rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-700" title={t("виплати за документами")}>{t("док.")}</span>}
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

// Перший робочий день: система ставить сама з першої явки «присутній» у затвердженому
// тижні; графікова може вписати/виправити (editData). Від нього — powiadomienie UA (7 днів).
function FirstWorkDateRow({ workerId, date, readOnly }: { workerId: number; date: string | null; readOnly?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(date ?? "");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { firstWorkDate: draft || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); qc.invalidateQueries({ queryKey: ["worker-legality"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <InfoRow icon={CalendarCheck} label={t("Перший робочий день")}>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="date" value={draft} onChange={e => setDraft(e.target.value)} className="rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={() => save.mutate()}>{t("Зберегти")}</button>
          <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
        </span>
      ) : readOnly ? (
        <span className="font-medium text-slate-700">{date ? new Date(date + "T00:00:00").toLocaleDateString("uk-UA") : "—"}</span>
      ) : (
        <button className="font-medium text-slate-700 hover:text-red-600" title={t("Ставиться сам з першої явки «присутній» у затвердженому графіку; можна вписати руками")} onClick={() => { setDraft(date ?? ""); setEditing(true); }}>
          {date ? new Date(date + "T00:00:00").toLocaleDateString("uk-UA") : t("ще не було явки — вказати")}
        </button>
      )}
    </InfoRow>
  );
}

// Виповідзення: запланована дата звільнення — крон звільняє в цю дату (дата ≤ сьогодні — одразу).
function TerminationRow({ workerId, date, readOnly }: { workerId: number; date: string | null; readOnly?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const confirmDlg = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(date ?? "");
  const save = useMutation({
    mutationFn: (d: string | null) => post<{ firedNow: boolean }>(`/workers/${workerId}/termination`, { date: d }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["workers"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setEditing(false); toast.success(r.firedNow ? t("Дата вже настала — працівника звільнено") : t("Збережено")); },
    onError: (e: any) => toast.error(e.message),
  });
  const submit = async () => {
    if (!draft) return save.mutate(null);
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
    if (draft <= today && !(await confirmDlg({ title: t("Звільнити зараз?"), message: t("Дата вже настала — працівник буде звільнений одразу цією датою."), confirmText: t("Звільнити") }))) return;
    save.mutate(draft);
  };
  return (
    <InfoRow icon={UserX} label={t("Виповідзення")}>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="date" value={draft} onChange={e => setDraft(e.target.value)} className="rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={submit}>{t("Зберегти")}</button>
          {date && <button className="text-xs text-rose-500" onClick={() => save.mutate(null)}>{t("скасувати виповідзення")}</button>}
          <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
        </span>
      ) : readOnly ? (
        <span className="font-medium text-slate-700">{date ? `${t("звільнення з")} ${new Date(date + "T00:00:00").toLocaleDateString("uk-UA")}` : "—"}</span>
      ) : (
        <button className={date ? "font-medium text-amber-700 hover:text-red-600" : "font-medium text-slate-400 hover:text-red-600"} title={t("Працівник подав дату, з якої звільняється: у цю дату система звільнить сама")} onClick={() => { setDraft(date ?? ""); setEditing(true); }}>
          {date ? `${t("звільнення з")} ${new Date(date + "T00:00:00").toLocaleDateString("uk-UA")}` : t("немає — вказати дату")}
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
    absences: { entryId: number; factory: string | null; date: string; shift: string; reason: string | null; explainedAt?: string | null; attachments?: { id: number; fileName: string | null; fileMime: string | null }[]; excused: boolean; justified: boolean; penalty: number; deductedMonth: string | null; deductedAmount: number | null }[];
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
                    {a.reason && <span className="ml-1.5 text-xs text-slate-400" title={a.explainedAt ? `${a.reason} (${t("пояснено")} ${new Date(a.explainedAt).toLocaleDateString("uk-UA")})` : a.reason}>{a.reason.length > 24 ? a.reason.slice(0, 24) + "…" : a.reason}{a.explainedAt && <span className="ml-1 text-slate-300">({new Date(a.explainedAt).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" })})</span>}</span>}
                    {!!a.attachments?.length && <span className="ml-1"><AbsenceFiles files={a.attachments} compact /></span>}
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

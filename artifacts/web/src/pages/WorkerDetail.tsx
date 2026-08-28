import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Building2, Factory as FactoryIcon, Send, Clock, CalendarCheck, UserX, Activity, Gift,
  FileText, Plus, Pencil, Trash2, ExternalLink, AlertTriangle, Briefcase, Users, Upload, Car, Cake, IdCard, Wallet, BadgePlus, History, Home, KeyRound, Shirt
} from "lucide-react";
import { ProfileChangeModal, CHANGE_FIELD_LABEL, PAYOUT_PREF_LABEL, fmtVal, type RequestChange } from "../components/ProfileChangeModal";
import { can } from "../lib/roles";
import { LEGAL_STATUSES, LEGAL_LABEL, LEGAL_BADGE, type LegalStatus } from "../lib/legalStatus";
import { get, post, patch, del, upload, type DocumentType, type WorkerDocument, type Worker, type Factory, type Company, type Gender } from "../lib/api";
import { Button, Card, Spinner, Badge, Empty, Modal, Input, Select, Label } from "../components/ui";
import { WorkerModal } from "../components/WorkerModal";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { badgeClass, dotClass, genderIcon, genderClass } from "../lib/colors";
import { NatFlag, NATIONALITIES } from "../lib/nationality";
import { useClothingTypes } from "../lib/clothingTypes";

type BadaniaEntry = { id: number; amount: number; enteredAt: string; deducted: boolean; deductedAt: string | null; note: string | null };

interface WorkerProfile {
  id: number; fullName: string; workerCode: string | null; telegramId: string | null;
  factoryId: number | null; factoryName: string | null; companyId: number | null; companyName: string | null;
  positionId: number | null; positionName: string | null; positionColor: string | null;
  gender: string | null; fixedShift: string | null; selfTransport: boolean;
  selfTransportSince?: string | null;
  gratyfikantName?: string | null; pesel?: string | null;
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
// повнорозмірної заглушки (сторінка з порожніми блоками лишається компактною)
function Section({ icon: Icon, title, extra, action, empty, children }: {
  icon?: any; title: string; extra?: React.ReactNode; action?: React.ReactNode; empty?: string; children: React.ReactNode | null;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-2.5">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-slate-400" />}
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {extra}
        {action && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children ?? <div className="px-5 py-2 text-sm text-slate-400">{empty}</div>}
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
    gratyfikantName: w.gratyfikantName ?? null, pesel: w.pesel ?? null,
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
              {w.gender && <span className={`text-lg font-semibold ${genderClass(w.gender)}`} title={w.gender === "male" ? t("Чоловік") : t("Жінка")}>{genderIcon(w.gender)}</span>}
              {!w.isActive && <Badge color="rose">{t("звільнений")}</Badge>}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              {w.workerCode && <span className="font-mono">{w.workerCode}</span>}
              {w.positionName && <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass(w.positionColor ?? "slate")}`}><span className={`h-1.5 w-1.5 rounded-full ${dotClass(w.positionColor ?? "slate")}`} />{w.positionName}</span>}
              {w.companyName && <Badge color="blue">{w.companyName}</Badge>}
              {w.factoryName && <Badge color="red">{w.factoryName}</Badge>}
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
            <InfoRow icon={Building2} label={t("Фірма")}>
              <InlineSelect value={w.companyId != null ? String(w.companyId) : ""} onChange={v => wpatch.mutate({ companyId: v ? Number(v) : null })}
                options={companies.map(c => ({ value: String(c.id), label: c.name }))} />
            </InfoRow>
            <InfoRow icon={FactoryIcon} label={t("Фабрика")}>
              <InlineSelect value={w.factoryId != null ? String(w.factoryId) : ""} onChange={v => wpatch.mutate({ factoryId: v ? Number(v) : null })}
                options={factories.map(f => ({ value: String(f.id), label: f.name }))} />
            </InfoRow>
            <InfoRow icon={Briefcase} label={t("Посада")}>
              <InlineSelect value={w.positionId != null ? String(w.positionId) : ""}
                onChange={v => { const p = v ? Number(v) : null; if (requestChange) requestChange({ positionId: p }, t("Посада")); else wpatch.mutate({ positionId: p }); }}
                options={posOptions} />
            </InfoRow>
            <InfoRow icon={Users} label={t("Стать")}>
              <InlineSelect value={w.gender ?? ""} onChange={v => wpatch.mutate({ gender: v || null })}
                options={[{ value: "male", label: t("Чоловік") }, { value: "female", label: t("Жінка") }]} />
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
          </InfoGroup>
          <InfoGroup title={t("Особисте")}>
            <BirthDateRow workerId={w.id} birthDate={w.birthDate ?? null} under26Fallback={w.under26 ?? null} onRequest={requestChange} />
            <InfoRow icon={KeyRound} label="PESEL">
              <InlineText value={w.pesel ?? ""} placeholder={t("вказати")} width="w-32" onSave={v => wpatch.mutate({ pesel: v.trim() || null })} />
            </InfoRow>
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
            <EmploymentDateRow workerId={w.id} date={w.employmentStartDate ?? null} readOnly={w.payoutPrefKind === undefined} onRequest={requestChange} />
            <NotifyHoursRow workerId={w.id} notifyHours={w.notifyHours ?? null} onRequest={requestChange} />
            {w.payoutPrefKind !== undefined && (
              <PayoutPrefRow workerId={w.id} kind={w.payoutPrefKind ?? null} value={w.payoutPrefValue ?? null} onRequest={requestChange} />
            )}
            {(w.agramFactory || w.cashBonusFactory) && (
              <AgramBonusRow workerId={w.id} staz={!!w.agramStazBonus} cash={!!w.agramCashBonus} startDate={w.employmentStartDate ?? null} cashOnly={!w.agramFactory} onRequest={requestChange} />
            )}
            <BadaniaRow workerId={w.id} entries={w.badania ?? []} />
            {w.gratyfikantName !== undefined && (
              <InfoRow icon={Briefcase} label={t("Імʼя в Gratyfikancie")}>
                <InlineText value={w.gratyfikantName ?? ""} placeholder={t("вказати")} width="w-44" onSave={v => wpatch.mutate({ gratyfikantName: v.trim() || null })} />
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
            <Section icon={FactoryIcon} title={t("Історія по фабриках")}>
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
          <Section icon={CalendarCheck} title={t("Останні зміни")} empty={t("Немає відпрацьованих змін")}>
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
          <WorkerDocuments workerId={w.id} />
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

// ─── Documents ────────────────────────────────────────────────────────────────
const DOC_STATUS: Record<string, { label: string; color: "green" | "rose" | "amber" | "slate" }> = {
  present: { label: "наявний", color: "green" },
  missing: { label: "відсутній", color: "rose" },
  expired: { label: "прострочений", color: "amber" },
  pending: { label: "очікується", color: "slate" },
};
const isExpired = (iso?: string | null) => !!iso && new Date(iso + "T00:00:00").getTime() < Date.now();

function WorkerDocuments({ workerId }: { workerId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: types = [] } = useQuery<DocumentType[]>({ queryKey: ["document-types"], queryFn: () => get("/document-types") });
  const { data: docs = [], isLoading } = useQuery<WorkerDocument[]>({ queryKey: ["worker-docs", workerId], queryFn: () => get(`/workers/${workerId}/documents`) });
  const [editing, setEditing] = useState<WorkerDocument | null>(null);
  const [addFor, setAddFor] = useState<DocumentType | null | "custom">(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["worker-docs", workerId] });
  const remove = useMutation({ mutationFn: (id: number) => del(`/worker-documents/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });

  const docByType = new Map<number, WorkerDocument>();
  for (const d of docs) if (d.docTypeId != null) docByType.set(d.docTypeId, d);
  const extras = docs.filter(d => d.docTypeId == null || !types.some(ty => ty.id === d.docTypeId));

  const missingRequired = types.filter(ty => ty.required && !docByType.has(ty.id)).length;

  const row = (key: string, name: string, required: boolean, doc: WorkerDocument | undefined, type: DocumentType | null) => {
    const expired = doc && (doc.status === "expired" || isExpired(doc.expiresAt));
    const status = doc ? (expired && doc.status === "present" ? "expired" : doc.status) : "missing";
    const s = DOC_STATUS[status] ?? DOC_STATUS.missing;
    return (
      <div key={key} className="flex flex-wrap items-center gap-2 border-b border-slate-50 px-4 py-2.5 text-sm last:border-0">
        <FileText className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="font-medium text-slate-700">{name}</span>
        {required && <span className="text-[10px] font-semibold uppercase text-amber-500">{t("обов'язковий")}</span>}
        <Badge color={s!.color}>{t(s!.label)}</Badge>
        {doc?.expiresAt && <span className={`text-xs ${isExpired(doc.expiresAt) ? "font-medium text-rose-600" : "text-slate-400"}`}>⏳ {doc.expiresAt}</span>}
        {doc?.number && <span className="text-xs text-slate-400">№ {doc.number}</span>}
        {doc?.fileName && <a href={`/api/worker-documents/${doc.id}/file`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-red-600 hover:underline" title={doc.fileName}>{t("файл")} <ExternalLink className="h-3 w-3" /></a>}
        {doc?.fileUrl && <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-red-600 hover:underline">{t("посилання")} <ExternalLink className="h-3 w-3" /></a>}
        {doc?.note && <span className="truncate text-xs text-slate-400" title={doc.note}>📝 {doc.note}</span>}
        <div className="ml-auto flex shrink-0 gap-1">
          {doc
            ? <>
                <button onClick={() => setEditing(doc)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Редагувати")}><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={async () => { if (await confirm({ title: t("Видалити документ?"), danger: true, confirmText: t("Видалити") })) remove.mutate(doc.id); }} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
              </>
            : <button onClick={() => setAddFor(type)} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"><Plus className="h-3.5 w-3.5" /> {t("Додати")}</button>}
        </div>
      </div>
    );
  };

  return (
    <>
      <Section icon={FileText} title={t("Документи")}
        extra={missingRequired > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600"><AlertTriangle className="h-3 w-3" /> {t("бракує {n}", { n: missingRequired })}</span>}
        action={<Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => setAddFor("custom")}><Plus className="h-3.5 w-3.5" /> {t("Документ")}</Button>}
        empty={t("Немає документів. Додайте типи в Налаштуваннях → Документи.")}>
        {isLoading ? <Spinner /> : (types.length || extras.length) ? (
          <div>
            {types.map(ty => row(`ty${ty.id}`, ty.name, ty.required, docByType.get(ty.id), ty))}
            {extras.map(d => row(`ex${d.id}`, d.title, false, d, null))}
          </div>
        ) : null}
      </Section>
      {(addFor !== null || editing) && (
        <DocModal workerId={workerId} doc={editing} type={addFor === "custom" ? null : addFor} types={types}
          onClose={() => { setAddFor(null); setEditing(null); }} onSaved={() => { inv(); setAddFor(null); setEditing(null); }} />
      )}
    </>
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

function DocModal({ workerId, doc, type, types, onClose, onSaved }: {
  workerId: number; doc: WorkerDocument | null; type: DocumentType | null; types: DocumentType[]; onClose: () => void; onSaved: () => void;
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
  const body = () => ({ docTypeId: docTypeId ? Number(docTypeId) : null, title: title.trim(), status, number, expiresAt: expiresAt || null, fileUrl, note });
  const save = useMutation({
    mutationFn: async () => {
      const saved: WorkerDocument = isEdit ? await patch(`/worker-documents/${doc!.id}`, body()) : await post(`/workers/${workerId}/documents`, body());
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        await upload(`/worker-documents/${saved.id}/file`, fd);
      }
      return saved;
    },
    onSuccess: () => { toast.success(isEdit ? t("Збережено") : t("Додано")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={isEdit ? t("Редагувати документ") : t("Новий документ")}>
      <div className="space-y-3">
        <div><Label>{t("Тип документа")}</Label>
          <Select value={docTypeId} onChange={e => { setDocTypeId(e.target.value); const ty = types.find(x => String(x.id) === e.target.value); if (ty && !title.trim()) setTitle(ty.name); }}>
            <option value="">{t("— власний —")}</option>
            {types.map(ty => <option key={ty.id} value={ty.id}>{ty.name}</option>)}
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

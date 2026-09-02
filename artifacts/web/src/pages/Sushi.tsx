import { useMemo, useState, useRef, useEffect } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Plus,
  Trash2,
  Edit2,
  Link2,
  Lock,
  Calendar,
  Clock,
  Shirt,
  Search,
  Filter,
  ArrowRight,
  ShieldAlert,
  ChevronDown,
  ChevronRight,
  UserCheck,
  Check,
  Building2,
  RefreshCw,
  Sliders,
  Table,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "../components/Layout";
import {
  Card,
  Button,
  Input,
  Select,
  Badge,
  Modal,
  Label,
  Spinner,
  Empty,
  cn,
} from "../components/ui";
import { useConfirm } from "../components/confirm";
import { monthOptions } from "../lib/dates";
import { useT } from "../lib/i18n";
import {
  fetchSushiRoles,
  fetchSushiLines,
  createSushiLine,
  addSushiLineAlias,
  fetchSushiSupervisors,
  saveSushiSupervisor,
  fetchSushiWorkerCodes,
  createSushiWorkerCode,
  deleteSushiWorkerCode,
  previewSushiExcel,
  uploadSushiReport,
  fetchSushiImportBatches,
  fetchSushiStaging,
  patchSushiStaging,
  linkSushiRcpAlias,
  approveSushiValidStaging,
  updateSushiBatchDate,
  fetchSushiTimesheetTree,
  fetchSushiIntervals,
  createSushiInterval,
  patchSushiInterval,
  deleteSushiInterval,
  fetchSushiDisputes,
  createSushiDispute,
  resolveSushiDispute,
  rejectSushiDispute,
  fetchSushiZalacznik,
  lockSushiZalacznik,
  fetchSushiReconciliation,
  createSushiException,
  type SushiStagingEntry,
  type SushiIntervalItem,
  type SushiDispute,
  type SushiLine,
  type SushiSupervisor,
  type SushiWorkerCode,
  type SushiColumnMapping,
  type ExcelPreviewData,
} from "../lib/sushiApi";
import { get } from "../lib/api";

const fmt = (n: number) =>
  n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Sushi() {
  const t = useT();
  const [, params] = useRoute("/sushi/:tab");
  const tab = (params?.tab as "import" | "timesheet" | "disputes" | "finance" | "settings") || "import";

  const TITLES: Record<string, { title: string; subtitle: string }> = {
    import: {
      title: t("Суші: Імпорт та Staging звітів"),
      subtitle: t("Шлюз завантаження та попередньої валідації щоденних змін бригадирів"),
    },
    timesheet: {
      title: t("Суші: Табель робочих годин"),
      subtitle: t("Дерево змін, 15-хвилинне округлення та ручні коригування"),
    },
    disputes: {
      title: t("Суші: Скарги по годинах"),
      subtitle: t("Узгодження розбіжностей у табелі та дисциплінарні штрафи бригадирів"),
    },
    finance: {
      title: t("Суші: Фінанси та Załącznik do faktury"),
      subtitle: t("Консолідований розрахунок для клієнта та двоконтурна звірка годин"),
    },
    settings: {
      title: t("Суші: Налаштування проєкту"),
      subtitle: t("Довідники цехів, виробничих ліній, підписів бригадирів та аліасів табельних номерів"),
    },
  };

  const headerInfo = TITLES[tab] || TITLES.import;

  return (
    <div className="space-y-6">
      <PageHeader
        title={headerInfo.title}
        subtitle={headerInfo.subtitle}
      />

      {/* Tab Panels — керуються через бічне підменю проєкту */}
      {tab === "import" && <ImportTab />}
      {tab === "timesheet" && <TimesheetTab />}
      {tab === "disputes" && <DisputesTab />}
      {tab === "finance" && <FinanceTab />}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}

// ─── 1. ВКЛАДКА ІМПОРТ ТА STAGING ──────────────────────────────────────────

function ImportTab() {
  const t = useT();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mappingFileInputRef = useRef<HTMLInputElement>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<number | undefined>();
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [linkingEntry, setLinkingEntry] = useState<SushiStagingEntry | null>(null);
  const [mappingFile, setMappingFile] = useState<File | null>(null);

  const { data: batches = [], isLoading: loadingBatches } = useQuery({
    queryKey: ["sushi-batches"],
    queryFn: () => fetchSushiImportBatches(),
  });

  const activeBatch = useMemo(() => {
    if (selectedBatchId) return batches.find((b) => b.id === selectedBatchId);
    return batches[0];
  }, [batches, selectedBatchId]);

  const { data: stagingEntries = [], isLoading: loadingStaging } = useQuery({
    queryKey: ["sushi-staging", activeBatch?.id, statusFilter],
    queryFn: () =>
      fetchSushiStaging({
        batchId: activeBatch?.id,
        status: statusFilter === "ALL" ? undefined : statusFilter,
      }),
    enabled: !!activeBatch?.id,
  });

  const uploadMutation = useMutation({
    mutationFn: ({ files, mapping }: { files: File | File[]; mapping?: SushiColumnMapping }) =>
      uploadSushiReport(files, 1, mapping),
    onSuccess: (res) => {
      toast.success(
        t("Успішно оброблено {count} файлів! Всього рядків: {total}, валідних: {valid}, помилок: {err}", {
          count: res.batchesCount || 1,
          total: res.totalRows,
          valid: res.validRows,
          err: res.errorRows,
        }),
      );
      setMappingFile(null);
      qc.invalidateQueries({ queryKey: ["sushi-batches"] });
      if (res.batchId) setSelectedBatchId(res.batchId);
    },
    onError: (err: any) => {
      toast.error(err.message || t("Помилка завантаження файлу"));
    },
  });

  const approveMutation = useMutation({
    mutationFn: (batchId: number) => approveSushiValidStaging(batchId),
    onSuccess: (res) => {
      toast.success(t("Успішно перенесено {count} валідних інтервалів у табель!", { count: res.committed }));
      qc.invalidateQueries({ queryKey: ["sushi-staging"] });
      qc.invalidateQueries({ queryKey: ["sushi-batches"] });
      qc.invalidateQueries({ queryKey: ["sushi-intervals"] });
    },
    onError: (err: any) => {
      toast.error(err.message || t("Помилка перенесення рядків"));
    },
  });

  const [editingBatchDate, setEditingBatchDate] = useState<string>("");

  useEffect(() => {
    if (activeBatch) {
      setEditingBatchDate(activeBatch.reportDate || "");
    }
  }, [activeBatch?.id, activeBatch?.reportDate]);

  const updateBatchDateMutation = useMutation({
    mutationFn: ({ batchId, date }: { batchId: number; date: string }) => updateSushiBatchDate(batchId, date),
    onSuccess: () => {
      toast.success(t("Дату звіту успішно встановлено!"));
      qc.invalidateQueries({ queryKey: ["sushi-batches"] });
      qc.invalidateQueries({ queryKey: ["sushi-staging"] });
    },
    onError: (err: any) => {
      toast.error(err.message || t("Помилка оновлення дати звіту"));
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const fileArray = Array.from(fileList);
    e.target.value = ""; // Безпечне очищення після копіювання
    uploadMutation.mutate({ files: fileArray });
  };

  const handleMappingFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    e.target.value = "";
    if (file) setMappingFile(file);
  };

  const validEntriesCount = useMemo(
    () => stagingEntries.filter((e) => e.validationStatus === "OK" && !e.isProcessed).length,
    [stagingEntries],
  );

  return (
    <div className="space-y-6">
      {/* Upload Banner */}
      <Card className="p-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4 border-2 border-dashed border-slate-200 rounded-xl p-6 bg-slate-50/50 hover:bg-slate-50 transition">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-red-100 text-red-600 rounded-xl">
              <FileSpreadsheet className="w-8 h-8" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800 text-base">
                {t("Завантажити щоденні звіти зміни (Excel)")}
              </h3>
              <p className="text-xs text-slate-500">
                {t("Можна обрати один або кілька файлів (наприклад 20 звітів за раз) або налаштувати стовпчики візуально.")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept=".xlsx,.xls"
              multiple
              className="hidden"
            />
            <input
              type="file"
              ref={mappingFileInputRef}
              onChange={handleMappingFileSelect}
              accept=".xlsx,.xls"
              className="hidden"
            />
            <Button
              variant="secondary"
              onClick={() => mappingFileInputRef.current?.click()}
              className="gap-2"
            >
              <Sliders className="w-4 h-4 text-blue-600" />
              {t("Візуальне налаштування")}
            </Button>
            <Button
              onClick={() => fileInputRef.current?.click()}
              loading={uploadMutation.isPending}
              className="gap-2"
            >
              <Upload className="w-4 h-4" />
              {t("Швидкий імпорт")}
            </Button>
          </div>
        </div>
      </Card>

      {/* Visual Mapping Modal */}
      {mappingFile && (
        <ExcelMappingModal
          file={mappingFile}
          onClose={() => setMappingFile(null)}
          onUpload={(f, m) => uploadMutation.mutate({ files: f, mapping: m })}
        />
      )}

      {/* Batches Selector & Action Bar */}
      {batches.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Label>{t("Звіт за дату:")}</Label>
              <Select
                value={activeBatch?.id ?? ""}
                onChange={(e) => setSelectedBatchId(Number(e.target.value))}
                className="w-72 font-medium"
              >
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.isDateMissing || !b.reportDate ? `⚠ [БЕЗ ДАТИ] ${b.sourceFilename}` : `${b.reportDate} (${b.sourceFilename})`} — {b.validRowsCount} ОК / {b.errorRowsCount} ⚠
                  </option>
                ))}
              </Select>

              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-xs font-medium">
                {[
                  ["ALL", t("Усі рядки")],
                  ["OK", t("Валідні (OK)")],
                  ["CHECK_ID", t("Потрібна прив'язка (CHECK_ID)")],
                  ["INVALID_TIME", t("Помилка часу")],
                  ["MISSING_SIGNATURE", t("Без підпису")],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setStatusFilter(k)}
                    className={`px-2.5 py-1 rounded-md transition ${
                      statusFilter === k ? "bg-white shadow-xs font-semibold text-slate-800" : "text-slate-500"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {activeBatch && activeBatch.status !== "PROCESSED" && (
              <div className="flex items-center gap-3">
                {(activeBatch.isDateMissing || !activeBatch.reportDate) && (
                  <span className="text-xs font-semibold text-amber-700 bg-amber-100 px-3 py-1.5 rounded-lg border border-amber-300 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    {t("Затвердження заблоковано: вкажіть дату звіту")}
                  </span>
                )}
                <Button
                  variant="success"
                  disabled={validEntriesCount === 0 || activeBatch.isDateMissing || !activeBatch.reportDate || approveMutation.isPending}
                  loading={approveMutation.isPending}
                  onClick={() => approveMutation.mutate(activeBatch.id)}
                  className="gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {t("Затвердити всі валідні ({count})", { count: validEntriesCount })}
                </Button>
              </div>
            )}
          </div>

          {/* Missing Date Alert & Quick Fix Bar */}
          {activeBatch && (activeBatch.isDateMissing || !activeBatch.reportDate) && (
            <div className="p-3.5 bg-amber-50 border-2 border-amber-400 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-amber-900 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-200/80 rounded-lg text-amber-800 shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-amber-950">
                    {t("Увага: у файлі не вказано дату зміни!")}
                  </div>
                  <div className="text-xs text-amber-800">
                    {t("Бригадир не заповнив клітинку дати в Excel. Затвердження інтервалів заблоковано, доки ви не вкажете дату звіту:")}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  value={editingBatchDate}
                  onChange={(e) => setEditingBatchDate(e.target.value)}
                  className="w-36 py-1.5 px-2 text-xs font-mono bg-white border-amber-400"
                />
                <Button
                  variant="primary"
                  disabled={!editingBatchDate || updateBatchDateMutation.isPending}
                  loading={updateBatchDateMutation.isPending}
                  onClick={() => {
                    if (activeBatch && editingBatchDate) {
                      updateBatchDateMutation.mutate({ batchId: activeBatch.id, date: editingBatchDate });
                    }
                  }}
                  className="text-xs py-1.5 px-3 whitespace-nowrap bg-amber-600 hover:bg-amber-700 text-white font-semibold"
                >
                  {t("Зберегти дату")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Staging Entries Table */}
      <Card className="overflow-hidden">
        {loadingBatches || loadingStaging ? (
          <Spinner />
        ) : !activeBatch ? (
          <Empty>{t("Ще не завантажено жодного щоденного звіту")}</Empty>
        ) : stagingEntries.length === 0 ? (
          <Empty>{t("Немає записів за обраним фільтром")}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/75 text-slate-500 font-semibold uppercase">
                  <th className="py-3 px-4">#</th>
                  <th className="py-3 px-4">{t("Фірма")}</th>
                  <th className="py-3 px-4">{t("Nr RCP")}</th>
                  <th className="py-3 px-4">{t("Працівник (Розпізнано)")}</th>
                  <th className="py-3 px-4">{t("Цех / Лінія")}</th>
                  <th className="py-3 px-4">{t("Час (OD – DO)")}</th>
                  <th className="py-3 px-4">{t("Години")}</th>
                  <th className="py-3 px-4">{t("Підпис")}</th>
                  <th className="py-3 px-4">{t("Статус")}</th>
                  <th className="py-3 px-4 text-right">{t("Дії")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {stagingEntries.map((entry) => {
                  return (
                    <tr
                      key={entry.id}
                      className={cn(
                        "hover:bg-slate-50/50 transition",
                        entry.validationStatus === "CHECK_ID" && "bg-amber-50/30",
                        entry.validationStatus === "INVALID_TIME" && "bg-red-50/30",
                        entry.isProcessed && "opacity-60 bg-slate-50/80",
                      )}
                    >
                      <td className="py-3 px-4 text-slate-400">{entry.rowNumber}</td>
                      <td className="py-3 px-4">
                        <Badge color={entry.rawFirma === "ES" ? "blue" : "amber"}>
                          {entry.rawFirma || "—"}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold">{entry.rawRcp || "—"}</td>
                      <td className="py-3 px-4">
                        {entry.workerName ? (
                          <div className="font-semibold text-slate-800">{entry.workerName}</div>
                        ) : (
                          <span className="text-amber-600 italic">{t("Не знайдено в базі")}</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-slate-600">{entry.lineName || entry.rawDzial || "—"}</span>
                      </td>
                      <td className="py-3 px-4 font-mono">
                        {entry.rawOd || "—"} → {entry.rawDo || "—"}
                      </td>
                      <td className="py-3 px-4 font-semibold text-slate-800">
                        {(() => {
                          if (!entry.rawRealneGodziny) return "—";
                          const parsed = parseFloat(String(entry.rawRealneGodziny).replace(",", "."));
                          if (isNaN(parsed)) return entry.rawRealneGodziny;
                          const h = parsed < 1 && parsed > 0 ? parsed * 24 : parsed;
                          return `${h.toFixed(2)} год`;
                        })()}
                      </td>
                      <td className="py-3 px-4 text-slate-600">{entry.rawPodpis || "—"}</td>
                      <td className="py-3 px-4">
                        <StagingStatusBadge status={entry.validationStatus} isProcessed={entry.isProcessed} />
                        {entry.errorMessage && (
                          <div className="text-[10px] text-red-500 font-normal mt-0.5 max-w-[200px] truncate" title={entry.errorMessage}>
                            {entry.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {!entry.isProcessed && entry.validationStatus === "CHECK_ID" && (
                          <Button
                            variant="secondary"
                            className="text-xs py-1 px-2.5 h-auto text-amber-700 hover:text-amber-800"
                            onClick={() => setLinkingEntry(entry)}
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            {t("Прив'язати аліас")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Link Alias Modal */}
      {linkingEntry && (
        <LinkAliasModal
          entry={linkingEntry}
          onClose={() => setLinkingEntry(null)}
          onSuccess={() => {
            setLinkingEntry(null);
            qc.invalidateQueries({ queryKey: ["sushi-staging"] });
            qc.invalidateQueries({ queryKey: ["sushi-batches"] });
            qc.invalidateQueries({ queryKey: ["sushi-worker-codes"] });
          }}
        />
      )}
    </div>
  );
}

function StagingStatusBadge({ status, isProcessed }: { status: string; isProcessed: boolean }) {
  const t = useT();
  if (isProcessed) {
    return <Badge color="slate">{t("Оброблено")}</Badge>;
  }
  switch (status) {
    case "OK":
      return <Badge color="green">{t("Готовий до табеля")}</Badge>;
    case "CHECK_ID":
      return <Badge color="amber">{t("Невідомий RCP")}</Badge>;
    case "INVALID_TIME":
      return <Badge color="rose">{t("Помилка часу")}</Badge>;
    case "MISSING_SIGNATURE":
      return <Badge color="amber">{t("Без підпису")}</Badge>;
    case "UNKNOWN_LINE":
      return <Badge color="rose">{t("Невідомий цех")}</Badge>;
    default:
      return <Badge color="slate">{status}</Badge>;
  }
}

// ─── 2. ВКЛАДКА ТАБЕЛЬ ГОДИН ТА ІНТЕРВАЛИ ──────────────────────────────────

function TimesheetTab() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const months = useMemo(() => monthOptions("uk-UA", 18), []);
  const [month, setMonth] = useState(months[0]!.value);
  const [selectedWorkerId, setSelectedWorkerId] = useState<number | undefined>();
  const [editingInterval, setEditingInterval] = useState<Partial<SushiIntervalItem> | null>(null);

  // Отримуємо список працівників фабрики
  const { data: workerCodes = [] } = useQuery({
    queryKey: ["sushi-worker-codes"],
    queryFn: () => fetchSushiWorkerCodes(),
  });

  const { data: timesheetData, isLoading: loadingTree } = useQuery({
    queryKey: ["sushi-timesheet-tree", selectedWorkerId],
    queryFn: () => fetchSushiTimesheetTree(selectedWorkerId!),
    enabled: !!selectedWorkerId,
  });

  const { data: monthIntervals = [], isLoading: loadingMonth } = useQuery({
    queryKey: ["sushi-intervals", month],
    queryFn: () => fetchSushiIntervals({ month }),
    enabled: !selectedWorkerId,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteSushiInterval(id),
    onSuccess: () => {
      toast.success(t("Інтервал успішно видалено"));
      qc.invalidateQueries({ queryKey: ["sushi-intervals"] });
      qc.invalidateQueries({ queryKey: ["sushi-timesheet-tree"] });
    },
  });

  const handleDelete = async (id: number) => {
    const ok = await confirm({
      title: t("Видалити інтервал?"),
      message: t("Цю дію не можна скасувати. Години буде видалено з табеля та Załącznik."),
      confirmText: t("Видалити"),
      danger: true,
    });
    if (ok) deleteMutation.mutate(id);
  };

  return (
    <div className="space-y-6">
      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Label>{t("Місяць:")}</Label>
          <Select value={month} onChange={(e) => setMonth(e.target.value)} className="w-52">
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>

          <Label>{t("Картка працівника:")}</Label>
          <Select
            value={selectedWorkerId ?? ""}
            onChange={(e) => setSelectedWorkerId(e.target.value ? Number(e.target.value) : undefined)}
            className="w-72"
          >
            <option value="">{t("Всі працівники (Зведений табель)")}</option>
            {workerCodes.map((w) => (
              <option key={w.id} value={w.workerId}>
                {w.workerName || `Працівник #${w.workerId}`} (RCP: {w.rcpCode})
              </option>
            ))}
          </Select>
        </div>

        <Button onClick={() => setEditingInterval({ workDate: `${month}-01`, startTime: "06:00", stopTime: "14:00" })} className="gap-2">
          <Plus className="w-4 h-4" />
          {t("Додати зміну вручну")}
        </Button>
      </div>

      {/* View: Single Worker Hierarchical Tree or Flat Month List */}
      {selectedWorkerId ? (
        <Card className="p-6">
          {loadingTree ? (
            <Spinner />
          ) : !timesheetData?.tree.length ? (
            <Empty>{t("Немає збережених інтервалів для цього працівника")}</Empty>
          ) : (
            <div className="space-y-4">
              {timesheetData.tree.map((yearNode) => (
                <div key={yearNode.year} className="space-y-4">
                  <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-red-500" />
                    {yearNode.year} {t("рік")} — {yearNode.totalHours} {t("год")}
                  </h3>

                  {yearNode.months.map((monthNode) => (
                    <div key={monthNode.month} className="border border-slate-200 rounded-xl overflow-hidden">
                      <div className="bg-slate-50 px-4 py-3 flex items-center justify-between border-b border-slate-200">
                        <span className="font-semibold text-slate-800 text-sm">
                          {monthNode.month} ({monthNode.totalDays} {t("днів")})
                        </span>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-slate-500">
                            {t("Оплачувані:")} <strong className="text-slate-800">{monthNode.totalPayableHours} год</strong>
                          </span>
                          <span className="text-slate-500">
                            {t("Фактура:")} <strong className="text-slate-800">{monthNode.totalBillableHours} год</strong>
                          </span>
                        </div>
                      </div>

                      <div className="divide-y divide-slate-100">
                        {monthNode.days.map((dayNode) => (
                          <div key={dayNode.date} className="p-3 hover:bg-slate-50/50 transition flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
                            <div className="flex items-center gap-3">
                              <span className="font-mono font-bold text-slate-800 text-sm w-28">
                                {dayNode.date} ({dayNode.dayOfWeek})
                              </span>
                              {dayNode.odziezApplied && (
                                <Badge color="green">
                                  <Shirt className="w-3 h-3 mr-1" />
                                  {t("Одяг 6 zł")}
                                </Badge>
                              )}
                              <span className="font-semibold text-slate-700">
                                {dayNode.totalHours} {t("год")}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              {dayNode.intervals.map((interval) => (
                                <div
                                  key={interval.id}
                                  className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 shadow-2xs"
                                >
                                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                                  <span className="font-mono text-slate-700">
                                    {interval.roundedStartTime}–{interval.roundedStopTime} ({interval.hours}h)
                                  </span>
                                  {interval.lineName && (
                                    <span className="text-slate-500 text-[11px]">[{interval.lineName}]</span>
                                  )}
                                  {interval.supervisorName && (
                                    <span className="text-slate-400 text-[10px]">✍ {interval.supervisorName}</span>
                                  )}
                                  <button
                                    onClick={() => setEditingInterval(interval)}
                                    className="text-slate-400 hover:text-slate-600 p-0.5"
                                  >
                                    <Edit2 className="w-3 h-3" />
                                  </button>
                                  <button
                                    onClick={() => handleDelete(interval.id)}
                                    className="text-slate-400 hover:text-red-600 p-0.5"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        /* Flat Month View */
        <Card className="overflow-hidden">
          {loadingMonth ? (
            <Spinner />
          ) : monthIntervals.length === 0 ? (
            <Empty>{t("Немає записів за обраний місяць")}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-semibold uppercase">
                    <th className="py-3 px-4">{t("Дата")}</th>
                    <th className="py-3 px-4">{t("Працівник")}</th>
                    <th className="py-3 px-4">{t("Цех / Лінія")}</th>
                    <th className="py-3 px-4">{t("Початок")}</th>
                    <th className="py-3 px-4">{t("Кінець")}</th>
                    <th className="py-3 px-4">{t("Округлені години")}</th>
                    <th className="py-3 px-4">{t("Бригадир")}</th>
                    <th className="py-3 px-4">{t("Одяг")}</th>
                    <th className="py-3 px-4 text-right">{t("Дії")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                  {monthIntervals.map((i) => (
                    <tr key={i.id} className="hover:bg-slate-50/50">
                      <td className="py-3 px-4 font-mono font-semibold">{i.workDate}</td>
                      <td className="py-3 px-4 font-semibold text-slate-800">{i.workerName || `#${i.workerId}`}</td>
                      <td className="py-3 px-4 text-slate-600">{i.lineName || "—"}</td>
                      <td className="py-3 px-4 font-mono">
                        {i.startTime} <span className="text-slate-400">→ {i.roundedStartTime}</span>
                      </td>
                      <td className="py-3 px-4 font-mono">
                        {i.stopTime} <span className="text-slate-400">→ {i.roundedStopTime}</span>
                      </td>
                      <td className="py-3 px-4 font-bold text-slate-900">{i.hours} год</td>
                      <td className="py-3 px-4 text-slate-600">{i.supervisorName || "—"}</td>
                      <td className="py-3 px-4">
                        {i.odziezFeeApplicable ? <Badge color="green">{t("6 zł")}</Badge> : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="py-3 px-4 text-right space-x-1">
                        <Button variant="ghost" className="p-1 h-auto" onClick={() => setEditingInterval(i)}>
                          <Edit2 className="w-3.5 h-3.5 text-slate-500" />
                        </Button>
                        <Button variant="ghost" className="p-1 h-auto text-red-500" onClick={() => handleDelete(i.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Add / Edit Interval Modal */}
      {editingInterval && (
        <IntervalModal
          interval={editingInterval}
          onClose={() => setEditingInterval(null)}
          onSuccess={() => {
            setEditingInterval(null);
            qc.invalidateQueries({ queryKey: ["sushi-intervals"] });
            qc.invalidateQueries({ queryKey: ["sushi-timesheet-tree"] });
          }}
        />
      )}
    </div>
  );
}

// ─── 3. ВКЛАДКА ДИСПУТИ ТА СКАРГИ ──────────────────────────────────────────

function DisputesTab() {
  const t = useT();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>("OPEN");
  const [resolvingDispute, setResolvingDispute] = useState<SushiDispute | null>(null);

  const { data: disputes = [], isLoading } = useQuery({
    queryKey: ["sushi-disputes", status],
    queryFn: () => fetchSushiDisputes({ status: status === "ALL" ? undefined : status }),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) => rejectSushiDispute(id, note),
    onSuccess: () => {
      toast.success(t("Скаргу відхилено"));
      qc.invalidateQueries({ queryKey: ["sushi-disputes"] });
    },
  });

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <div className="flex items-center gap-2">
        {[
          ["OPEN", t("Відкриті")],
          ["RESOLVED", t("Вирішені")],
          ["REJECTED", t("Відхилені")],
          ["ALL", t("Усі")],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setStatus(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              status === k ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <Spinner />
        ) : disputes.length === 0 ? (
          <Empty>{t("Немає скарг за обраним фільтром")}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-semibold uppercase">
                  <th className="py-3 px-4">#</th>
                  <th className="py-3 px-4">{t("Працівник")}</th>
                  <th className="py-3 px-4">{t("Дата зміни")}</th>
                  <th className="py-3 px-4">{t("Тип скарги")}</th>
                  <th className="py-3 px-4">{t("Заявлений час")}</th>
                  <th className="py-3 px-4">{t("Коментар працівника")}</th>
                  <th className="py-3 px-4">{t("Статус")}</th>
                  <th className="py-3 px-4 text-right">{t("Дії")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {disputes.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/50">
                    <td className="py-3 px-4 text-slate-400">#{d.id}</td>
                    <td className="py-3 px-4 font-semibold text-slate-900">{d.workerName || `#${d.workerId}`}</td>
                    <td className="py-3 px-4 font-mono">{d.targetDate}</td>
                    <td className="py-3 px-4">
                      <Badge color="amber">{d.disputeType}</Badge>
                    </td>
                    <td className="py-3 px-4 font-mono">
                      {d.claimedStartTime} → {d.claimedStopTime} ({d.claimedHours ?? 8}h)
                    </td>
                    <td className="py-3 px-4 max-w-xs truncate text-slate-600" title={d.workerComment || ""}>
                      {d.workerComment || "—"}
                    </td>
                    <td className="py-3 px-4">
                      <Badge color={d.status === "OPEN" ? "amber" : d.status === "RESOLVED" ? "green" : "rose"}>
                        {d.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-right space-x-2">
                      {d.status === "OPEN" && (
                        <>
                          <Button
                            variant="success"
                            className="text-xs py-1 px-2.5 h-auto"
                            onClick={() => setResolvingDispute(d)}
                          >
                            {t("Розглянути")}
                          </Button>
                          <Button
                            variant="danger"
                            className="text-xs py-1 px-2.5 h-auto"
                            onClick={() => rejectMutation.mutate({ id: d.id, note: "Відхилено адміністратором" })}
                          >
                            {t("Відхилити")}
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Resolve Modal */}
      {resolvingDispute && (
        <ResolveDisputeModal
          dispute={resolvingDispute}
          onClose={() => setResolvingDispute(null)}
          onSuccess={() => {
            setResolvingDispute(null);
            qc.invalidateQueries({ queryKey: ["sushi-disputes"] });
            qc.invalidateQueries({ queryKey: ["sushi-intervals"] });
          }}
        />
      )}
    </div>
  );
}

// ─── 4. ВКЛАДКА ФІНАНСИ ТА ZAŁĄCZNIK ───────────────────────────────────────

function FinanceTab() {
  const t = useT();
  const qc = useQueryClient();
  const months = useMemo(() => monthOptions("uk-UA", 18), []);
  const [month, setMonth] = useState(months[0]!.value);
  const [viewMode, setViewMode] = useState<"consolidated" | "company">("consolidated");
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | undefined>();
  const [subTab, setSubTab] = useState<"zalacznik" | "reconciliation">("zalacznik");

  const { data: zalacznik, isLoading: loadingZalacznik } = useQuery({
    queryKey: ["sushi-zalacznik", month, viewMode === "company" ? selectedCompanyId : null],
    queryFn: () =>
      fetchSushiZalacznik({
        month,
        companyId: viewMode === "company" ? selectedCompanyId : null,
      }),
  });

  const { data: reconciliation, isLoading: loadingRecon } = useQuery({
    queryKey: ["sushi-reconciliation", month],
    queryFn: () => fetchSushiReconciliation({ month }),
    enabled: subTab === "reconciliation",
  });

  const lockMutation = useMutation({
    mutationFn: () => lockSushiZalacznik(zalacznik),
    onSuccess: () => {
      toast.success(t("Załącznik do faktury успішно зафіксовано!"));
      qc.invalidateQueries({ queryKey: ["sushi-zalacznik"] });
    },
  });

  return (
    <div className="space-y-6">
      {/* Sub tabs & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Label>{t("Місяць:")}</Label>
          <Select value={month} onChange={(e) => setMonth(e.target.value)} className="w-52">
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>

          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-xs font-medium">
            <button
              onClick={() => setSubTab("zalacznik")}
              className={`px-3 py-1.5 rounded-md transition ${
                subTab === "zalacznik" ? "bg-white shadow-xs font-semibold text-slate-800" : "text-slate-500"
              }`}
            >
              {t("Załącznik do faktury")}
            </button>
            <button
              onClick={() => setSubTab("reconciliation")}
              className={`px-3 py-1.5 rounded-md transition ${
                subTab === "reconciliation" ? "bg-white shadow-xs font-semibold text-slate-800" : "text-slate-500"
              }`}
            >
              {t("Двоконтурна звірка годин")}
            </button>
          </div>
        </div>

        {subTab === "zalacznik" && (
          <div className="flex items-center gap-2">
            <Select
              value={viewMode === "consolidated" ? "ALL" : String(selectedCompanyId ?? 1)}
              onChange={(e) => {
                if (e.target.value === "ALL") {
                  setViewMode("consolidated");
                  setSelectedCompanyId(undefined);
                } else {
                  setViewMode("company");
                  setSelectedCompanyId(Number(e.target.value));
                }
              }}
              className="w-64 text-xs font-medium"
            >
              <option value="ALL">{t("Вся фабрика (Консолідовано для клієнта)")}</option>
              <option value="1">{t("Тільки фірма ES (Внутрішній розподіл)")}</option>
              <option value="2">{t("Тільки фірма ESO (Внутрішній розподіл)")}</option>
            </Select>

            <Button
              variant="secondary"
              loading={lockMutation.isPending}
              onClick={() => lockMutation.mutate()}
              className="gap-1.5"
            >
              <Lock className="w-4 h-4" />
              {t("Зафіксувати")}
            </Button>
          </div>
        )}
      </div>

      {subTab === "zalacznik" ? (
        loadingZalacznik ? (
          <Spinner />
        ) : !zalacznik ? (
          <Empty>{t("Немає даних за цей місяць")}</Empty>
        ) : (
          <div className="space-y-6">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <Card className="p-4 bg-slate-50/50">
                <span className="text-xs text-slate-500 font-medium">{t("Фактуровані години")}</span>
                <div className="text-xl font-bold text-slate-900 mt-1">{zalacznik.totalBillableHours} год</div>
              </Card>
              <Card className="p-4 bg-slate-50/50">
                <span className="text-xs text-slate-500 font-medium">{t("Вартість робіт Netto")}</span>
                <div className="text-xl font-bold text-slate-900 mt-1">{fmt(zalacznik.totalLaborCostNet)} zł</div>
              </Card>
              <Card className="p-4 bg-slate-50/50">
                <span className="text-xs text-slate-500 font-medium">
                  {t("Спецодяг Netto ({count} дн)", { count: zalacznik.totalOdziezDaysCount })}
                </span>
                <div className="text-xl font-bold text-emerald-600 mt-1">-{fmt(zalacznik.totalOdziezDeductionNet)} zł</div>
              </Card>
              <Card className="p-4 bg-slate-50/50">
                <span className="text-xs text-slate-500 font-medium">{t("Штрафи клієнта (Kary)")}</span>
                <div className="text-xl font-bold text-rose-600 mt-1">-{fmt(zalacznik.totalContractualPenalties)} zł</div>
              </Card>
              <Card className="p-4 bg-red-50/40 border-red-200">
                <span className="text-xs text-red-600 font-semibold">{t("До фактури Netto")}</span>
                <div className="text-2xl font-black text-red-600 mt-1">{fmt(zalacznik.finalInvoiceNet)} zł</div>
              </Card>
            </div>

            {/* Roles Breakdown Table */}
            <Card className="overflow-hidden">
              <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <h4 className="font-semibold text-slate-800 text-sm">{t("Розбивка годин за тарифними ролями")}</h4>
              </div>
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/50 text-slate-500 font-semibold uppercase">
                    <th className="py-3 px-4">{t("Категорія / Роль")}</th>
                    <th className="py-3 px-4">{t("Ставка клієнту")}</th>
                    <th className="py-3 px-4">{t("Відпрацьовані години")}</th>
                    <th className="py-3 px-4 text-right">{t("Сума Netto")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                  {Object.values(zalacznik.breakdownByRole).map((b) => (
                    <tr key={b.roleCode} className="hover:bg-slate-50/50">
                      <td className="py-3 px-4 font-semibold text-slate-900">{b.roleName}</td>
                      <td className="py-3 px-4 font-mono">{fmt(b.clientRate)} zł/h</td>
                      <td className="py-3 px-4 font-bold">{b.hours} год</td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-slate-900">
                        {fmt(b.amountNet)} zł
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )
      ) : (
        /* Reconciliation Sub Tab */
        <Card className="overflow-hidden">
          {loadingRecon ? (
            <Spinner />
          ) : !reconciliation?.items.length ? (
            <Empty>{t("Немає даних для звірки за цей місяць")}</Empty>
          ) : (
            <div className="space-y-4 p-4">
              <div className="flex items-center justify-between text-xs text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-200">
                <span>
                  {t("Годин за даними фабрики:")} <strong>{reconciliation.totalFactoryHours} год</strong>
                </span>
                <span>
                  {t("Годин у табелі Grafik-bot:")} <strong>{reconciliation.totalInternalHours} год</strong>
                </span>
                <span>
                  {t("Незбігів:")}{" "}
                  <strong className={reconciliation.mismatchCount > 0 ? "text-red-600 font-bold" : "text-emerald-600 font-bold"}>
                    {reconciliation.mismatchCount}
                  </strong>
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-semibold uppercase">
                      <th className="py-2.5 px-3">{t("Працівник")}</th>
                      <th className="py-2.5 px-3">{t("Дата")}</th>
                      <th className="py-2.5 px-3">{t("Фабрика (Realne)")}</th>
                      <th className="py-2.5 px-3">{t("Табель Grafik-bot")}</th>
                      <th className="py-2.5 px-3">{t("Різниця")}</th>
                      <th className="py-2.5 px-3">{t("Статус звірки")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                    {reconciliation.items.map((item, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50">
                        <td className="py-2.5 px-3 font-semibold text-slate-800">#{item.workerId}</td>
                        <td className="py-2.5 px-3 font-mono">{item.workDate}</td>
                        <td className="py-2.5 px-3 font-mono">{item.factoryHours}h</td>
                        <td className="py-2.5 px-3 font-mono">{item.internalHours}h</td>
                        <td className="py-2.5 px-3 font-mono font-bold">
                          {item.deltaHours > 0 ? `+${item.deltaHours}` : item.deltaHours}h
                        </td>
                        <td className="py-2.5 px-3">
                          {item.status === "MATCH" && <Badge color="green">{t("Збігається")}</Badge>}
                          {item.status === "COMPENSATED_OFFSET" && (
                            <Badge color="blue">{t("Нічний зсув (Самокомпенсовано)")}</Badge>
                          )}
                          {item.status === "MISMATCH" && <Badge color="rose">{t("Розбіжність")}</Badge>}
                          {item.status === "EXCEPTION_APPROVED" && (
                            <Badge color="amber">{t("Узгоджене виключення")}</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ─── 5. ВКЛАДКА НАЛАШТУВАННЯ ПРОЄКТУ ───────────────────────────────────────

function SettingsTab() {
  const t = useT();
  const qc = useQueryClient();
  const [subTab, setSubTab] = useState<"lines" | "supervisors" | "rcp" | "roles">("lines");

  const { data: lines = [] } = useQuery({ queryKey: ["sushi-lines"], queryFn: () => fetchSushiLines() });
  const { data: supervisors = [] } = useQuery({ queryKey: ["sushi-supervisors"], queryFn: () => fetchSushiSupervisors() });
  const { data: workerCodes = [] } = useQuery({ queryKey: ["sushi-worker-codes"], queryFn: () => fetchSushiWorkerCodes() });
  const { data: roles = [] } = useQuery({ queryKey: ["sushi-roles"], queryFn: () => fetchSushiRoles() });

  const [addingLine, setAddingLine] = useState(false);
  const [newLineName, setNewLineName] = useState("");
  const [newLineCode, setNewLineCode] = useState("");

  const [addingAliasLineId, setAddingAliasLineId] = useState<number | null>(null);
  const [newAliasText, setNewAliasText] = useState("");

  const lineMutation = useMutation({
    mutationFn: () => createSushiLine({ name: newLineName, code: newLineCode }),
    onSuccess: () => {
      toast.success(t("Лінію успішно створено"));
      setAddingLine(false);
      setNewLineName("");
      setNewLineCode("");
      qc.invalidateQueries({ queryKey: ["sushi-lines"] });
    },
  });

  const aliasMutation = useMutation({
    mutationFn: () => addSushiLineAlias(addingAliasLineId!, newAliasText),
    onSuccess: () => {
      toast.success(t("Аліас додано"));
      setAddingAliasLineId(null);
      setNewAliasText("");
      qc.invalidateQueries({ queryKey: ["sushi-lines"] });
    },
  });

  return (
    <div className="space-y-6">
      {/* Sub tabs */}
      <div className="flex items-center gap-2">
        {[
          ["lines", t("Виробничі лінії та аліаси")],
          ["supervisors", t("Підписи бригадирів")],
          ["rcp", t("Табельні коди RCP")],
          ["roles", t("Тарифні ролі")],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSubTab(k as any)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
              subTab === k ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {subTab === "lines" && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-slate-800 text-sm">{t("Виробничі лінії фабрики Суші")}</h4>
            <Button onClick={() => setAddingLine(true)} className="text-xs gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              {t("Додати лінію")}
            </Button>
          </div>

          <div className="divide-y divide-slate-100">
            {lines.map((l) => (
              <div key={l.id} className="py-3 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
                <div>
                  <div className="font-semibold text-slate-800 text-sm">
                    {l.name} <span className="font-mono text-slate-400 font-normal">({l.code})</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <span className="text-slate-400 text-[11px]">{t("Аліаси з Excel:")}</span>
                    {l.aliases.map((a, i) => (
                      <Badge key={i} color="slate">{a}</Badge>
                    ))}
                    <button
                      onClick={() => setAddingAliasLineId(l.id)}
                      className="text-red-600 hover:text-red-700 font-medium text-[11px] ml-1"
                    >
                      + {t("додати аліас")}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {addingLine && (
            <Modal open={addingLine} onClose={() => setAddingLine(false)} title={t("Створити нову лінію")}>
              <div className="space-y-4">
                <div>
                  <Label>{t("Назва лінії (наприклад, Pakowanie 4)")}</Label>
                  <Input value={newLineName} onChange={(e) => setNewLineName(e.target.value)} />
                </div>
                <div>
                  <Label>{t("Код лінії (наприклад, PAK_4)")}</Label>
                  <Input value={newLineCode} onChange={(e) => setNewLineCode(e.target.value)} />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="secondary" onClick={() => setAddingLine(false)}>{t("Скасувати")}</Button>
                  <Button onClick={() => lineMutation.mutate()} loading={lineMutation.isPending}>{t("Створити")}</Button>
                </div>
              </div>
            </Modal>
          )}

          {addingAliasLineId && (
            <Modal open={!!addingAliasLineId} onClose={() => setAddingAliasLineId(null)} title={t("Додати аліас з Excel")}>
              <div className="space-y-4">
                <div>
                  <Label>{t("Точний текст із файлу бригадира (наприклад, 'PAKOWANIE 4 (2 zm)')")}</Label>
                  <Input value={newAliasText} onChange={(e) => setNewAliasText(e.target.value)} />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="secondary" onClick={() => setAddingAliasLineId(null)}>{t("Скасувати")}</Button>
                  <Button onClick={() => aliasMutation.mutate()} loading={aliasMutation.isPending}>{t("Додати")}</Button>
                </div>
              </div>
            </Modal>
          )}
        </Card>
      )}

      {subTab === "supervisors" && (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-semibold uppercase">
                <th className="py-3 px-4">{t("Підпис у звіті")}</th>
                <th className="py-3 px-4">{t("Працівник агентства (для штрафів)")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
              {supervisors.map((s) => (
                <tr key={s.id}>
                  <td className="py-3 px-4 font-bold text-slate-900 font-mono">{s.signatureName}</td>
                  <td className="py-3 px-4">{s.workerName || <span className="text-slate-400 italic">{t("Не прив'язано")}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {subTab === "rcp" && (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-semibold uppercase">
                <th className="py-3 px-4">{t("Табельний Nr RCP")}</th>
                <th className="py-3 px-4">{t("Працівник")}</th>
                <th className="py-3 px-4">{t("Фірма")}</th>
                <th className="py-3 px-4">{t("Діє з")}</th>
                <th className="py-3 px-4">{t("Діє до")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
              {workerCodes.map((w) => (
                <tr key={w.id}>
                  <td className="py-3 px-4 font-mono font-bold text-slate-900">{w.rcpCode}</td>
                  <td className="py-3 px-4 font-semibold text-slate-800">{w.workerName || `#${w.workerId}`}</td>
                  <td className="py-3 px-4"><Badge color={w.companyId === 1 ? "blue" : "amber"}>{w.companyName || "ES"}</Badge></td>
                  <td className="py-3 px-4 font-mono text-slate-500">{w.validFrom}</td>
                  <td className="py-3 px-4 font-mono text-slate-500">{w.validTo || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {subTab === "roles" && (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-semibold uppercase">
                <th className="py-3 px-4">{t("Код")}</th>
                <th className="py-3 px-4">{t("Назва ролі")}</th>
                <th className="py-3 px-4">{t("Ставка клієнту")}</th>
                <th className="py-3 px-4">{t("Базова ставка працівнику")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
              {roles.map((r) => (
                <tr key={r.id}>
                  <td className="py-3 px-4 font-mono font-semibold">{r.code}</td>
                  <td className="py-3 px-4 font-bold text-slate-900">{r.name}</td>
                  <td className="py-3 px-4 font-mono font-bold text-slate-800">{fmt(r.defaultClientRate)} zł/h</td>
                  <td className="py-3 px-4 font-mono">{fmt(r.defaultWorkerRate)} zł/h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ─── 6. МОДАЛКА ПРИВ'ЯЗКИ АЛІАСУ RCP ───────────────────────────────────────

function LinkAliasModal({
  entry,
  onClose,
  onSuccess,
}: {
  entry: SushiStagingEntry;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useT();
  const [selectedWorkerId, setSelectedWorkerId] = useState<number | undefined>();
  const [notes, setNotes] = useState("");

  const { data: workers = [] } = useQuery({
    queryKey: ["active-workers"],
    queryFn: () => get<any[]>("/workers?active=true"),
  });

  const linkMutation = useMutation({
    mutationFn: () =>
      linkSushiRcpAlias({
        workerId: selectedWorkerId!,
        rcpCode: entry.rawRcp || "",
        notes,
      }),
    onSuccess: (res) => {
      toast.success(
        t("Успішно прив'язано RCP #{rcp} до працівника! Оновлено {count} рядків.", {
          rcp: res.linkedRcp,
          count: res.updatedStagingRows,
        }),
      );
      onSuccess();
    },
    onError: (err: any) => {
      toast.error(err.message || t("Помилка прив'язки аліасу"));
    },
  });

  return (
    <Modal open={true} onClose={onClose} title={t("Прив'язати фабричний номер RCP")}>
      <div className="space-y-4 text-xs">
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800">
          {t("Табельний номер")} <strong className="font-mono font-bold">{entry.rawRcp}</strong>{" "}
          {t("знайдено у файлі зміни, але він ще не зареєстрований за працівником агентства.")}
        </div>

        <div>
          <Label>{t("Оберіть працівника агентства:")}</Label>
          <Select
            value={selectedWorkerId ?? ""}
            onChange={(e) => setSelectedWorkerId(Number(e.target.value))}
            className="w-full"
          >
            <option value="">{t("— Оберіть працівника —")}</option>
            {workers.map((w: any) => (
              <option key={w.id} value={w.id}>
                {w.fullName} (Код #{w.workerCode})
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label>{t("Примітка:")}</Label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("Наприклад: Видано новий RCP після повторного працевлаштування")}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t("Скасувати")}
          </Button>
          <Button
            onClick={() => linkMutation.mutate()}
            disabled={!selectedWorkerId || linkMutation.isPending}
            loading={linkMutation.isPending}
          >
            {t("Зберегти та перевалідувати")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── 7. МОДАЛКА ДОДАВАННЯ / РЕДАГУВАННЯ ІНТЕРВАЛУ ─────────────────────────

function IntervalModal({
  interval,
  onClose,
  onSuccess,
}: {
  interval: Partial<SushiIntervalItem>;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useT();
  const isNew = !interval.id;

  const [workerId, setWorkerId] = useState(interval.workerId ? String(interval.workerId) : "");
  const [workDate, setWorkDate] = useState(interval.workDate || new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState(interval.startTime || "06:00");
  const [stopTime, setStopTime] = useState(interval.stopTime || "14:00");
  const [lineId, setLineId] = useState(interval.lineId ? String(interval.lineId) : "1");
  const [roleId, setRoleId] = useState(interval.roleId ? String(interval.roleId) : "1");
  const [notes, setNotes] = useState(interval.notes || "");

  const { data: workers = [] } = useQuery({ queryKey: ["active-workers"], queryFn: () => get<any[]>("/workers?active=true") });
  const { data: lines = [] } = useQuery({ queryKey: ["sushi-lines"], queryFn: () => fetchSushiLines() });
  const { data: roles = [] } = useQuery({ queryKey: ["sushi-roles"], queryFn: () => fetchSushiRoles() });

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        workerId: Number(workerId),
        workDate,
        startTime,
        stopTime,
        lineId: Number(lineId),
        roleId: Number(roleId),
        notes,
      };
      if (isNew) return createSushiInterval(payload);
      return patchSushiInterval(interval.id!, payload);
    },
    onSuccess: () => {
      toast.success(isNew ? t("Інтервал створено") : t("Інтервал оновлено"));
      onSuccess();
    },
    onError: (err: any) => {
      toast.error(err.message || t("Помилка збереження інтервалу"));
    },
  });

  return (
    <Modal open={true} onClose={onClose} title={isNew ? t("Додати інтервал зміни") : t("Редагувати інтервал")}>
      <div className="space-y-4 text-xs">
        {isNew && (
          <div>
            <Label>{t("Працівник:")}</Label>
            <Select value={workerId} onChange={(e) => setWorkerId(e.target.value)} className="w-full">
              <option value="">{t("— Оберіть працівника —")}</option>
              {workers.map((w: any) => (
                <option key={w.id} value={w.id}>
                  {w.fullName} (Код #{w.workerCode})
                </option>
              ))}
            </Select>
          </div>
        )}

        <div>
          <Label>{t("Дата зміни:")}</Label>
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t("Час початку:")}</Label>
            <Input value={startTime} onChange={(e) => setStartTime(e.target.value)} placeholder="06:00" />
          </div>
          <div>
            <Label>{t("Час завершення:")}</Label>
            <Input value={stopTime} onChange={(e) => setStopTime(e.target.value)} placeholder="14:00" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t("Виробнича лінія:")}</Label>
            <Select value={lineId} onChange={(e) => setLineId(e.target.value)}>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t("Роль:")}</Label>
            <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({r.defaultClientRate} zł)</option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <Label>{t("Примітка / Причина зміни:")}</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("Коригування за табелем")} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button onClick={() => saveMutation.mutate()} loading={saveMutation.isPending}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── 8. МОДАЛКА РОЗГЛЯДУ ДИСПУТУ ──────────────────────────────────────────

function ResolveDisputeModal({
  dispute,
  onClose,
  onSuccess,
}: {
  dispute: SushiDispute;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useT();
  const [action, setAction] = useState<string>("CREATED_NEW_INTERVAL");
  const [startTime, setStartTime] = useState(dispute.claimedStartTime || "06:00");
  const [stopTime, setStopTime] = useState(dispute.claimedStopTime || "14:00");
  const [applyPenalty, setApplyPenalty] = useState(false);
  const [supervisorId, setSupervisorId] = useState<string>("");
  const [penaltyAmount, setPenaltyAmount] = useState("50");
  const [note, setNote] = useState("");

  const { data: supervisors = [] } = useQuery({ queryKey: ["sushi-supervisors"], queryFn: () => fetchSushiSupervisors() });

  const resolveMutation = useMutation({
    mutationFn: () =>
      resolveSushiDispute(dispute.id, {
        action,
        startTime,
        stopTime,
        note,
        applyPenaltyToSupervisor: applyPenalty,
        supervisorId: supervisorId ? Number(supervisorId) : undefined,
        penaltyAmount: Number(penaltyAmount),
      }),
    onSuccess: () => {
      toast.success(t("Скаргу успішно розглянуто та узгоджено!"));
      onSuccess();
    },
  });

  return (
    <Modal open={true} onClose={onClose} title={`${t("Розгляд скарги")} #${dispute.id}`}>
      <div className="space-y-4 text-xs">
        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
          <div>{t("Працівник:")} <strong>{dispute.workerName}</strong></div>
          <div>{t("Дата:")} <strong>{dispute.targetDate}</strong></div>
          <div>{t("Коментар:")} <em>{dispute.workerComment}</em></div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t("Час початку:")}</Label>
            <Input value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div>
            <Label>{t("Час завершення:")}</Label>
            <Input value={stopTime} onChange={(e) => setStopTime(e.target.value)} />
          </div>
        </div>

        <div className="border border-slate-200 rounded-lg p-3 space-y-3 bg-slate-50/50">
          <label className="flex items-center gap-2 font-medium text-slate-800">
            <input
              type="checkbox"
              checked={applyPenalty}
              onChange={(e) => setApplyPenalty(e.target.checked)}
              className="rounded"
            />
            {t("Списати штраф з бригадира за помилку в табелі")}
          </label>

          {applyPenalty && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <Label>{t("Бригадир:")}</Label>
                <Select value={supervisorId} onChange={(e) => setSupervisorId(e.target.value)}>
                  <option value="">{t("— Оберіть бригадира —")}</option>
                  {supervisors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.signatureName} ({s.workerName || "Без прив'язки"})
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{t("Сума штрафу (PLN):")}</Label>
                <Input value={penaltyAmount} onChange={(e) => setPenaltyAmount(e.target.value)} />
              </div>
            </div>
          )}
        </div>

        <div>
          <Label>{t("Резолюція / Коментар:")}</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("Години підтверджено за погодженням з клієнтом")} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button onClick={() => resolveMutation.mutate()} loading={resolveMutation.isPending}>{t("Узгодити та зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── 9. МОДАЛКА ВІЗУАЛЬНОГО НАЛАШТУВАННЯ КОЛОНОК EXCEL ──────────────────────

function colToLetter(c: number): string {
  let letter = "";
  let temp = c;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

function ExcelMappingModal({
  file,
  onClose,
  onUpload,
}: {
  file: File;
  onClose: () => void;
  onUpload: (file: File, mapping: SushiColumnMapping) => void;
}) {
  const t = useT();
  const [selectedSheet, setSelectedSheet] = useState<string>("");
  const [activeField, setActiveField] = useState<
    "rcp" | "od" | "do" | "dzial" | "firma" | "podpis" | "realne" | "uwagi"
  >("rcp");

  const { data: preview, isLoading, error } = useQuery({
    queryKey: ["sushi-preview", file.name, selectedSheet],
    queryFn: () => previewSushiExcel(file, selectedSheet || undefined),
  });

  const [headerRow, setHeaderRow] = useState<number>(1);
  const [reportDate, setReportDate] = useState<string>("");
  const [mapping, setMapping] = useState<{
    colRcp: number;
    colOd: number;
    colDo: number;
    colDzial: number;
    colFirma: number;
    colPodpis: number;
    colRealne: number;
    colUwagi: number;
  }>({
    colRcp: 1,
    colOd: 6,
    colDo: 7,
    colDzial: 2,
    colFirma: 0,
    colPodpis: 9,
    colRealne: 8,
    colUwagi: 11,
  });

  // Sync detected mapping when preview loads
  useEffect(() => {
    if (preview) {
      if (!selectedSheet && preview.selectedSheet) {
        setSelectedSheet(preview.selectedSheet);
      }
      setHeaderRow(preview.detectedHeaderRow);
      setMapping(preview.detectedMapping);
      if (preview.detectedDate) {
        setReportDate(preview.detectedDate);
      }
    }
  }, [preview]);

  const FIELDS: {
    key: typeof activeField;
    label: string;
    colKey: keyof typeof mapping;
    badgeColor: string;
    required: boolean;
  }[] = [
    { key: "rcp", label: t("Табельний номер (RCP)"), colKey: "colRcp", badgeColor: "bg-emerald-500 text-white", required: true },
    { key: "od", label: t("Час початку (OD)"), colKey: "colOd", badgeColor: "bg-blue-500 text-white", required: true },
    { key: "do", label: t("Час завершення (DO)"), colKey: "colDo", badgeColor: "bg-indigo-500 text-white", required: true },
    { key: "dzial", label: t("Цех / Лінія (Dział)"), colKey: "colDzial", badgeColor: "bg-amber-500 text-white", required: false },
    { key: "firma", label: t("Агентство (Firma)"), colKey: "colFirma", badgeColor: "bg-purple-500 text-white", required: false },
    { key: "podpis", label: t("Підпис бригадира"), colKey: "colPodpis", badgeColor: "bg-rose-500 text-white", required: false },
    { key: "realne", label: t("Реальні години"), colKey: "colRealne", badgeColor: "bg-teal-500 text-white", required: false },
    { key: "uwagi", label: t("Примітки (Uwagi)"), colKey: "colUwagi", badgeColor: "bg-slate-500 text-white", required: false },
  ];

  const handleColumnClick = (colIdx: number) => {
    const activeObj = FIELDS.find((f) => f.key === activeField);
    if (!activeObj) return;
    setMapping((prev) => ({
      ...prev,
      [activeObj.colKey]: colIdx,
    }));
    toast.success(
      t("Прив'язано: {field} → Колонка {col}", {
        field: activeObj.label,
        col: colToLetter(colIdx),
      })
    );
  };

  const getColBadges = (colIdx: number) => {
    return FIELDS.filter((f) => mapping[f.colKey] === colIdx);
  };

  const renderCellPreview = (cellVal: any, cIdx: number) => {
    if (cellVal === undefined || cellVal === null || String(cellVal).trim() === "") {
      return <span className="text-slate-300 italic">—</span>;
    }

    const isNum = typeof cellVal === "number";
    const strVal = String(cellVal).trim().replace(",", ".");
    const num = isNum ? cellVal : parseFloat(strVal);
    const isFraction = !isNaN(num) && num > 0 && num < 1;

    // 1. Колонки часу (OD або DO)
    if (cIdx === mapping.colOd || cIdx === mapping.colDo) {
      if (!isNaN(num)) {
        let totalM = 0;
        if (num < 1) totalM = Math.round(num * 24 * 60);
        else if (num <= 24) totalM = Math.round(num * 60);
        else totalM = Math.round((num % 1) * 24 * 60);
        const h = Math.floor(totalM / 60) % 24;
        const m = totalM % 60;
        const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        return (
          <span className="font-semibold text-blue-700">
            {timeStr}
            {isFraction && <span className="text-[9px] text-slate-400 font-normal ml-1">({num.toFixed(2)})</span>}
          </span>
        );
      }
    }

    // 2. Колонка реальних годин (Realne godziny)
    if (cIdx === mapping.colRealne) {
      if (!isNaN(num)) {
        const hours = num < 1 ? num * 24 : num;
        return (
          <span className="font-semibold text-emerald-700">
            {hours.toFixed(2)} год
            {isFraction && <span className="text-[9px] text-slate-400 font-normal ml-1">({num.toFixed(2)})</span>}
          </span>
        );
      }
    }

    // 3. Загальний числовий дріб доби (< 1)
    if (isFraction) {
      const totalM = Math.round(num * 24 * 60);
      const h = Math.floor(totalM / 60) % 24;
      const m = totalM % 60;
      const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      return (
        <span>
          <strong className="text-slate-800">{timeStr}</strong>
          <span className="text-[9px] text-slate-400 font-normal ml-1">({num.toFixed(2)})</span>
        </span>
      );
    }

    return String(cellVal);
  };

  return (
    <Modal open={true} onClose={onClose} title={t("Візуальне налаштування колонок Excel")} size="xl">
      <div className="space-y-4 text-xs">
        {/* Top Controls: Sheet selector & Header row */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
          <div className="flex items-center gap-4">
            <div>
              <span className="text-slate-500 font-medium mr-2">{t("Файл:")}</span>
              <strong className="text-slate-900 font-mono">{file.name}</strong>
            </div>

            {preview && preview.sheetNames.length > 1 && (
              <div className="flex items-center gap-2">
                <Label>{t("Аркуш:")}</Label>
                <Select
                  value={selectedSheet}
                  onChange={(e) => setSelectedSheet(e.target.value)}
                  className="py-1 px-2 text-xs"
                >
                  {preview.sheetNames.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Label>{t("Рядок заголовків:")}</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={headerRow + 1}
                onChange={(e) => setHeaderRow(Math.max(0, Number(e.target.value) - 1))}
                className="w-16 py-1 px-2 text-xs font-mono"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Label>{t("Дата звіту:")}</Label>
            <Input
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
              className={`w-36 py-1 px-2 text-xs font-mono ${
                !reportDate ? "border-red-500 ring-2 ring-red-200 bg-red-50/50" : ""
              }`}
            />
          </div>
        </div>

        {/* Missing Date Banner inside Modal */}
        {(!reportDate || preview?.isDateMissing) && (
          <div className="p-3 bg-red-50 border border-red-300 rounded-xl flex items-center gap-2.5 text-red-800 text-xs shadow-xs">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>
              <strong>{t("Увага: у файлі не вказано дату зміни!")}</strong>{" "}
              {t("Бригадир не заповнив клітинку дати в Excel. Будь ласка, оберіть точну дату звіту вище перед імпортом.")}
            </span>
          </div>
        )}

        {/* Fields Selector Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-700">
              {t("Оберіть поле для прив'язки, потім клікніть на відповідний стовпчик у таблиці нижче:")}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {FIELDS.map((f) => {
              const isSelected = activeField === f.key;
              const assignedCol = mapping[f.colKey];
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setActiveField(f.key)}
                  className={`p-2.5 rounded-xl border text-left transition flex items-center justify-between ${
                    isSelected
                      ? "border-blue-600 bg-blue-50/70 shadow-sm ring-2 ring-blue-500/20"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  <div className="truncate pr-2">
                    <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                      <span className={`w-2 h-2 rounded-full ${f.badgeColor.split(" ")[0]}`} />
                      <span className="truncate">{f.label}</span>
                    </div>
                    <span className="text-[10px] text-slate-500">
                      {f.required ? t("Обов'язкове") : t("Опціонально")}
                    </span>
                  </div>

                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono font-bold text-xs ${f.badgeColor}`}>
                    {assignedCol >= 0 ? colToLetter(assignedCol) : "—"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Interactive Excel Preview Table */}
        <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          {isLoading ? (
            <div className="p-12 flex justify-center">
              <Spinner />
            </div>
          ) : error ? (
            <div className="p-8 text-center text-red-600">
              {t("Не вдалося завантажити прев'ю файлу Excel.")}
            </div>
          ) : !preview || preview.rows.length === 0 ? (
            <div className="p-8 text-center text-slate-400">{t("Файл порожній")}</div>
          ) : (
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-left text-xs border-collapse font-sans">
                <thead>
                  {/* Column Letters & Active Field Badges */}
                  <tr className="bg-slate-100 border-b border-slate-300 select-none">
                    <th className="py-2 px-2.5 text-center text-slate-400 font-mono bg-slate-200 border-r border-slate-300 w-12 sticky left-0">
                      #
                    </th>
                    {Array.from({ length: preview.totalCols }).map((_, colIdx) => {
                      const badges = getColBadges(colIdx);
                      const isTargetOfActive = mapping[FIELDS.find((f) => f.key === activeField)?.colKey!] === colIdx;

                      return (
                        <th
                          key={colIdx}
                          onClick={() => handleColumnClick(colIdx)}
                          className={`py-2 px-3 text-center cursor-pointer transition border-r border-slate-200 min-w-[120px] ${
                            isTargetOfActive
                              ? "bg-blue-100 font-bold text-blue-900 ring-2 ring-blue-500 ring-inset"
                              : "hover:bg-slate-200 text-slate-700"
                          }`}
                        >
                          <div className="font-mono text-sm font-bold">{colToLetter(colIdx)}</div>
                          <div className="flex flex-wrap gap-1 justify-center mt-1">
                            {badges.map((b) => (
                              <span
                                key={b.key}
                                className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${b.badgeColor}`}
                              >
                                {b.key.toUpperCase()}
                              </span>
                            ))}
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                  {preview.rows.map((row, rIdx) => {
                    const isHeader = rIdx === headerRow;
                    return (
                      <tr
                        key={rIdx}
                        className={`hover:bg-blue-50/40 transition ${
                          isHeader ? "bg-amber-50 font-bold text-amber-900" : ""
                        }`}
                      >
                        <td
                          className={`py-1.5 px-2 text-center text-slate-400 bg-slate-50 border-r border-slate-200 sticky left-0 font-sans text-xs ${
                            isHeader ? "bg-amber-100 font-bold text-amber-800" : ""
                          }`}
                        >
                          {rIdx + 1}
                          {isHeader && <span className="block text-[9px] text-amber-600">HEADER</span>}
                        </td>
                        {Array.from({ length: preview.totalCols }).map((_, cIdx) => {
                          const cellVal = row[cIdx];
                          const isColActive = mapping[FIELDS.find((f) => f.key === activeField)?.colKey!] === cIdx;

                          return (
                            <td
                              key={cIdx}
                              onClick={() => handleColumnClick(cIdx)}
                              className={`py-1.5 px-3 border-r border-slate-100 cursor-pointer truncate max-w-[180px] ${
                                isColActive ? "bg-blue-50/70 font-semibold" : ""
                              }`}
                              title={String(cellVal || "")}
                            >
                              {renderCellPreview(cellVal, cIdx)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Modal Actions */}
        <div className="flex justify-between items-center pt-2">
          <Button
            variant="secondary"
            onClick={() => {
              if (preview) {
                setMapping(preview.detectedMapping);
                setHeaderRow(preview.detectedHeaderRow);
                toast.info(t("Скинуто до авто-визначення"));
              }
            }}
          >
            {t("Скинути до авто-детекції")}
          </Button>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("Скасувати")}
            </Button>
            <Button
              onClick={() => {
                if (!reportDate) {
                  toast.error(t("Будь ласка, вкажіть дату звіту перед імпортом!"));
                  return;
                }
                onUpload(file, {
                  sheetName: selectedSheet || undefined,
                  headerRowIndex: headerRow,
                  customReportDate: reportDate,
                  colFirma: mapping.colFirma,
                  colRcp: mapping.colRcp,
                  colDzial: mapping.colDzial,
                  colOd: mapping.colOd,
                  colDo: mapping.colDo,
                  colRealne: mapping.colRealne,
                  colPodpis: mapping.colPodpis,
                  colUwagi: mapping.colUwagi,
                });
              }}
              disabled={!reportDate}
              className="gap-2"
            >
              <Check className="w-4 h-4" />
              {t("Імпортувати файл із цим маппінгом")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

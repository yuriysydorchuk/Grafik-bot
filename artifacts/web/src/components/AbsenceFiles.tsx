// Довідки/скріншоти до пропуску, прикріплені працівником у боті. Чип відкриває
// перегляд у модалці (з хрестиком/Esc) — нова вкладка з голим файлом у мобільному
// браузері/Mini App не має як закритись. Лінк «у новій вкладці» лишаємо запасним.
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Modal } from "./ui";
import { useT } from "../lib/i18n";

export type AbsenceFile = { id: number; fileName: string | null; fileMime: string | null };

const fileUrl = (id: number) => `/api/absence-attachments/${id}/file`;

export function AbsenceFiles({ files, compact }: { files?: AbsenceFile[]; compact?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState<AbsenceFile | null>(null);
  if (!files?.length) return null;
  const isPdf = open?.fileMime === "application/pdf";
  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-1">
        {files.map((f, i) => (
          <button key={f.id} type="button" onClick={() => setOpen(f)} title={f.fileName ?? undefined}
            className={compact ? "text-xs text-sky-700 hover:underline" : "inline-flex items-center gap-0.5 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-700 hover:underline"}>
            📎{compact ? "" : ` ${f.fileMime === "application/pdf" ? "PDF" : t("фото")}${files.length > 1 ? ` ${i + 1}` : ""}`}
          </button>
        ))}
      </span>
      <Modal open={!!open} onClose={() => setOpen(null)} title={t("Підтвердження пропуску")} size="lg">
        {open && (
          <div className="space-y-3">
            <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-slate-50">
              {isPdf
                ? <iframe src={fileUrl(open.id)} title={open.fileName ?? "PDF"} className="h-[70vh] w-full" />
                : <img src={fileUrl(open.id)} alt={open.fileName ?? ""} className="mx-auto max-h-[70vh] w-auto max-w-full object-contain" />}
            </div>
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span className="truncate">{open.fileName}</span>
              <a href={fileUrl(open.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline">
                {t("Відкрити в новій вкладці")} <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

// Фото рапорту з панелі (зголошення #37, 13.11.2026): офіс сам завантажує фото/PDF рапорту працівника
// (POST /hours/report-photo, multipart) — на Drive тим самим шляхом, що й бот; повторне фото дописується
// сторінкою в той самий PDF. Потрібні вже вписані години рапорту (сервер відповість, якщо їх немає).
import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { toast } from "sonner";
import { upload } from "../lib/api";
import { useT } from "../lib/i18n";

export function ReportPhotoUpload({ workerId, factoryId, month, weekStart, onDone }: {
  workerId: number; factoryId: number; month?: string; weekStart?: string; onDone: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const send = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("workerId", String(workerId)); fd.append("factoryId", String(factoryId));
      if (weekStart) fd.append("weekStart", weekStart); else if (month) fd.append("month", month);
      await upload("/hours/report-photo", fd);
      toast.success(t("Фото рапорту збережено на Drive")); onDone();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); if (ref.current) ref.current.value = ""; }
  };
  return (
    <>
      <input ref={ref} type="file" accept="image/*,application/pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void send(f); }} />
      <button type="button" disabled={busy} onClick={e => { e.stopPropagation(); ref.current?.click(); }}
        title={t("Завантажити фото рапорту (фото або PDF; додається до наявного файла)")}
        className="rounded-md p-0.5 text-slate-300 hover:text-sky-600 disabled:opacity-50">
        <ImagePlus className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

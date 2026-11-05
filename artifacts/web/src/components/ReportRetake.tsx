// «Попросити перезняти рапорт» (зголошення #32, 05.11.2026): офіс бачить, що на фото шматок аркуша,
// і повертає рапорт на перезйомку — людині в бот іде прохання з причиною й кнопкою, що відкриває
// рапорт за цей місяць×фабрику або тиждень (POST /hours/report-retake). Наявний рапорт лишається,
// доки людина не здасть новий. Причина пишеться мовою офісу — бот додає її до свого тексту як є.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { post } from "../lib/api";
import { useT } from "../lib/i18n";
import { Button, Modal } from "./ui";

const QUICK = ["Видно не весь аркуш", "Немає підсумку годин", "Немає підпису", "Фото нечітке"];

export function ReportRetakeButton({ workerId, factoryId, month, weekStart, title }: {
  workerId: number; factoryId: number; month?: string; weekStart?: string;
  title: string; // «Імʼя · період» — заголовок модалки
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const send = useMutation({
    mutationFn: () => post("/hours/report-retake", { workerId, factoryId, ...(weekStart ? { weekStart } : { month }), reason: reason.trim() }),
    onSuccess: () => { setOpen(false); toast.success(t("Прохання перезняти рапорт надіслано в бот")); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <>
      <button type="button" onClick={e => { e.stopPropagation(); setReason(""); setOpen(true); }}
        title={t("Попросити перезняти рапорт (фото неповне або нечітке)")}
        className="rounded-md p-0.5 text-slate-300 hover:text-amber-600">
        <RefreshCcw className="h-3.5 w-3.5" />
      </button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`${t("Попросити перезняти рапорт")} — ${title}`} size="md">
          <div className="space-y-3 text-left">
            <p className="text-sm text-slate-500">{t("Працівник отримає в бот прохання надіслати рапорт ще раз — з кнопкою, яка відкриває саме цей рапорт. Поточний рапорт лишається, доки він не здасть новий.")}</p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK.map(q => (
                <button key={q} type="button" onClick={() => setReason(r => r.trim() ? `${r.trim()}; ${t(q).toLowerCase()}` : t(q))}
                  className="rounded-full bg-slate-50 px-2.5 py-1 text-xs text-slate-600 ring-1 ring-slate-200 hover:bg-amber-50 hover:text-amber-700 hover:ring-amber-200">{t(q)}</button>
              ))}
            </div>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={500}
              placeholder={t("Що не так з фото (необовʼязково) — працівник побачить цей текст")}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-red-300" />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>{t("Скасувати")}</Button>
              <Button onClick={() => send.mutate()} loading={send.isPending}>{t("Надіслати в бот")}</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

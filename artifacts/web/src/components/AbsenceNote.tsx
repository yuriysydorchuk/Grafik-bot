// Внутрішня нотатка офісу до дня пропуску (зголошення #29, 05.11.2026): графікова лишає собі
// примітку на конкретний пропуск («не приймати запізніле виправдання за цей день»). Працівник її
// не бачить. Кнопка-значок стоїть у графіку (рядок «не вийшов») і на /absences; текст зберігає
// PATCH /absences/:entryId {officeNote}. Перед «Виправдати» сторінка пропусків показує нотатку.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { StickyNote } from "lucide-react";
import { toast } from "sonner";
import { patch } from "../lib/api";
import { useT } from "../lib/i18n";
import { Button, Modal } from "./ui";

export function AbsenceNoteButton({ entryId, note, canEdit, title, onSaved }: {
  entryId: number; note: string | null | undefined; canEdit: boolean;
  title: string;            // «Імʼя · дата · зміна» — заголовок модалки
  onSaved: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const save = useMutation({
    mutationFn: (officeNote: string | null) => patch(`/absences/${entryId}`, { officeNote }),
    onSuccess: () => { setOpen(false); onSaved(); toast.success(t("Збережено")); },
    onError: (e: any) => toast.error(e.message),
  });
  if (!note && !canEdit) return null;
  return (
    <>
      <button type="button" disabled={!canEdit} onClick={() => { setVal(note ?? ""); setOpen(true); }}
        title={note ? `${t("Нотатка офісу")}: ${note}` : t("Нотатка офісу до цього пропуску (працівник її не бачить)")}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition disabled:cursor-default ${note
          ? "bg-amber-100 text-amber-700 hover:bg-amber-200" : "text-slate-300 hover:bg-slate-100 hover:text-slate-600"}`}>
        <StickyNote className="h-3.5 w-3.5" />
      </button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`${t("Нотатка офісу")} — ${title}`} size="md">
          <div className="space-y-3">
            <p className="text-sm text-slate-500">{t("Внутрішня примітка до цього дня пропуску. Працівник її не бачить; її покаже панель, коли хтось захоче виправдати цей пропуск.")}</p>
            <textarea autoFocus value={val} onChange={e => setVal(e.target.value)} rows={4} maxLength={1000}
              placeholder={t("Напр.: не приймати виправдання заднім числом — не попередив, на звʼязок не вийшов")}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-red-300" />
            <div className="flex justify-end gap-2">
              {note && <Button variant="secondary" onClick={() => save.mutate(null)} disabled={save.isPending}>{t("Прибрати нотатку")}</Button>}
              <Button variant="secondary" onClick={() => setOpen(false)}>{t("Скасувати")}</Button>
              <Button onClick={() => save.mutate(val.trim() || null)} loading={save.isPending}>{t("Зберегти")}</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// Фіксація розбіжності звірки каси: модалка з поясненням «чому так» замість
// window.prompt (той у частині браузерів/вебвʼю заблокований і виглядає чужорідно).
// Використовується на /cash і в блоці «Каса: розбіжності» на /cashflow.
import { useState } from "react";
import { post } from "../lib/api";
import { Button, Modal } from "./ui";
import { useT } from "../lib/i18n";

export interface AckTarget { side: string; ref: string }

export function AckNoteModal({ target, onClose, onDone }: { target: AckTarget | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (!target) return null;
  const save = async () => {
    setBusy(true);
    try {
      await post("/cash/recon-ack", { side: target.side, ref: target.ref, note });
      setNote("");
      onDone();
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={t("Зафіксувати розбіжність")} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <div className="mb-1 text-xs font-medium text-slate-500">{t("Чому так? Пояснення збережеться в рапорті")}</div>
          <textarea
            value={note} onChange={e => setNote(e.target.value)} rows={3} autoFocus
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition-colors hover:border-slate-400 focus:border-red-500 focus:ring-2 focus:ring-red-100"
            placeholder={t("напр.: частина зарплати видана авансом, решта піде наступного тижня")}
          />
        </label>
        <div className="text-xs text-slate-400">{t("Зафіксована розбіжність зникає з жовтих алертів і лишається в журналі — фіксацію можна скасувати.")}</div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={busy} onClick={save}>{t("Зафіксувати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Після підтвердження нового паспорта (профіль або задача «Перевірити завантажений документ»):
// дані документа ≠ анкета → питаємо, чи оновити анкету (22.10.2026). Нічого не змінюється без
// «Оновити анкету»; зміна потрапляє в «Історію змін» профілю (Анкета · …). Бекенд — services/passportSync.ts.
import { Modal, Button } from "./ui";
import { useT } from "../lib/i18n";

export type PassportDiff = { workerId: number; documentId: number; rows: { field: "passportNumber" | "passportIssuedAt" | "passportExpiresAt"; questionnaire: string | null; document: string }[] };
const LABEL: Record<PassportDiff["rows"][number]["field"], string> = {
  passportNumber: "Номер паспорта", passportIssuedAt: "Паспорт видано", passportExpiresAt: "Паспорт дійсний до",
};
const fmt = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8, 10)}.${v.slice(5, 7)}.${v.slice(0, 4)}` : v || "—");

export function PassportAnketaSyncModal({ diff, applying, onApply, onClose }: { diff: PassportDiff; applying?: boolean; onApply: () => void; onClose: () => void }) {
  const t = useT();
  return (
    <Modal open onClose={onClose} title={t("Оновити анкету з нового паспорта?")}>
      <p className="mb-3 text-sm text-slate-500">{t("Дані підтвердженого паспорта відрізняються від анкети. Зміна запишеться в «Історію змін» профілю.")}</p>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-slate-400"><th className="pb-1 font-normal" /><th className="pb-1 font-normal">{t("В анкеті")}</th><th className="pb-1 font-normal">{t("У паспорті")}</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {diff.rows.map(r => (
            <tr key={r.field}>
              <td className="py-1.5 pr-3 text-slate-500">{t(LABEL[r.field])}</td>
              <td className="py-1.5 pr-3 text-slate-400 line-through">{fmt(r.questionnaire)}</td>
              <td className="py-1.5 font-medium text-slate-800">{fmt(r.document)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("Лишити анкету як є")}</Button>
        <Button loading={applying} onClick={onApply}>{t("Оновити анкету")}</Button>
      </div>
    </Modal>
  );
}

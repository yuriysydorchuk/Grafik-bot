// «Історія документа» — журнал worker_document_audit (хто додав/змінив/
// підтвердив/відхилив документ і при чому саме). Дзеркало InvoiceAuditModal
// (той самий візуал), джерело — GET /worker-documents/:id/audit (cap legalization).
import { useQuery } from "@tanstack/react-query";
import { get, type DocumentAuditEntry } from "../lib/api";
import { Modal, Spinner, Empty } from "./ui";
import { useT } from "../lib/i18n";

const FIELD: Record<string, string> = {
  validFrom: "Чинний з", expiresAt: "Чинний до", employerCompanyId: "Роботодавець (id)",
  caseStatus: "Статус справи", submittedAt: "Подано", caseNumber: "№ справи", decisionAt: "Рішення",
  issuer: "Видав", status: "Статус", number: "Номер", note: "Примітка", fileName: "Файл", title: "Назва",
  replacesDocumentId: "Поновлює",
};
const ACTION: Record<string, string> = {
  created: "додано документ", updated: "змінено", file: "додано/замінено файл",
  verified: "підтверджено", rejected: "відхилено", case: "оновлено справу",
  requested: "запрошено подати", deleted: "видалено",
};

export function DocumentAuditModal({ documentId, title, onClose }: { documentId: number; title: string; onClose: () => void }) {
  const t = useT();
  const q = useQuery<DocumentAuditEntry[]>({
    queryKey: ["document-audit", documentId],
    queryFn: () => get(`/worker-documents/${documentId}/audit`),
  });
  const val = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : v === true ? t("так") : v === false ? t("ні") : String(v));
  return (
    <Modal open title={`${t("Історія документа")} ${title}`} onClose={onClose} size="lg">
      {q.isFetching && !q.data ? <Spinner /> : !q.data?.length ? (
        <Empty>{t("Записів ще немає — історія ведеться з моменту додавання цієї функції")}</Empty>
      ) : (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {q.data.map(e => (
            <div key={e.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-700">
                  {e.adminName ?? (e.source === "worker_bot" ? t("бот") : t("система"))}
                  <span className="ml-2 text-xs font-normal text-slate-400">{t(ACTION[e.action] ?? e.action)}</span>
                </span>
                <span className="whitespace-nowrap text-xs text-slate-400">{new Date(e.createdAt).toLocaleString("uk-UA")}</span>
              </div>
              {(e.changes ?? []).map((c, i) => (
                <div key={i} className="mt-0.5 text-xs text-slate-600">
                  {t(FIELD[c.field] ?? c.field)}: <span className="text-slate-400 line-through">{val(c.from)}</span>
                  {" → "}<span className="font-medium">{val(c.to)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

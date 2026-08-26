// «Історія фактури» — журнал invoice_audit (хто додав / змінив / затвердив оплату).
// Спільна модалка для /cost-invoices і /ksef; дані — GET /cost-invoices/audit
// (гейт viewFinance АБО costInvoices — покриває обидві сторінки).
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { Modal, Spinner, Empty } from "./ui";
import { useT } from "../lib/i18n";

export interface AuditTarget { origin: "ksef" | "local"; id: number; number: string | null }

interface Entry {
  id: number; action: string;
  changes: { field: string; from?: unknown; to?: unknown }[] | null;
  adminName: string | null; createdAt: string;
}

const FIELD: Record<string, string> = {
  number: "Номер", issueDate: "Дата виставлення", amount: "Сума", counterparty: "Постачальник",
  sellerNip: "NIP", dueDate: "Термін оплати", note: "Нотатка", paymentMethod: "Спосіб оплати",
  cashReport: "Рапорт готівковий", manualCategory: "Категорія", unpaid: "Не оплачена",
  manualStatus: "Статус оплати (вручну)", manualPaidDate: "Дата оплати (вручну)", paidDate: "Дата оплати",
  hostelId: "Хостел", vehicleId: "Авто", city: "Місто", companyId: "Фірма",
  cleaning: "Прибирання", segment: "Сегмент", cleaningProjectId: "Вспульнота",
};
const ACTION: Record<string, string> = {
  created: "додано фактуру", updated: "змінено", file: "додано/замінено файл", deleted: "видалено",
};

export function InvoiceAuditModal({ target, onClose }: { target: AuditTarget; onClose: () => void }) {
  const t = useT();
  const q = useQuery<{ entries: Entry[] }>({
    queryKey: ["invoice-audit", target.origin, target.id],
    queryFn: () => get(`/cost-invoices/audit?origin=${target.origin}&id=${target.id}`),
  });
  const val = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : v === true ? t("так") : v === false ? t("ні") : String(v));
  return (
    <Modal open title={`${t("Історія фактури")} ${target.number ?? ""}`} onClose={onClose} size="lg">
      {q.isFetching && !q.data ? <Spinner /> : !q.data?.entries.length ? (
        <Empty>{t("Записів ще немає — історія ведеться з моменту додавання цієї функції")}</Empty>
      ) : (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {q.data.entries.map(e => (
            <div key={e.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-700">
                  {e.adminName ?? t("система")}
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

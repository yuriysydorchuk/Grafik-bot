import { useState } from "react";
import { post, patch } from "../lib/api";
import { Select, Button, Input, Modal } from "./ui";
import { useT } from "../lib/i18n";

export interface Obligation {
  id: number; companyId: number | null; direction: string; counterparty: string; description: string | null;
  amount: number; dueDate: string | null; arisenDate: string; status: string; settledAt: string | null; note: string | null; source: string;
}

// Create/edit a receivable or payable. Used by «Належності» and inline on «Баланс»
// (there the direction is preset by the clicked section and arisenDate defaults to
// the viewed month end so the item lands in that month's position).
export function ObligationModal({ companies, ob, defaults, onClose, onSaved }: {
  companies: { id: number; name: string }[];
  ob: Obligation | null;
  defaults?: { direction?: string; companyId?: string; arisenDate?: string };
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [direction, setDirection] = useState(ob?.direction ?? defaults?.direction ?? "payable");
  const [companyId, setCompanyId] = useState(ob ? String(ob.companyId ?? "") : (defaults?.companyId ?? ""));
  const [counterparty, setCounterparty] = useState(ob?.counterparty ?? "");
  const [description, setDescription] = useState(ob?.description ?? "");
  const [amount, setAmount] = useState(ob ? String(ob.amount) : "");
  const [dueDate, setDueDate] = useState(ob?.dueDate ?? "");
  const [arisenDate, setArisenDate] = useState(ob?.arisenDate ?? defaults?.arisenDate ?? new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState(ob?.note ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { direction, companyId: companyId ? Number(companyId) : null, counterparty, description, amount, dueDate: dueDate || null, arisenDate, note };
      if (ob) await patch(`/obligations/${ob.id}`, body);
      else await post("/obligations", body);
      onSaved();
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={ob ? t("Редагувати належність") : t("Нова належність")} onClose={onClose}>
      <div className="space-y-3">
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Тип")}</div>
          <Select value={direction} onChange={e => setDirection(e.target.value)} disabled={!!ob}>
            <option value="payable">{t("Ми винні (податки, фактури, борг)")}</option>
            <option value="receivable">{t("Нам винні (недоотримана оплата)")}</option>
          </Select></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Фірма")}</div>
          <Select value={companyId} onChange={e => setCompanyId(e.target.value)}>
            <option value="">{t("— спільне —")}</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Хто / кому (контрагент)")}</div>
          <Input value={counterparty} onChange={e => setCounterparty(e.target.value)} placeholder={t("напр. US (VAT за червень), клієнт X")} /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Опис")}</div>
          <Input value={description} onChange={e => setDescription(e.target.value)} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Сума")}</div>
            <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></label>
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Термін (до якої дати)")}</div>
            <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></label>
        </div>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Виникло (з якої дати це борг — впливає на стан на кінець місяця)")}</div>
          <Input type="date" value={arisenDate} onChange={e => setArisenDate(e.target.value)} /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Нотатка")}</div>
          <Input value={note} onChange={e => setNote(e.target.value)} /></label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={busy} disabled={!amount || !counterparty} onClick={save}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

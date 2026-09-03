// Скан karta pobytu з профілю: фото лицьової (обовʼязково) і звороту → OCR →
// поля для перевірки (тип карти, номер, строк, доступ до ринку праці, мета) →
// «Зберегти» створює документ з обома сторонами одним PDF
// (routes/residenceCardScan.ts). Мета — ручний селект: на карті не друкується.
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScanLine, Camera, CheckCircle2, AlertTriangle } from "lucide-react";
import { post, upload, type DocumentType } from "../lib/api";
import { Button, Modal, Input, Label, Select } from "./ui";
import { useT } from "../lib/i18n";
import { TRC_PURPOSE_OPTIONS } from "../lib/documentFields";

type Draft = {
  typeCode: string | null; permitText: string | null; cardNumber: string | null; expiresAt: string | null;
  birthDate: string | null; nationality: string | null; laborMarketAccess: boolean | null; isResidenceCard: boolean; mrzValid: boolean;
};
const CARD_CODES = ["trc", "karta_stalego_pobytu", "rezydent_ue", "refugee_status", "subsidiary_protection", "humanitarian_stay", "tolerated_stay", "eu_family_member_card"];

export function ResidenceCardScanModal({ workerId, types, onClose, onSaved }: { workerId: number; types: DocumentType[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const frontRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLInputElement>(null);
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [tempFile, setTempFile] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [typeCode, setTypeCode] = useState("trc");
  const [number, setNumber] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [laborMarketAccess, setLaborMarketAccess] = useState(false);
  const [purpose, setPurpose] = useState("");
  const cardTypes = CARD_CODES.map(c => types.find(ty => ty.code === c)).filter((x): x is DocumentType => !!x);

  const analyze = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("front", front!);
      if (back) fd.append("back", back);
      return upload<{ draft: Draft; tempFile: string; sides: number }>(`/workers/${workerId}/residence-card-scan`, fd);
    },
    onSuccess: r => {
      setDraft(r.draft); setTempFile(r.tempFile);
      if (r.draft.typeCode) setTypeCode(r.draft.typeCode);
      setNumber(r.draft.cardNumber ?? ""); setExpiresAt(r.draft.expiresAt ?? "");
      setLaborMarketAccess(r.draft.laborMarketAccess === true);
    },
    onError: (e: any) => toast.error(e.message),
  });
  const confirm = useMutation({
    mutationFn: () => post(`/workers/${workerId}/residence-card-scan/confirm`, {
      tempFile, typeCode, number: number.trim() || null, expiresAt, validFrom: validFrom || null,
      laborMarketAccess: typeCode === "trc" ? laborMarketAccess : undefined, purpose: typeCode === "trc" ? (purpose || null) : null,
    }),
    onSuccess: () => { toast.success(t("Карту додано")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  const pick = (ref: React.RefObject<HTMLInputElement | null>, set: (f: File | null) => void, label: string, file: File | null) => (
    <button type="button" onClick={() => ref.current?.click()}
      className={`flex flex-1 flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-4 text-sm ${file ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
      {file ? <CheckCircle2 className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
      <span className="font-medium">{label}</span>
      <span className="max-w-full truncate text-xs text-slate-400">{file ? file.name : t("фото або PDF")}</span>
      <input ref={ref} type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={e => set(e.target.files?.[0] ?? null)} />
    </button>
  );

  return (
    <Modal open onClose={onClose} title={t("Сканувати karta pobytu")}>
      <div className="space-y-3">
        {!draft ? (
          <>
            <div className="flex gap-2">
              {pick(frontRef, setFront, t("Лицьова сторона"), front)}
              {pick(backRef, setBack, t("Зворот (MRZ, adnotacje)"), back)}
            </div>
            <p className="text-xs text-slate-400">{t("Зчитуються тип карти, номер, строк дії і «dostęp do rynku pracy». Мета перебування — з decyzji, вкажеш вручну.")}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
              <Button loading={analyze.isPending} disabled={!front} onClick={() => analyze.mutate()}><ScanLine className="h-3.5 w-3.5" /> {t("Розпізнати")}</Button>
            </div>
          </>
        ) : (
          <>
            <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${draft.mrzValid ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {draft.mrzValid ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span>
                {draft.mrzValid ? t("MRZ зчитано, контрольні суми збіглись — перевір поля й збережи.") : t("MRZ не зчитано або суми не збіглись — звір поля з карткою вручну.")}
                {draft.permitText && <> · {draft.permitText}</>}
                {draft.nationality && <> · {draft.nationality}</>}
              </span>
            </div>
            <div>
              <Label>{t("Тип карти")}</Label>
              <Select value={typeCode} onChange={e => setTypeCode(e.target.value)}>
                {cardTypes.map(ty => <option key={ty.code!} value={ty.code!}>{ty.name}</option>)}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>{t("Номер карти")}</Label><Input value={number} onChange={e => setNumber(e.target.value.toUpperCase())} /></div>
              <div><Label>{t("Дійсна до")}</Label><Input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} /></div>
              <div><Label>{t("Видана")}</Label><Input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} /></div>
            </div>
            {typeCode === "trc" && (
              <>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={laborMarketAccess} onChange={e => setLaborMarketAccess(e.target.checked)} />
                  {t("Z dostępem do rynku pracy — дає й право на працю")}
                  {draft.laborMarketAccess === null && <span className="text-xs text-slate-400">({t("на звороті не побачили — перевір")})</span>}
                </label>
                <div>
                  <Label>{t("Мета перебування (з decyzji)")}</Label>
                  <Select value={purpose} onChange={e => setPurpose(e.target.value)}>
                    <option value="">—</option>
                    {TRC_PURPOSE_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
                  </Select>
                </div>
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setDraft(null); setTempFile(null); }}>{t("Інше фото")}</Button>
              <Button loading={confirm.isPending} disabled={!expiresAt} onClick={() => confirm.mutate()}>{t("Зберегти")}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

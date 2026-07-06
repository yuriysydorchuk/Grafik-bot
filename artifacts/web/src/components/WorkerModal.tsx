import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { post, patch, type Worker, type Factory, type Company } from "../lib/api";
import { Button, Input, Select, Label, Modal } from "./ui";
import { useT } from "../lib/i18n";

// Bot UI languages a worker can have (mirrors bot/i18n.ts).
const LANGUAGES: { value: string; label: string }[] = [
  { value: "uk", label: "🇺🇦 Українська" },
  { value: "en", label: "🇬🇧 English" },
  { value: "es", label: "🇪🇸 Español" },
  { value: "ru", label: "🇷🇺 Русский" },
  { value: "pl", label: "🇵🇱 Polski" },
];

// Create / edit a worker. Shared by the Workers list and the worker profile page.
export function WorkerModal({ worker, factories, companies, isOwner, onClose, onSaved }: {
  worker: Worker | null; factories: Factory[]; companies: Company[]; isOwner: boolean; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [fullName, setFullName] = useState(worker?.fullName ?? "");
  const [factoryId, setFactoryId] = useState(worker?.factoryId ? String(worker.factoryId) : "");
  const [companyId, setCompanyId] = useState(worker?.companyId ? String(worker.companyId) : "");
  const [positionId, setPositionId] = useState(worker?.positionId ? String(worker.positionId) : "");
  const [gender, setGender] = useState(worker?.gender ?? "");
  const [fixedShift, setFixedShift] = useState(worker?.fixedShift ?? "");
  const [telegramId, setTelegramId] = useState(worker?.telegramId ?? "");
  const [workerCode, setWorkerCode] = useState(worker?.workerCode ?? "");
  const [language, setLanguage] = useState(worker?.language ?? "");
  const [hourlyRate, setHourlyRate] = useState(worker?.hourlyRate != null ? String(worker.hourlyRate) : "31.5");
  const [isStudent, setIsStudent] = useState(!!worker?.isStudent);
  const [under26, setUnder26] = useState(!!worker?.under26);
  const [selfTransport, setSelfTransport] = useState(!!worker?.selfTransport);
  const finance = isOwner ? { hourlyRate: hourlyRate.trim() === "" ? 31.5 : Number(hourlyRate.replace(",", ".")), isStudent, under26 } : {};
  const selFactory = factories.find(f => String(f.id) === factoryId);
  const shiftCount = selFactory?.shiftCount ?? 3;
  // position / gender fields only for factories that use them
  const facPositions = selFactory?.usesPositions ? (selFactory.positions ?? []) : [];
  const showPositions = !!selFactory?.usesPositions && facPositions.length > 0;
  const showGender = !!selFactory?.usesGender;
  const base = {
    fullName, factoryId: factoryId ? Number(factoryId) : null, companyId: companyId ? Number(companyId) : null,
    positionId: positionId ? Number(positionId) : null, gender: gender || null, fixedShift: fixedShift || null,
    telegramId, workerCode: workerCode.trim() || null, language: language || null, selfTransport, ...finance,
  };
  const save = useMutation({
    mutationFn: () => worker ? patch(`/workers/${worker.id}`, base) : post(`/workers`, base),
    onSuccess: () => { toast.success(worker ? t("Збережено") : t("Додано")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={worker ? t("Редагувати працівника") : t("Новий працівник")}>
      <div className="space-y-3">
        <div><Label>{t("Ім'я та прізвище")}</Label><Input value={fullName} onChange={e => setFullName(e.target.value)} autoFocus /></div>
        <div><Label>{t("Фірма")}</Label>
          <Select value={companyId} onChange={e => setCompanyId(e.target.value)}>
            <option value="">{t("— без фірми —")}</option>
            {companies.map(co => <option key={co.id} value={co.id}>{co.name}</option>)}
          </Select>
        </div>
        <div><Label>{t("Фабрика")}</Label>
          <Select value={factoryId} onChange={e => setFactoryId(e.target.value)}>
            <option value="">{t("— без фабрики —")}</option>
            {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </div>
        {(showPositions || showGender) && (
          <div className="grid grid-cols-2 gap-3">
            {showPositions && <div><Label>{t("Посада")}</Label>
              <Select value={positionId} onChange={e => setPositionId(e.target.value)}>
                <option value="">{t("— без посади —")}</option>
                {facPositions.map(p => <option key={p.positionId} value={p.positionId}>{p.name}</option>)}
              </Select>
            </div>}
            {showGender && <div><Label>{t("Стать")}</Label>
              <Select value={gender} onChange={e => setGender(e.target.value)}>
                <option value="">{t("— не вказано —")}</option>
                <option value="male">{t("Чоловік")}</option>
                <option value="female">{t("Жінка")}</option>
              </Select>
            </div>}
          </div>
        )}
        <div><Label>{t("Закріплена зміна")}</Label>
          <Select value={fixedShift} onChange={e => setFixedShift(e.target.value)}>
            <option value="">{t("— гнучко (будь-яка зміна) —")}</option>
            {Array.from({ length: shiftCount }, (_, i) => <option key={i + 1} value={i + 1}>{t("{n} зміна", { n: i + 1 })}</option>)}
          </Select>
          <p className="mt-1 text-xs text-slate-400">{t("Для фабрик «всіх у зміни» — закріплює працівника за конкретною зміною на весь тиждень.")}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Код (лише цифри)")}</Label><Input value={workerCode} onChange={e => setWorkerCode(e.target.value)} placeholder={worker ? "" : t("авто-генерація")} inputMode="numeric" /></div>
          <div><Label>{t("Мова бота")}</Label>
            <Select value={language} onChange={e => setLanguage(e.target.value)}>
              <option value="">{t("— не обрано —")}</option>
              {LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
            </Select>
          </div>
        </div>
        <div><Label>{t("Telegram ID (необов'язково)")}</Label><Input value={telegramId} onChange={e => setTelegramId(e.target.value)} /></div>
        <div className="rounded-xl border border-slate-200 p-3">
          <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={selfTransport} onChange={e => setSelfTransport(e.target.checked)} /> {t("Доїжджає сам")}</label>
          <p className="mt-1.5 text-xs text-slate-400">{t("Не показується водіям і не рахується до забрання. Явку/відсутність відмічає графікова вручну у графіку.")}</p>
        </div>
        {isOwner && (
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Фінанси (umowa zlecenie)")}</div>
            <div><Label>{t("Ставка брутто (zł/год)")}</Label><Input value={hourlyRate} onChange={e => setHourlyRate(e.target.value)} inputMode="decimal" placeholder="31.5" /></div>
            <div className="mt-2 flex gap-4">
              <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={isStudent} onChange={e => setIsStudent(e.target.checked)} /> {t("Студент")}</label>
              <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={under26} onChange={e => setUnder26(e.target.checked)} /> {t("До 26 років")}</label>
            </div>
            <p className="mt-1.5 text-xs text-slate-400">{t("Студент + до 26 → без ZUS і податків (нетто = брутто). Решта: ZUS 11.26% + здоровотне 9%, ПІТ 0.")}</p>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => fullName.trim() && save.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

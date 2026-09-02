// Іконки типів документів працівника (Settings → Обов'язкові документи, картка
// працівника). Ключ (document_types.icon) — з фіксованого набору нижче, обраний
// вручну в адмінці — самі назви типів вільний текст, автоматично вгадувати
// іконку за назвою ненадійно (і суперечило б духу "нічого не вгадувати").
// null/невідомий ключ → фолбек FileText.
import {
  IdCard, CreditCard, Gavel, GraduationCap, Stethoscope, Stamp, Bell, Flag,
  FileSignature, ShieldCheck, FileText, type LucideIcon,
} from "lucide-react";

export const DOC_TYPE_ICONS: Record<string, { Icon: LucideIcon; label: string }> = {
  passport: { Icon: IdCard, label: "Паспорт" },
  residence_card: { Icon: CreditCard, label: "Карта побиту / інша картка" },
  decision: { Icon: Gavel, label: "Децизія (рішення по карті)" },
  student: { Icon: GraduationCap, label: "Довідка студента" },
  medical: { Icon: Stethoscope, label: "Санепід / медична книжка" },
  permit: { Icon: Stamp, label: "Дозвіл (зезволення)" },
  notification: { Icon: Bell, label: "Повідомлення про роботу" },
  karta_polaka: { Icon: Flag, label: "Карта поляка" },
  contract: { Icon: FileSignature, label: "Умова / договір" },
  insurance: { Icon: ShieldCheck, label: "Страхування" },
};

export const DOC_TYPE_ICON_KEYS = Object.keys(DOC_TYPE_ICONS);

export function docTypeIcon(key: string | null | undefined): LucideIcon {
  return (key && DOC_TYPE_ICONS[key]?.Icon) || FileText;
}

import { useLocation } from "wouter";
import { Check, Circle, Dot, ClipboardList, CheckSquare, Zap, Eye, BadgeCheck, Send } from "lucide-react";
import { Button, Card } from "./ui";
import { useT } from "../lib/i18n";

type State = "done" | "current" | "todo";

interface Props {
  weekLabel: string;
  focusWeek: string;
  ordersTotal: number;
  assignedTotal: number;
  filledCount: number;
  totalWorkers: number;
  weekStatus: string; // none | draft | approved
  planning: { factoryId: number; name: string }[];
  onGenerate: (factoryId: number) => void;
  generatingId: number | null;
  onApprove: () => void;
  approving: boolean;
}

export function WeeklyWizard(p: Props) {
  const t = useT();
  const [, nav] = useLocation();
  const hasOrders = p.ordersTotal > 0;
  const hasSchedule = p.assignedTotal > 0 || p.weekStatus === "draft" || p.weekStatus === "approved";
  const approved = p.weekStatus === "approved";

  // figure out the first actionable step that isn't done → that's "current"
  const doneFlags = [hasOrders, p.filledCount > 0, hasSchedule, approved, approved, approved];
  const currentIdx = doneFlags.findIndex(d => !d);

  const stateOf = (i: number): State => doneFlags[i] ? "done" : i === currentIdx ? "current" : "todo";

  const steps = [
    {
      icon: ClipboardList, title: t("Замовлення фабрик"),
      sub: hasOrders ? t("Замовлено {n} змін-місць", { n: p.ordersTotal }) : t("Скільки людей потрібно на зміни"),
      action: <Button variant={stateOf(0) === "current" ? "primary" : "secondary"} className="px-3 py-1.5 text-xs" onClick={() => nav("/orders")}>{hasOrders ? t("Змінити") : t("Заповнити")}</Button>,
    },
    {
      icon: CheckSquare, title: t("Доступність працівників"),
      sub: t("Заповнили {a} з {b}", { a: p.filledCount, b: p.totalWorkers }),
      action: <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => nav("/availability")}>{t("Переглянути")}</Button>,
    },
    {
      icon: Zap, title: t("Згенерувати графік"),
      sub: hasSchedule ? t("Призначено {n}", { n: p.assignedTotal }) : t("Авто-розподіл за доступністю"),
      action: (
        <div className="flex flex-wrap justify-end gap-1.5">
          {p.planning.map(f => (
            <Button key={f.factoryId} variant={stateOf(2) === "current" ? "primary" : "secondary"} className="px-3 py-1.5 text-xs"
              loading={p.generatingId === f.factoryId} onClick={() => p.onGenerate(f.factoryId)}>
              {p.planning.length > 1 ? f.name : (hasSchedule ? t("Перегенерувати") : t("Згенерувати"))}
            </Button>
          ))}
        </div>
      ),
    },
    {
      icon: Eye, title: t("Переглянути графік"),
      sub: hasSchedule ? t("Перевірте, за потреби підправте") : t("Зʼявиться після генерації"),
      action: <Button variant="secondary" className="px-3 py-1.5 text-xs" disabled={!hasSchedule} onClick={() => nav(`/schedule?week=${p.focusWeek}`)}>{t("Відкрити")}</Button>,
    },
    {
      icon: BadgeCheck, title: t("Затвердити"),
      sub: approved ? t("Затверджено · збережено на Drive") : t("Зберегти на Drive і надіслати клієнту"),
      action: <Button variant={stateOf(4) === "current" ? "success" : "secondary"} className="px-3 py-1.5 text-xs" disabled={!hasSchedule || approved} loading={p.approving} onClick={p.onApprove}>{approved ? t("Готово") : t("Затвердити")}</Button>,
    },
    {
      icon: Send, title: t("Розіслати працівникам"),
      sub: t("У боті: 📢 Розсилки → Розіслати затверджений графік"),
      action: null,
    },
  ];

  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-gradient-to-r from-red-50 to-white px-5 py-3.5">
        <h3 className="text-sm font-semibold text-slate-800">{t("Тиждень крок за кроком")}</h3>
        <span className="text-xs text-slate-500">{t("Наступний тиждень")} · {p.weekLabel}</span>
      </div>
      <ol className="divide-y divide-slate-100">
        {steps.map((s, i) => {
          const st = stateOf(i);
          return (
            <li key={i} className={`flex items-center gap-3 px-4 py-3 ${st === "current" ? "bg-red-50/40" : ""}`}>
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                st === "done" ? "bg-emerald-500 text-white" : st === "current" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-400"}`}>
                {st === "done" ? <Check className="h-4 w-4" /> : st === "current" ? <Dot className="h-6 w-6" /> : <Circle className="h-3.5 w-3.5" />}
              </div>
              <s.icon className={`h-[18px] w-[18px] shrink-0 ${st === "todo" ? "text-slate-300" : "text-slate-500"}`} />
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-medium ${st === "todo" ? "text-slate-400" : "text-slate-700"}`}>{s.title}</div>
                <div className="truncate text-xs text-slate-400">{s.sub}</div>
              </div>
              {s.action}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

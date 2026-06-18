import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Copy, SlidersHorizontal, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { get, put, type Factory, type FactoryPositionConf, type OrderRequirement, DAYS, DAY_FULL } from "../lib/api";
import { upcomingWeeks } from "../lib/dates";
import { usePersisted } from "../lib/hooks";
import { WeekSelect } from "../components/WeekSelect";
import { Button, Select, Card, Spinner, Empty, Modal, Input, Label, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { badgeClass, dotClass, genderIcon } from "../lib/colors";
import { useT } from "../lib/i18n";

type OrderMap = Record<string, number[]>;
type ReqMap = Record<string, OrderRequirement[]>; // key: "day-shift" (shift 1-based)
type OrdersResp = { totals: OrderMap; req: ReqMap };

const sumReq = (lines: OrderRequirement[]) => lines.reduce((s, l) => s + (Number(l.count) || 0), 0);

export default function Orders() {
  const t = useT();
  const qc = useQueryClient();
  const { data: factories = [], isLoading } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const [factoryId, setFactoryId] = usePersisted<string>("sel.factory", "");
  const [weekStart, setWeekStart] = useState(upcomingWeeks()[0]!.value);
  const [grid, setGrid] = useState<OrderMap>({});
  const [req, setReq] = useState<ReqMap>({});
  const [editKey, setEditKey] = useState<string | null>(null); // "day-shift" being broken down

  useEffect(() => { if (!factoryId && factories.length) setFactoryId(String(factories[0]!.id)); }, [factories]);

  const { data: loaded, isFetching } = useQuery<OrdersResp>({
    queryKey: ["orders", factoryId, weekStart],
    queryFn: () => get(`/orders?factoryId=${factoryId}&weekStart=${weekStart}`),
    enabled: !!factoryId,
  });
  useEffect(() => { if (loaded) { setGrid(loaded.totals ?? {}); setReq(loaded.req ?? {}); } }, [loaded]);

  const selFactory = factories.find(f => String(f.id) === factoryId);
  const shiftCount = selFactory?.shiftCount ?? 3;
  const facPositions: FactoryPositionConf[] = selFactory?.usesPositions ? (selFactory.positions ?? []) : [];
  const usesGender = !!selFactory?.usesGender;
  // breakdown (position/gender split) is only offered for factories that need it
  const canBreakdown = (!!selFactory?.usesPositions && facPositions.length > 0) || usesGender;
  const shiftIdx = Array.from({ length: shiftCount }, (_, i) => i);
  const keyOf = (day: string, s: number) => `${day}-${s + 1}`;
  const lines = (day: string, s: number) => req[keyOf(day, s)] ?? [];
  const hasBreak = (day: string, s: number) => lines(day, s).length > 0;
  const cell = (day: string, s: number) => hasBreak(day, s) ? sumReq(lines(day, s)) : (grid[day]?.[s] ?? 0);
  const setCell = (day: string, s: number, val: number) => {
    const row = Array.from({ length: shiftCount }, (_, i) => grid[day]?.[i] ?? 0);
    row[s] = Math.max(0, val);
    setGrid({ ...grid, [day]: row });
  };
  const copyMon = () => {
    const mon = Array.from({ length: shiftCount }, (_, i) => grid["mon"]?.[i] ?? 0);
    const g: OrderMap = {};
    const r: ReqMap = {};
    for (const d of DAYS) {
      g[d] = [...mon];
      for (let s = 0; s < shiftCount; s++) {
        const ml = req[`mon-${s + 1}`];
        if (ml?.length) r[`${d}-${s + 1}`] = ml.map(l => ({ ...l }));
      }
    }
    setGrid(g); setReq(r);
  };

  const save = useMutation({
    mutationFn: () => put("/orders", { factoryId: Number(factoryId), weekStart, totals: grid, req }),
    onSuccess: () => { toast.success(t("Замовлення збережено")); qc.invalidateQueries({ queryKey: ["orders"] }); qc.invalidateQueries({ queryKey: ["schedule"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const total = DAYS.reduce((s, d) => s + shiftIdx.reduce((a, i) => a + cell(d, i), 0), 0);
  const posName = (id: number | null) => id == null ? t("будь-яка посада") : (facPositions.find(p => p.positionId === id)?.name ?? "?");
  const posColor = (id: number | null) => id == null ? "slate" : (facPositions.find(p => p.positionId === id)?.color ?? "slate");

  if (isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t("Замовлення фабрик")} subtitle={t("Скільки людей потрібно на кожну зміну")}
        action={<Button onClick={() => save.mutate()} loading={save.isPending}><Save className="h-4 w-4" /> {t("Зберегти")}</Button>} />

      <WeekSelect value={weekStart} onChange={setWeekStart} className="mb-4" />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select value={factoryId} onChange={e => setFactoryId(e.target.value)} className="w-48">
          {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
        <Button variant="secondary" onClick={copyMon}><Copy className="h-4 w-4" /> {t("Понеділок → усім")}</Button>
      </div>

      {!factories.length ? <Empty>{t("Спочатку додайте фабрику")}</Empty> : (
        <Card className="overflow-x-auto">
          {isFetching && <div className="h-0.5 animate-pulse bg-red-400" />}
          <table className="w-full min-w-130 text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2.5 text-left">{t("День")}</th>{shiftIdx.map(s => <th key={s} className="px-4 py-2.5">{s + 1} {t("зміна")}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {DAYS.map(d => (
                <tr key={d}>
                  <td className="px-4 py-2 font-medium text-slate-700">{DAY_FULL[d]}</td>
                  {shiftIdx.map(s => {
                    const broken = hasBreak(d, s);
                    return (
                      <td key={s} className="px-4 py-2 align-top">
                        <div className="flex flex-col items-center gap-1">
                          <div className="flex items-center gap-1">
                            <input type="number" min={0} value={cell(d, s)} disabled={broken}
                              onChange={e => setCell(d, s, Number(e.target.value))}
                              className={`w-16 rounded-lg border px-2 py-1.5 text-center outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 ${broken ? "border-slate-200 bg-slate-50 text-slate-500" : "border-slate-300"}`} />
                            {canBreakdown && (
                              <button onClick={() => setEditKey(keyOf(d, s))} title={t("Розбивка по посадах/статі")}
                                className={`rounded-lg border p-1.5 transition ${broken ? "border-red-300 bg-red-50 text-red-600" : "border-slate-200 text-slate-400 hover:bg-slate-50 hover:text-slate-600"}`}>
                                <SlidersHorizontal className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                          {broken && (
                            <div className="flex flex-wrap justify-center gap-0.5">
                              {lines(d, s).map((l, i) => (
                                <span key={i} className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${badgeClass(posColor(l.positionId))}`}>
                                  {l.count}{l.gender !== "any" && genderIcon(l.gender)} {posName(l.positionId).split(" ")[0]}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="bg-slate-50 font-semibold text-slate-700"><td className="px-4 py-2.5">{t("Усього")}</td><td colSpan={shiftCount} className="px-4 py-2.5 text-center">{total} {t("змін-місць")}</td></tr></tfoot>
          </table>
        </Card>
      )}
      {canBreakdown && <p className="mt-3 text-xs text-slate-400">💡 {t("Натисніть на повзунок у клітинці, щоб задати розбивку: скільки людей на яку посаду та стать (напр. 5 дівчат + 5 хлопців на продукцію, 2 вузкових).")}</p>}

      {editKey && (
        <BreakdownModal day={editKey.split("-")[0]!} shift={editKey.split("-")[1]!} positions={facPositions} usesGender={usesGender}
          value={req[editKey] ?? []} fallbackTotal={grid[editKey.split("-")[0]!]?.[Number(editKey.split("-")[1]) - 1] ?? 0}
          onClose={() => setEditKey(null)}
          onApply={(linesOut) => { setReq(prev => { const n = { ...prev }; if (linesOut.length) n[editKey] = linesOut; else delete n[editKey]; return n; }); setEditKey(null); }} />
      )}
    </>
  );
}

function BreakdownModal({ day, shift, positions, usesGender, value, fallbackTotal, onClose, onApply }: {
  day: string; shift: string; positions: FactoryPositionConf[]; usesGender: boolean; value: OrderRequirement[]; fallbackTotal: number;
  onClose: () => void; onApply: (lines: OrderRequirement[]) => void;
}) {
  const t = useT();
  const [lines, setLines] = useState<OrderRequirement[]>(
    value.length ? value.map(l => ({ ...l })) : (fallbackTotal > 0 ? [{ positionId: null, gender: "any", count: fallbackTotal }] : [])
  );
  const update = (i: number, patch: Partial<OrderRequirement>) => setLines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l));
  const addLine = () => setLines(ls => [...ls, { positionId: null, gender: "any", count: 1 }]);
  const removeLine = (i: number) => setLines(ls => ls.filter((_, j) => j !== i));
  const total = sumReq(lines);
  const clean = () => lines.map(l => ({ positionId: l.positionId, gender: l.gender, count: Math.max(0, Number(l.count) || 0) })).filter(l => l.count > 0);

  return (
    <Modal open onClose={onClose} title={t("Розбивка — {day}, {n} зміна", { day: DAY_FULL[day as keyof typeof DAY_FULL], n: shift })}>
      <div className="space-y-3">
        <p className="text-xs text-slate-400">{t("Кожен рядок — скільки людей якої посади та статі потрібно. Без рядків = просто загальна кількість.")}</p>
        {!lines.length && <Empty>{t("Без розбивки. Додайте рядок або закрийте — буде використано просте число.")}</Empty>}
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2">
              <div className="min-w-36 flex-1"><Label>{t("Посада")}</Label>
                <Select value={l.positionId == null ? "" : String(l.positionId)} onChange={e => update(i, { positionId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t("Будь-яка")}</option>
                  {positions.map(p => <option key={p.positionId} value={p.positionId}>{p.name}</option>)}
                </Select>
              </div>
              {usesGender && <div className="w-28"><Label>{t("Стать")}</Label>
                <Select value={l.gender} onChange={e => update(i, { gender: e.target.value as OrderRequirement["gender"] })}>
                  <option value="any">{t("Будь-яка")}</option>
                  <option value="female">{t("Жінки")}</option>
                  <option value="male">{t("Чоловіки")}</option>
                </Select>
              </div>}
              <div className="w-20"><Label>{t("К-сть")}</Label>
                <Input type="number" min={0} value={l.count} onChange={e => update(i, { count: Math.max(0, Number(e.target.value)) })} />
              </div>
              <button onClick={() => removeLine(i)} className="mb-1.5 rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <Button variant="secondary" onClick={addLine}><Plus className="h-4 w-4" /> {t("Додати рядок")}</Button>
          <Badge color="slate">{t("Разом")}: {total}</Badge>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          {value.length > 0 && <Button variant="secondary" onClick={() => onApply([])}>{t("Прибрати розбивку")}</Button>}
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button onClick={() => onApply(clean())}>{t("Застосувати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

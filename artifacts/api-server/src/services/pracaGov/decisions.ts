// Рішення людини після перегляду заповненої форми (status review): «зберегти чернетку на
// порталі» (Zapisz dane → schowek, далі руками) або «підписати й надіслати». Той самий
// памʼятевий патерн, що й коди SMS (codes.ts): робот чекає з відкритим браузером.
export type ReviewDecision = "save_draft" | "sign" | "cancel";
type Pending = { resolve: (d: ReviewDecision) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
const pending = new Map<number, Pending>();

export function waitForDecision(submissionId: number, timeoutMs = 20 * 60_000): Promise<ReviewDecision> {
  cancelDecisionWait(submissionId);
  return new Promise<ReviewDecision>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(submissionId); reject(new Error("Рішення не прийнято за 20 хвилин — форму не відправлено")); }, timeoutMs);
    pending.set(submissionId, { resolve, reject, timer });
  });
}
export function provideDecision(submissionId: number, d: ReviewDecision): boolean {
  const p = pending.get(submissionId);
  if (!p) return false;
  clearTimeout(p.timer); pending.delete(submissionId); p.resolve(d);
  return true;
}
export function cancelDecisionWait(submissionId: number, reason = "Скасовано"): void {
  const p = pending.get(submissionId);
  if (!p) return;
  clearTimeout(p.timer); pending.delete(submissionId); p.reject(new Error(reason));
}
export const isAwaitingDecision = (submissionId: number): boolean => pending.has(submissionId);

// Очікування одноразового коду (SMS profilu zaufanego) від людини під час роботи робота
// praca.gov.pl (12.10.2026). Робот живе в цьому ж процесі, тож достатньо памʼяті: на подачу
// реєструється resolver, бот або веб віддають код через provideCode(). Рестарт процесу вбиває
// браузер — така подача все одно завершується failed, тож персистити тут нічого.
type Pending = { resolve: (code: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; adminId: number | null };
const pending = new Map<number, Pending>();

export function waitForCode(submissionId: number, adminId: number | null, timeoutMs = 5 * 60_000): Promise<string> {
  cancelCodeWait(submissionId);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(submissionId); reject(new Error("Код не введено за 5 хвилин")); }, timeoutMs);
    pending.set(submissionId, { resolve, reject, timer, adminId });
  });
}

// true = робот чекав код і отримав його; false = ніхто не чекає (запізно/не той id)
export function provideCode(submissionId: number, code: string): boolean {
  const p = pending.get(submissionId);
  if (!p) return false;
  clearTimeout(p.timer); pending.delete(submissionId);
  p.resolve(code.replace(/\s+/g, ""));
  return true;
}

export function cancelCodeWait(submissionId: number, reason = "Скасовано"): void {
  const p = pending.get(submissionId);
  if (!p) return;
  clearTimeout(p.timer); pending.delete(submissionId);
  p.reject(new Error(reason));
}

export const isAwaitingCode = (submissionId: number): boolean => pending.has(submissionId);
// Подачі, що чекають код саме від цього адміна (бот: «Ввести код» без вказаного id)
export const awaitingCodeFor = (adminId: number): number[] => [...pending.entries()].filter(([, p]) => p.adminId === adminId).map(([id]) => id);

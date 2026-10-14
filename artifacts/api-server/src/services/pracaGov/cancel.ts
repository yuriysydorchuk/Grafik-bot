// Прапорець скасування подачі ззовні («Зупинити робота»): робот перевіряє його на кожному кроці
// (robot.ts step()) і завершується RobotError("cancelled"); фасад ставить статус cancelled.
const cancelled = new Set<number>();
export const requestCancel = (submissionId: number) => { cancelled.add(submissionId); };
export const isCancelled = (submissionId: number) => cancelled.has(submissionId);
export const clearCancel = (submissionId: number) => { cancelled.delete(submissionId); };

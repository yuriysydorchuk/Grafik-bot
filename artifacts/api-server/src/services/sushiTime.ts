/**
 * Сервісний модуль розрахунку робочого часу, 15-хвилинного округлення та колізій інтервалів
 * для фабрики «Суші» (Sushi & Food Factory).
 * 
 * Бізнес-правила:
 * 1. Старт округлюється ВГОРУ (Round UP) до 15 хв: ceil(mins / 15) * 15 (06:01 -> 06:15).
 * 2. Фініш округлюється ВНИЗ (Round DOWN) до 15 хв: floor(mins / 15) * 15 (14:14 -> 14:00).
 * 3. Підтримка нічних переходів через північ (22:00 -> 06:00 = 8.0 год, 17:00 -> 05:00 = 12.0 год).
 * 4. Smart Merge інтервалів (дедуплікація, злиття перекриттів, збереження odziez).
 */

export interface SushiIntervalData {
  id?: number;
  workerId: number;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  stopTime: string; // HH:MM
  roundedStartTime?: string;
  roundedStopTime?: string;
  hours?: number;
  shift?: string;
  dzial?: string;
  lineId?: number | null;
  roleId?: number | null;
  clothingDeduction?: boolean;
  notes?: string | null;
  status?: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: "MISSING_START" | "MISSING_STOP" | "INVALID_FORMAT" | "ZERO_DURATION";
  errorMessage?: string;
  normalizedStart?: string;
  normalizedStop?: string;
  roundedStart?: string;
  roundedStop?: string;
  hours?: number;
}

/**
 * Нормалізація рядка часу у формат HH:MM (наприклад, "6:5" -> "06:05", "14:00:00" -> "14:00").
 * Також підтримує десятковий час з Excel (наприклад, 0.25 -> "06:00", 0.708333 -> "17:00").
 */
export function normalizeTime(timeVal?: string | number | null): string | null {
  if (timeVal === undefined || timeVal === null) return null;

  if (typeof timeVal === "number") {
    if (isNaN(timeVal) || timeVal < 0) return null;
    let totalMinutes = 0;
    if (timeVal < 1) {
      // Дріб доби в Excel (0.0 .. 1.0) -> множимо на 24 * 60
      totalMinutes = Math.round(timeVal * 24 * 60);
    } else if (timeVal <= 24) {
      // Година (напр. 7 -> 07:00, 17.5 -> 17:30)
      totalMinutes = Math.round(timeVal * 60);
    } else {
      // Excel datetime serial (> 24) -> беремо дробову частину
      totalMinutes = Math.round((timeVal % 1) * 24 * 60);
    }
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  const str = String(timeVal).trim().replace(",", ".");
  if (!str) return null;

  // Якщо рядок є числовим дробом (напр. "0.7083333333333334" або "0.2708333333333333")
  if (/^\d+(\.\d+)?$/.test(str)) {
    const num = parseFloat(str);
    if (!isNaN(num)) return normalizeTime(num);
  }

  const match = str.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/);
  if (!match) return null;

  const h = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);

  if (h < 0 || h > 24 || m < 0 || m > 59) return null;
  if (h === 24 && m === 0) return "24:00";
  if (h >= 24) return null;

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Парсинг кількості відпрацьованих годин (Realne godziny) з Excel,
 * включно з дробами доби (напр. 0.708333 -> 17.0 год, 0.4166667 -> 10.0 год) та форматом "HH:MM".
 */
export function parseExcelHours(val: string | number | null | undefined): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") {
    if (isNaN(val) || val <= 0) return 0;
    if (val < 1) {
      return Math.round(val * 24 * 100) / 100;
    }
    return Math.round(val * 100) / 100;
  }
  const str = String(val).trim().replace(",", ".");
  if (!str) return 0;

  const timeMatch = str.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1]!, 10);
    const m = parseInt(timeMatch[2]!, 10);
    return Math.round((h + m / 60) * 100) / 100;
  }

  const num = parseFloat(str);
  if (!isNaN(num) && num > 0) {
    if (num < 1) {
      return Math.round(num * 24 * 100) / 100;
    }
    return Math.round(num * 100) / 100;
  }
  return 0;
}

/**
 * Округлення початку зміни ВГОРУ (Round UP) до найближчих 15 хвилин:
 * ceil(minutes / 15) * 15.
 * Приклади:
 * - 06:00 -> 06:00
 * - 06:01 -> 06:15
 * - 06:14 -> 06:15
 * - 06:15 -> 06:15
 * - 06:16 -> 06:30
 */
export function roundStartTime(timeStr: string): string {
  const norm = normalizeTime(timeStr);
  if (!norm) throw new Error(`Invalid time format for roundStartTime: "${timeStr}"`);

  const [hStr, mStr] = norm.split(":");
  let h = parseInt(hStr!, 10);
  const m = parseInt(mStr!, 10);

  if (m === 0) return `${String(h).padStart(2, "0")}:00`;

  const roundedM = Math.ceil(m / 15) * 15;
  if (roundedM === 60) {
    h = (h + 1) % 24;
    return `${String(h).padStart(2, "0")}:00`;
  }

  return `${String(h).padStart(2, "0")}:${String(roundedM).padStart(2, "0")}`;
}

/**
 * Округлення кінця зміни ВНИЗ (Round DOWN) до найближчих 15 хвилин:
 * floor(minutes / 15) * 15.
 * Приклади:
 * - 14:00 -> 14:00
 * - 14:14 -> 14:00
 * - 14:15 -> 14:15
 * - 14:29 -> 14:15
 * - 14:30 -> 14:30
 */
export function roundStopTime(timeStr: string): string {
  const norm = normalizeTime(timeStr);
  if (!norm) throw new Error(`Invalid time format for roundStopTime: "${timeStr}"`);

  const [hStr, mStr] = norm.split(":");
  const h = parseInt(hStr!, 10);
  const m = parseInt(mStr!, 10);

  const roundedM = Math.floor(m / 15) * 15;
  return `${String(h).padStart(2, "0")}:${String(roundedM).padStart(2, "0")}`;
}

/**
 * Перетворення часу "HH:MM" у хвилини від початку доби (0..1440).
 */
export function timeToMinutes(timeStr: string): number {
  const norm = normalizeTime(timeStr);
  if (!norm) throw new Error(`Invalid time: "${timeStr}"`);
  const [hStr, mStr] = norm.split(":");
  return parseInt(hStr!, 10) * 60 + parseInt(mStr!, 10);
}

/**
 * Розрахунок відпрацьованого часу в годинах з підтримкою переходів через північ (00:00).
 * Результат повертається з точністю до сотих (наприклад, 7.75).
 */
export function calcIntervalHours(startStr: string, stopStr: string): number {
  const startMins = timeToMinutes(startStr);
  const stopMins = timeToMinutes(stopStr);

  let diffMins = stopMins - startMins;
  if (diffMins < 0) {
    // Перехід через північ (наприклад 22:00 -> 06:00: 360 - 1320 + 1440 = 480 хв = 8 год)
    diffMins += 24 * 60;
  }

  const hours = diffMins / 60;
  return Math.round(hours * 100) / 100;
}

/**
 * Повна валідація та розрахунок інтервалу для вхідного рядка звіту або форми редагування.
 */
export function validateTimeInterval(
  startVal?: string | number | null,
  stopVal?: string | number | null,
): ValidationResult {
  const normStart = normalizeTime(startVal);
  const normStop = normalizeTime(stopVal);

  if (!normStart && !normStop) {
    return { valid: false, error: "MISSING_START", errorMessage: "Не вказано час початку та завершення зміни" };
  }
  if (!normStart) {
    return { valid: false, error: "MISSING_START", errorMessage: "Не вказано час початку зміни" };
  }
  if (!normStop) {
    return { valid: false, error: "MISSING_STOP", errorMessage: "Не вказано час завершення зміни" };
  }

  const rawStartMins = timeToMinutes(normStart);
  const rawStopMins = timeToMinutes(normStop);
  const isOvernight = rawStopMins < rawStartMins;

  const roundedStart = roundStartTime(normStart);
  const roundedStop = roundStopTime(normStop);
  const roundedStartMins = timeToMinutes(roundedStart);
  let roundedStopMins = timeToMinutes(roundedStop);

  if (isOvernight) {
    roundedStopMins += 24 * 60;
  }

  const diffMins = roundedStopMins - roundedStartMins;
  if (diffMins <= 0) {
    return {
      valid: false,
      error: "ZERO_DURATION",
      errorMessage: "Розрахований час зміни дорівнює 0 годин після 15-хв округлення",
      normalizedStart: normStart,
      normalizedStop: normStop,
      roundedStart,
      roundedStop,
      hours: 0,
    };
  }

  const hours = Math.round((diffMins / 60) * 100) / 100;

  return {
    valid: true,
    normalizedStart: normStart,
    normalizedStop: normStop,
    roundedStart,
    roundedStop,
    hours,
  };
}

/**
 * Smart Merge інтервалів для одного працівника за одну дату:
 * 1. Якщо новий інтервал повністю дублює існуючий -> дублікат відкидається.
 * 2. Якщо новий інтервал перекриває існуючий частково -> об'єднуємо (вибираємо ширший інтервал),
 *    зберігаючи прапорець clothingDeduction.
 * 3. Якщо інтервали роздільні (наприклад, дві зміни в один день) -> додається окремий інтервал.
 */
export function mergeSushiIntervals<T extends SushiIntervalData>(
  existingList: T[],
  newInterval: T,
): T[] {
  const result: T[] = [];
  let merged = false;

  const newStartM = timeToMinutes(newInterval.roundedStartTime || roundStartTime(newInterval.startTime));
  let newStopM = timeToMinutes(newInterval.roundedStopTime || roundStopTime(newInterval.stopTime));
  if (newStopM <= newStartM) newStopM += 24 * 60;

  for (const item of existingList) {
    const itemRoundedStart = item.roundedStartTime || roundStartTime(item.startTime);
    const itemRoundedStop = item.roundedStopTime || roundStopTime(item.stopTime);
    const itemHours = item.hours ?? calcIntervalHours(itemRoundedStart, itemRoundedStop);

    const itemStartM = timeToMinutes(itemRoundedStart);
    let itemStopM = timeToMinutes(itemRoundedStop);
    if (itemStopM <= itemStartM) itemStopM += 24 * 60;

    // 1. Точний дублікат
    if (itemStartM === newStartM && itemStopM === newStopM) {
      // Оновлюємо прапорець одягу, якщо в новому він true
      result.push({
        ...item,
        roundedStartTime: itemRoundedStart,
        roundedStopTime: itemRoundedStop,
        hours: itemHours,
        clothingDeduction: item.clothingDeduction || newInterval.clothingDeduction || false,
        notes: item.notes || newInterval.notes,
      });
      merged = true;
      continue;
    }

    // 2. Перекриття інтервалів (overlap)
    const hasOverlap = Math.max(itemStartM, newStartM) < Math.min(itemStopM, newStopM);
    if (hasOverlap) {
      const combinedStartM = Math.min(itemStartM, newStartM);
      const combinedStopM = Math.max(itemStopM, newStopM);

      const combStartH = Math.floor(combinedStartM / 60) % 24;
      const combStartMin = combinedStartM % 60;
      const combStopH = Math.floor(combinedStopM / 60) % 24;
      const combStopMin = combinedStopM % 60;

      const roundedStart = `${String(combStartH).padStart(2, "0")}:${String(combStartMin).padStart(2, "0")}`;
      const roundedStop = `${String(combStopH).padStart(2, "0")}:${String(combStopMin).padStart(2, "0")}`;
      const hours = calcIntervalHours(roundedStart, roundedStop);

      result.push({
        ...item,
        startTime: itemStartM <= newStartM ? item.startTime : newInterval.startTime,
        stopTime: itemStopM >= newStopM ? item.stopTime : newInterval.stopTime,
        roundedStartTime: roundedStart,
        roundedStopTime: roundedStop,
        hours,
        clothingDeduction: item.clothingDeduction || newInterval.clothingDeduction || false,
        notes: [item.notes, newInterval.notes].filter(Boolean).join("; ") || null,
      });
      merged = true;
      continue;
    }

    result.push({
      ...item,
      roundedStartTime: itemRoundedStart,
      roundedStopTime: itemRoundedStop,
      hours: itemHours,
    });
  }

  if (!merged) {
    const roundedStart = newInterval.roundedStartTime || roundStartTime(newInterval.startTime);
    const roundedStop = newInterval.roundedStopTime || roundStopTime(newInterval.stopTime);
    const hours = newInterval.hours ?? calcIntervalHours(roundedStart, roundedStop);

    result.push({
      ...newInterval,
      roundedStartTime: roundedStart,
      roundedStopTime: roundedStop,
      hours,
    });
  }

  return result;
}

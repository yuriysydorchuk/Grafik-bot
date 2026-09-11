// Спільні правила платного довозу (transport_deductions). Використовують
// генерація знять (routes/transport.ts) і перед-звірка перенесення до сводної
// (routes/svodni.ts) — режими мають збігатися, інакше перенесення бачить
// «розбіжність», якої нема.

/** Межі місяця як рядки: [start, end) у форматі YYYY-MM-DD. */
export function monthBoundsStr(month: string): { monthStart: string; monthEnd: string } {
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  return { monthStart, monthEnd };
}

/**
 * Чи людина у цьому місяці «доїжджає сама» (self_transport). Вирішується
 * ПОМІСЯЧНО через self_transport_since («діє з»): прапорець увімкнули з датою
 * після кінця місяця → у цьому місяці ще «звичайна»; вимкнули з датою після
 * кінця місяця → у цьому місяці ще була self. Без дати (легасі) — за поточним
 * прапорцем. Для self-людей зняття рахуються за посадками водія, а не за
 * годинами сводної.
 */
export function isSelfTransportForMonth(
  w: { selfTransport: boolean; selfTransportSince: string | null },
  monthEnd: string,
): boolean {
  return w.selfTransport
    ? (w.selfTransportSince == null || w.selfTransportSince < monthEnd)
    : (w.selfTransportSince != null && w.selfTransportSince >= monthEnd);
}

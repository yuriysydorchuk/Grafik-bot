// Спільні хелпери платного довозу (transport_deductions): генерація знять
// (routes/transport.ts) і перед-звірка перенесення до сводної (routes/svodni.ts).
// Режим «доїжджає сам» — у services/selfTransport.ts (по фабриці й поденно).

/** Межі місяця як рядки: [start, end) у форматі YYYY-MM-DD. */
export function monthBoundsStr(month: string): { monthStart: string; monthEnd: string } {
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  return { monthStart, monthEnd };
}

// Порожні сторінки PDF — без жодного тексту й жодного зображення (лінії/рамки не рахуються).
// Скан порожнього аркуша — це зображення, тож сюди не потрапляє; потрапляє «вивантажений» PDF,
// у якого зник зміст (зголошення #10, 02.11.2026: «signed_Umowa…» з HRappka — 3 білі сторінки
// умови + 2 сторінки «Karta podpisów»). Best-effort: збій розбору = «порожніх нема».
// Текст, перетворений на криві, не має text-операторів — сторінку з ≥40 контурами вважаємо змістовною
// (порожні сторінки «вивантаженої» умови мали 9–12: рамки/лінії).
const PATHS_AS_CONTENT = 40;
export async function blankPdfPages(data: Uint8Array): Promise<{ pages: number; blank: number[] }> {
  let task: { promise: Promise<any>; destroy: () => Promise<void> } | null = null;
  try {
    const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const content = new Set(Object.entries(OPS).filter(([k]) => /showText|ShowText|Image/.test(k)).map(([, v]) => v as number));
    task = getDocument({ data: new Uint8Array(data), useSystemFonts: true, disableFontFace: true });
    const doc = await task.promise;
    const blank: number[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const ops: number[] = (await (await doc.getPage(p)).getOperatorList()).fnArray;
      if (ops.some(fn => content.has(fn))) continue;
      if (ops.filter(fn => fn === OPS.constructPath).length >= PATHS_AS_CONTENT) continue;
      blank.push(p);
    }
    return { pages: doc.numPages, blank };
  } catch {
    return { pages: 0, blank: [] };
  } finally {
    await task?.destroy().catch(() => {});
  }
}

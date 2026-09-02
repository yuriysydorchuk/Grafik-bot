// Зменшення фото-сканів перед аплоудом (фактури, умови): фото з телефону —
// 5–20 МБ, для скану цього не треба. Малюємо на canvas з обмеженням довшої
// сторони і віддаємо JPEG; якщо браузер не вміє декодувати (HEIC у Chrome) або
// файл і так малий — повертаємо оригінал. PDF не чіпаємо (їх стискає сервер).
const SHRINK_FROM = 1.5 * 1024 * 1024; // менші файли не чіпаємо
const MAX_SIDE = 2400;                 // достатньо для читабельного скану
const TARGET = 3 * 1024 * 1024;        // під це підганяємо якість JPEG

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
}

export async function shrinkImageFile(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < SHRINK_FROM) return file;
  try {
    const img = await loadImage(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null = null;
    for (const q of [0.85, 0.75, 0.65, 0.5]) {
      blob = await toBlob(canvas, q);
      if (blob && blob.size <= TARGET) break;
    }
    if (!blob || blob.size >= file.size) return file; // не стало менше — лишаємо оригінал
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return file;
  }
}

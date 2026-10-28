// Мінімальні типи archiver@5 (CJS-фабрика). @types/archiver v8 описує ESM-класи archiver@8 —
// не збігається з runtime 5.3.2, тож тримаємо власну декларацію лише того, що використовуємо.
declare module "archiver" {
  import type { Transform } from "node:stream";
  interface ArchiverEntryData { name: string; date?: Date }
  interface Archiver extends Transform {
    file(filepath: string, data: ArchiverEntryData): this;
    append(source: string | Buffer | NodeJS.ReadableStream, data: ArchiverEntryData): this;
    finalize(): Promise<void>;
    on(event: "warning" | "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  interface ArchiverOptions { zlib?: { level?: number }; store?: boolean }
  function archiver(format: "zip" | "tar", options?: ArchiverOptions): Archiver;
  export = archiver;
}

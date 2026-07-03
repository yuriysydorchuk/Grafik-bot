# Handoff: прямий аплоуд документів працівників

Дата: 2026-06-18 · Статус: **готово, не задеплоєно на прод**

Раніше документи працівника могли мати лише зовнішнє посилання (`fileUrl`). Тепер
адмін може **завантажити файл напряму** з веб-панелі. Файли зберігаються **на диску
VPS** (не в Google Drive, не в БД).

---

## Що зроблено

- Документ працівника тепер має або зовнішнє посилання (`fileUrl`, як було), **або**
  завантажений файл — джерела незалежні, можуть співіснувати.
- Файли лежать на диску в `uploads/worker-documents/` (корінь проєкту; env `UPLOADS_DIR`
  для перевизначення). **Не** через `express.static` — лише через авторизований ендпоінт,
  бо це персональні документи (паспорти тощо).
- Аплоуд через `multer` (memory storage, ліміт 15 МБ, whitelist: pdf / jpg / png / webp /
  heic / doc / docx).
- У БД зберігається лише метадата файлу (шлях, оригінальне імʼя, MIME) — не сам файл.

---

## Файли змінено

**Схема БД**
- `lib/db/src/schema/workers.ts` — у `workerDocumentsTable` додано `filePath`, `fileName`,
  `fileMime`. ALTER уже накатано на **локальну** БД (на прод — ще ні, див. нижче).

**Бекенд** (`artifacts/api-server/`)
- `src/lib/uploads.ts` — **новий**. `UPLOADS_ROOT` / `WORKER_DOCS_DIR`, `ensureUploadDirs()`,
  `makeStoredName()`, `deleteStoredFile()` (із захистом від path-traversal).
- `src/index.ts` — виклик `ensureUploadDirs()` при старті.
- `src/routes/admin-api.ts`:
  - конфіг `uploadDoc` (multer) біля `RW`;
  - `POST /worker-documents/:id/file` — завантажити/замінити файл (видаляє попередній);
    оригінальне імʼя декодується з latin1→utf8 (особливість multipart);
  - `GET /worker-documents/:id/file` — стрім файлу під `RW`-авторизацією,
    `Content-Disposition: inline; filename*=UTF-8''…`;
  - `DELETE /worker-documents/:id` — тепер ще й видаляє файл із диска.
- `package.json` + `pnpm-lock.yaml` — додано `multer` + `@types/multer`.

**Веб** (`artifacts/web/`)
- `src/lib/api.ts` — хелпер `upload(path, FormData)` (без JSON Content-Type, щоб браузер сам
  виставив multipart boundary); у типі `WorkerDocument` додано `fileName`.
- `src/pages/WorkerDetail.tsx` — у `DocModal` поле вибору файлу (показує поточне імʼя при
  заміні); зберігання двокрокове: спершу створити/оновити документ (JSON) → потім, якщо
  обрано файл, `POST …/file`. У рядку документа два посилання: «файл» (завантажений) і
  «посилання» (зовнішній URL).
- `src/lib/i18n.tsx` — 3 нові ключі з EN-перекладом («посилання», «Обрати файл…»,
  «Замінити: {name}»).

**Інфра**
- `.gitignore` — додано `uploads/`.
- `deploy/DEPLOY.md` — розділ про персистентність `uploads/` + приклад бекапу файлів (tar).

---

## Що потрібно знати наступній сесії

### Деплой на прод (ОБОВʼЯЗКОВО, ще не зроблено)
```bash
psql "$DATABASE_URL" -c "ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS file_path text, ADD COLUMN IF NOT EXISTS file_name text, ADD COLUMN IF NOT EXISTS file_mime text;"
pnpm install            # підтягне multer
bash deploy/build.sh    # (або build бекенду + веб окремо)
pm2 restart grafik-bot && pm2 save
```
Тека `uploads/` створюється автоматично при старті; переживає `git pull`. **Додай її в бекап** —
інакше файли втратяться при переустановці.

### Перевірено
- `pnpm run typecheck` ✅, build бекенду (multer бандлиться у `dist/index.mjs`) ✅, build веб ✅.
- **Локальний смоук через запуск сервера НЕ робили** — це підняло б другий polling-інстанс
  бота → `409 Conflict` з продом. Для ручного тесту потрібен окремий тестовий бот-токен.

### Передіснуючий, НЕ повʼязаний збій
- `pnpm --filter @workspace/api-server run test` падає в `src/bot/time.test.ts`
  (`factoryShiftStart(..,"1")` очікує `06:00`, отримує `13:30`). Це в некомічених файлах
  `bot/time.ts`/`time.test.ts`, які ця задача **не торкалася**. Розбиратися окремо.

### Можливі наступні кроки (не в обсязі)
- Завантаження документів самим працівником через бота.
- Антивірус-скан завантажених файлів.
- Прев'ю файлу в модалці замість окремої вкладки.

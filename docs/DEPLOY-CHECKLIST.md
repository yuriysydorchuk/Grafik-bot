# Чек-лист деплою

Кроки для викочування поточних змін на VPS. Повний гайд із нуля — [`deploy/DEPLOY.md`](../deploy/DEPLOY.md).

## Що в цьому релізі
- **Прямий аплоуд документів працівників** (файли на диск VPS) — [handoff](HANDOFF-worker-document-upload.md).
- **Редагування всіх даних працівника з профілю** — [handoff](HANDOFF-worker-profile-edit.md).

## Передумови (один раз)
- На сервері заповнений `.env` (не в git). Для аплоуду документів НЕ потрібні нові env-змінні
  (зберігання локальне). Опційно `UPLOADS_DIR` — якщо хочеш окремий шлях/volume для `uploads/`.
- Залежності: додано `multer` — `pnpm install` (через `build.sh`) підтягне з лок-файлу.

## Кроки деплою
```bash
cd ~/grafik-bot
git pull

# 1) Міграція БД (ОБОВʼЯЗКОВО — нові колонки для файлів документів)
psql "$DATABASE_URL" -c "ALTER TABLE worker_documents \
  ADD COLUMN IF NOT EXISTS file_path text, \
  ADD COLUMN IF NOT EXISTS file_name text, \
  ADD COLUMN IF NOT EXISTS file_mime text;"

# 2) Встановити залежності, зібрати, перезапустити (build.sh робить усе разом)
bash deploy/build.sh   # pnpm install --frozen-lockfile + build web + build api + typecheck + pm2 restart + pm2 save
```
> Редагування профілю міграції НЕ потребує — колонки `worker_code`, `language` вже існують.

## Після деплою — смоук-тест
- `pm2 logs grafik-bot` — старт без помилок; у логах має зʼявитись створення теки `uploads/`.
- Веб → працівник → **Документи**: завантажити файл, відкрити, замінити, видалити (файл зникає з диска).
- Веб → профіль працівника → **Редагувати**: змінити поля (зокрема код і мову) → зберегти.

## Бекап (нагадування)
Тека `uploads/` — поза git, переживає `git pull`, але **має бути в бекапі** (інакше файли
втратяться при переустановці). Приклад cron — у [`deploy/DEPLOY.md`](../deploy/DEPLOY.md) розділ
«Завантажені файли».

## Відоме / не блокує деплой
- `pnpm --filter @workspace/api-server run test` падає в `src/bot/time.test.ts`
  (legacy-шлях `factoryShiftStart`). `build.sh` тести **не ганяє**, тож деплой не блокується.
  Зачіпає лише фабрики на старих полях `shiftNStart` (без масиву `shifts`) — перевірити окремо.

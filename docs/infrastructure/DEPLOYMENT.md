# DEPLOYMENT — деплой і відкат

> Як викотити нову версію на прод. Опис середовища — [PRODUCTION.md](PRODUCTION.md).
> Деплой з нуля (свіжий сервер) — [`deploy/DEPLOY.md`](../../deploy/DEPLOY.md).

Сервер тягне код через `git pull` з `origin/main` (https://github.com/yuriysydorchuk/Grafik-bot).

---

## Звичайний деплой (оновлення)

```bash
ssh grafik                 # root@161.97.117.151 по ключу
cd /root/grafik-bot
git pull
# (за потреби) зміни схеми БД — вручну, див. DATABASE.md
bash deploy/build.sh
```

`deploy/build.sh` ([файл](../../deploy/build.sh)) робить усе по черзі:
1. `pnpm install --frozen-lockfile` (толерує `ERR_PNPM_IGNORED_BUILDS` від esbuild — це норма);
2. `pnpm --filter @workspace/web run build` → `artifacts/web/dist`;
3. `pnpm --filter @workspace/api-server run build` → `artifacts/api-server/dist/index.mjs` (esbuild);
4. typecheck api + web;
5. `pm2 start ecosystem.config.cjs --update-env || pm2 restart grafik-bot --update-env`;
6. `pm2 save`.

> Після `build.sh` процес уже перезапущений. Окремий `pm2 restart` не потрібен.

---

## Build-команди (за потреби окремо)

З кореня репо:
```bash
pnpm install --frozen-lockfile                  # залежності (лок-файл)
pnpm run typecheck                               # типи по всіх пакетах (libs → artifacts)
pnpm run typecheck:libs                          # лише lib/* (після зміни схеми БД)
pnpm --filter @workspace/web run build           # веб → artifacts/web/dist
pnpm --filter @workspace/api-server run build     # бекенд → dist/index.mjs
pnpm run build                                    # typecheck + збірка всіх пакетів
```
> Тільки **pnpm** (npm/yarn заблоковані `preinstall`-скриптом).

---

## Restart / керування процесом

```bash
pm2 restart grafik-bot --update-env   # перезапуск (підхопити зміни .env)
pm2 stop grafik-bot                    # зупинити
pm2 start grafik-bot                   # запустити
pm2 save                               # зберегти стан (щоб пережив ребут)
pm2 logs grafik-bot                    # логи (live)
```
Після зміни **тільки `.env`** (без коду): `pm2 restart grafik-bot --update-env`.

---

## Rollback (відкат)

Міграцій-файлів немає, тож відкат — це повернення коду + (за потреби) ручний відкат SQL.

**Код:**
```bash
cd /root/grafik-bot
git log --oneline -5            # знайти попередній робочий коміт <SHA>
git checkout <SHA>              # або: git reset --hard <SHA>
bash deploy/build.sh
```
Повернутись на гілку: `git checkout main`.

**Схема БД:** автоматичного відкату немає. Якщо реліз додавав колонки/таблиці — або лиши їх
(зворотно-сумісні), або відкоти вручну в `psql` (див. [DATABASE.md](DATABASE.md)). Перед ризикованими
змінами роби `pg_dump` (DATABASE.md → Backup).

**Завантажені файли:** `uploads/` не зачіпається `git`-операціями.

> TODO: тегувати релізи (`git tag`) для зручнішого відкату — наразі лише за SHA.

---

## Що перевірити після деплою

```bash
pm2 status                                              # grafik-bot = online, restarts не ростуть
pm2 logs grafik-bot --lines 30 --nostream               # "Server listening", "polling mode", без 404/409
curl -s -o /dev/null -w '%{http_code}\n' https://161.97.117.151.sslip.io/        # 200
curl -s https://161.97.117.151.sslip.io/api/healthz                              # health-відповідь
```
- **Веб:** відкрити https://161.97.117.151.sslip.io — сторінка входу, валідний 🔒.
- **Бот:** написати боту `/start` — має відповісти (немає `409`/`404` у логах).
- **Якщо змінювалась схема:** перевірити, що нові колонки/таблиці на місці (DATABASE.md).
- Деталі діагностики при проблемах — [RUNBOOK.md](RUNBOOK.md).

## Системні залежності на VPS

- **Chromium для Puppeteer** (генерація PDF-документів працівника: умови, регуляміни, świadectwo — `services/contracts.ts`, гілка worker-docs-signing). Пакет `puppeteer` сам не ставить браузер на сервері — потрібно один раз після `pnpm install`:
  ```bash
  # системні бібліотеки Chrome (Ubuntu 22.04/24.04)
  apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 fonts-liberation
  cd /root/grafik-bot && pnpm --filter @workspace/api-server exec puppeteer browsers install chrome
  ```
  Перевірка: `ls ~/.cache/puppeteer` (тека `chrome/…`). Без браузера генерація пакета падає з `Could not find Chrome`. Шрифт документів (Liberation Serif під іменем «Times New Roman») вшитий з `artifacts/api-server/assets/fonts` через `@font-face` — системний Times New Roman на сервері НЕ потрібен, рендер однаковий локально і на проді.
- **Печатки фірм для умов** (`services/contracts.ts finalizeContractSignature`): файли поза git —
  `/root/grafik-bot/uploads/company/stamp-<companyId>.png` (id фірм: 1 Klinex, 2 ES, 3 ESO), фолбек
  `COMPANY_STAMP_PNG` у `.env`. PNG 3:1 (бокс шаблону 210×70), печатка на весь бокс, підпис поверх.
  Оригінали й скрипти витяжки — у Yuriy (фото/PDF у ~/Downloads, 08.09.2026).
- **Порядок міграцій = алфавіт назв.** CI і `/deploy` накочують `deploy/migrations/*.sql` за `sort`;
  файл, що ALTER-ить/UPDATE-ить таблицю з «пізнішого» файла, падає на чистій/прод базі
  (10.09.2026: employers → worker_factories, doc-auto-request/lead-days → task_auto_rules; виправлено
  датою в назві). Перед деплоєм великого батчу — сухий прогін на копії прод-дампу
  (`pg_restore` у локальну БД → `psql -f` за алфавітом → 0 ERROR).
- **ghostscript** (`apt install -y ghostscript`) — стискання великих PDF-сканів умов/фактур (`lib/uploads.ts shrinkDocBuffer`, з 02.09.2026). Без нього аплоуд працює, але файли лишаються оригінального розміру (у логах warn `ghostscript not installed`). Перевірка: `gs --version`.

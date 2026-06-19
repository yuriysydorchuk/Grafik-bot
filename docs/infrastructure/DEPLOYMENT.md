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

---
name: deploy
description: Deploy Grafik-bot to the production VPS — verify locally (typecheck+tests+build), push main, pull on the server, apply pending SQL migrations, run deploy/build.sh, and smoke-check health/logs. Use when the user asks to deploy, викотити, задеплоїти, or push changes to prod.
---

# Deploy Grafik-bot to production

Прод: VPS `ssh grafik` (root@161.97.117.151), код у `/root/grafik-bot`, процес pm2 `grafik-bot`, HTTPS `https://161.97.117.151.sslip.io`. Джерело правди — `docs/infrastructure/DEPLOYMENT.md`; цей скіл — виконуваний конспект.

## Кроки

1. **Локальна перевірка** (не деплой зламаного):
   ```bash
   pnpm run typecheck
   pnpm --filter @workspace/api-server run test
   pnpm --filter @workspace/api-server run build
   ```
   Будь-який fail → зупинись і покажи помилку користувачу.

2. **Коміт + пуш `main`** — лише те, що стосується задачі. Сервер тягне з `origin/main`, тому без пушу деплоїти нічого. Формат комітів — див. git log; підпис `Co-Authored-By` як у CLAUDE.md-конвенції.

3. **Pull на сервері:**
   ```bash
   ssh grafik 'cd /root/grafik-bot && git pull && git log --oneline -1'
   ```

4. **Міграції (якщо у цьому деплої зʼявились нові файли в `deploy/migrations/`):**
   ```bash
   ssh grafik 'cd /root/grafik-bot && export $(grep -E "^DATABASE_URL=" .env) && psql "$DATABASE_URL" -f deploy/migrations/<файл>.sql'
   ```
   - Порядок: спершу SQL, потім рестарт коду, якщо код залежить від нових колонок/таблиць.
   - Файли з `CREATE INDEX CONCURRENTLY` **не можна** запускати під `psql -1` (однією транзакцією).
   - Схема в `lib/db/src/schema/workers.ts` і SQL мають бути синхронні (перевір, що зміни схеми вже закомічені).

5. **Збірка + рестарт** (build.sh сам робить install → build web+api → typecheck → pm2 restart + save):
   ```bash
   ssh grafik 'cd /root/grafik-bot && bash deploy/build.sh 2>&1 | tail -12'
   ```
   `ERR_PNPM_IGNORED_BUILDS` від esbuild — норма, не помилка.

6. **Пост-деплой смоук:**
   ```bash
   ssh grafik 'curl -s -m 10 https://161.97.117.151.sslip.io/api/healthz; echo; pm2 logs grafik-bot --lines 20 --nostream --raw 2>/dev/null | tail -10'
   ```
   Очікується `{"status":"ok","db":"ok","bot":"up"}` і логи без `level:50`-помилок (алерт «service started» після рестарту — норма). Якщо бот `down` або 409 — перевір, чи не запущений другий polling-інстанс на прод-токені.

7. **Звіт користувачу:** коміт, що поїхав; накачені міграції; healthz; помічені помилки в логах.

## Заборонено

- Деплоїти з червоним typecheck/тестами.
- Запускати локальний бот на прод-токені (409 Conflict у прод-бота).
- «Тестувати» на проді розсилки (`/hours/report-remind`, `/availability/remind`, notify-ендпойнти) — вони шлють живим людям.
- Rollback без потреби; якщо треба — процедура в `docs/infrastructure/DEPLOYMENT.md → Rollback`.

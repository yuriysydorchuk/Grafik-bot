# PRODUCTION — продакшн-середовище

> **Джерело правди по проду.** Тут — стан реального сервера. Покрокові процедури — у
> [DEPLOYMENT.md](DEPLOYMENT.md), [DATABASE.md](DATABASE.md), [RUNBOOK.md](RUNBOOK.md).
> Секрети сюди **не пишемо** — лише назви env-змінних.

Оновлено: 2026-06-19.

---

## Сервер

| | |
|---|---|
| Провайдер | Contabo — «Cloud VPS 20 NVMe» (Hub Europe) |
| Публічний IP | `161.97.117.151` |
| OS | Ubuntu 24.04.4 LTS |
| Ресурси | 6 vCPU · 11 GiB RAM · NVMe |
| Доступ | `ssh root@161.97.117.151` (по SSH-ключу; пароль — TODO: вимкнути, див. нижче) |

Зручний аліас у `~/.ssh/config` (локально): `ssh grafik`.

---

## Доступи та відповідальні

| | |
|---|---|
| SSH-доступ | **тільки власник** (Yuriy Sydorchuk), root по SSH-ключу. Інших ключів/користувачів немає |
| On-call / відповідальний | Yuriy Sydorchuk — email `yuriisydorchuk96@gmail.com`; Telegram **TODO** (вказати @handle); телефон **TODO** |
| GitHub | репо `yuriysydorchuk/Grafik-bot` (публічне), деплой тягне `origin/main` |

---

## Домени / SSL

| | |
|---|---|
| Поточний хост | `https://161.97.117.151.sslip.io` (sslip.io → резолвиться в IP) |
| TLS | Let's Encrypt, видає й оновлює **Caddy** автоматично |
| Реальний домен | **TODO** — планується пізніше. Після купівлі: A-запис `@` → IP, замінити блок у Caddyfile, оновити `WEB_PUBLIC_URL` |

---

## Розташування на сервері

| Що | Шлях |
|---|---|
| Код проєкту | `/root/grafik-bot` |
| `.env` (секрети, не в git) | `/root/grafik-bot/.env` |
| Зібраний бекенд | `/root/grafik-bot/artifacts/api-server/dist/index.mjs` |
| Зібрана веб-панель | `/root/grafik-bot/artifacts/web/dist` |
| Завантажені файли (документи) | `/root/grafik-bot/uploads/worker-documents` (поза git; бекап окремо) |
| Caddy config | `/etc/caddy/Caddyfile` |
| pm2 логи | `/root/.pm2/logs/grafik-bot-{out,error}.log` |

---

## Сервіси

Уся аппка — **один Node-процес** (Express API + статика веб-панелі + Telegraf-бот polling + node-cron),
плюс системні Postgres і Caddy.

| Сервіс | Менеджер | Призначення |
|---|---|---|
| `grafik-bot` | pm2 | API + веб + Telegram-бот + cron, слухає `localhost:8080` |
| `caddy` | systemd | реверс-проксі + HTTPS, `:80/:443` → `localhost:8080` |
| `postgresql` | systemd | база `grafik_bot` на `localhost:5432` |

### Версії (на момент розгортання)
Node v22.23.0 · pnpm 11.8.0 · PostgreSQL 16.14 · Caddy v2.11.4 · pm2 7.0.1.

### PM2-процес
- Ім'я: **`grafik-bot`** (конфіг: [`ecosystem.config.cjs`](../../ecosystem.config.cjs), `cwd` = корінь репо).
- Запуск: `node --env-file=./.env --enable-source-maps dist/index.mjs`, `NODE_ENV=production`.
- `autorestart: true`, `max_restarts: 30`, `restart_delay: 3000`.
- Автозапуск після ребуту: `pm2 startup systemd` (налаштовано) + `pm2 save`.

### Caddy / SSL
- `/etc/caddy/Caddyfile` (шаблон у репо — [`deploy/Caddyfile`](../../deploy/Caddyfile)):
  ```
  161.97.117.151.sslip.io {
      encode gzip
      reverse_proxy localhost:8080
  }
  ```
- Сертифікат — автоматичний Let's Encrypt; ручних дій з оновленням не треба.

### PostgreSQL
- База: `grafik_bot`, власник/юзер: `grafik`, хост: `localhost:5432` (назовні **не** відкрита).
- Деталі схеми/бекапів — [DATABASE.md](DATABASE.md).

### Брандмауер (ufw)
Активний. Відкрито: **OpenSSH (22)**, **80**, **443**. Порт **8080 закритий** назовні (лише Caddy локально).

---

## Env-змінні (лише назви; значення — в `/root/grafik-bot/.env`)

Шаблон: [`deploy/.env.example`](../../deploy/.env.example).

**Обовʼязкові:**
`PORT` · `DATABASE_URL` · `TELEGRAM_BOT_TOKEN` · `TELEGRAM_BOT_USERNAME` · `SESSION_SECRET` ·
`GOOGLE_SERVICE_ACCOUNT_JSON` · `GOOGLE_SHEETS_ID`

**Рекомендовані/опційні:**
`NODE_ENV` · `WEB_PUBLIC_URL` · `LOG_LEVEL` · `CORS_ORIGINS` · `WEB_DIST` · `UPLOADS_DIR` ·
`ADMIN_GOOGLE_EMAIL`

**Алерти (опційно, off за замовчуванням — див. [ALERTING.md](ALERTING.md)):**
`ALERTS_ENABLED` · `ALERT_TELEGRAM_CHAT_ID` · `ALERT_COOLDOWN_SECONDS`

**Google Drive (експорт графіків/звітів):**
`GOOGLE_OAUTH_CLIENT_ID` · `GOOGLE_OAUTH_CLIENT_SECRET` · `GOOGLE_OAUTH_REFRESH_TOKEN`
(службовий акаунт не має квоти Drive — аплоуд іде від імені OAuth-користувача; див.
[`artifacts/api-server/get-google-token.mjs`](../../artifacts/api-server/get-google-token.mjs))

**SMTP (надсилання графіку клієнту):**
`SMTP_HOST` · `SMTP_PORT` · `SMTP_USER` · `SMTP_PASS` · `SMTP_FROM`

---

## Ризики продакшну

- **Один процес = усе разом.** Падіння кладе API, веб і бота одночасно (рятує pm2 `autorestart`).
- **Бот — лише один polling-інстанс.** Два інстанси на одному токені → `409 Conflict`. Не запускати
  локальний бот на тому ж токені, що й прод. (Локальний/прод боти зараз **різні** — див. [HANDOFF-vps-deploy](../HANDOFF-vps-deploy.md).)
- **Міграції — SQL-файли в `deploy/migrations/`,** накатуються вручну (`psql`); схему й БД
  легко розсинхронити. `deploy/schema.sql` тримати актуальним (перегенеровувати після змін
  схеми — див. [DATABASE.md](DATABASE.md)).
- **`uploads/` поза git.** Не входить у `git pull` і в дамп БД — покривається окремим архівом
  у щоденному бекапі.
- **Бекапи app-рівня налаштовані** (з 2026-07-06): cron 03:00 → `deploy/backup.sh` →
  `/root/backups/` (дамп БД + `uploads/`, ротація 14 днів). TODO: offsite-копія дампів.
  Деталі — [DATABASE.md](DATABASE.md).
- **Безпека доступу.** Парольний root-SSH ще ввімкнений; root-пароль і старий бот-токен світилися
  в чаті — **TODO:** вимкнути `PasswordAuthentication`, змінити root-пароль, відкликати токен.
- **Моніторинг помилок** — Telegram-алерти (API/процес/бот/cron) + healthcheck; див. [ALERTING.md](ALERTING.md).
  За замовчуванням вимкнено (`ALERTS_ENABLED=false`). **TODO:** зовнішній uptime-монітор на
  `/api/healthz` для виявлення повного падіння процесу/сервера (самоалерт тоді не спрацює).
- **Sshlip.io тимчасовий.** Залежить від сервісу sslip.io; на постійку — власний домен.
- **Секрети.** `.env`, `GOOGLE_SERVICE_ACCOUNT_JSON`, SSH-ключі не комітити; `minimumReleaseAge`
  у `pnpm-workspace.yaml` не вимикати.

# Handoff: моніторинг помилок + Telegram-алерти

Дата: 2026-06-19 · Статус: **реалізовано, закомічено, задеплоєно, алерти УВІМКНЕНІ на проді**

Повна документація системи — [`docs/infrastructure/ALERTING.md`](infrastructure/ALERTING.md).

---

## Що зроблено

Система сповіщень про збої прода: короткі Telegram-повідомлення owner-у поверх pino-логів,
opt-in (`ALERTS_ENABLED=false` за замовчуванням), з антиспамом і строгою санітизацією.

- **Ядро** `lib/alerts.ts`: `sendAlert()` / `sendStartupAlert()` через **наявний бот** (лише вихідний
  `sendMessage` — без другого polling-інстансу). Best-effort (ніколи не кидає). Антиспам: per-error
  cooldown + дедуплікація (числа в message → `#`) + глобальний ліміт ~10/5хв. Санітайзер вирізає
  токени/БД-URL/довгі секрети, обрізає до ~300 символів. Адресат: `ALERT_TELEGRAM_CHAT_ID`, фолбек
  на `is_main` адміна (лінивий, не ламає старт).
- **API:** глобальний Express error-handler (останній у `app.ts`) → лог зі стеком + короткий алерт +
  `500 {error:"Internal server error"}` без деталей.
- **Процес:** `unhandledRejection` (лог+алерт, живе) і `uncaughtException` (лог+алерт→`exit(1)` для
  pm2-рестарту) в `index.ts`; **startup-алерт** після успішного старту.
- **Бот:** `bot.catch` — PII-safe (лише `updateType` + помилка, без тексту/імен/телефонів).
- **Cron:** алерти лише на job-level помилки (`weeklyReminder`, `preShiftCheck`, `pruneNotifications`);
  per-worker `catch {}` не чіпали (без спаму).
- **Healthcheck:** `GET /api/healthz` тепер `{status, db, bot, uptimeSec}` — `select 1` до БД
  (**503** якщо лежить), bot-статус best-effort (прапорець `isBotLaunched`, без зайвих Telegram-викликів),
  без секретів/стека.

---

## Файли змінено

Коміт **`d587cbb`** «feat: add production alerting and health checks» (у `origin/main`).

**Нові:**
- `artifacts/api-server/src/lib/alerts.ts`
- `docs/infrastructure/ALERTING.md`

**Змінені:**
- `artifacts/api-server/src/app.ts` — Express error-middleware
- `artifacts/api-server/src/index.ts` — process-handlers + startup-alert + `setBotLaunched`
- `artifacts/api-server/src/bot/index.ts` — `bot.catch`
- `artifacts/api-server/src/bot/instance.ts` — `isBotLaunched`/`setBotLaunched`
- `artifacts/api-server/src/routes/health.ts` — DB-check + bot-статус + 503
- `artifacts/api-server/src/services/scheduler.ts` — job-level cron-алерти
- `deploy/.env.example` — секція алертів
- `docs/infrastructure/PRODUCTION.md`, `docs/infrastructure/RUNBOOK.md` — згадки/розділ «Алерти»

---

## Нові env-змінні
| Змінна | Дефолт | |
|---|---|---|
| `ALERTS_ENABLED` | `false` | `true` вмикає надсилання |
| `ALERT_TELEGRAM_CHAT_ID` | — | одержувач; порожнє → фолбек на `is_main` |
| `ALERT_COOLDOWN_SECONDS` | `300` | per-error cooldown |

---

## Стан на проді (що потрібно знати)

- Задеплоєно: `git pull` → `d587cbb`, `bash deploy/build.sh` (exit 0), pm2 `grafik-bot` online.
- **Алерти УВІМКНЕНІ:** на сервері в `/root/grafik-bot/.env` виставлено
  `ALERTS_ENABLED=true`, `ALERT_TELEGRAM_CHAT_ID=789739764` (chat_id owner-а, не секрет),
  `ALERT_COOLDOWN_SECONDS=300`. Після рестарту startup-алерт спрацював, помилок надсилання в логах
  немає. `/api/healthz` → `{"status":"ok","db":"ok","bot":"up",...}` (200).
- chat_id дістали через бот-команду **`/getid`** (для приватного чату chat_id = user id).
- Вимкнути: `ALERTS_ENABLED=false` → `pm2 restart grafik-bot --update-env`.
- Діагностика логів: `pm2 logs grafik-bot | grep alert` (алерт-події логуються навіть коли вимкнено).

### Обмеження / TODO
- **Самоалерт не спрацює, якщо ляже весь процес/сервер** (нікому слати). Потрібен **зовнішній
  uptime-монітор** на `https://161.97.117.151.sslip.io/api/healthz` (UptimeRobot/healthchecks.io) —
  **TODO власника**, поза кодом. Інструкція в [ALERTING.md](infrastructure/ALERTING.md).
- bot-статус у healthz — best-effort прапорець (true після `bot.launch()`, false якщо launch впав);
  не гарантує, що polling реально живий цю секунду.
- Антиспам-стан у пам'яті процесу — скидається при рестарті (очікувано).

### Не зламати
- Один polling-інстанс бота — алерти лише вихідні `sendMessage`, **не** додавати другий `bot.launch()`.
- У `bot.catch` і будь-яких алертах **не** додавати текст повідомлень/імена/телефони (PII).
- healthz — публічний; **не** повертати стек/секрети/внутрішні тексти помилок БД.

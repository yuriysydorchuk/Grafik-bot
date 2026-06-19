# RUNBOOK — операційні процедури

> Швидкі команди для перевірки стану й типові інциденти. Середовище — [PRODUCTION.md](PRODUCTION.md).
> Вхід: `ssh grafik` (= `root@161.97.117.151` по ключу).
> **On-call:** Yuriy Sydorchuk (`yuriisydorchuk96@gmail.com`) — єдиний відповідальний; контакти/доступи у [PRODUCTION.md](PRODUCTION.md#доступи-та-відповідальні).

Скорочення нижче: `URL = https://161.97.117.151.sslip.io`.

---

## Швидка перевірка стану (health-check)

```bash
ssh grafik
pm2 status                                              # grafik-bot online?
systemctl is-active caddy postgresql                    # active active
curl -s -o /dev/null -w '%{http_code}\n' https://161.97.117.151.sslip.io/         # 200
curl -s https://161.97.117.151.sslip.io/api/healthz                               # {status,db,bot,uptimeSec}; 503 якщо БД лежить
```

---

## PM2 (застосунок: API + веб + бот + cron)

```bash
pm2 status                       # стан, аптайм, к-сть рестартів
pm2 logs grafik-bot              # логи live
pm2 logs grafik-bot --lines 50 --nostream   # останні 50 рядків
pm2 restart grafik-bot --update-env          # перезапуск (з підхопленням .env)
pm2 stop grafik-bot / pm2 start grafik-bot
pm2 describe grafik-bot          # деталі процесу
pm2 save                         # зберегти стан після змін
```
Логи на диску: `/root/.pm2/logs/grafik-bot-out.log`, `…-error.log`.

## Caddy (HTTPS / реверс-проксі)

```bash
systemctl status caddy
systemctl reload caddy           # перечитати /etc/caddy/Caddyfile (без даунтайму)
systemctl restart caddy
journalctl -u caddy -n 50 --no-pager     # логи Caddy (вкл. видачу сертифікатів)
```

## PostgreSQL

```bash
systemctl status postgresql
psql "$(grep ^DATABASE_URL= /root/grafik-bot/.env | cut -d= -f2-) " -c "select 1"   # конект ок?
psql "$(grep ^DATABASE_URL= /root/grafik-bot/.env | cut -d= -f2-)" -tAc "select count(*) from pg_tables where schemaname='public'"   # ~26
```

## API health

```bash
curl -s https://161.97.117.151.sslip.io/api/healthz       # через Caddy (HTTPS)
curl -s http://localhost:8080/api/healthz                 # напряму на сервері (повз Caddy)
```

## Бот (Telegram)

- У логах при старті має бути `Telegram bot started in polling mode`, **без** `404`/`409`.
  ```bash
  pm2 logs grafik-bot --lines 50 --nostream | grep -Ei "polling|409|404|getMe|telegram"
  ```
- Перевірити токен/username бота (без витоку секрета — лише getMe з самого сервера):
  ```bash
  TOK=$(grep ^TELEGRAM_BOT_TOKEN= /root/grafik-bot/.env | cut -d= -f2-)
  curl -s "https://api.telegram.org/bot$TOK/getMe"     # {"ok":true,...,"username":...}
  ```
- Живий тест: написати боту `/start` у Telegram.

---

## Інцидент: бот не відповідає

1. `pm2 status` — якщо `stopped`/`errored`: `pm2 restart grafik-bot --update-env`, потім логи.
2. У логах `409 Conflict` → десь **другий polling-інстанс** на тому ж токені (локальний запуск
   або дубль). Зупинити зайвий; на проді має бути рівно один `grafik-bot`.
3. У логах `404 Not Found` на `getMe` → невірний/порожній `TELEGRAM_BOT_TOKEN`. Перевірити getMe
   (вище), виправити `.env`, `pm2 restart grafik-bot --update-env`.
4. Бот живий, але комусь не пише → користувач не натиснув `/start` у **цьому** боті (бот не може
   ініціювати чат). Дати правильне invite-посилання (воно з `TELEGRAM_BOT_USERNAME`).
5. Перевірити, що процес не крешить у циклі (`pm2 status` → `restarts` швидко росте) → дивитись
   `…-error.log` (часто БД/`.env`).

## Інцидент: сайт не відкривається

1. `curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/` на сервері:
   - **не 200 / немає відповіді** → проблема в застосунку: `pm2 status` + логи, за потреби рестарт.
   - **200 локально, але ззовні ні** → проблема в Caddy/мережі (нижче).
2. Caddy: `systemctl status caddy`; `journalctl -u caddy -n 50` (помилки сертифіката/проксі);
   `systemctl reload caddy`.
3. TLS/сертифікат: перевірити, що хост у `/etc/caddy/Caddyfile` правильний і резолвиться в IP.
   ```bash
   echo | openssl s_client -connect 161.97.117.151.sslip.io:443 -servername 161.97.117.151.sslip.io 2>/dev/null | openssl x509 -noout -issuer -dates
   ```
4. Брандмауер: `ufw status` — мають бути відкриті 80/443.
5. `502 Bad Gateway` від Caddy → застосунок лежить на `:8080` (див. п.1, pm2).

## Інцидент: БД недоступна

1. `systemctl status postgresql`; якщо лежить — `systemctl restart postgresql`.
2. Конект-тест (вище). У логах застосунку — `ECONN`/`password authentication failed` → перевірити
   `DATABASE_URL` у `.env` (юзер/пароль/база) vs реальний стан Postgres.
3. Місце на диску: `df -h` (повний диск кладе і Postgres, і логи). Почистити старі pm2-логи/бекапи.
4. Після відновлення БД — `pm2 restart grafik-bot`.
5. Якщо дані пошкоджені — відновити з дампа (див. [DATABASE.md](DATABASE.md) → restore).

---

## Алерти (моніторинг помилок)

Прод шле короткі Telegram-алерти на помилки API/процесу/бота/cron. Повний опис, формат, антиспам
і налаштування — [ALERTING.md](ALERTING.md).

- **Стан:** алерти активні, якщо в `.env` `ALERTS_ENABLED=true` і задано `ALERT_TELEGRAM_CHAT_ID`
  (інакше — лише логування).
- **Заглушити:** `ALERTS_ENABLED=false` → `pm2 restart grafik-bot --update-env`.
- **Алерт прийшов — що робити:** дивись поле `service` (api/process/bot/cron) → відповідний плейбук вище;
  деталі помилки — `pm2 logs grafik-bot | grep alert`.
- **Тиша при явному збої?** Перевір `ALERTS_ENABLED`, `ALERT_TELEGRAM_CHAT_ID`, і що ти натискав
  `/start` боту-одержувачу. Якщо ліг **увесь** процес/сервер — самоалерт не надійде (потрібен
  зовнішній uptime-монітор на `/api/healthz`, див. ALERTING.md).

## Корисне

```bash
df -h                       # місце на диску
free -h                     # пам'ять
journalctl -p err -n 50 --no-pager   # системні помилки
```
Кожен значущий інцидент — фіксувати в [INCIDENTS.md](INCIDENTS.md).

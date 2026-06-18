# Grafik-bot — деплой на сервер + домен

Покроковий гайд для новачка. Рекомендований стек (найпростіший + надійний):

- **Сервер:** VPS на **Ubuntu 24.04 LTS**
- **Реверс-проксі + HTTPS:** **Caddy** (сам отримує й оновлює сертифікат)
- **База:** **PostgreSQL** локально на тому ж сервері
- **Процес:** **pm2** (тримає бота живим, автозапуск після перезавантаження)
- **Telegram:** режим polling — нічого «прокидати» ззовні не треба

---

## 0. Що купити

**Сервер (VPS):**
- **Hetzner Cloud** — найкраща ціна/якість, дата-центри в ЄС (близько до Польщі). Тариф **CX22** (2 vCPU / 4 ГБ) ~€4–5/міс — з запасом. → https://www.hetzner.com/cloud
- Альтернативи: DigitalOcean (простіший інтерфейс, дорожче), Contabo (дешево).
- Бери Ubuntu 24.04, додай свій SSH-ключ при створенні.

**Домен:**
- **Cloudflare** або **Porkbun** — найдешевше. **Namecheap** — популярний.
- Після купівлі: у DNS додай **A-запис** `@` → IP твого сервера (і за бажанням `www` → той самий IP).

> Орієнтовний бюджет: ~€5/міс сервер + ~€10/рік домен.

---

## 1. Підключення до сервера

```bash
ssh root@ВАШ_IP
```

Створи звичайного користувача (необов'язково, але правильно):
```bash
adduser grafik && usermod -aG sudo grafik
su - grafik
```

## 2. Встановити Node 22, pnpm, PostgreSQL, Caddy, pm2

```bash
# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo corepack enable && corepack prepare pnpm@latest --activate

# PostgreSQL
sudo apt-get install -y postgresql

# Caddy (реверс-проксі з авто-HTTPS)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# pm2
sudo npm install -g pm2
```

## 3. База даних

```bash
sudo -u postgres psql <<'SQL'
CREATE USER grafik WITH PASSWORD 'ПРИДУМАЙ_ПАРОЛЬ';
CREATE DATABASE grafik_bot OWNER grafik;
SQL
```

Залий схему (файл у репозиторії — `deploy/schema.sql`):
```bash
# (після клонування репо, крок 4) з кореня проєкту:
psql "postgresql://grafik:ПРИДУМАЙ_ПАРОЛЬ@localhost:5432/grafik_bot" -f deploy/schema.sql
```

## 4. Код і налаштування

```bash
cd ~
git clone ВАШ_РЕПОЗИТОРІЙ grafik-bot   # або завантаж архів
cd grafik-bot

cp deploy/.env.example .env
nano .env        # заповни: DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME,
                 #          SESSION_SECRET (openssl rand -hex 32), WEB_PUBLIC_URL=https://твій-домен
```

Залий схему БД (якщо ще ні — див. крок 3), тоді збери й запусти:
```bash
bash deploy/build.sh
```
Це: встановить залежності, збере панель і бота, перевірить типи, запустить під pm2.

Автозапуск після перезавантаження сервера:
```bash
pm2 startup    # виконай команду, яку він підкаже (з sudo)
pm2 save
```

## 5. HTTPS (Caddy)

### Варіант А — БЕЗ домену (безкоштовно, через sslip.io) ← ми йдемо цим
`sslip.io` дає хостнейм виду `IP.sslip.io`, який вказує на твій IP. Caddy видасть на нього справжній HTTPS-сертифікат безкоштовно.

```bash
sudo nano /etc/caddy/Caddyfile
```
Встав (заміни `1.2.3.4` на **реальний IP** сервера):
```
1.2.3.4.sslip.io {
    encode gzip
    reverse_proxy localhost:8080
}
```
```bash
sudo systemctl reload caddy
```
У `.env` постав `WEB_PUBLIC_URL=https://1.2.3.4.sslip.io` (теж із реальним IP) і перезапусти бота (`pm2 restart grafik-bot`).
Відкрий `https://1.2.3.4.sslip.io` — має з'явитися сторінка входу з валідним 🔒.

### Варіант Б — коли купиш домен
Заміни блок у Caddyfile на `твій-домен.com { ... }`, додай DNS A-запис домену → IP сервера, онови `WEB_PUBLIC_URL`, і `sudo systemctl reload caddy`.

## 6. Перший вхід (головний адмін)

1. У Telegram напиши своєму боту `/start`, потім `/adminsetup` — ти станеш **головним адміністратором** (owner, is_main).
2. Натисни «🔐 Мій веб-доступ» у боті → задай логін і пароль.
3. На сайті увійди логіном/паролем → бот надішле 6-значний **код 2FA** → введи його.
4. Далі додавай фабрики, працівників, водіїв; запрошуй користувачів і признач ролі (це може лише головний адмін).

> 2FA обов'язкова й коди йдуть через бота — **бот має бути запущений**, щоб хтось міг увійти в панель.

---

## Оновлення (нова версія коду)

```bash
cd ~/grafik-bot
git pull
bash deploy/build.sh
```
Якщо змінювалась схема БД — застосуй відповідні `ALTER TABLE` вручну через `psql` (міграції в цьому проєкті — ручні).

## Брандмауер (рекомендовано)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```
Порт **8080 НЕ відкривай** назовні — до нього ходить лише Caddy локально. PostgreSQL теж лишається лише на localhost (за замовчуванням).

## Завантажені файли (документи працівників)

Файли, завантажені через веб-панель (документи працівників), зберігаються **на диску** в теці `uploads/` у корені проєкту (`~/grafik-bot/uploads/`). Вона:
- **не в git** (`.gitignore`) і не зачіпається `git pull` — переживає оновлення коду;
- має бути в бекапі (нижче) — інакше файли втратяться при переустановці;
- шлях можна змінити env-змінною `UPLOADS_DIR` (напр. для окремого диска/volume).

## Бекап бази (раз на день)

```bash
# простий приклад через cron (база + завантажені файли):
( crontab -l 2>/dev/null; echo '0 3 * * * pg_dump "postgresql://grafik:ПАРОЛЬ@localhost:5432/grafik_bot" | gzip > ~/backup-grafik-$(date +\%F).sql.gz' ) | crontab -
( crontab -l 2>/dev/null; echo '5 3 * * * tar czf ~/backup-uploads-$(date +\%F).tar.gz -C ~/grafik-bot uploads' ) | crontab -
```

## Корисні команди

```bash
pm2 logs grafik-bot      # логи
pm2 restart grafik-bot   # перезапуск
pm2 status               # стан
sudo systemctl reload caddy   # перечитати Caddyfile
```

## Інтеграції (необов'язково)
- **Google Drive** (експорт графіків/звітів) — заповни `GOOGLE_OAUTH_*` у `.env` (як у `get-google-token.mjs`). Без них панель і бот працюють, лише експорт у Drive вимкнено.
- **SMTP** — заповни `SMTP_*`, щоб надсилати графік клієнтам на email.

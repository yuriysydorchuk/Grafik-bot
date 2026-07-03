# Handoff: фікси бота при онбордингу людей (telegram_id + Markdown)

Дата: 2026-06-22 · Статус: **реалізовано, закомічено (`e70f3ea`), запушено, задеплоєно й перевірено**

Дві прод-помилки, що випливли **через алертинг** після того, як почали додавати реальних людей.

---

## Що зроблено

**№1 — UNIQUE-конфлікт `telegram_id` (DB-краш у `bot.catch`)**
`workers.telegram_id` / `drivers.telegram_id` — `unique()`. Прив'язка Telegram ставила id, не
перевіривши, чи він уже зайнятий іншим записом → `Failed query: update "workers" set "telegram_id"…`.
- Додано хелпери `tgTakenByWorker(tid, exceptId)` / `tgTakenByDriver(...)` у `bot/index.ts`.
- Guard **перед усіма** незахищеними `set telegram_id`: driver-invite (deep-link), worker-by-code
  (deep-link), admin «Прив'язати Telegram» (працівник і водій). Якщо id зайнятий іншим → дружнє
  повідомлення, **update не виконується**, помилки немає.
- Уже мали guard (не чіпав): самореєстрація на фабрику, кандидат-реферал, admin-invite.
- **Перепривʼязку (зміну власника id) НЕ реалізовано** — свідомо, на потім (owner-driven).

**№2 — `400: can't parse entities` (Markdown)**
Ім'я зі спецсимволами `* _ \`` ламало `parse_mode:"Markdown"`. Legacy Markdown екранування не має.
- **A (глобально):** у `bot/instance.ts` обгорнуто `bot.telegram.sendMessage` — на цій помилці
  **повторна** відправка без `parse_mode` (звичайний текст). Покриває й `ctx.reply`. Дубля при
  успіху немає (retry лише після реальної невдачі).
- **B (точково):** хелпер `mdSafe()` у `bot/display.ts` (вирізає `* _ \` [ ]`), застосований до
  `fullName/name/factory` у ключових повідомленнях реєстрації/прив'язки людей.

Бізнес-логіку не змінювали; один polling-інстанс; PII в логах/алертах не додавали.

**Доповнення (коміт `ad62646`):** перша версія fallback (A) обгортала лише `sendMessage`, тож
помилка `can't parse entities` з **іншого** методу (напр. `editMessageText` при редагуванні
inline-клавіатури) все одно йшла в `bot.catch` і давала алерт. Перенесено fallback на
**`bot.telegram.callApi`** — єдину точку, через яку проходять **усі** методи Telegram
(sendMessage, editMessageText, sendPhoto-caption…) і `ctx.reply`/edits. Тепер будь-який метод із
зламаним `parse_mode` повторюється без форматування; payload без `parse_mode` (getUpdates тощо) не
зачіпається. Задеплоєно, healthz `ok`, врапер у білді присутній.

---

## Файли змінено
Коміт **`e70f3ea`** «fix: guard telegram_id linking and harden Markdown sends in bot» (у `origin/main`):
- `artifacts/api-server/src/bot/index.ts` — guard-хелпери + 4 guard'и + `mdSafe` у повідомленнях
- `artifacts/api-server/src/bot/instance.ts` — A: safe `sendMessage` fallback
- `artifacts/api-server/src/bot/display.ts` — B: `mdSafe()` helper

---

## Деплой / перевірка
- `git pull` → `e70f3ea` (сервер, робоче дерево чисте), `bash deploy/build.sh` (exit 0), pm2 online.
- `/api/healthz` → `{"status":"ok","db":"ok","bot":"up"}`; логи без `409`/`404`/`Failed query`/`parse entities`.

## Що знати наступній сесії
- **Поведінка тепер:** повторна прив'язка зайнятого Telegram → дружнє повідомлення (не краш);
  ім'я зі спецсимволами → у ключових місцях очищається (B), решта — гарантовано доходить як текст (A).
- **Глобальний fallback (A)** обгорнутий на рівні `callApi`, тож ловить «can't parse entities» для
  **усіх** методів (sendMessage, editMessageText, sendPhoto-caption, `ctx.reply`/edits) — якщо десь
  забули `mdSafe`, повідомлення все одно піде без форматування (коміт `ad62646`).
- **Не зроблено (бэклог):** owner-driven **перепривʼязка** Telegram до іншого працівника (зараз лише
  блокується). Якщо знадобиться — окрема фіча (адмін підтверджує перенесення id).
- Алертинг працює — нові класи помилок одразу видно в Telegram (`ALERTS_ENABLED=true` на проді).

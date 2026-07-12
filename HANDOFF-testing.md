# HANDOFF — тестова інфраструктура (2026-07-12)

Тимчасова записка сесії. Довговічне вже рознесено: команди тестів → `CLAUDE.md` (розділ «Тести»);
цей файл — що зробила сесія + що далі. Усе задеплоєно на прод (коміти `2987cf3`, `269412e`, `fd50630`).

## Контекст

Сесія почалась із defensive security review (див. `HANDOFF-security-review.md`), далі —
аналіз покриття тестами й нарощування. **Покриття: 63 → 125 тестів; загальне 38.6% → 43.3% рядків.**
Заміряно `node --test --experimental-test-coverage`: до робіт ефективне покриття бекенду було ~10%
(тести чіпали лише ~21% рядків, усередині них 49%), зміщене у бік фінансових парсерів.

## Що додано

**Крок 1 — чисті юніти (без БД):**
- `lib/dates.ts` — винесено `entryDateStr`/`weekFromForMonth`/`addDaysStr` з `admin-api.ts`
  (поведінка незмінна) + `lib/dates.test.ts` (межі місяця/року, null-день).
- `lib/auth.primitives.test.ts` — `createToken`/`verifyToken` (підпис/tamper/expiry),
  `hashPassword`/`verifyPassword`. Побіжно закрито латентний вакуумний матч у `verifyPassword`
  (порожній hex-hash тепер відхиляється; реальних логінів не зачіпає).

**Крок 2 — інтеграційний харнес (supertest + реальний Postgres):**
- `src/test/env.ts` + `src/test/harness.ts` — **opt-in через `TEST_DATABASE_URL`**. Форсує
  `DATABASE_URL = TEST_DATABASE_URL` (env.ts імпортується першим, до `@workspace/db`),
  `resetDb()` труакує лише БД зі словом *test* у назві (захист дев-даних), `seedAdmin`/`seedRole`
  видають підписану сесію-cookie. Без `TEST_DATABASE_URL` інтеграційні тести **самі скіпаються**.
- `routes/security.integration.test.ts` (7) — 401 без сесії, CSRF 403 без заголовка,
  driver-invite гейт (F1), finance owner-only, ревокація сесії через `token_version`.
- `services/scheduleGenerator.integration.test.ts` (6) — availability+shortage,
  position/gender requirement, цілоденна відсутність, no-double-book, `'all'`-режим (fixedShift).
  Далеке-майбутнє `weekStart` знімає залежність від `nowWarsaw()` (slot-lock завжди false).
- `services/bankClassify.integration.test.ts` (8) — реальна Postgres-семантика регексів:
  income vs internal, owner-виплата vs card-fee, cash (стем BANKOMA) vs комісія, кредит-рахунок,
  first-match категорій (ORLEN=fuel), `\y`-межа (ULAN ≠ ULANOWSKI), manual override, salary.

**Крок 3 — auth-флоу + операційне ядро (пізніше в сесії):**
- `lib/clientInfo.test.ts` (pure) — `parseDevice` + `isPrivateIp` (SSRF-гейт; `isPrivateIp` експортовано). 24.6%→77%.
- `routes/auth.integration.test.ts` — повний логін→2FA→сесія→`/me` (Telegram-код через стаб
  `bot.telegram.sendMessage`), bad_password/no_telegram/bad_2fa, logout-ревокація, звірка `login_events`. auth.ts 33%→88%.
- `routes/workers.integration.test.ts` — фін-поля пишуться лише під `viewFinance` (mass-assignment guard), editData-гейт, CSRF.
- `routes/admin-operational.integration.test.ts` — PUT /orders (сітка/заміна/сума breakdown),
  PATCH schedule/entry status, absence approve (пошиftна/цілоденна → entry absent) / reject.

**CI** (`.github/workflows/ci.yml`): job `check` (юніти, без БД) + новий job `integration`
з Postgres-17 сервісом (вантажить `schema.sql` + усі міграції, ганяє тести з `TEST_DATABASE_URL`).

**Серіалізація:** тест-скрипт має `--test-concurrency=1` — паралельні файли ділили одну БД і
`TRUNCATE ... CASCADE` давав deadlock. Суїт ~2с, вартість серіалізації нехтовна.

## Знайдено тестами (реальний баг)

`deploy/schema.sql` (снапшот Jul-3) мав `absence_requests.shift NOT NULL`, тоді як **жива БД**
і код трактують `NULL` як «вихідний на цілий день» (`scheduleGenerator`). Fresh-deploy/CI зі
schema.sql **ламав би цілоденні відсутності**. Фікс — міграція `2026-07-12-absence-shift-nullable.sql`
(`ALTER … DROP NOT NULL`; на проді no-op — уже nullable). Повний дифф nullability dev↔schema
показав: це **єдина** розбіжність (492 колонки збігаються).
> ⚠️ Залишок: сам `schema.sql` як снапшот усе ще стале на цій колонці — міграція вирівнює
> fresh-load, але при наступному повному ре-дампі `schema.sql` варто перегенерувати.

## Як ганяти

```bash
# юніти (без БД) — інтеграційні самі скіпаються
pnpm --filter @workspace/api-server run test
# з інтеграційними: одноразова БД (НЕ дев-база!)
createdb grafik_bot_test && psql -d grafik_bot_test -f deploy/schema.sql && \
  for m in deploy/migrations/*.sql; do psql -d grafik_bot_test -f "$m"; done
TEST_DATABASE_URL=postgres://localhost/grafik_bot_test pnpm --filter @workspace/api-server run test
```
Стан: 125 тестів — з `TEST_DATABASE_URL` усі 125 pass; без нього 88 pass + 37 skip.

## Що далі (кандидати на тому ж харнесі)

Найбільший непокритий обсяг: `bot/index.ts` (~4600), великі роути `admin-api.ts`, `notify.ts`,
`scheduler.ts`. Route-тести робляться так само, як `security.integration` (seed + supertest).
Бот-флоу складніший (Telegraf-контексти) — окрема оцінка перед роботою. `--experimental-test-coverage`
у CI поки не увімкнено (5-хв додача, якщо хочемо тримати цифру на очах).

## Гілки

Злиті в `main`, можна видаляти: `security-hardening-idor-csrf`, `tests-step1-2-integration`,
`tests-schedule-bank-integration`.

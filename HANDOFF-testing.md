# HANDOFF — тестова інфраструктура (2026-07-12)

Тимчасова записка сесії. Довговічне вже рознесено: команди тестів → `CLAUDE.md` (розділ «Тести»);
цей файл — що зробила сесія + що далі. Усе задеплоєно на прод (коміти `2987cf3`, `269412e`, `fd50630`).

## Контекст

Сесія почалась із defensive security review (див. `HANDOFF-security-review.md`), далі —
аналіз покриття тестами й нарощування. **Покриття: 63 → 178 тестів; загальне ~51% рядків.**
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

**Крок 4 — admins/roles + money-endpoints:**
- `routes/admins-roles.integration.test.ts` — POST/PATCH/DELETE /admins під `requireMainAdmin`
  (owner-не-main→403, головного не демоутнути/видалити, reset-web бампає token_version),
  roles CRUD (фільтр невідомих caps/pages, owner незмінний, system/in-use не видалити).
- `routes/finance.integration.test.ts` — pnl viewFinance-гейт + валідація entries;
  /bank/transactions bucket/місяць/`cat:` (роут коректно вплітає BUCKET/catCondition).

**Знайдено тестом (2-й баг сесії):** `DELETE /admins/:id` падав 500 для будь-кого, хто
входив (FK `admin_sessions`/`login_events`) чи вів рекрутинг — головний адмін не міг
видалити звільненого. Виправлено в хендлері: транзакційний cleanup (сесії delete,
аудит/рекрутинг-посилання SET NULL, далі delete). Без міграції.

**Крок 5 — довідникові CRUD:**
- `routes/reference-data.integration.test.ts` — companies/positions/document-types (RW) з
  in-use-гардами на delete; drivers (crypto-invite, soft-delete, промоут head-driver лише
  головним адміном + демоут попереднього); vehicles (plate upper-case, soft-delete); capability-гейти.

**Крок 6 — аванси + файли документів:**
- `routes/advances.integration.test.ts` — approve/reject/paid (paid лише після approved), editData-гейт.
- `routes/worker-documents.integration.test.ts` — metadata + upload/download: реальний PNG приймається,
  HTML під виглядом `.pdf` ВІДХИЛЯЄТЬСЯ (magic-byte — security Finding 2 наскрізь), download з `nosniff`.
  `env.ts` ставить `UPLOADS_DIR=/tmp/grafik-test-uploads` (файли тестів поза репо).

**Крок 7 — рекрутинг-CRM:**
- `routes/recruitment.integration.test.ts` — funnels (задані/дефолтні стадії, in-use delete-гард);
  candidates (create → перша стадія + activity, валідація переходу стадії, convert→worker+hired з
  блоком повторного, bonus paid → прапорець + activity); editData-гейт.

**Крок 8 — бот-флоу (найбільша темна зона):**
- `src/test/botHarness.ts` — ганяє РЕАЛЬНІ Telegraf-хендлери через `bot.handleUpdate(fakeUpdate)`
  проти тестової БД. **Вихідні Telegram-виклики перехоплюються на ПРОТОТИПІ `Telegram.callApi`**
  (Telegraf будує per-update telegram-instance, тож instance-стаб недостатній — це був головний
  підводний камінь). Хелпери: `sendStart`/`sendText`/`pressButton`, `sent`/`sentText`. Нуль правок у проді.
- `bot/deeplink.integration.test.ts` (7) — emp/drv/adm bind, гарди (вже-використано, зайнятий TG,
  невідомий код), fac self-signup (кирилиця відхиляється, латиниця створює працівника — ганяє start + on(text)+state).
- `bot/roles.integration.test.ts` (4) — `getAdmin` виключає веб-роль 'driver', `getWorker`/`getDriver` лише active.
- `bot/driver-boarding.integration.test.ts` (3) — посадка `brd:ok`: боарднутий → present+pickedUpBy,
  заміна → замінений absent «заміна», no-op без стану. Стан `boarding` засівається напряму
  (обхід час-гейтованого білдера); `boardDate` у майбутньому вимикає wall-clock auto-absent пас.
- `bot/absence-office.integration.test.ts` (4) — `absence_approve` (пошиftна/цілоденна → entry absent),
  `absence_reject` (rejected, entry scheduled), невідомий id без падіння.

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
Стан: 178 тестів — з `TEST_DATABASE_URL` усі 178 pass; без нього 88 pass + 90 skip.

## Що далі (кандидати на тому ж харнесі)

Бот-флоу тепер має вхід (`botHarness.ts`) — далі варто розширити на водійський pickup-флоу,
реєстрацію/відсутності працівника, офісні дії. `notify.ts`/`scheduler.ts` — сповіщення/cron
(потребують стабу часу + перехоплення `sent`, той самий харнес). Route-тести admin-api ще мають
запас (аналітичні GET-и dashboard/hours/reliability). Money-math у глибину (акруал/звірка/P&L)
— окремий високоцінний напрям. `--experimental-test-coverage` у CI поки не увімкнено (5-хв додача).

## Гілки

Злиті в `main`, можна видаляти: `security-hardening-idor-csrf`, `tests-step1-2-integration`,
`tests-schedule-bank-integration`.

# HANDOFF — self-transport працівники (доїжджають самі)

**Сесія:** 2026-07-06 · **Статус:** ✅ задеплоєно на прод (commit `61e3d76`)

---

## Проблема

Частина працівників доїжджає на роботу самостійно. Водії їх не возять, але вони
потрапляли у водійський флоу:

1. При «Підтвердити посадку» всі незабрані `scheduled`-явки автоматично ставали
   `absent` → self-transport працівнику летіло «чому не вийшов», у графіку світилась
   фейкова відсутність.
2. Водіям у нагадуваннях / на дошці показувалась **більша** кількість людей до
   забрання, ніж реально треба возити.

## Рішення

Прапорець **`workers.self_transport`** (профіль працівника). Такі люди:
- **не показуються водієві** у списку посадки (бот);
- **ніколи не позначаються `absent`** автоматично — явку/відсутність ставить
  графікова вручну у веб-графіку (кнопки present/absent на сторінці Schedule);
- **виключені з лічильників «до забрання»** (driver-board, pickupGaps, пресмінне
  нагадування водієві);
- **свій пресмінний пуш отримують** (вони все одно на зміні).

Excel-графік клієнту **не змінювався** — self-transport там лишаються (працюють).

## Що зроблено

**Схема:** `workers.self_transport boolean NOT NULL DEFAULT false`
(міграція `deploy/migrations/2026-07-06-worker-self-transport.sql`, накатана на прод).

**Бекенд:**
- `bot/index.ts` — посадка: виключення з списку + з auto-absent (два запити).
- `services/scheduler.ts` — `driverPickupCount` (без self-transport) у повідомленні водієві; працівнику пуш лишається.
- `services/pickupGaps.ts` + `routes/admin-api.ts` `GET /driver-board` — headcount без self-transport (продубльована логіка, міняти синхронно).
- `admin-api.ts` — `selfTransport` у `GET /workers`, `GET /workers/:id`, `POST/PATCH /workers`, `GET /schedule`. Поле **операційне** (гейт `editData`/`RW`), не owner-only.

**Веб:** чекбокс «Доїжджає сам» у `WorkerModal`, бейдж у `WorkerDetail` (Транспорт) і в `Schedule` (🚗 біля явки), EN-переклади в `i18n.tsx`, `selfTransport` у типах `Worker`/`ScheduleEntry`.

## Як користуватись

Профіль працівника → «Редагувати» → галка **«Доїжджає сам»**. Після цього водій
його не бачить; графікова відмічає present/absent на сторінці «Графік» (🚗-бейдж
підказує, кого відмічати вручну).

## Верифікація

`pnpm run typecheck` ✅ · `web build` + `api build` ✅ · тести 10/10 ✅ ·
прод health `ok` (db ok, bot up), логи без 409/404.

---

## ⚠️ Важливо для наступної сесії: паралельний WIP «Економіка»

У робочому дереві лежить **великий незакомічений WIP модуля Економіка/фінанси**
(KSeF, банк-імпорт): `routes/economics.ts`, `services/{bankImport,reconcile,incomeFromBank,taxFromBank,classifyBankExpense}.ts`,
`pages/Economics.tsx`, нові fin-таблиці у схемі, зміни в `scheduler.ts` (дедуп-персист +
`bankImportTask`), `routes/index.ts`, `lib/{auth,roles}.ts`, `App.tsx`, `Layout.tsx`,
`web/lib/roles.ts`, міграція `2026-07-05-economics-module.sql`.

Ця self-transport-фіча була **ізольована** в окремий коміт (economics лишився
локально незакоміченим), тому на прод поїхав **тільки self-transport**. Економіку
**не деплоїти**, доки не дороблена (потрібні: SQL-міграція economics, KSeF-креденшели,
монтування `economics.ts` в `routes/index.ts`, перевірка). `scheduler.ts` у WIP
імпортує ще-незакомічені сервіси — без них білд впаде.

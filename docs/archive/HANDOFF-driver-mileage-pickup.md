# Handoff — пробіг водіїв, «Забрати зі зміни», керування водіями з бота

Задачі завершені й **задеплоєні на прод** (комміти `6b4fac3`, `7abb46f`, `e4dd250`). Сесія 2026-07-02…03. Міграції накатані, разовий cleanup виконано.

---

## 1. Робоча зміна водія + звіт по пробігу

- **Бот (водій і головний водій):** кнопка `🚗 Почати зміну` (виїзд з бази → ввести пробіг у км) ↔ `🏁 Закінчити зміну` (повернення → кінцевий пробіг; валідація ≥ початкового). Кнопка в меню перемикається за станом через `driverMenuFor(driver, dl)` — **усі** реплаї водій-контексту переведені на нього (аналог `workerMenuFor`). Забута незакрита зміна за попередній день закривається сьогоднішнім стартовим показником (одометр за ніч не змінився).
- **API:** `GET /api/mileage?month=YYYY-MM` — по водіях: дні (дата, виїзд/повернення, одометр старт/кінець, км), `totalKm`, `closedShifts`, `avgKm`. Без спец-гейту (будь-який залогінений).
- **Веб:** сторінка **`/mileage` «Звіт по пробігу»** (розділ Аналітика): вкладки по водіях → місяць → таблиця днів + картки підсумків. Додано в `PAGE_KEYS`/`PAGE_LABEL` обох `roles.ts` і в `roles.pages` для **driver** і **scheduler** (SQL нижче) — головний водій бачить **усіх**.

## 2. Pickup — «Забрати зі зміни»

- **Модель:** `driver_shift_assignments.kind: 'delivery' | 'pickup'` (default delivery — історичні рядки не мігрувались). Семантика pickup для зміни N = бути на фабриці на **кінець** зміни N.
- **Неявне правило лишилося:** якщо pickup не призначений — людей забирає водій, що привозить зміну, яка **починається в момент закінчення** N (та сама доба; наступна — якщо зміна через північ).
- **Веб DriverShifts:** у клітинці під основною кнопкою — перемикач `🔙 забрати` (ключі слотів: `day-shift` delivery, `day-shift-p` pickup); в огляді pickup-водії сині плашки. `PUT /schedule/driver-assignments` від pickup-unaware клієнта (сторінка Графік шле лише `day-shift`) **не стирає** pickup-рядки (`hasPickupKeys`-гілка в delete). copy-week переносить `kind`.
- **Бот:** «Мій графік»/«Моя зміна сьогодні» показують pickup з часом кінця зміни і списком людей **без** статус-іконок; «Почати поїздку», «Посадка/явка», «Не прийшли до машини» — **лише delivery** (рішення власника: при заборі явку не відмічають). `notifyDriversOfWeek`/`notifyDriverOfWeek` маркують pickup (`🔙 забрати 2зм`); графік працівникам показує лише delivery-водія.
- **Нагадування (scheduler):** pickup-водію за ~60 хв до **кінця** зміни (вікно 46–74 хв, дедуп `{factoryId}_{shift}_p_{date}`); нічна зміна через північ → рядок призначення шукається на попередній день (і попередній тиждень, якщо сьогодні понеділок) — `sendPickupReminder()`.

## 3. Авто-детекція прогалин забору

- **`services/pickupGaps.ts` → `detectPickupGaps(weekId, day)`**; те саме правило продубльоване per-cell у `GET /driver-board` (`pickupGap`) — **тримати синхронними** (взаємні коментарі є).
- Правила: зміна з людьми не покрита, якщо (а) pickup не призначено І ніхто не приїжджає на її кінець (`reason: "none"`), або (б) людей більше за місткість покриття (`reason: "capacity"`).
- **Місткість:** per-driver `drivers.seats` є в БД, але **власник вирішив не заповнювати** (авто ротуються; парк = 9- і 20-місні буси). Поле прибрано з UI Водіїв. Невідоме авто рахується як **20 місць** → capacity-gap лише коли не влізе навіть у найбільші буси.
- **Cron 19:00 Warsaw** (`notifyHeadDriverPickupGaps`): прогалини на **завтра** → головному водієві повідомлення з inline-кнопками: `pkg:<weekStart>:<day>:<factoryId>:<shift>` (вибір водія) → `pka:...:<driverId>` (створює pickup-призначення + сповіщає обраного водія). Обробники в `bot/index.ts`, гейт — лише head driver.
- **Веб:** бейдж «⚠️ нема кому забрати» в клітинках DriverShifts; в AssignModal pickup-тогл підсвічується жовтим на прогалині.

## 4. Керування водіями з бота + фікс «привида» (`e4dd250`)

- **`rosterManager(tid)`** — гейт «офіс-адмін АБО головний водій» для `➕ Додати водія` і нового `🗑 Видалити водія`. Головний водій заходить через «👥 Мій список водіїв» (там додано кнопки), адмін — через меню «🚗 Водії» (видалення додано і туди). Звичайні водії — **bot-only**, сайту не отримують.
- Додавання: ім'я → авто (/skip) → invite-лінк `?start=drv<code>`. Видалення: список звичайних (НЕ head) водіїв → підтвердження → софт-деліт.
- **Фікс:** видалення водія (бот або веб `DELETE /drivers/:id`) тепер викликає `services/drivers.ts`: `deactivateDriver()` + `removeDriverUpcomingAssignments()` — знімає його призначення з поточного і майбутніх тижнів (минуле лишається для історії). Разовий cleanup на проді прибрав старих «привидів» (0 залишилось).

---

## Ключові файли

| Файл | Зміна |
|------|-------|
| `lib/db/src/schema/workers.ts` | `driver_workdays` (нова), `driver_shift_assignments.kind`, `drivers.seats` |
| `artifacts/api-server/src/bot/index.ts` | workday-флоу, `driverMenuFor`, `rosterManager` + add/remove флоу, `pkg`/`pka` callbacks, delivery-фільтри |
| `artifacts/api-server/src/bot/menus.ts` | `driverMenu`/`headDriverMenu(lang, onShift)` |
| `artifacts/api-server/src/bot/views.ts` | pickup у «Моя зміна сьогодні» / «Мій графік» |
| `artifacts/api-server/src/bot/notify.ts` | kind-маркування розсилок водіям; delivery-only для працівників |
| `artifacts/api-server/src/services/scheduler.ts` | `sendPickupReminder`, cron 19:00 `notifyHeadDriverPickupGaps` |
| `artifacts/api-server/src/services/pickupGaps.ts` | детекція прогалин (нова) |
| `artifacts/api-server/src/services/drivers.ts` | деактивація + чистка призначень (нова) |
| `artifacts/api-server/src/routes/admin-api.ts` | `/mileage`, kind у driver-board/PUT-ах/copy-week, delete-фікс |
| `artifacts/web/src/pages/Mileage.tsx` | сторінка звіту (нова) |
| `artifacts/web/src/pages/DriverShifts.tsx` | pickup-тогли, плашки, бейджі прогалин |
| `artifacts/web/src/{App.tsx, components/Layout.tsx, lib/{roles,api,i18n}.ts(x)}` | роут/нав/типи/EN |

**Міграція (накатано на проді; `deploy/schema.sql` перегенеровано з проду — `7abb46f`):**
```sql
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS seats integer;
ALTER TABLE driver_shift_assignments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'delivery';
CREATE TABLE IF NOT EXISTS driver_workdays (
  id serial PRIMARY KEY, driver_id integer NOT NULL REFERENCES drivers(id),
  work_date date NOT NULL, started_at timestamp NOT NULL DEFAULT now(),
  odometer_start integer NOT NULL, ended_at timestamp, odometer_end integer,
  created_at timestamp NOT NULL DEFAULT now());
UPDATE roles SET pages = pages || '["/mileage"]'::jsonb
  WHERE key IN ('driver','scheduler') AND NOT pages ? '/mileage';
-- разовий cleanup: призначення неактивних водіїв на поточний/майбутні тижні
DELETE FROM driver_shift_assignments a USING drivers d, schedule_weeks w
 WHERE a.driver_id=d.id AND a.week_id=w.id AND d.is_active=false
   AND w.week_start::date >= date_trunc('week', CURRENT_DATE)::date;
```

---

## Що потрібно знати наступній сесії

- **Нові запити до `driver_shift_assignments` мусять думати про `kind`:** усе, що стосується завозу/посадки/поїздок — фільтр `kind='delivery'`; загальні огляди — показувати обидва з маркуванням. Забудеш фільтр — pickup-рядки «продублюють» водіїв у завозі.
- **Меню водія** — тільки через `driverMenuFor(driver, dl)` (кнопка зміни залежить від відкритого workday). Голий `driverMenu()/headDriverMenu()` без прапора покаже «Почати зміну» тому, хто вже на зміні.
- Детекція прогалин продубльована у 2 місцях (driver-board + pickupGaps.ts) — при зміні правил міняти **обидва**.
- `drivers.seats` живе в БД, у UI його нема; якщо колись заповнять — детекція автоматично стане точнішою (unknown=20 лише як фолбек).
- Trip-tracking (`driver_trips`) для pickup-поїздок **не ведеться** (немає «почати поїздку» для забору) — якщо власник захоче трекінг заборів, це окрема задача.
- Callback-дані `pkg:`/`pka:` вміщуються в ліміт 64 байти; при додаванні полів перевіряти довжину.

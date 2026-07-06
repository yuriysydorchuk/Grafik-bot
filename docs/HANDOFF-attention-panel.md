# HANDOFF: панель «Потребує уваги» + фікс «Прочитати всі» (2026-07-07)

Одноразова записка сесії. Задеплоєно на прод комітом `2ea1f34`.

## Що зроблено

1. **Баг «Прочитати всі» у дзвіночку сповіщень.** `POST /notifications/read` порівнював
   `n.id !== Number(id)`, а фронт шле `{ id: "all" }` → `Number("all") = NaN` → умова
   пропускала всі рядки, нічого не позначалось. Тепер: нечисловий/відсутній `id` =
   «позначити все видиме», один jsonb-UPDATE (`read_by = read_by || [myId]` + фільтр
   audience) замість циклу по таблиці. Файл: `routes/admin-api.ts`.
2. **NotificationBell** (`web/src/components/NotificationBell.tsx`): optimistic update —
   сповіщення зникає одразу після кліку, не чекаючи refetch (30 c).
3. **`GET /api/attention`** (`routes/admin-api.ts`, поруч із `/dashboard`) — лічильники
   відкритих питань; **панель «Потребує уваги»** на дашборді
   (`web/src/pages/Dashboard.tsx`, компонент `AttentionPanel`) — клікабельні плитки,
   нульові ховаються, все по нулях → зелений рядок. i18n uk+en (`web/src/lib/i18n.tsx`).

## Логіка лічильників `/attention` (нюанси)

- `unmarkedAttendance` — затверджені тижні з `weekStart >= поточний понеділок − 14 днів`,
  записи зі статусом `scheduled`, чия фактична дата (`entryDateStr`) < сьогодні (Warsaw).
  Дати рахуються рядками (правило проєкту, без `toISOString`).
- `driverGaps` — слоти (тиждень|фабрика|день|зміна) поточного+наступного тижня від
  сьогодні й далі, де є працівники без `self_transport`, фабрика з `usesTransport`,
  і немає `driver_shift_assignments` з `kind='delivery'`. Рахує слоти, не людей;
  місткість не перевіряє (це робить pickupGaps). Primary-тиждень на weekStart —
  approved має пріоритет (дзеркалить `GET /dashboard`).
- `availabilityMissing` — довжина `missingAvailabilityWorkers(nextWeek)` (лише число,
  без імен — імена і так є в картці внизу дашборда).
- Решта — прості count: `absence_requests`/`advance_requests` `pending`,
  `hours_disputes` `new`, `unplanned_workers` з `worker_id IS NULL`.
- Гейт — лише `authRequired` (як `/dashboard`), фінансових даних у відповіді немає.

## Перевірено

- typecheck / 27 тестів / build — зелені; CI пройде ті самі кроки.
- Прод-смоук після деплою: `healthz` ok, `GET /attention` під сесією повертає реальні
  цифри, `POST /notifications/read` відпрацьовує без помилок у логах.

## Попутний локальний інцидент (не прод)

Локально виявились **два** інстанси бекенду (pm2 `grafik-bot` + вручну запущений
`node dist/index.mjs`) → 409-конфлікт polling тестового бота і десятки рестартів pm2.
Ручний процес зупинено, лишився pm2. Нагадування: після локального build треба
`pm2 restart grafik-bot`, інакше процес крутить старий бандл.

## Можливі продовження (не почато)

- `unmarkedAttendance` на проді зараз ~265 — вікно у 3 тижні тягне історичний хвіст;
  якщо заважає, можна звузити до поточного тижня або показувати розбивку по тижнях.
- Плитку можна вести не на загальний `/schedule`, а на конкретний тиждень/фільтр.

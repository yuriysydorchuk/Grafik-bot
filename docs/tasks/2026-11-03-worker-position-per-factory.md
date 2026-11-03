# Задача: посада працівника — окремо на кожній фабриці (зголошення #12, етап c)

- **Статус:** 🔲 заплановано — чекає погодження власника (схема БД + сводна/ставки)
- **Дата:** 2026-11-03
- **Автор/сесія:** Claude (тріаж зголошень)

---

## Мета

Людина може мати різну посаду на різних фабриках (напр. Wózkowy на одній, Pracownik на іншій). Секція сводної, ставка, Stanowisko в умові, KZiS у powiadomieniu й посада в графіку/замовленнях беруться з посади **на цій фабриці**, з фолбеком на теперішню `workers.position_id`. Готово, коли: у профілі біля кожної фабрики свій вибір посади; сводна/облік/умова/powiadomienie по додатковій фабриці беруть її; без окремого значення все працює як зараз.

## Контекст

Зараз `workers.position_id` — одна посада на всі фабрики. На додатковій фабриці: ставка випадково правильна (фолбек на найдешевшу посаду фабрики), але секція сводної — посада, якої там нема; {%Stanowisko%} в умові — посада з основної фабрики. Посади фабрики (`factory_positions`) — уже є (етап b, Налаштування → Посади на фабриці). Шари: схема, API, веб (профіль), сводна, облік годин, документи, powiadomienie, графік/генератор.

## Модулі які можна чіпати

- `lib/db/src/schema/workers.ts` + міграція `deploy/migrations/2026-11-xx-worker-factory-positions.sql`
- новий `artifacts/api-server/src/services/workerPositions.ts` (резолвер)
- сводна: `routes/svodni.ts` (rowSetFromProfile, add-row, from-hours, зміна посади → сегменти), `services/svodni.ts` (resolveBaseRates — без змін логіки, лише вхідна посада), `services/rateRules.ts`
- облік: `services/hoursRows.ts`, `/hours` у `routes/admin-api.ts`, `services/workerBalance.ts`
- документи: `services/contracts.ts` ({%Stanowisko%}, {%Czynności%}, вибір andros_extra), `routes/contracts.ts`
- powiadomienie: `services/pracaGov/payload.ts`, `services/uaNotification.ts`
- графік/замовлення: `services/scheduleGenerator.ts`, `services/drive.ts` (Excel), відповідні місця `admin-api.ts`
- `services/workerMerge.ts` (нова таблиця з worker_id), профіль `web/src/pages/WorkerDetail.tsx`

## Модулі які не можна чіпати

- рішення по ставках (ланцюжок rateRules) — лише вхідна посада змінюється, порядок пріоритетів той самий
- уже сформовані рядки сводної — не перераховувати масово (лише через наявний ревʼю/«У сводну»)

## План

1. **Схема:** `worker_factory_positions (worker_id, factory_id, position_id, since date, created_at, admin_id)`, unique(worker_id, factory_id, since) — за зразком `worker_notify_hours`. Без рядка — діє `workers.position_id`.
2. **Резолвер** `positionAt(workerId, factoryId, date?)` + пакетний `loadPositionMap(workerIds)`; правило: рядок пари (останній since ≤ дата) → профіль. Жодних прямих читань `w.positionId` у нових місцях (гард-тест на кшталт legality.guard).
3. **Заміна читань** у місцях з «Модулі які можна чіпати» (≈15 викликів): сводна (секція, ставка, сегменти зміни посади лише в рядках ЦІЄЇ фабрики), облік годин/ставка, баланс, умова/Czynności/andros_extra, powiadomienie (Stanowisko/KZiS), генератор графіку (посада для замовлень по фабриці), Excel графіка.
4. **Журнал:** зміна посади на фабриці → `worker_changes` (field `positionId`, `factory_id`) — ревʼю розлоку сводної бачить лише свою фабрику.
5. **UI профілю:** у блоці фабрик (основна + додаткові) — вибір посади з посад цієї фабрики («як у профілі» = без рядка); основна посада профілю лишається дефолтом.
6. **mergeWorkers:** перенос рядків нової таблиці.
7. **Тести:** сводна (секція/ставка по додатковій фабриці, сегменти), облік, умова {%Stanowisko%}, powiadomienie, генератор; міграція на копії прод-дампу.

## Ризики

- Фінансово критично: ставка й секція сводної. Пом'якшення — фолбек на профіль (нічого не змінюється, поки ніхто не вкаже окрему посаду), тести на кожну поверхню, ревʼю agy+codex.
- Обсяг L (≈1–1,5 дня).

# HANDOFF: Інтеграція Суші, Становіск та Сегментації Сводної (Познань)

## 1. Мета та Контекст
Поєднати модуль фабрики Суші (`sushi_roles`, `sushi_work_intervals`, `sushi_worker_codes`) із загальною системою Сводних (`/svodni`, місто Познань, фабрика Sushi) та картками робітників (`/workers/:id`).

## 2. Ключові Архітектурні Рішення

### А. Двостороння синхронізація трійки реквізитів
1. **Номер працівника (Nr osobowy / RCP):**
   - `workers.workerCode` $\leftrightarrow$ `svodni_rows.hr.nrOsobowy` $\leftrightarrow$ `sushi_worker_codes.rcpCode`
2. **Фірма (Company):**
   - `workers.companyId` (ES/ESO/Klinex) $\leftrightarrow$ `svodni_rows.hr.firma` $\leftrightarrow$ `sushi_worker_codes.firm`
3. **Становіско (Stanowisko):**
   - `workers.positionId` $\leftrightarrow$ `svodni_rows.section` (`hr.stanowisko`) $\leftrightarrow$ `sushi_roles` через `sushi_roles.position_id`

- Зміна в профілі працівника $\to$ оновлює відповідні поля в рядку Сводної (Познань → Sushi) та в модулі Суші.
- Зміна у Сводній $\to$ через `syncWorkerProfile` зберігається назад у `workersTable`.

### Б. Вибірковий вплив на ставку: Статусні посади vs Звичайні
- **Статусні ролі (`Lider`, `Brygadzista`, `Supervisor`):**
  - Ставка залежить від статусу (підвищена ставка ролі або надбавка лідера).
  - Призначення цієї посади актуалізує ставку працівника в розрахунку годин.
- **Звичайні виробничі посади (`Pracownik`, `Skoczek`, `Оператор машини заморозки`, `Repack`):**
  - Посада фіксує операційну функцію на лінії для обліку, але ставка залишається **базовою ставкою фабрики** (не змінюється).

### В. Порізка місяця на години по різних ставках (Сегментація)
- Якщо звичайний працівник посеред місяця (наприклад, з 16 вересня) стає лідером:
  - У системі фіксується дата зміни (`effectiveDate` = `2026-09-16`).
  - `svodni` розрізає рядок на 2 сегменти:
    - **Сегмент 1 (01–15):** Посада `Pracownik`, базова ставка, години з табеля Суші за 01–15 вересня.
    - **Сегмент 2 (16–30):** Посада `Lider`, підвищена ставка, години з табеля Суші за 16–30 вересня.
  - Функція `attendanceByWindows` у `svodni.ts` зчитує фактичні години з `sushi_work_intervals` за відповідними діапазонами дат.
  - Калькулятор `Załącznik do faktury` формує клієнтську фактуру за дзеркальною порізкою дат та ставок.

## 3. Файли для реалізації в наступному чаті
1. `lib/db/src/schema/workers.ts` — додати `position_id` у `sushi_roles` (якщо ще немає).
2. `artifacts/api-server/src/routes/svodni.ts` — розширити `syncWorkerProfile` на трійку реквізитів (`nrOsobowy`, `firma`, `stanowisko`) та оновити `attendanceByWindows` для фабрики Суші.
3. `artifacts/api-server/src/routes/admin-api.ts` — при оновленні профілю оновлювати рядки поточної відкритої сводної.
4. `artifacts/api-server/src/services/svodniSync.ts` — правило вибіркової ставки: статусний прапорець для Lider/Brygadzista, звичайна база для Skoczek/Operator.
5. Автотести для перевірки порізки та синхронізації.

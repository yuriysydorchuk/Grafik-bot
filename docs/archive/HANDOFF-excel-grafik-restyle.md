# Handoff — новий стиль Excel-графіку + конфіг стовпчиків

Задача завершена й **задеплоєна на прод** (commit `30b96ea`).

---

## Що зроблено

Excel-графік фабрики тепер генерується у бірюзовому посекційному стилі (за макетом клієнта):

- кожна зміна — **бірюзова смуга-заголовок**: `{N} zmiana {Назва фабрики} {DD.MM.YYYY} ({год}H) ({поч}-{кін})`, напр. `1 zmiana LST 22.06.2026 (8H) (06:00-14:00)`;
- під нею **пронумерований список** (номер у бірюзовій клітинці, нумерація з 1 у кожній зміні) + ім'я;
- **порожня права колонка** (нотатки/підпис), без заголовка;
- рядка-шапки `Lp./Imię/Kod` і старого чорного day-title більше нема;
- один аркуш на день (вкладка названа польським днем); тривалість зміни `(NH)` рахується з часу (нічна через північ — коректно).

**Налаштовувані стовпчики (в налаштуваннях фабрики, блок «Стовпчики Excel-графіку»):**
- **Код** — нове поле `factories.show_code` (дефолт `true`).
- **Стать** (колонка K/M) — наявний `usesGender`.
- **Розділення по посадах** (групи-підзаголовки) — наявний `usesPositions`.

> `usesGender`/`usesPositions` керують і генерацією графіку, і колонками Excel (спільні). Якщо колись треба незалежно — окрема задача.

---

## Які файли змінено (commit 30b96ea)

| Файл | Зміна |
|------|-------|
| `lib/db/src/schema/workers.ts` | `factories.show_code boolean NOT NULL DEFAULT true` |
| `artifacts/api-server/src/services/drive.ts` | переписано `buildFactoryWorkbook` (бірюза, смуга-заголовок, нумеровані рядки, порожня колонка); `SegConfig`/`loadSegConfig` + `showCode`; хелпери `dayDate`/`fmtDDMMYYYY`/`shiftHours` |
| `artifacts/api-server/src/routes/admin-api.ts` | POST/PATCH `/factories` приймають `showCode` |
| `artifacts/web/src/lib/api.ts` | тип `Factory` + `showCode` |
| `artifacts/web/src/pages/Factories.tsx` | блок «Стовпчики Excel-графіку» (чекбокс коду) |
| `artifacts/web/src/lib/i18n.tsx` | EN-переклади |

**Міграція БД (накатано на проді й локально):**
```sql
ALTER TABLE factories ADD COLUMN IF NOT EXISTS show_code boolean NOT NULL DEFAULT true;
```

---

## Що потрібно знати наступній сесії

- **Деплой зроблено повністю** (через `ssh grafik`): `git pull` → ALTER TABLE → `bash deploy/build.sh`. Перевірено: pm2 online/стабільний, `/healthz`=200, бот у polling.
- **Колір бірюзи** — `FF8FC9C4` (смуга+номери), `FFD6EBE9` (підзаголовки груп), чорна тонка рамка `FF000000`. Константи `TEAL`/`TEAL_LIGHT`/`BORDER` угорі `buildFactoryWorkbook`.
- **`row.values = [...]` у ExcelJS у цьому коді 1:1 з колонками** (елемент 0 → колонка 1), не sparse. Порядок: `№, Ім'я, [Płeć], [Kod], (порожня)`.
- **LST за дефолтом показує код** (бо `show_code=true`). Щоб 1-в-1 як скрін клієнта (без коду) — вимкнути тумблер «Стовпчик коду працівника» у фабрики LST.
- **Прев'ю Excel локально** (тимчасові скрипти видалені): можна відтворити через esbuild-бандл скрипта, що кличе `buildScheduleExcelBuffer(weekId, factoryId)`, із `NODE_ENV=production` (інакше pino-pretty падає в бандлі) і `--banner` з `createRequire` (для CJS-залежностей типу `pg`).
- **Два боти, різні токени** (локальний тест ≠ прод) — 409 нема.

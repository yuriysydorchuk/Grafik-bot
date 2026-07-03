# Handoff — завантаження графіку по днях (per-day schedule Excel)

Завершено й **задеплоєно на прод**. Комміт `06c26e7`. Прод HEAD `06c26e7`.

Раніше графік качався лише на весь тиждень. Тепер можна скачати **кожен день окремо** — кнопка «Скачати» біля кнопки «Розіслати» для кожного дня.

---

## Що зроблено

### Веб ([`pages/Schedule.tsx`](../artifacts/web/src/pages/Schedule.tsx))
У заголовку кожного дня, де є зміни (`entries.some(e => e.day === day)`), поряд із «Розіслати» додано `<a>` **«Скачати»** (іконка `Download`):
`/api/schedule/excel?weekStart=…&factoryId=…&day=${day}`. Обидві кнопки загорнуто в `ml-auto flex gap-1`.

### API ([`routes/admin-api.ts`](../artifacts/api-server/src/routes/admin-api.ts))
`GET /schedule/excel` приймає опційний `&day=` (валідований проти `DAYS` — інакше ігнорується → весь тиждень). Передає `day` у білдер.

### Excel-білдер ([`services/drive.ts`](../artifacts/api-server/src/services/drive.ts))
`buildScheduleExcelBuffer(weekId, factoryId, day?)` — при заданому `day` додає у WHERE `eq(dayOfWeek, day)`. Оскільки `buildFactoryWorkbook` і так робить **один аркуш на день** і пропускає порожні дні, відфільтровані записи дають файл з одним аркушем. Назва файлу:
- день: `Grafik <фабрика> <PL-день> DD.MM.YYYY.xlsx` (напр. `Grafik ALMIZ Poniedziałek 29.06.2026.xlsx`);
- тиждень (без `day`): як було — `Grafik <фабрика> YYYY.MM.DD.xlsx`.

### i18n ([`lib/i18n.tsx`](../artifacts/web/src/lib/i18n.tsx))
Нові ключі: `"Скачати"` → "Download", `"Скачати графік на цей день"` → "Download this day's schedule".

---

## Перевірено на проді (форжений owner-токен)
- Тижневий файл — 6 аркушів (Пн–Сб); денний (`&day=mon`) — **один** аркуш (Poniedziałek), ~вдвічі менший, валідний xlsx (PK), коректна датована назва.
- Ендпойнт віддає `Content-Disposition: attachment` з іменем файлу (браузер бере назву звідти).

## Нотатки
- Кнопка/ендпойнт працюють і для чернетки, і для затвердженого тижня (`/schedule/excel` бере approved, інакше останній кандидат за `weekStart`).
- `day` — коди `mon..sun` (масив `DAYS`), як у решті графіку.

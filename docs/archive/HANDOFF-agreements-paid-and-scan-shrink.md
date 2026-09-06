# Handoff: оплата умов, вкладка проформ, автостискання сканів

Дата: 2026-09-02 · Статус: **готово, задеплоєно на прод** (див. «Прод» нижче)

Три скарги кшєнгової по «Умовах» на /cost-invoices: не можна відмітити, чи
оплачена умова цього місяця; не можна вибрати переказ/готівку; скан умови не
завантажився («upload failed»). Плюс окремий розділ для проформ.

---

## Що зроблено

### Оплата умов (agreement_charges)
- Раніше записи умов свідомо не трекали оплату (`paid: true`, бейдж
  «нарахування»). Тепер рядок умови в списку має **ті самі контроли, що й
  фактура**: ✓/✗ оплата (клік — сьогодні), 🏦/💵 спосіб (цикл переказ →
  готівка → авто), чекбокс «рапорт» при готівці. Суми входять у плитки
  «Оплачено / Не оплачено / Переказ / Готівка».
- **Олівець** ✏️ на рядку умови → модалка `ChargeModal` «Запис умови · YYYY-MM»
  (сума, спосіб, нотатка, «Оплачена» + дата) — дзеркало форми ручної фактури.
- Схема (`lib/db/src/schema/workers.ts`, міграція
  `deploy/migrations/2026-09-02-agreement-charges-paid.sql`):
  - `agreement_charges`: `paid`, `paid_date`, `payment_method`, `cash_report`;
  - `agreement_conditions`: `payment_method` — **дефолт умови** (поле «Спосіб
    оплати» у формі умови; у списку показується як «авто», точково перебивається
    на записі місяця; `null` на charge = назад на дефолт).
- Бекенд: `PATCH /agreements/charges/:id` приймає `paid`/`paidDate`/
  `paymentMethod`/`cashReport`; `source='manual-edit'` тепер ставиться **лише
  при зміні суми** (оплата/нотатка не «приклеюють» суму при регенерації).
  `GET /cost-invoices` мерджить реальні значення (`paidSource:"manual"`,
  `paymentMethodSource: manual|auto`). Аудит — `agreement_audit` як раніше.
- **Касовий P&L не змінювався** (умови — акруал незалежно від позначки) — рішення
  Yuriy 02.09.2026.

### Проформи
- У перемикачі «Тип» на /cost-invoices нова вкладка **«Проформи»**
  (`isProforma`); «Фактури без КСеФ» їх більше не показує, «Всі» — показує.

### Скани: причина і автостискання
- Прод-лог: `MulterError: File too large` на `POST /api/agreements/1/file` —
  файл >15 МБ; фронт ковтав відповідь і показував «upload failed».
- Ліміт multer для сканів умов і фактур → **60 МБ** (`SCAN_UPLOAD_LIMIT` у
  `lib/uploads.ts`). Глобальний хендлер в `app.ts` перетворює `MulterError`
  на `413 {"error":"Файл завеликий (макс 60 МБ)"}` / 400 (не 500, не алерт).
  Форми умови/фактури шлють файл через `upload()` з `lib/api.ts` — показують
  реальний текст помилки сервера.
- **Фото** зменшує браузер перед відправкою: `web/src/lib/shrinkFile.ts`
  (canvas → JPEG, довша сторона ≤2400px, ціль ≤3 МБ; HEIC у Chrome не
  декодується — йде як є). Підключено у формі умови, формі фактури і «Скан».
- **PDF** > 4 МБ стискає сервер ghostscript-ом: `shrinkDocBuffer()` у
  `lib/uploads.ts` (`gs -dPDFSETTINGS=/ebook`, best-effort: без `gs`, при
  помилці або якщо не стало менше — лишається оригінал, лише лог). Перевірено:
  скан 26,8 МБ → 1,2 МБ у `uploads/` і в Drive-архіві.
  На VPS потрібен `apt install -y ghostscript` (задокументовано в
  `docs/infrastructure/DEPLOYMENT.md → Системні залежності`).

## Файли змінено

- **Нові**: `artifacts/web/src/lib/shrinkFile.ts`,
  `deploy/migrations/2026-09-02-agreement-charges-paid.sql`
- **Змінено**: `lib/db/src/schema/workers.ts`, `artifacts/api-server/src/app.ts`,
  `artifacts/api-server/src/lib/uploads.ts`, `routes/agreements.ts`,
  `routes/costInvoices.ts`, `artifacts/web/src/pages/CostInvoices.tsx`,
  `artifacts/web/src/lib/i18n.tsx`, `docs/API_ROUTES.md`,
  `docs/infrastructure/DEPLOYMENT.md`

## Перевірено

- `pnpm run typecheck`, юніти api-server (241 pass / 0 fail), build api+web.
- Смоук API локально: paid/дата/метод/рапорт/аудит, 413 на 70 МБ, 400 на не-PDF,
  20 МБ PDF проходить; gs-шлях наскрізь через `POST /agreements/:id/file`.
- Скріни light+dark /cost-invoices (вкладка «Умови», модалка запису) — без
  console errors. Yuriy протестував локально 02.09 → «ніби все ок».
- Тестові файли смоуку з Drive (`Umowy/ES`) видалено, локальна умова #2 очищена.

## Відкрите

- На проді умова #1 (HOSTEL ZBOŻOWA) створена **без скану** — кшєнгова має
  перезалити файл через «Умови → олівець → Скан умови».
- Банк-матчингу для умов нема (оплата — лише ручна позначка); за потреби —
  окрема задача.
- Локально: на 8080 висів осиротілий node зі старим `dist` (ppid 1, з давнього
  `run dev`) і блокував pm2 — прибитий. Якщо pm2 показує `errored`/restarts і
  `EADDRINUSE` — `lsof -iTCP:8080 -sTCP:LISTEN`.

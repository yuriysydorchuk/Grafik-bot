# Handoff: Google Sheets фід годин для рекрутингу

Дата: 2026-09-01 · Статус: **готово, задеплоєно на прод**

Зовнішній сервіс, що рахує виплати рекрутерам, тепер щоранку може підтягувати
список свіжих активних працівників із годинами обліку — окремим
Google Sheets документом, який оновлюється кроном (не через API/веб-панель).

---

## Що зроблено

- Новий сервіс `syncRecruiterHoursSheet()` (`artifacts/api-server/src/services/recruiterHoursSheet.ts`):
  - Бере активних (`workers.is_active`) працівників зі стажем **≤60 днів**
    (`employmentStartDate`, фолбек `createdAt`, до сьогодні — `daysBetween` з `services/svodni.ts`).
  - Рахує їм суму годин **за весь час роботи** (не за місяць) з явок
    `status="present"` затверджених тижнів — та сама формула
    `hoursOverride ?? factoryShiftHours(fac, shift)`, що в `hoursRows.ts`, але
    без місячного фільтра.
  - Лишає лише тих, у кого сума годин `> 0` («мають години в обліку»).
  - `hours = round2(max(0, totalHours − 8))` — офсет застосовується **один раз**
    до підсумкової суми.
  - Пише в Google Sheet: `ПІБ | Код | Години`, повний перезапис (clear+update)
    при кожному прогоні — не append.
- Auth — **OAuth** (`getDriveAuth()` з `services/drive.ts`, той самий, що для
  Drive-експортів), НЕ read-only сервісний акаунт з `services/sheets.ts` —
  токен вже мав scope `spreadsheets` (мінтиться в `get-google-token.mjs`).
- Документ **створюється автоматично** при першому запуску
  (`spreadsheets.create`), ID зберігається в `settings` (ключ
  `recruiter_hours_sheet_id`) — новий env var не заводили.
- Крон: `artifacts/api-server/src/services/scheduler.ts` — новий
  `recruiterHoursSheetTask`, щодня о **06:20 Europe/Warsaw** (одразу після
  банк-імпорту), try/catch + `logger.warn` — падіння не валить решту циклу.

## Файли змінено

- **Новий**: `artifacts/api-server/src/services/recruiterHoursSheet.ts`
- **Змінено**: `artifacts/api-server/src/services/scheduler.ts` (реєстрація/зупинка нового крона)

## Перевірено

- `pnpm run typecheck`, `pnpm --filter @workspace/api-server run test` (0 fail), `run build` — усе чисто.
- Локальний прогін проти дев-БД: документ реально створився, OAuth-скоуп
  дозволив запис без 403, дані звірені вручну (стаж/години рахуються правильно).
- Прод: задеплоєно, `git log --oneline -1` = `ed0efb8`, `bash deploy/build.sh`
  пройшов, `/api/healthz` → `{"status":"ok","db":"ok","bot":"up"}`, логи без помилок.

## Відкрите (за користувачем, не автоматизовано)

- **Доступ (share) на документ** зовнішньому сервісу користувач додає
  **вручну сам**, коли отримає email/service-account — код цього не робить.
- Перший реальний прод-документ створиться при першому запуску крона
  (сьогодні 06:20 Warsaw, або наступного дня, якщо деплой стався пізніше) —
  URL шукати в `pm2 logs grafik-bot` (`"Recruiter hours sheet created"`).
- У фід свідомо **не** включено, хто з рекрутерів привів працівника
  (`candidates.assigned_admin_id`) — за рішенням користувача зовнішній сервіс
  сам це знає з іншого джерела.

# PROJECT_MAP.md

Технічна карта проєкту **Grafik-bot**. Високорівневий опис системи — у [`CLAUDE.md`](CLAUDE.md); деталі модулів — у README відповідних пакетів; повний довідник API — у [`docs/API_ROUTES.md`](docs/API_ROUTES.md); фінансові правила — у [`docs/rules/FINANCE_RULES.md`](docs/rules/FINANCE_RULES.md).

---

## Карта монорепо

pnpm workspaces. Один процес обслуговує API + статику веб + бота + cron.

```
Grafik-bot/
├── artifacts/
│   ├── api-server/          @workspace/api-server — бекенд (Express+бот+cron) → dist/index.mjs (esbuild)
│   │   └── src/{index.ts, app.ts, routes/, bot/, services/, lib/, middlewares/}
│   ├── web/                 @workspace/web — адмінпанель (React 19 + Vite + Tailwind v4) → dist/
│   │   └── src/{App.tsx, pages/, components/, lib/}
│   └── mockup-sandbox/      пісочниця UI-макетів (поза прод-системою)
├── lib/
│   ├── db/                  @workspace/db — Drizzle-схема (єдине джерело правди)
│   │   └── src/{index.ts, schema/workers.ts}
│   └── api-spec / api-zod / api-client-react   OpenAPI/orval-скафолд (майже не використовується)
├── scripts/                 дрібний workspace (placeholder)
├── deploy/                  Caddyfile, DEPLOY.md, build.sh, schema.sql
├── ecosystem.config.cjs     pm2 (процес `grafik-bot`)
├── CLAUDE.md / HANDOFF.md / PROJECT_MAP.md / replit.md(legacy)
└── pnpm-workspace.yaml, tsconfig.base.json, .env (не комітиться)
```

---

## Основні entry points

| Що | Файл | Нотатки |
|----|------|---------|
| Процес бекенду | `artifacts/api-server/src/index.ts` | `app.listen($PORT)` → `loadStates()` → `bot.launch()` (polling) → `startScheduler()`; graceful shutdown |
| Express-застосунок | `artifacts/api-server/src/app.ts` | helmet/cors/cookies/pino → `/api` → статика `web/dist` + SPA-fallback |
| Роутер API | `artifacts/api-server/src/routes/index.ts` | монтує health + auth + admin-api |
| Telegram-бот | `artifacts/api-server/src/bot/index.ts` (+ `instance.ts`) | усі обробники; запуск з index.ts |
| Веб-SPA | `artifacts/web/src/main.tsx` → `App.tsx` | роути wouter, гард за роллю |
| Схема/клієнт БД | `lib/db/src/index.ts` (+ `schema/workers.ts`) | експорт `db` + таблиці/типи |

---

## API routes — індекс

Повний довідник маршрутів з деталями поведінки/гейтів — **[docs/API_ROUTES.md](docs/API_ROUTES.md)** (великий; читати цільово — grep по маршруту/слову). Тут — лише навігаційний індекс.

Префікс `/api`. Сесійний cookie + CSRF-заголовок на мутаціях; гейти `requireCap` — див. «Ролі доступу».

| Група | Код | Що всередині |
|-------|-----|--------------|
| Auth / сесії | `routes/auth.ts` | login, 2FA, telegram-webapp (Mini App), web-lang/web-prefs, logout, me |
| Працівники / документи | `routes/admin-api.ts` | workers CRUD + fire/restore, invite, документи + файли, document-types |
| Довідники | `routes/admin-api.ts` | companies, positions, factories (+join-link) |
| Водії / авто | `routes/admin-api.ts` | drivers, driver-board, driver-days, mileage, vehicles |
| Замовлення / доступність | `routes/admin-api.ts` | orders, availability (+missing/remind) |
| Графік | `routes/admin-api.ts` | weeks, schedule: generate/approve/entry/copy-day/clear/shift-override/shift-cancel, driver-assignments, notify-*, email, excel |
| Облік годин / відсутності | `routes/admin-api.ts` | hours (+report, factory-parse/apply/codes, exclusions, confirm/notify), absences, absence-requests, reliability, hours-reports, worker-days, unplanned/link |
| Аванси | `routes/admin-api.ts` | advances CRUD + approve/reject/paid, svodni-pending/applied, gratyfikant-ліста |
| Фінанси (owner) | `routes/{bank,cash,cashflow,obligations,invoices,costInvoices,pnl,payroll,fuel,ksef}.ts` | витяги банків, каса + звірки, кешфлоу/баланс, належності, реєстр фактур, фактури коштові + Drive-архів + аудит, P&L (клієнти/міста/actuals), зведені ЗП, пальне Orlen, KSeF-синк |
| Прибирання | `routes/cleaning.ts` | вспульноти, дохід, винагородження, працівники + позиції оплат, видатки, P&L |
| Сводні | `routes/svodni.ts` | рядки/локи/from-hours/rematch/sync, фабричні правила konto/готівки, перенесення знять (транспорт/одяг/залічки/бадання/штрафи/пропуски), profile-impact/apply, lock-pending |
| Gratyfikant | `routes/gratyfikant.ts` | імпорт умов/PESEL з nexo, статус, лісти до виплат |
| Хостели | `routes/hostels.ts` | довідник, проживання, кімнати, платежі, шахматка, umowa, fill-deductions |
| Штрафи | `routes/penalties.ts` | реєстр kar + перенесення в Kara сводної |
| Автопарк / Транспорт / Одяг | `routes/{fleet,transport,clothing}.ts` | картки авто/ремонти/алерти, журнал виїздів, ставки водіїв, зняття за довіз (+платний довіз), магазин/видача/зняття одягу |
| Рекрутинг | `routes/admin-api.ts` | funnels, candidates + activity/convert/followup, staff |
| Адміни / ролі | `routes/admin-api.ts` | admins CRUD + invite/reset-web, roles (лише `is_main`) |
| Безпека | `routes/security.ts` | сесії, журнал входів, revoke, logout-everywhere (лише `is_main`) |
| Інше | `routes/admin-api.ts` | dashboard, attention, live, notifications, broadcast, reports, drive/link |
| Задачі / календар працівників | `routes/tasks.ts`, `routes/taskIcal.ts`, `routes/workersCalendar.ts` | задачі/групові/зустрічі, «Мій день», автозадачі й «Як вирішити», шаблони, iCal, календар подій працівників |
| Умови / підпис / шаблони | `routes/contracts.ts`, `routes/sign.ts`, `routes/documentDelivery.ts` | генерація пакетів, надсилання на підпис (Mini App), підпис працівника, підпис фірми з печаткою, дати, бібліотека шаблонів, анкета |
| Скан паспорта / анкета | `routes/passportScan.ts` | публічні токен-сторінки скану (OCR MRZ), анкета, karta pobytu, конверт кандидата |
| Легалізація | `routes/legalization.ts` | дашборд, документи-слоти, правила легальності, типи документів, worker_factories, статус для виплат |
| Проєкти | `routes/sushi.ts`/`routes/andros.ts` (очік.) | вкладки-заготовки /sushi, /andros — функціонал переносить колега PR-ами |

> `routes/bot.ts` має `POST /webhook`, але **не змонтований** — бот працює в polling.

---

## Bot flow

Telegraf, **long-polling**, один інстанс. Деталі — [`artifacts/api-server/src/bot/README.md`](artifacts/api-server/src/bot/README.md).

- **Вхід:** `bot.start` обробляє deep-links `?start=...` (префікси: `emp`=привʼязка працівника, `drv`=водія, `adm`=адміна, `ref`=реферал, `fac`=самореєстрація на фабрику старим способом (ім'я в чаті), `facs`=новим (скан паспорта + анкета на вебі; перехідний період з 06.09.2026); вибір мови). Усі invite-коди — **криптовипадкові** (`lib/invite.ts` `randomInviteCode`, base32), не послідовні й не `Math.random`; токен працівника одноразовий (обнуляється при привʼязці). Команди: `/adminsetup`, `/getid`, `/invite`.
- **Навігація:** reply-keyboard меню за роллю (`menus.ts`); `bot.hears` (~53, двомовний матч через `bhears`). Головний водій має web_app-кнопку «🖥 Панель призначень» (Telegram Mini App: відкриває `/driver-shifts` панелі з авто-логіном через `POST /auth/telegram-webapp`; зʼявляється лише коли задано `WEB_APP_URL`).
- **Дії:** inline-кнопки `bot.action` (~32) — підтвердження відсутностей, мова, редагування графіку.
- **Введення:** `bot.on("text"|"photo"|"document")` у межах активного кроку діалогу.
- **«Мій графік» працівника — поденні стани:** зміна показується лише з розісланого запису (`sent_at`); день без зміни = «вихідний» ТІЛЬКИ якщо день фабрики released (хтось із фабрики отримав розсилку) або порожній день released-тижня; інакше — «⏳ ще не затверджено» (`sched.pending`/`sched.notApprovedWeek`, 5 мов). «Затвердити день» у веб-графіку = розсилка (`POST /schedule/notify` з `day` → `sent_at`), окремого статусу дня немає. Таби «Цей/Наступний тиждень» — завжди. Бот-затвердження тижня пише `schedule_approvals` по фабриках (дзеркально до веб `/schedule/approve`).
- **Стан діалогів:** власний (`state.ts`) — in-memory Map + write-through у `user_states` (переживає рестарт; відновлення `loadStates()`).
- **Ролі:** працівник / водій / головний водій / офіс-адмін (керування переважно у веб-панелі).

---

## Cron / jobs

`services/scheduler.ts` (node-cron, **Europe/Warsaw**), шле через `bot`:

| Розклад | Завдання |
|---------|----------|
| `0 {година} * * 0` (нд, типово 18:00) | Нагадування заповнити доступність (кому бракує) + зведення адмінам |
| `*/15 * * * *` | Пресмінні сповіщення (~2 год до старту зміни) працівникам і водієві; pickup-нагадування водієві (~60 хв до **кінця** зміни); дедуп `sentToday` |
| `0 19 * * *` | Прогалини забору (pickup) на завтра → головному водієві з inline-вибором водія (`services/pickupGaps.ts`) |
| `0 0 * * *` | Скидання дедуп-трекера |
| `0 4 * * *` | Housekeeping: прибирання трекінгу повідомлень + старих `notifications` |
| `0 6 * * *` | Імпорт банківських витягів MT940 з Drive → `bank_transactions`/`bank_statements` (ідемпотентний, `services/bankStatements.ts`) + фактури витрат, зведені ЗП, KSeF-синк (вкл. `matchKsefPayments`; статус → settings `ksef_last_sync`) + **архів фактур на Drive** (`services/invoiceArchive.ts`: KSeF-XML і скани, яких ще нема на Диску), контрагенти, авто-«виплачено» авансів, попередження про сплив консентів. Каса зі STAN KASY **більше не синкається** (таблиця виведена 08.2026) |
| `10 7,11,15,19 * * *` | Оперативний банк (Enable Banking, `services/bankApi.ts`): транзакції+баланси по консентах → одразу матчинг оплат KSeF і авансів; алерти власнику. 4 рази/день — PSD2-ліміт фонових запитів |
| `0 9 1 * *` | Місячний CFO-звіт за попередній місяць (`services/cfo.ts`) |
| `0 8 * * 1` | Автопарк: дайджест спливу страховок/техоглядів (30 дн) → головний водій + головний адмін (`services/fleet.ts`) |
| `*/15 * * * *` | Семпл здоровʼя сервера: loadavg + MemAvailable з `/proc/meminfo` → ролінг-вікно 7 днів у `settings` (`server_stats_samples`); диск ≥90% → негайний алерт, раз на день (`services/serverStats.ts`) |
| `0 8 * * 1` | Тижневий дайджест сервера → головний адмін: диск (використано/вільно, розмір БД і `uploads/`), CPU/RAM за тиждень (сер./пік), аптайм, вердикт «чи треба покращувати» (`services/serverStats.ts`) |

| `30 6 * * *` | Модуль «Задачі»: бекфіл першого робочого дня з явок (`services/firstWorkDate.ts`) → перерахунок легальності всіх активних → **автозапит документів у працівників** (`services/docRequests.ts`: self-service типи + Telegram — запит у бот з лінком `/docs/:token`, нагадування за драбиною 3/7 днів; відсутні документи НЕ просимо; офісна задача лише «не надіслав» після 7 днів мовчання або коли до строку ≤ 7 днів; вікно «документ спливає» 14 дн. (типи зі своїм renewal_lead_days мають пріоритет), «умова» 7 дн.) → генератор автозадач (`services/taskAutoRules.ts`: створити/оновити/`auto_resolved`, одна задача на випадок по `source_key`) → нагадування за драбиною 24/14/7/0 (жовта зона 24 дн. / червона 7 — правило легальності `defaults.lead_days`, єдине джерело для задач, автозапиту, дашборду й підсвітки) → ескалація головному після N днів прострочення |
| `5 0 * * *` | Модуль «Задачі»: перенос невиконаного з «Мого дня» на сьогодні (`rolloverPlanned`, лічильник переносів); виповідзення — звільнити всіх, у кого `workers.termination_date` настала (`fireDueTerminations`, `services/workerFire.ts`) |
| `*/5 * * * *` | Модуль «Задачі»: тік дайджестів (`services/taskDigest.ts`) — ранковий дайджест і вечірній підсумок у час із налаштувань (типово 07:30 / 17:30), дедуп по `settings` `tasks.digest.sent`/`tasks.evening.sent`, вихідні за прапорцем |
| `0 8 * * 1` | Модуль «Задачі»: тижневий звіт контролю головному адміну (`sendWeeklyControlReport`: по адмінах виконано/відкрито/прострочено/середній час) |

`setReminderHour()` перезапускає завдання. `pruneNotifications()` тримає таблицю обмеженою (30 днів / 300 записів). Дедуп пресмінних (`sentToday`) віддзеркалюється в `settings` — переживає рестарт pm2.

---

## Database schema overview

Drizzle, уся схема в `lib/db/src/schema/workers.ts`. Групи таблиць:

- **Довідники:** `companies`, `factories`, `positions`, `factory_positions`, `workers` (`self_transport` = доїжджає сам → поза водійським флоу, явку ставить графікова; `worker_code` = публічний послідовний id для показу, `invite_code` = криптотокен привʼязки Telegram через `?start=emp<code>`), `worker_factory_codes` (особистий номер працівника в системі фабрики, unique пари worker+factory і factory+code; імпорт годин матчить по ньому першим), `drivers`, `vehicles` (автопарк: номер/марка/місткість; веде головний водій у боті «🚙 Авто» або сайт Водії→Автопарк), `admins`, `roles` (динамічні ролі веб-панелі: pages+caps)
- **Планування:** `factory_orders`, `availability`, `schedule_weeks`, `schedule_entries` (має `sent_at` — «Мій графік» у боті показує лише розіслане; `absence_excused` = виправданий пропуск — поза підсумками/штрафом, `absence_penalty` = override штрафу zł, NULL = стандарт 200, 0 = анульовано), `schedule_approvals`, `driver_shift_assignments` (`kind`: delivery|pickup), `shift_cancellations` (скасовані клітинки week+factory+day+shift, unique), `factory_shift_overrides` (разова зміна: factory+date+shift+start/end, unique; час має пріоритет над `factories.shifts` — резолвиться через `services/shiftOverrides.ts`)
- **Операції:** `driver_trips`, `driver_workdays` (зміна водія: виїзд/повернення + одометр + `vehicle_id`), `unplanned_workers` (`replaces_worker_id` = кого замінив; замінений отримує absent з причиною «заміна» → reliability рахує як скасовано), `absence_requests` (`shift NULL` = вихідний на цілий день; блокує генерацію вже в pending), `hours_disputes`, `advance_requests`, `monthly_reports` (рапорт працівника: unique worker+month+factory)
- **Рекрутинг:** `funnels` (реферальна воронка гарантується на старті — `ensureReferralFunnel()`), `candidates`, `candidate_activity`
- **Документи:** `document_types`, `worker_documents` (файли — на диску `uploads/`, в БД лише метадата)
- **Банківські витяги:** `bank_transactions` (сирі рядки MT940: дата/напрям/сума/контрагент/призначення/тип, дедуп-хеш, `manual_category` — ручне перенесення), `bank_statements` (залишки `:60F:`/`:62F:` по витягах; `closing_derived` = обчислене закриття, коригується ланцюжком), `expense_categories` (категорії витрат: key/label/pattern-DSL/sort_order; owner-CRUD з веб-панелі), `counterparty_rules` (контрагент→категорія). `companies` має `legal_name`/`nip`/`is_active` (юрособи; TS неактивна). **Каса:** `cash_entries` (рухи ящиків office/yuriy/tetiana/hostel: kind opening|in|out, `manual_category`, `transfer_group`; рядки STAN KASY — read-only історія), `cash_categories` (довідник категорій каси: flow in|out, зарплатні — `payroll`+`city`, `requires_desc`), `cash_recon_acks` (зафіксовані розбіжності звірок: side=bank|cash|month|payroll + note)
- **Сводні:** `svodni_rows` (рядки місячної сводної: працівник/місто/фабрика/години/ставки/виплати), `svodni_tab_checks` + `svodni_tab_meta` (звірка й мета вкладок Google-таблиці), `svodni_locks` (локи затвердження: unique period_month+city+factory_label, `''` = ціле місто), `hostel_deductions` (утримання за хостел по місяцях), `hostels` (довідник житла: місто/модель оренди whole|per_place/ціна/кауція/типова плата мешканця/фірма-платник), `hostel_stays` (проживання: працівник × хостел, від/до, індивідуальна плата; `to_date NULL` = живе; джерело генерації знять), `staff_allocations` (P&L по містах: %-поділ обслуговуючого персоналу між містами, ключ — нормалізоване імʼя з OFFICE-вкладки), `worker_changes` (журнал змін профілю з `effective_date`: історія станів людини; куди пропагували/що пропущено через лок; фундамент майбутніх сегментів усередині місяця)
- **Пальне:** `fuel_invoices` (шапки фактур Orlen: номер unique, дати, Ogółem нетто/VAT/брутто), `fuel_transactions` (транзакції wykaz-у: картка/№ авто/продукт/`is_fuel`/станція/`tx_date`+`tx_time`/літри/ціни/суми; unique invoice_id+lp, ресинк фактури замінює), `fuel_cards` (довідник флотових карток: картка → label/місто/водій/авто)
- **Штрафи:** `penalties` (штрафи по місяцях). Поля ставок: `factories.city/rate_brutto/rate_netto/night_addon`, `factory_positions.rate_netto`, `workers.agram_staz_bonus/agram_cash_bonus` (таблиці `svodni2_*` видалені 24.07.2026)
- **Папка водія (мігровано 31.07.2026, снапшот+звіти — `data-import/`, gitignored):** `vehicles` розширено (місто/фірма/власність/страховка/техогляд/статус/ціни/інвентар), `vehicle_expenses` (ремонти авто×місяць) + `vehicle_service_invoices` (фактури сервісів, довідково), `driver_trip_log` (архів виїздів 2022–2026: дата/фабрика/водій/авто/одометри/люди/оплата, `source_ref` = файл|аркуш|рядок), `driver_trip_rates` (ставка водій×фабрика) + `drivers.trip_rate`, `transport_deductions` (зняття за довіз), `hostel_rooms`, `hostel_payments`, `clothing_items` (спецодяг; 12.08.2026 розширено життєвим циклом: `stock_id`/`size`/`condition`/`issued_at`/`returned_at`/`deducted_amount`/`deducted_month`) + `clothing_stock` (склад магазину: тип/назва/розмір/стан new|used/ціна/qty). Усі мігровані рядки мають `source_ref` — цифру можна відмотати до клітинки таблиці-джерела. `workers.self_transport_since` («діє з» прапорця self_transport), `worker_badania` (залічки за бадання — СПИСОК записів на людину: сума + entered_at/deducted/deducted_at/deducted_month; CRUD у профілі — `POST /workers/:id/badania`, `PATCH/DELETE /worker-badania/:id`; незняті — `GET /badania/pending` → вкладка «Бадання до зняття» на /advances з чекбоксами; перенесення вибраних/усіх у колонку Zaliczka BD сводної — `POST /svodni/apply-badania-deductions {month, ids?}` (cap svodni, рядок основної фабрики, сума ДОДАЄТЬСЯ до наявної Zaliczka BD, локи/самозвірка як у одягу); одиночні поля workers.badania_* видалені міграцією 2026-08-12-badania-list; історія знятих — `GET /badania/deducted` (підвкладка «Зняті»), відміна перенесеного — `POST /svodni/undo-badania-deduction {id}` (віднімає суму з клітинки Zaliczka BD тієї сводної з перерахунком, залочена вкладка — 409; зняте перенесенням НЕ відміняється простим PATCH — гард від зависання суми у сводній), `workers.nationality` (ukraine|belarus|africa|latin_america|central_asia|south_asia — прапорець біля імені в профілі/довозах/сводній; каталог — `web/src/lib/nationality.tsx` ↔ `NATIONALITIES` в admin-api, тримати синхронно), `clothing_types` (довідник типів одягу), `advance_requests.factory_id` (фабрика запиту залічки) + `paid_by` (хто вручну позначив виплату)
- **Сервісні:** `hours_month_exclusions` (приховані з місяця Обліку годин: worker+month unique, reason manual/vacation/not_started), `notifications`, `user_states`, `bot_messages`, `settings`, `admin_sessions` (сесії веб-панелі: `id`=`sid` у токені, `ip`/`user_agent`/`device`/`geo`, `revoked_at` → per-session ревокація), `login_events` (незмінний журнал входів: `event`=success|bad_password|bad_2fa|no_telegram|logout)

Деталі полів — у `lib/db/README.md` та самій схемі. **Зміни — вручну через `psql`** (не drizzle-kit).

---

## Зовнішні інтеграції

| Сервіс | Де | Призначення |
|--------|----|-------------|
| Telegram (Telegraf) | `bot/`, `bot/notify.ts` | бот + усі вихідні сповіщення (polling) |
| Google Sheets | `services/sheets.ts` | доступність працівників (матч за «Прізвище Імʼя») |
| Google Drive | `services/drive.ts` | експорт Excel-графіку (сегрегація посада→стать), звіти |
| Google Drive (витяги) | `services/bankStatements.ts` | читання MT940 з папки `WB {MM.YYYY}/{юрособа}` (service account, `BANK_STATEMENTS_FOLDER_ID`); Kokos — чужий бізнес, пропускається. Чистий шар (кодування/парсер/матчинг юросіб) — `services/mt940.ts`, без БД/Drive, покритий тестами |
| SMTP (nodemailer) | `services/email.ts` | графік клієнту email-ом (тиждень/день, HTML + Excel-вкладення); відправник — Gmail office.eurosupp@gmail.com через app password (`SMTP_*` у `.env`) |
| PostgreSQL | `@workspace/db` | основне сховище |

Доступ Google: Sheets — через `GOOGLE_SERVICE_ACCOUNT_JSON` (таблиця розшарена на service account); **Drive-завантаження — OAuth від реального користувача** (`GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`; перегенерація токена — `artifacts/api-server/get-google-token.mjs`; застосунок має бути **Published**, інакше токен вмирає за 7 днів → `invalid_grant` ламає всі Drive-операції).

---

## Ролі доступу

**Динамічні** — живуть у БД-таблиці `roles` (`pages` jsonb + `caps` jsonb), редагуються головним адміном у Налаштування → «Користувачі та ролі». Каталоги capability/сторінок — `api-server/src/lib/roles.ts` ↔ `web/src/lib/roles.ts` (тримати синхронними). Гейти API: `requireCap`/`requireAnyCap`; capabilities: `editData`, `viewFinance`, `factoryRates` (ставки в налаштуваннях фабрики — брутто/нетто/нічна/фактурна + ставки посад; без NIP/P&L-підпису — ті лише `viewFinance`), `assignDrivers`, `deleteWorkers`, `svodni` (офіційна частина сводних), `svodniSensitive` (закритий шар: księgowość, готівка), `costInvoices`, `invoiceScan` (сканування фактур у боті — кнопка «📄 Фактура»), `fuel`, `hostelOps` (операційне ведення хостелів: кімнати/проживання/платежі — головний водій, без фінансового шару).

**Глобальні use-гейти роутерів — скоуп по префіксу шляху** (`router.use("/bank", requireCap(...))`), інакше в Express вони зачіпають прохідні запити до роутерів, змонтованих нижче у `routes/index.ts` (латентний баг до 12.08.2026: роль без `viewFinance` не діставалась до /cash, /cost-invoices, /fuel). Новий роутер з власним гейтом — обовʼязково скоупити.

- **owner** — незмінний суперюзер (повний доступ у коді, редагування/видалення ролі заблоковано).
- **scheduler** — системна, редагована (типово editData+assignDrivers, без фінансів).
- **driver** — системна, редагована (типово assignDrivers + водійські сторінки). У **боті** людей з веб-роллю `driver` ведуть як водіїв (`bot/roles.ts` фільтрує їх з адмінів).
- Кастомні ролі — повний CRUD (лише `is_main`).
- **`admins.is_main`** — головний адмін (Yuriy, id=1): **єдиний**, хто керує ролями/користувачами (`requireMainAdmin`). У бота немає шляху видати `is_main`.

---

## Production / deploy flow

> **Джерело правди по продакшн-середовищу — [`docs/infrastructure/`](docs/infrastructure/)**: живий сервер
> ([PRODUCTION.md](docs/infrastructure/PRODUCTION.md)), деплой/відкат ([DEPLOYMENT.md](docs/infrastructure/DEPLOYMENT.md)),
> БД ([DATABASE.md](docs/infrastructure/DATABASE.md)), експлуатація ([RUNBOOK.md](docs/infrastructure/RUNBOOK.md)),
> журнал інцидентів ([INCIDENTS.md](docs/infrastructure/INCIDENTS.md)). Деплой з нуля — [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

VPS (Ubuntu) + **Caddy** (HTTPS) + **PostgreSQL** локально + **pm2**. Гайд: [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

```bash
git pull
pnpm install
pnpm --filter @workspace/web run build         # → artifacts/web/dist
pnpm --filter @workspace/api-server run build   # → dist/index.mjs
psql "$DATABASE_URL" -c "…"                      # накатати зміни схеми (за потреби)
pm2 restart grafik-bot && pm2 save
```

Caddy проксіює на `$PORT`; `app.set("trust proxy", 1)` для коректних IP/secure-cookie. pm2 `autorestart` (max_restarts=30).

Довкола деплою:
- **CI** — GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): typecheck + тести api-server на кожен push/PR у `main`.
- **Скіл `/deploy`** ([`.claude/skills/deploy/SKILL.md`](.claude/skills/deploy/SKILL.md)) — виконуваний ранбук деплою для сесій Claude Code.
- **Скіл `/module-proposal`** ([`.claude/skills/module-proposal/SKILL.md`](.claude/skills/module-proposal/SKILL.md)) — формат пропозиції великого модуля для узгодження: HTML-артефакт «Механіка» + повний візуал екранів/бота/налаштувань (еталон — «Задачі та календар працівників», 06.09.2026).
- **Бекапи** — щодня 03:00 cron → [`deploy/backup.sh`](deploy/backup.sh) → `/root/backups/` (дамп БД + `uploads/`, ротація 14 днів); див. [DATABASE.md](docs/infrastructure/DATABASE.md).

---

## Ризикові місця

- **Подвійний polling бота** → `409 Conflict`. Рівно один `grafik-bot`; не запускати локальний бот на прод-токені.
- **Схема vs psql.** Міграції — SQL-файли в `deploy/migrations/` (`YYYY-MM-DD-тема.sql`), накатуються вручну `psql -f`; авто-запуску немає, тож легко розсинхронити код-схему й реальну БД. Завжди накатуй SQL + `typecheck:libs`. Файли з `CREATE INDEX CONCURRENTLY` не можна запускати однією транзакцією (`psql -1`).
- **Один процес = усе разом.** Падіння кладе і API, і бота, і панель (рятує pm2 autorestart).
- **Tailwind v4** не бачить динамічних класів — лише буквальні (повні класи в `web/src/lib/colors.ts`).
- **i18n-дублі** ключів → TS1117; не забувати EN-переклад + перевірку `uniq -d`.
- **Фінансові поля** мають лишатися owner-only і в API, і в UI.
- **Секрети:** `.env`, `GOOGLE_SERVICE_ACCOUNT_JSON`, SSH-ключ — не комітити/не розкривати. `minimumReleaseAge` у pnpm не вимикати.
- **Google sharing.** Якщо Sheet/Drive не розшарені на service account — доступність/експорт мовчки не працюють.
- **Великі файли:** `bot/index.ts` (~5000) і `routes/admin-api.ts` (~5100) — зміни робити точково, не переписувати масово.
- **Час/зміни** рахуються у Europe/Warsaw — не вводити локальні таймзони у логіку змін. Прод-сервер у Europe/Berlin: `new Date(...).toISOString()` для дати-рядка зрізає день — дати рахувати рядком.
- **Місячні звіти** зараховують зміни за фактичною датою (`entryDateStr`), не за понеділком тижня — тиждень легально перетинає межу місяця.
- **`driver_shift_assignments.kind`:** транспортна логіка (посадка/поїздки/явка) фільтрує `kind='delivery'`; забутий фільтр «дублює» водіїв. Детекція pickup-прогалин продубльована (driver-board + `pickupGaps.ts`) — міняти обидва. **Фабрики без довозу (`uses_transport=false`) виключаються з усіх водійських поверхонь** (driver-board, pickup-прогалини, бот-флоу призначення/огляд тижня, лайв-зміни) — нова водійська поверхня мусить фільтрувати теж.
- **Множина змін поверхні — від записів, не від `shiftCount`.** `factories.shift_count` — лише «стандартний набір» для показу порожньої сітки; запис (`schedule_entries`) на зміні поза лімітом (разова зміна, або лічильник зменшили пізніше) МУСИТЬ лишатися видимим і функціональним. Пуші, `/live`, `/driver-board`, pickup-прогалини, Excel і веб-сітка ітерують «налаштовані ∪ зміни з записами»; час зміни — спершу `factory_shift_overrides` (через `services/shiftOverrides.ts`), потім `factoryShifts()`. Нова поверхня зі змінами — той самий патерн; фільтр `slice(0, shiftCount)` там — регресія (саме він «губив» графік при зміні кількості змін).
- **Статус тижня `approved` ≠ «тиждень у роботі».** Веб працює з draft-тижнями (створює їх при призначенні водіїв наперед); затвердження однієї фабрики ставить approved на весь тиждень. Вибір тижня — тільки `services/weeks.ts` (`resolveWeekRow`/`ensureWeekRow`): водійські поверхні й крон-пуші резолвлять «approved ?? останній draft», approved-only фільтр там — регресія (інцидент 27.07.2026). Робітничі екрани і фінанси/облік — свідомо approved-only.
- **Розсилки реально шлють людям** (`/hours/report-remind`, `/availability/remind`, notify-ендпойнти) — не «тестувати» на проді.
- **Класифікація витягів: bucket-и — в `services/bankClassify.ts` (код), категорії витрат — у БД-таблиці `expense_categories`** (owner редагує на /bank: назви, патерни, додавання/видалення; перший збіг за `sort_order` виграє; кеш у пам'яті інвалідовується мутаціями CRUD). Патерн — міні-DSL (`patternCondition`): рядок = АБО-альтернатива, ` + ` = І, частина = Postgres regex. У Postgres межа слова — `\y`, **не** `\b` (тихо не матчиться); польські відміни (bankomat/bankoma**cie**) — матчити корінь. Видалення категорії переносить її ручні транзакції в `'other'` і зносить її правила контрагентів. Тест-харнес сідить категорії з `DEFAULT_EXPENSE_CATS` після кожного truncate. Кредитний рахунок `PL75…8415` виключений з операційної каси (борг). Нова юрособа/назва підпапки на Drive = правка `matchCompanyName` у `bankStatements.ts`.
- **Enable Banking: повну історію транзакцій банк віддає лише свіжому консенту** (одразу після SCA-авторизації); фонові запити бачать ~2 тижні. Новий консент → одразу запусти синк, не чекай крону, інакше в `bank_transactions` лишиться прогалина, яку MT940 закриє аж наступного місяця, а KSeF/аванси тим часом «не бачать» оплат (інцидент 30.07.2026 — див. `docs/infrastructure/INCIDENTS.md`; бекфіл — перенесення рядків з БД, де історія є, дедуп по `dedup_hash`).
- **esbuild `keepNames: true` в `artifacts/api-server/build.mjs` — не прибирати.** node-fetch (усередині telegraf) перевіряє сигнал по `constructor.name === "AbortSignal"`; без keepNames esbuild при колізії імен перейменовує клас поліфіла (`AbortSignal2`) → полінг бота мертвий з «Expected signal to be an instanceof AbortSignal» (проявилось 08.2026 після оновлення залежностей).
- **`xlsx` (SheetJS) — пін CDN-тарбола `xlsx-0.20.3` (не npm!).** У package.json залежність — URL `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, бо SheetJS публікує фікси лише на своєму CDN (npm застряг на вразливій 0.18.5: prototype pollution CVE-2023-30533 + ReDoS CVE-2024-22363, обидва на `XLSX.read`). **Не «оновлювати» назад на npm-версію** (`^0.18.x`) — це регресія в CVE. `minimumReleaseAge` на URL-тарбол не діє (свідомий виняток, офіційний CDN + точний пін). API той самий; `.xls` (старий бінар) 0.20.x читає. Використання: `XLSX.read` у боті (імпорт графіка/кандидатів, за гейтом `isAdmin`) + `services/drive.ts` (свої файли з Drive), `XLSX.write` — генерація.

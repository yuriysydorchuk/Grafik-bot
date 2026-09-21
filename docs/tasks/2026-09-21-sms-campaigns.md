# Задача: SMS-кампанії (персональні лінки → продажна сторінка → бот → кандидат)

> Контекст проєкту: [`HANDOFF.md`](../../HANDOFF.md) · [`CLAUDE.md`](../../CLAUDE.md) · [`PROJECT_MAP.md`](../../PROJECT_MAP.md)
> Пропозиція (узгоджена 21.09.2026): https://claude.ai/code/artifact/08e29f9f-d103-4f2b-ace5-27d388a3b6a4 · база отримувачів: `docs/DRIVE_MAP.md` → «Таблиці контактів» (`Drive-контакти-ES-combined-2026-09-17.xlsx`, аркуш «Перевірені номери»)

- **Статус:** 🔄 в роботі — батчі 1–4 зроблено 21.09 (локально, чекає тесту власника); далі батч 5 (прод: ключі, міграції, тест 300)
- **Дата:** 2026-09-21
- **Автор/сесія:** Claude (Fable), сесія «карта Drive → контакти → SMS»

---

## Мета

Панель уміє: імпортувати список отримувачів з xlsx, згенерувати кожному персональний токен-лінк, слати SMS через SMSAPI або SMS-Fly батчами у вікні, показувати воронку `відправлено → доставлено → відкрив сторінку → записатись → у боті → анкета → на зміні`. Публічна сторінка `/r/<токен>` (продажна, uk/ru/en, з іменем) з кнопками Telegram / подзвонити / WhatsApp. Бот за `?start=sms<токен>` знає людину і створює кандидата у воронці «SMS-кампанії». Активним працівникам SMS не йде — їм «приведи друга» в бот через наявну реферальну розсилку.

Критерій готовності: тестова кампанія на 300 реальних номерів (150 SMSAPI + 150 SMS-Fly) пройшла від імпорту до кандидата в Kanban; статистика й витрати збігаються з кабінетами провайдерів.

## Рішення власника (21.09.2026)

- Персональний лінк на кожного; клік = знаємо номер та імʼя. Лінк веде на продажну сторінку, з неї в бот.
- Активні працівники: без SMS, лише «приведи друга» в Telegram (безкоштовно).
- Окрема воронка «SMS-кампанії» (етапи як у «Реферали»).
- Тексти SMS максимально продажні, в межах частин SMS (8 текстів у пропозиції, вкладка «Тексти SMS»).
- Без STOP-обробки; без фільтра за старими статусами «не інтересно».
- Провайдери: SMSAPI і SMS-Fly обидва, з перемикачем; вибір після тесту на 300.
- Зі списку вилучено: клієнти/партнери, закордонні ліди, Work Permit Global, сторонні, поляки. Uber/UPartner лишаються.
- Відправку запускає лише головний адмін (owner).

**Припущення до підтвердження** (у коді — налаштування, не хардкод): короткий домен лінків = `SMS_LINK_BASE` (поки `WEB_APP_URL`, потім куплений короткий домен); вікно Вт–Чт 10:00–14:00, 1 500/день, батч 200 кожні 5 хв; UA-номери (+380) включаються лише для записів 2024–2026 (чекбокс при імпорті); цифри пропозиції (ставка, «до … zł/міс», житло, бонус, дата) — поля кампанії.

## Контекст

Шари: схема БД + міграція, API (новий роутер + публічний маршрут), бот (новий префікс start), веб (нова сторінка + публічна сторінка + налаштування), крон, зовнішні інтеграції (SMSAPI, SMS-Fly). Що вже є і перевикористовується (з розвідки 21.09):

- `candidates` / `funnels` / `candidate_activity` + `ensureReferralFunnel()` (`services/funnels.ts`), створення кандидата з бота за `?start=ref` (`bot/index.ts` ~:3573, з привʼязкою telegramId до кандидата з тим самим номером) — SMS-вхід іде тим самим шляхом.
- Публічні токен-маршрути до `authRequired` (`routes/index.ts` :47–52), `randomInviteCode(24)` (`lib/invite.ts`), rate-limit за префіксом (`routes/passportScan.ts` :44), `signature_events` як зразок журналу подій (ip/ua/device).
- Реферальна розсилка `services/referralCampaign.ts` (`sendReferralCampaign`, in-flight guard, тексти 5 мовами) — для активних працівників.
- Крон-патерн `services/scheduler.ts` (TZ Europe/Warsaw, `stopScheduler`), авто-правила задач `services/taskAutoRules.ts` (`AUTO_RULE_DEFS`, `source_key`, `resolveAssignee`).
- Ролі: `PAGE_KEYS`/`NOTIFY_KEYS` у `api-server/src/lib/roles.ts` ↔ `web/src/lib/roles.ts`; нав `web/src/components/Layout.tsx` група «Персонал».
- Згода на SMS-комунікацію вже є в анкеті (`PassportScan.tsx` :145, `CONSENTS_VERSION`).

## Модулі які можна чіпати

- `lib/db/src/schema/workers.ts` — нові таблиці `sms_campaigns`, `sms_recipients`, `sms_events`; колонки `candidates.source`, `candidates.campaign_id`, `candidates.language`
- `deploy/migrations/2026-09-22-sms-campaigns.sql` (нова)
- `artifacts/api-server/src/services/sms/` (нові: `provider.ts` інтерфейс, `smsapi.ts`, `smsfly.ts`, `campaigns.ts`, `sender.ts` (крон), `import.ts`), `services/scheduler.ts` (реєстрація кронів), `services/taskAutoRules.ts` (правило «відкрив сторінку, не зайшов»), `services/funnels.ts` (`ensureSmsFunnel`)
- `artifacts/api-server/src/routes/smsCampaigns.ts` (нова, з гейтом за префіксом), `routes/smsPublic.ts` (нова, `/r/:token` API), `routes/index.ts` (монтування до auth), `routes/admin-api.ts` — тільки `GET /candidates` (фільтр `campaignId`) і `POST /candidates` (нові поля)
- `artifacts/api-server/src/bot/index.ts` — лише гілка `?start=sms<токен>` перед фолбеком і `bot/i18n.ts` (тексти вітання 3 мовами)
- `artifacts/api-server/src/lib/roles.ts`, `artifacts/web/src/lib/roles.ts` — ключ сторінки `/sms-campaigns`, notify-тип `sms`
- `artifacts/web/src/pages/SmsCampaigns.tsx`, `SmsCampaignCard.tsx`, `SmsLanding.tsx` (публічна), `App.tsx` (маршрути + публічна гілка `/r/`), `components/Layout.tsx` (нав), `lib/api.ts` (типи/ендпойнти), `lib/i18n.tsx`, `pages/Settings.tsx` (вкладка «SMS-кампанії»), `pages/Recruitment.tsx` (фільтр «Кампанія», рядок джерела в картці)
- `docs/API_ROUTES.md`, `PROJECT_MAP.md`, `.env` (нові ключі — вручну власником), `CLAUDE.md` (короткий пункт правил)

## Модулі які не можна чіпати

- фінансовий блок (`svodni`, `payroll`, `bank`, `cash`, `cost-invoices`), `services/drive.ts`, `services/sheets.ts`
- реферальна механіка як така (`lib/referral.ts`, `services/referralCampaign.ts`) — лише виклик наявних функцій
- `routes/passportScan.ts`, `routes/sign.ts` — лише читаємо як зразок
- секрети/конфіг: `.env` (ключі додає власник), `ecosystem.config.cjs`, `pnpm-workspace.yaml`; `node_modules/`, `dist/`, `pnpm-lock.yaml`, `artifacts/mockup-sandbox/`

## План (батчі; кожен окремо перевіряється і коміт-иться)

**Батч 1 — схема + міграція + ядро (без UI).** `sms_campaigns` (id, name, kind `job|referral`, status `draft|test|sending|paused|sent|closed`, provider `smsapi|smsfly`, sender, texts jsonb {uk,ru,en}, landing jsonb, offer jsonb {factoryId, city, rate, monthly, housing, startDate, bonus}, schedule jsonb {days, from, to, dailyLimit, batchSize}, recruiterAdminId, funnelId, createdBy, created/updated); `sms_recipients` (campaignId, phone E.164, name, lang, segment, year, sourceFile, token unique 24, status, providerMsgId, sentAt, deliveredAt, failReason, candidateId, workerId, skippedReason); `sms_events` (recipientId, kind `sent|delivered|failed|view|cta_bot|cta_call|cta_wa|bot_start|form|hired`, at, ip, userAgent, device, meta jsonb); `candidates.source text`, `candidates.campaign_id int`, `candidates.language text`. Сервіси: `ensureSmsFunnel()`, `provider.ts` (`send(batch) → [{phone,msgId|error}]`, `status(msgIds)`, `hlr(phones)`, `price`), адаптери SMSAPI (`/sms.do`, `from`, `encoding utf-8`, `details`) і SMS-Fly (API v2 JSON), `campaigns.ts` (CRUD, імпорт з масиву рядків: валідація як у `scratch-drive-build2.py` `phone_check`, дедуп, розділення активних працівників → список для реферальної розсилки, генерація токенів), `sender.ts` (крон кожні 5 хв: вікно, ліміт, батч, in-flight guard; опитування статусів кожні 15 хв або webhook). Юніти: `phone_check`, розбиття на частини SMS (GSM/UCS-2), вікно відправки. Інтеграційні: імпорт + дедуп, крон бере батч і пише статуси (провайдер замокано).

**Батч 2 — публічна сторінка + бот.** API `GET /api/r/:token` (дані для сторінки, подія `view`, rate-limit), `POST /api/r/:token/event` (`cta_bot|cta_call|cta_wa`, без CSRF-заголовка не треба — GET/POST з виключенням у гарді як `/auth/login`... рішення: POST через `sendBeacon` → додати шлях у виключення CSRF). Веб: `SmsLanding.tsx` (мобільна, 3 мови, sticky CTA, «приведи друга»-варіант), гілка в `App.tsx` для `/r/`. Бот: `?start=sms<токен>` → отримувач → вітання мовою → кнопки (Хочу на роботу → існуючий flow анкети `facs` з фабрикою кампанії; Інше місто; Приведу друга → реферальний блок; Не зараз) → кандидат у воронці «SMS-кампанії» з `source='sms'`, `campaign_id`, `language`, `assigned_admin_id` = рекрутер кампанії (фолбек `resolveAssignee`); подія `bot_start`; при заповненні анкети → подія `form`; при конвертації кандидата → `hired`. Нагадування 24 год без анкети (одне).

**Батч 3 — панель.** Сторінка `/sms-campaigns` (список з воронками), картка (плитки, воронка, вкладки Отримувачі / Тексти SMS / Сторінка / Розклад / Журнал, експорт xlsx), модалка створення (3 кроки: параметри → імпорт xlsx з мапінгом колонок і підсумком перевірки → підтвердження з вартістю; лічильник частин SMS з урахуванням кодування; «тест на мій номер»), Налаштування → вкладка «SMS-кампанії» (провайдери: статус ключів з env, підпис, тест; дефолти; бібліотека фото і FAQ для сторінки), ролі: ключ сторінки + notify `sms`, i18n uk/en, нав у «Персонал». Рекрутація: фільтр «Кампанія», рядок джерела в картці кандидата. Дашборд: плитка (кліки 7 дн, нові кандидати, «відкрили, не зайшли», у черзі).

**Батч 4 — автоматика й звіти.** Правило задач `sms_no_bot` (щодня 09:00, групова, рекрутеру кампанії, дедуп по кампанії+дню), звіт у бот після спорожніння черги і через 3 дні (`notifyAdminById`, notify-тип `sms`), плитка кампанії «активним працівникам → приведи друга» = виклик `sendReferralCampaign(workerIds)` з журналом у кампанії.

**Батч 5 — прод і тест.** Ключі `SMS_SMSAPI_TOKEN`, `SMS_SMSFLY_KEY`, `SMS_SENDER`, `SMS_LINK_BASE` у `.env` (власник), міграція на проді через `/deploy`, підпис відправника в обох провайдерів, HLR по списку, тест 300 (150/150), розбір, хвиля 1.

## Реалізація

**Сторінка v2 (21.09.2026, рішення власника):** без форми й бота — плитки вакансій (`landing.vacancies`, редактор у вкладці «Сторінка»; порожньо → одна з пропозиції) → по кліку опис і переваги → «Мене цікавить ця вакансія» (`GET /r/:token/e?k=interested&v=`; телефон відомий, рекрутер отримує картку в бот, людині «консультант звʼяжеться протягом 1 робочого дня») і «Порекомендувати друга» (`POST /r/:token/friend` імʼя + телефон → кандидат `source=sms_friend`); унизу контакти (`landing.contacts`: телефон, адреса + Google Maps, сайт, Instagram, Facebook; дефолти офісу). Токени 8 символів (`SMS_TOKEN_LEN`) і транслітеровані тексти GSM-7 — щоб SMS вмістилось в одну частину (текст власника: «u nas ye vakansiia dlia vas! Abo porekomenduite nas druziam i otrymaite bonus 300zl. Start cioho tyzhnia»). SMS-Fly: дія `SENDMESSAGE`, статус `DELIVRD`; тест на свій номер = справжній отримувач сегмента «тест». Перевірено живим SMS 21.09 (доставка 6 с, 0.069 zł/частина).

**Батч 4 (21.09.2026):** `services/sms/automation.ts`: (1) правило автозадач `sms_no_bot` (у `AUTO_RULE_DEFS`, lead 2 дн, вікно 7 дн) — одна групова задача на кампанію `smsnb:<id>` зі списком людей (імʼя · телефон · мова · лінк) у description, виконавець — рекрутер кампанії → `resolveAssignee`; auto_resolved, коли у вікні нікого; блок стоїть перед раннім виходом `collectCandidates` (порожня база працівників) і `Candidate.description` тепер оновлюється нічним прогоном; (2) денний звіт хвилі в бот (крон 15:05 Warsaw, тип сповіщень `sms` у `NOTIFY_KEYS` обох `roles.ts`, міграція `2026-09-22-sms-campaigns-notify.sql` вмикає owner і ролям зі сторінкою) + повідомлення про завершення кампанії із `sender.ts`; (3) нагадування «без анкети» (крон щогодини :40): статус `bot` 24–72 год, кандидат з Telegram і без worker_id, одне на людину (подія `remind`), текст `sms.remind` 5 мовами з кнопками анкети/пізніше; (4) `POST /sms-campaigns/:id/referral-active` + кнопка в картці «Приведи друга активним (N)» — пропущені `active_worker` отримують реферальну розсилку бота (`sendReferralCampaign` з чинними умовами), подія `referral_bot`, `activeWorkersPending` у відповіді картки. Тест: `services/sms/automation.integration.test.ts` (4/4), `routes/tasks.integration.test.ts` не зламано.

**Батч 3 (21.09.2026):** `routes/smsCampaigns.ts` (гейт по префіксу `/sms-campaigns` + `editData`; список/картка/PATCH, `preview-text`, імпорт xlsx у два кроки — `dry=1` з вгадуванням колонок за заголовками і підсумком, `dry=0` запис; отримувачі з фільтрами/пагінацією, журнал подій, експорт xlsx польською; `start`/`send-batch`/`test-sms` — лише `requireMainAdmin`; `pause`/`close`), сервіс: `importRecipients({dry})`, `listRecipients`, `recipientEvents`, `smsDashboardSummary`. Веб: `pages/SmsCampaigns.tsx` (плитки, список з воронками, модалка «Налаштування» з статусом ключів провайдерів, майстер 3 кроки: параметри+пропозиція → тексти з лічильником частин → імпорт з перевіркою), `pages/SmsCampaignCard.tsx` (плитки воронки, дії за статусом і `isMain`, вкладки Отримувачі / Тексти SMS / Сторінка / Розклад і пропозиція / Імпорт, модалка подій, тест на мій номер), `lib/smsParts.ts`. Роль: `/sms-campaigns` у `PAGE_KEYS` обох `roles.ts`, нав «Персонал», міграція `2026-09-22-sms-campaigns-page.sql` (сторінка ролі `scheduler`). Рекрутація: бейдж «📨 SMS» + лінк на кампанію в картці кандидата, `GET /candidates?campaignId=`. Тест: `routes/smsCampaigns.integration.test.ts`. Смоук через web-screens: список/майстер/картка/вкладки у світлій і темній темі — без console errors.

**Батч 2 (21.09.2026):** `routes/smsPublic.ts` (`GET /r/:token` → дані сторінки + подія view; `GET /r/:token/e?k=` → cta-події; rate-limit; монтується до auth у `routes/index.ts`), веб `pages/SmsLanding.tsx` (мобільна продажна сторінка uk/ru/en з перемикачем, чіпи/FAQ з лендінгу кампанії або вбудовані, кнопки Telegram/дзвінок/WhatsApp з подіями через GET-beacon) + гілка `/r/` в `App.tsx` (без /auth/me), бот `bot/handlers/smsCampaign.ts` (`?start=sms<токен>`: подія bot_start, кандидат з даними отримувача у воронці «SMS-кампанії» з source/campaign_id/language, привітання мовою з пропозицією, кнопки job/ref/later; job → `createSelfScanToken` з candidateId; ref → реферальний код лише для отримувача-працівника), i18n `sms.*` 5 мовами, хуки `markCandidateSmsEvent` (анкета → form у passport-scan confirm, convert → hired). Тести: `routes/smsPublic.integration.test.ts`, `bot/smsCampaign.integration.test.ts`.

**Батч 1 (21.09.2026):** схема (`sms_campaigns`, `sms_recipients`, `sms_events`, `candidates.source/campaign_id/language`) + міграція `2026-09-22-sms-campaigns.sql` (накатано локально і на тестову БД); `services/sms/phone.ts` (нормалізація, перевірка мобільних PL/UA/BY, підозрілі, частини SMS GSM-7/UCS-2, рендер тексту), `provider.ts` (SMSAPI + SMS-Fly адаптери, підміна для тестів, ключі з env `SMS_SMSAPI_TOKEN` / `SMS_SMSFLY_KEY` / `SMS_SMSFLY_URL` / `SMS_SENDER` / `SMS_LINK_BASE`), `campaigns.ts` (воронка «SMS-кампанії» kind=sms, CRUD, імпорт з дедупом/валідністю/активними працівниками → skipped+worker_id/UA-фільтром, токени 24 симв., події, статистика з оцінкою витрат), `sender.ts` (вікно Варшави, денний ліміт, батч, in-flight guard, опитування статусів, тест-SMS), крони в `scheduler.ts` (*/5 і кожні 15 хв). Рішення: `sent_at` пишеться часом батча (крон = зараз; тести підставляють дату), дублі й номери без цифр в отримувачі не вставляються (лише рахуються у підсумку імпорту).

- [ ] i18n: нові тексти в укр і EN (`web/src/lib/i18n.tsx`), бот — uk/ru/en у `bot/i18n.ts`
- [ ] Tailwind v4: класи буквально
- [ ] Ролі: `api-server/src/lib/roles.ts` ↔ `web/src/lib/roles.ts`; запуск відправки — `requireMainAdmin`
- [ ] Схема БД: SQL через `psql`; `pnpm run typecheck:libs`

## Тести

- [x] `pnpm run typecheck` ✓ (21.09)
- [x] `pnpm --filter @workspace/api-server run test` — 358 pass / 0 fail (юніти `services/sms/phone.test.ts`)
- [x] інтеграційні `services/sms/campaigns.integration.test.ts` з `TEST_DATABASE_URL` — 7/7 (імпорт/дедуп/активні/UA, батч у вікні + ліміт, статуси, токен, воронка вперед); start=sms → кандидат — батч 2
- [ ] `pnpm --filter @workspace/api-server run build`, `pnpm --filter @workspace/web run build`, `pm2 restart grafik-bot`, смоук через `web-screens`
- Ручні: імпорт реального xlsx (аркуш «Перевірені номери»), тест на свій номер через обох провайдерів, клік по лінку з телефону без Telegram і з Telegram.

## Ризики

- Гроші: відправка незворотна — гейт owner + підтвердження з вартістю + in-flight guard + денний ліміт; провайдерські помилки не мають повторно списувати (ідемпотентність по recipientId).
- Публічний маршрут `/r/:token` — rate-limit, токен 24 симв., без персональних даних у відповіді понад імʼя.
- Кирилиця в SMS = дорожче; лічильник у UI має рахувати так само, як провайдер.
- Один polling-інстанс бота: новий префікс не ламає наявні (`fac`/`facs`-урок — перевіряти порядок).
- Персональні дані: список лише в БД; xlsx не в git; експорт лише зі сторінки з cap.

## Handoff для наступної сесії

- **Зроблено:** пропозиція узгоджена; батчі 1–4 закомічено 21.09 (ядро, публічна сторінка, бот, панель `/sms-campaigns`, автоматика).
- **Лишилось:** батч 5 — прод (лише після явного схвалення власника): ключі в `.env` (`SMS_SMSAPI_TOKEN`, `SMS_SMSFLY_KEY`, `SMS_SENDER`, `SMS_LINK_BASE`, `SMS_OFFICE_PHONE`), 4 міграції `2026-09-22-sms-campaigns*.sql` через `/deploy`, реєстрація підпису відправника у провайдера, HLR-перевірка, тест 300 номерів (по 150 на провайдера), вибір провайдера, хвиля 1. Перед деплоєм — ревʼю diff через `agy`/`codex`.
- **Відкриті питання / рішення власника:** короткий домен; цифри пропозиції; вікно/ліміт; UA-номери — див. «Припущення».
- **Як перевірити поточний стан:** артефакт + цей файл; база отримувачів у `data-import/drive-map-combined-2026-09-17/`.

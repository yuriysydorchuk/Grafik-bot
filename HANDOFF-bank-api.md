# HANDOFF: Банківські API (open banking) — етап 0, розвідка

**Мета:** дивитися оплати по рахунках трьох юросіб майже наживо через API + прибрати ручне
скачування MT940. Рішення: агрегатор **Enable Banking** (api.enablebanking.com) — один конектор
на всі наші банки (**BNP Paribas PL, mBank PL, Erste**; країну рахунку Erste уточнити).
MT940 з Drive лишається джерелом правди для звірки до злотого — API-шар буде «оперативним».

**Обмеження PSD2:** згода (consent) живе ~180 днів → раз на пів року SCA-переавторизація по
кожному банку/юрособі. Головний ризик етапу 0: чи віддають банки **корпоративні** рахунки
через PSD2 AIS (перевіряється лише реальним підключенням, `psu_type: business`).

## Зроблено (27.07.2026)

- RSA-4096 ключ + self-signed сертифікат: `secrets/enablebanking/{key.pem,cert.pem}`
  (тека в .gitignore, не комітиться).
- Пробний скрипт: `artifacts/api-server/scratch-bankapi-probe.mjs` (JWT RS256 без залежностей;
  команди: app / aspsps / auth / session / accounts / balances / tx). Запуск:
  `node --env-file=.env artifacts/api-server/scratch-bankapi-probe.mjs <cmd>`.
- `.env`: додані `ENABLE_BANKING_APP_ID` (пустий — чекає реєстрації) і `ENABLE_BANKING_KEY_FILE`.

## Прогрес

- ✅ 27.07: акаунт зареєстрований, SANDBOX-застосунок `Grafik-bot` активний,
  `ENABLE_BANKING_APP_ID=e9fcd792-…7bcd` у `.env`.
- ✅ 28.07: повний sandbox-флоу пройдено probe-скриптом: `auth "Mock ASPSP" PL business` →
  SCA у браузері → `session <code>` → сесія з consent на 180 днів → `balances`/`tx`
  відповідають 200 (порожні, бо в мок-рахунку нема транзакцій — не блокер).
  Граблі: (1) auth-лінк короткоживучий — проходити одразу; (2) Mock ASPSP дає
  `server_error`, поки в CP-вкладці Mock ASPSP не створені рахунки.
- Sandbox для PL містить лише Bank Millennium + Mock ASPSP; реальні BNP/mBank/Erste —
  тільки в production-застосунку.

- ✅ 28.07: PRODUCTION-застосунок створений: `ENABLE_BANKING_APP_ID_PROD=477ab2a8-…c5d3`
  (у `.env`; той самий cert). Статус Inactive, але режим **link own accounts — self-serve**:
  «The application will be activated after account linking is complete. Only linked accounts
  can be accessed» — договір/активація для власних рахунків не потрібні.
  privacy_url/terms_url вказані як `https://161.97.117.151.sslip.io/privacy|/terms` —
  сторінок ще НЕМА, зробити мінімальні до підключення реальних банків.

- ✅ 28.07: **ГОЛОВНИЙ РИЗИК ЗНЯТО** — BNP віддає корпоративні рахунки через PSD2.
  Прив'язка рахунків у CP (self-serve) активувала застосунок; далі окремий auth-флоу
  застосунку (CP-прив'язка = вайтліст, сесія API = окрема згода — банк питає двічі, це норм).
  Прочитано наживо: рахунок KLINEX SP. Z O.O. (PL68…0001, PLN), баланси ITBD/ITAV,
  188 транзакцій за 30 днів — контрагенти/тайтли ті самі, що в MT940 (WYNAGRODZENIE…,
  VAT MPP, Faktura nr…) → класифікація сумісна. Сесія: consent до 2027-01-24.
  У конекторах PL є всі три банки: BNP Paribas, mBank, **Erste Bank Polska** (business, REDIRECT).
  Ключ прод-застосунку: `secrets/enablebanking/key-prod.pem` (браузер-генерований при
  створенні застосунку; `ENABLE_BANKING_KEY_FILE_PROD` у `.env`).
  Пам'ятка probe проти проду:
  `ENABLE_BANKING_APP_ID=$ENABLE_BANKING_APP_ID_PROD ENABLE_BANKING_KEY_FILE=secrets/enablebanking/key-prod.pem node --env-file=.env artifacts/api-server/scratch-bankapi-probe.mjs <cmd>`

- ✅ 28.07: **Erste Bank Polska** (екс-Santander BP — звідси код банку 1090 і продукти
  «Godne Polecenia») прив'язаний і читається: 3 рахунки EUROSUPPORT GROUP sp. z o.o.
  (основний PL79…7955, другий PL08…1834, Rachunek VAT PL09…7954), транзакції ок.
  Consent до 2027-01-24. Покрито 2/3 юросіб: Klinex@BNP, Eurosupport@Erste.

## ✅ 28.07: прод-код написаний і перевірений локально (ще НЕ задеплоєний)

Зроблено (усе під typecheck+тестами, 273 pass):
- **БД:** `bank_api_consents` + `bank_api_accounts` + `bank_transactions.source`
  (`mt940`|`api`); міграція `deploy/migrations/2026-07-28-bank-api.sql` (локально накатана).
- **`services/enableBanking.ts`** — чистий шар (JWT RS256, мапінг API-транзакцій у формат
  bank_transactions, дедуп-хеші з ординалами, матчинг власника→юрособа, класифікація
  алертів) — під тестами `enableBanking.test.ts`.
- **`services/bankApi.ts`** — I/O: startAuth/completeAuth/importSession/revoke, синк
  балансів+транзакцій по всіх активних згодах. Захисти: період ≤ останнього closing
  витягу НЕ тягнеться з API (джерело правди — MT940) і вичищається; алерти лише по
  свіжих (≤3 дн.) вставлених рядках (перший бекфіл не спамить); лоу-баланс — на
  перетині порогу вниз, VAT-рахунки пропускаються. GET /sessions/{id} віддає рахунки
  uid-рядками → деталі дотягуються `/accounts/{uid}/details` (граблі, вже враховано).
- **`routes/bank.ts`:** GET `/bank/api-consents`, `/bank/api-aspsps`, POST
  `…/start|/import`, GET `/bank/psd2-callback` (redirect назад на `/bank?api=…`),
  DELETE `…/:id`, POST `/bank/api-sync`, PATCH `/bank/api-accounts/:id` (company),
  фільтр `source` у `/bank/transactions`.
- **`scheduler.ts`:** крон `10 7-22/3 * * *` Warsaw — синк+алерти головному адміну
  (надходження ≥2000 zł не-внутрішні, komornik/egzekucja, низький баланс <10k;
  кап 10 повідомлень); щоденна перевірка строку згод у блоці 06:00 (<14 дн, раз/3 дні).
- **MT940-імпорт** (`bankStatements.ts` `supersedeApiRows`) видаляє API-рядки
  покритого періоду по 26-цифровому ядру рахунку.
- **Веб `/bank`:** картка «Банк наживо» (живі баланси по рахунках, кнопка «Оновити
  зараз», модалка згод: діє до/поновити/відкликати/підключити банк), бейдж `API` у
  рядках транзакцій, обробка `?api=linked|помилка`, i18n uk/en.
- **`/privacy` і `/terms`** — статичні сторінки в `app.ts` (вказані в анкеті EB).
- **Сід сесій:** `scratch-bankapi-seed.mjs <session_id…>` (запуск з кореня з
  `--import ./artifacts/api-server/test-hooks.mjs`); локально засіджено Klinex@BNP
  і Eurosupport@Erste (4 рахунки), синк наживо: 205 рядків, ідемпотентний.
- `.env` локально: `ENABLE_BANKING_APP_ID`/`KEY_FILE` = прод-застосунок;
  `_SANDBOX`-варіанти збережені. Опційні пороги: `BANK_API_BACKFILL_DAYS`,
  `BANK_API_ALERT_IN_MIN`, `BANK_API_LOW_BALANCE_PLN`, `ENABLE_BANKING_REDIRECT_URL`.

## ✅ 28.07 (продовження): довідник контрагентів + IBAN-и працівників (локально, НЕ задеплоєно)

- **Схема:** `counterparties` (канон-назва/kind/NIP) + `counterparty_aliases` + `counterparty_accounts`
  + `worker_bank_accounts` + `bank_transactions.counterparty_id`; міграція
  `deploy/migrations/2026-07-28-counterparties.sql` (локально накатана).
- **`services/counterparties.ts`** (чисті хелпери під тестами): сідинг із KSeF
  (buyer/seller NIP+назви, свої фірми виключені), клієнтських прив'язок фабрик
  (client_nip/pnl_label), IBAN-и з переказів зматчених із фактурами і з титулів
  з рівно одним чужим NIP. Резолюція транзакцій: IBAN → NIP у титулі → аліас.
  IBAN-и працівників сідяться зі строгих ЗП-переказів (повне ім'я, унікальний
  кандидат); перекази на них без категорії → `salary`/`zaliczki` (власників не чіпає).
- **Локальний сідинг:** 197 контрагентів, 61 IBAN, 297 рахунків працівників,
  578 транзакцій розпізнано, 1785 → salary/zaliczki (перевірено семпл: «Przelew
  środków», «Money transfer» тощо — реальні ЗП, що падали в «Інше»).
- **API:** `/bank/counterparties` CRUD + `/merge` + alias/account add/del + `/sync`;
  фільтр `counterpartyId` у `/bank/transactions`; `/workers/:id/bank-accounts` CRUD.
- **Крон:** щоденний `syncCounterparties()` у 06:00-блоці; інкрементальна резолюція
  після кожного MT940-імпорту й API-синку.
- **Веб:** модалка «Контрагенти» на /bank (пошук/тип/статистика, правки, аліаси,
  IBAN-и, злиття дублів, синк) + картка «Банківські рахунки (для ЗП/авансів)»
  у профілі працівника. i18n uk/en. Тестів: 279 pass.
- **✅ Поверх словника (28.07, локально):**
  - **Аванси авто-«виплачено»** (`services/advances.ts` + `advance_requests.paid_txn_id`,
    міграція `2026-07-28-advances-autopaid.sql`, локально накатана): вихідний переказ
    належить працівнику (IBAN з worker_bank_accounts або повне ім'я) + точна сума
    ±0.02 + дата ≥ затвердження + не WYNAGRODZ; один переказ = один аванс (найстаріший);
    працівнику йде звичайний пуш «виплачено», власнику — рядок в алерті; у веб-таблиці
    авансів позначка «авто». Виклик: bankApiTask (після API-синку) + 06:00-блок (MT940).
    Локальний прогін: 22 approved — 0 матчів, ПРАВИЛЬНО (їх платили готівкою; після
    затвердження в банку лише зарплатні перекази інших сум). Готівкові аванси —
    свідомо ручна кнопка.
  - **KSeF same-day:** після API-синку з новими рядками — `matchKsefPayments()`
    (строгий, номер у призначенні) + `recentlyPaidByApi()` → рядки
    «✅ Фактура … закрита переказом» в алерті власнику.
  - **KSeF закупівлі по IBAN постачальника:** новий прохід у `matchKsefPayments` —
    вихідний переказ на відомий IBAN зі словника + точна сума + однозначна пара
    в обидва боки (кілька відкритих фактур на ту саму суму — вручну). Локально:
    5 липневих продажів закрито API-рядками (Andros 505k, Agram 142k, Premium
    Fruits 69k, Aunde 90k) + 2 закупівлі. 78 закупівель лишаються відкритими
    ЛЕГАЛЬНО: або не оплачені, або оплачені з непідключених рахунків
    (BNP Group, BNP Outsourcing, mBank) — закриються після їх прив'язки.

## ✅ 28.07 (вечір): модуль «Фактури коштові» (/cost-invoices) + бот-сканер (локально)

- **Схема:** `invoices` + source(sheet|manual|scan)/seller_nip/note/file_path/created_by;
  міграція `2026-07-28-cost-invoices.sql` (локально накатана). Стара сторінка /invoices
  і sheet-синк НЕ чіпані (перехідний період — рішення Юрія).
- **Ролі:** нова cap `costInvoices` + сторінка `/cost-invoices` в обох каталогах
  roles.ts. Роль «Бухгалтерія» Юрій створює в Налаштуваннях (cap costInvoices +
  сторінка /cost-invoices) — бачитиме лише фактури, без балансів/ЗП.
- **API `routes/costInvoices.ts`** (гейт viewFinance АБО costInvoices): об'єднаний
  список місяця (KSeF-закупівлі + локальні рядки з бейджами), дедуп-підказка
  (номер+сума збігаються з KSeF → рядок маркується і не рахується в підсумках),
  CRUD ручних, PATCH оплати (для KSeF — дзеркальний ендпойнт під цим гейтом),
  файли сканів (uploads/invoices, magic-byte sniff), `createScannedInvoice` для бота.
- **Document AI (`services/docai.ts`):** той самий процесор, що в боті Faktury
  (invoice-bot-123/eu, ключ `secrets/docai-key.json`, env `GOOGLE_DOCAI_KEY_FILE` +
  `DOCAI_PROCESSOR`). Чисті хелпери (суми/дати/NIP/entities→чернетка/наша фірма)
  під тестами docai.test.ts. Реальний смоук на PDF — ок.
- **Бот:** кнопка «📄 Фактура» в офіс-меню → фото/PDF → чернетка з інлайн-редактором
  (фірма-цикл, постачальник, NIP, номер, дата, сума) → збереження source='scan'.
  `bot/handlers/invoiceScan.ts`, реєструється ДО загальних photo/document/text
  хендлерів (вони без next), чужі стани пропускає. EN-переклади в BOT_EN.
- **Веб `/cost-invoices`** («Фактури» в наві; стара — «Фактури (таблиця)»): фільтри
  місяць/фірма/статус/джерело/пошук, зведення (разом-без-дублів/оплачено/не оплачено),
  бейджі KSeF/вручну/скан/таблиця/дубль, прострочені терміни, клік-оплата, модалка
  з усіма полями + файл. Тестів: 285 pass.
- Деплой-чеклист: +міграція `2026-07-28-cost-invoices.sql`, +копія `secrets/docai-key.json`
  на сервер, +env `GOOGLE_DOCAI_KEY_FILE`/`DOCAI_PROCESSOR` у прод-`.env`.

## ✅ 28.07 (ніч): CFO-модуль (/cfo, owner-only) — локально, НЕ задеплоєно

- **`services/cfo.ts`:** звірка `Баланс(поч) + кешфлоу = Баланс(кін)` (переюзано
  `computeCashflow` — тіло GET /cashflow витягнуто в експортовану функцію; residual
  на червні = −0.03 zł ✅), P&L vs кеш із факторами (власники, Δдебіторки/кредиторки;
  контекст ЗП M+1), маржі по клієнтах з pnl_entries + MoM (поріг з налаштувань,
  дефолт <10%; нові/зниклі; списки в бот-звіті обрізаються топ-5).
- **АІ-шар:** `@anthropic-ai/sdk` (^0.115), модель claude-opus-4-8, adaptive thinking;
  вмикається наявністю `ANTHROPIC_API_KEY` у .env (ключа ЩЕ НЕМА — Юрій зареєструє
  console.anthropic.com і поповнить $5). Висновки зберігаються в `cfo_reports`
  (міграція `2026-07-28-cfo.sql`, локально накатана).
- **API `routes/cfo.ts`:** GET /cfo?month (дані+налаштування+звіти+aiConfigured),
  PUT /cfo/settings (поріг + recipientAdminIds), POST /cfo/analyze.
- **Крон:** 1-го числа 09:00 Warsaw — звіт за попередній місяць вибраним адресатам
  у бот (цифри звірки+маржі; АІ-висновок додається, якщо є ключ). Без адресатів — skip.
- **Веб /cfo** (нав «Фінанси», page key в обох roles.ts): картки звірки і P&L↔кеш,
  таблиця маржинальності з бейджами/MoM, блок АІ-висновків з історією, модалка
  налаштувань (поріг + чекбокси адресатів). i18n uk/en. Тестів: 285 pass.
- Смоук червня: звірка сходиться, Eurocash 2.03% і TOP-2 6.64% (маломаржинальні),
  InPost 24.4→16.2% (падіння), нові Allmiz/Dorko/Bimiz.

## Деплой-чеклист (після тесту й підтвердження Юрієм — правило deploy-only-after-approval)

1. `psql -f` три міграції: `2026-07-28-bank-api.sql`, `2026-07-28-counterparties.sql`,
   `2026-07-28-advances-autopaid.sql`; після деплою — `POST /bank/counterparties/sync`
   (або дочекатися крону 06:00).
2. Скопіювати `secrets/enablebanking/` на сервер (scp, поза git) + у прод-`.env`:
   `ENABLE_BANKING_APP_ID=477ab2a8-…`, `ENABLE_BANKING_KEY_FILE=<шлях>/key-prod.pem`.
3. Звичайний деплой (build + pm2 restart).
4. Сід сесій на проді тим самим scratch-скриптом (session_id ті самі, вони серверні).
5. Пізніше: у CP → Link accounts два рахунки BNP, що лишились (Group і Outsourcing),
   → «Підключити банк» на /bank (або поновлення BNP-згоди) — система підтримує
   кілька згод на один банк. mBank — так само, коли дійдуть руки.

## Наступні етапи (після успішної розвідки)

1. `services/bankApi.ts` + таблиця згод `bank_api_consents`; транзакції → `bank_transactions`
   з `source='api'` (мапінг полів під патерни класифікації).
2. Крон-синк кілька разів на день; на `/bank` — «оперативні» транзакції + керування згодами
   (строк дії, кнопка поновлення); алерт у бот за ~2 тижні до кінця згоди.
3. MT940-імпорт заміщає API-рядки покритого періоду (без построкового дедупу).

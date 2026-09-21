# Карта Google Drive Euro Support

Знімок: **2026-09-17**. Джерело — усе, що бачить OAuth-акаунт `yuriisydorchuk96@gmail.com` (той самий, що в `.env` `GOOGLE_OAUTH_*`): «Мій диск» + «Доступні мені» + дві папки, розшарені лінком (хостельна папка головного водія, Sheets доступності `GOOGLE_SHEETS_ID`).

> **Два акаунти.** Розділи 1–6 — диск Юрія. **Розділ 7 — диск фірми `office.eurosupp@gmail.com`** (39 160 обʼєктів, знято того ж дня окремим OAuth-токеном `GOOGLE_OAUTH_REFRESH_TOKEN_OFFICE` у `.env`; сирі дані — `data-import/drive-map-office-2026-09-17/`). Скрипти ті самі, токен підставляється через `GOOGLE_OAUTH_REFRESH_TOKEN="$(grep ^GOOGLE_OAUTH_REFRESH_TOKEN_OFFICE= .env | cut -d= -f2-)"`. Зведена таблиця контактів по обох дисках — `data-import/drive-map-combined-2026-09-17/`.

## Обсяг

| | |
|---|---|
| Обʼєктів усього | 5 228 (500 папок + 207 у лінк-папках) |
| PDF | 2 904 (рапорти, фактури, витяги, рахунки) |
| Google Sheets / xlsx / xls / csv | 233 / 201 / 30 / 20 |
| Google Docs / docx / odt | 162 / 61 / 4 |
| Фото/відео | ~600 (jpeg 564, heif 7, mov 18) |
| Форми Google | 9 (доступність 2018–19, Uber Eats, Kinder) |

Сирі дані знімка (gitignored): `data-import/drive-map-2026-09-17/` — `all.json` (інвентар з шляхами, id, webViewLink, дати), `tree.txt` (папки з лічильниками), `text/<id>.txt` (витягнутий текст 967 документів), `contacts.json` / `contacts-by-file.json`, `revisions-first-seen.json`, **`Drive-контакти-2026-09-17.xlsx`** (таблиця контактів — див. нижче).

Скрипти (у `artifacts/api-server/`, запуск `node --env-file=../../.env …`): `scratch-drive-inventory.mjs` (повний список), `scratch-drive-tree.mjs` (дерево), `scratch-drive-extra-roots.mjs` (лінк-папки), `scratch-drive-extract.mjs` (текст: Sheets→xlsx, Docs→txt, pdf→pdftotext; пропускає фактури/витяги/рапорти), `scratch-drive-contacts.mjs` (телефони+імена+мова), `scratch-drive-revisions.mjs` (перша поява номера за ревізіями), `scratch-drive-build-xlsx.py` (фінальний xlsx). Повторний знімок = прогнати в цьому порядку в нову папку `data-import/drive-map-<дата>/`.

---

## 1. Мій диск (`[MyDrive]`, 1 700 файлів, власник Юрій)

### 1.1 Операційні дані Euro Support

| Папка / файл | Що це | Період |
|---|---|---|
| **`Raporty/`** (782 pdf) | Скани рапортів годин по фабриках, підпапки `<Фабрика>/<YYYY-MM>/`: Agram 189, LST 338, Premium Fruits 131, PT Makaruk 70 (до 11.2025), Kuźnia 20, Andros 19, InPost 7. `Raporty/Users` — таблиця користувачів. Це **старий** архів рапортів (до того, як бот почав писати в `Графіки бот/Рапорти`). | 09.2025 – 06.2026 |
| **`Rachunki PDF 2025/`** (382 pdf) | Rachunki до umów zlecenie за 2025: `ESG/`, `ESO/`, `Klinex/` → папка на працівника+місяць (`Rachunek_<Фірма>_<Імʼя Прізвище>_<міс>`). Згенеровано масово 05–09.02.2026. У корені диска лежить ~10 таких самих папок-«хвостів» (Rachunek_ESG_…, Rachunek_ESO_…, Rachunek_Klinex_…). | 2025 |
| **`Faktury/`** (110) | Вхідні фактури по місяцях: `10.2025 Kokos`, `11.2025 Kokos`, `12.2025 Kokos`, `01.2026 Kokos`, `02.2026 Kokos` (Kokos = постачальник, ~100 pdf), `10.2025 ES Group`, `10.2025 ESO`, `10.2025 Klinex`, `11.2025 ES Group`; `InvoicesBot` — 1 файл. | 10.2025 – 02.2026 |
| **`EuroSupport Phinance (Фінанси)/`** (23) | Фінансові зведення: `2022 dochod/` (Dochód 01–10.2022, xls), `Archiv/` (2023, 2024, taxi.xlsx, «Підсумки по обороту і годинах 2020-2022»), `Przychody/` (wynagrodzenia 2025, 2026), `2025`, `Stan finansowy`, `Podatki`, `Faktury Kosztowe ESG`, `Klinex Faktury Kosztowe`, `Klinex sprzątanie`, `формa фінансового звіту.xlsx`. | 2022 – 2026 |
| `Waloryzacja 2026/` (12 gdoc) + `Waloryzacja cyrkoniowa/GT group/office center` | Листи-валоризації для клінінгових вспульнот (AUGUSTA 27–41, FIELDORFA 6, OFFICE CENTER, Urbanowicza 8, WYŻYNNEJ 5, CYRKONIOWEJ 3 i 5). | 2022, 2026 |
| `LFR - dokumenty poręczyciela - Jurij Sydorczuk/` (6) | Пакет поручителя для LFR/BGK (załączniki 4, 13–17). Особисто-фінансове. | 09.2026 |
| `ES Bułgaria/` (5) + `Болгарія`, `JOB OFFER bulgaria`, `Bolgaria praciwnyky`, `ES BG` | Болгарський напрямок: договори temporary staffing, договір за посередництво, ДОДАТЪК №1, список працівників/постачальників. | 08.2025 – 02.2026 |
| `09.2025 ESO/`, `09.2025 Klinex/`, `[MyDrive-orphan]/…` (pdf `A2_4_2023`, `WARSZAWA`, `125501B03004372`, `FVS_11_08_2025`, `0490816154`) | Розсипані сканами документи вересня 2025 (Drive «File Stream»-артефакти з дивними шляхами `13/09/2025.pdf`). | 09.2025 |
| `tmp payroll import 17…36` (11 gsheet) | Тимчасові аркуші імпорту зарплат із сайту (`/hours` → Sheets), можна видаляти. | 07–09.2026 |
| `Облік годин — рекрутинг (авто)` (2) | Автоматичний облік годин рекрутерів (ПІБ/Код/Години). | 09.2026 |
| `Grafik` | **Sheets доступності** (`GOOGLE_SHEETS_ID`), його читає `services/sheets.ts`. | 05.2026 → |
| `Danne do rachunków`, `Копия Danne do rachunków` | Дані до rachunków (реквізити працівників). | 01.2026 |
| Калькуляції: `kalkulacja 2026`, `Agram kalkulacja 2026`, `Agram umowa o prace kalkulacja`, `umowa o prace kalkulacja`, `kalkulacja ARVATO/BORG/-1/Oplłata miesięczna`, `Pracownik magazynowy kalkulacja BORG`, `Kalkulacja porównanie`, `Try and hire`, `Stawki 2026`, `Stawki netto eurocash`, `nowe stawki 2024/2025`, `Kalkulator stawek`, `Zalacznikcenowypersonelzewnetrzny_strukturakosztow`, `Oferta UPS Polska 2025`, `Motywacja 2024`, `Imma motywacja`, `DEFS_kalkulator…`, `15gg_kalkulator…` | Ставки/калькуляції для клієнтів і мотивація персоналу. | 2020 – 2026 |
| Договори/шаблони: `Aneks Agram 2023`, `Aneks LST`, `Aneks nr Umowa Współpracy EUROSUPPORT 4`, `umowa outsourcing 2022-2023 eurosupport`, `UMOWA ZLECENIE KLINEX pusta`, `Umowa_sprzątanie_Wspólnota`, `Umowa wspolpracy APT Zloty Indyk - Eurosupport Group 050826`, `UMOWA NA WYKONANIE USŁUG REKRUTACYJNYCH POLSKA`, `Umowa rekrutacyjna Niemcy ENGLISH`, `ДОГОВІР про одноразове надання рекрутингових послуг`, `Умова з рекрутерами`, `Kwestionariusz osobowy`, `Formularz oceny agencji 2026`, `OFERTA NA USŁUGI PORZĄDKOWE…`, `Pełnomocnictwo*` (11 копій, 02–03.2026), `Upoważnienie`, `Oświadczenie o obywatelstwie / o odstąpienie umowy`, `Odpis z dowodu osobistego`, `Protokół zwrotu pojazdu`, `Umowa darowizny samochodu`, `umowa_kupna-sprzedazy`, `Umowa sprzedaży na raty`, `Pismo do UFG Mercedes…`, `YURIY - pismo w sprawie podwyżki 13112025`, `wniosek o podwyżkę GT group / LZN`. | Юридичні шаблони й підписані договори. | 2019 – 2026 |
| Клієнти-фабрики (старе): `Klinex`, `KLINEX`, `Klinex 2022.xlsx`, `KLINEX.pdf`, `KLinex zalegle fakrury`, `Tabela obecności klinex`, `Лодзь`, `London`, `inpl listopad.xlsx`, `KARTY PRACY es 09.11` (karty pracy OWŚ/OWM по змінах), `Makaruk (Tabela pracownikow i zmian)` (2018), `графики 05.19`, `01.07`, `02.09.19`, `29-30.08`, `30-31.05.19 EuroSupport`, `EuroSupport.xlsx`×6 + `EuroSupport`×5 (графіки 2018–19), `Szkolenia 13.11`, `Lista Szkolenia`, `Kinder Postoyannye`, `Listy Kinder`, `EuroSupport Kinder постоянные работники` (форма). | Ранні графіки/списки на фабрики (Kinder, Makaruk, Klinex). | 2018 – 2022 |
| `Karta stelażej`, `Spotkanie sushi 21.01.2026`, `Новая таблица` (06.2026: Pracownik/Lider/Brygadzista премії), `Аналітика_менеджерів_з_формулами.xlsx`, `Етапи рекрутації`, `Описание бизнес кейса`, `Strategia Marketingowa na rok 2024`, `Копия Сегментация аудиторий EuroSupport.docx`, `Политика в отношении обработки персональных данных`, `Пропозиція по клінінгу`, `Дизайн люблін.docx`, `Обладнання+меню`, `menu`, `Lublin 13` | Операційні/маркетингові нотатки. | 2020 – 2026 |

### 1.2 Бази контактів працівників і кандидатів (**головне для таблиці контактів**)

| Файл (Drive id) | Зміст | Створено → змінено | Унік. телефонів |
|---|---|---|---|
| **`EuroSupport lista Pracownicy`** (`1NFYqeR2hDs6TgHNCzMTivWzuw9KaGCiDlgH3p09P2uM`) | Головна база 2019–22: аркуші `Leady` (Nr, Imię Nazwisko, telefon, звідки контакт, тип роботи, документ, статус студента, **Data pierwszego kontaktu**, результат розмови), `МАКАРУК ШКОЛЕНЄ`, `AGRAM LUBLIN SZKOLENIE`, `АГРАМ БРИГАДА`, `MATERNE`, `litwa`, `frukty`, `new`, `stal`. | 09.2019 → 06.2022 | 1 967 |
| **`номера работников`** (`1-cB2eJPs6aoDA0yYOsn72C4I5V69QAH5AhY1PDpPb-c`) | Плоский список Imię Nazwisko / telefon / Viber / фабрика (Materne…). | 11.2021 | 1 313 |
| **`Pracownicy leady 2.0`** (`1cDHzadnFh206HIDV2vKi2NwFEkYd4emALHlfqS6EIOk`) + форма | Ліди 2020: імʼя, телефон, тип роботи, джерело (OLX…), документ, студент, працював у нас, статус, książka sanitarna, перший контакт. | 06.2020 → 09.2020 | 374 |
| `Новая таблица` (`1PZhQiH4n37FdlFFNQxt1dd4DioaZPiknnY5cQ3isUbk`, 09.2019) | Список кандидатів 2019 (імʼя + телефон). | 09.2019 | 149 |
| `EuroSupport tabela dyspozycyjności (Ответы)` / `… 2019 (Ответы)`, `Dyspozycyjność 2-11 stycznia`, `… 16.02(sobota)`, `… 23.04.2019-04.05.19` | Відповіді Google-форм доступності 2018–19 (імʼя, тиждень, зміни, позначка часу). | 11.2018 → 04.2019 | ~50 |
| `SMS рассылки` | Список на розсилку: Nazwisko Imię, Telefon, Sanepid, Dokumenty. | 06.2020 | 13 |
| ` transport i torby` | Кому платити за транспорт/торби (імʼя + телефон). | 07.2019 | 102 |
| `Рекрутери` | Телефони рекрутерів. | 09.2020 | 5 |
| `Kinder Postoyannye` (форма, 413 рядків) | Постійні працівники Kinder: ПІБ, тиждень, зміни. Без телефонів. | 03.2019 → 03.2022 | — |
| `EuroSupport Leady Pracodawcy` (`13ESQM7YSbPXfEzpQiHnI1JVuJ5n0dVAQAjCk2KQ9cIU`) | **Роботодавці** (B2B-ліди): Люблін, інші міста, Łódź — фірма, адреса, контактна особа, телефон, статус обдзвону. | 09.2019 → 09.2024 | 92 |
| `XXXXX`, `pozostala-dzialalnosc-uslugowa`, `szwalnie lublin`, `Копія для BNI MOTOR` | Бази фірм (Tarczyński…, PKD-вибірки, швальні, гості BNI). Не працівники. | 2020 – 2021 | 33 / 106 / 3 / 250 |
| `Список для обзвона убер:`, `Uber*`, `UPartner Uber Eats (Ответы)`, `Uber/Taxify accaunt`, `uber eats lista`, `Bolt Lublin Udriver`, `Таксифай`, `Partner Flotowy marketplace`, `Upartner Lista płac`, `Uber Zielona Gora` | **Uber/Taxify/Bolt-флот 2019–20** (Y.S. Group / UPartner) — водії, не працівники ES. | 2018 – 2020 | ~300 |
| `lista_wizyt.xlsx` (×3) | Список візитів салону Cocos Paradise Beauty Studio (Люблін) — сторонній бізнес, ~1 500 клієнтських номерів. | 06.2026 | 1 255 |
| `Сербія партнер`, `Вова тест` | Сербські партнери-фірми; тест-вибірка Дубай. | 09.2025 / 07.2025 | 48 / 32 |
| `a2zA2Z_CR_PL_…`, `a2zA2Z_CR_SK_…`, `155 x Dell LOT` | Лоти Amazon returns (товари) — не персонал. | 09.2025 – 01.2026 | — |

### 1.3 Особисте / навчання / інше (не для бази знань ES)

CV Юрія (2018), `Yuriy Sydorchuk/` (дипломна), `exam_questions`, `Statystyka homework`, `Colab Notebooks`, `IoS Lab3`, `lab10`, `Project IT`, `PDCA…pptx`, `Dziennik stażu`, `Raport staż`, `Diploma question`, `Title page…`, `Machine Learning` (mindmup), `Untitled Diagram.drawio`×4, `Копия Банк идей…/Видение будущего/Выбор дела 2.0/Точка А/Марш-бросок/Твои интересы` (курс «Скорость»), `NFT Imaginary`, `DRAFT_handel krypto kantor`, `Канада`, `uah-pln`, `Audi SQ7`, `audi.zip`, `ArkuszPytańWWS`, `Wizz Air bank acc`, `Taxi pożyczka Vakulenko`, `Zabiezpieczenie Nieruchomością`, `IMG_4436.jpeg`, `IMG_4596.JPG`, `Мое устройство MacBook Pro/` (2019 бекап).

---

## 2. Розшарене з `office.eurosupp@gmail.com` (диск фірми, 534 + 207 файлів)

| Папка / файл | Що це | Період |
|---|---|---|
| **`Wyciągi Bankowy/`** (489) | Банківські витяги: `2025/WB za 01.25 … WB za 12.2025`, `2026/WB 01.2026 … WB 08.2026`; всередині підпапки по фірмах (ESG / ESO / KLINEX / Outsourcing), формати mt940/csv/pdf (`lista_operacji_*`, `84423868_*`, `01018756_*`, `M_BANK_KLINEX_*`). Це джерело `services/bankStatements.ts` (синк із Drive). | 02.2025 → 08.2026 |
| **«Папка красивого білоруського мужика»** (лінк, 207) — папка головного водія | `Auto/` (АВТОПАРК.xlsx, АВТОПАРК 2.xlsx, Контроль продаж и топлива, Продажа и покупка автомобилей, `UMOWA NAJMU SAMOCHODU/` — 11 умов найму авто водіями, `ewidencja 2026/` — 59 ewidencji przebiegu VAT, upoważnienia, umowa odpowiedzialności materialnej); `Hostel/Люблин/` (Jagiellonska 46, Zbożowa 107, Żółkiewskiego 3, Gojawiczyńskiej 30, Igłatowskiego, «Hostel do wynajęcia», умови на хостел) і `Hostel/Познань/` (Polna 29, Reymonta 6); `Контроль поездок по фабрикам/` (LUBLIN‑LOGISTICS 27 файлів 2022–26, BIAŁYSTOK, KRAKÓW, LST, Agram Motycz — журнали поїздок: дата/водій/авто/км/люди); `Протоколы/` (regulamin hostelu PL/ENG/RUS/UKR, umowa najmu lokalu, ключі, протоколи прийому авто 4 мовами); `Учет денежных средств/HOSTEL REPORT/` (звіти по фінансах хостелів, 01.2026); `Учет одежды/` (Forma.xlsx, Рабочая одежда на балансе, Учёт рабочей одежды); `Автосервисы Познань`. Знімок від 31.07.2026 — `data-import/drive-2026-07-31/` (імпортовано в автопарк/транспорт/спецодяг). | 2022 → 09.2026 |
| **`Активні працівники 2020`** (`1E05Q2XNQlZgfpA0xq7jLJBn5UsxvpT-pbNHOkZY9PmE`) | База працівників 2020–22: Imię Nazwisko, telefon, Viber, фабрика, документ, студент, umowa od/do, PESEL, konto, hostel, data wjazdu, stawka, дата народження. **1 260 телефонів.** | 06.2020 → 08.2022 |
| Сводні: `10.24 сводная фабрик`, `03.2025 Люблін Сводна`, `04.2025 Люблін Сводна`, `06.2025 Люблін Сводна`, `12.2025 Познань сводна`, `Godziny Sushi 01.2025`, `Чорновик.xlsx` | Місячні зведення годин/виплат до появи модуля сводних у сайті. | 10.2024 → 02.2026 |
| Логістика: `Логистика - EUROCASH 2024` (12 аркушів-місяців), `LST 2026`, `AGRAM MOTYCZ 2023`, `Plany Tygodniowe.xlsx` (тижні 15–31, 2026) | Журнали поїздок і тижневі плани. | 2023 → 2026 |
| Рекрутинг: `рекрутинг` (2020, опис вакансій Kantpol…), `Informacja rekruting` (01.2026, вигрузка CRM), `Danne do CRM` (07.2025), `Baza zainteresowanych klientów FREELINE wrzeszeń` (2024–25, 90 тел.), `ПАРАГВАЙ` (06.2026: списки на подачу/дозволи/прильоти), `zezwolenia` (2022), `InPost Zamówienie 2025` | Кандидатські списки офісу. | 2020 → 2026 |
| Документи: `UMOWA ES Klinex`, `Aneks Jukki`, `PEKAO Leasing - Uproszczony wniosek Spółki.docx`, `Przetarg Prszczółka/` (тендер KGS, 09.2025), `SKIEROWANIE NA BADANIA LEKARSKIE - K/M`, `ZEZNANIE_O_WYSOKOSCI…pdf` (PIT 2023), `POZYCZKI 2024`, `Spotkanie 2024.05.31 P.Mazur.xlsx`, `Prezentacja Euro Support Group.pptx`, `Faktury Kosztowe Outsourcing`, `Хостел ZBOŻOWA 107.xlsx`, `1.jpg…10.jpg` (2019). | | |

## 3. Розшарене ботом (`grafik@grafik-bot-497821.iam.gserviceaccount.com`) — **`Графіки бот/`** (1 233)

Кореневі id у таблиці `settings`: `drive_root_folder_id`, `drive_schedules_folder_id`, `drive_hours_folder_id`, `drive_trips_folder_id`, `drive_reports_folder_id`, `drive_agreements_folder_id`, `drive_faktury_cost_folder_id`, `drive_faktury_sales_folder_id`, `recruiter_hours_sheet_id`.

| Підпапка | Зміст |
|---|---|
| `Графіки/<ФАБРИКА>/` (50 xlsx) | Затверджені тижневі графіки (експорт `exportScheduleToDrive`): AGRAM LUBLIN, AGRAM MOTYCZ, ALMIZ, ANDROS, BIMIZ, DORKO, Karton-Pak, LST, Mlekovita, PREMIUM FRUITS, Scandic Food, Test. 06.2026 → |
| `Облік годин/<ФАБРИКА>/` (66) | `Ewidencja godzin 2026` по фабриках (`updateHoursTracking`). |
| `Рапорти/<ФАБРИКА>/` (697 pdf/фото) | Фото рапортів із бота (`uploadReportPhoto`): ANDROS 235, ALMIZ 146, LST 85, BIMIZ 72, PREMIUM FRUITS 42, DORKO 34, AGRAM ×2 31, Scandic 13, DAWTONA 10, RECYKLING 10, KUŹNIA 9, SUPERDROB 5, EUROCASH BIAŁYSTOK 4, SERWIS PLUS 1. |
| `Faktury kosztowe/2026/` (343), `Faktury sprzedażowe/2026/` (72) | Архів фактур XML+PDF (Фактури 2.0, KSeF). |
| `Umowy/ES/` (2) | Підписані умови оренди житла. |
| `Поїздки водіїв/` (3) | `Przejazdy kierowców 2026.xlsx` (`updateDriverTripsExcel`). |

## 4. Розшарене від рекрутерів/підрядників (edos.tort, anastasiia.eswp, vashtargetolog, toladubik, marchew911, krrekrutacji, janevakulenko, zhenyasimonyan, sidorchukroman2000, aliaksandraralen)

| Файл (Drive id) | Зміст | Період | Телефонів |
|---|---|---|---|
| **`EuroSupport Target`** (`1286WitJabY0zgAt_DHTJnHrZZW-u41UplKDyKRM5L54`, edos.tort) | Ліди з таргету по кампаніях-аркушах: Sushi Poznań, Tik Tok Kinder/Matern, шоколадна фабрика, Будова, Матерн PL QUIZ, Рециклінг, КАРТА UA, Euro Cash, резерв. Колонки: дата, ПІБ, телефон, Tg/Viber, **мова**, статус, коли готові. | 10.2024 → 07.2026 | 2 336 |
| **`Euro Support Emigrant`** (`1wvf3Y9jIjMyLJ4yTfBNo80xgM6ZCG-U72rN7TKScMds`, edos.tort) | Ліди еміграційного напрямку (Bagram engl, OAE): name, phone, WhatsApp, country, passport. Азія/Африка/Затока. | 05.2025 → 10.2025 | 775 |
| `ES Emirat Ru` (edos.tort) | Те саме, рос. аудиторія. | 07.2025 | 44 |
| `Партнери Euro Support` (edos.tort) | Агенції-партнери (Emirat, Сербія, Poland, рекрутер на офіс Dubai): name, phone, email, agency, sectors. | 06.2025 → 10.2025 | 364 |
| `EuroSupport Bulgaria partners`, `ES Болгарія (кухня)`, `ES Керівник віділу Продаж (ВРО)`, `Болгарія 2 скрипти…` (edos.tort) | Болгарія: фірми-партнери (ПІБ, тел, компанія), ліди на кухню (FB lead-форма з `created_time`), кандидати на керівника продажів. | 07.2025 → 07.2026 | 210 / 200 / 13 |
| **`Leads`** (`1rmvEfXirJuTbaJcsLAuS94xWTr7yxwMKn3shXNiwA4k`, anastasiia.eswp) | FB/IG lead-форми «Dubai» з датою-часом, кампанією, телефоном, статусом. | 07.2025 | 865 |
| `Лиды Работа Дубаи (англ) рос` (vashtargetolog.ads) | Те саме від таргетолога, ISO-дати. | 08–09.2025 | 614 |
| `Польша - Лиды (Анатолий)` (toladubik) | Ліди на Польщу 12.2021: ПІБ, телефон, вакансія, коли приїде. | 12.2021 → 01.2022 | 129 |
| `Black people, и англо. говорящие`, `KINDER szkolenie 07.08.2020`, `Х`, `НУЖНЫ на работу` (marchew911) | Рекрутер 2020: кандидати (дата додання, ПІБ, тел, студент, санепід, місто, оферта), фірми-контакти. | 07–09.2020 | 82 / 18 / 18 |
| `WYNAGROD. REKRUTERY` (krrekrutacji) | Виплати рекрутерам за працівників (рекрутер, працівник, магазин, години, сума). | 03.2026 → | 1 |
| `практика 2021-2022` (janevakulenko) | Студентські практики (uczelnia, kierunek, opiekun, oplata) 2021–2026. | | 11 |
| `MATERNE 2022` (zhenyasimonyan) | Журнал поїздок Materne 05–09.2022. | | 7 |
| `lista osob sierpien` (sidorchukroman2000) | Список осіб (Nazwisko/Imię) серпень 2020. | | — |
| `L Сотрудники на производство` (aliaksandraralen) | Docs-список кандидатів на виробництво. | 07.2025 → 03.2026 | — |
| `Agencja pracy Lublin`, `Strona główna`, … (joachim.kawecki@freeline.pl) | Тексти сайту FREELINE (партнер-агенція). | 05.2024 | — |

## 5. Work Permit Global (`plyush.sasha66@gmail.com`, 628 файлів, 2.9 GB) — **окремий бізнес (Дубай/ESWP)**

`BrandBook/` (185, 1 GB медіа), `Клієнти/` (201: `Candidates/<рекрутер>/<MM.YY>/<країна>/…` — паспорти/анкети/квитанції кандидатів з Азії; `Сербія/`, `Словакія/`; `клиенты инфо`; `Продажі фізичні особи` — цінник по країнах; `Candidates/Abhishek/Hanna/Leads Analysis` — 431 тел. з аналізом відмов), `Клієнти партнери (Фірми)/` (`Контакти до фірм` — прозвон/конкуренти, PERRY EDEN, Pal Subrat Kumar), `Вакансії work permit global/` (167: Visa (107 фото), Сербія, Польща, Україна, Словаччина, Чехія, Болгарія — презентації й приклади документів), `Зразки договорів/` (B2B, B2C, work permit UKR-ENG, договір Польща–Дубай), `Правила та узгодження/` (гайди для рекрутерів, воронки, order briefs, відео), `Dokumenty firma dubai/` (ліцензія 29333, Ejari, офіс), `Фінанси/`, `Звітність/`, `Працівники/Правила ЗП нові рекрутери`, `План дій в дубай`, `ОРГ. структура ESWP`, `Реклама/`.

## 6. Інше розшарене (шум)

`kaif.mvk@gmail.com` — ~100 jpg `a1…a95` (дублі); `vakulenkovova80` — «фото насадки» (66, 928 MB); `endrjum99` — «3P Center BMW M8 11.2024» (182 MB); `komornikstrzelecki` — Operat szacunkowy BMW; `office@alexkorchevski.com` — офер 07.2025; `randroshchuk97` — Prezentacja Euro Support Group dla klientów.pptx; `[Shared:?]` — «Poprawiona STRATEGIA transformacji cyfrowej ES» (03.2026), BSH menu, Dell LOT; `like.dolina.project`, `shkilv`, `maliksvv`, `polly.ivanova`, `project@likecentre.ru`, `skorostylike`, `alekseeva7125`, `alsidbamcon`, `flywithme1505`, `nagaytsev64`, `assistant.nagaytsev`, `aleksandrzmyrov` — матеріали бізнес-курсів 2019–22; `rafal.moczadlo`, `shneyder.d`, `upartnerlublin`, `dmytrohrushovenko` — університет; `gigigatt` — оренда GZR180; `raimisvaliukas`, `lenasolh`, `vitaliipolitylo99`, `tonya.didenko`, `england.arrivo`, `wenden18`, `bogdan.stoianov8`, `citadelheraldgu`, `veraveronika555` (EuroSupport | розбір/тексти, Заборгованість), `mr_avangardo` (Сегментація аудиторій EuroSupport, ТЗ для відео), `annmostipan`, `cocosparadise.studio`, `logistykapolub`, `sushi.cloud.lublin`, `cloudlublin`, `anncafephuquoc` (меню), `polishchshuksergy` (кейси), `polishchuk.tkp`, `glassbless`, `ok8367178`, `info@globalpolish.org` (підручник B1), `departament.jakosci` (відео), `drivestorage2@uber.com` (Lista Yurii, Yurii - PL — Uber 2019), `Magdalena@mika.pro` (GALA BNI), `justyna.j.kot` (warsztaty GBG).

---

## 7. Диск фірми `office.eurosupp@gmail.com` («Euro Support», 38.9 GB, 39 160 обʼєктів)

Знімок 2026-09-17, `data-import/drive-map-office-2026-09-17/` (`all.json`, `tree.txt`, `text/` — 7 338 витягнутих документів; PDF на цьому диску **не** витягались: 20 668 сканів — PIT-11, фактури, дозволи, карти побиту, медичні). Типи: pdf 20 668, jpeg 4 077, xlsx 2 916, gdoc 2 014, docx 1 418, gsheet 726, xls 608, doc 210, xml 308 (KSeF), zip/rar ~170, форми 14.

### 7.1 Мій диск (`[MyDrive]`, 26 552 файли)

| Папка | Що це | Період |
|---|---|---|
| **`GRAFIKOWY/`** (2 777) | Робоча папка графікової. По фабриках: `AGRAM LUBLIN/` (72; `SZKOLENIA/Agram lista osób na szkolenie.xlsx` — списки на школення з телефонами, аркуш = дата), `AGRAM MOTYCZ/`, `ALMIZ/`, `ANDROS/` (160: `GRAFIK/`, `GRAFIK ES/`, `ESTYMACJE/`, `SZKOLENIA/` — `[KLINEX] lista osób na szkolenie`, `KONTROLE/`, `[ES]/[KLINEX] Aktualna lista pracowników.xlsx`), `BIMIZ/`, `DORKO/`, `EUROCASH/` (38, 892 MB), `INPOST/` (43; `Lista InPost.xlsx` — контакти відділень), `LST/`, `PREMIUM FRUITS/`, `RECYKLING/`, `SCANDIC FOOD/`, `SERWIS PLUS/`, `SUPERDROP/`. Спільне: `INNE/` (151: `REGULAMINY/`, `MAKARUK/`, `OSMOFROST/`, `NOVABERRY/`, `WYPOWIEDZENIA/`, `NOWE PRACOWNICY/`, **`Tablica Terminów aktualna.xlsx`** — терміни умов/санепід/дозволів по фабриках, `BLACK LIST`, `KARA ZA NIEOBECNOŚCI`), `MEDYCZNE DOKUMENTY/` (1 093 pdf), `SZKOLENIA WÓZKOWYCH/` (137; `Lista chętnych na kurs wózkowych.xlsx`), `SKAN/` + `SKAN (Posortowane)/` (634 сканів 06–08.2026), `DOKUMENTY/`, `REKRUTACJA/` (`MAKARUK/Makaruk 2025 Lista chętnych osób`), `Badania lekarskie pracowników/` (52, 09.2026), `Розподіл по фабрикам.xlsx`. | 2022 → 09.2026 |
| **`ДОКУМЕНТАЦІЯ ФАБРИК/`** (1 899) | Документація по клієнтах: `SUSHI&FOODFACTOR/` (1 301: `SUSHI RAPORTY/` 1 238 таблиць-рапортів, `Godziny 2025/2026`, `CARD PROBLEMS/`, `Załączniki`, `Lista Pracowników na 04.07.2026.xlsx`, `Sushi Workers Hours Dispute`), `ANDROS/` (346: `Ewidencja/` 285 з 2019 — вкл. `2019/джем/тел/` списки з телефонами, `kontrola/`, **`Sprawozdanie pracowników/`** — річні зведення працівників Andros 2021–2026 з паспортами/PESEL/днями праці, `EUROSUPPORT PRZEPUSTKA.docx`), `MAKARUK/` (71, 2019–25), `LST/` (80), `AGRAM/` (68), `INPOST/`, `MILEJÓW/`, `OSMOFROST/`, `SUPERDROB/`, `UREN NOVABERRY/`, `EUROCASH/`, `Поездки/`. | 2019 → 09.2026 |
| **`INNE/`** (8 712) | `Odzyskane/` (8 438 — відновлені файли 2023–25, дублі всього підряд, у т.ч. `DENYS (Oświadczenia)/`), **`безлад/`** (219 — старі бази 2019–22: `EuroSupport grafik Materne (Ответы)` — форма доступності Materne 2020–23 з 714 тел., `Lidy мости і куряча фабрика` (CRM-вигрузка 2022, 558 тел.), `Andros NEW (Ответы)`, `AGRAM Motycz (Ответы)`, `chicken factory (Ответы)`, `рекрутинг`, `list of afrika`, `Браки по документах.xlsx`, `нету вайбера люди з срм`, `Вторая смена LST`, `EURO SUPPORT LISTA*.xlsx`, ewidencje 2020–22, `Rozliczenie EUROSUPPORT*`, `Czas pracy EUROSUPPORT.xlsx`, `STRAŻ GRANICZNA KONTROLA LISTA`, `инструкции/`), `сталі працівники/` (**`Активні працівники 2020`** — оригінал бази 2020–22), `Łodż/` (`Kontrola dokumentów/TABLICA TERMINÓW ŁÓDŹ.xlsx`), `Обучение Орг Структура компании/`. | 2019 → 2025 |
| **`Vlada/`** (4 112) | Кадри/легалізація: `ZEZWOLENIA/` (763), `FAKTURY/` (2 307 pdf 05–08.2026), `FAKTURY SPRZEDAŻOWI/` (378), `OŚWIADCZENIA/` (74), `RACHUNKI Z UKRAINY 2026/` (227), `zestawienie 12.2025/`, `DOKUMENTY SPÓLEK/` (88), `Podpis/`, `88Z/`, `ГАРАНТІЙНІ ЛИСТИ/`, `RACHUNKI GOTÓWKA/`, `ZWROT OPLATY SKARBOWEJ/`, `DOFINANSOWANIE/`. | 2023 → 09.2026 |
| **`ŻENIA DOKUMENTY/`** (1 808) | `Karta pobytu/` (1 060; `klienty/KARTY POBYTU` — список), `PIT/` (534, 2020–23), `WYPŁATA WYNAGRODZENIA/` (27 таблиць 2025–26), `KOMORNIKI/`, `DEZYNFEKCJA KONTROLA/`, `RABEN DOKUMENTY/`, `STRAZ GRANICZNA/`, `kontrola pip/`, `uzgodnienia/`, `zezwolenia/`, `praktyka 2026/`, `HOSTEL/`, `INNE PISMA/`, `WYPLATY Z KARTY/`, `przychód SLV`. | 2020 → 09.2026 |
| **`LEVIN/`** (2 061) | Бухгалтерія: `TKM Rachunkowość/` (1 348), `Wyciągi Bankowy/` (489 — те, що розшарене Юрію), `KSIEGOWOSC/`, `Important/` (175), `Dmytro oswiadczenia/`. | 2024 → 09.2026 |
| **`pit-11/`** (3 086 pdf) | PIT-11 працівників: `pit 11 2023` (968), `2024` (997), `2025` (1 121). | |
| **`Recrutacja/`** (27) | Рекрутинг: `Вова/` (19: **`Африка по городам`** — кандидати-африканці по містах 573 тел., **`Рекрутери Офіс.xlsx`** — виплати рекрутерам за працівників (аркуш = рекрутер) 397 тел., `Обзвон Таргета Отчет`, `Рекрутери ТГ`, `ТАРГЕТ.xlsx`, `Таргет Саня`, `Лиды по городам`, `sprzedaż agencje`, `AGENCJA zestawienie danych EUROSUPPORT.xlsx`), `Baza … FREELINE`, `ANDROS TREINING 23.07.2025`, `Шріланка кандидати на зезволенє`, `Afryka Poznan`, `Owoce Warzywa interesanty`, `Szwaczka/`. | 2023 → 06.2026 |
| **`Roma/`** (240) | Регіональний директор (Yevhenii Simonian): `Praca/` (181: `KLIENCI SPRZEDAŻ/` — `CRM`, `SPRZEDAŻ LUBLIN`, `Sprzedaż Łódź.xlsx`, `InPost Kontakty/`; `Nawiązanie współprac/`, `Godziny/`, `Praca ES 2/`, `Moje Prace/`, `Інше/` — `Lista Kontaktów INPOST.xlsx`, `Danne do CRM`), `Faktury/` (50), `Siatka kontaktowa do Oddziałów (7).xlsx` (контакти відділень InPost), `Rejd 2026 plan`, `bonus ALLMIZ`, `ewidencja Klinex`. | 2023 → 09.2026 |
| **`Сводні/`** (108) | `2020 - 2024/` (65 місячних сводних), `LUBLIN ROZLICZENIE GODZIN/` (20, 2025–26), `POZNAN ROZLICZENIE GODZIN/` (21), `Godzin Ogółem`. Попередник модуля сводних у сайті. | 11.2020 → 09.2026 |
| **`KADRY I PLACE/`** (96) | `kokos/` (55), ewidencje 2022–25, `zaswiadczenie z us i zus/`, `STRAZ GRANICZNA EWIDECJIA/`, `Bilans/`, `klinex/`, `Y.S.Grop/`, `outsouscing/`, `Pani Krystyna/`, `Rachunki _Passage_ 01.2025.xlsx`. | 2022 → 2026 |
| `Documenty/` (669) | `образец договоров/` (566 — шаблони й скани умов з 2019), `INNE/`. | 2019 → |
| `ES CYFROWIZACJA - DOFINANSOWANIE/` (102) | Заявка на дофінансування цифровізації (OLD, PODPISANE PLIKI, Umowa biuro, sprawozdania finansowe 2022–25). | 02–06.2026 |
| `ANTON/` (28) | `Dowód wypłaty generacja/` (20), `Zezwolenia opłata`, `Rachunkowość/`, `Rachunki gotówką 08.2026`, `ESO 06.2026`. | 10.2025 → |
| `UMOWY SCAN TECZKI/` (41), `DOKUMENTY FIRM/` (10), `Tetiana/` (61; `Tanzania/`), `Yevhenii Holov./` (21), `REKRUTERY ZENIA` (виплати рекрутерам 2023), `Папка красивого білоруського мужика/` (оригінал, 157), `ANDROS NEW WORKERS 07/2026`, `Новая таблица` (07.2024 — список на школення), `MURYN VADYM/`, `PiT 2025 Roman/`, `PODANI/`, `L4318TV/`, `From_BrotherDevice/`, `Има/`. | | |
| `[MyDrive-orphan]/My Computer/` (3 001) | Бекап компʼютера офісу (Desktop 2 066, Downloads 895): `Desktop/HrAppka/EXPORT/{ESG,ESO}/` — експорти HRappka з повними даними працівників (PESEL, паспорт, адреса, телефон), `Downloads/Telegram Desktop/Eksport - Umowy KLINEX 06.2026.xlsx`. | 02.2026 → |

### 7.2 Розшарене офісу (ключове)

| Хто | Файли | Зміст | Телефонів |
|---|---|---|---|
| **edos.tort@gmail.com** (таргетолог/рекрутер) | **`Архів ES`** | Архів лідів з таргету 2024–25: аркуші-кампанії (WJ PL, Вакансії, КАРТА UA/AFR Quiz, Карта побиту LUB, Матерн UA, архів суші…). Колонки: дата, ПІБ, тел, Tg/Viber, досвід, статус, замітки. **Найбільша база: 6 429 тел.** (файл не має історії ревізій для нашого акаунта — дати лише з рядків.) | 6 429 |
| | `EuroSupport Target`, `Euro Support Emigrant`, `Партнери Euro Support` | Ті самі, що в розділі 4. | |
| | `Euro Support Łodz` | Ліди Łódź/InPost (UA, AFR) 04–09.2025. | 401 |
| | `ES Karta Pobytu 12/07/2025` | Ліди на карту побиту (Meta, Meta Afr, TikTok) з містом, 07.2025 → 09.2026. | 286 |
| | `Карта словакії 7.09`, `ES Karta slovalii 25.08`, `Карта Словачини - 17.06`, `КарТа Єс ЦІНА`, `Скрипти карта єс`, `ES заміна прав (4.09)`, `EuroSupport звіти` | Скрипти/ліди по словацьких картах і заміні прав (2026). | |
| **ant.zaiets@gmail.com** | **`PRACOWNICY/`** (1 379 docx) | 721 персональних папок `ІМʼЯ ПРІЗВИЩЕ PESEL` з умовами/документами працівників (генерація з шаблонів). | |
| | `Rekrutacja` (gsheet, 9 аркушів: HR_Sources, Main/Main-ENG, EmployeeRegistry, Companies, Positions, Factories, TemplatesCatalog) | CRM-подібна таблиця рекрутації 2025–26 з реєстром працівників. | 899 |
| | `Template/` (147) | Шаблони: `UMOWY FABRYKI TEMPLATE/` (94), `ENG/PL MAIN DOCS/`, `REGULAMINY TEMPLATE/`, EUROCASH regulamin, JUKKI BHP, karta obiegowa. | |
| **krrekrutacji@gmail.com** | `Kandydaty do ES` (ENGLISH/UKR), `Training \| Szkolenia`, `Szkolenie EuroSupport`, `Recruitment Master Data`, `InventPeople`, `WYNAGROD. REKRUTERY` | Кандидати й школення 2026 (рекрутер), виплати рекрутерам. | 247 / 50 |
| **poznan.eurosupp / lodz.eurosupp / bialystok.eurosupp** | `Tablica Terminów aktualna.xlsx` (Poznań: SUSHI, MAKARUK, MATERNE, COCOS), `Plany Tygodniowe`, `Hostel Akacjowa/Żerniki 3/Luboń`, `kalkulacja MEGA PACK`, `Копия ВАКАНСИЙ`, `TABLICA TERMINÓW BIAŁYSTOK.xlsx`, `LISTA FIRM BIAŁYSTOK 2024`, `RAPORT ZALICZEK EUROCASH`, `RAPORT WYPOWIEDZENIA`, `RAPORT KONTROLI SAMOCHODU…` | Регіональні офіси. | 234 |
| **office.klinex@gmail.com** | ewidencje Klinex 06–07.2026 | | |
| **raulesupport@gmail.com** | `Colombianos/NEW/` (103) | Документи колумбійських кандидатів 07–08.2026. | 37 |
| **biuro@bluerent.org**, **biuro@most-biznesu.eu**, **w.bujnicki@most-biznesu.eu**, **kontakt@medimost.eu**, **joachim.kawecki / martyna.kosienkowska / mateusz.kocowski @freeline.pl**, **kontakt@krzysztoflatka.pl** | Кватери (каталог, фото), документи 4 спілок від бухгалтерії most-biznesu, szablony deklaracji, тексти FREELINE, «Firmy do potencjalnej obsługi». | | |
| Інше | `marchew911` (Szkolenie 30.06, Bełżyce, Materne 24/07 — 2020), `toladubik`, `janevakulenko` (facebook лиды 2021), `khristina.chavus` (ONLINE RETRIT — сторонній), `agpolonline`, `ptmakaruk` (SZKOLENIE відео), `endrjum99`, `komornikstrzelecki`, `yuriisydorchuk96` (Raporty, Faktury — дзеркало розділу 1), `grafik@…` (Графіки бот — розділ 3). | | |

### 7.3 Контакти з офісного диска

`Drive-контакти-office-2026-09-17.xlsx` — **19 430 унікальних телефонів** з 1 862 файлів (PL 12 630, UA 3 867, AE 715, SA 365, IN 230, BD 190, GH 155, BY 105). Категорії: кандидати ES Польща 10 927, працівники ES 5 645, ліди закордон 1 659, B2B 893, інше 263. Датування: 16 519 з дати в рядку.

---

## Таблиці контактів

**Робочий файл (20.09.2026): `Drive-контакти-ES-combined-2026-09-17.xlsx`** — тільки люди Euro Support: працівники (бази/облік/логістика/хостели), кандидати на Польщу (ліди таргету, школення, рекрутери) і Uber/UPartner 2019–20; вилучено партнерів/роботодавців (B2B), закордонні ліди (Дубай/Еміграція/Болгарія), Work Permit Global, сторонні списки (салон Cocos, Amazon, ретрит). Аркуш **«Перевірені номери»** — мобільні PL/UA/BY за діапазонами операторів, без стаціонарних/преміум/VoIP/підозрілих послідовностей і без номерів, що повторюються в кількох людей (офісні/рекрутерські на кшталт +48731437822, +48731090151, +48576776679, +48731090115). Перевірка формальна (формат + діапазон); чи номер активний, покаже лише HLR-перевірка у провайдера. Збірка: `KEEP_CATS="Працівники ES|Ліди-кандидати ES|Uber/Taxi" EXCLUDE_LANGS=pl OUT_SUFFIX=ES python3 scratch-drive-build2.py <combined>` (`EXCLUDE_LANGS=pl` вилучає людей з мовою-оцінкою pl або національністю Polska/polskie — рішення власника 20.09.2026; словник польських імен без двозначних Roman/Bogdan/Adam/Marta/Natalia тощо). Файл «практика 2021-2022» вилучено цілком: у ньому телефони лише опікунів (офіс ES), у студентів номерів немає. Варіанти написання одного імені (кирилиця/латиниця, порядок слів, зменшувальні) при спільному номері зливаються в одну людину (`namesSimilar` у `scratch-drive-names.mjs`).

**Повна версія v2: `Drive-контакти-v2-combined-2026-09-17.xlsx`** у `data-import/drive-map-combined-2026-09-17/` (і `Drive-контакти-v2-*.xlsx` у папках кожного диска). 22 953 людини (18 855 з іменем), 23 339 унікальних телефонів з 2 070 файлів. Аркуші: «Люди» (1 рядок = людина: прізвище, імʼя, повне імʼя як у файлі, інші написання, телефони, мова-оцінка + впевненість + підстава, національність/мова/місто з файлу, категорія, від коли, файли, спосіб витягу, якість, у базі), «Телефони» (1 рядок = номер), «Файли-джерела», «Зведення». Витяг v2 — `scratch-drive-contacts2.mjs` + `scratch-drive-names.mjs` + `scratch-drive-phone.mjs`, обʼєднання `scratch-drive-merge2.mjs`, xlsx `scratch-drive-build2.py`: імʼя/прізвище беруться **з колонок за заголовком** (Imię/Nazwisko, ПІБ, Name/Surname, «Прізвище Імя» і т.д., з визначенням порядку), телефон — з телефонних колонок (або колонки, де ≥50% значень — телефони, як «Nr osobisty» у Sprawozdanie Andros); файли без заголовка — сувора евристика по сусідній клітинці (позначено «низька»). Мова: мова з файлу → національність з файлу → кирилиця (і/ї/є vs ы/э/ё, морфологія -енко/-ая) → словники імен uk/ru/by/pl/ka/Центр. Азія/Півд. Азія/араб./афр./англ. + суфікси прізвищ → код країни телефону. Стара v1 (12 333 «телефонів», сусідня клітинка як імʼя) залишена лише для історії.

**v1, зведена по обох дисках — `data-import/drive-map-combined-2026-09-17/Drive-контакти-combined-2026-09-17.xlsx`: 23 216 унікальних телефонів (19 644 з іменем) з 2 014 файлів.** Категорії: кандидати ES Польща 11 217, працівники ES 5 756, ліди закордон 2 560, B2B 1 424, сторонні (салон/Amazon) 1 225, інше 516, Work Permit Global 438, Uber 49, бухгалтерія 31. Дати: 18 226 з рядка, 541 з ревізій, решта — створення файлу. Збігів з локальною БД Grafik-bot — 199 (за іменем). Шляхи файлів мають префікс `[main]` (диск Юрія) або `[office]`. Окремі таблиці по кожному диску лежать у своїх папках (`Drive-контакти-2026-09-17.xlsx`, `Drive-контакти-office-2026-09-17.xlsx`); формат однаковий.

### Диск Юрія — `Drive-контакти-2026-09-17.xlsx`

Аркуші: **Контакти** (11 763 унікальних номерів: телефон E.164, країна коду, імʼя як у файлі, інші варіанти, мова-оцінка, мова з файлу, хто це, категорія джерела, від коли, підстава дати, файли, чи є в базі Grafik-bot), **Файли-джерела** (198 файлів з телефонами: категорія, к-сть, шлях, лінк, id), **Зведення** (формули), **Карта папок**.

Категорії джерел (пріоритет при кількох файлах): працівники ES (3 366) → кандидати ES Польща (2 780) → ліди ES закордон (2 740) → партнери/роботодавці B2B (871) → Work Permit Global (438) → сторонні клієнтські списки — салон Cocos/Amazon (1 226) → Uber/Taxi 2019–20 (295) → бухгалтерія (31) → інше (16).

Як рахувалось «від коли»: (1) дата в самому рядку (форма/«Data pierwszego kontaktu»/lead `created_time`) → (2) найраніша ревізія Google-таблиці, де номер уже присутній (семпл до 40 ревізій на файл; Google зберігає ревізії обмежено — напр., для `lista Pracownicy` доступні лише з 01.2022, тому для старіших записів береться дата створення файлу) → (3) дата створення файлу.

Мова — евристика (код країни + транслітерація імені + мова файлу); для +48 без розпізнаного імені — `?`. Кирилиця з і/ї/є → uk, з ы/э/ё → ru.

Звірка з локальною базою: у `workers` немає телефону (є лише в `worker_questionnaires`, локально порожньо), тож збіги — за іменем (латиниця, порядок слів не важливий) або телефоном `candidates`. Знайдено лише 14 збігів — більшість людей у Drive-базах 2019–22 у Grafik-bot не заведені.

Оновлення: перегенерувати знімок (див. скрипти вище), нова папка `data-import/drive-map-<дата>/`, оновити цей файл.

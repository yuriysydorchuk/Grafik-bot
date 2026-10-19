# praca.gov.pl — форма PSZ-PPWPU (powiadomienie o powierzeniu pracy cudzoziemcowi)

Карта форми для автоматичної подачі (знята 12.10.2026 у контексті «Osoba fizyczna»; у контексті
організації секція 1 має інші поля — NIP/REGON/nazwa, зняти окремо). Джерело для `services/pracaGov/`.

## Загальне

- Офіційного API немає. Підписання — profil zaufany (login.gov.pl → pz.gov.pl, другий фактор SMS або push mObywatel) або podpis kwalifikowany.
- Кабінет: `https://www.praca.gov.pl/eurzad/` — Angular SPA. Конструктор заяви: `/eurzad/uslugi-elektroniczne/kreator-wnioskow/PSZ-PPWPU`.
- Сама форма відкривається в окремому застосунку `https://www.praca.gov.pl/formularze-pgp/formularz/PSZ-PPWPU/5/<uuid>?locale=pl` (Angular Material: `mat-input-N`, `mat-select-N`, `mat-radio-N-input`; id-и `mat-input-N` нумеруються по порядку рендеру — селектори будувати за підписами (`label`), не за номерами).
- Передумови акаунта: заповнена адреса проживання в «Zarządzanie kontem» (інакше alert «Konieczne jest wypełnienie adresu zamieszkania…» і редирект на `/eurzad/zarzadzanie-kontem/konto`).
- Контекст подачі (шапка «Kontekst: Osoba fizyczna / organizacja») обирається ДО форми; зміна контексту під час заповнення робить відправку неможливою (діалог «Potwierdzenie» перед кроком 2).
- Кроки: 1 Wybór adresata → 2 Edycja formularza → 3 Wysłanie wniosku (підпис) → 4 Podsumowanie.
- Повідомлення не можна відкликати/виправити після відправки («Brak możliwości korekty»).

## Крок 1 — Wybór adresata

- `Adresat` — autocomplete urzędu (placeholder «Zacznij wpisywać nazwę urzędu…»), підставляється сам за адресою акаунта/організації.
- Кнопки: Wstecz, Przerwij, **Wczytaj dane** (меню → лише «Ze schowka praca.gov.pl», файлового імпорту немає), **Wybierz z wysłanych** (скопіювати раніше подане), Dalej.
- Після Dalej — діалог «Potwierdzenie» про контекст → «Tak».

## Крок 2 — Edycja formularza (одна довга сторінка)

Шапка: `Data sporządzenia` (disabled, сьогодні), `Miejscowość` * (вільний текст — місто складання), `Adresat` (disabled).

### 1. Informacje o podmiocie powierzającym pracę
Контекст **організації** (знято 12.10.2026, «EUROSUPPORT GROUP SP. Z O.O.»): Nazwa, NIP, REGON — disabled (з реєстрації організації на порталі) + **Numer KRAZ** (вільне поле, «dotyczy agencji pracy tymczasowej»). Адреса 1.1 теж підставляється з організації.
Контекст «osoba fizyczna»: Imię, Kolejne imiona, Nazwisko, PESEL — усі disabled (з акаунта).
1.1 Adres siedziby: Kod pocztowy * (маска `__-___`), Województwo *, Powiat *, Gmina *, Miejscowość * (autocomplete-довідники TERYT, підставлені з акаунта), Ulica, Nr domu *, Nr lokalu.
1.2 Adres do doręczeń: e-mail (prefilled з акаунта).
1.3 Dane kontaktowe: Nr telefonu.

### 2. Dane cudzoziemca
- Imię, Kolejne imiona, Nazwisko (вільний текст, латиниця — на формі попередження про кирилицю).
- Obywatelstwo — autocomplete (довідник країн, «Ukr» → «Ukraina»).
- `mat-select` **Rodzaj dokumentu podróży** *: Paszport | Inny (при «Inny» вмикається поле «Jaki?»).
- Państwo, w którym wydano dokument podróży — autocomplete країн.
- Seria i nr dokumentu podróży; Data wydania dokumentu; Data ważności dokumentu (формат RRRR-MM-DD, datepicker).
- PESEL; Data urodzenia.
- `mat-select` **Płeć** *: Kobieta | Mężczyzna.
- Tytuł pobytu — disabled, prefilled «OCHRONA CZASOWA».

### 3. Informacje o oferowanej pracy
- Data podjęcia pracy; Data powiadomienia (disabled, сьогодні).
- 3.1 Symbol PKD: radio «klasyfikacji PKD 2007» | «klasyfikacji PKD 2025» (values `PKD_2007`/`PKD_2025`), далі autocomplete «Symbol PKD i opis podklasy…» (довідник `7810Z - Działalność agencji pracy tymczasowej` тощо; поле disabled до вибору radio).
- 3.2 Stanowisko / rodzaj pracy — textarea, max 200 знаків.
- 3.3 Nazwa i kod zawodu * — autocomplete KZiS, пошук «contains», формат `932101 - Pakowacz ręczny` (підтверджено: «pakow» → 814302, 722306, 816024, 932101, 214925).
- 3.4 Miejsce wykonywania pracy: Kod pocztowy, Województwo *, Powiat *, Gmina *, Miejscowość, Ulica, Nr domu, Nr lokalu (ті самі TERYT-autocomplete) + textarea «Informacje dodatkowe o miejscu wykonywania pracy».
- 3.5 Podstawa prawna: `mat-select` **Rodzaj umowy** * (17): Delegowanie; Kontrakt menedżerski; Mianowanie; Nie dotyczy; Powołanie; Praktyka absolwencka; Praktyka studencka; Spółdzielcza umowa o pracę; Umowa agencyjna; Umowa o dzieło; Umowa o pomocy przy zbiorach; Umowa o pracę na czas nieokreślony; Umowa o pracę na czas określony; Umowa o pracę na okres próbny; Umowa o pracę w zastępstwie; **Umowa zlecenie / Umowa o świadczenie usług**; Wybór. Checkbox «umowa z małoletnim».
- 3.6 Wymiar czasu pracy: checkbox «Nie dotyczy»; radio: Pełny etat | Część etatu ułamkowo (licznik/mianownik) | Liczba godzin pracy w tygodniu (число) | Liczba godzin pracy w miesiącu (число). Для zlecenia — години в місяць (`workers.notifyHours`).
- 3.7 Najniższe wynagrodzenie brutto: checkbox «Nie dotyczy»; radio: godzinowa w złotych (число) | miesięczna w złotych (число).

### 4. Informacja o liczbie wszystkich osób wykonujących pracę u pracodawcy
«podaj dane aktualne na dzień złożenia powiadomienia; jeśli brak takich osób należy wpisać zero». Два обовʼязкові числа:
- Liczba wszystkich osób wykonujących pracę na podstawie **umowy o pracę** *
- Liczba wszystkich osób wykonujących pracę na podstawie **umów cywilnoprawnych** *

### Załączniki
Кнопка «Dodaj załącznik» (для powiadomienia не обовʼязково).

### Osoba podpisująca wniosek
«Dodaj kolejne osoby, których podpisy są niezbędne… zgodnie z reprezentacją w KRS/CEiDG lub z pełnomocnictwami. Wszystkie wskazane osoby muszą podpisać dokument w dniu dzisiejszym do 23:59», інакше заява йде в «dokumenty do podpisu» і процес повторюється наступного дня.
- Imię, Nazwisko, PESEL — disabled, з акаунта (PESEL маскується `*********73`).
- **Pełniona funkcja** * — textarea (посада підписанта, напр. «Pełnomocnik»/«Prezes Zarządu»).
- checkbox «Dokument składa pełnomocnik, osoba uprawniona. Wymagane jest pełnomocnictwo.» + `mat-select` «Wybierz osobę» (особи з реєстрації організації).
- Для Влади: вона підписує як pełnomocnik фірми — значення «Pełniona funkcja» зберігаємо в акаунті робота (`pz_accounts.signer_function`).

Кнопки внизу: Wstecz, **Zapisz dane** (у schowek порталу), Wydruk (disabled до валідації), **Dalej** (валідація → крок 3).

## Крок 3 — Wysłanie wniosku (знято 14.10.2026), крок 4 — Podsumowanie

Після «Dalej» на формі portal повертає в кабінет `/eurzad/uslugi-elektroniczne/PSZ-PPWPU` і малює крок 3 (спінер кілька секунд; індикатор таймера сесії має `role=progressbar` постійно — на нього не орієнтуватись). Текст: «Reprezentanci wskazani na dokumencie powinni zalogować się … do dnia <сьогодні> do godziny 23:59». Три плитки з кнопкою «Podpisz i wyślij» кожна: kwalifikowany podpis elektroniczny / podpis osobisty (e-dowód) / **«Podpisz wniosek profilem zaufanym i wyślij»** («Wybór opcji przekieruje Cię na stronę pz.gov.pl»). Робот (`form.ts signAndSend`) клікає третю. Після плитки portal веде на **podpis.gov.pl**/ui/wp/<id>/preview?authnWithWK=true — «Sprawdź dokumenty przed podpisaniem» (документ «XAdES otoczony», кнопки Anuluj / **Podpisz**, банер «Klauzula przetwarzania danych…» з кнопкою «Zamknij»; знято на живій подачі #6 19.10.2026). Робот закриває банер і тисне «Podpisz» → **podpis.gov.pl/…/signature/select** «Podpisz dokument — Wybierz jedną z poniższych metod»: плитка «Profil zaufany» (решта — mObywatel/E-dowód/Certyfikat — недоступні), лінк «Wróć» (знято на подачі #8). Далі pz.gov.pl (логін/SMS) і крок 4 ще не зняті — робот іде евристиками (повторний логін #username/#password, код через `findCodeInput`, кнопки «Podpisz…»/«Potwierdź»), успіх = повернення на praca.gov.pl з «Podsumowanie» і маркером відправки без «nie został/błąd»; потвердження — PDF/XML з «Pobierz/UPP» або PNG підсумку.

## Мапа наших даних → поля форми

| Поле форми | Джерело в Grafik-bot |
|---|---|
| Imię / Kolejne imiona / Nazwisko | `workers.first_name`, `middle_name`, `last_name` |
| Obywatelstwo | `worker_questionnaires.citizenship` → назва PL (`countryNamePl`) |
| Rodzaj dokumentu / Państwo wydania / Seria i nr / Data wydania / Data ważności | анкета: `passport_number`, `passport_issued_at`, `passport_expires_at`, `passport_country` (фолбек — громадянство) |
| PESEL / Data urodzenia / Płeć | `workers.pesel`, `birth_date`, `gender` |
| Data podjęcia pracy | `workers.first_work_date` |
| Symbol PKD | `companies.pkd` (+ версія класифікації) |
| Stanowisko / rodzaj pracy | `factories.contract_duties` або `positions.name` |
| Nazwa i kod zawodu | **нове поле** `positions.kzis_code` (напр. `932101`) |
| Miejsce wykonywania pracy | адреса фабрики — потрібні структуровані TERYT-поля: **нове** (нині лише `factories.address` вільний текст + `city`) |
| Rodzaj umowy | «Umowa zlecenie / Umowa o świadczenie usług» |
| Wymiar czasu pracy | «Liczba godzin pracy w miesiącu» = `workers.notify_hours` |
| Wynagrodzenie | «godzinowa w złotych» = `factories.contract_rate_brutto` або `KSIEG_STD_BRUTTO()` |
| Liczba osób u pracodawcy | **нове**: `companies.headcount_employment` (umowa o pracę) / `headcount_civil` (umowy cywilnoprawne) |
| Numer KRAZ | **нове**: `companies.kraz` (агенція праці тимчасової) |
| Pełniona funkcja підписанта | `pz_accounts.signer_function` |

## Вхід (знято 12.10.2026 у Chrome, акаунт з трьома організаціями)

1. praca.gov.pl → «Zaloguj» → `https://login.gov.pl/?ssot=…`: плитки `button.wds-action-tile` («Profil zaufany», «Aplikacja mObywatel», «Bankowość elektroniczna», «E-dowód», «Use eID»).
2. pz.gov.pl `/ui/au/login?prid=…&client=praca.gov.pl…`: `input#username` (autocomplete username), `input#password` (current-password), `button[type=submit]` «Zaloguj się»; лінки «Przypomnij nazwę użytkownika/hasło», «Zaloguj się inną metodą lub bankowością elektroniczną».
3. Після submit — модалка `mat-dialog` «Potwierdź logowanie» (`h2#sms-confirmation-modal-title`): «Wpisz kod SMS, który wysłaliśmy na numer telefonu: +48 ******679», поле `input#smsInput` (label «Kod SMS z <дата>, godzina <час>»), кнопки «Potwierdź» / «Anuluj», лінк «Wyślij nowy kod lub potwierdź innym sposobem».
4. Повернення на `https://www.praca.gov.pl/eurzad/strona-glowna`. Шапка `pgp-header`: кнопка `button.mat-mdc-menu-trigger` з текстом «<IMIĘ NAZWISKO> Kontekst: Osoba fizyczna» (aria «Przejdź do ustawień użytkownika»), «Do końca sesji pozostało 30 minut».
5. Меню користувача (`[role=menuitem]`): «Zarządzanie kontem», «Zmiana kontekstu», «Zakładanie konta organizacji», «Domyślny urząd», «Wyloguj się».
6. «Zmiana kontekstu» → `mat-dialog-container` з таблицею `tr.mat-row` (Nazwa | Typ): рядок «<IMIĘ NAZWISKO> | Osoba fizyczna» і по рядку на організацію (у знятого акаунта: EURO SUPPORT OUTSOURCING SP. Z O.O., EUROSUPPORT GROUP SP. Z O.O., Klinex sp. z o.o.); фільтр `input#mat-input-N`, пагінація, «Anuluj». Клік по рядку = вибір контексту (перевірити на тесті робота, чи потрібне підтвердження).

## Робот: знахідки з тестових прогонів 13.10.2026 (контекст організації)

- Портал сам підставляє województwo/powiat/gmina/miejscowość з індексу (асинхронно) — після індексу чекати, вже заповнене не чіпати.
- «Symbol PKD i opis…» — автодоповнення; підпис «Symbol PKD według:» (перемикач) починається так само — шукати по повному підпису. Код у базі «78.10.Z» → набір «7810Z».
- «Tytuł pobytu» — у контексті організації це `pgp-autocomplete` (не mat-select) без prefill; обираємо «OCHRONA CZASOWA».
- 1.2 e-mail і 1.3 Nr telefonu — обовʼязкові на порталі; portal підставляє їх з реєстрації організації (у Klinex були заповнені, у EUROSUPPORT GROUP — ні). Наші `companies.contact_email/contact_phone` перезаписують підставлене; порожні у нас → лишаємо портальні (попередження в анкеті).
- Контексти ES / ESO / Klinex (14.10.2026): форма ідентична (84 елементи), «Numer KRAZ» є в усіх (порожнє для аутсорсингу). «Tytuł pobytu» в одних сесіях підставлений «OCHRONA CZASOWA» і заблокований, в інших — порожній список; робот обробляє обидва.
- 3.6/3.7: числові поля стоять у рядку з перемикачем і не мають підпису — беремо перший увімкнений input біля перемикача. При годинній ставці портал вимагає ще «oraz najniższe miesięczne wynagrodzenie … na podstawie stawki godzinowej» = ставка × години; `mat-error` під вимкненим полем «miesięczna w złotych» — артефакт, ігнорується.
- Підписант: Imię/Nazwisko/PESEL з акаунта; «Pełniona funkcja» обовʼязкова (`pz_accounts.signer_function`, напр. «Specjalista ds. kadr»). Галочка «składa pełnomocnik» відкриває обовʼязковий załącznik pełnomocnictwa — у нас люди мають прямі права, галочку не ставимо (ставиться лише якщо в акаунт завантажено PDF довіреності).
- «Data podjęcia pracy» має бути в межах 7 днів до дати повідомлення, інакше форма невалідна (прострочені подачі портал не приймає).
- «Zapisz dane» відкриває меню: «Zapis do schowka praca.gov.pl» | «Zapis do dokumentów roboczych».
- Поле «Wydruk» стає активним лише на валідній формі — ознака, що всі обовʼязкові поля прийнято.
- Ulica (3.4) — автодоповнення «Wpisz min. 3 znaki», поки не заповнюється (необовʼязкове).

## Звірка з реальними подачами (19.10.2026)

Три повідомлення, подані Владою руками (ESO/DAWTONA 12.10, Klinex/PREMIUM FRUITS 28.09, ESG/AGRAM LUBLIN 12.10), проти нашого payload:

- **3.1 PKD** — діяльність, яку виконує cudzoziemiec, не PKD агенції: у всіх трьох `1039Z` (przetwarzanie owoców i warzyw), класифікація **PKD-2025** (одна — 2007). Тепер `factories.ua_pkd` → фолбек `companies.pkd`; дефолт версії PKD_2025.
- **3.2/3.3** — «Przetwórca owoców i warzyw» / **751402** на овочево-фруктових заводах (сід у `2026-10-19-praca-gov-pkd-filings.sql`), не «Pracownik produkcji» 932990.
- **Tytuł pobytu** — не завжди OCHRONA CZASOWA: власник karty czasowej → **POBYT CZASOWY**. Опції довідника в контексті організації: OCHRONA CZASOWA; OCHRONA UZUPEŁNIAJĄCA; POBYT CZASOWY; POBYT CZŁONKA RODZINY OBYWATELA UE; POBYT HUMANITARNY; POBYT NA PODSTAWIE ART. 108 UST. 1 PKT 1, ART. 206 UST. 1 PKT 2 LUB 223 USTAWY O CUDZOZIEMCACH. Payload виводить з документів (trc → POBYT CZASOWY, zaświadczenie o złożeniu wniosku → art. 108, інакше OCHRONA CZASOWA), поле редагується в анкеті; якщо portal підставив і заблокував — лишаємо його значення (warn у лог).
- **3.4** — nr budynku і nr lokalu окремо (44 / B); «Informacje dodatkowe» Влада лишає порожнім або пише примітку (у нас — назва фабрики + адреса, не шкодить).
- **3.6/3.7** — 40 год, 31,40 → 1 256,00 — збігається з `ua_notify_hours`.
- **4** — ESG 0/209, ESO 3/131, Klinex 3/25 (на дату подач).
- **1.2/1.3** — office.eurosupp@gmail.com; телефони ESO/ESG 792182764, Klinex 530878711.
- **Załączniki** — Влада додає скан паспорта і два файли «88Z» фірми за місяць (oświadczenie podmiotu ws. okoliczności art. 13 ust. 1 pkt 1 lit. c–g ustawy z 20.03.2025 — некараність; джерело: Drive офісу, папка «88Z» → місяць). З 19.10.2026 файли живуть у `pz_company_attachments` (Налаштування → praca.gov.pl → Фірми), робот додає їх + скан паспорта з профілю через «Dodaj załącznik» (`form.ts addAttachments`, best-effort: розмітку секції не знято, невдалий załącznik знімається й не валить подачу — перевіряти у Wydruku).
- Підписант: «Pracownik działu kadr» (у нас налаштовано «Specjalista ds. kadr» — поле акаунта).

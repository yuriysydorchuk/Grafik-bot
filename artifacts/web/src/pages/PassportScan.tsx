// Публічна сторінка сканування паспорта (/passport-scan/:token) — заміна
// завантаження фото в Telegram: камера прямо в браузері з рамкою-підказкою
// (без живого зелено/червоного індикатора — власник обрав просту статичну
// підказку), або файл/PDF. Двоетапно: analyze() запускає OCR (Vision+MRZ) і
// кладе файл+чернетку в токен; екран підтвердження показує РОЗПІЗНАНЕ —
// вручну ввести ім'я «з нуля» не можна, а виправити (диктовки OCR) — можна;
// confirm() із фінальних полів створює працівника. БЕЗ сесії — токен єдина
// авторизація (той самий підхід, що /sign/:token).
import { useEffect, useRef, useState } from "react";
import { useRoute } from "wouter";
import { Card, Button, Spinner, SearchableSelect } from "../components/ui";
import { TAX_OFFICES } from "../lib/taxOffices";
import { validatePassport, validateQuestionnaire, CONSENT_KEYS, type ConsentKey } from "../lib/questionnaireRules";
import { NFZ_BRANCHES } from "../lib/nfzBranches";

type Lang = "uk" | "en" | "es" | "ru" | "pl";
const STR: Record<string, Record<Lang, string>> = {
  loading: { uk: "Завантаження…", en: "Loading…", es: "Cargando…", ru: "Загрузка…", pl: "Ładowanie…" },
  invalidTitle: { uk: "Лінк недійсний", en: "Invalid link", es: "Enlace no válido", ru: "Ссылка недействительна", pl: "Nieprawidłowy link" },
  contact: { uk: "Зверніться до офісу за новим посиланням.", en: "Contact the office for a new link.", es: "Contacta con la oficina para un nuevo enlace.", ru: "Обратитесь в офис за новой ссылкой.", pl: "Skontaktuj się z biurem po nowy link." },
  title: { uk: "Скан паспорта", en: "Passport scan", es: "Escaneo de pasaporte", ru: "Скан паспорта", pl: "Skan paszportu" },
  hint: { uk: "Розмісти паспорт (сторінку з фото та рядками внизу) у рамці й зроби фото — або завантаж наявне фото/PDF.", en: "Place the passport (photo page with the lines at the bottom) inside the frame and take a photo — or upload an existing photo/PDF.", es: "Coloca el pasaporte (página con foto y líneas abajo) dentro del marco y toma una foto — o sube una foto/PDF existente.", ru: "Разместите паспорт (страницу с фото и строками внизу) в рамке и сделайте фото — или загрузите готовое фото/PDF.", pl: "Umieść paszport (strona ze zdjęciem i liniami na dole) w ramce i zrób zdjęcie — albo prześlij istniejące zdjęcie/PDF." },
  shutter: { uk: "Зробити фото", en: "Take photo", es: "Tomar foto", ru: "Сделать фото", pl: "Zrób zdjęcie" },
  upload: { uk: "Завантажити фото/PDF", en: "Upload photo/PDF", es: "Subir foto/PDF", ru: "Загрузить фото/PDF", pl: "Prześlij zdjęcie/PDF" },
  noCamera: { uk: "Камера недоступна — завантаж фото або PDF файлом.", en: "Camera unavailable — upload a photo or PDF file instead.", es: "Cámara no disponible — sube una foto o PDF.", ru: "Камера недоступна — загрузите фото или PDF файлом.", pl: "Aparat niedostępny — prześlij zdjęcie lub plik PDF." },
  analyzing: { uk: "🔎 Розпізнаю паспорт…", en: "🔎 Reading your passport…", es: "🔎 Leyendo tu pasaporte…", ru: "🔎 Распознаю паспорт…", pl: "🔎 Odczytuję paszport…" },
  analyzingHint: { uk: "Це може зайняти до хвилини — не закривай сторінку.", en: "This can take up to a minute — don't close the page.", es: "Esto puede tardar hasta un minuto — no cierres la página.", ru: "Это может занять до минуты — не закрывай страницу.", pl: "To może potrwać do minuty — nie zamykaj strony." },
  analyzeFailed: { uk: "Не вдалося розпізнати. Сфотографуй чіткіше (рівне освітлення, без відблисків) і спробуй ще раз.", en: "Couldn't read the passport. Take a clearer photo (even lighting, no glare) and try again.", es: "No se pudo leer el pasaporte. Toma una foto más clara (luz uniforme, sin reflejos) e inténtalo de nuevo.", ru: "Не удалось распознать. Сфотографируйте чётче (ровное освещение, без бликов) и попробуйте снова.", pl: "Nie udało się odczytać. Zrób wyraźniejsze zdjęcie (równe oświetlenie, bez odblasków) i spróbuj ponownie." },
  retry: { uk: "Спробувати ще раз", en: "Try again", es: "Intentar de nuevo", ru: "Попробовать снова", pl: "Spróbuj ponownie" },
  confirmTitle: { uk: "Перевір дані", en: "Check the details", es: "Revisa los datos", ru: "Проверь данные", pl: "Sprawdź dane" },
  confirmHint: { uk: "Розпізнано з паспорта — виправ, якщо десь помилка.", en: "Read from the passport — fix anything that's wrong.", es: "Leído del pasaporte — corrige si algo está mal.", ru: "Распознано с паспорта — исправь, если где-то ошибка.", pl: "Odczytano z paszportu — popraw, jeśli coś jest błędne." },
  firstName: { uk: "Ім'я (латиницею)", en: "First name (Latin letters)", es: "Nombre (letras latinas)", ru: "Имя (латиницей)", pl: "Imię (alfabet łaciński)" },
  middleName: { uk: "Друге ім'я, якщо є (латиницею)", en: "Middle name, if any (Latin letters)", es: "Segundo nombre, si lo hay (letras latinas)", ru: "Второе имя, если есть (латиницей)", pl: "Drugie imię, jeśli jest (alfabet łaciński)" },
  lastName: { uk: "Прізвище (латиницею)", en: "Last name (Latin letters)", es: "Apellido (letras latinas)", ru: "Фамилия (латиницей)", pl: "Nazwisko (alfabet łaciński)" },
  birthDate: { uk: "Дата народження", en: "Date of birth", es: "Fecha de nacimiento", ru: "Дата рождения", pl: "Data urodzenia" },
  passportNumber: { uk: "Номер паспорта", en: "Passport number", es: "Número de pasaporte", ru: "Номер паспорта", pl: "Numer paszportu" },
  passportCountry: { uk: "Країна видачі", en: "Issuing country", es: "País de emisión", ru: "Страна выдачи", pl: "Kraj wydania" },
  passportExpiresAt: { uk: "Дійсний до", en: "Valid until", es: "Válido hasta", ru: "Действителен до", pl: "Ważny do" },
  citizenship: { uk: "Громадянство", en: "Citizenship", es: "Ciudadanía", ru: "Гражданство", pl: "Obywatelstwo" },
  sex: { uk: "Стать", en: "Sex", es: "Sexo", ru: "Пол", pl: "Płeć" },
  male: { uk: "Чоловіча", en: "Male", es: "Masculino", ru: "Мужской", pl: "Mężczyzna" },
  female: { uk: "Жіноча", en: "Female", es: "Femenino", ru: "Женский", pl: "Kobieta" },
  retakePhoto: { uk: "Переробити фото", en: "Retake photo", es: "Repetir foto", ru: "Переснять фото", pl: "Zrób zdjęcie ponownie" },
  confirmBtn: { uk: "Підтвердити", en: "Confirm", es: "Confirmar", ru: "Подтвердить", pl: "Potwierdź" },
  // повернення звільненого: ім'я зі скану збіглось зі старим профілем (routes/passportScan.ts → rehireCandidate)
  rehireTitle: { uk: "Ви вже працювали у нас?", en: "Have you worked with us before?", es: "¿Ya trabajaste con nosotros?", ru: "Вы уже работали у нас?", pl: "Pracowałeś(-aś) już u nas?" },
  rehireText: { uk: "Знайдено профіль {name} (№{code}). Це ви?", en: "We found a profile {name} (No. {code}). Is that you?", es: "Encontramos un perfil {name} (nº {code}). ¿Eres tú?", ru: "Найден профиль {name} (№{code}). Это вы?", pl: "Znaleziono profil {name} (nr {code}). To Ty?" },
  rehireHint: { uk: "Якщо це ви — старий профіль відновлять після підтвердження офісу (з цим Telegram), а анкету заповните зараз. Повідомимо в боті.", en: "If it's you, the office will restore your old profile (with this Telegram) after confirmation; fill in the questionnaire now. We'll let you know in the bot.", es: "Si eres tú, la oficina restaurará tu perfil antiguo (con este Telegram) tras confirmarlo; rellena el cuestionario ahora. Te avisaremos en el bot.", ru: "Если это вы — старый профиль восстановят после подтверждения офиса (с этим Telegram), а анкету заполните сейчас. Сообщим в боте.", pl: "Jeśli to Ty — biuro przywróci Twój stary profil (z tym Telegramem) po potwierdzeniu; ankietę wypełnij teraz. Damy znać w bocie." },
  rehireMe: { uk: "✅ Це я, оновити мій Telegram", en: "✅ That's me, update my Telegram", es: "✅ Soy yo, actualizar mi Telegram", ru: "✅ Это я, обновить мой Telegram", pl: "✅ To ja, zaktualizuj mój Telegram" },
  rehireNotMe: { uk: "❌ Ні, це інша людина", en: "❌ No, that's someone else", es: "❌ No, es otra persona", ru: "❌ Нет, это другой человек", pl: "❌ Nie, to ktoś inny" },
  badName: { uk: "Ім'я та прізвище — лише латиницею (напр. Jan Kowalski)", en: "Name — Latin letters only (e.g. Jan Kowalski)", es: "Nombre — solo letras latinas (p. ej. Jan Kowalski)", ru: "Имя — только латиницей (напр. Jan Kowalski)", pl: "Imię — tylko alfabet łaciński (np. Jan Kowalski)" },
  successTitle: { uk: "✅ Готово!", en: "✅ Done!", es: "✅ ¡Listo!", ru: "✅ Готово!", pl: "✅ Gotowe!" },
  successBody: { uk: "Дані передано в офіс. Можеш закрити цю сторінку.", en: "Your details have been sent to the office. You can close this page now.", es: "Tus datos se enviaron a la oficina. Ya puedes cerrar esta página.", ru: "Данные переданы в офис. Можешь закрыть эту страницу.", pl: "Dane przesłano do biura. Możesz zamknąć tę stronę." },
  error: { uk: "Помилка", en: "Error", es: "Error", ru: "Ошибка", pl: "Błąd" },
  qTitle: { uk: "Ще трохи даних", en: "A few more details", es: "Unos datos más", ru: "Ещё немного данных", pl: "Jeszcze kilka danych" },
  qHint: { uk: "Це потрібно для оформлення умови — заповни, що знаєш, решту офіс уточнить.", en: "This is needed for the contract — fill in what you know, the office will check the rest.", es: "Esto es necesario para el contrato — completa lo que sepas, la oficina revisará el resto.", ru: "Это нужно для оформления договора — заполни, что знаешь, остальное офис уточнит.", pl: "To potrzebne do umowy — wypełnij, co wiesz, resztę sprawdzi biuro." },
  birthPlace: { uk: "Місце народження", en: "Place of birth", es: "Lugar de nacimiento", ru: "Место рождения", pl: "Miejsce urodzenia" },
  pesel: { uk: "PESEL", en: "PESEL", es: "PESEL", ru: "PESEL", pl: "PESEL" },
  peselBad: { uk: "PESEL — 11 цифр", en: "PESEL — 11 digits", es: "PESEL — 11 dígitos", ru: "PESEL — 11 цифр", pl: "PESEL — 11 cyfr" },
  addressPl: { uk: "Адреса проживання в Польщі", en: "Address in Poland", es: "Dirección en Polonia", ru: "Адрес проживания в Польше", pl: "Adres zamieszkania w Polsce" },
  postalCode: { uk: "Поштовий індекс", en: "Postal code", es: "Código postal", ru: "Почтовый индекс", pl: "Kod pocztowy" },
  city: { uk: "Місто/gmina", en: "Town/gmina", es: "Ciudad/gmina", ru: "Город/gmina", pl: "Miejscowość/gmina" },
  addressRegisteredSame: { uk: "Адреса замельдування — така сама, як вище", en: "Registered address is the same as above", es: "La dirección de empadronamiento es la misma que arriba", ru: "Адрес прописки — такой же, как выше", pl: "Adres zameldowania — taki sam jak wyżej" },
  addressRegistered: { uk: "Адреса замельдування (прописки)", en: "Registered (permanent) address", es: "Dirección de empadronamiento", ru: "Адрес прописки", pl: "Adres zameldowania" },
  motherName: { uk: "Імʼя мами", en: "Mother's first name", es: "Nombre de la madre", ru: "Имя мамы", pl: "Imię matki" },
  fatherName: { uk: "Імʼя тата", en: "Father's first name", es: "Nombre del padre", ru: "Имя папы", pl: "Imię ojca" },
  bankName: { uk: "Назва банку", en: "Bank name", es: "Nombre del banco", ru: "Название банка", pl: "Nazwa banku" },
  bankIban: { uk: "Номер банківського рахунку (польський)", en: "Bank account number (Polish)", es: "Número de cuenta bancaria (polaca)", ru: "Номер банковского счёта (польский)", pl: "Numer konta bankowego (polskie)" },
  phone: { uk: "Номер телефону", en: "Phone number", es: "Número de teléfono", ru: "Номер телефона", pl: "Numer telefonu" },
  email: { uk: "Email", en: "Email", es: "Email", ru: "Email", pl: "E-mail" },
  taxOffice: { uk: "Urząd skarbowy (податкова)", en: "Tax office (urząd skarbowy)", es: "Oficina de impuestos (urząd skarbowy)", ru: "Налоговая (urząd skarbowy)", pl: "Urząd skarbowy" },
  nfzBranch: { uk: "Відділення NFZ", en: "NFZ branch", es: "Sucursal NFZ", ru: "Отделение NFZ", pl: "Oddział NFZ" },
  isStudent: { uk: "Я студент(ка)", en: "I'm a student", es: "Soy estudiante", ru: "Я студент(ка)", pl: "Jestem studentem/studentką" },
  schoolName: { uk: "Назва навчального закладу", en: "School / university name", es: "Nombre del centro de estudios", ru: "Название учебного заведения", pl: "Nazwa szkoły/uczelni" },
  certLabel: { uk: "Актуальна довідка студента (фото/PDF)", en: "Current student certificate (photo/PDF)", es: "Certificado de estudiante actual (foto/PDF)", ru: "Актуальная справка студента (фото/PDF)", pl: "Aktualne zaświadczenie ze szkoły (zdjęcie/PDF)" },
  hasOtherEmployment: { uk: "У мене є інша робота", en: "I have another job", es: "Tengo otro trabajo", ru: "У меня есть другая работа", pl: "Mam inną pracę" },
  otherEmploymentNote: { uk: "Опис іншої роботи", en: "Details of the other job", es: "Detalles del otro trabajo", ru: "Описание другой работы", pl: "Opis innej pracy" },
  isRegisteredUnemployed: { uk: "Я зареєстрований(а) як безробітний(а) в Польщі (urząd pracy)", en: "I'm registered as unemployed in Poland (urząd pracy)", es: "Estoy registrado(a) como desempleado(a) en Polonia (urząd pracy)", ru: "Я зарегистрирован(а) как безработный(ая) в Польше (urząd pracy)", pl: "Jestem zarejestrowany(-a) jako bezrobotny(-a) w Polsce (urząd pracy)" },
  emergencyContact: { uk: "Контакт для екстрених випадків (ім'я + телефон)", en: "Emergency contact (name + phone)", es: "Contacto de emergencia (nombre + teléfono)", ru: "Контакт для экстренных случаев (имя + телефон)", pl: "Kontakt alarmowy (imię + telefon)" },
  nip: { uk: "НІП (необов'язково)", en: "NIP (optional)", es: "NIP (opcional)", ru: "НИП (необязательно)", pl: "NIP (opcjonalnie)" },
  taxOfficeAddress: { uk: "Адреса податкової (Urząd Skarbowy)", en: "Tax office address", es: "Dirección de la oficina de impuestos", ru: "Адрес налоговой", pl: "Adres urzędu skarbowego" },
  pit0Label: { uk: "Пільга «zerowy PIT» — 0% податку для осіб до 26 років", en: "\"Zero PIT\" relief — 0% income tax for people under 26", es: "Alivio «PIT cero» — 0% de impuesto para menores de 26 años", ru: "Льгота «нулевой PIT» — 0% налога для лиц до 26 лет", pl: "Ulga „zerowy PIT” — 0% podatku dla osób do 26. roku życia" },
  ankietaInnyPracodawca: { uk: "Маю іншого роботодавця, який теж звітує за мене в ZUS", en: "I have another employer who also reports me to ZUS", es: "Tengo otro empleador que también me declara ante ZUS", ru: "У меня есть другой работодатель, который тоже отчитывается за меня в ZUS", pl: "Mam innego pracodawcę, który również zgłasza mnie do ZUS" },
  ankietaEmeryt: { uk: "Я емерит (отримую пенсію за віком)", en: "I'm a retiree (receiving an old-age pension)", es: "Soy jubilado/a (recibo una pensión por edad)", ru: "Я пенсионер (получаю пенсию по возрасту)", pl: "Jestem emerytem/emerytką" },
  ankietaRencista: { uk: "Отримую пенсію по інвалідності (rencista)", en: "I receive a disability pension (rencista)", es: "Recibo una pensión por discapacidad (rencista)", ru: "Получаю пенсию по инвалидности (rencista)", pl: "Jestem rencistą/rencistką" },
  ankietaNiepelnosprawnosc: { uk: "Маю встановлену групу інвалідності", en: "I have a registered disability status", es: "Tengo un grado de discapacidad reconocido", ru: "У меня установлена группа инвалидности", pl: "Mam orzeczony stopień niepełnosprawności" },
  ankietaSkladkaChorobowa: { uk: "Хочу добровільну хворобову складку (chorobowe)", en: "I want voluntary sickness insurance (chorobowe)", es: "Quiero el seguro de enfermedad voluntario (chorobowe)", ru: "Хочу добровольный больничный взнос (chorobowe)", pl: "Chcę dobrowolną składkę chorobową" },
  regAddressTitle: { uk: "Адреса замельдування (прописки)", en: "Registered address (zameldowanie)", es: "Dirección de empadronamiento (zameldowanie)", ru: "Адрес прописки (zameldowanie)", pl: "Adres zameldowania" },
  zamAddressTitle: { uk: "Адреса проживання в Польщі", en: "Residential address in Poland", es: "Dirección de residencia en Polonia", ru: "Адрес проживания в Польше", pl: "Adres zamieszkania w Polsce" },
  zamSameAsReg: { uk: "Така сама, як замельдування вище", en: "Same as the registered address above", es: "Misma que la dirección de empadronamiento", ru: "Такой же, как адрес прописки", pl: "Taki sam jak adres zameldowania wyżej" },
  fieldWojewodztwo: { uk: "Воєводство", en: "Voivodeship (województwo)", es: "Voivodato (województwo)", ru: "Воеводство", pl: "Województwo" },
  fieldPowiat: { uk: "Повіт (powiat)", en: "County (powiat)", es: "Distrito (powiat)", ru: "Повят (powiat)", pl: "Powiat" },
  fieldGmina: { uk: "Гміна (gmina)", en: "Commune (gmina)", es: "Municipio (gmina)", ru: "Гмина (gmina)", pl: "Gmina" },
  fieldMiejscowosc: { uk: "Населений пункт", en: "Town/village", es: "Localidad", ru: "Населённый пункт", pl: "Miejscowość" },
  fieldUlica: { uk: "Вулиця", en: "Street", es: "Calle", ru: "Улица", pl: "Ulica" },
  fieldNumerDomu: { uk: "Номер будинку", en: "House number", es: "Número de casa", ru: "Номер дома", pl: "Numer domu" },
  fieldKodPocztowy: { uk: "Поштовий індекс", en: "Postal code", es: "Código postal", ru: "Почтовый индекс", pl: "Kod pocztowy" },
  // ── обов'язкові поля, підказки, коди помилок (08.09.2026: усе латиницею, формати) ──
  requiredMark: { uk: "обов'язково", en: "required", es: "obligatorio", ru: "обязательно", pl: "wymagane" },
  latinOnly: { uk: "Лише латиницею", en: "Latin letters only", es: "Solo letras latinas", ru: "Только латиницей", pl: "Tylko alfabet łaciński" },
  qHintStrict: { uk: "Усі поля зі знаком * обов'язкові. Заповнюй лише латиницею (як у паспорті), під кожним полем є приклад.", en: "All fields marked * are required. Use Latin letters only (as in your passport); each field shows an example.", es: "Todos los campos con * son obligatorios. Usa solo letras latinas (como en el pasaporte); cada campo muestra un ejemplo.", ru: "Все поля со знаком * обязательны. Заполняй только латиницей (как в паспорте), под каждым полем есть пример.", pl: "Wszystkie pola oznaczone * są wymagane. Wpisuj tylko alfabetem łacińskim (jak w paszporcie); pod każdym polem jest przykład." },
  fixErrors: { uk: "Перевір позначені поля", en: "Please check the highlighted fields", es: "Revisa los campos marcados", ru: "Проверь отмеченные поля", pl: "Sprawdź zaznaczone pola" },
  errRequired: { uk: "Обов'язкове поле", en: "Required", es: "Obligatorio", ru: "Обязательное поле", pl: "Pole wymagane" },
  errLatin: { uk: "Лише латиниця (без кирилиці)", en: "Latin letters only (no Cyrillic)", es: "Solo letras latinas (sin cirílico)", ru: "Только латиница (без кириллицы)", pl: "Tylko alfabet łaciński (bez cyrylicy)" },
  errFormat: { uk: "Неправильний формат — дивись приклад", en: "Wrong format — see the example", es: "Formato incorrecto — mira el ejemplo", ru: "Неверный формат — смотри пример", pl: "Zły format — zobacz przykład" },
  errChecksum: { uk: "Номер неправильний (не сходиться контрольна цифра)", en: "Invalid number (check digit doesn't match)", es: "Número inválido (dígito de control incorrecto)", ru: "Номер неверный (не сходится контрольная цифра)", pl: "Nieprawidłowy numer (nie zgadza się cyfra kontrolna)" },
  errDate: { uk: "Дата не збігається з датою народження", en: "Doesn't match the date of birth", es: "No coincide con la fecha de nacimiento", ru: "Дата не совпадает с датой рождения", pl: "Nie zgadza się z datą urodzenia" },
  errBadDate: { uk: "Неправильна дата", en: "Invalid date", es: "Fecha no válida", ru: "Неверная дата", pl: "Nieprawidłowa data" },
  errAge: { uk: "Вік має бути від 16 до 80 років", en: "Age must be between 16 and 80", es: "La edad debe estar entre 16 y 80", ru: "Возраст должен быть от 16 до 80 лет", pl: "Wiek musi być między 16 a 80 lat" },
  errExpired: { uk: "Дата має бути в майбутньому", en: "Must be a future date", es: "Debe ser una fecha futura", ru: "Дата должна быть в будущем", pl: "Data musi być w przyszłości" },
  errList: { uk: "Обери зі списку (почни вводити місто)", en: "Choose from the list (start typing the city)", es: "Elige de la lista (empieza a escribir la ciudad)", ru: "Выбери из списка (начни вводить город)", pl: "Wybierz z listy (zacznij wpisywać miasto)" },
  errConsent: { uk: "Потрібна згода", en: "Consent required", es: "Se requiere consentimiento", ru: "Нужно согласие", pl: "Wymagana zgoda" },
  hintName: { uk: "напр. Jan", en: "e.g. Jan", es: "p. ej. Jan", ru: "напр. Jan", pl: "np. Jan" },
  hintLastName: { uk: "напр. Kowalski", en: "e.g. Kowalski", es: "p. ej. Kowalski", ru: "напр. Kowalski", pl: "np. Kowalski" },
  hintBirthDate: { uk: "від 16 до 80 років", en: "age 16 to 80", es: "de 16 a 80 años", ru: "от 16 до 80 лет", pl: "od 16 do 80 lat" },
  hintPassportNo: { uk: "великі літери й цифри, напр. FC1234567", en: "capital letters and digits, e.g. FC1234567", es: "mayúsculas y dígitos, p. ej. FC1234567", ru: "заглавные буквы и цифры, напр. FC1234567", pl: "wielkie litery i cyfry, np. FC1234567" },
  hintCountry: { uk: "напр. Ukraina", en: "e.g. Ukraina", es: "p. ej. Ukraina", ru: "напр. Ukraina", pl: "np. Ukraina" },
  hintExpires: { uk: "дата з паспорта, має бути в майбутньому", en: "from the passport, must be in the future", es: "del pasaporte, debe ser futura", ru: "дата из паспорта, должна быть в будущем", pl: "z paszportu, musi być w przyszłości" },
  hintBirthPlace: { uk: "місто латиницею, напр. Lwów", en: "city in Latin letters, e.g. Lwów", es: "ciudad en letras latinas, p. ej. Lwów", ru: "город латиницей, напр. Lwów", pl: "miasto, np. Lwów" },
  hintPesel: { uk: "11 цифр, напр. 95050512346", en: "11 digits, e.g. 95050512346", es: "11 dígitos, p. ej. 95050512346", ru: "11 цифр, напр. 95050512346", pl: "11 cyfr, np. 95050512346" },
  hintParent: { uk: "лише ім'я латиницею, напр. Maria", en: "first name only, Latin letters, e.g. Maria", es: "solo el nombre, letras latinas, p. ej. Maria", ru: "только имя латиницей, напр. Maria", pl: "tylko imię, np. Maria" },
  hintBank: { uk: "напр. PKO BP", en: "e.g. PKO BP", es: "p. ej. PKO BP", ru: "напр. PKO BP", pl: "np. PKO BP" },
  hintNrb: { uk: "польський рахунок, 26 цифр: PL 61 1090 1014 0000 0712 1981 2874", en: "Polish account, 26 digits: PL 61 1090 1014 0000 0712 1981 2874", es: "cuenta polaca, 26 dígitos: PL 61 1090 1014 0000 0712 1981 2874", ru: "польский счёт, 26 цифр: PL 61 1090 1014 0000 0712 1981 2874", pl: "polskie konto, 26 cyfr: PL 61 1090 1014 0000 0712 1981 2874" },
  hintPhone: { uk: "напр. +48 600 000 000", en: "e.g. +48 600 000 000", es: "p. ej. +48 600 000 000", ru: "напр. +48 600 000 000", pl: "np. +48 600 000 000" },
  hintEmail: { uk: "напр. jan.kowalski@gmail.com", en: "e.g. jan.kowalski@gmail.com", es: "p. ej. jan.kowalski@gmail.com", ru: "напр. jan.kowalski@gmail.com", pl: "np. jan.kowalski@gmail.com" },
  hintTaxOffice: { uk: "почни вводити місто й обери зі списку, напр. Lublin", en: "start typing the city and pick from the list, e.g. Lublin", es: "empieza a escribir la ciudad y elige de la lista, p. ej. Lublin", ru: "начни вводить город и выбери из списка, напр. Lublin", pl: "zacznij wpisywać miasto i wybierz z listy, np. Lublin" },
  hintNfz: { uk: "обери воєводство зі списку, напр. Lubelski", en: "pick your voivodeship from the list, e.g. Lubelski", es: "elige tu voivodato de la lista, p. ej. Lubelski", ru: "выбери воеводство из списка, напр. Lubelski", pl: "wybierz województwo z listy, np. Lubelski" },
  hintSchool: { uk: "напр. Uniwersytet Marii Curie-Skłodowskiej", en: "e.g. Uniwersytet Marii Curie-Skłodowskiej", es: "p. ej. Uniwersytet Marii Curie-Skłodowskiej", ru: "напр. Uniwersytet Marii Curie-Skłodowskiej", pl: "np. Uniwersytet Marii Curie-Skłodowskiej" },
  hintOtherJob: { uk: "де і ким, латиницею", en: "where and as what, Latin letters", es: "dónde y como qué, letras latinas", ru: "где и кем, латиницей", pl: "gdzie i jako kto" },
  hintEmergency: { uk: "необов'язково, напр. Anna Kowalska +48 600 000 000", en: "optional, e.g. Anna Kowalska +48 600 000 000", es: "opcional, p. ej. Anna Kowalska +48 600 000 000", ru: "необязательно, напр. Anna Kowalska +48 600 000 000", pl: "opcjonalnie, np. Anna Kowalska +48 600 000 000" },
  hintNip: { uk: "необов'язково, 10 цифр", en: "optional, 10 digits", es: "opcional, 10 dígitos", ru: "необязательно, 10 цифр", pl: "opcjonalnie, 10 cyfr" },
  hintWoj: { uk: "напр. lubelskie", en: "e.g. lubelskie", es: "p. ej. lubelskie", ru: "напр. lubelskie", pl: "np. lubelskie" },
  hintPowiat: { uk: "напр. Lublin", en: "e.g. Lublin", es: "p. ej. Lublin", ru: "напр. Lublin", pl: "np. Lublin" },
  hintGmina: { uk: "напр. Lublin", en: "e.g. Lublin", es: "p. ej. Lublin", ru: "напр. Lublin", pl: "np. Lublin" },
  hintMiejscowosc: { uk: "напр. Lublin", en: "e.g. Lublin", es: "p. ej. Lublin", ru: "напр. Lublin", pl: "np. Lublin" },
  hintUlica: { uk: "напр. Długa", en: "e.g. Długa", es: "p. ej. Długa", ru: "напр. Długa", pl: "np. Długa" },
  hintNrDomu: { uk: "будинок/квартира, напр. 5/12", en: "house/flat, e.g. 5/12", es: "casa/piso, p. ej. 5/12", ru: "дом/квартира, напр. 5/12", pl: "dom/mieszkanie, np. 5/12" },
  hintKod: { uk: "формат 00-000, напр. 20-076", en: "format 00-000, e.g. 20-076", es: "formato 00-000, p. ej. 20-076", ru: "формат 00-000, напр. 20-076", pl: "format 00-000, np. 20-076" },
  consentsTitle: { uk: "Згоди", en: "Consents", es: "Consentimientos", ru: "Согласия", pl: "Zgody" },
  consentsHint: { uk: "Відміть усі, щоб завершити.", en: "Tick all to finish.", es: "Marca todas para terminar.", ru: "Отметь все, чтобы завершить.", pl: "Zaznacz wszystkie, aby zakończyć." },
  cRodoInfo: { uk: "Ознайомився(-лась) з інформацією про обробку персональних даних; адміністратор даних — {company}.", en: "I have read the information on personal data processing; the data controller is {company}.", es: "He leído la información sobre el tratamiento de datos personales; el responsable es {company}.", ru: "Ознакомился(-ась) с информацией об обработке персональных данных; администратор данных — {company}.", pl: "Zapoznałem(-am) się z informacją o przetwarzaniu danych osobowych; administratorem danych jest {company}." },
  cProcessing: { uk: "Погоджуюсь на обробку моїх персональних даних для укладення і виконання umowy zlecenia.", en: "I consent to the processing of my personal data to conclude and perform the umowa zlecenie.", es: "Consiento el tratamiento de mis datos personales para celebrar y ejecutar la umowa zlecenie.", ru: "Соглашаюсь на обработку моих персональных данных для заключения и выполнения umowy zlecenia.", pl: "Wyrażam zgodę na przetwarzanie moich danych osobowych w celu zawarcia i realizacji umowy zlecenia." },
  cStorage: { uk: "Погоджуюсь на зберігання моїх даних протягом строку, передбаченого законом (ZUS, податки).", en: "I consent to storing my data for the period required by law (ZUS, taxes).", es: "Consiento la conservación de mis datos durante el periodo exigido por la ley (ZUS, impuestos).", ru: "Соглашаюсь на хранение моих данных в течение срока, предусмотренного законом (ZUS, налоги).", pl: "Wyrażam zgodę na przechowywanie moich danych przez okres wymagany przepisami prawa (ZUS, podatki)." },
  cSharing: { uk: "Погоджуюсь на передачу моїх даних роботодавцю-користувачу (фабриці), ZUS, urzędowi skarbowemu та NFZ.", en: "I consent to sharing my data with the user employer (factory), ZUS, the tax office and NFZ.", es: "Consiento la comunicación de mis datos al empleador usuario (fábrica), ZUS, la oficina de impuestos y NFZ.", ru: "Соглашаюсь на передачу моих данных работодателю-пользователю (фабрике), ZUS, urzędowi skarbowemu и NFZ.", pl: "Wyrażam zgodę na przekazanie moich danych pracodawcy użytkownikowi (zakładowi pracy), ZUS, urzędowi skarbowemu i NFZ." },
  cEComm: { uk: "Погоджуюсь на електронну комунікацію і підписання документів онлайн (Telegram, e-mail, SMS).", en: "I consent to electronic communication and signing documents online (Telegram, e-mail, SMS).", es: "Consiento la comunicación electrónica y la firma de documentos en línea (Telegram, e-mail, SMS).", ru: "Соглашаюсь на электронную коммуникацию и подписание документов онлайн (Telegram, e-mail, SMS).", pl: "Wyrażam zgodę na komunikację elektroniczną i podpisywanie dokumentów online (Telegram, e-mail, SMS)." },
  finishBtn: { uk: "Завершити", en: "Finish", es: "Finalizar", ru: "Завершить", pl: "Zakończ" },
};

// purpose=anketa — бот «📄 Документи → заповнити анкету» для вже існуючого
// працівника (немає кроку сканування паспорта, лінк одразу відкриває анкету
// з уже збереженими відповідями, щоб не бити чистий бланк щоразу).
type NameDraft = { firstName: string | null; middleName: string | null; lastName: string | null };
type Meta = {
  purpose: "office" | "self" | "anketa"; factoryName: string | null; language: string;
  questionnaire: Record<string, unknown> | null; pesel: string | null; birthDate: string | null; needsPassportScan: boolean;
  nameDraft: NameDraft | null; companyName: string | null;
};
// 400 з мапою field → код помилки (lib/questionnaireRules) — форма підсвічує поля
export class FieldError extends Error { fields: Record<string, string>; constructor(msg: string, fields: Record<string, string>) { super(msg); this.fields = fields; } }
type AddrParts = { wojewodztwo: string; powiat: string; gmina: string; miejscowosc: string; ulica: string; numerDomu: string; kodPocztowy: string };
type Draft = {
  passportNumber: string | null; passportCountry: string | null; passportExpiresAt: string | null;
  citizenship: string | null; sex: string | null; birthDate: string | null; fullName: string | null;
} & NameDraft;

async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { headers: { "X-Requested-With": "grafik" } });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error || `Помилка ${r.status}`);
  return data as T;
}
async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const r = await fetch(`/api${path}`, { method: "POST", headers: { "X-Requested-With": "grafik" }, body: form });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error || `Помилка ${r.status}`);
  return data as T;
}
async function apiPostJson<T>(path: string, body: any): Promise<T> {
  const r = await fetch(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "grafik" }, body: JSON.stringify(body) });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) {
    if (data?.fields && typeof data.fields === "object") throw new FieldError(data.error || `Помилка ${r.status}`, data.fields);
    throw new Error(data?.error || `Помилка ${r.status}`);
  }
  return data as T;
}

export default function PassportScan() {
  const [, params] = useRoute("/passport-scan/:token");
  const token = params?.token ?? "";
  const [langState, setLangState] = useState<Lang>("uk");
  const s = (k: keyof typeof STR) => STR[k]![langState];

  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"capture" | "analyzing" | "confirm" | "rehire" | "questionnaire" | "success">("capture");
  const [rehire, setRehire] = useState<{ candidate: { id: number; fullName: string; workerCode: string | null }; fields: Omit<Draft, "fullName"> } | null>(null);
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [birthDate, setBirthDate] = useState<string | null>(null); // з кроку паспорта — для звірки PESEL на кроці анкети
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) return;
    apiGet<Meta>(`/passport-scan/${token}`).then(m => {
      setMeta(m);
      if ((["uk", "en", "es", "ru", "pl"] as const).includes(m.language as Lang)) setLangState(m.language as Lang);
      // Крок вирішує бекенд (needsPassportScan): office/self завжди сканують;
      // anketa — лише якщо в цього працівника ще нема паспорта на файлі,
      // інакше одразу до анкети (без зайвого кроку сканування).
      if (m.birthDate) setBirthDate(m.birthDate);
      if (!m.needsPassportScan) setStep("questionnaire");
    }).catch(e => setError(e.message));
  }, [token]);

  async function handleCaptured(file: Blob, name: string) {
    setStep("analyzing"); setAnalyzeErr(null);
    try {
      const form = new FormData();
      form.append("file", file, name);
      const r = await apiPostForm<{ draft: Draft }>(`/passport-scan/${token}/analyze`, form);
      setDraft(r.draft);
      setStep("confirm");
    } catch (e: any) {
      setAnalyzeErr(e.message);
      setStep("capture");
    }
  }

  async function submitConfirm(fields: Omit<Draft, "fullName">) {
    setBusy(true); setServerErrors({}); setAnalyzeErr(null);
    try {
      const r = await apiPostJson<{ rehireCandidate?: { id: number; fullName: string; workerCode: string | null } }>(`/passport-scan/${token}/confirm`, fields);
      if (fields.birthDate) setBirthDate(fields.birthDate);
      // звільнений профіль зі схожим ім'ям — спершу «Це ви?» (нічого ще не створено)
      if (r?.rehireCandidate) { setRehire({ candidate: r.rehireCandidate, fields }); setStep("rehire"); return; }
      setStep("questionnaire");
    } catch (e: any) {
      if (e instanceof FieldError) setServerErrors(e.fields);
      setAnalyzeErr(e.message);
    } finally { setBusy(false); }
  }
  async function submitRehire(me: boolean) {
    if (!rehire) return;
    setBusy(true); setAnalyzeErr(null);
    try {
      await apiPostJson(`/passport-scan/${token}/confirm`, me ? { ...rehire.fields, rehireWorkerId: rehire.candidate.id } : { ...rehire.fields, force: true });
      setStep("questionnaire");
    } catch (e: any) {
      setAnalyzeErr(e.message);
    } finally { setBusy(false); }
  }

  async function submitQuestionnaire(fields: Record<string, unknown>, certFile: File | null) {
    setBusy(true); setServerErrors({}); setAnalyzeErr(null);
    try {
      await apiPostJson(`/passport-scan/${token}/questionnaire`, fields);
      if (certFile) {
        const form = new FormData();
        form.append("file", certFile, certFile.name);
        // Довідка — best-effort: анкета вже прийнята, офіс завжди може донести
        // документ пізніше через профіль, тож помилка завантаження не блокує "Готово".
        await apiPostForm(`/passport-scan/${token}/student-cert`, form).catch(() => {});
      }
      setStep("success");
    } catch (e: any) {
      if (e instanceof FieldError) setServerErrors(e.fields);
      setAnalyzeErr(e.message);
    } finally { setBusy(false); }
  }

  if (error) return (
    <Centered><Card className="max-w-md p-6 text-center"><h1 className="mb-2 text-lg font-bold text-rose-600">{s("invalidTitle")}</h1><p className="text-sm text-slate-500">{s("contact")}</p></Card></Centered>
  );
  if (step === "success") return (
    <Centered><Card className="max-w-md p-6 text-center"><h1 className="mb-2 text-lg font-bold text-emerald-600">{s("successTitle")}</h1><p className="text-sm text-slate-500">{s("successBody")}</p></Card></Centered>
  );
  if (!meta) return <Centered><Spinner /></Centered>;

  return (
    <div className="min-h-dvh bg-slate-100 px-3 py-4 sm:px-6">
      <div className="mx-auto max-w-md">
        {/* На кроці анкети власна картка вже має заголовок (qTitle) — «Скан
            паспорта» тут був би неправильним, особливо для purpose=anketa
            (лінк на дозаповнення анкети, без кроку сканування взагалі). */}
        {step !== "questionnaire" && <h1 className="mb-1 text-lg font-bold text-slate-800">{s("title")}</h1>}
        {step !== "questionnaire" && meta.factoryName && <p className="mb-3 text-sm text-slate-500">{meta.factoryName}</p>}

        {/* Окрема явна карта під час розпізнавання — раніше тут просто лишалась
            камера з неактивною кнопкою, і людина не розуміла, чи щось узагалі
            відбувається (запит триває секунди-хвилину — Vision API + мережа
            через тунель). */}
        {step === "analyzing" && (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <Spinner />
            <p className="text-sm font-medium text-slate-600">{s("analyzing")}</p>
            <p className="text-xs text-slate-400">{s("analyzingHint")}</p>
          </Card>
        )}

        {step === "capture" && (
          <>
            <p className="mb-3 text-sm text-slate-600">{s("hint")}</p>
            {analyzeErr && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{analyzeErr}</p>}
            <CameraCapture s={s} onCapture={handleCaptured} fileInputRef={fileInputRef} />
            <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleCaptured(f, f.name); e.target.value = ""; }} />
            <button type="button" onClick={() => fileInputRef.current?.click()}
              className="mt-3 w-full rounded-lg border border-slate-300 bg-white py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              {s("upload")}
            </button>
          </>
        )}

        {step === "confirm" && draft && (
          <ConfirmForm s={s} draft={draft} busy={busy} error={analyzeErr} serverErrors={serverErrors}
            onBack={() => { setDraft(null); setStep("capture"); }}
            onSubmit={submitConfirm} />
        )}

        {step === "rehire" && rehire && (
          <Card className="p-4">
            <h2 className="mb-1 text-base font-semibold text-slate-800">{s("rehireTitle")}</h2>
            <p className="mb-2 text-sm text-slate-700">{s("rehireText").replace("{name}", rehire.candidate.fullName).replace("{code}", rehire.candidate.workerCode ?? String(rehire.candidate.id))}</p>
            <p className="mb-4 text-xs text-slate-500">{s("rehireHint")}</p>
            {analyzeErr && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{analyzeErr}</p>}
            <div className="flex flex-col gap-2">
              <Button onClick={() => submitRehire(true)} disabled={busy} className="justify-center">{s("rehireMe")}</Button>
              <Button variant="secondary" onClick={() => submitRehire(false)} disabled={busy} className="justify-center">{s("rehireNotMe")}</Button>
            </div>
          </Card>
        )}
        {step === "questionnaire" && (
          // Поля ім'я/по-батькові/прізвище тут — лише коли скану в ЦІЙ сесії не
          // було (needsPassportScan=false): ConfirmForm їх уже спитав і записав,
          // питати вдруге поспіль — зайве.
          <QuestionnaireForm s={s} busy={busy} error={analyzeErr} serverErrors={serverErrors} initial={meta.questionnaire} initialPesel={meta.pesel}
            birthDate={birthDate} companyName={meta.companyName}
            showNameFields={!meta.needsPassportScan} nameDraft={meta.nameDraft} onSubmit={submitQuestionnaire} />
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-slate-100 p-4">{children}</div>;
}

// Камера прямо в браузері (getUserMedia) з рамкою-підказкою «сюди паспорт» —
// без живого зелено/червоного індикатора (рішення власника: занадто дорого
// ганяти OCR на кожен кадр, а клієнтська евристика розмитості нічого не
// доводить). Якщо камера недоступна (дозвіл відхилено/десктоп без камери) —
// тихо ховається, лишається кнопка завантаження файлу.
// Геометрія рамки-підказки — узгоджена з grid-розміткою в JSX нижче (p-6 = 24px
// відступ, "1fr 6fr 1fr" → рамка займає середні 6/8 після відступу).
const FRAME_PAD_PX = 24;
const FRAME_INSET_FRAC = 1 / 8;
const FRAME_SIZE_FRAC = 6 / 8;

// Мапить видиму на екрані рамку (CSS-координати контейнера) у координати
// НАТИВНОГО буфера відео — та сама математика, якою браузер сам масштабує
// video (object-fit:cover) у контейнер: довша сторона обрізається симетрично.
function frameToVideoRect(containerRect: { width: number; height: number }, videoW: number, videoH: number) {
  const cw = containerRect.width, ch = containerRect.height;
  const coverScale = Math.max(cw / videoW, ch / videoH);
  const offsetX = (cw - videoW * coverScale) / 2, offsetY = (ch - videoH * coverScale) / 2;
  const innerW = cw - FRAME_PAD_PX * 2, innerH = ch - FRAME_PAD_PX * 2;
  const frameX = FRAME_PAD_PX + innerW * FRAME_INSET_FRAC, frameY = FRAME_PAD_PX + innerH * FRAME_INSET_FRAC;
  const frameW = innerW * FRAME_SIZE_FRAC, frameH = innerH * FRAME_SIZE_FRAC;
  // +5% запасу з кожного боку — рідко хто вирівнює паспорт день-у-день ідеально в рамку.
  const margin = 0.05;
  const sx = Math.max(0, (frameX - frameW * margin - offsetX) / coverScale);
  const sy = Math.max(0, (frameY - frameH * margin - offsetY) / coverScale);
  const sw = Math.min(videoW - sx, (frameW * (1 + 2 * margin)) / coverScale);
  const sh = Math.min(videoH - sy, (frameH * (1 + 2 * margin)) / coverScale);
  return { sx, sy, sw, sh };
}

function CameraCapture({ s, onCapture, fileInputRef }: {
  s: (k: keyof typeof STR) => string;
  onCapture: (file: Blob, name: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
        setReady(true);
      } catch { if (!cancelled) setUnavailable(true); }
    })();
    return () => { cancelled = true; streamRef.current?.getTracks().forEach(t => t.stop()); };
  }, []);

  // Телефонні камери часто дають кадр 3000+px по довшій стороні — для
  // розпізнавання тексту стільки не треба, а от завантаження такого файлу
  // (особливо через cloudflared-тунель на слабшому зв'язку) — це і є
  // більшість тієї «хвилини очікування». Обрізаємо довшу сторону до 1600px.
  const MAX_SIDE = 1600;
  function shoot() {
    const video = videoRef.current, container = containerRef.current;
    if (!video || !video.videoWidth || !container) return;
    // Рамка раніше була суто візуальною підказкою — у кадр, що йшов на OCR,
    // потрапляло ВСЕ відео (фон кімнати, ноутбук тощо), і Vision інколи
    // домішував текст із фону в результат (спостережуваний баг: у полях
    // паспорта з'являлись фрагменти зовсім сторонніх слів). Тепер вирізаємо
    // саме те, що показано в рамці, за тією ж object-fit:cover математикою,
    // якою браузер сам масштабує video → контейнер.
    const { sx, sy, sw, sh } = frameToVideoRect(container.getBoundingClientRect(), video.videoWidth, video.videoHeight);
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
    canvas.getContext("2d")!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => { if (blob) onCapture(blob, "passport.jpg"); }, "image/jpeg", 0.9);
  }

  if (unavailable) return <p className="rounded-lg bg-slate-200 px-3 py-2 text-center text-xs text-slate-500">{s("noCamera")}</p>;

  // Рамка-підказка «сюди паспорт» (§: box-shadow-spread-трюк давав нестабільний
  // ефект — у Safari/TG-вебвʼю рамка виглядала суцільною сірою плямою без
  // чіткого контуру, замість затемнення НАВКОЛО чіткого «вікна». Тут — 4
  // окремі напівпрозорі панелі (grid) навколо центральної клітинки: та сама
  // ідея, але без залежності від величезного box-shadow spread, який по-різному
  // рендериться між рушіями. Кутові дужки (як у банківських застосунках) —
  // чіткіший орієнтир, ніж суцільна рамка.
  const dim = "bg-black/45";
  return (
    <div ref={containerRef} className="relative overflow-hidden rounded-xl bg-black" style={{ aspectRatio: "4 / 3" }}>
      <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
      {ready && (
        <div className="pointer-events-none absolute inset-0 grid p-6" style={{ gridTemplateRows: "1fr 6fr 1fr", gridTemplateColumns: "1fr 6fr 1fr" }}>
          <div className={`col-span-3 ${dim}`} />
          <div className={dim} />
          <div className="relative">
            {(["-top-1 -left-1 border-t-4 border-l-4", "-top-1 -right-1 border-t-4 border-r-4", "-bottom-1 -left-1 border-b-4 border-l-4", "-bottom-1 -right-1 border-b-4 border-r-4"]).map((cls, i) => (
              <div key={i} className={`absolute h-6 w-6 rounded-sm border-white ${cls}`} />
            ))}
          </div>
          <div className={dim} />
          <div className={`col-span-3 ${dim}`} />
        </div>
      )}
      {ready && (
        <button type="button" onClick={shoot}
          aria-label={s("shutter")}
          className="absolute bottom-4 left-1/2 h-16 w-16 -translate-x-1/2 rounded-full border-4 border-white bg-white/30" />
      )}
      {!ready && !unavailable && <div className="absolute inset-0 flex items-center justify-center"><Spinner /></div>}
    </div>
  );
}

// ── Спільне для обох форм: підпис поля з зірочкою, підказка-приклад, помилка ─────
type S = (k: keyof typeof STR) => string;
type Errs = Record<string, string>;
const inputCls = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm";
const inputErrCls = "w-full rounded-lg border border-rose-400 bg-rose-50/40 px-3 py-2 text-sm";

// Код помилки (lib/questionnaireRules, той самий на сервері) → текст мовою працівника
function errText(s: S, code: string | undefined): string | null {
  switch (code) {
    case "required": return s("errRequired");
    case "latin": return s("errLatin");
    case "format": return s("errFormat");
    case "checksum": return s("errChecksum");
    case "date": return s("errDate");
    case "age": return s("errAge");
    case "expired": return s("errExpired");
    case "list": return s("errList");
    case "consent": return s("errConsent");
    default: return code ? s("errFormat") : null;
  }
}

function Field({ label, required, hint, error, children }: { label: string; required?: boolean; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <label className="block" data-err={error ? "1" : undefined}>
      <div className="mb-1 text-xs font-medium text-slate-500">{label}{required && <span className="ml-0.5 text-rose-500">*</span>}</div>
      {children}
      {error ? <p className="mt-1 text-xs text-rose-600">{error}</p> : hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </label>
  );
}

// Після першої невдалої спроби помилки перераховуються наживо (тими самими
// правилами, що на сервері); серверні коди (400 fields) мають пріоритет, поки
// людина не змінить поле. Скрол — до першого поля з помилкою.
function scrollToFirstError() {
  requestAnimationFrame(() => document.querySelector('[data-err="1"]')?.scrollIntoView({ behavior: "smooth", block: "center" }));
}
const todayIso = () => new Date().toISOString().slice(0, 10);

function ConfirmForm({ s, draft, busy, error, serverErrors, onBack, onSubmit }: {
  s: S; draft: Draft; busy: boolean; error: string | null; serverErrors: Errs;
  onBack: () => void; onSubmit: (fields: Omit<Draft, "fullName">) => void;
}) {
  const [firstName, setFirstName] = useState(draft.firstName ?? "");
  const [middleName, setMiddleName] = useState(draft.middleName ?? "");
  const [lastName, setLastName] = useState(draft.lastName ?? "");
  const [birthDate, setBirthDate] = useState(draft.birthDate ?? "");
  const [passportNumber, setPassportNumber] = useState(draft.passportNumber ?? "");
  const [passportCountry, setPassportCountry] = useState(draft.passportCountry ?? "");
  const [passportExpiresAt, setPassportExpiresAt] = useState(draft.passportExpiresAt ?? "");
  const [citizenship, setCitizenship] = useState(draft.citizenship ?? "");
  const [sex, setSex] = useState(draft.sex ?? "");
  const [tried, setTried] = useState(false);
  const [touched, setTouched] = useState<Record<string, true>>({});

  const body = { firstName, middleName, lastName, birthDate, passportNumber, passportCountry, passportExpiresAt, citizenship, sex };
  const local = tried ? validatePassport(body, todayIso()).errors : {};
  const errs: Errs = { ...local };
  for (const [k, v] of Object.entries(serverErrors)) if (!touched[k]) errs[k] = v;
  const er = (k: string) => errText(s, errs[k]);
  const cls = (k: string) => (errs[k] ? inputErrCls : inputCls);
  const touch = (k: string) => setTouched(t => (t[k] ? t : { ...t, [k]: true }));

  function submit() {
    setTried(true);
    const v = validatePassport(body, todayIso());
    if (Object.keys(v.errors).length) { scrollToFirstError(); return; }
    onSubmit({
      firstName: v.values.firstName, middleName: v.values.middleName, lastName: v.values.lastName,
      birthDate: v.values.birthDate, passportNumber: v.values.passportNumber, passportCountry: v.values.passportCountry,
      passportExpiresAt: v.values.passportExpiresAt, citizenship: v.values.citizenship, sex: v.values.sex,
    });
  }
  const hasErr = Object.keys(errs).length > 0;

  return (
    <Card className="p-4">
      <h2 className="mb-1 text-base font-semibold text-slate-800">{s("confirmTitle")}</h2>
      <p className="mb-1 text-xs text-slate-500">{s("confirmHint")}</p>
      <p className="mb-4 text-xs text-slate-500">{s("qHintStrict")}</p>
      {error && !hasErr && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{error}</p>}
      {hasErr && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{s("fixErrors")}</p>}
      <div className="space-y-3">
        <Field label={s("firstName")} required hint={s("hintName")} error={er("firstName")}><input value={firstName} onChange={e => { setFirstName(e.target.value); touch("firstName"); }} className={cls("firstName")} /></Field>
        <Field label={s("middleName")} hint={s("latinOnly")} error={er("middleName")}><input value={middleName} onChange={e => { setMiddleName(e.target.value); touch("middleName"); }} className={cls("middleName")} /></Field>
        <Field label={s("lastName")} required hint={s("hintLastName")} error={er("lastName")}><input value={lastName} onChange={e => { setLastName(e.target.value); touch("lastName"); }} className={cls("lastName")} /></Field>
        <Field label={s("birthDate")} required hint={s("hintBirthDate")} error={er("birthDate")}><input type="date" value={birthDate} onChange={e => { setBirthDate(e.target.value); touch("birthDate"); }} className={cls("birthDate")} /></Field>
        <Field label={s("passportNumber")} required hint={s("hintPassportNo")} error={er("passportNumber")}><input value={passportNumber} onChange={e => { setPassportNumber(e.target.value.toUpperCase()); touch("passportNumber"); }} autoCapitalize="characters" className={cls("passportNumber")} /></Field>
        <Field label={s("passportCountry")} required hint={s("hintCountry")} error={er("passportCountry")}><input value={passportCountry} onChange={e => { setPassportCountry(e.target.value); touch("passportCountry"); }} className={cls("passportCountry")} /></Field>
        <Field label={s("passportExpiresAt")} required hint={s("hintExpires")} error={er("passportExpiresAt")}><input type="date" value={passportExpiresAt} onChange={e => { setPassportExpiresAt(e.target.value); touch("passportExpiresAt"); }} className={cls("passportExpiresAt")} /></Field>
        <Field label={s("citizenship")} required hint={s("hintCountry")} error={er("citizenship")}><input value={citizenship} onChange={e => { setCitizenship(e.target.value); touch("citizenship"); }} className={cls("citizenship")} /></Field>
        <Field label={s("sex")} required error={er("sex")}>
          <div className="flex gap-2">
            {(["M", "F"] as const).map(v => (
              <button key={v} type="button" onClick={() => { setSex(v); touch("sex"); }}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm ${sex === v ? "border-red-500 bg-red-50 text-red-700" : "border-slate-300 text-slate-600"}`}>
                {v === "M" ? s("male") : s("female")}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" onClick={onBack} disabled={busy}>{s("retakePhoto")}</Button>
        <Button onClick={submit} disabled={busy} className="flex-1 justify-center">{s("confirmBtn")}</Button>
      </div>
    </Card>
  );
}

// 7 гранульних полів адреси (województwo/powiat/gmina/miejscowość/ulica/nr
// domu/kod pocztowy) — Oświadczenie podatkowe; вільнотекстові «Pełny adres …»
// для umowy/wniosków сервер збирає з цих самих полів (08.09.2026: адресу
// вводять один раз).
function AddrFields({ s, prefix, value, onChange, errs, touch }: {
  s: S; prefix: "reg" | "zam"; value: AddrParts; onChange: (v: AddrParts) => void; errs: Errs; touch: (k: string) => void;
}) {
  const f = (k: keyof AddrParts, label: keyof typeof STR, hint: keyof typeof STR, extra?: Record<string, string>) => {
    const key = `${prefix}${k[0]!.toUpperCase()}${k.slice(1)}`;
    return (
      <Field label={s(label)} required hint={s(hint)} error={errText(s, errs[key])}>
        <input value={value[k]} onChange={e => { onChange({ ...value, [k]: e.target.value }); touch(key); }} className={errs[key] ? inputErrCls : inputCls} {...extra} />
      </Field>
    );
  };
  return (
    <>
      {f("wojewodztwo", "fieldWojewodztwo", "hintWoj")}
      {f("powiat", "fieldPowiat", "hintPowiat")}
      {f("gmina", "fieldGmina", "hintGmina")}
      {f("miejscowosc", "fieldMiejscowosc", "hintMiejscowosc")}
      {f("ulica", "fieldUlica", "hintUlica")}
      {f("numerDomu", "fieldNumerDomu", "hintNrDomu")}
      {f("kodPocztowy", "fieldKodPocztowy", "hintKod", { placeholder: "00-000", inputMode: "numeric" })}
    </>
  );
}

const CONSENT_LABEL: Record<ConsentKey, keyof typeof STR> = { rodo_info: "cRodoInfo", processing: "cProcessing", storage: "cStorage", sharing: "cSharing", e_comm: "cEComm" };

// Решта анкети — одразу після скану, поки людина ще на сторінці. Рішення
// власника 08.09.2026: усі поля обов'язкові, лише латиниця, підказки під
// кожним полем, згоди RODO — короткі рядки з галочками в кінці. Правила —
// lib/questionnaireRules (копія серверного файлу): підсвічуємо тут, сервер
// перевіряє ще раз і відповідає 400 fields.
function QuestionnaireForm({ s, busy, error, serverErrors, initial, initialPesel, birthDate, companyName, showNameFields, nameDraft, onSubmit }: {
  s: S; busy: boolean; error: string | null; serverErrors: Errs;
  initial: Record<string, unknown> | null; initialPesel: string | null; birthDate: string | null; companyName: string | null;
  showNameFields: boolean; nameDraft: NameDraft | null;
  onSubmit: (fields: Record<string, unknown>, certFile: File | null) => void;
}) {
  // Дозаповнення (purpose=anketa, лінк з бота «📄 Документи») — стартові
  // значення з уже збереженої анкети замість чистого бланку щоразу.
  const str = (k: string) => { const v = initial?.[k]; return typeof v === "string" ? v : ""; };
  const bool = (k: string) => !!initial?.[k];

  const [firstName, setFirstName] = useState(nameDraft?.firstName ?? "");
  const [middleName, setMiddleName] = useState(nameDraft?.middleName ?? "");
  const [lastName, setLastName] = useState(nameDraft?.lastName ?? "");
  const [birthPlace, setBirthPlace] = useState(str("birthPlace"));
  const [pesel, setPesel] = useState(initialPesel ?? "");
  const [motherName, setMotherName] = useState(str("motherName"));
  const [fatherName, setFatherName] = useState(str("fatherName"));
  const [bankName, setBankName] = useState(str("bankName"));
  const [bankIban, setBankIban] = useState(str("bankIban"));
  const [phone, setPhone] = useState(str("phone"));
  const [email, setEmail] = useState(str("email"));
  const [taxOffice, setTaxOffice] = useState(str("taxOffice"));
  const [nfzBranch, setNfzBranch] = useState(str("nfzBranch"));
  const [isStudent, setIsStudent] = useState(bool("isStudent"));
  const [schoolName, setSchoolName] = useState(str("schoolName"));
  const [certFile, setCertFile] = useState<File | null>(null);
  const [hasOtherEmployment, setHasOtherEmployment] = useState(bool("hasOtherEmployment"));
  const [otherEmploymentNote, setOtherEmploymentNote] = useState(str("otherEmploymentNote"));
  const [isRegisteredUnemployed, setIsRegisteredUnemployed] = useState(bool("isRegisteredUnemployed"));
  const [emergencyContact, setEmergencyContact] = useState(str("emergencyContact"));
  const [nip, setNip] = useState(str("nip"));
  const [pit0, setPit0] = useState(bool("pit0"));
  const [ankietaInnyPracodawca, setAnkietaInnyPracodawca] = useState(bool("ankietaInnyPracodawca"));
  const [ankietaEmeryt, setAnkietaEmeryt] = useState(bool("ankietaEmeryt"));
  const [ankietaRencista, setAnkietaRencista] = useState(bool("ankietaRencista"));
  const [ankietaNiepelnosprawnosc, setAnkietaNiepelnosprawnosc] = useState(bool("ankietaNiepelnosprawnosc"));
  const [ankietaSkladkaChorobowa, setAnkietaSkladkaChorobowa] = useState(bool("ankietaSkladkaChorobowa"));
  const [regAddr, setRegAddr] = useState<AddrParts>({
    wojewodztwo: str("regWojewodztwo"), powiat: str("regPowiat"), gmina: str("regGmina"),
    miejscowosc: str("regMiejscowosc"), ulica: str("regUlica"), numerDomu: str("regNumerDomu"), kodPocztowy: str("regKodPocztowy"),
  });
  const [zamSame, setZamSame] = useState(false);
  const [zamAddr, setZamAddr] = useState<AddrParts>({
    wojewodztwo: str("zamWojewodztwo"), powiat: str("zamPowiat"), gmina: str("zamGmina"),
    miejscowosc: str("zamMiejscowosc"), ulica: str("zamUlica"), numerDomu: str("zamNumerDomu"), kodPocztowy: str("zamKodPocztowy"),
  });
  const [consents, setConsents] = useState<Record<ConsentKey, boolean>>({ rodo_info: false, processing: false, storage: false, sharing: false, e_comm: false });
  const [tried, setTried] = useState(false);
  const [touched, setTouched] = useState<Record<string, true>>({});

  const addrBody = (prefix: "reg" | "zam", a: AddrParts) => ({
    [`${prefix}Wojewodztwo`]: a.wojewodztwo, [`${prefix}Powiat`]: a.powiat, [`${prefix}Gmina`]: a.gmina, [`${prefix}Miejscowosc`]: a.miejscowosc,
    [`${prefix}Ulica`]: a.ulica, [`${prefix}NumerDomu`]: a.numerDomu, [`${prefix}KodPocztowy`]: a.kodPocztowy,
  });
  const body: Record<string, unknown> = {
    ...(showNameFields ? { firstName, middleName, lastName } : {}),
    birthPlace, pesel, motherName, fatherName, bankName, bankIban, phone, email, taxOffice, nfzBranch,
    isStudent, schoolName, hasOtherEmployment, otherEmploymentNote, isRegisteredUnemployed, emergencyContact, nip, pit0,
    ankietaInnyPracodawca, ankietaEmeryt, ankietaRencista, ankietaNiepelnosprawnosc, ankietaSkladkaChorobowa,
    ...addrBody("reg", regAddr), ...addrBody("zam", zamAddr), zamSame, consents,
  };
  const validate = () => {
    const errs: Errs = { ...validateQuestionnaire(body, { birthDate, taxOffices: TAX_OFFICES, nfzBranches: NFZ_BRANCHES }).errors };
    if (showNameFields) {
      const pv = validatePassport({ firstName, middleName, lastName }, todayIso()).errors;
      for (const k of ["firstName", "middleName", "lastName"] as const) if (pv[k]) errs[k] = pv[k]!;
    }
    return errs;
  };
  const errs: Errs = tried ? validate() : {};
  for (const [k, v] of Object.entries(serverErrors)) if (!touched[k]) errs[k] = v;
  const er = (k: string) => errText(s, errs[k]);
  const cls = (k: string) => (errs[k] ? inputErrCls : inputCls);
  const touch = (k: string) => setTouched(t => (t[k] ? t : { ...t, [k]: true }));
  const hasErr = Object.keys(errs).length > 0;

  function submit() {
    setTried(true);
    if (Object.keys(validate()).length) { scrollToFirstError(); return; }
    onSubmit(body, isStudent ? certFile : null);
  }

  const txt = (k: string, set: (v: string) => void, extra?: Record<string, unknown>) =>
    <input value={String(body[k] ?? "")} onChange={e => { set(e.target.value); touch(k); }} className={cls(k)} {...extra} />;
  const check = (label: string, checked: boolean, set: (v: boolean) => void) => (
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" checked={checked} onChange={e => set(e.target.checked)} className="mt-1" /> <span>{label}</span>
    </label>
  );

  return (
    <Card className="p-4">
      <h2 className="mb-1 text-base font-semibold text-slate-800">{s("qTitle")}</h2>
      <p className="mb-4 text-xs text-slate-500">{s("qHintStrict")}</p>
      {error && !hasErr && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{error}</p>}
      {hasErr && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{s("fixErrors")}</p>}
      <div className="space-y-3">
        {showNameFields && (
          <>
            <Field label={s("firstName")} required hint={s("hintName")} error={er("firstName")}>{txt("firstName", setFirstName)}</Field>
            <Field label={s("middleName")} hint={s("latinOnly")} error={er("middleName")}>{txt("middleName", setMiddleName)}</Field>
            <Field label={s("lastName")} required hint={s("hintLastName")} error={er("lastName")}>{txt("lastName", setLastName)}</Field>
          </>
        )}
        <Field label={s("birthPlace")} required hint={s("hintBirthPlace")} error={er("birthPlace")}>{txt("birthPlace", setBirthPlace)}</Field>
        <Field label={s("pesel")} required hint={s("hintPesel")} error={er("pesel")}>
          <input value={pesel} onChange={e => { setPesel(e.target.value.replace(/\D/g, "").slice(0, 11)); touch("pesel"); }} inputMode="numeric" className={cls("pesel")} />
        </Field>
        <Field label={s("motherName")} required hint={s("hintParent")} error={er("motherName")}>{txt("motherName", setMotherName)}</Field>
        <Field label={s("fatherName")} required hint={s("hintParent")} error={er("fatherName")}>{txt("fatherName", setFatherName)}</Field>
        <Field label={s("bankName")} required hint={s("hintBank")} error={er("bankName")}>{txt("bankName", setBankName)}</Field>
        <Field label={s("bankIban")} required hint={s("hintNrb")} error={er("bankIban")}>{txt("bankIban", setBankIban, { inputMode: "numeric", autoComplete: "off" })}</Field>
        <Field label={s("phone")} required hint={s("hintPhone")} error={er("phone")}>{txt("phone", setPhone, { type: "tel", inputMode: "tel" })}</Field>
        <Field label={s("email")} required hint={s("hintEmail")} error={er("email")}>{txt("email", setEmail, { type: "email", inputMode: "email", autoCapitalize: "none" })}</Field>
        <Field label={s("taxOffice")} required hint={s("hintTaxOffice")} error={er("taxOffice")}>
          <SearchableSelect value={taxOffice} onChange={v => { setTaxOffice(v); touch("taxOffice"); }} options={TAX_OFFICES} className={cls("taxOffice")} />
        </Field>
        <Field label={s("nfzBranch")} required hint={s("hintNfz")} error={er("nfzBranch")}>
          <SearchableSelect value={nfzBranch} onChange={v => { setNfzBranch(v); touch("nfzBranch"); }} options={NFZ_BRANCHES} className={cls("nfzBranch")} />
        </Field>
        {check(s("isStudent"), isStudent, setIsStudent)}
        {isStudent && (
          <>
            <Field label={s("schoolName")} required hint={s("hintSchool")} error={er("schoolName")}>{txt("schoolName", setSchoolName)}</Field>
            <Field label={s("certLabel")}>
              <input type="file" accept="image/*,application/pdf" onChange={e => setCertFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-slate-600" />
            </Field>
          </>
        )}
        {check(s("hasOtherEmployment"), hasOtherEmployment, setHasOtherEmployment)}
        {hasOtherEmployment && (
          <Field label={s("otherEmploymentNote")} required hint={s("hintOtherJob")} error={er("otherEmploymentNote")}>{txt("otherEmploymentNote", setOtherEmploymentNote)}</Field>
        )}
        {check(s("isRegisteredUnemployed"), isRegisteredUnemployed, setIsRegisteredUnemployed)}
        <Field label={s("emergencyContact")} hint={s("hintEmergency")} error={er("emergencyContact")}>{txt("emergencyContact", setEmergencyContact)}</Field>
        <Field label={s("nip")} hint={s("hintNip")} error={er("nip")}>{txt("nip", setNip, { inputMode: "numeric" })}</Field>
        {check(s("pit0Label"), pit0, setPit0)}
        {check(s("ankietaInnyPracodawca"), ankietaInnyPracodawca, setAnkietaInnyPracodawca)}
        {check(s("ankietaEmeryt"), ankietaEmeryt, setAnkietaEmeryt)}
        {check(s("ankietaRencista"), ankietaRencista, setAnkietaRencista)}
        {check(s("ankietaNiepelnosprawnosc"), ankietaNiepelnosprawnosc, setAnkietaNiepelnosprawnosc)}
        {check(s("ankietaSkladkaChorobowa"), ankietaSkladkaChorobowa, setAnkietaSkladkaChorobowa)}

        <h3 className="pt-1 text-sm font-semibold text-slate-800">{s("regAddressTitle")}</h3>
        <AddrFields s={s} prefix="reg" value={regAddr} onChange={setRegAddr} errs={errs} touch={touch} />

        <h3 className="pt-1 text-sm font-semibold text-slate-800">{s("zamAddressTitle")}</h3>
        {check(s("zamSameAsReg"), zamSame, setZamSame)}
        {!zamSame && <AddrFields s={s} prefix="zam" value={zamAddr} onChange={setZamAddr} errs={errs} touch={touch} />}

        <h3 className="pt-1 text-sm font-semibold text-slate-800">{s("consentsTitle")}</h3>
        <p className="-mt-2 text-xs text-slate-400">{s("consentsHint")}</p>
        {CONSENT_KEYS.map(k => {
          const key = `consents.${k}`;
          const label = s(CONSENT_LABEL[k]).replace("{company}", (companyName ?? "Euro Support").replace(/\.$/, "")); // «Sp. z o.o.» + крапка речення
          return (
            <div key={k} data-err={errs[key] ? "1" : undefined}>
              <label className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-xs text-slate-700 ${errs[key] ? "border-rose-300 bg-rose-50/40" : "border-slate-200"}`}>
                <input type="checkbox" checked={consents[k]} onChange={e => { setConsents(c => ({ ...c, [k]: e.target.checked })); touch(key); }} className="mt-0.5" />
                <span>{label}<span className="ml-0.5 text-rose-500">*</span></span>
              </label>
              {errs[key] && <p className="mt-1 text-xs text-rose-600">{errText(s, errs[key])}</p>}
            </div>
          );
        })}
      </div>
      <Button disabled={busy} className="mt-4 w-full justify-center" onClick={submit}>
        {s("finishBtn")}
      </Button>
    </Card>
  );
}

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
  pesel: { uk: "PESEL (якщо вже маєш)", en: "PESEL (if you already have one)", es: "PESEL (si ya lo tienes)", ru: "PESEL (если уже есть)", pl: "PESEL (jeśli już masz)" },
  peselBad: { uk: "PESEL — 11 цифр", en: "PESEL — 11 digits", es: "PESEL — 11 dígitos", ru: "PESEL — 11 цифр", pl: "PESEL — 11 cyfr" },
  addressPl: { uk: "Адреса проживання в Польщі", en: "Address in Poland", es: "Dirección en Polonia", ru: "Адрес проживания в Польше", pl: "Adres zamieszkania w Polsce" },
  postalCode: { uk: "Поштовий індекс", en: "Postal code", es: "Código postal", ru: "Почтовый индекс", pl: "Kod pocztowy" },
  city: { uk: "Місто/gmina", en: "Town/gmina", es: "Ciudad/gmina", ru: "Город/gmina", pl: "Miejscowość/gmina" },
  addressRegisteredSame: { uk: "Адреса замельдування — така сама, як вище", en: "Registered address is the same as above", es: "La dirección de empadronamiento es la misma que arriba", ru: "Адрес прописки — такой же, как выше", pl: "Adres zameldowania — taki sam jak wyżej" },
  addressRegistered: { uk: "Адреса замельдування (прописки)", en: "Registered (permanent) address", es: "Dirección de empadronamiento", ru: "Адрес прописки", pl: "Adres zameldowania" },
  motherName: { uk: "Імʼя та прізвище мами", en: "Mother's full name", es: "Nombre completo de la madre", ru: "Имя и фамилия мамы", pl: "Imię i nazwisko matki" },
  fatherName: { uk: "Імʼя та прізвище тата", en: "Father's full name", es: "Nombre completo del padre", ru: "Имя и фамилия папы", pl: "Imię i nazwisko ojca" },
  bankName: { uk: "Назва банку", en: "Bank name", es: "Nombre del banco", ru: "Название банка", pl: "Nazwa banku" },
  bankIban: { uk: "Номер банківського рахунку (IBAN)", en: "Bank account number (IBAN)", es: "Número de cuenta bancaria (IBAN)", ru: "Номер банковского счёта (IBAN)", pl: "Numer konta bankowego (IBAN)" },
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
  regAddressTitle: { uk: "Адреса замельдування (детально)", en: "Registered address (detailed)", es: "Dirección de empadronamiento (detallada)", ru: "Адрес прописки (детально)", pl: "Adres zameldowania (szczegółowo)" },
  zamAddressTitle: { uk: "Адреса проживання (детально)", en: "Residential address (detailed)", es: "Dirección de residencia (detallada)", ru: "Адрес проживания (детально)", pl: "Adres zamieszkania (szczegółowo)" },
  zamSameAsReg: { uk: "Така сама, як замельдування вище", en: "Same as the registered address above", es: "Misma que la dirección de empadronamiento", ru: "Такой же, как адрес прописки", pl: "Taki sam jak adres zameldowania wyżej" },
  fieldWojewodztwo: { uk: "Воєводство", en: "Voivodeship (województwo)", es: "Voivodato (województwo)", ru: "Воеводство", pl: "Województwo" },
  fieldPowiat: { uk: "Повіт (powiat)", en: "County (powiat)", es: "Distrito (powiat)", ru: "Повят (powiat)", pl: "Powiat" },
  fieldGmina: { uk: "Гміна (gmina)", en: "Commune (gmina)", es: "Municipio (gmina)", ru: "Гмина (gmina)", pl: "Gmina" },
  fieldMiejscowosc: { uk: "Населений пункт", en: "Town/village", es: "Localidad", ru: "Населённый пункт", pl: "Miejscowość" },
  fieldUlica: { uk: "Вулиця", en: "Street", es: "Calle", ru: "Улица", pl: "Ulica" },
  fieldNumerDomu: { uk: "Номер будинку", en: "House number", es: "Número de casa", ru: "Номер дома", pl: "Numer domu" },
  fieldKodPocztowy: { uk: "Поштовий індекс", en: "Postal code", es: "Código postal", ru: "Почтовый индекс", pl: "Kod pocztowy" },
  finishBtn: { uk: "Завершити", en: "Finish", es: "Finalizar", ru: "Завершить", pl: "Zakończ" },
};

// purpose=anketa — бот «📄 Документи → заповнити анкету» для вже існуючого
// працівника (немає кроку сканування паспорта, лінк одразу відкриває анкету
// з уже збереженими відповідями, щоб не бити чистий бланк щоразу).
type NameDraft = { firstName: string | null; middleName: string | null; lastName: string | null };
type Meta = {
  purpose: "office" | "self" | "anketa"; factoryName: string | null; language: string;
  questionnaire: Record<string, unknown> | null; pesel: string | null; needsPassportScan: boolean;
  nameDraft: NameDraft | null;
};
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
  if (!r.ok) throw new Error(data?.error || `Помилка ${r.status}`);
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) return;
    apiGet<Meta>(`/passport-scan/${token}`).then(m => {
      setMeta(m);
      if ((["uk", "en", "es", "ru", "pl"] as const).includes(m.language as Lang)) setLangState(m.language as Lang);
      // Крок вирішує бекенд (needsPassportScan): office/self завжди сканують;
      // anketa — лише якщо в цього працівника ще нема паспорта на файлі,
      // інакше одразу до анкети (без зайвого кроку сканування).
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
    setBusy(true);
    try {
      const r = await apiPostJson<{ rehireCandidate?: { id: number; fullName: string; workerCode: string | null } }>(`/passport-scan/${token}/confirm`, fields);
      // звільнений профіль зі схожим ім'ям — спершу «Це ви?» (нічого ще не створено)
      if (r?.rehireCandidate) { setRehire({ candidate: r.rehireCandidate, fields }); setStep("rehire"); return; }
      setStep("questionnaire");
    } catch (e: any) {
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
    setBusy(true);
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
          <ConfirmForm s={s} draft={draft} busy={busy} error={analyzeErr}
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
          <QuestionnaireForm s={s} busy={busy} error={analyzeErr} initial={meta.questionnaire} initialPesel={meta.pesel}
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

function ConfirmForm({ s, draft, busy, error, onBack, onSubmit }: {
  s: (k: keyof typeof STR) => string; draft: Draft; busy: boolean; error: string | null;
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
  const [nameErr, setNameErr] = useState(false);
  const LATIN_NAME = /^[a-ząćęłńóśźż' -]+$/i;

  function submit() {
    const first = firstName.trim(), middle = middleName.trim(), last = lastName.trim();
    if (!first || !LATIN_NAME.test(first) || !last || !LATIN_NAME.test(last) || (middle && !LATIN_NAME.test(middle))) { setNameErr(true); return; }
    setNameErr(false);
    onSubmit({
      firstName: first, middleName: middle || null, lastName: last,
      birthDate: birthDate || null, passportNumber: passportNumber || null, passportCountry: passportCountry || null,
      passportExpiresAt: passportExpiresAt || null, citizenship: citizenship || null, sex: sex || null,
    });
  }

  return (
    <Card className="p-4">
      <h2 className="mb-1 text-base font-semibold text-slate-800">{s("confirmTitle")}</h2>
      <p className="mb-4 text-xs text-slate-500">{s("confirmHint")}</p>
      {error && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{error}</p>}
      <div className="space-y-3">
        <Field label={s("firstName")}><input value={firstName} onChange={e => setFirstName(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></Field>
        <Field label={s("middleName")}><input value={middleName} onChange={e => setMiddleName(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></Field>
        <Field label={s("lastName")}><input value={lastName} onChange={e => setLastName(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></Field>
        {nameErr && <p className="-mt-2 text-xs text-rose-600">{s("badName")}</p>}
        <Field label={s("birthDate")}><input type="date" value={birthDate} onChange={e => setBirthDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></Field>
        <Field label={s("passportNumber")}><input value={passportNumber} onChange={e => setPassportNumber(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></Field>
        <Field label={s("passportCountry")}><input value={passportCountry} onChange={e => setPassportCountry(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></Field>
        <Field label={s("passportExpiresAt")}><input type="date" value={passportExpiresAt} onChange={e => setPassportExpiresAt(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></Field>
        <Field label={s("citizenship")}><input value={citizenship} onChange={e => setCitizenship(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></Field>
        <Field label={s("sex")}>
          <div className="flex gap-2">
            {(["M", "F"] as const).map(v => (
              <button key={v} type="button" onClick={() => setSex(v)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm ${sex === v ? "border-red-500 bg-red-50 text-red-700" : "border-slate-300 text-slate-600"}`}>
                {v === "M" ? s("male") : s("female")}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" onClick={onBack} disabled={busy}>{s("retakePhoto")}</Button>
        <Button onClick={submit} disabled={busy || !firstName.trim() || !lastName.trim()} className="flex-1 justify-center">{s("confirmBtn")}</Button>
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{label}</div>{children}</label>;
}

const inputCls = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm";

// 7 гранульних полів адреси (wojewodztwo/powiat/gmina/miejscowość/ulica/nr
// domu/kod pocztowy) — Oświadczenie podatkowe (worker-docs-signing), окремо
// від вільнотекстової "Адреса в Польщі"/"Адреса замельдування" вище.
function AddrFields({ s, value, onChange }: { s: (k: keyof typeof STR) => string; value: AddrParts; onChange: (v: AddrParts) => void }) {
  const set = (k: keyof AddrParts) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <>
      <Field label={s("fieldWojewodztwo")}><input value={value.wojewodztwo} onChange={e => set("wojewodztwo")(e.target.value)} className={inputCls} /></Field>
      <Field label={s("fieldPowiat")}><input value={value.powiat} onChange={e => set("powiat")(e.target.value)} className={inputCls} /></Field>
      <Field label={s("fieldGmina")}><input value={value.gmina} onChange={e => set("gmina")(e.target.value)} className={inputCls} /></Field>
      <Field label={s("fieldMiejscowosc")}><input value={value.miejscowosc} onChange={e => set("miejscowosc")(e.target.value)} className={inputCls} /></Field>
      <Field label={s("fieldUlica")}><input value={value.ulica} onChange={e => set("ulica")(e.target.value)} className={inputCls} /></Field>
      <Field label={s("fieldNumerDomu")}><input value={value.numerDomu} onChange={e => set("numerDomu")(e.target.value)} className={inputCls} /></Field>
      <Field label={s("fieldKodPocztowy")}><input value={value.kodPocztowy} onChange={e => set("kodPocztowy")(e.target.value)} className={inputCls} /></Field>
    </>
  );
}

// Решта анкети — одразу після скану, поки людина ще на сторінці (замість
// окремого походу через бот-флоу «📄 Документи» пізніше). Нічого тут не є
// обов'язковим — офіс однаково перевіряє/дозаповнює в панелі, тож краще
// відправити частково заповнене, ніж заблокувати людину на цьому кроці.
function QuestionnaireForm({ s, busy, error, initial, initialPesel, showNameFields, nameDraft, onSubmit }: {
  s: (k: keyof typeof STR) => string; busy: boolean; error: string | null;
  initial: Record<string, unknown> | null; initialPesel: string | null;
  showNameFields: boolean; nameDraft: NameDraft | null;
  onSubmit: (fields: Record<string, unknown>, certFile: File | null) => void;
}) {
  // Дозаповнення (purpose=anketa, лінк з бота «📄 Документи») — стартові
  // значення з уже збереженої анкети замість чистого бланку щоразу.
  const str = (k: string) => { const v = initial?.[k]; return typeof v === "string" ? v : ""; };
  const bool = (k: string) => !!initial?.[k];

  // Ім'я/по-батькові/прізвище — лише коли скану в цій сесії не було
  // (showNameFields=true): нема ConfirmForm, це єдине місце їх спитати.
  const [firstName, setFirstName] = useState(nameDraft?.firstName ?? "");
  const [middleName, setMiddleName] = useState(nameDraft?.middleName ?? "");
  const [lastName, setLastName] = useState(nameDraft?.lastName ?? "");
  const [nameErr, setNameErr] = useState(false);
  const [birthPlace, setBirthPlace] = useState(str("birthPlace"));
  const [pesel, setPesel] = useState(initialPesel ?? "");
  const [peselErr, setPeselErr] = useState(false);
  const [addressPl, setAddressPl] = useState(str("addressPl"));
  const [postalCode, setPostalCode] = useState(str("postalCode"));
  const [city, setCity] = useState(str("city"));
  const [addressRegisteredSame, setAddressRegisteredSame] = useState(false);
  const [addressRegistered, setAddressRegistered] = useState(str("addressRegistered"));
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
  const [taxOfficeAddress, setTaxOfficeAddress] = useState(str("taxOfficeAddress"));
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

  function submit() {
    if (pesel && !/^\d{11}$/.test(pesel)) { setPeselErr(true); return; }
    setPeselErr(false);
    const LATIN_NAME = /^[a-ząćęłńóśźż' -]+$/i;
    if (showNameFields) {
      const first = firstName.trim(), middle = middleName.trim(), last = lastName.trim();
      if (!first || !LATIN_NAME.test(first) || !last || !LATIN_NAME.test(last) || (middle && !LATIN_NAME.test(middle))) { setNameErr(true); return; }
    }
    setNameErr(false);
    const zam = zamSame ? regAddr : zamAddr;
    onSubmit({
      ...(showNameFields ? { firstName: firstName.trim(), middleName: middleName.trim() || undefined, lastName: lastName.trim() } : {}),
      birthPlace, pesel: pesel || undefined, addressPl, postalCode, city,
      addressRegistered: addressRegisteredSame ? addressPl : addressRegistered,
      motherName, fatherName, bankName, bankIban, phone, email, taxOffice, nfzBranch,
      isStudent, schoolName: isStudent ? schoolName : "",
      hasOtherEmployment, otherEmploymentNote,
      isRegisteredUnemployed, emergencyContact,
      nip, taxOfficeAddress, pit0,
      ankietaInnyPracodawca, ankietaEmeryt, ankietaRencista, ankietaNiepelnosprawnosc, ankietaSkladkaChorobowa,
      regWojewodztwo: regAddr.wojewodztwo, regPowiat: regAddr.powiat, regGmina: regAddr.gmina,
      regMiejscowosc: regAddr.miejscowosc, regUlica: regAddr.ulica, regNumerDomu: regAddr.numerDomu, regKodPocztowy: regAddr.kodPocztowy,
      zamWojewodztwo: zam.wojewodztwo, zamPowiat: zam.powiat, zamGmina: zam.gmina,
      zamMiejscowosc: zam.miejscowosc, zamUlica: zam.ulica, zamNumerDomu: zam.numerDomu, zamKodPocztowy: zam.kodPocztowy,
    }, isStudent ? certFile : null);
  }

  return (
    <Card className="p-4">
      <h2 className="mb-1 text-base font-semibold text-slate-800">{s("qTitle")}</h2>
      <p className="mb-4 text-xs text-slate-500">{s("qHint")}</p>
      {error && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{error}</p>}
      <div className="space-y-3">
        {showNameFields && (
          <>
            <Field label={s("firstName")}><input value={firstName} onChange={e => setFirstName(e.target.value)} className={inputCls} /></Field>
            <Field label={s("middleName")}><input value={middleName} onChange={e => setMiddleName(e.target.value)} className={inputCls} /></Field>
            <Field label={s("lastName")}><input value={lastName} onChange={e => setLastName(e.target.value)} className={inputCls} /></Field>
            {nameErr && <p className="-mt-2 text-xs text-rose-600">{s("badName")}</p>}
          </>
        )}
        <Field label={s("birthPlace")}><input value={birthPlace} onChange={e => setBirthPlace(e.target.value)} className={inputCls} /></Field>
        <Field label={s("pesel")}><input value={pesel} onChange={e => setPesel(e.target.value.replace(/\D/g, "").slice(0, 11))} inputMode="numeric" className={inputCls} /></Field>
        {peselErr && <p className="-mt-2 text-xs text-rose-600">{s("peselBad")}</p>}
        <Field label={s("addressPl")}><input value={addressPl} onChange={e => setAddressPl(e.target.value)} className={inputCls} /></Field>
        <Field label={s("postalCode")}><input value={postalCode} onChange={e => setPostalCode(e.target.value)} placeholder="00-000" className={inputCls} /></Field>
        <Field label={s("city")}><input value={city} onChange={e => setCity(e.target.value)} className={inputCls} /></Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={addressRegisteredSame} onChange={e => setAddressRegisteredSame(e.target.checked)} /> {s("addressRegisteredSame")}
        </label>
        {!addressRegisteredSame && (
          <Field label={s("addressRegistered")}><input value={addressRegistered} onChange={e => setAddressRegistered(e.target.value)} className={inputCls} /></Field>
        )}
        <Field label={s("motherName")}><input value={motherName} onChange={e => setMotherName(e.target.value)} className={inputCls} /></Field>
        <Field label={s("fatherName")}><input value={fatherName} onChange={e => setFatherName(e.target.value)} className={inputCls} /></Field>
        <Field label={s("bankName")}><input value={bankName} onChange={e => setBankName(e.target.value)} className={inputCls} /></Field>
        <Field label={s("bankIban")}><input value={bankIban} onChange={e => setBankIban(e.target.value)} className={inputCls} /></Field>
        <Field label={s("phone")}><input type="tel" value={phone} onChange={e => setPhone(e.target.value)} className={inputCls} /></Field>
        <Field label={s("email")}><input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} /></Field>
        <Field label={s("taxOffice")}><SearchableSelect value={taxOffice} onChange={setTaxOffice} options={TAX_OFFICES} className={inputCls} /></Field>
        <Field label={s("nfzBranch")}><SearchableSelect value={nfzBranch} onChange={setNfzBranch} options={NFZ_BRANCHES} className={inputCls} /></Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isStudent} onChange={e => setIsStudent(e.target.checked)} /> {s("isStudent")}
        </label>
        {isStudent && (
          <>
            <Field label={s("schoolName")}><input value={schoolName} onChange={e => setSchoolName(e.target.value)} className={inputCls} /></Field>
            <Field label={s("certLabel")}>
              <input type="file" accept="image/*,application/pdf" onChange={e => setCertFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-slate-600" />
            </Field>
          </>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={hasOtherEmployment} onChange={e => setHasOtherEmployment(e.target.checked)} /> {s("hasOtherEmployment")}
        </label>
        {hasOtherEmployment && (
          <Field label={s("otherEmploymentNote")}><input value={otherEmploymentNote} onChange={e => setOtherEmploymentNote(e.target.value)} className={inputCls} /></Field>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isRegisteredUnemployed} onChange={e => setIsRegisteredUnemployed(e.target.checked)} /> {s("isRegisteredUnemployed")}
        </label>
        <Field label={s("emergencyContact")}><input value={emergencyContact} onChange={e => setEmergencyContact(e.target.value)} className={inputCls} /></Field>

        <Field label={s("nip")}><input value={nip} onChange={e => setNip(e.target.value)} className={inputCls} /></Field>
        <Field label={s("taxOfficeAddress")}><input value={taxOfficeAddress} onChange={e => setTaxOfficeAddress(e.target.value)} className={inputCls} /></Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={pit0} onChange={e => setPit0(e.target.checked)} /> {s("pit0Label")}
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={ankietaInnyPracodawca} onChange={e => setAnkietaInnyPracodawca(e.target.checked)} /> {s("ankietaInnyPracodawca")}
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={ankietaEmeryt} onChange={e => setAnkietaEmeryt(e.target.checked)} /> {s("ankietaEmeryt")}
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={ankietaRencista} onChange={e => setAnkietaRencista(e.target.checked)} /> {s("ankietaRencista")}
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={ankietaNiepelnosprawnosc} onChange={e => setAnkietaNiepelnosprawnosc(e.target.checked)} /> {s("ankietaNiepelnosprawnosc")}
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={ankietaSkladkaChorobowa} onChange={e => setAnkietaSkladkaChorobowa(e.target.checked)} /> {s("ankietaSkladkaChorobowa")}
        </label>

        <h3 className="pt-1 text-sm font-semibold text-slate-800">{s("regAddressTitle")}</h3>
        <AddrFields s={s} value={regAddr} onChange={setRegAddr} />

        <h3 className="pt-1 text-sm font-semibold text-slate-800">{s("zamAddressTitle")}</h3>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={zamSame} onChange={e => setZamSame(e.target.checked)} /> {s("zamSameAsReg")}
        </label>
        {!zamSame && <AddrFields s={s} value={zamAddr} onChange={setZamAddr} />}
      </div>
      <Button disabled={busy} className="mt-4 w-full justify-center" onClick={submit}>
        {s("finishBtn")}
      </Button>
    </Card>
  );
}

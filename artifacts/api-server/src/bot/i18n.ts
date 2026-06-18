// Worker-bot localisation. Office/driver flows stay Ukrainian for now.
// To proofread/extend: edit the strings below — one row per key, 5 languages each.

export type Lang = "uk" | "en" | "es" | "ru" | "pl";
export const LANGS: Lang[] = ["uk", "en", "es", "ru", "pl"];

// Picker buttons. Russian intentionally has NO flag (per request).
export const LANG_LABEL: Record<Lang, string> = {
  uk: "🇺🇦 Українська",
  en: "🇬🇧 English",
  es: "🇪🇸 Español",
  ru: "Русский",
  pl: "🇵🇱 Polski",
};

export const isLang = (v: any): v is Lang => LANGS.includes(v);
export const asLang = (v: any): Lang => (isLang(v) ? v : "uk");

type Dict = Record<string, Record<Lang, string>>;

// {param} placeholders are filled from the params object.
const D: Dict = {
  // ── language picker ──
  "lang.choose":   { uk: "Оберіть мову:", en: "Choose your language:", es: "Elige tu idioma:", ru: "Выберите язык:", pl: "Wybierz język:" },
  "lang.changed":  { uk: "✅ Мову змінено.", en: "✅ Language changed.", es: "✅ Idioma cambiado.", ru: "✅ Язык изменён.", pl: "✅ Język zmieniono." },

  // ── menu buttons (also used as hears triggers in every language) ──
  "menu.schedule":     { uk: "📅 Мій графік на тиждень", en: "📅 My weekly schedule", es: "📅 Mi horario semanal", ru: "📅 Мой график на неделю", pl: "📅 Mój grafik na tydzień" },
  "menu.availability": { uk: "📋 Заповнити доступність", en: "📋 Submit availability", es: "📋 Enviar disponibilidad", ru: "📋 Заполнить доступность", pl: "📋 Wypełnij dyspozycyjność" },
  "menu.factoryInfo":  { uk: "🏭 Інфо по фабриці", en: "🏭 Factory info", es: "🏭 Info de la fábrica", ru: "🏭 Инфо по фабрике", pl: "🏭 Info o fabryce" },
  "menu.myHours":      { uk: "🕒 Мої години та зміни", en: "🕒 My hours & shifts", es: "🕒 Mis horas y turnos", ru: "🕒 Мои часы и смены", pl: "🕒 Moje godziny i zmiany" },
  "menu.absence":      { uk: "🙋 Зголосити відсутність", en: "🙋 Report absence", es: "🙋 Reportar ausencia", ru: "🙋 Сообщить об отсутствии", pl: "🙋 Zgłoś nieobecność" },
  "menu.myInfo":       { uk: "ℹ️ Моя інформація", en: "ℹ️ My info", es: "ℹ️ Mi información", ru: "ℹ️ Моя информация", pl: "ℹ️ Moje dane" },
  "menu.referral":     { uk: "🎁 Запроси друга", en: "🎁 Invite a friend", es: "🎁 Invita a un amigo", ru: "🎁 Пригласи друга", pl: "🎁 Zaproś znajomego" },
  "menu.report":       { uk: "📄 Здати рапорт", en: "📄 Submit report", es: "📄 Enviar reporte", ru: "📄 Сдать рапорт", pl: "📄 Złóż raport" },
  "menu.language":     { uk: "🌐 Мова", en: "🌐 Language", es: "🌐 Idioma", ru: "🌐 Язык", pl: "🌐 Język" },
  "menu.back":         { uk: "⬅️ Назад", en: "⬅️ Back", es: "⬅️ Atrás", ru: "⬅️ Назад", pl: "⬅️ Wstecz" },
  "menu.title":        { uk: "Головне меню:", en: "Main menu:", es: "Menú principal:", ru: "Главное меню:", pl: "Menu główne:" },

  // ── common ──
  "notRegistered": { uk: "❌ Ви не зареєстровані як працівник.", en: "❌ You are not registered as a worker.", es: "❌ No estás registrado como trabajador.", ru: "❌ Вы не зарегистрированы как работник.", pl: "❌ Nie jesteś zarejestrowany jako pracownik." },
  "start.greet":   { uk: "👷 Привіт, {name}! Ваше меню:", en: "👷 Hi {name}! Your menu:", es: "👷 ¡Hola {name}! Tu menú:", ru: "👷 Привет, {name}! Ваше меню:", pl: "👷 Cześć {name}! Twoje menu:" },
  "start.notReg":  { uk: "👋 Привіт, {name}!\n\nВи не зареєстровані. Зверніться до адміністратора або скористайтесь посиланням-запрошенням.", en: "👋 Hi {name}!\n\nYou are not registered. Contact the administrator or use an invite link.", es: "👋 ¡Hola {name}!\n\nNo estás registrado. Contacta al administrador o usa un enlace de invitación.", ru: "👋 Привет, {name}!\n\nВы не зарегистрированы. Обратитесь к администратору или воспользуйтесь ссылкой-приглашением.", pl: "👋 Cześć {name}!\n\nNie jesteś zarejestrowany. Skontaktuj się z administratorem lub użyj linku zaproszenia." },

  // ── days (short / full) ──
  "d.mon": { uk: "Пн", en: "Mon", es: "Lun", ru: "Пн", pl: "Pon" },
  "d.tue": { uk: "Вт", en: "Tue", es: "Mar", ru: "Вт", pl: "Wt" },
  "d.wed": { uk: "Ср", en: "Wed", es: "Mié", ru: "Ср", pl: "Śr" },
  "d.thu": { uk: "Чт", en: "Thu", es: "Jue", ru: "Чт", pl: "Czw" },
  "d.fri": { uk: "Пт", en: "Fri", es: "Vie", ru: "Пт", pl: "Pt" },
  "d.sat": { uk: "Сб", en: "Sat", es: "Sáb", ru: "Сб", pl: "Sob" },
  "d.sun": { uk: "Нд", en: "Sun", es: "Dom", ru: "Вс", pl: "Nd" },

  // ── schedule ──
  "sched.title":      { uk: "📅 *Ваш графік — {week}*", en: "📅 *Your schedule — {week}*", es: "📅 *Tu horario — {week}*", ru: "📅 *Ваш график — {week}*", pl: "📅 *Twój grafik — {week}*" },
  "sched.none":       { uk: "На цей тиждень у вас немає змін.", en: "No shifts for you this week.", es: "No tienes turnos esta semana.", ru: "На эту неделю у вас нет смен.", pl: "W tym tygodniu nie masz zmian." },
  "sched.dayOff":     { uk: "вихідний", en: "day off", es: "libre", ru: "выходной", pl: "wolne" },
  "sched.addresses":  { uk: "📍 *Адреси:*", en: "📍 *Addresses:*", es: "📍 *Direcciones:*", ru: "📍 *Адреса:*", pl: "📍 *Adresy:*" },
  "sched.noApproved": { uk: "📭 Немає затвердженого графіку.", en: "📭 No approved schedule yet.", es: "📭 Aún no hay horario aprobado.", ru: "📭 Нет утверждённого графика.", pl: "📭 Brak zatwierdzonego grafiku." },
  "sched.tabThis":    { uk: "Цей тиждень", en: "This week", es: "Esta semana", ru: "Эта неделя", pl: "Ten tydzień" },
  "sched.tabNext":    { uk: "Наступний", en: "Next week", es: "Próxima", ru: "Следующая", pl: "Następny" },

  // ── availability ──
  "av.manual":  { uk: "ℹ️ Для вашої фабрики графік складає адміністратор — доступність заповнювати не потрібно.", en: "ℹ️ For your factory the schedule is set by the administrator — no need to submit availability.", es: "ℹ️ En tu fábrica el horario lo fija el administrador — no necesitas enviar disponibilidad.", ru: "ℹ️ Для вашей фабрики график составляет администратор — заполнять доступность не нужно.", pl: "ℹ️ Dla Twojej fabryki grafik ustala administrator — nie trzeba podawać dyspozycyjności." },
  "av.intro":   { uk: "📋 *Доступність на тиждень {week}*\n\nОберіть зміни для днів, коли можете працювати (можна кілька).\nКоли готово — натисніть ✅ Підтвердити.", en: "📋 *Availability for the week {week}*\n\nPick shifts for the days you can work (multiple allowed).\nWhen ready — tap ✅ Confirm.", es: "📋 *Disponibilidad para la semana {week}*\n\nElige turnos para los días que puedes trabajar (varios permitidos).\nCuando estés listo — toca ✅ Confirmar.", ru: "📋 *Доступность на неделю {week}*\n\nВыберите смены для дней, когда можете работать (можно несколько).\nКогда готово — нажмите ✅ Подтвердить.", pl: "📋 *Dyspozycyjność na tydzień {week}*\n\nWybierz zmiany na dni, gdy możesz pracować (można kilka).\nGdy gotowe — naciśnij ✅ Potwierdź." },
  "av.already": { uk: "✅ *Ви вже заповнювали доступність на тиждень {week}.*\n\nНижче — ваш поточний вибір. Можете переглянути, змінити та натиснути ✅ Підтвердити (новий вибір замінить попередній).", en: "✅ *You already submitted availability for the week {week}.*\n\nBelow is your current choice. You can review, change it and tap ✅ Confirm (the new choice replaces the old one).", es: "✅ *Ya enviaste disponibilidad para la semana {week}.*\n\nAbajo está tu elección actual. Puedes revisarla, cambiarla y tocar ✅ Confirmar (lo nuevo reemplaza lo anterior).", ru: "✅ *Вы уже заполняли доступность на неделю {week}.*\n\nНиже — ваш текущий выбор. Можете просмотреть, изменить и нажать ✅ Подтвердить (новый выбор заменит прежний).", pl: "✅ *Już podałeś dyspozycyjność na tydzień {week}.*\n\nPoniżej Twój obecny wybór. Możesz go przejrzeć, zmienić i nacisnąć ✅ Potwierdź (nowy zastąpi poprzedni)." },
  "av.kbTitle": { uk: "📋 *Доступність {week}*", en: "📋 *Availability {week}*", es: "📋 *Disponibilidad {week}*", ru: "📋 *Доступность {week}*", pl: "📋 *Dyspozycyjność {week}*" },
  "av.kbHint":  { uk: "Можна обрати кілька змін на день. Дні без вибору (—) рахуються як «не доступний». Коли готово — натисніть ✅ Підтвердити:", en: "You can pick several shifts per day. Days with no choice (—) count as “not available”. When ready — tap ✅ Confirm:", es: "Puedes elegir varios turnos por día. Días sin elección (—) cuentan como «no disponible». Cuando estés listo — toca ✅ Confirmar:", ru: "Можно выбрать несколько смен в день. Дни без выбора (—) считаются «недоступен». Когда готово — нажмите ✅ Подтвердить:", pl: "Można wybrać kilka zmian dziennie. Dni bez wyboru (—) liczą się jako „niedostępny”. Gdy gotowe — naciśnij ✅ Potwierdź:" },
  "av.confirm": { uk: "✅ Підтвердити", en: "✅ Confirm", es: "✅ Confirmar", ru: "✅ Подтвердить", pl: "✅ Potwierdź" },
  "av.off":     { uk: "Вихідний", en: "Day off", es: "Libre", ru: "Выходной", pl: "Wolne" },
  "av.shift":   { uk: "{n}зм", en: "{n}sh", es: "{n}t", ru: "{n}см", pl: "{n}zm" },
  "av.saved":   { uk: "✅ *Доступність збережено!*\n\nТиждень: {week}\n\n{summary}", en: "✅ *Availability saved!*\n\nWeek: {week}\n\n{summary}", es: "✅ *¡Disponibilidad guardada!*\n\nSemana: {week}\n\n{summary}", ru: "✅ *Доступность сохранена!*\n\nНеделя: {week}\n\n{summary}", pl: "✅ *Dyspozycyjność zapisana!*\n\nTydzień: {week}\n\n{summary}" },

  // ── factory info ──
  "fac.noFactory": { uk: "ℹ️ За вами ще не закріплена фабрика. Зверніться до адміністратора.", en: "ℹ️ No factory assigned to you yet. Contact the administrator.", es: "ℹ️ Aún no tienes fábrica asignada. Contacta al administrador.", ru: "ℹ️ За вами ещё не закреплена фабрика. Обратитесь к администратору.", pl: "ℹ️ Nie masz jeszcze przypisanej fabryki. Skontaktuj się z administratorem." },
  "fac.notFound":  { uk: "ℹ️ Фабрику не знайдено.", en: "ℹ️ Factory not found.", es: "ℹ️ Fábrica no encontrada.", ru: "ℹ️ Фабрика не найдена.", pl: "ℹ️ Nie znaleziono fabryki." },
  "fac.shifts":    { uk: "🕐 *Зміни:*", en: "🕐 *Shifts:*", es: "🕐 *Turnos:*", ru: "🕐 *Смены:*", pl: "🕐 *Zmiany:*" },
  "fac.shiftRow":  { uk: "{n} зміна: {start}–{end}", en: "Shift {n}: {start}–{end}", es: "Turno {n}: {start}–{end}", ru: "{n} смена: {start}–{end}", pl: "Zmiana {n}: {start}–{end}" },
  "fac.notSet":    { uk: "не налаштовано", en: "not set", es: "no configurado", ru: "не настроено", pl: "nie ustawiono" },
  "fac.stops":     { uk: "🚌 *Зупинки (де забирає водій):*", en: "🚌 *Pickup stops (where the driver collects you):*", es: "🚌 *Paradas (donde te recoge el conductor):*", ru: "🚌 *Остановки (где забирает водитель):*", pl: "🚌 *Przystanki (gdzie zabiera kierowca):*" },
  "fac.stopAt":    { uk: "бути о", en: "be there at", es: "estar a las", ru: "быть в", pl: "być o" },
  "fac.noStops":   { uk: "ℹ️ Зупинки ще не вказані. Уточніть у диспетчера.", en: "ℹ️ Pickup stops not set yet. Ask the dispatcher.", es: "ℹ️ Paradas aún no definidas. Pregunta al despachador.", ru: "ℹ️ Остановки ещё не указаны. Уточните у диспетчера.", pl: "ℹ️ Przystanki jeszcze nieustawione. Zapytaj dyspozytora." },

  // ── my hours (read-only) ──
  "hours.title":      { uk: "🕒 *Мої години та зміни*", en: "🕒 *My hours & shifts*", es: "🕒 *Mis horas y turnos*", ru: "🕒 *Мои часы и смены*", pl: "🕒 *Moje godziny i zmiany*" },
  "hours.disclaimer": { uk: "⚠️ _Це приблизний підрахунок ботом, не офіційні дані. Можливі неточності, точна звірка буде в кінці місяця._", en: "⚠️ _This is an approximate bot estimate, not official data. The exact reconciliation is at month end._", es: "⚠️ _Es un cálculo aproximado del bot, no datos oficiales. La conciliación exacta es a fin de mes._", ru: "⚠️ _Это приблизительный подсчёт ботом, не официальные данные. Точная сверка будет в конце месяца._", pl: "⚠️ _To przybliżone wyliczenie bota, nie dane oficjalne. Dokładne rozliczenie na koniec miesiąca._" },
  "hours.month":      { uk: "📅 Цей місяць: *{shifts}* змін · *{hours} год*", en: "📅 This month: *{shifts}* shifts · *{hours} h*", es: "📅 Este mes: *{shifts}* turnos · *{hours} h*", ru: "📅 Этот месяц: *{shifts}* смен · *{hours} ч*", pl: "📅 Ten miesiąc: *{shifts}* zmian · *{hours} godz*" },
  "hours.worked":     { uk: "*Відпрацьовані зміни:*", en: "*Worked shifts:*", es: "*Turnos trabajados:*", ru: "*Отработанные смены:*", pl: "*Przepracowane zmiany:*" },
  "hours.none":       { uk: "Цього місяця змін ще немає.", en: "No shifts this month yet.", es: "Aún no hay turnos este mes.", ru: "В этом месяце смен ещё нет.", pl: "W tym miesiącu nie ma jeszcze zmian." },
  "hours.editBtn":    { uk: "✏️ Повідомити про помилку / редагувати", en: "✏️ Report a mistake / edit", es: "✏️ Reportar error / editar", ru: "✏️ Сообщить об ошибке / изменить", pl: "✏️ Zgłoś błąd / edytuj" },

  // ── my hours (edit review) ──
  "hr.instr":      { uk: "👉 Натисніть на зміну, щоб *змінити години* або *видалити* її.\nЯкщо якоїсь зміни немає — натисніть «Додати зміну».", en: "👉 Tap a shift to *change hours* or *delete* it.\nIf a shift is missing — tap “Add shift”.", es: "👉 Toca un turno para *cambiar horas* o *eliminarlo*.\nSi falta un turno — toca «Añadir turno».", ru: "👉 Нажмите на смену, чтобы *изменить часы* или *удалить*.\nЕсли смены нет — нажмите «Добавить смену».", pl: "👉 Naciśnij zmianę, aby *zmienić godziny* lub *usunąć*.\nJeśli brakuje zmiany — naciśnij „Dodaj zmianę”." },
  "hr.instrEmpty": { uk: "Цього місяця змін ще немає.\nЯкщо вам не зарахували зміну — натисніть «➕ Додати зміну».", en: "No shifts this month yet.\nIf a shift wasn't counted — tap “➕ Add shift”.", es: "Aún no hay turnos este mes.\nSi no contaron un turno — toca «➕ Añadir turno».", ru: "В этом месяце смен ещё нет.\nЕсли вам не засчитали смену — нажмите «➕ Добавить смену».", pl: "W tym miesiącu nie ma jeszcze zmian.\nJeśli zmiana nie została policzona — naciśnij „➕ Dodaj zmianę”." },
  "hr.add":        { uk: "➕ Додати зміну, якої немає", en: "➕ Add a missing shift", es: "➕ Añadir un turno que falta", ru: "➕ Добавить недостающую смену", pl: "➕ Dodaj brakującą zmianę" },
  "hr.send":       { uk: "✅ Надіслати", en: "✅ Send", es: "✅ Enviar", ru: "✅ Отправить", pl: "✅ Wyślij" },
  "hr.close":      { uk: "✖️ Закрити", en: "✖️ Close", es: "✖️ Cerrar", ru: "✖️ Закрыть", pl: "✖️ Zamknij" },
  "hr.added":      { uk: "➕ Додано: {date} · {shift} зм (прибрати)", en: "➕ Added: {date} · shift {shift} (remove)", es: "➕ Añadido: {date} · turno {shift} (quitar)", ru: "➕ Добавлено: {date} · смена {shift} (убрать)", pl: "➕ Dodano: {date} · zmiana {shift} (usuń)" },
  "hr.shiftMenu":  { uk: "📅 *{date} · {shift} зміна*\n🏭 {factory}\n🕒 Години: *{hours}*\n\nЩо зробити з цією зміною?", en: "📅 *{date} · shift {shift}*\n🏭 {factory}\n🕒 Hours: *{hours}*\n\nWhat to do with this shift?", es: "📅 *{date} · turno {shift}*\n🏭 {factory}\n🕒 Horas: *{hours}*\n\n¿Qué hacer con este turno?", ru: "📅 *{date} · смена {shift}*\n🏭 {factory}\n🕒 Часы: *{hours}*\n\nЧто сделать с этой сменой?", pl: "📅 *{date} · zmiana {shift}*\n🏭 {factory}\n🕒 Godziny: *{hours}*\n\nCo zrobić z tą zmianą?" },
  "hr.changeHours":{ uk: "✏️ Змінити кількість годин", en: "✏️ Change hours", es: "✏️ Cambiar horas", ru: "✏️ Изменить часы", pl: "✏️ Zmień godziny" },
  "hr.delete":     { uk: "🗑 Видалити цю зміну", en: "🗑 Delete this shift", es: "🗑 Eliminar este turno", ru: "🗑 Удалить эту смену", pl: "🗑 Usuń tę zmianę" },
  "hr.undelete":   { uk: "↩️ НЕ видаляти", en: "↩️ Don't delete", es: "↩️ No eliminar", ru: "↩️ Не удалять", pl: "↩️ Nie usuwaj" },
  "hr.backList":   { uk: "⬅️ Назад до списку", en: "⬅️ Back to list", es: "⬅️ Volver a la lista", ru: "⬅️ Назад к списку", pl: "⬅️ Powrót do listy" },
  "hr.askHours":   { uk: "✏️ {date} · {shift}зм · зараз *{hours} год*.\nВведіть правильну кількість годин (напр. 12):", en: "✏️ {date} · shift {shift} · now *{hours} h*.\nEnter the correct number of hours (e.g. 12):", es: "✏️ {date} · turno {shift} · ahora *{hours} h*.\nIngresa las horas correctas (ej. 12):", ru: "✏️ {date} · смена {shift} · сейчас *{hours} ч*.\nВведите правильное число часов (напр. 12):", pl: "✏️ {date} · zmiana {shift} · teraz *{hours} godz*.\nWpisz poprawną liczbę godzin (np. 12):" },
  "hr.badHours":   { uk: "❌ Введіть число годин від 0 до 24 (напр. 12):", en: "❌ Enter hours from 0 to 24 (e.g. 12):", es: "❌ Ingresa horas de 0 a 24 (ej. 12):", ru: "❌ Введите число часов от 0 до 24 (напр. 12):", pl: "❌ Wpisz godziny od 0 do 24 (np. 12):" },
  "hr.askDate":    { uk: "📅 Введіть дату пропущеної зміни (напр. `11.06`), або /skip щоб скасувати:", en: "📅 Enter the date of the missing shift (e.g. `11.06`), or /skip to cancel:", es: "📅 Ingresa la fecha del turno faltante (ej. `11.06`), o /skip para cancelar:", ru: "📅 Введите дату пропущенной смены (напр. `11.06`), или /skip чтобы отменить:", pl: "📅 Wpisz datę brakującej zmiany (np. `11.06`), lub /skip aby anulować:" },
  "hr.badDate":    { uk: "❌ Формат дати: `ДД.ММ` (напр. 11.06). Спробуйте ще, або /skip:", en: "❌ Date format: `DD.MM` (e.g. 11.06). Try again, or /skip:", es: "❌ Formato: `DD.MM` (ej. 11.06). Inténtalo de nuevo, o /skip:", ru: "❌ Формат даты: `ДД.ММ` (напр. 11.06). Попробуйте ещё, или /skip:", pl: "❌ Format daty: `DD.MM` (np. 11.06). Spróbuj ponownie, lub /skip:" },
  "hr.badDate2":   { uk: "❌ Такої дати немає. Спробуйте ще, або /skip:", en: "❌ No such date. Try again, or /skip:", es: "❌ Fecha inexistente. Inténtalo, o /skip:", ru: "❌ Такой даты нет. Попробуйте ещё, или /skip:", pl: "❌ Nie ma takiej daty. Spróbuj, lub /skip:" },
  "hr.pickShift":  { uk: "📅 {date} · 🏭 {factory}\nОберіть зміну:", en: "📅 {date} · 🏭 {factory}\nChoose a shift:", es: "📅 {date} · 🏭 {factory}\nElige un turno:", ru: "📅 {date} · 🏭 {factory}\nВыберите смену:", pl: "📅 {date} · 🏭 {factory}\nWybierz zmianę:" },
  "hr.shiftN":     { uk: "{n} зміна", en: "Shift {n}", es: "Turno {n}", ru: "{n} смена", pl: "Zmiana {n}" },
  "hr.cancel":     { uk: "✖️ Скасувати", en: "✖️ Cancel", es: "✖️ Cancelar", ru: "✖️ Отмена", pl: "✖️ Anuluj" },
  "hr.nothing":    { uk: "Немає правок — виправте години, приберіть або додайте зміну", en: "No changes — fix hours, remove or add a shift", es: "Sin cambios — corrige horas, quita o añade un turno", ru: "Нет правок — измените часы, уберите или добавьте смену", pl: "Brak zmian — popraw godziny, usuń lub dodaj zmianę" },
  "hr.sent":       { uk: "✅ Дякуємо! Ваші правки надіслано менеджеру на перевірку. Ми повідомимо вас про рішення.", en: "✅ Thank you! Your changes were sent to the manager for review. We'll notify you of the decision.", es: "✅ ¡Gracias! Tus cambios se enviaron al gerente para revisión. Te avisaremos de la decisión.", ru: "✅ Спасибо! Ваши правки отправлены менеджеру на проверку. Мы сообщим о решении.", pl: "✅ Dziękujemy! Twoje zmiany wysłano do menedżera. Powiadomimy o decyzji." },

  // ── absence ──
  "abs.title":   { uk: "🙋 *Зголосити відсутність*\n\nℹ️ Зголосити можна щонайменше *за 24 години* до початку зміни.", en: "🙋 *Report absence*\n\nℹ️ You can report at least *24 hours* before the shift starts.", es: "🙋 *Reportar ausencia*\n\nℹ️ Puedes reportar al menos *24 horas* antes del turno.", ru: "🙋 *Сообщить об отсутствии*\n\nℹ️ Сообщить можно минимум *за 24 часа* до начала смены.", pl: "🙋 *Zgłoś nieobecność*\n\nℹ️ Można zgłosić co najmniej *24 godziny* przed zmianą." },
  "abs.tooLate": { uk: "\n\n⏰ _Запізно (менше 24 год до початку):_", en: "\n\n⏰ _Too late (less than 24h before):_", es: "\n\n⏰ _Demasiado tarde (menos de 24h):_", ru: "\n\n⏰ _Поздно (меньше 24 ч до начала):_", pl: "\n\n⏰ _Za późno (mniej niż 24h):_" },
  "abs.noneEligible": { uk: "\n\nНемає змін, на які ще можна зголоситися.", en: "\n\nNo shifts you can still report for.", es: "\n\nNo hay turnos para reportar.", ru: "\n\nНет смен, о которых ещё можно сообщить.", pl: "\n\nBrak zmian do zgłoszenia." },
  "abs.pick":    { uk: "\n\nОберіть зміну, на яку не зможете прийти:", en: "\n\nChoose the shift you can't attend:", es: "\n\nElige el turno al que no podrás asistir:", ru: "\n\nВыберите смену, на которую не сможете прийти:", pl: "\n\nWybierz zmianę, na którą nie przyjdziesz:" },
  "abs.noShifts":{ uk: "У вас немає запланованих змін на цей та наступний тиждень.", en: "You have no planned shifts for this or next week.", es: "No tienes turnos planificados para esta o la próxima semana.", ru: "У вас нет запланированных смен на эту и следующую неделю.", pl: "Nie masz zaplanowanych zmian na ten i następny tydzień." },
  "abs.askReason": { uk: "🙋 Зміна: *{day} {shift}*\n\nВкажіть причину відсутності:", en: "🙋 Shift: *{day} {shift}*\n\nState the reason for absence:", es: "🙋 Turno: *{day} {shift}*\n\nIndica el motivo de la ausencia:", ru: "🙋 Смена: *{day} {shift}*\n\nУкажите причину отсутствия:", pl: "🙋 Zmiana: *{day} {shift}*\n\nPodaj powód nieobecności:" },
  "abs.sent":    { uk: "✅ *Зголошення прийнято!*\n\nВи зголосили відсутність на {day} ({shift}).\n\nАдміністратор отримав повідомлення.", en: "✅ *Request submitted!*\n\nYou reported absence for {day} ({shift}).\n\nThe administrator was notified.", es: "✅ *¡Solicitud enviada!*\n\nReportaste ausencia para {day} ({shift}).\n\nEl administrador fue notificado.", ru: "✅ *Заявка принята!*\n\nВы сообщили об отсутствии на {day} ({shift}).\n\nАдминистратор уведомлён.", pl: "✅ *Zgłoszenie przyjęte!*\n\nZgłosiłeś nieobecność na {day} ({shift}).\n\nAdministrator został powiadomiony." },

  // ── my info ──
  "info.body": { uk: "👷 <b>{name}</b>\n🆔 Telegram: <code>{id}</code>\n🔑 Ваш код: <code>{code}</code>\n\n💡 Хочете покликати друга на роботу й отримати бонус? Тисніть «🎁 Запроси друга».", en: "👷 <b>{name}</b>\n🆔 Telegram: <code>{id}</code>\n🔑 Your code: <code>{code}</code>\n\n💡 Want to invite a friend and earn a bonus? Tap “🎁 Invite a friend”.", es: "👷 <b>{name}</b>\n🆔 Telegram: <code>{id}</code>\n🔑 Tu código: <code>{code}</code>\n\n💡 ¿Quieres invitar a un amigo y ganar un bono? Toca «🎁 Invita a un amigo».", ru: "👷 <b>{name}</b>\n🆔 Telegram: <code>{id}</code>\n🔑 Ваш код: <code>{code}</code>\n\n💡 Хотите пригласить друга и получить бонус? Нажмите «🎁 Пригласи друга».", pl: "👷 <b>{name}</b>\n🆔 Telegram: <code>{id}</code>\n🔑 Twój kod: <code>{code}</code>\n\n💡 Chcesz zaprosić znajomego i dostać bonus? Naciśnij „🎁 Zaproś znajomego”." },

  // ── referral ──
  "ref.header":  { uk: "🎁 <b>Запроси друга — отримай бонус</b>\n\nНадішліть це посилання другові. Коли він вийде на роботу — ви отримаєте бонус 💰\n\n👉 <b>Ваше посилання</b> (натисніть щоб скопіювати):\n<code>{link}</code>", en: "🎁 <b>Invite a friend — get a bonus</b>\n\nSend this link to a friend. When they start working — you get a bonus 💰\n\n👉 <b>Your link</b> (tap to copy):\n<code>{link}</code>", es: "🎁 <b>Invita a un amigo — gana un bono</b>\n\nEnvía este enlace a un amigo. Cuando empiece a trabajar — recibes un bono 💰\n\n👉 <b>Tu enlace</b> (toca para copiar):\n<code>{link}</code>", ru: "🎁 <b>Пригласи друга — получи бонус</b>\n\nОтправьте эту ссылку другу. Когда он выйдет на работу — вы получите бонус 💰\n\n👉 <b>Ваша ссылка</b> (нажмите, чтобы скопировать):\n<code>{link}</code>", pl: "🎁 <b>Zaproś znajomego — odbierz bonus</b>\n\nWyślij ten link znajomemu. Gdy zacznie pracę — dostaniesz bonus 💰\n\n👉 <b>Twój link</b> (naciśnij, aby skopiować):\n<code>{link}</code>" },
  "ref.list":    { uk: "\n\n📋 <b>Ваші запрошені ({n}):</b>", en: "\n\n📋 <b>Your invitees ({n}):</b>", es: "\n\n📋 <b>Tus invitados ({n}):</b>", ru: "\n\n📋 <b>Ваши приглашённые ({n}):</b>", pl: "\n\n📋 <b>Twoi zaproszeni ({n}):</b>" },
  "ref.none":    { uk: "\n\nℹ️ Ви ще нікого не запросили.", en: "\n\nℹ️ You haven't invited anyone yet.", es: "\n\nℹ️ Aún no has invitado a nadie.", ru: "\n\nℹ️ Вы ещё никого не пригласили.", pl: "\n\nℹ️ Nikogo jeszcze nie zaprosiłeś." },
  "ref.active":  { uk: " · 👷 активний працівник", en: " · 👷 active worker", es: " · 👷 trabajador activo", ru: " · 👷 активный работник", pl: " · 👷 aktywny pracownik" },
  "ref.bonusPaid": { uk: " · 💰 бонус виплачено", en: " · 💰 bonus paid", es: " · 💰 bono pagado", ru: " · 💰 бонус выплачен", pl: " · 💰 bonus wypłacony" },
  "ref.bonusWait": { uk: " · ⏳ бонус очікує", en: " · ⏳ bonus pending", es: " · ⏳ bono pendiente", ru: " · ⏳ бонус ожидает", pl: " · ⏳ bonus oczekuje" },

  // ── push notifications (sent TO workers) ──
  "notif.reminder":      { uk: "🔔 *Нагадування про зміну*\n\nЧерез 2 години: *{shift}* ({time})\n🏭 {factory}\n\nБудьте вчасно!", en: "🔔 *Shift reminder*\n\nIn 2 hours: *{shift}* ({time})\n🏭 {factory}\n\nBe on time!", es: "🔔 *Recordatorio de turno*\n\nEn 2 horas: *{shift}* ({time})\n🏭 {factory}\n\n¡Sé puntual!", ru: "🔔 *Напоминание о смене*\n\nЧерез 2 часа: *{shift}* ({time})\n🏭 {factory}\n\nБудьте вовремя!", pl: "🔔 *Przypomnienie o zmianie*\n\nZa 2 godziny: *{shift}* ({time})\n🏭 {factory}\n\nBądź punktualnie!" },
  "notif.schedHdr":      { uk: "📅 *Ваш графік — {factory}*\nТиждень: {week}\n\n{lines}", en: "📅 *Your schedule — {factory}*\nWeek: {week}\n\n{lines}", es: "📅 *Tu horario — {factory}*\nSemana: {week}\n\n{lines}", ru: "📅 *Ваш график — {factory}*\nНеделя: {week}\n\n{lines}", pl: "📅 *Twój grafik — {factory}*\nTydzień: {week}\n\n{lines}" },
  "notif.schedWeekHdr":  { uk: "📅 *Ваш графік на тиждень {week}*\n\n{lines}", en: "📅 *Your schedule for the week {week}*\n\n{lines}", es: "📅 *Tu horario para la semana {week}*\n\n{lines}", ru: "📅 *Ваш график на неделю {week}*\n\n{lines}", pl: "📅 *Twój grafik na tydzień {week}*\n\n{lines}" },
  "notif.schedDrvHdr":   { uk: "📅 *Графік — {factory}*\n{week}\n\n{lines}", en: "📅 *Schedule — {factory}*\n{week}\n\n{lines}", es: "📅 *Horario — {factory}*\n{week}\n\n{lines}", ru: "📅 *График — {factory}*\n{week}\n\n{lines}", pl: "📅 *Grafik — {factory}*\n{week}\n\n{lines}" },
  "notif.drvNone":       { uk: "водій не призначений", en: "no driver assigned", es: "sin conductor asignado", ru: "водитель не назначен", pl: "brak przypisanego kierowcy" },
  "notif.absentPrompt":  { uk: "⚠️ *{name}*, сьогодні ({day}) вас відмітили як відсутнього на зміну *{shift}*.\n\nБудь ласка, напишіть причину вашої відсутності:", en: "⚠️ *{name}*, today ({day}) you were marked absent for shift *{shift}*.\n\nPlease state the reason for your absence:", es: "⚠️ *{name}*, hoy ({day}) te marcaron como ausente en el turno *{shift}*.\n\nPor favor, indica el motivo de tu ausencia:", ru: "⚠️ *{name}*, сегодня ({day}) вас отметили как отсутствующего на смене *{shift}*.\n\nПожалуйста, напишите причину вашего отсутствия:", pl: "⚠️ *{name}*, dziś ({day}) oznaczono Cię jako nieobecnego na zmianie *{shift}*.\n\nProszę podać powód nieobecności:" },
  "notif.availReminder": { uk: "📋 *Нагадування*\n\nЗаповніть доступність на тиждень *{week}*!\n\nНатисніть «{btn}» у меню.", en: "📋 *Reminder*\n\nSubmit your availability for the week *{week}*!\n\nTap “{btn}” in the menu.", es: "📋 *Recordatorio*\n\n¡Envía tu disponibilidad para la semana *{week}*!\n\nToca «{btn}» en el menú.", ru: "📋 *Напоминание*\n\nЗаполните доступность на неделю *{week}*!\n\nНажмите «{btn}» в меню.", pl: "📋 *Przypomnienie*\n\nWypełnij dyspozycyjność na tydzień *{week}*!\n\nNaciśnij „{btn}” w menu." },
  "notif.candActive":    { uk: "🎉 *{friend}* вийшов(ла) на роботу за вашим запрошенням!\n\nВам належить бонус 💰 — щойно його випишуть, ви отримаєте сповіщення.", en: "🎉 *{friend}* started working thanks to your invitation!\n\nYou're owed a bonus 💰 — you'll be notified as soon as it's issued.", es: "🎉 *{friend}* empezó a trabajar gracias a tu invitación!\n\nTe corresponde un bono 💰 — te avisaremos en cuanto se emita.", ru: "🎉 *{friend}* вышел(ла) на работу по вашему приглашению!\n\nВам положен бонус 💰 — как только его оформят, вы получите уведомление.", pl: "🎉 *{friend}* zaczął(-ęła) pracę dzięki Twojemu zaproszeniu!\n\nNależy Ci się bonus 💰 — powiadomimy Cię, gdy zostanie przyznany." },
  "notif.bonusPaid":     { uk: "💰 *Бонус виплачено!*\n\nЗа запрошення *{friend}*{amount}. Дякуємо, що приводите нових людей! 🙌", en: "💰 *Bonus paid!*\n\nFor inviting *{friend}*{amount}. Thanks for bringing in new people! 🙌", es: "💰 *¡Bono pagado!*\n\nPor invitar a *{friend}*{amount}. ¡Gracias por traer gente nueva! 🙌", ru: "💰 *Бонус выплачен!*\n\nЗа приглашение *{friend}*{amount}. Спасибо, что приводите новых людей! 🙌", pl: "💰 *Bonus wypłacony!*\n\nZa zaproszenie *{friend}*{amount}. Dzięki za przyprowadzanie nowych osób! 🙌" },
  "notif.dispHdr":       { uk: "📋 Ваші правки годин розглянуто:\n\n{lines}", en: "📋 Your hours corrections were reviewed:\n\n{lines}", es: "📋 Tus correcciones de horas fueron revisadas:\n\n{lines}", ru: "📋 Ваши правки часов рассмотрены:\n\n{lines}", pl: "📋 Twoje poprawki godzin rozpatrzono:\n\n{lines}" },
  "notif.dispYes":       { uk: "✅ прийнято", en: "✅ accepted", es: "✅ aceptado", ru: "✅ принято", pl: "✅ przyjęto" },
  "notif.dispNo":        { uk: "❌ не прийнято", en: "❌ not accepted", es: "❌ no aceptado", ru: "❌ не принято", pl: "❌ nie przyjęto" },
  "notif.dispAdd":       { uk: "додати {date} {shift}зм", en: "add {date} shift {shift}", es: "añadir {date} turno {shift}", ru: "добавить {date} смена {shift}", pl: "dodać {date} zmiana {shift}" },
  "notif.dispRemove":    { uk: "прибрати {date} {shift}зм", en: "remove {date} shift {shift}", es: "quitar {date} turno {shift}", ru: "убрать {date} смена {shift}", pl: "usunąć {date} zmiana {shift}" },
  "notif.dispChange":    { uk: "{date} {shift}зм → {hours} год", en: "{date} shift {shift} → {hours} h", es: "{date} turno {shift} → {hours} h", ru: "{date} смена {shift} → {hours} ч", pl: "{date} zmiana {shift} → {hours} godz" },
  "notif.absAccepted":   { uk: "✅ Вашу відсутність на *{day} {shift}* прийнято.", en: "✅ Your absence for *{day} {shift}* was accepted.", es: "✅ Tu ausencia para *{day} {shift}* fue aceptada.", ru: "✅ Ваше отсутствие на *{day} {shift}* принято.", pl: "✅ Twoja nieobecność na *{day} {shift}* została przyjęta." },
  "notif.absRejected":   { uk: "❌ Вашу відсутність на *{day} {shift}* відхилено. Зверніться до диспетчера.", en: "❌ Your absence for *{day} {shift}* was rejected. Contact the dispatcher.", es: "❌ Tu ausencia para *{day} {shift}* fue rechazada. Contacta al despachador.", ru: "❌ Ваше отсутствие на *{day} {shift}* отклонено. Обратитесь к диспетчеру.", pl: "❌ Twoja nieobecność na *{day} {shift}* została odrzucona. Skontaktuj się z dyspozytorem." },
  "notif.subAssigned":   { uk: "🆕 Вас поставили на зміну *{day} {shift}* (заміна). Перевірте «{btn}».", en: "🆕 You were assigned to shift *{day} {shift}* (substitute). Check “{btn}”.", es: "🆕 Te asignaron al turno *{day} {shift}* (sustitución). Revisa «{btn}».", ru: "🆕 Вас поставили на смену *{day} {shift}* (замена). Проверьте «{btn}».", pl: "🆕 Przydzielono Cię do zmiany *{day} {shift}* (zastępstwo). Sprawdź „{btn}”." },

  // ── stages (referral) ──
  "stage.new":       { uk: "🆕 нова заявка", en: "🆕 new", es: "🆕 nuevo", ru: "🆕 новая заявка", pl: "🆕 nowy" },
  "stage.contacted": { uk: "📞 зв'язалися", en: "📞 contacted", es: "📞 contactado", ru: "📞 связались", pl: "📞 skontaktowano" },
  "stage.interview": { uk: "🤝 співбесіда", en: "🤝 interview", es: "🤝 entrevista", ru: "🤝 собеседование", pl: "🤝 rozmowa" },
  "stage.hired":     { uk: "✅ працює", en: "✅ hired", es: "✅ contratado", ru: "✅ работает", pl: "✅ zatrudniony" },
  "stage.rejected":  { uk: "❌ відмова", en: "❌ rejected", es: "❌ rechazado", ru: "❌ отказ", pl: "❌ odmowa" },
};

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const row = D[key];
  let s = row ? (row[lang] ?? row.uk) : key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// All language variants of a key — used as Telegraf hears() triggers so a button
// works no matter which language the worker picked.
export function trAll(key: string): string[] {
  const row = D[key];
  return row ? [...new Set(LANGS.map(l => row[l]))] : [key];
}

export const dayShort = (lang: Lang, day: string) => t(lang, `d.${day}`);
export const stageLabel = (lang: Lang, stage: string) => t(lang, `stage.${stage}`) || stage;
export { DAY_KEYS };

// ─────────────────────────────────────────────────────────────────────────────
// Office/admin + driver bot localisation (Ukrainian + English only).
// Uses the "Ukrainian-string-as-key" approach (like the web panel): the uk text
// IS the key, BOT_EN holds uk→en. tb(lang, uk) returns en when lang="en", else uk.
// bhears(uk) returns [uk, en] so bot.hears matches a button in either language.
export const OFFICE_LANGS: Lang[] = ["uk", "en"];
export const oLang = (v: any): Lang => (v === "en" ? "en" : "uk"); // office/driver: uk default

// uk → en. Add pairs here as strings get wrapped with tb(). Proofread later.
const BOT_EN: Record<string, string> = {
  // ── menus / buttons ──
  "📋 Замовлення фабрик": "📋 Factory orders",
  "📊 Читати таблицю": "📊 Read spreadsheet",
  "🗓 Генерувати графік": "🗓 Generate schedule",
  "✅ Перегляд графіків": "✅ Review schedules",
  "📥 Імпорт графіку (Excel)": "📥 Import schedule (Excel)",
  "👥 Управління": "👥 Management",
  "📢 Розсилки": "📢 Broadcasts",
  "🌐 Мова / Language": "🌐 Language / Мова",
  "➕ Додати працівника": "➕ Add worker",
  "📋 Список працівників": "📋 Worker list",
  "📥 Імпорт працівників": "📥 Import workers",
  "🔗 Прив'язати Telegram": "🔗 Link Telegram",
  "🚗 Водії": "🚗 Drivers",
  "🏭 Фабрики": "🏭 Factories",
  "🔥 Звільнити працівника": "🔥 Dismiss worker",
  "👑 Адміни": "👑 Admins",
  "☁️ Google Drive": "☁️ Google Drive",
  "⬅️ Назад": "⬅️ Back",
  "📍 Моя зміна сьогодні": "📍 My shift today",
  "📅 Мій графік": "📅 My schedule",
  "✅ Посадка / явка": "✅ Boarding / attendance",
  "🏭 Прибув на фабрику": "🏭 Arrived at factory",
  "📋 Призначити водіїв": "📋 Assign drivers",
  "📅 Графік тижня": "📅 Week schedule",
  "👥 Мій список водіїв": "👥 My driver list",
  "📨 Нагадати заповнити таблицю": "📨 Remind to submit availability",
  "⏰ Змінити час нагадування": "⏰ Change reminder time",
  "🔔 Тест нагадування": "🔔 Test reminder",
  "📢 Розіслати затверджений графік": "📢 Send approved schedule",
  "➕ Додати водія": "➕ Add driver",
  "📋 Список водіїв": "📋 Driver list",
  "🔗 Прив'язати вручну (ID)": "🔗 Link manually (ID)",
  "📨 Запросити водія": "📨 Invite driver",
  "👑 Призначити головним": "👑 Make head driver",
  "⏰ Часи змін фабрики": "⏰ Factory shift times",
  "📧 Email клієнта": "📧 Client email",
  "➕ Додати фабрику": "➕ Add factory",
  "📋 Список фабрик": "📋 Factory list",
  "🔐 Мій веб-доступ": "🔐 My web access",
  "➕ Додати адміна": "➕ Add admin",
  "🗑 Видалити адміна": "🗑 Delete admin",
  "🚌 Почати поїздку": "🚌 Start trip",
  "⚠️ Не прийшли до машини": "⚠️ Didn't come to the vehicle",
  "➕ Позаплановий працівник": "➕ Unplanned worker",

  // ── greetings / navigation ──
  "✅ Привіт, *{name}*!\n\nВас прив'язано до бота як водія.": "✅ Hi *{name}*!\n\nYou've been linked to the bot as a driver.",
  "👋 Привіт, *{name}*! Ви адміністратор.": "👋 Hi *{name}*! You are an administrator.",
  "Ви головний водій.": "You are the head driver.",
  "Ваше меню:": "Your menu:",
  "Привіт, *{name}*!": "Hi *{name}*!",
  "Головне меню:": "Main menu:",
  "✅ Мову змінено.": "✅ Language changed.",

  // ── driver / head-driver flows ──
  "Немає затверджених графіків.": "No approved schedules.",
  "Оберіть тиждень:": "Choose a week:",
  "❌ Немає доступу.": "❌ No access.",
  "Список водіїв порожній.": "Driver list is empty.",
  "Водії": "Drivers",
  "👑 = головний водій (теж може возити зміни)\n✅ = підключений до бота": "👑 = head driver (also drives shifts)\n✅ = connected to the bot",
  "❌ Ви не зареєстровані як водій.": "❌ You are not registered as a driver.",
  "Немає графіків.": "No schedules.",
  "Немає активного графіку.": "No active schedule.",
  "📭 На {day} у вас немає призначень.": "📭 You have no assignments on {day}.",
  "Поїздку розпочато!": "Trip started!",
  "Час:": "Time:",
  "Спізнення на збір (план {t})": "Late to pickup (planned {t})",
  "Вчасно на місці збору": "On time at the pickup point",
  "Прибуття зафіксовано!": "Arrival recorded!",
  "В дорозі:": "On the way:",
  "хв": "min",
  "Запізнення (план до {t})": "Late (planned by {t})",
  "Прибули вчасно": "Arrived on time",
  "Всі явки вже відмічені (або немає працівників для ваших змін).": "All attendance already marked (or no workers for your shifts).",
  "📭 На сьогодні у вас немає призначень.": "📭 You have no assignments today.",
  "⚠️ Оберіть хто *не прийшов* (натисніть ім'я щоб відмітити ❌):\n\nПотім натисніть «✅ Підтвердити»": "⚠️ Select who *didn't show up* (tap a name to mark ❌):\n\nThen press “✅ Confirm”.",
  "✅ Підтвердити відсутніх": "✅ Confirm absentees",
  "⚠️ Спочатку натисніть «🚌 Почати поїздку».": "⚠️ First press “🚌 Start trip”.",
  "Введіть ім'я або код позапланового працівника:": "Enter the name or code of the unplanned worker:",
  "Посадка": "Boarding",
  "Натискайте, хто сів у авто (⬜→✅). За потреби додайте людей. Коли всі сіли або час їхати — «Підтвердити посадку».": "Tap whoever got in the vehicle (⬜→✅). Add people if needed. When everyone is in or it's time to go — “Confirm boarding”.",
  "➕ Додати людину": "➕ Add a person",
  "✅ Підтвердити посадку": "✅ Confirm boarding",
  "❌ Скасувати": "❌ Cancel",
  "У вас немає призначень на сьогодні.": "You have no assignments today.",
  "фабрика": "factory",
  "Немає кого забирати — усіх уже забрали інші водії, або явку вже відмічено.": "No one to pick up — other drivers already took everyone, or attendance is already marked.",
  "Введіть ім'я або код працівника, якого додати в авто:": "Enter the name or code of the worker to add to the vehicle:",
  "Скасовано": "Cancelled",
  "❌ Посадку скасовано.": "❌ Boarding cancelled.",
  "Зберігаю...": "Saving...",
  "Посадку підтверджено": "Boarding confirmed",
  "Сіли в авто:": "Got in the vehicle:",
  "Не вийшли:": "No-shows:",
  "Залишено для інших водіїв:": "Left for other drivers:",
  "Час виїзду зафіксовано.": "Departure time recorded.",
  "Додано в авто:": "Added to the vehicle:",
  "(немає в базі)": "(not in the database)",
  "✅ *{name}* додано як позапланового.": "✅ *{name}* added as unplanned.",
  "Нікого не обрано.": "No one selected.",
  "Нікого не обрано": "No one selected",
  "✅ Відсутніх відмічено: {n}": "✅ Absentees marked: {n}",
  "Обрані відсутні:": "Selected absentees:",
  "Продовжуйте або натисніть «✅ Підтвердити відсутніх»": "Continue or press “✅ Confirm absentees”.",
  // head-driver assignment
  "Графік не знайдено.": "Schedule not found.",
  "Оберіть день:": "Choose a day:",
  "Оберіть день зі списку.": "Choose a day from the list.",
  "Оберіть зміну зі списку.": "Choose a shift from the list.",
  "Оберіть водія (✅ = вже призначений):": "Choose a driver (✅ = already assigned):",
  "Водія не знайдено. Оберіть зі списку.": "Driver not found. Choose from the list.",
  "➖ *{name}* знятий зі зміни.": "➖ *{name}* removed from the shift.",
  // views.ts
  "📭 На {day} немає змін у графіку.": "📭 No shifts in the schedule on {day}.",
  "ос.": "ppl",
  "оберіть зміну, щоб призначити водія\n(✅ = вже є водій):": "choose a shift to assign a driver\n(✅ = driver already set):",
  "Графік порожній.": "Schedule is empty.",
  "Графік": "Schedule",
  "Ваші зміни:": "Your shifts:",
  "Збір:": "Pickup:",
  "на фабриці до:": "at factory by:",
  "Меню:": "Menu:",
  "📭 На тиждень {week} немає призначень.": "📭 No assignments for week {week}.",
  "Ваш графік": "Your schedule",

  // ── admin top-level + management ──
  "Спочатку додайте фабрику через 👥 Управління → 🏭 Фабрики.": "First add a factory via 👥 Management → 🏭 Factories.",
  "Оберіть фабрику для замовлення:": "Choose a factory for the order:",
  "⏳ Зчитую Google Sheets...": "⏳ Reading Google Sheets...",
  "📭 Таблиця порожня або немає нових відповідей.": "📭 The spreadsheet is empty or has no new responses.",
  "Оберіть тиждень для синхронізації:": "Choose a week to sync:",
  "❌ Помилка читання таблиці. Перевірте що таблиця поділена з сервісним акаунтом.": "❌ Error reading the spreadsheet. Make sure it's shared with the service account.",
  "Спочатку додайте фабрику.": "Add a factory first.",
  "Для якої фабрики генерувати графік?": "Which factory to generate the schedule for?",
  "Графік якої фабрики переглянути?": "Which factory's schedule to view?",
  "Управління:": "Management:",
  "Розсилки": "Broadcasts",
  "Авто-нагадування: щонеділі о *{h}:00* (Київ)": "Auto-reminder: every Sunday at *{h}:00* (Kyiv)",
  "Введіть тиждень для нагадування (РРРР-ММ-ДД):": "Enter the week for the reminder (YYYY-MM-DD):",
  "Введіть годину нагадування (0–23, за Києвом):": "Enter the reminder hour (0–23, Kyiv time):",
  "⏳ Надсилаю тестові нагадування...": "⏳ Sending test reminders...",
  "✅ Тест завершено!\n📨 Надіслано: {n}\n⚠️ Пропущено: {s}": "✅ Test complete!\n📨 Sent: {n}\n⚠️ Skipped: {s}",
  "Оберіть тиждень для розсилки:": "Choose a week to send:",
  "📥 *Імпорт графіку з Excel*\n\nНадішніть Excel файл у форматі який генерує бот.\n\n*Очікуваний формат:*\n• Аркуш \"Загальний\" з колонками: ПІБ, Код, потім дні (Пн зм1, Пн зм2...)\n• Або будь-який аркуш з колонками: ПІБ | Код | Зміна | День\n\nБот визначить тиждень з назви файлу (формат: `Графік 2026.06.01.xlsx`)": "📥 *Import schedule from Excel*\n\nSend an Excel file in the format the bot generates.\n\n*Expected format:*\n• A \"General\" sheet with columns: Name, Code, then days (Mon sh1, Mon sh2...)\n• Or any sheet with columns: Name | Code | Shift | Day\n\nThe bot detects the week from the file name (format: `Графік 2026.06.01.xlsx`)",
  "Введіть повне ім'я працівника (Прізвище Ім'я):": "Enter the worker's full name (Surname Name):",
  "Введіть повне ім'я працівника:": "Enter the worker's full name:",
  "Введіть Telegram ID (або /skip):": "Enter Telegram ID (or /skip):",
  "Оберіть фабрику для *{name}*:": "Choose a factory for *{name}*:",
  "/skip — без фабрики": "/skip — no factory",
  "Введіть код працівника (тільки цифри) або /skip — автоматично:": "Enter the worker code (digits only) or /skip — auto:",
  "Показати працівників:": "Show workers:",
  "👥 Усі працівники": "👥 All workers",
  "📥 *Масовий імпорт працівників*\n\nНадішліть CSV або Excel (.xlsx) файл.\n\n*Формат CSV:*\n```\nПрізвище Ім'я,telegram_id,код\nІванов Іван,123456789,0001\nПетров Петро,,\n```\nКолонки telegram_id та код — необов'язкові. Перший рядок — заголовок (пропускається).": "📥 *Bulk worker import*\n\nSend a CSV or Excel (.xlsx) file.\n\n*CSV format:*\n```\nSurname Name,telegram_id,code\nIvanov Ivan,123456789,0001\nPetrov Petro,,\n```\nThe telegram_id and code columns are optional. The first row is a header (skipped).",
  "Введіть ім'я працівника для прив'язки:": "Enter the worker's name to link:",
  "Управління водіями:": "Driver management:",
  "Введіть ім'я водія:": "Enter the driver's name:",
  "Введіть ім'я водія для прив'язки:": "Enter the driver's name to link:",
  "Немає водіїв. Спочатку додайте водія.": "No drivers. Add a driver first.",
  "Оберіть водія, щоб отримати посилання-запрошення:": "Choose a driver to get an invite link:",
  "Оберіть головного водія:": "Choose the head driver:",
  "Управління фабриками:": "Factory management:",
  "Оберіть фабрику для налаштування часів змін:": "Choose a factory to set shift times:",
  "Оберіть фабрику для налаштування email клієнта:": "Choose a factory to set the client email:",
  "Введіть назву фабрики:": "Enter the factory name:",
  "Немає фабрик.": "No factories.",
  "Фабрики": "Factories",
  "Немає активних працівників.": "No active workers.",
  "Оберіть працівника для звільнення:": "Choose a worker to dismiss:",
  "Адміни": "Admins",
  "👑 = Головний адмін": "👑 = Head admin",
  "Управління адмінами:": "Admin management:",
  "Веб-панель — задайте собі логін/пароль:": "Web panel — set your login/password:",
  "🔐 *Веб-панель*\n\nВведіть бажаний *логін* (латиниця/цифри, без пробілів):": "🔐 *Web panel*\n\nEnter your desired *login* (latin letters/digits, no spaces):",
  "Введіть Telegram ID нового адміна.\n\nПопросіть людину надіслати /getid боту і передати вам число.": "Enter the new admin's Telegram ID.\n\nAsk the person to send /getid to the bot and give you the number.",
  "Немає інших адмінів для видалення.": "No other admins to remove.",
  "Оберіть адміна для видалення:": "Choose an admin to remove:",
  "⏳ Перевіряю папки на Google Drive...": "⏳ Checking Google Drive folders...",
  "☁️ *Google Drive*\n\n📁 Головна папка:\n{link}\n\nСтруктура:\n📂 Графіки — Excel графіків по тижнях\n📂 Облік годин — річний Excel з вкладками по місяцях\n📂 Поїздки водіїв — статистика водіїв\n📂 Рапорти — фото рапортів по фабриках та місяцях": "☁️ *Google Drive*\n\n📁 Main folder:\n{link}\n\nStructure:\n📂 Schedules — weekly schedule Excel files\n📂 Hours — yearly Excel with monthly tabs\n📂 Driver trips — driver statistics\n📂 Reports — report photos by factory and month",
  "❌ Помилка підключення до Google Drive. Перевірте налаштування сервісного акаунту.": "❌ Google Drive connection error. Check the service account settings.",

  // ── admin state handlers ──
  "Оберіть фабрику зі списку.": "Choose a factory from the list.",
  "Оберіть тиждень зі списку.": "Choose a week from the list.",
  "Зміна": "Shift",
  "не налаштовано": "not set",
  "⏰ *{name}* — Часи змін\n\nПоточні налаштування:\n{cur}\n\nВведіть час початку *Зміни 1* (формат HH:MM, наприклад `06:00`):\nАбо /skip щоб не змінювати": "⏰ *{name}* — Shift times\n\nCurrent settings:\n{cur}\n\nEnter the start time of *Shift 1* (format HH:MM, e.g. `06:00`):\nOr /skip to keep it",
  "Введіть час у форматі HH:MM (наприклад `06:00`) або /skip:": "Enter time in HH:MM format (e.g. `06:00`) or /skip:",
  "✅ Зміна {prev} збережена.\n\nВведіть час початку *Зміни {n}* (HH:MM або /skip):": "✅ Shift {prev} saved.\n\nEnter the start time of *Shift {n}* (HH:MM or /skip):",
  "✅ *{name}* — часи змін збережено!\n\n{list}\n\n🔔 Нагадування будуть надсилатися за 2 години до початку кожної зміни.\n\nℹ️ Для гнучкого налаштування (до 6 змін, точний кінець) скористайтесь веб-панеллю.": "✅ *{name}* — shift times saved!\n\n{list}\n\n🔔 Reminders are sent 2 hours before each shift starts.\n\nℹ️ For flexible setup (up to 6 shifts, exact end) use the web panel.",
  "📧 *{name}*\nПоточний email: {email}\n\nВведіть email клієнта (куди слати графік) або /clear щоб прибрати:": "📧 *{name}*\nCurrent email: {email}\n\nEnter the client email (where to send the schedule) or /clear to remove:",
  "не вказано": "not set",
  "✅ Email для *{name}* прибрано.": "✅ Email for *{name}* removed.",
  "❌ Невірний формат email. Введіть ще раз або /clear:": "❌ Invalid email format. Try again or /clear:",
  "✅ Email клієнта для *{name}* збережено:\n{email}\n\nПісля затвердження графіку лист надсилатиметься автоматично.": "✅ Client email for *{name}* saved:\n{email}\n\nThe email will be sent automatically after the schedule is approved.",
  "❌ Telegram ID має містити тільки цифри. Введіть ще раз:": "❌ Telegram ID must contain digits only. Try again:",
  "⚠️ Цей Telegram ID вже є адміном (*{name}*).": "⚠️ This Telegram ID is already an admin (*{name}*).",
  "✅ *{name}* (`{id}`) додано як адміна.": "✅ *{name}* (`{id}`) added as an admin.",
  "❌ Логін: 3–32 символи, лише латиниця/цифри/_.- — введіть ще раз:": "❌ Login: 3–32 chars, latin letters/digits/_.- only — try again:",
  "❌ Такий логін уже зайнятий. Введіть інший:": "❌ That login is already taken. Enter another:",
  "Тепер введіть *пароль* (мінімум 8 символів):": "Now enter a *password* (at least 8 characters):",
  "❌ Пароль закороткий (мінімум 8 символів). Введіть ще раз:": "❌ Password too short (at least 8 characters). Try again:",
  "(адреса панелі)": "(panel address)",
  "✅ Веб-доступ налаштовано!\n\n👤 Логін: <code>{user}</code>\n🔗 Панель: {url}\n\n(пароль збережено, повідомлення з ним видалено)": "✅ Web access set up!\n\n👤 Login: <code>{user}</code>\n🔗 Panel: {url}\n\n(password saved, the message with it was deleted)",
  "Оберіть зі списку.": "Choose from the list.",
  "✅ *{name}* видалений(-а) з адмінів.": "✅ *{name}* removed from admins.",
  "Усі": "All",
  "Фабрику не знайдено.": "Factory not found.",
  "Немає активних працівників ({label}).": "No active workers ({label}).",
  "👷 *Працівники — {label} ({n})*:\n\n{list}\n\n✅ = Telegram прив'язаний  ⚠️ = не прив'язаний": "👷 *Workers — {label} ({n})*:\n\n{list}\n\n✅ = Telegram linked  ⚠️ = not linked",
  "Оберіть фабрику зі списку або /skip:": "Choose a factory from the list or /skip:",
  "❌ Код має містити тільки цифри. Введіть ще раз або /skip:": "❌ Code must contain digits only. Try again or /skip:",
  "❌ Код `{code}` вже зайнятий. Введіть інший або /skip:": "❌ Code `{code}` is taken. Enter another or /skip:",
  "✅ Працівник <b>{name}</b> доданий!\n🔑 Код: <code>{code}</code>\n🏭 Фабрика: {factory}": "✅ Worker <b>{name}</b> added!\n🔑 Code: <code>{code}</code>\n🏭 Factory: {factory}",
  "📎 Посилання (натисніть щоб скопіювати):": "📎 Link (tap to copy):",
  "Введіть номер авто (або /skip):": "Enter the vehicle number (or /skip):",
  "✅ Водій <b>{name}</b> доданий!": "✅ Driver <b>{name}</b> added!",
  "Авто:": "Vehicle:",
  "📎 Посилання-запрошення (натисніть щоб скопіювати):": "📎 Invite link (tap to copy):",
  "Надішліть його водію — він натисне і автоматично підключиться до бота.": "Send it to the driver — they'll tap it and connect to the bot automatically.",
  "Оберіть водія зі списку.": "Choose a driver from the list.",
  "✅ вже підключений до бота": "✅ already connected to the bot",
  "⚠️ ще не підключений": "⚠️ not connected yet",
  "Введіть адресу (або /skip):": "Enter the address (or /skip):",
  "✅ Фабрика *{name}* додана!": "✅ Factory *{name}* added!",
  "Попросіть {who} надіслати /getid боту.\nПотім вставте їх Telegram ID сюди:": "Ask the {who} to send /getid to the bot.\nThen paste their Telegram ID here:",
  "працівника": "worker",
  "водія": "driver",
  "Працівника не знайдено.": "Worker not found.",
  "✅ *{name}* прив'язаний до Telegram `{id}`": "✅ *{name}* linked to Telegram `{id}`",
  "✅ *{name}* призначений головним водієм!": "✅ *{name}* set as the head driver!",
  "Фабрика: *{name}*\nОберіть тиждень:": "Factory: *{name}*\nChoose a week:",
  "Поточний тиждень": "Current week",
  "Наступний тиждень": "Next week",
  "Завантажую дошку замовлення...": "Loading the order board...",
  "Введіть 3 числа через пробіл (1зм 2зм 3зм), напр. `8 12 5`": "Enter 3 numbers separated by spaces (sh1 sh2 sh3), e.g. `8 12 5`",
  "Введіть 3 числа через пробіл, напр. `8 12 5`": "Enter 3 numbers separated by spaces, e.g. `8 12 5`",
  "⏳ Синхронізую тиждень {week}...": "⏳ Syncing week {week}...",
  "✅ Синхронізовано! *{n}* записів для тижня {week}": "✅ Synced! *{n}* records for week {week}",
  "Автоматично додано ({n}):": "Automatically added ({n}):",
  "Не заповнили ({n}):": "Didn't submit ({n}):",
  "🎉 Всі заповнили анкету!": "🎉 Everyone submitted!",
  "Що далі?": "What's next?",
  "❌ Помилка синхронізації.": "❌ Sync error.",
  "Фабрика: *{name}*\nДля якого тижня?": "Factory: *{name}*\nFor which week?",
  "Поточний": "Current",
  "Наступний": "Next",
  "Перевірка перед генерацією": "Pre-generation check",
  "Тиждень:": "Week:",
  "Замовлено змін:": "Shifts ordered:",
  "днів із замовленням:": "days with an order:",
  "Заповнили доступність:": "Submitted availability:",
  "осіб": "people",
  "слотів": "slots",
  "⚠️ Немає замовлень — спочатку заповніть \"📋 Замовлення фабрик\".": "⚠️ No orders — first fill in \"📋 Factory orders\".",
  "⚠️ Ніхто не заповнив доступність — графік буде порожній.\nВсе одно генерувати?": "⚠️ No one submitted availability — the schedule will be empty.\nGenerate anyway?",
  "⚠️ Доступних слотів ({a}) менше за замовлені ({b}) — буде нестача.\nГенерувати?": "⚠️ Available slots ({a}) are fewer than ordered ({b}) — there will be a shortage.\nGenerate?",
  "✅ Людей достатньо. Генерувати?": "✅ Enough people. Generate?",
  "✅ Генерувати": "✅ Generate",
  "⏳ Генерую графік для тижня {week}{label}...": "⏳ Generating the schedule for week {week}{label}...",
  "Чернетка готова!": "Draft ready!",
  "Призначено:": "Assigned:",
  "змін": "shifts",
  "Нестача людей:": "Staff shortage:",
  "потрібно": "needed",
  "є": "have",
  "бракує": "short",
  "✅ Всі замовлення виконані!": "✅ All orders fulfilled!",
  "Перегляньте через \"✅ Перегляд графіків\"": "Review it via \"✅ Review schedules\"",
  "⏳ Розсилаю...": "⏳ Sending...",
  "📢 Розіслано!\n👷 Працівники: {n} / пропущено: {s}\n🚐 Головний водій: {hd}": "📢 Sent!\n👷 Workers: {n} / skipped: {s}\n🚐 Head driver: {hd}",
  "⏳ Перевіряю хто не заповнив...": "⏳ Checking who hasn't submitted...",
  "🎉 Всі заповнили!": "🎉 Everyone submitted!",
  "📨 Готово!\n✅ {n} повідомлень\n⚠️ {s} без Telegram": "📨 Done!\n✅ {n} messages\n⚠️ {s} without Telegram",
  "Введіть число від 0 до 23:": "Enter a number from 0 to 23:",
  "✅ Нагадування налаштовано на *{h}:00* щонеділі!": "✅ Reminder set for *{h}:00* every Sunday!",
  "Оберіть працівника зі списку.": "Choose a worker from the list.",
  "⚠️ Дійсно звільнити *{name}*?": "⚠️ Really dismiss *{name}*?",
  "✅ Так, звільнити": "✅ Yes, dismiss",
  "✅ *{name}* звільнений(-а).": "✅ *{name}* dismissed.",

  // ── view / approve schedule ──
  "Для *{name}* немає графіків чи замовлень.": "No schedules or orders for *{name}*.",
  "Затверджено": "Approved",
  "Чернетка": "Draft",
  "Лише замовлення": "Orders only",
  "Для тижня {week} ще немає згенерованого графіку.\nЗгенеруйте через \"🗓 Генерувати графік\".": "No generated schedule for week {week} yet.\nGenerate it via \"🗓 Generate schedule\".",
  "Що робити з цим графіком?": "What to do with this schedule?",
  "✏️ Редагувати графік": "✏️ Edit schedule",
  "✅ Затвердити графік": "✅ Approve schedule",
  "🔄 Перегенерувати": "🔄 Regenerate",
  "Графік затверджений. Можна редагувати:": "Schedule approved. You can edit it:",
  "✅ Графік на {week} затверджено!\n\n⏳ Зберігаю на Google Drive...": "✅ Schedule for {week} approved!\n\n⏳ Saving to Google Drive...",
  "Збережено:": "Saved:",
  "Розсилка клієнтам:": "Sent to clients:",
  "Тепер розішліть працівникам через \"📢 Розсилки → Розіслати затверджений графік\"": "Now send it to workers via \"📢 Broadcasts → Send the approved schedule\"",
  "⚠️ *Увага!*\nПерегенерація *{name}* видалить поточні {n} призначень (разом із будь-якими ручними правками) і збере графік заново з доступності.\n\nПродовжити?": "⚠️ *Warning!*\nRegenerating *{name}* will delete the current {n} assignments (including any manual edits) and rebuild the schedule from availability.\n\nContinue?",
  "✅ Так, перегенерувати": "✅ Yes, regenerate",
  "⏳ Перегенерую графік для *{name}*...": "⏳ Regenerating the schedule for *{name}*...",
  "✅ Перегенеровано! Призначено: {n}": "✅ Regenerated! Assigned: {n}",
  "Не вистачає людей:": "Not enough people:",
  // @bot-en-append
};

export function tb(lang: Lang, uk: string, params?: Record<string, string | number>): string {
  let s = lang === "en" ? (BOT_EN[uk] ?? uk) : uk;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// All language variants of a uk button string — for bot.hears triggers.
export function bhears(uk: string): string[] {
  return [...new Set([uk, BOT_EN[uk] ?? uk])];
}

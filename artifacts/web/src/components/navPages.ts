// Список сторінок панелі (href → назва з меню) для віджета зголошень: «про цю сторінку» і
// вибір «інша сторінка». Окремо від Layout.tsx, щоб віджет не імпортував Layout (цикл).
// Тримати синхронно з NAV у Layout.tsx.
export const NAV_PAGES: { href: string; label: string }[] = [
  { href: "/", label: "Огляд" }, { href: "/tasks", label: "Задачі" },
  { href: "/schedule", label: "Графіки" }, { href: "/driver-shifts", label: "Призначення водіїв" }, { href: "/orders", label: "Замовлення" }, { href: "/availability", label: "Доступність" },
  { href: "/workers", label: "Працівники" }, { href: "/workers-calendar", label: "Календар працівників" }, { href: "/contracts", label: "Документи й умови" }, { href: "/legalization", label: "Легалізація" },
  { href: "/document-templates", label: "Шаблони документів" }, { href: "/drivers", label: "Водії" }, { href: "/fleet", label: "Автопарк" }, { href: "/transport", label: "Транспорт" }, { href: "/clothing", label: "Одяг" },
  { href: "/recruitment", label: "Рекрутація" }, { href: "/signup-links", label: "Лінки реєстрації" }, { href: "/broadcast", label: "Розсилка" }, { href: "/sms-campaigns", label: "SMS-кампанії" },
  { href: "/reliability", label: "Надійність" }, { href: "/hours", label: "Облік годин" }, { href: "/absences", label: "Відсутності" }, { href: "/advances", label: "Аванси" }, { href: "/trips", label: "Поїздки" }, { href: "/mileage", label: "Звіт по пробігу" }, { href: "/reports", label: "Звіти / Drive" },
  { href: "/finance", label: "Фінанси" }, { href: "/bank", label: "Витяги" }, { href: "/cash", label: "Каса" }, { href: "/cashflow", label: "Кешфлоу" }, { href: "/cfo", label: "CFO" }, { href: "/analytics", label: "Аналітика" }, { href: "/balance", label: "Баланс" },
  { href: "/cost-invoices", label: "Фактури" }, { href: "/pnl", label: "P&L" }, { href: "/payroll", label: "Зарплати" }, { href: "/svodni", label: "Сводні" }, { href: "/hostels", label: "Хостели" }, { href: "/penalties", label: "Штрафи" }, { href: "/fuel", label: "Пальне" },
  { href: "/sushi", label: "Суші" }, { href: "/andros", label: "Андрос" }, { href: "/cleaning", label: "Прибирання" },
  { href: "/settings", label: "Налаштування" }, { href: "/admins", label: "Користувачі та запрошення" }, { href: "/security", label: "Безпека / Сесії" }, { href: "/feedback", label: "Зголошення" },
];

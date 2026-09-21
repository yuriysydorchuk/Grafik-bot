// Каталог розділів і дій панелі для загального пошуку (Ctrl+K): «де це?» — знайти сторінку,
// вкладку налаштувань чи конкретну можливість за словами (рішення власника 21.09.2026).
// Доступ: сторінка — canAccessPage; вкладки/дії з капою — show(me). Ключові слова — укр/pl/en
// синоніми, які люди реально набирають. Дії ведуть на сторінку, де кнопка живе (?tab= для налаштувань).
import { canAccessPage, can, type Capability } from "./roles";
import type { Me } from "./api";

export interface CatalogEntry { label: string; href: string; keywords: string; kind: "section" | "action"; cap?: Capability; mainOnly?: boolean }

const S = (label: string, href: string, keywords: string): CatalogEntry => ({ label, href, keywords, kind: "section" });
const A = (label: string, href: string, keywords: string, cap?: Capability): CatalogEntry => ({ label, href, keywords, kind: "action", cap });

export const SEARCH_CATALOG: CatalogEntry[] = [
  // розділи
  S("Огляд", "/", "дашборд головна overview"),
  S("Задачі", "/tasks", "мій день задача todo нагадування дайджест"),
  S("Графіки", "/schedule", "графік зміни тиждень розклад schedule grafik розіслати згенерувати"),
  S("Призначення водіїв", "/driver-shifts", "водії довіз посадка забір борд driver board"),
  S("Замовлення", "/orders", "замовлення фабрик потреба людей zamówienie orders"),
  S("Доступність", "/availability", "доступність диспозиція dyspo dyspozycyjność sheets"),
  S("Працівники", "/workers", "працівник профіль список pracownicy workers"),
  S("Календар працівників", "/workers-calendar", "календар строки документів дні народження перший робочий день останній день звільнення"),
  S("Документи й умови", "/contracts", "умова umowa zlecenie підпис пакет документи інбокс"),
  S("Легалізація", "/legalization", "легалізація дашборд karta pobytu powiadomienie zezwolenie статус для виплат"),
  S("Шаблони документів", "/document-templates", "шаблон документ zaświadczenie wypowiedzenie aneks ZCNA"),
  S("Водії", "/drivers", "водій kierowca drivers авто"),
  S("Автопарк", "/fleet", "автопарк авто страховка техогляд ремонт flota"),
  S("Транспорт", "/transport", "транспорт зняття за довіз ставки водій×фабрика виїзди"),
  S("Одяг", "/clothing", "одяг спецодяг склад видача"),
  S("Рекрутація", "/recruitment", "рекрутація кандидати воронка канбан приведи друга referral"),
  S("Розсилка", "/broadcast", "розсилка повідомлення бот кампанія"),
  S("Надійність", "/reliability", "надійність явка пропуски рейтинг"),
  S("Облік годин", "/hours", "години рапорт імпорт годин фабрики zestawienie godzin ewidencja"),
  S("Відсутності", "/absences", "пропуски відсутності штраф виправдати нез'явлення відпрошування"),
  S("Аванси", "/advances", "аванс залічка zaliczka бадання виплата 15 30"),
  S("Поїздки", "/trips", "поїздки водіїв запізнення"),
  S("Звіт по пробігу", "/mileage", "пробіг одометр км"),
  S("Звіти / Drive", "/reports", "звіти google drive excel експорт"),
  S("Фінанси", "/finance", "фінанси огляд"),
  S("Витяги", "/bank", "витяги банк mt940 транзакції класифікація"),
  S("Каса", "/cash", "каса готівка ящик"),
  S("Кешфлоу", "/cashflow", "кешфлоу рух грошей"),
  S("CFO", "/cfo", "cfo звіт фінансовий"),
  S("Аналітика", "/analytics", "аналітика графіки"),
  S("Баланс", "/balance", "баланс активи"),
  S("Фактури", "/cost-invoices", "фактури ksef faktura витрати категорії"),
  S("P&L", "/pnl", "p&l прибуток збиток маржа"),
  S("Зарплати", "/payroll", "зарплати виплати lista płac"),
  S("Сводні", "/svodni", "сводна вкладка фабрики konto готівка gratyfikant лок"),
  S("Хостели", "/hostels", "хостел житло мешканці шахматка платежі"),
  S("Штрафи", "/penalties", "штрафи kara реєстр"),
  S("Пальне", "/fuel", "пальне заправки"),
  S("Суші", "/sushi", "sushi проєкт"),
  S("Андрос", "/andros", "andros проєкт"),
  S("Прибирання", "/cleaning", "прибирання вспульноти клінінг"),
  S("Налаштування", "/settings", "налаштування settings"),
  S("Фабрики", "/factories", "фабрики клієнти ставки email клієнта зміни"),
  { label: "Користувачі та ролі", href: "/admins", keywords: "користувачі ролі адміни доступи права", kind: "section", mainOnly: true },
  { label: "Безпека / Сесії", href: "/security", keywords: "безпека сесії входи логіни ip", kind: "section", mainOnly: true },
  // вкладки налаштувань
  A("Налаштування → Фінанси / ставки", "/settings?tab=general", "ставки дефолтна ставка фінанси налаштування", "viewFinance"),
  A("Налаштування → Фірми", "/settings?tab=companies", "фірми компанії реквізити nip", "editData"),
  A("Налаштування → Посади", "/settings?tab=positions", "посади стать закріплена зміна", "editData"),
  A("Налаштування → Документи", "/settings?tab=documents", "типи документів каталог self-service", "editData"),
  A("Налаштування → Правила легальності", "/settings?tab=legalRules", "правила легальності lead days строки жовта червона зона", "legalization"),
  A("Налаштування → Задачі", "/settings?tab=tasks", "автоправила задач дайджест нагадування"),
  A("Налаштування → Воронки рекрутації", "/settings?tab=funnels", "воронки етапи рекрутації", "editData"),
  A("Налаштування → Email-шаблони", "/settings?tab=email", "email шаблони листи клієнту", "editData"),
  A("Налаштування → Gratyfikant", "/settings?tab=gratyfikant", "gratyfikant nexo знімок умов імпорт", "svodniSensitive"),
  // дії / можливості
  A("Додати працівника (скан паспорта)", "/workers", "додати працівника новий скан паспорта", "editData"),
  A("Згенерувати графік", "/schedule", "згенерувати графік генерація доповнити augment"),
  A("Розіслати графік працівникам", "/schedule", "розіслати графік повідомити sent"),
  A("Excel графіку / email клієнту", "/schedule", "excel графіку відправити клієнту email затвердити"),
  A("Нагадати про доступність", "/availability", "нагадати доступність розсилка нагадування"),
  A("Імпорт годин фабрики", "/hours", "імпорт годин excel фабрики factory-apply ключі фабрики"),
  A("Нагадати про рапорт", "/hours", "нагадати рапорт години працівникам"),
  A("Zestawienie godzin клієнту", "/hours", "zestawienie годин клієнту лист email розбіжності"),
  A("Нагадати про невиправдані пропуски", "/absences", "нагадати пропуски невиправдані пояснення файл"),
  A("Написати працівнику щодо пропуску", "/absences", "написати працівнику пропуск відповідь бот"),
  A("Штрафи за пропуски → сводна", "/absences", "перенести штрафи kara сводна", "svodni"),
  A("Ліста залічок до Gratyfikanta", "/advances", "gratyfikant ліста залічок аванси експорт", "svodniSensitive"),
  A("Подати залічку", "/advances", "подати аванс залічка запит"),
  A("У сводну з обліку годин", "/svodni", "у сводну from-hours перенести години", "svodni"),
  A("Gratyfikant ліста зі сводної", "/svodni", "gratyfikant ліста сводна експорт nexo", "svodniSensitive"),
  A("Кампанія «приведи друга»", "/recruitment", "приведи друга реферал кампанія бонус"),
  A("Скан karta pobytu", "/workers", "скан карта побиту karta pobytu ocr", "workerDocs"),
  A("Запросити анкету / скан у працівника", "/workers", "анкета запросити скан лінк бот", "workerDocs"),
  A("Витяги: синк із Drive", "/bank", "синк витягів drive mt940", "viewFinance"),
  A("Фактури: синк KSeF", "/cost-invoices", "ksef синк фактури", "viewFinance"),
];

export function catalogFor(me: Me | undefined, q: string, match: (q: string, ...f: (string | null | undefined)[]) => boolean): CatalogEntry[] {
  if (!me) return [];
  return SEARCH_CATALOG.filter(e => {
    const page = e.href.split("?")[0]!;
    if (e.mainOnly && !me.isMain) return false;
    if (!canAccessPage(me, page)) return false;
    if (e.cap && !can(me, e.cap)) return false;
    return match(q, e.label, e.keywords);
  }).slice(0, 8);
}

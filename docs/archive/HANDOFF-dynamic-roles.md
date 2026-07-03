# Handoff — динамічні ролі з налаштовуваними доступами

Задача завершена й **задеплоєна на прод** (commit `fcb53ca`).

---

## Що зроблено

Ролі веб-панелі переїхали з хардкоду `owner|scheduler|driver` у БД-таблицю `roles`. Головний адмін (`is_main`) у **Налаштування → «Користувачі та ролі» → блок «Ролі та доступи»** може створювати/редагувати/видаляти ролі й перемикати їхні **сторінки** (нав/доступ) і **дії** (capabilities). Лише головний адмін — усе під `requireMainAdmin`.

**Каталог дій (capabilities, фіксований у коді):** `editData` (операційні правки), `viewFinance` (фінанси), `assignDrivers` (водійські дії), `deleteWorkers` (видалення працівників). **Сторінки** — 18 ключів (`PAGE_KEYS`).

**Системні ролі:** `owner` — незмінний суперюзер (у коді завжди повний доступ, редагування/видалення заблоковано); `scheduler`/`driver` — редаговані, але не видаляються. Кастомні — повністю CRUD.

---

## Файли (commit fcb53ca)

| Файл | Зміна |
|------|-------|
| `lib/db/src/schema/workers.ts` | нова `rolesTable` (`key, label, is_system, pages jsonb, caps jsonb, sort_order`) |
| `api-server/src/lib/roles.ts` | каталоги `CAP_KEYS`/`CAP_LABEL`/`PAGE_KEYS` + `hasCap()`; `Role = string`; `OWNER` |
| `api-server/src/lib/auth.ts` | кеш ролей (`loadRolesCache`/`invalidateRolesCache`), `resolveAccess`, `req.admin.{caps,pages}`, `requireCap()` |
| `api-server/src/routes/admin-api.ts` | `GET/POST/PATCH/DELETE /roles` (is_main); `requireRole`→`requireCap`; інлайн owner-фінчеки→`canFinance()`; валідація ролі через БД |
| `api-server/src/routes/auth.ts` | `/auth/me` віддає `roleLabel`, `caps`, `pages` |
| `web/src/lib/roles.ts` | каталоги + `can(me,cap)`/`canAccessPage(me,path)` з `me.caps`/`me.pages` |
| `web/src/lib/api.ts` | `Me` += `roleLabel,caps,pages`; новий `RoleDef` |
| `web/src/{App,components/Layout,pages/Dashboard,pages/Schedule,pages/Settings}.tsx` | виклики авторизації на нову сигнатуру; Settings-таби за caps/isMain |
| `web/src/pages/Admins.tsx` | дропдаун ролей з `GET /roles`; компонент `RolesManager` + `RoleEditor` (чекбокси сторінок/дій) |
| `web/src/lib/i18n.tsx` | EN-переклади |

**Міграція (накатано на проді й локально):** `CREATE TABLE roles (...)` + сід 3 системних ролей (owner/scheduler/driver). Точний SQL — в історії цієї сесії / повторюваний (idempotent, `ON CONFLICT (key) DO NOTHING`).

---

## Що знати наступній сесії

- **Деплой зроблено** через `ssh grafik`: pull → CREATE TABLE+seed → `bash deploy/build.sh`. **Порядок критичний:** таблиця `roles` має існувати ДО рестарту (новий код читає її щозапиту через `resolveAccess`; без таблиці — 500 на всьому API).
- **owner не можна відрізати:** у `hasCap`/`resolveAccess`/`canAccessPage` owner завжди = повний доступ, незалежно від рядка в БД. Усі мутації ролей/користувачів — лише `is_main`.
- **Кеш ролей** у `auth.ts` інвалідовується на кожній мутації `/roles`. `authRequired` щозапиту перечитує роль адміна з БД і резолвить доступ із кешу.
- **Кирилична назва ролі** → `slugify` дає порожній ключ → бекенд авто-генерує `role-<rand>` (ключ внутрішній, показується `label`).
- **Смоук-тест (пройдено):** owner=повний; scheduler→403 на `/finance`,`/roles`,`delete /workers`, але 200 на `/workers`; CRUD ролей + блок видалення системних/owner-edit.
- ⚠️ **`CLAUDE.md` → розділ «Ролі та доступи» застарів** (описує хардкод owner|scheduler|driver + дубльовану мапу). Варто оновити під БД-модель. Я не чіпав без запиту.
- Два боти різні токени (локальний тест ≠ прод) — 409 нема.

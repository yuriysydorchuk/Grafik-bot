# Handoff — аванси (запит через бота → облік на сайті → статус)

Задача завершена й **задеплоєна на прод** (commit `7a0fb15`).

---

## Що зроблено

Працівник просить аванс через бота й бачить статуси; офіс розглядає на сайті.

- **Бот (працівник):** кнопка **«💰 Аванс»** у `workerMenu` → показує останні запити зі статусами + inline «➕ Попросити аванс» → діалог «сума → коментар (опц., «-» щоб пропустити)» → запис `pending`.
- **Сповіщення:** адмінам — Telegram з inline **Підтвердити / Відхилити / Виплачено** + дзвіночок (`notifyRoles type:"advance"`); працівнику — DM 5 мовами при зміні статусу (`notifyWorkerAdvance`).
- **Сайт:** нова сторінка **«Аванси»** (`/advances`, у групі обліку) — секція «на розгляді» (Затвердити/Відхилити), таблиця всіх зі статус-бейджами, фільтр, підсумки сум, кнопка «Виплачено» для затверджених.
- **Статуси:** `pending → approved → paid` або `pending → rejected`. «Виплачено» лише після «затверджено» (гард в API і в боті).

---

## Файли (commit 7a0fb15)

| Файл | Зміна |
|------|-------|
| `lib/db/src/schema/workers.ts` | `advanceRequestsTable` (`amount real, comment, status, adminNote, decidedBy/At, paidAt`) |
| `api-server/src/routes/admin-api.ts` | `GET /advances` + `POST /advances/:id/{approve,reject,paid}` під `RW` (=`editData`); `decideAdvance()` гард paid-after-approved |
| `api-server/src/bot/notify.ts` | `notifyWorkerAdvance(workerId,status,amount)`; `notifyRoles` type += `"advance"` |
| `api-server/src/bot/i18n.ts` | `menu.advance`, `adv.*`, `notif.adv*` (5 мов). **Приклад суми — 200 zł** |
| `api-server/src/bot/menus.ts` | кнопка `menu.advance` у `workerMenu` |
| `api-server/src/bot/index.ts` | hears `menu.advance`, action `adv:new`, текст-гілки `advance:enter_amount/_comment`, admin action `adv_(approve|reject|paid)_<id>` |
| `api-server/src/lib/roles.ts` + `web/src/lib/roles.ts` | `/advances` у каталог сторінок |
| `web/src/pages/Advances.tsx` | нова сторінка |
| `web/src/{App,components/Layout,lib/api,lib/i18n}.tsx` | маршрут, нав-пункт (icon HandCoins), тип `AdvanceRequest`, переклади |

**Міграція (накатано на проді й локально):**
```sql
CREATE TABLE advance_requests (...);
UPDATE roles SET pages = pages || '["/advances"]'::jsonb WHERE key='scheduler' AND NOT (pages ? '/advances');
```

---

## Що знати наступній сесії

- **Деплой зроблено** через `ssh grafik`: pull → CREATE TABLE + UPDATE roles → `bash deploy/build.sh`. Перевірено: `/healthz` 200, `GET /api/advances` → 200 `[]`, бот polling, pm2 стабільний.
- **Доступ:** вкладка/API під `editData` (owner + scheduler + будь-яка роль із цією дією). `owner` бачить як суперюзер; `scheduler` — додано `/advances` у сторінки. Кастомним ролям головний адмін вмикає сторінку `/advances` у редакторі ролей.
- **Сума** зберігається `real` (zł). Приклад у тексті бота — 200.
- **Worker DM при зміні статусу** — best-effort (якщо немає telegramId, тихо пропускається).
- Два боти різні токени (локальний тест ≠ прод) — 409 нема.

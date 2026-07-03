# Handoff — кнопки бота працівника за налаштуваннями фабрики

Задача завершена й **задеплоєна на прод** (commit `fd0e0de`).

---

## Що зроблено

Меню Telegram-бота працівника тепер обрізається під налаштування його фабрики — зайвих кнопок нема:

1. **Заповнення графіку** — кнопка `📋 Заповнити доступність` показується лише коли фабрика в режимі «Працівники заповнюють доступність» (`usesAvailability` = `genMode === 'availability'`). Окремого тумблера не додавали — це вже керується селектом «Режим графіку».
2. **Доїзд/транспорт** — нове поле `factories.uses_transport`. Коли вимкнено, екран `🏭 Інфо по фабриці` **не показує блок зупинок** (сама кнопка лишається — там адреса й час змін). Рішення власника: ховати саме зупинки, не кнопку.
3. **Перегляд годин** — нове поле `factories.show_worker_hours`. Коли вимкнено, кнопка `🕒 Мої години та зміни` зникає з меню.

Обидва нові тумблери — у модалці фабрики (веб), блок **«Що бачить працівник у боті»**. Дефолт обох — `true` (наявні фабрики поведінки не міняють).

---

## Які файли змінено (commit fd0e0de)

| Файл | Зміна |
|------|-------|
| `lib/db/src/schema/workers.ts` | `factories.uses_transport`, `factories.show_worker_hours` (boolean, default true) |
| `artifacts/api-server/src/routes/admin-api.ts` | POST/PATCH `/factories` приймають нові поля |
| `artifacts/api-server/src/bot/menus.ts` | `workerMenu(lang, {availability, hours})` — умовні рядки |
| `artifacts/api-server/src/bot/index.ts` | хелпер `workerMenuFor(worker, lang)` (тягне прапори фабрики); усі воркер-контекстні виклики меню переведені на нього; зупинки в «Інфо» за `usesTransport` |
| `artifacts/web/src/lib/api.ts` | тип `Factory` + 2 поля |
| `artifacts/web/src/pages/Factories.tsx` | блок «Що бачить працівник у боті» (2 чекбокси) |
| `artifacts/web/src/lib/i18n.tsx` | EN-переклади нових рядків |

**Міграція БД (накатано на проді):**
```sql
ALTER TABLE factories ADD COLUMN IF NOT EXISTS uses_transport boolean NOT NULL DEFAULT true;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS show_worker_hours boolean NOT NULL DEFAULT true;
```

---

## Що потрібно знати наступній сесії

- **Деплой зроблено повністю** (Claude через `ssh grafik`): `git pull` → ALTER TABLE ×2 → `bash deploy/build.sh` → pm2 restart+save. Перевірено: pm2 online, `/healthz`=200, бот у polling.
- **Клавіатура в Telegram оновлюється лише при новому повідомленні з reply-keyboard** — працівник має натиснути `/start` або `⬅️ Назад`, щоб побачити оновлене меню після зміни тумблерів.
- **`workerMenuFor(worker, lang)`** робить 1 запит до `factories` за прапорами. Якщо в працівника нема `factoryId` — повертає повне меню. Усі нові реплаї воркер-контексту мають іти через нього (не через голий `workerMenu`), інакше сховані кнопки «повертаються».
- **⚠️ Латентна проблема на проді:** у `pnpm-workspace.yaml` на сервері є локальна (незакомічена) правка з невалідним placeholder:
  ```yaml
  allowBuilds:
    esbuild: set this to true or false
  ```
  Зараз `pnpm install` її стерпів (білд пройшов), але це сміття треба прибрати/допилити. Claude її **не чіпав**. Дублюй з власником, що там малося на увазі.
- **Два боти, різні токени** (локальний тест ≠ прод) — конфлікту 409 нема, локальний інстанс зупиняти не треба.

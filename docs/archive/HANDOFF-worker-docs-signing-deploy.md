# HANDOFF: деплой гілки `feature/worker-docs-signing` (підготовлено 10.09.2026)

Тимчасова записка: виконуваний порядок деплою великого батчу (підпис документів, легалізація,
задачі/календар, життєвий цикл працівника, повернення звільненого). Довговічні правила вже
перенесені в `docs/infrastructure/DEPLOYMENT.md` і `CLAUDE.md`. Після деплою — в архів.

## Що перевірено локально перед деплоєм

- Гілка містить увесь `origin/main` (прод стоїть на `8a1b671`, він у гілці; behind = 0).
- Сухий прогін **усіх** міграцій гілки на копії прод-дампу від 02.09 (`pg_restore` → `psql -f`
  за алфавітом): 40 файлів, 0 помилок. Два файли перейменовано, щоб алфавіт відповідав
  залежностям (`2026-09-04-worker-factories-contract-axis.sql`, `2026-09-06-tasks-module.sql`).
- Повний тестовий прогін на чистій базі (schema.sql + міграції за алфавітом): 736/736.
- `tsc` по lib/db, api-server, web — чисто; збірка api (esbuild) і web (vite) — ок.
- Друга думка (`codex exec --sandbox read-only`, `agy --mode plan`) по 4 diff-ах:
  умови/підпис, легалізація, задачі, життєвий цикл — результати й що підтвердилось: див. розділ
  «Ревʼю» нижче.

## Порядок деплою (крок за кроком)

0. **Бекап** перед усім: `ssh grafik /root/grafik-bot/deploy/backup.sh` (дамп БД + uploads).

1. **Злиття в main і пуш** (локально):
   ```bash
   git checkout main && git merge --ff-only feature/worker-docs-signing && git push origin main
   ```
   Якщо ff-only не проходить — гілка відстала від main, спершу `git merge main` у гілці.

2. **Код на сервер.** Штатно — `git pull` (див. DEPLOYMENT.md). Якщо GitHub знову відбиває
   анонімний HTTPS-pull (401, з 02.09) — bundle по ssh:
   ```bash
   git bundle create /tmp/grafik.bundle origin/main..main   # або main цілком: git bundle create /tmp/grafik.bundle main
   scp /tmp/grafik.bundle grafik:/tmp/ && ssh grafik 'cd /root/grafik-bot && git pull /tmp/grafik.bundle main && git log --oneline -1'
   ```

3. **Chromium для Puppeteer** (один раз; без нього генерація умов падає «Could not find Chrome»):
   ```bash
   ssh grafik 'cd /root/grafik-bot && pnpm install --frozen-lockfile 2>&1 | tail -2 && pnpm --filter @workspace/api-server exec puppeteer browsers install chrome 2>&1 | tail -2 && ls ~/.cache/puppeteer'
   ```
   Системні бібліотеки (libnss3, libatk, libgbm, libxkbcommon, libasound) на VPS уже стоять (перевірено 10.09).

4. **Міграції** — за алфавітом, лише файли гілки (усе від `2026-08-28` і новіше; старші вже на проді):
   ```bash
   ssh grafik 'cd /root/grafik-bot && export $(grep -E "^DATABASE_URL=" .env) && for m in $(ls deploy/migrations/*.sql | sort | awk -F/ "\$NF >= \"2026-08-28\""); do echo "== $m"; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$m" || break; done'
   ```
   Очікувано: 0 ERROR. Файли від 02–03.09 з main (agreement-charges-paid, absence-attachments,
   email-recipients) уже накочені — вони ідемпотентні, повторний прогін безпечний.
   Два «датових» файли: `2026-09-10-companies-registry-data.sql` (реквізити фірм по NIP) і
   `2026-09-10-document-templates-import.sql` (26 шаблонів; scope фабрик уже під прод-id).

5. **Печатки фірм** (файли поза git, id фірм на проді = локальним: 1 Klinex, 2 ES, 3 ESO):
   ```bash
   scp artifacts/api-server/uploads/company/stamp-{1,2,3}.png grafik:/root/grafik-bot/uploads/company/   # тека створюється: ssh grafik 'mkdir -p /root/grafik-bot/uploads/company'
   ```
   `.env` на проді: додати `COMPANY_STAMP_PNG=/root/grafik-bot/uploads/company/stamp-2.png` (фолбек
   для умов без фірми). `UPLOADS_DIR` не потрібен — дефолт збігається з `/root/grafik-bot/uploads`.

6. **Збірка + рестарт:** `ssh grafik 'cd /root/grafik-bot && bash deploy/build.sh 2>&1 | tail -12'`.
   При старті код сам сідить `task_auto_rules` (`ensureAutoRules`) і перераховує кеш легальності.

7. **Смоук** (`/api/healthz` → `{"status":"ok","db":"ok","bot":"up"}`, `pm2 logs` без level:50), далі руками:
   - профіль будь-якого працівника: секції «Легалізація і документи» і «Умови» відкриваються;
   - Налаштування → Бібліотека документів: 27 шаблонів, у AGRAM/InPost/ANDROS/Sushi є scope-фабрики;
   - тестовий пакет умов на ТЕСТОВОГО працівника (не живого): згенерувати → відправити (кнопка
     «✍️ Підписати» у боті) → підписати з телефону → «Підписати від компанії» → у PDF печатка фірми;
   - `/tasks` відкривається, «Мій день» без помилок; `/workers-calendar` показує місяць;
   - `/legalization` дашборд + Excel.

## Що НЕ входить у деплой (рішення потрібне окремо)

- Ставки/обовʼязки фабрик для умов (`factories.contract_rate_brutto`, `contract_duties`,
  `factory_positions.contract_duties`) — локально порожні, заповнює офіс у налаштуваннях фабрики.
- Виконавець 2-го ступеня powiadomienia UA (`task-auto-rules` → правило `ua_notification`,
  `params.stage2AdminId`) — вибрати в Налаштуваннях задач після деплою.
- Untracked у worktree лишаються: `docs/INBOX_*.md` (спека іншого модуля), `.claude/skills/module-proposal/`,
  `artifacts/api-server/scratch-*.mjs` — не для проду.

## Rollback

`docs/infrastructure/DEPLOYMENT.md → Rollback` (git checkout попереднього коміту + build.sh).
Міграції адитивні (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / сіди), старий код
з ними працює; відкат схеми не потрібен. Єдине неадитивне — `ALTER TABLE positions DROP COLUMN
is_office` в `2026-09-05-employers.sql`, але колонку створює сама гілка (main її не знає).

## Ревʼю (друга думка, 10.09.2026)

`codex exec --sandbox read-only` по 4 diff-ах (умови/підпис, легалізація, задачі, життєвий цикл).
`agy` у headless-режимі не відпрацював: «tool required the "command" permission» — потрібне
allow-правило в налаштуваннях Antigravity (без `--dangerously-skip-permissions` не запускаємо).

**Підтверджено по коду і виправлено (коміт «fix(review)…»):**
- легалізація: вісь «умова» не перевіряла `hasUmowa` (пакет без umowy рахувався умовою); сортування
  підстав ставило безстроковий документ останнім (усупереч коментарю); ранг `pending` був нижчий за
  `expiring` → overall=expiring і резолвер виплат вважав людину повністю оформленою;
- задачі: повторний «done» плодив наступний екземпляр повторюваної задачі; спостерігачі ставали
  виконавцями повтору; строки автозадач «сьогодні + N» переписувались щодня (ніколи не прострочувались);
- умови: PATCH лише з датою «від» стирав дату «до»; дата укладення по UTC (за Варшавою тепер);
  порожній draft лишався після падіння Chromium (тепер прибирається); `supersedesId` без перевірки
  власника; стрім файла без обробника помилок (падіння процесу); номер паспорта в info-лозі;
- /workers: świadectwo (factoryId + sent) підмінювало umowę в колонці «Легалізація»;
  картка PSZ-PPWPU: адреса без номера будинку.

**Не підтвердилось:** «анкета лишається verified після публічного скану» — confirm ставить
`submitted`; «фолбек SESSION_SECRET у iCal» — auth.ts кидає помилку без секрету в production.

**Відкладено (реальні, але не блокують деплой; рішення власника):**
- легалізація: nationality-mismatch лише попереджає; `hadPrior` для додаткової фірми бере primary;
  `workOnOtherBasis` не рахує `expiring`; `loadLeadDays` без фільтра effectiveFrom/To;
  `effectiveSinceOf` без дати документа з legacy; `resolveStatusMap` при зміні лише group;
  журнал зміни статусу поза транзакцією з кешем;
- задачі: `tasksManage`-не-автор не може закрити review; `autoParams/contractId` не оновлюються;
  `sendDocumentRequest` бере довільний документ типу; `newer` не дивиться на статус; iCal DTEND
  через опівніч; нагадування «за годину» про зустріч після опівночі;
- життєвий цикл: гонка двох адмінів на «Відновити»; callback rehire без id запиту; `fireWorker`
  без транзакції; UA-задачі 2-го ступеня без блокування; пріоритет UA-задачі не росте при простроченні;
  convert кандидата без Telegram не передає factoryId у office-токен;
- умови: гонка двох confirm скану; PNG-валідація лише по заголовку; редагування verified-анкети офісом
  без скидання статусу (свідомо: це дія офісу).

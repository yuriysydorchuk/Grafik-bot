# Задача: Зголошення проблем і побажань з панелі (модуль «Зголошення»)

> Контекст проєкту: [`HANDOFF.md`](../../HANDOFF.md) · [`CLAUDE.md`](../../CLAUDE.md) · [`PROJECT_MAP.md`](../../PROJECT_MAP.md) · пропозиція-макет: https://claude.ai/artifact/Twy4G9zYQkWcVpWJQWaxkY

- **Статус:** ✅ ЗАДЕПЛОЄНО 29.10.2026 (70ad883; міграція накачена; healthz ok)
- **Дата:** 2026-10-29
- **Автор/сесія:** Claude Fable 5.1, сесія з Yuriy

---

## Мета

Користувачі панелі зголошують проблеми й побажання прямо під час роботи (кнопка в куті кожної сторінки), система сама збирає контекст (сторінка, фільтри, останні дії, запити, помилки, версія збірки), усе лягає в БД, головний адмін отримує пуш у бот, а окрема сесія Claude (`/feedback-triage`) читає відкриті зголошення, дає вердикти, після узгодження реалізує й повертає статуси авторам.

**Критерій готовності:** з ролі «Графікова» зголошення зі скріншотом, піном і записом дій створюється й видно на `/feedback`; головний отримує пуш із кнопками; автор бачить відповідь у віджеті та в боті; `/feedback-triage` читає пакет з проду read-only; імпорт `result.json` міняє статуси й шле авторам «виправлено».

## Рішення власника (29.10.2026)

- Запис дій = **лише «хлібні крихти»** (кліки/переходи/запити/помилки), без rrweb-відео. Формат — текстовий, щоб Claude читав напряму.
- Зворотний запис тріажу = **імпорт файлу результату в панелі** (безпечно, один клік). Не прод-API з локальної машини.
- Чужі **відкриті** зголошення по тій самій сторінці **видно всім** для «у мене теж» (лише заголовок/тип/статус/голоси, без вкладень і контексту).
- Працівники/водії з бота — **пізніше**, не в цій версії.
- Замазка на скріншоті **незворотна** (на сервер іде лише сплющене зображення) — свідомо, заради персональних/фінансових даних.

## Контекст

Шари: схема БД + міграція, API (новий роутер), сервіс + бот-сповіщення + бот-хендлер, крон-хуки (вечірній підсумок, нагадування/автопідтвердження, рядок у тижневому звіті), веб (віджет, крихти, ErrorBoundary, сторінка, дашборд, налаштування, навігація), скіл Claude, доки.

**Що вже є й перевикористовується** (факти з розвідки 29.10):

- `pino-http` дає `req.id` (лічильник процесу; `app.ts:22-40`), заголовок клієнту не віддається → додати `X-Request-Id` + `genReqId` (випадковий короткий id, щоб не збігались після рестарту).
- `lib/uploads.ts`: `UPLOADS_ROOT`, `ensureUploadDirs()` (новий каталог додати туди), `sniffDocMime`, `compressUploadImage`, `makeStoredName`; збереження/віддача — як у `routes/tasks.ts:477-507` (`writeFile` + `res.sendFile` з `nosniff`).
- `bot/notify.ts` `notifyAdminById(adminId, type, text, options)`; тип гейтиться `roles.notify`; головний — `mainAdminId()` з `services/tasks.ts:79`.
- `lib/roles.ts` `NOTIFY_KEYS` (+ дзеркало `web/src/lib/roles.ts`), `READ_ONLY_ALLOWED_PATHS` — точні шляхи (`.includes`); `lib/scope.ts` `SCOPE_RULES` — регекс+метод, перший збіг.
- `lib/auth.ts` `authRequired`, `requireMainAdmin`; `req.admin = {adminId, name, role, isMain, caps, pages, scope, ...}`.
- Бот: патерн `registerXxx(bot)` у `bot/handlers/*`, стан `setState/getState/clearState` (`bot/state.ts`), тексти офісу `tb(lang, uk)` + `BOT_EN` (`bot/i18n.ts:458`), мова `oLang(admin.language)`, штамп на повідомленні — `bot/handlers/tasks.ts:209-216`; реєстрація — `bot/index.ts:139-149` до загального `on("text")`.
- `services/taskDigest.ts`: `runTaskDigestTick` (кожні 5 хв, час з `loadTaskSettings().eveningTime`, дедуп у `settings`), `sendWeeklyControlReport` (пн 08:00) — місце для рядка про зголошення.
- `services/tasks.ts` `createTask({title, source, sourceKey, ...}, actorId)`; `source_key` унікальний → `feedback:<id>`.
- Веб: `api()`/`upload()` у `lib/api.ts` (єдина точка для крихт запитів і 5xx), `lib/nav.ts` `useNavTracking` (ефект по `loc` для крихт навігації), `components/ui.tsx` `Modal/Button/Card/Badge/Textarea`, `sonner` тости з `action`, `lib/theme.ts` `resolvedDark()`, `lib/hooks.ts` `useMe()`, `Layout.tsx` NAV (остання група без назви: Налаштування/Користувачі/Безпека), бейдж задач як зразок лічильника, `lib/searchCatalog.ts` (Ctrl+K), `lib/roles.ts` `canAccessPage` зі спецкейсом `/security` (так само `/feedback`), `pages/Settings.tsx` TABS, `Dashboard.tsx` AttentionPanel/MyTasksTile, `TaskBits.tsx` блок «Кого стосується».
- ErrorBoundary / `window.onerror` у вебі **немає** — додаємо.
- Версії збірки **немає** — додаємо `APP_VERSION` через esbuild `define` + vite `define`.
- Прод read-only: `ssh grafik 'cd /root/grafik-bot && export $(grep -E "^DATABASE_URL=" .env) && psql "$DATABASE_URL" -f …'`; uploads на проді `/root/grafik-bot/uploads/`. SSH рейт-лімітиться → усе в один виклик.
- Інтеграційні тести: `src/test/harness.ts` (`resetDb` з хардкод-списком таблиць — додати нові; `seedAdmin`, `seedRole`).

## Модулі які можна чіпати

- `lib/db/src/schema/workers.ts` (3 нові таблиці) + `deploy/migrations/2026-10-29-feedback.sql`
- `artifacts/api-server/src/{routes/feedback.ts, services/feedback.ts, bot/handlers/feedback.ts}` (нові)
- `artifacts/api-server/src/{routes/index.ts, lib/roles.ts, lib/auth.ts, lib/scope.ts, lib/uploads.ts, app.ts, routes/auth.ts, bot/index.ts, bot/i18n.ts, services/taskDigest.ts, services/scheduler.ts, test/harness.ts, build.mjs}` (точкові правки)
- `artifacts/web/src/{components/FeedbackWidget.tsx, components/FeedbackAnnotator.tsx, lib/breadcrumbs.ts, lib/feedbackApi.ts, pages/Feedback.tsx, pages/FeedbackSettings.tsx}` (нові)
- `artifacts/web/src/{App.tsx, components/Layout.tsx, lib/api.ts, lib/nav.ts, lib/roles.ts, lib/i18n.tsx, lib/searchCatalog.ts, lib/tasksApi.ts, components/TaskBits.tsx, pages/Dashboard.tsx, pages/Settings.tsx, main.tsx}` (точкові), `artifacts/web/package.json` (+`modern-screenshot`), `vite.config.ts` (define)
- `.claude/skills/feedback-triage/SKILL.md`, `deploy/feedback-pack.sql`, `docs/feedback/README.md`, `.gitignore`
- `docs/API_ROUTES.md`, `PROJECT_MAP.md`, `CLAUDE.md` (один рядок правила), `artifacts/api-server/src/routes/feedback.integration.test.ts`

## Модулі які не можна чіпати

- Незакомічена чужа партія в дереві (fireDate: `admin-api.ts`, `svodni.ts`, `workerFire.ts`, `WorkerDetail.tsx`, `ProfileChangeModal.tsx`, `CLAUDE.md` рядок про звільнення, частина `app.ts` і `i18n.tsx`) — лише **додавати** рядки поруч, нічого з її diff не відкочувати.
- Фінансові модулі, сводні, `routes/admin-api.ts` (крім нічого), `.env`, `ecosystem.config.cjs`, `pnpm-workspace.yaml` (крім, за потреби, каталогу).

---

## План (деталізовано)

### Крок 1. Схема БД і міграція

`feedback_reports`
| Колонка | Тип | Навіщо |
|---|---|---|
| id | serial PK | номер зголошення (показується як #id) |
| kind | text NOT NULL | `bug` / `wish` / `question` |
| severity | text | лише для bug: `blocks` / `hinders` / `minor` |
| status | text NOT NULL default `new` | `new, review, clarify, planned, in_progress, fixed, confirmed, rejected, duplicate, exists` |
| title | text NOT NULL | авто з першого рядка опису (≤120), головний може правити |
| description | text NOT NULL | «що сталось» / текст побажання / питання |
| steps | text | «що робили» (bug) |
| expected | text | «що очікували» (bug) |
| about_page | boolean NOT NULL default true | «про цю сторінку» / інша / загальне (`page_path` null) |
| page_path, page_label, page_url | text | шлях з меню, назва, повний URL з query |
| page_filters | jsonb | `{factoryId:"3", week:"2026-10-26", selects:{"Фабрика":"AGRAM LUBLIN"}}` |
| origin | text NOT NULL default `widget` | `widget` / `error` (тост після падіння) / `api5xx` |
| client_error | jsonb | `{message, stack, source}` коли origin=error/api5xx |
| context | jsonb NOT NULL default `{}` | роль, скоуп, UA, платформа, екран, тема, мова, `failedRequests[]`, `consoleErrors[]` |
| breadcrumbs | jsonb NOT NULL default `[]` | масив `{t, type, text, status?, ms?, reqId?}` |
| recorded | boolean default false | чи натискав «Записати дії» |
| build_version | text | `APP_VERSION` клієнта на момент зголошення |
| author_admin_id | int FK admins NOT NULL | автор |
| author_seen_at | timestamp | коли автор востаннє відкривав «Мої» (непрочитане = `last_admin_activity_at > coalesce(author_seen_at, created_at)`) |
| last_admin_activity_at | timestamp | остання дія головного (статус/відповідь/питання) |
| reply | text | остання офіційна відповідь автору (показується у списку «Мої») |
| duplicate_of_id | int FK self ON DELETE SET NULL | дубль → оригінал |
| task_id | int FK tasks ON DELETE SET NULL | «зробити задачею» |
| triage | jsonb | `{verdict, effort, risk, note, batch}` з імпорту результату |
| deployed_commit | text | коміт деплою, що закрив |
| status_by_admin_id, status_changed_at | int, timestamp | хто/коли міняв статус |
| confirm_requested_at, confirm_reminded_at, confirmed_at | timestamp | ланцюжок підтвердження автора |
| created_at, updated_at | timestamp NOT NULL default now() | |

Індекси: `(status)`, `(author_admin_id)`, `(page_path) WHERE status NOT IN закриті`.

`feedback_attachments`: id, report_id FK CASCADE, kind (`screenshot`/`pin`/`upload`), path, name, mime, size, meta jsonb (пін: `{selector, text, tag, rect, pageW, pageH}`; скріншот: `{annotations: n, blurred: bool, viewport}`), created_at.

`feedback_comments`: id, report_id FK CASCADE, admin_id FK admins, kind (`comment`/`answer`/`question`/`system`), body, via (`web`/`bot`/`triage`), created_at.

`feedback_votes`: report_id FK CASCADE, admin_id FK admins, created_at, PK(report_id, admin_id).

Міграція `deploy/migrations/2026-10-29-feedback.sql`: `CREATE TABLE IF NOT EXISTS` ×4, індекси, `UPDATE roles SET notify = notify || '["feedback"]' WHERE key='owner' AND NOT notify ? 'feedback'`, сіди `settings` (`feedback.instant_kinds='["blocks"]'`, `feedback.confirm_days='7'`, `feedback.remind_days='3'`, `feedback.widget_off_roles='[]'`) через `ON CONFLICT DO NOTHING` (не затирати налаштоване). Накат локально `psql "$DATABASE_URL" -f`, потім `pnpm run typecheck:libs`. Назва файла йде після `2026-10-29-contract-termination.sql` за алфавітом (`f` > `c`) — залежностей між ними немає.

### Крок 2. Доступ, інфраструктура запитів, версія збірки

- `lib/roles.ts` + `web/src/lib/roles.ts`: `NOTIFY_KEYS` + `"feedback"`, label `"🐞 Зголошення (нові з панелі, вечірній підсумок)"`.
- `lib/roles.ts`: `READ_ONLY_ALLOWED_PREFIXES = ["/feedback"]`; `lib/auth.ts` перевіряє `includes(path) || PREFIXES.some(startsWith)` (мутації головного й так за `requireMainAdmin`, readOnly-роль ніколи не головна).
- `lib/scope.ts`: `R(ANY, /^\/feedback(?:\/.*)?$/, { kind: "free" })` — зголошення не є даними працівників.
- `app.ts`: у `pinoHttp` `genReqId: () => randomBytes(4).toString("hex")`; middleware `res.setHeader("X-Request-Id", req.id)`; `Access-Control-Expose-Headers` не потрібен (same-origin).
- Версія: `artifacts/api-server/build.mjs` → `define: {"process.env.APP_VERSION": JSON.stringify("<sha7> <YYYY-MM-DD>")}` (git через `execSync`, try/catch → `"dev"`); `routes/auth.ts /auth/me` → `buildVersion`; web `vite.config.ts` `define: { __APP_VERSION__ }` для тосту падіння до того, як `me` завантажиться (fallback). Тип `Me.buildVersion?: string`.

### Крок 3. Сервіс і API (`services/feedback.ts`, `routes/feedback.ts`)

Сервіс:
- `OPEN_STATUSES`, `CLOSED_STATUSES`, `STATUS_LABEL`, `KIND_LABEL`, `SEVERITY_LABEL` (укр., для бота й експорту).
- `createReport(input, admin)` → insert, title з опису, `notifyNewReport`.
- `notifyNewReport(report)`: головному через `notifyAdminById(main, "feedback", text, kb)` **одразу**, якщо `severity ∈ settings.instant_kinds` або `origin ∈ {error, api5xx}` з severity blocks; інакше лише у вечірній підсумок. Текст: `🐞 Зголошення #48 · блокує роботу` + автор/роль + сторінка/фільтри + заголовок + що прикріплено; кнопки `fb:open` (url панелі), `fb:accept:<id>`, `fb:ask:<id>`, `fb:reject:<id>`.
- `setStatus(report, status, adminId, {reply?, duplicateOfId?, via})` → оновлює, пише system-коментар, `last_admin_activity_at`, при `fixed` — `confirm_requested_at = now`, `notifyAuthor` з текстом за статусом і кнопками `fb:ok/fb:no` (для fixed) або `fb:reply` (для clarify).
- `notifyAuthor(report, text, kb?)` — напряму `bot.telegram.sendMessage(author.telegramId, …)` мовою `oLang(author.language)` (особисте, без гейта типу).
- `addComment(report, adminId, kind, body, via)`; коментар автора у статусі `clarify` → статус `review` + пуш головному.
- `similar({pagePath, q})` — токени ≥4 символів, `ILIKE` по title/description, спершу та ж сторінка, лише відкриті, топ-5.
- `counters()` → `{new, stale (>7 дн без відповіді у new/review), awaiting (fixed без підтвердження), openTotal}`.
- `eveningSummary(today)` → текст для головного (нові за день, stale, awaiting) або null; `dailyTick(today)` → нагадування авторам (`fixed` + `remind_days`, раз) і автопідтвердження (`fixed` + `confirm_days`); `weeklyLine(from,to)` → рядок для тижневого звіту.
- `buildPack(filter)` → `{generatedAt, build, reports:[…з коментарями/вкладеннями(path)/голосами]}`; `applyTriageResult(json, adminId)` → по кожному item `setStatus`/`triage`/`duplicateOfId`/`deployedCommit`, повертає `{applied, skipped:[…]}`.
- `createTaskFromReport(report, adminId)` → `createTask({title, description, source:"feedback", sourceKey:\`feedback:${id}\`, priority за severity}, adminId)` + `task_id`.

Роутер (`router.use(authRequired)`; `router.use("/feedback/admin", requireMainAdmin)` — адмінські шляхи під префіксом `/feedback/admin/*`, щоб гейт був по префіксу):
| Метод | Шлях | Хто | Що |
|---|---|---|---|
| GET | `/feedback/mine` | усі | мої зголошення + `unread` |
| POST | `/feedback/mine/seen` | усі | `author_seen_at = now` |
| GET | `/feedback/page?path=` | усі | відкриті по сторінці (чужі й мої): id, kind, severity, status, title, votes, voted, mine |
| GET | `/feedback/similar?path=&q=` | усі | підказка дубля |
| POST | `/feedback` | усі (вкл. readOnly/скоуп) | створити; тіло JSON (без файлів); відповідь `{id}` |
| POST | `/feedback/:id/attachments` | автор або головний | multipart `files[]` + `meta` (JSON-масив по файлах: kind, meta); PNG/JPEG/WEBP/PDF ≤10 МБ ×6; зображення стискаються `compressUploadImage` (крім PNG-скріншотів з замазкою → лишаємо PNG, щоб не розмазувати пікселізацію) |
| GET | `/feedback/:id` | автор або головний | картка (контекст/крихти/вкладення/коментарі/голоси) |
| GET | `/feedback/:id/attachments/:aid` | автор або головний | файл (`nosniff`, inline) |
| POST/DELETE | `/feedback/:id/vote` | усі | «у мене теж» |
| POST | `/feedback/:id/comments` | автор або головний | `{body}` |
| POST | `/feedback/:id/confirm` | автор | `{ok, note?}` → confirmed / in_progress |
| GET | `/feedback/admin/list?status=&kind=&page=&author=&q=` | головний | список/дошка |
| GET | `/feedback/admin/counters` | головний | плитка/бейдж |
| PATCH | `/feedback/admin/:id` | головний | `{status?, reply?, duplicateOfId?, severity?, kind?, title?}` |
| POST | `/feedback/admin/:id/task` | головний | зробити задачею |
| GET | `/feedback/admin/pack.zip?…фільтри` | головний | ZIP: `feedback.json` + `shots/<id>-<aid>.png` |
| POST | `/feedback/admin/import` | головний | JSON результату тріажу (тіло або файл) |
| GET/PUT | `/feedback/admin/settings` | головний | налаштування модуля |

Монтування в `routes/index.ts` після `securityRouter`. Тест `feedback.integration.test.ts`: графікова створює → `mine`/`page`; readOnly-роль створює (не 403); інший адмін голосує; головний `list`/`PATCH status=fixed` → `confirm_requested_at`; автор `confirm ok` → `confirmed`; імпорт результату → статуси + коментар-answer.

### Крок 4. Бот (`bot/handlers/feedback.ts`, `BOT_EN`)

- `fb:accept:<id>` → `review`, штамп на повідомленні («✔ Прийнято · Yuriy»).
- `fb:ask:<id>` → `setState(tid, "fb:ask", {id})`, `cancelKb(lang)`; текст → коментар `question` + статус `clarify` + пуш автору з кнопкою `fb:reply:<id>`.
- `fb:reject:<id>` → стан `fb:reject` → текст-причина → `rejected` + `reply` + пуш автору.
- Автор: `fb:ok:<id>` → `confirmed`; `fb:no:<id>` → стан `fb:no` → текст → `in_progress` + коментар + пуш головному; `fb:reply:<id>` → стан `fb:reply` → текст → коментар + `review` + пуш головному.
- Автор визначається по `admins.telegram_id` напряму (`adminByTelegramId` у сервісі): це перевірка авторства, не адмін-гейт; readOnly/скоуп-адміни теж автори.
- `bot.on("text")` лише для станів `fb:*`, з перевіркою скасування; реєстрація `registerFeedback(bot)` у `bot/index.ts` поруч з `registerPracaGov`.
- EN-рядки у `BOT_EN` (секція `// Зголошення (bot/handlers/feedback.ts)`).

### Крок 5. Крони (без нових розкладів)

- `runTaskDigestTick`: у гілці вечірнього часу після `sendEveningSummaries` → `sendFeedbackEveningSummary(today)` з дедупом `feedback.evening.sent`.
- `scheduler.ts` джоб `5 0 * * *` (rollover/терминації) → `feedbackDailyTick()`.
- `sendWeeklyControlReport`: перед `notifyAdminById` → `lines.push(await feedbackWeeklyLine(...))`.

### Крок 6. Веб

1. **Залежність** `modern-screenshot@^4.7.0` у `artifacts/web/package.json` (опубліковано 04.2026, `minimumReleaseAge` не блокує).
2. **`lib/breadcrumbs.ts`**: кільцевий буфер (200 подій, при знімку — останні 5 хв або від маркера запису), `record(ev)`, `startRecording/stopRecording/isRecording`, `snapshot()` → `{breadcrumbs, failedRequests, consoleErrors, recorded}`; `installBreadcrumbs()` (один раз у `main.tsx`): клік capture-фазою (tag + текст ≤40 символів з `innerText`/`aria-label`/`title`, без значень інпутів), `window.error`, `unhandledrejection`, обгортка `console.error`; події `api` пишуть `api()`/`upload()` (метод, шлях без `/api`, статус, ms, `X-Request-Id`); події `nav` пише `useNavTracking` (`loc + location.search`). Помилки й 5xx диспатчать `window.dispatchEvent(new CustomEvent("grafik:feedback-prompt", {detail}))`.
3. **`lib/api.ts`**: `api()`/`upload()` вимірюють час, читають `X-Request-Id`, пишуть крихту, на `status >= 500` диспатчать prompt. `upload()` теж віддає `status/data` на помилці (дрібний фікс).
4. **ErrorBoundary** (`components/ErrorBoundary.tsx`, class) навколо `<Switch>` у `App.tsx`: картка «Щось зламалось на цій сторінці» з кнопками «Зголосити» (відкриває віджет з origin=error) і «Оновити». `componentDidCatch` → крихта `error`.
5. **`components/FeedbackWidget.tsx`** (монтується в `Layout` після `<main>`, лише коли `me` є і роль не у `widget_off_roles`): кнопка `fixed bottom-5 right-5 z-[45]` з бейджем непрочитаних (`/feedback/mine` раз/2 хв), `Alt+F`; панель (абсолютно позиціонована картка 360px, на мобільному — на всю ширину) з вкладками «Нове» / «Мої» / «На цій сторінці». Крок 1: тип + вага. Крок 2: «про цю сторінку?» (так / інша зі списку NAV / загальне). Крок 3: поля, підказка дубля (`/feedback/similar`, debounce 500 мс), кнопки вкладень, блок «Додасться автоматично» (розгортається), «Надіслати». Після відправки: `POST /feedback` → `POST attachments` → тост «Дякуємо! Зголошення #N». Автоконтекст: `me` (роль, roleLabel, скоуп), UA/платформа, `screen`, `resolvedDark()`, `localStorage.lang`, `me.buildVersion ?? __APP_VERSION__`, `page_filters` = `URLSearchParams` + підписи вибраних `<select>` у `<main>` (label-текст → selected option text, ≤8), `document.title`/заголовок `h1`.
6. **Скріншот**: віджет ховається (`data-feedback-hide`, фільтр `filter` у `domToBlob`), `domToBlob(document.documentElement, {scale: 1, type: "image/png"})`; **анотатор** `components/FeedbackAnnotator.tsx` (Modal xl): canvas на зображенні, інструменти рамка / стрілка / замазка (пікселізація 12px блоками) / текст, скасувати, «Готово» → сплющений PNG blob. Крихта `rec`.
7. **«Показати де»**: оверлей на весь екран (`z-[70]`), підсвітка елемента під курсором (`outline`), `Esc` скасовує; клік → `{selector (tag#id / .класи до 2 / nth-of-type, ≤4 рівні), text ≤60, rect, tag}` + `domToBlob(el)` мініатюра ≤400px; у кроці 3 показується чіп «👆 button «26.10 – 01.11»».
8. **Запис дій**: `startRecording()`; пілюля з таймером над кнопкою; стоп автоматично через 3 хв.
9. **`pages/Feedback.tsx`** (`/feedback`, лише головний): лічильники-чіпи, фільтри (статус/тип/сторінка/автор/збірка/пошук), перемикач «Дошка» (4 колонки: нові / на розгляді+уточнити / у плані+в роботі / виправлено) ↔ «Список»; картка у Modal `xl` (`?id=` у URL для лінків з бота/задач): дії (Прийняти / Уточнити / Відхилити / Дубль / Зробити задачею / Статус ▾ / Копіювати для Claude), опис-три поля, вкладення (ZoomImage), крихти (моно-блок, ≥400 і помилки червоним, кнопка копіювання req.id), коментарі + поле відповіді (`answer`), права колонка контекст/журнал/голоси/звʼязки. Кнопки «📦 Пакет для Claude» (link на `pack.zip` з поточними фільтрами) і «⬆ Імпорт результату» (file input → POST import → тост із підсумком).
10. **Dashboard**: `FeedbackTile` (лише головний; `/feedback/admin/counters`): нові / без відповіді >7 дн / чекають підтвердження; ховається, якщо все нулі.
11. **Settings**: вкладка «Зголошення» (`isMain`): миттєвий пуш по вагах/типах, `remind_days`, `confirm_days`, ролі без віджета, підказка дубля (увімк.), нагадування що тип сповіщення — у ролях.
12. **Layout**: пункт `/feedback` «Зголошення» в останній групі (icon `MessageSquareWarning`), бейдж `new`; `searchCatalog` рядок (`mainOnly`); `roles.ts` `canAccessPage("/feedback") = isMain`.
13. **Задачі**: `SOURCE_LABEL.feedback = "зголошення"`, у `TaskDrawer` блок «Кого стосується» показує лінк `🐞 Зголошення #N` коли `source === "feedback"` (id з `sourceKey`).
14. **i18n**: усі нові рядки у `EN` (секція `// ── Зголошення ──`).

### Крок 7. Скіл Claude і пакет

- `deploy/feedback-pack.sql`: один `SELECT json_build_object(...)` з відкритими зголошеннями (коментарі, вкладення-шляхи, голоси, автор: імʼя + роль) → psql `-tA` дає JSON.
- `.claude/skills/feedback-triage/SKILL.md`: 1) один ssh: `psql -f deploy/feedback-pack.sql` → `docs/feedback/inbox/pack-<дата>.json` + `tar` скріншотів з `uploads/feedback/` → `docs/feedback/inbox/shots/`; альтернатива — ZIP з панелі, розпакувати туди ж; 2) правила аналізу (кожне звірити з кодом, ознаки «уже є», дубль, суперечність правилам CLAUDE.md, обсяг S/M/L, ризик, згрупувати в батчі), 3) вихід: артефакт-таблиця + `docs/feedback/triage-<дата>.md`, 4) стоп до рішення власника, 5) після реалізації й `/deploy` — `docs/feedback/result-<дата>.json` у форматі імпорту (`{commit, items:[{id, status, reply, duplicateOfId?, triage:{verdict, effort, risk, note}}]}`) і нагадати власнику імпортувати на `/feedback`; 6) заборони (не писати в прод, не слати персональні дані у зовнішні агенти, скріншоти з фінансів — лише якщо замазані).
- `docs/feedback/README.md` (формат пакета/результату), `.gitignore` → `docs/feedback/inbox/`.

### Крок 8. Доки й правила

- `docs/API_ROUTES.md`: секція «Зголошення» (таблиця). `PROJECT_MAP.md`: рядок в індексі API + рядок у крон-таблиці + bot flow (кнопки `fb:*`). `CLAUDE.md`: один рядок-правило у «Правила розробки» (віджет на кожній сторінці; новий `fetch` поза `api()` крихт не лишає; readOnly-префікс; сторінка головного; скіл тріажу).

### Крок 9. Верифікація

1. `pnpm run typecheck:libs` після схеми; `pnpm run typecheck`.
2. `pnpm --filter @workspace/api-server run build`; `run test` (юніти); інтеграційні з `TEST_DATABASE_URL` на одноразовій БД (`grafik_bot_test` зі схемою + усіма міграціями).
3. `pnpm --filter @workspace/web run build`.
4. `pm2 restart grafik-bot` (локальний процес) → смоук: створити зголошення з ролі графікової (скріншот/пін/запис), побачити на `/feedback`, пуш у тест-бот, кнопки, імпорт результату з тестовим файлом.
5. Скрін сторінок через `web-screens` (віджет на Графіках, `/feedback` дошка, картка).
6. Codex/agy-ревʼю diff — перед деплоєм (окремим кроком, за правилом CLAUDE.md), не зараз.

## Реалізація

Зроблено 29.10.2026 за планом вище, усі кроки 1–9. Ключові рішення й відхилення від плану:

- Скріншот бере **лише видиму область** (клон зсувається на scroll, полотно = вікно): на списку з 420 працівників знімок усієї сторінки тривав десятки секунд; таймаут 25 с із тостом.
- Миттєвий пуш головному йде з **затримкою 20 с** після створення — щоб вкладення (скріншот/пін) уже були в БД і потрапили в текст.
- Автор отримує особисті пуші **без гейта типу сповіщень** (`bot.telegram.sendMessage` напряму); тип `feedback` гейтить лише пуші головному.
- `source_key` задачі зі зголошення = `feedback:<id>:<ts>` (унікальний індекс; повторне «зробити задачею» повертає відкриту задачу).
- «Копіювати для Claude» — Markdown картки на клієнті (`reportMarkdown` у `lib/feedbackApi.ts`), без окремого ендпойнта.
- `NAV_PAGES` (`components/navPages.ts`) дублює NAV з `Layout.tsx` для віджета (інакше цикл імпортів) — тримати синхронно.
- Пакет: ZIP з панелі (`/feedback/admin/pack.zip`) **і** `deploy/feedback-pack.sql` для read-only psql по ssh — обидва дають той самий `feedback.json`.
- **Дописано 29.10 після звірки з макетом** (пропущені при складанні спеки): обрізання скріншота в анотаторі; перетягування карток між колонками дошки (→ статус колонки); окремий блок «Журнал» у картці (системні події окремо від коментарів); 4-та плитка дашборду «закрито за 30 дн · середній час» (`counters.closed30/avgDays`); «сесія N год M хв» в автоконтексті (`/auth/me sessionSince`); попередження перед «Пакетом для Claude» про незамазані скріншоти з фінансових сторінок (`GET /feedback/admin/pack-check`, `FINANCE_PAGES`, налаштування `feedback.pack_warn`; `warnings` також у `feedback.json`); виконана задача зі зголошення → системний рядок + пуш головному «відповісти автору / ✔ виправлено» (`onFeedbackTaskDone`, кнопка `fb:fixed`); «⏺ запис» у тексті пушу. Не зроблено свідомо: AI-схожість дублів (опційна в макеті, платний виклик).

- [x] i18n: EN для всіх нових рядків веба (152, секція «Зголошення з панелі»); `BOT_EN` для бота
- [x] Tailwind v4: класи буквально (`TONE_BORDER` у `lib/feedbackApi.ts`)
- [x] Ролі: `NOTIFY_KEYS` синхронно в обох `roles.ts`; `/feedback` — спецкейс `isMain` в обох `canAccessPage`
- [x] Схема: SQL накатано локально й на `grafik_bot_test`, `typecheck:libs`

## Тести

- [x] `pnpm run typecheck` (усі пакети)
- [x] `pnpm --filter @workspace/api-server run build`
- [x] `pnpm --filter @workspace/web run build`
- [x] `pnpm --filter @workspace/api-server run test` — 948 тестів, 0 падінь (без БД)
- [x] Інтеграційні `routes/feedback.integration.test.ts` на `grafik_bot_test` — 3/3 (+ `closed30` у лічильниках) (будь-яка роль створює/бачить/голосує; readOnly створює, адмінські шляхи 403; статуси, підтвердження автора, імпорт результату, задача, ZIP)
- [x] `pm2 restart grafik-bot` + смоук: `X-Request-Id` у відповідях, `buildVersion` у `/auth/me`, 4 тестові зголошення через API (#1–#4 у локальній БД, #4 «блокує» → миттєвий пуш у тест-бот)
- [x] Скріни (web-screens, світла/темна/мобільна): віджет крок 3 з підказкою дубля, «Мої», анотатор скріншота, пін на елемент (чіп «👆 button «…»»), дошка `/feedback`, картка з крихтами й контекстом, Налаштування → Зголошення — `console errors: none`
- [x] Наскрізний E2E у справжньому Chrome (playwright-core, scratch `e2e.mjs`, 29.10): Alt+F → крок 1–3 → запис дій → скріншот з рамкою/замазкою/обрізанням → пін на «Згенерувати» → відправка → в API 2 вкладення, 13 крихт з req.id, `recorded`, `context.session`, `pageFilters.selects`; помилка JS → тост → віджет з прикріпленою помилкою → `origin=error`; «Мої»: «Досі ні» з текстом → in_progress, «Працює» → confirmed; «На цій сторінці» + голос; дошка drag-and-drop → review; картка: «Копіювати для Claude» (markdown у буфері) + «Журнал»; імпорт `result.json` через UI; попередження про незамазаний скріншот зі сводної; перемикач налаштувань; плитки дашборду — 16/16 кроків, без помилок консолі
- [x] Бот-харнес `bot/handlers/feedback.integration.test.ts` (3 тести): прийняти/уточнити/відповідь автора/виправлено/«досі ні»/«працює»/повторне натискання; відхилити з причиною; виконана задача → пуш `fb:fixed` → fixed; крони: нагадування раз, автопідтвердження, вечірній підсумок з дедупом, рядок тижня. Нюанс харнесу: telegram_id має бути числовим; `resetDb` не чистить `settings`
- [x] Повний прогін api-server з тестовою БД (пофайлово, 29.10 ~15:00): 928+ пройшло; падіння — НЕ модуля: 6 падають і на чистому HEAD у worktree (видалення адміна з історією; задачі «масові випадки»/«старі працівники»; SMS «відправка»; документи «кілька фото → PDF»; workerLifecycle «лінк пішов у бот»), `workerFactoryEnd` зависає після тестів і на HEAD, і в дереві; `hireRegistration` «ревʼю codex» падає через ПАРАЛЕЛЬНУ незакомічену правку `routes/contracts.ts` іншої сесії (409 «умова уже є», 15:08). `officeManagerScope` у спільному прогоні падав, окремо — проходить (порядок у БД)
- [ ] Ручний тест Yuriy у своєму браузері й Telegram (живий пуш у тест-бот)
- [ ] Ревʼю diff через `agy` + `codex` перед `/deploy`; на проді — лише нова міграція `2026-10-29-feedback.sql`

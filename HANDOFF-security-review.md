# HANDOFF — defensive security review (2026-07-12)

Тимчасова записка сесії. Довговічні факти вже рознесені: CSRF-інваріант — у `CLAUDE.md`; решта — тут як TODO.

## Що зроблено

Проведено повний defensive-review кодової бази (auth/ролі, IDOR/BOLA, SQLi, XSS/CSRF/SSRF,
path traversal, upload, витік секретів/PII, cookies/CORS/headers, race conditions, валідація,
залежності). Загальний стан — добрий. Застосовано **3 виправлення** (гілка `security-hardening-idor-csrf`):

| # | Ризик | Файли |
|---|-------|-------|
| 1 | Medium — `GET /drivers/:id/invite` без capability-гейта видавав/генерував секрет прив'язки водія | `routes/admin-api.ts:1136` — додано `DRIVER_RW` |
| 2 | Medium — документ віддавався `inline` з client-declared MIME (stored-XSS, CSP вимкнено) | `lib/uploads.ts` (`sniffDocMime` — магічні байти), `routes/admin-api.ts` (валідація на upload + збереження перевіреного MIME + `X-Content-Type-Options: nosniff` на віддачі) |
| 4 | Medium — не було CSRF-токена, захист лише SameSite=Lax, `urlencoded` приймався | `app.ts` (гард на `/api`: мутації вимагають `X-Requested-With: grafik`, логін/2FA звільнені), `web/src/lib/api.ts` (заголовок у `api()` та `upload()`) |

Regression-тести (усі зелені, `node --test`): `lib/auth.gate.test.ts`, `lib/uploads.mime.test.ts`, `csrf.test.ts`.

Перевірено: `pnpm run typecheck` (чисто), `pnpm --filter @workspace/api-server run test` (63 pass),
web+api build (успішно). Веб-клієнт шле CSRF-заголовок скрізь через обгортки; `Login.tsx` `postRaw`
б'є лише в exempt `/auth/login`+`/auth/verify-2fa`; Excel/файл-лінки — GET (гардом не зачіпаються).

## ⚠️ Наслідок для деплою (CSRF)

Будь-який клієнт, що робить мутацію (POST/PATCH/PUT/DELETE) проти `/api`, **тепер мусить слати
заголовок `X-Requested-With: grafik`**, інакше отримає `403 {"error":"csrf"}`. Веб-панель уже це
робить. Бот працює polling-ом і не ходить через `/api` — його не стосується. Якщо є зовнішні
скрипти/інтеграції/curl проти API — навчити їх слати заголовок або додати у виключення в `app.ts`.
Логін/2FA (`/auth/login`, `/auth/verify-2fa`) звільнені за дизайном (сесії ще нема).

## Ще не застосовано (з ревʼю; підтвердити з власником перед роботою)

- **F3 (High, недосяжно зараз):** `nodemailer@8.0.10` має CVE GHSA-p6gq-j5cr-w38f (файл-рід/SSRF через опцію `raw`, яку код не використовує). Bump до `^9.0.1`. Готовий тест `email.deps.test.ts` описаний у ревʼю.
- **F6 (Low):** транзитивні `qs 6.15.1` (GHSA-q8mj-m7cp-5q26) і `uuid 8.3.2` через `exceljs` (GHSA-w5hq-g745-h8pq). Виправлення — `pnpm.overrides` у корені (`qs >=6.15.2`, `uuid >=11.1.1`).
- **F7 (Low):** `GET /admins` (`admin-api.ts:2975`, гейт `requireRole("owner")`) віддає invite-лінки всім owner, не лише `is_main`. За бажання — ховати `inviteLink` під `req.admin.isMain`.
- **F8 (Low):** непослідовні NaN-гарди на `Number(req.params.id)` (~40 хендлерів admin-api). Не експлуатується (Postgres відкидає NaN для int → 500). Косметика: спільний `parseId`.
- **F9 (Low, латентно):** `startsWith(UPLOADS_ROOT)` без межі роздільника (`lib/uploads.ts`, `admin-api.ts` download). Наразі недосяжно (`filePath` завжди з `makeStoredName`). Захист у глибину — порівняння з `UPLOADS_ROOT + path.sep`.
- **F10 (Low):** `XLSX.read` у боті без ліміту розміру перед парсингом (`bot/index.ts`). Перевіряти `doc.file_size` до `fetch`. Гейт `isAdmin` обмежує коло.
- **F11 (Low):** `/adminsetup` — гонка лише на «чистій» БД (fresh install). Мікроскопічне вікно.

## Підтверджено безпечним (без дій)

SQLi — немає (усе параметризоване; `sql.raw` лише серверні константи). XSS-стоків у React немає.
Email — plain-text. Секрети не логуються/не повертаються; pino редагує cookie/authorization/query-string.
Auth-ядро міцне (scrypt+timingSafeEqual, ревокація per-session + `token_version`, re-check щозапиту,
2FA, rate-limit, обовʼязковий `SESSION_SECRET` у проді). SSRF — усі `fetch` у фіксовані хости.
CORS `origin:false` за замовч. `xlsx` коректно запінений 0.20.3. `minimumReleaseAge` активний.

# Handoff: фікс рефералів на сайті + ліміти/причина авансу

Дата: 2026-06-22 · Статус: **реалізовано, закомічено (`f2eeaad`), запушено, задеплоєно й перевірено на проді**

---

## Задача 1 — реферали не з'являлися на сайті (фікс)

**Симптом:** працівник запросив друга, у Telegram прийшло сповіщення про реферала, але на сайті
(/recruitment) його не було.

**Причина:** на проді **взагалі не існувало вбудованої реферальної воронки** (прод-БД ініціалізована
зі `schema.sql` — лише структура, без даних; локально воронка була із сіду). Бот вставляв
реферал-кандидата з `funnel_id = null`, а Kanban/`GET /candidates` працюють по воронці →
кандидат не потрапляв у жодну колонку → невидимий (хоч у БД був, сповіщення йшло).

**Зроблено:**
- **NEW** [services/funnels.ts](../artifacts/api-server/src/services/funnels.ts):
  - `ensureReferralFunnel()` — create-or-get воронки «Реферали» (`kind:"referral"`) з канонічними
    стадіями `new → contacted → interview → hired → rejected` (KEYS load-bearing: convert/bonus
    залежать від `hired`).
  - `backfillOrphanReferralCandidates(funnelId)` — підтягує кандидатів із `funnel_id IS NULL AND
    referrer_worker_id IS NOT NULL` у реферальну воронку (ідемпотентно).
- [index.ts](../artifacts/api-server/src/index.ts) — на старті викликає обидві (ensure + backfill);
  **самовідновлення без ручного psql**.
- [bot/index.ts](../artifacts/api-server/src/bot/index.ts) — реферал-вставка тепер ставить
  `funnelId: await ensureReferralFunnel()`.

**Підтверджено на проді (логи старту):** `Created built-in referral funnel` (funnelId=1) +
`Backfilled orphan referral candidates count:1` → зниклий реферал відновлено. БД: `refFunnels=1`,
`orphanReferrals=0`.

---

## Задача 2 — аванс: ліміт + причина відхилення (доробка наявної фічі)

> Сама фіча авансів вже існувала (паралельний чат): таблиця `advance_requests`, `GET /advances` +
> `/advances/:id/{approve,reject,paid}`, веб `Advances.tsx`, бот-флоу `advance:*`, меню «💰 Аванс».
> Бракувало лише двох речей нижче.

**Ліміт 1/день, 3/місяць:**
- [bot/index.ts](../artifacts/api-server/src/bot/index.ts) `adv:new` — рахує запити працівника за
  сьогодні / поточний місяць (**усі статуси**, по **Europe/Warsaw**); ≥1/день або ≥3/міс → дружнє
  повідомлення, запит не створюється.
- i18n `adv.limitDay` / `adv.limitMonth` (5 мов).

**Причина відхилення (опційна):**
- API вже зберігав `adminNote` у `decideAdvance` (приймає `body.note`).
- [Advances.tsx](../artifacts/web/src/pages/Advances.tsx) — «Відхилити» → модалка з полем причини →
  `POST /advances/:id/reject { note }`; причина показується на відхилених рядках.
- [bot/index.ts](../artifacts/api-server/src/bot/index.ts) — inline «❌ Відхилити» тепер питає
  причину (стан `advance:reject_reason`, `/skip` щоб пропустити).
- [notify.ts](../artifacts/api-server/src/bot/notify.ts) `notifyWorkerAdvance(…, note?)` — додає
  причину в сповіщення про відхилення (через `mdSafe`); `decideAdvance` передає `adminNote`.
- i18n: web (4 ключі), bot BOT_EN (2 адмін-рядки).

**Дефолти (узгоджено):** ліміт рахує всі статуси; причина опційна; bot inline reject теж питає причину.

---

## Файли (коміт `f2eeaad`)
```
NEW artifacts/api-server/src/services/funnels.ts
    artifacts/api-server/src/index.ts            (startup ensure+backfill)
    artifacts/api-server/src/bot/index.ts        (funnelId, ліміт, reject-reason flow)
    artifacts/api-server/src/bot/notify.ts        (reason у сповіщенні)
    artifacts/api-server/src/routes/admin-api.ts (передача adminNote)
    artifacts/web/src/pages/Advances.tsx          (модалка причини)
    artifacts/api-server/src/bot/i18n.ts          (ліміти + 2 EN)
    artifacts/web/src/lib/i18n.tsx                (4 ключі)
```
**Схема БД не змінювалась.** typecheck + білди (api+web) чисті.

---

## Що знати наступній сесії
- **Реферальна воронка тепер гарантована** — `ensureReferralFunnel()` на старті створює її, якщо
  немає. Якщо колись побачиш «реферали не на сайті» — перевір `select * from funnels where
  kind='referral'` і `candidates.funnel_id`.
- **Прод-урок:** `deploy/schema.sql` — лише структура (без сід-даних), тож будь-які «вбудовані»
  рядки (як реферальна воронка) треба створювати кодом на старті, а не покладатися на сід.
- **Ліміт авансу** рахує всі статуси (включно з rejected) у Warsaw-календарі — якщо захочуть не
  рахувати відхилені, міняти у `adv:new`.
- **Причина відхилення** — опційна (можна `/skip` у боті, лишити порожнім у вебі).
- Не зламати: один polling-інстанс; PII/секрети не логувати; `mdSafe` для вільного тексту в Markdown.
- Живий смоук Задачі 2 (двічі попросити аванс → блок; відхилити з причиною → працівнику приходить) —
  рекомендовано виконати вручну.

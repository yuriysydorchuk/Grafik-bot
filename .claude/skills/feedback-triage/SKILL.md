---
name: feedback-triage
description: Розібрати зголошення проблем і побажань з веб-панелі Grafik-bot — зчитати відкриті з проду read-only, звірити з кодом, дати вердикти (треба / не треба / уже є / дубль / уточнити), скласти план батчів для узгодження, а після реалізації й деплою записати файл результату для імпорту на /feedback. Use when the user asks розібрати зголошення, проаналізувати фідбек/баги з панелі, тріаж, що там назголошували, or wants a plan from user-reported issues.
---

# Тріаж зголошень з панелі

Модуль: `docs/tasks/2026-10-29-feedback-module.md`. Користувачі зголошують із віджета, усе лежить у `feedback_reports` (+ вкладення в `uploads/feedback/`). Цей скіл — цикл «пакет → аналіз → узгодження → реалізація → результат».

## 1. Зібрати пакет (read-only)

Варіант А — з проду одним ssh (SSH рейт-лімітиться, НЕ дробити):

```bash
mkdir -p docs/feedback/inbox/shots
D=$(date +%F)
ssh grafik 'cd /root/grafik-bot && export $(grep -E "^DATABASE_URL=" .env) && psql "$DATABASE_URL" -tA -f deploy/feedback-pack.sql' > docs/feedback/inbox/pack-$D.json
# скріншоти/піни лише для зголошень з пакета
FILES=$(node -e 'const p=require("./docs/feedback/inbox/pack-'$D'.json");console.log(p.reports.flatMap(r=>r.attachments.map(a=>a.path)).join(" "))')
[ -n "$FILES" ] && ssh grafik "cd /root/grafik-bot/uploads/feedback && tar cf - $FILES" | tar xf - -C docs/feedback/inbox/shots
```

Варіант Б — Yuriy скачав «📦 Пакет для Claude» на /feedback → розпакувати ZIP у `docs/feedback/inbox/` (`feedback.json` + `shots/`).

`docs/feedback/inbox/` — gitignored (персональні дані, скріншоти). Пакет дивись лише локально; в зовнішні агенти (agy/codex) його не слати — лише код і diff.

## 2. Аналіз (кожне зголошення окремо, потім групування)

Для кожного `report`:
1. **Де причина.** Сторінка (`page.path`/`label`), фільтри, пін (`attachments[].meta.selector/text` — знайти кнопку за текстом у `artifacts/web/src/pages/*`), крихти (`breadcrumbs`: клік → запит → статус; `reqId` невдалого запиту → `pino` на проді: `ssh grafik 'grep <reqId> /root/.pm2/logs/grafik-bot-out.log | tail'`), `clientError` (stack з `Schedule.tsx:812` → файл і рядок), `buildVersion` (чи код уже змінено після цієї збірки — `git log <sha>..HEAD -- <файл>`).
2. **Вердикт:** `треба` / `не треба` (суперечить правилу CLAUDE.md або рішенню власника — назвати яке) / `уже є` (де саме в UI) / `дубль #N` / `уточнити` (чого бракує для рішення, запитання автору одним реченням).
3. **Обсяг і ризик:** S (≤1 год) / M (пів дня) / L (день+); ризик `низький / середній / високий` (фінанси, схема БД, легальність → завжди ≥ середній; за `docs/rules/FINANCE_RULES.md`).
4. **Пропозиція:** що саме змінити, у яких файлах, чи потрібна міграція, чи зачіпає скоуп/readOnly/i18n/бот.

Групування: одна причина → один батч (кілька № разом); побажання з найбільшою кількістю голосів — угору; «блокує роботу» — першим.

## 3. Вихід для узгодження

- Артефакт (одна сторінка): таблиця `№ · суть · вердикт · обсяг·ризик · пропозиція`, далі «Пропоновані батчі» (порядок, що входить), «Відкриті питання власнику».
- Той самий зміст у `docs/feedback/triage-<дата>.md` (комітиться; без персональних даних і без скріншотів).
- **Стоп.** Код — лише після рішень Yuriy по вердиктах. Правки вердиктів → оновити той самий артефакт і md.

## 4. Реалізація

Узгоджені батчі — за спекою `docs/tasks/<дата>-<slug>.md` (`TEMPLATE.md`), звичайна верифікація (typecheck/build/тести), `/deploy` за правилами (перед деплоєм — ревʼю diff через `agy` і `codex`).

## 5. Файл результату (після деплою)

`docs/feedback/result-<дата>.json` у форматі імпорту `POST /feedback/admin/import`:

```json
{
  "commit": "abc1234",
  "items": [
    { "id": 48, "status": "fixed", "reply": "Виправлено: після зміни фабрики тиждень лишається вибраний. Оновіть панель (Ctrl+F5).", "triage": { "verdict": "треба", "effort": "S", "risk": "низький", "batch": "2026-11-03-schedule-week" } },
    { "id": 41, "status": "duplicate", "duplicateOfId": 48, "triage": { "verdict": "дубль" } },
    { "id": 29, "status": "exists", "reply": "Ширина колонок уже налаштовується кнопкою ⚙ над таблицею сводної." },
    { "id": 42, "status": "rejected", "reply": "Затвердження всіх фабрик доступне лише головному — правило скоупу (11.10.2026)." },
    { "id": 40, "status": "clarify", "reply": "Чи йдеться лише про zaświadczenia, чи про всі документи фірми?" },
    { "id": 47, "status": "planned", "reply": "Беремо в наступний батч.", "triage": { "verdict": "треба", "effort": "S" } }
  ]
}
```

Статуси: `review | clarify | planned | in_progress | fixed | rejected | duplicate | exists`. `reply` іде автору в бот разом зі статусом; `fixed` додає кнопки «Працює / Досі ні» і пише `commit` у `deployed_commit`. Сказати Yuriy: «імпортуй `docs/feedback/result-<дата>.json` на /feedback → Імпорт результату».

## Заборонено

- Писати в прод-БД по ssh (UPDATE/DELETE) — статуси повертаються лише імпортом файлу в панелі.
- Слати пакет, скріншоти чи імена користувачів у agy/codex/інші агенти.
- Реалізовувати до рішення власника по вердиктах.

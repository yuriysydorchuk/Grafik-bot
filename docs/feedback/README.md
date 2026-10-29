# Зголошення з панелі — пакети й результати тріажу

Модуль: [`docs/tasks/2026-10-29-feedback-module.md`](../tasks/2026-10-29-feedback-module.md). Скіл: `.claude/skills/feedback-triage/SKILL.md`.

```
docs/feedback/
├── inbox/            # gitignored: pack-<дата>.json (або feedback.json з ZIP) + shots/ — персональні дані
├── triage-<дата>.md  # таблиця вердиктів для узгодження (комітиться)
└── result-<дата>.json# файл для «Імпорт результату» на /feedback (комітиться)
```

## Пакет (`pack-*.json` / `feedback.json`)

`{ generatedAt, count, reports: [...] }`, кожен `report`:

| Поле | Зміст |
|---|---|
| `id, kind, severity, status, title` | номер, `bug/wish/question`, `blocks/hinders/minor`, статус |
| `description, steps, expected` | що сталось (або побажання/питання), що робили, що очікували |
| `page` | `{path, label, url, filters, aboutPage}`; `filters.selects` — підписи вибраних select-ів сторінки |
| `origin, clientError` | `widget` / `error` (падіння сторінки) / `api5xx`; `{message, stack, source}` |
| `context` | роль, скоуп, браузер/ОС, екран, тема, мова, `failedRequests[{method,path,status,reqId}]`, `consoleErrors[]` |
| `breadcrumbs` | `[{t, type: click|nav|api|error|console|rec|input, text, status?, ms?, reqId?}]` — останні 5 хв або від маркера запису |
| `buildVersion` | `sha7 дата` збірки, з якої зголошено |
| `author` | `{id, name, role}` |
| `attachments` | `[{id, kind: screenshot|pin|upload, path|file, name, mime, meta}]`; пін: `meta.selector/text/tag/rect` |
| `comments` | `[{at, by, kind: comment|answer|question|system, via, body}]` |
| `votes, duplicateOfId, taskId, triage, reply` | голоси «у мене теж», звʼязки, попередній тріаж |

## Результат (`result-*.json`)

`{ commit?: "sha7", items: [{ id, status?, reply?, duplicateOfId?, triage?: {verdict, effort, risk, note, batch} }] }` — застосовується кнопкою «Імпорт результату» (лише головний адмін): статус + тріаж + відповідь автору в бот; `fixed` → запит підтвердження автору й `deployed_commit = commit`.

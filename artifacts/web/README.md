# @workspace/web

Веб-панель адміністратора системи **Grafik-bot** — React 19 + Vite + Tailwind v4. Загальний огляд системи — у [`/CLAUDE.md`](../../CLAUDE.md).

## Стек

- **React 19** + **Vite 7** (збірка/HMR)
- **Tailwind CSS v4** (через `@tailwindcss/vite`)
- **wouter** — роутинг
- **@tanstack/react-query** — серверний стан/кеш
- **lucide-react** — іконки, **sonner** — тости, **recharts** — графіки
- TypeScript strict

## Структура

```
src/
├── main.tsx        точка входу (монтування, провайдери)
├── App.tsx         роути (wouter), гард за роллю
├── index.css       Tailwind
├── pages/          сторінки панелі
│   ├── Dashboard, Schedule, Orders, Availability, Workers, WorkerDetail,
│   ├── Drivers, DriverShifts, Trips, Absences, Reliability, Hours,
│   ├── Finance, Recruitment, Reports, Broadcast, Settings, Admins, Login
├── components/
│   ├── Layout.tsx          каркас + бічна навігація (згортувана) + перемикач мови
│   ├── ui.tsx              базові UI-примітиви (Button, Input, Select, Card, Badge, Modal…)
│   ├── LiveShifts.tsx, NotificationBell.tsx, WeekSelect.tsx, WeeklyWizard.tsx,
│   ├── DetailModals.tsx, confirm.tsx
└── lib/
    ├── api.ts      fetch-обгортка (get/post/patch/del) + усі типи відповідей API
    ├── roles.ts    мапа можливостей ролей owner|scheduler|driver + can()/canAccessPage()
    ├── i18n.tsx    двомовність uk/en (LangProvider, useT) — «укр-рядок-як-ключ»
    ├── colors.ts   палітра + повні Tailwind-класи (dotClass/topClass/badgeClass), K/M-хелпери статі
    ├── dates.ts    робота з тижнями/датами
    └── hooks.ts    usePersisted, useMe тощо
```

## Запуск і збірка

```bash
pnpm --filter @workspace/web run dev        # Vite dev-сервер (HMR); проксі/запити йдуть на /api
pnpm --filter @workspace/web run build      # → artifacts/web/dist (її віддає api-server)
pnpm --filter @workspace/web run typecheck  # tsc --noEmit
pnpm --filter @workspace/web run preview     # локальний перегляд збірки
```

У проді **немає окремого хостингу**: `build` кладе статику в `dist/`, а `@workspace/api-server` віддає її same-origin зі SPA-fallback.

## Як спілкується з API

Усі запити — через `lib/api.ts` (тонка обгортка над `fetch`, same-origin `/api/*`, із сесійним cookie `grafik_session`). Згенерованого клієнта немає — типи відповідей описані вручну поруч із запитами. Кешування/інвалідація — через React Query (`useQuery`/`useMutation` + `queryClient.invalidateQueries`).

## Ролі та доступи

`lib/roles.ts` дублює мапу можливостей бекенду (`owner | scheduler | driver`). `App.tsx` і `Layout.tsx` ховають/гардять маршрути за роллю; фінансові дані видно лише owner. Призначення ролей — лише для головного адміна (`is_main`).

## i18n

`lib/i18n.tsx`: компонент-провайдер + `useT()`. Ключ перекладу — **сам український рядок**; англійський словник містить пари uk→en. Додаючи текст:
1. пиши українською в JSX через `t("…")`;
2. додай EN-переклад у словник `i18n.tsx`;
3. перевір дублі ключів: `grep -oE '^  "[^"]+":' src/lib/i18n.tsx | sort | uniq -d` (дублі → TS1117).

## Tailwind v4 — застереження

Сканер бачить лише **буквальні** класи в коді. Динамічні `bg-${color}-500` не працюють — повні рядки класів виписані в `lib/colors.ts`. Додаючи новий колір/відтінок для бейджів/крапок — додай його туди повністю.

# Core Architecture & Invariants

## 1. Monorepo Stack
- **Package Manager:** `pnpm` workspaces (`pnpm run typecheck`, `pnpm run build`).
- **Backend:** Express 5 (`artifacts/api-server`), Node 20+, Pino logger, multer memory storage.
- **Frontend:** React 19, Vite, Tailwind CSS, Lucide icons, Sonner toasts, Wouter router (`artifacts/web`).
- **Database:** PostgreSQL with Drizzle ORM (`lib/db/src/schema/`). Migrations stored in `deploy/migrations/`.
- **Testing:** Node test runner (`node:test`). Run via `pnpm --filter @workspace/api-server run test`.

## 2. Authentication & Authorization
- **Session Auth:** Cookie-based sessions with CSRF protection headers (`x-requested-with`).
- **Telegram 2FA:** 6-digit codes sent via bot.
- **Role Capabilities:** `canAccessPage(me, path)`, `requireAnyCap(...)` middleware.

## 3. UI/UX Principles
- **Design Aesthetic:** High-density SaaS (Stripe/Monobank style), neutral slate tones, subtle borders, responsive collapsible sidebar rail.
- **Localization (i18n):** Ukrainian is the canonical source key in `useT()`. English (`EN`) and Russian (`RU`) dictionaries defined in `artifacts/web/src/lib/i18n.tsx`.

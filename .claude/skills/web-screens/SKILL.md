---
name: web-screens
description: Подивитись на веб-панель Grafik-bot «очима» — зробити скріншот залогіненої сторінки headless-Chrome і проаналізувати рендер. Use when the user asks зробити скрін панелі / перевірити як виглядає сторінка, and ALWAYS after significant UI changes — verify the rendered result visually before handing off.
---

# Скріни веб-панелі (локальний pm2)

Скріншоти залогіненої адмінпанелі локального процесу `grafik-bot` (http://localhost:8080) системним Chrome через playwright-core. Мета — **дивитись на результат UI-правок очима**: накладання/обрізання тексту, переноси, порожні стани, темна тема, мобільна ширина.

## Передумови

- Локальний pm2 онлайн (`pm2 list`). Веб-статика віддається з диска: для веб-правок досить `pnpm --filter @workspace/web run build` (рестарт НЕ потрібен); для бекенд-правок — build api-server + `pm2 restart grafik-bot`.
- playwright-core у scratch-теці сесії (НЕ в репо): `npm i playwright-core`.
- Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

## Крок 1 — сесія (одноразовий cookie-токен)

Скрипт створює рядок у **локальній** `admin_sessions` і підписує cookie локальним `SESSION_SECRET`. Класифікатор безпеки може блокувати запуск (виглядає як само-видача доступу) — за потреби попроси в користувача явне «роби» (Yuriy уже схвалював цей механізм 28.08.2026).

Запиши в `artifacts/api-server/scratch-screenshot-session.mjs` (мусить лежати саме там — резолвить `@workspace/db`) і запусти `node --env-file=../../.env scratch-screenshot-session.mjs`:

```js
import { db, pool, adminsTable, adminSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createHmac, randomBytes } from "node:crypto";
const SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const [admin] = await db.select().from(adminsTable).where(eq(adminsTable.id, 1));
const sid = randomBytes(16).toString("hex");
await db.insert(adminSessionsTable).values({ id: sid, adminId: admin.id, device: "screenshot-script", ip: "127.0.0.1" });
const payload = { adminId: admin.id, name: admin.name ?? "Yuriy", role: admin.role ?? "owner", exp: Date.now() + 24 * 3600 * 1000, tv: admin.tokenVersion ?? 0, sid };
const body = b64url(Buffer.from(JSON.stringify(payload)));
console.log("TOKEN=" + `${body}.${createHmac("sha256", SECRET).update(body).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`);
await pool.end();
```

Не імпортуй `src/lib/auth.ts` — його безрозширенні імпорти не резолвляться під raw Node; HMAC інлайном.

## Крок 2 — скріншот

`shot.mjs` у scratch-теці; `GRAFIK_TOKEN=<токен> node shot.mjs /workers/66 out.png`:

```js
import { chromium } from "playwright-core";
const TOKEN = process.env.GRAFIK_TOKEN;
const path = process.argv[2] ?? "/";                 // маршрут панелі, напр. /workers/66
const out = process.argv[3] ?? "shot.png";
const dark = process.env.DARK === "1";
const mobile = process.env.MOBILE === "1";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const ctx = await browser.newContext({
  viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  deviceScaleFactor: 1.5, colorScheme: dark ? "dark" : "light",
});
await ctx.addCookies([{ name: "grafik_session", value: TOKEN, domain: "localhost", path: "/" }]);
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://localhost:8080${path}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: out, fullPage: true });
console.log("saved", out, "console errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
```

Прапорці: `DARK=1` — темна тема (клас `dark` панель ставить сама за prefers-color-scheme), `MOBILE=1` — телефонна ширина.

## Крок 3 — ДИВИСЬ і ітеруй

1. Прочитай PNG (Read) і чесно перевір: тексти не налазять і не обрізаються, дати не ламаються на два рядки, порожні стани компактні, скрол-контейнери працюють, `console errors: none`.
2. Знайшов дефект → правка → `pnpm --filter @workspace/web run build` → новий скрін. Дві-три ітерації — норма.
3. Для порівняння варіантів дизайну з користувачем — вбудуй скріни (через `sips --resampleWidth 1100` + base64) в Artifact.

## Крок 4 — прибирання

Відклич сесію (UPDATE у локальній БД): scratch-скрипт з
`db.update(adminSessionsTable).set({ revokedAt: sql`now()` }).where(eq(adminSessionsTable.id, "<sid>"))`.
Токен і так помирає за 24 год, але чисто — краще.

## Граблі

- 401 і порожня сторінка → сесію відкликано/протухла; мінт нову (крок 1).
- Скрін «до» правок → веб не перезібраний (статика з диска) або (для бекенд-змін) не зроблений `pm2 restart grafik-bot`.
- Порожні дані на сторінці → вибери «багатого» працівника scratch-запитом (порожній профіль теж корисно глянути — стан empty).
- Локальна БД ≠ прод: id і назви різняться (памʼятка local/prod id drift).

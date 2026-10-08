-- 08.10.2026 — роль «Власник (перегляд)»: бачить усі фінансові дані, нічого не редагує.
-- Прапорець "readOnly" у caps (lib/roles.ts READ_ONLY) — сервер (authRequired) відхиляє
-- будь-яку мутацію такої ролі; бот — без офісного меню (лише коди входу).
-- editData потрібен лише для ЧИТАННЯ /hours, /advances, /reports (їхні GET-и під editData);
-- мутації все одно блокує readOnly. Схема не змінюється.

-- Сід ролі (ідемпотентно; якщо власник уже правив роль — не чіпаємо).
INSERT INTO roles (key, label, is_system, pages, caps, notify, sort_order)
VALUES ('owner_view', 'Власник (перегляд)', false,
        '["/", "/finance", "/bank", "/cash", "/cashflow", "/cfo", "/analytics", "/balance", "/obligations",
          "/cost-invoices", "/pnl", "/payroll", "/svodni", "/advances", "/penalties", "/hours", "/reports",
          "/hostels", "/fuel", "/cleaning", "/transport", "/workers"]'::jsonb,
        '["readOnly", "editData", "viewFinance", "factoryRates", "svodni", "svodniSensitive", "costInvoices",
          "fuel", "hostelOps", "cleaning", "viewWorkers", "workerPay"]'::jsonb,
        '[]'::jsonb, 60)
ON CONFLICT (key) DO NOTHING;

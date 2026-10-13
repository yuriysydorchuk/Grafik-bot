-- 13.10.2026 — роль «Dyrektor - Łódź/Poznań»: капи як у «Dyrektor - Lublin», сторінки — лише ті, що
-- вміє скоуп міст (lib/scope.ts SCOPE_RULES, вкл. сводну з цього релізу). Обмеження по містах — на адміні
-- (admins.scope_cities = ["Лодзь","Познань"]), ставиться при запрошенні з /admins. Ідемпотентно.
INSERT INTO roles (key, label, is_system, pages, caps, notify, sort_order)
VALUES ('dyrektor-lodz-poznan', 'Dyrektor - Łódź/Poznań', false,
        '["/", "/svodni", "/workers", "/schedule", "/availability", "/hours", "/absences", "/reliability", "/broadcast", "/tasks", "/workers-calendar", "/advances", "/legalization", "/signup-links", "/factories", "/clothing", "/contracts", "/document-templates"]'::jsonb,
        '["editData", "svodni", "svodniSensitive", "assignDrivers", "viewFinance", "factoryRates", "legalization", "tasksGroup", "tasksManage", "workerDocs", "signupLinks"]'::jsonb,
        '["no_show", "cancellation", "hours_correction", "advance", "substitution", "availability_change", "absence_warning", "weekly_summary", "tasks"]'::jsonb,
        5)
ON CONFLICT (key) DO NOTHING;

-- MAKARUK (закрита фабрика Любліна) без міста випадала з усіх скоупів — місто власник підтвердив 13.10.2026.
UPDATE factories SET city = 'Люблін' WHERE upper(name) = 'MAKARUK' AND (city IS NULL OR city = '');

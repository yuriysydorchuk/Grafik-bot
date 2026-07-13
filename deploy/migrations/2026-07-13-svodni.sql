-- Сводні (повне дзеркало зарплатних таблиць по містах) — крок 1.
-- svodni_rows: рядок «людина × фабрика × місяць» з усіма колонками таблиці;
-- svodni_tab_checks: контроль сум вкладки (наші рядки vs SUMA vs зведення);
-- workers.hourly_rate_netto: справжня netto-ставка (пари brutto/netto нестандартні).

CREATE TABLE IF NOT EXISTS svodni_rows (
    id serial PRIMARY KEY,
    period_month text NOT NULL,                -- 'YYYY-MM'
    city text NOT NULL,                        -- Люблін | Познань | Лодзь
    firm text,                                 -- ES | ESO | Klinex (де відомо)
    factory_label text NOT NULL,               -- назва вкладки-фабрики
    factory_id integer REFERENCES factories(id),
    source_id integer REFERENCES payroll_sources(id),
    sort_idx integer NOT NULL DEFAULT 0,
    section text,                              -- секція в таблиці (KOBIETY / NIE OPODATKOWANE / …)
    raw_name text NOT NULL,
    worker_id integer REFERENCES workers(id),
    link_status text NOT NULL DEFAULT 'unmatched',  -- auto | confirmed | unmatched | external
    -- спільні колонки (відкритий шар)
    hours_notified real,                       -- години у повідомленні
    hours real,                                -- фактичні години
    shifts real,
    rate_brutto real,
    rate_netto real,
    premia real,                               -- сумарна премія рядка
    zaliczka real,
    zaliczka_bd real,
    hostel real,
    odziez real,
    dojazd real,
    kara real,
    komornik real,
    kaucja real,
    potracenia real,
    do_wyplaty real,                           -- повне netto до виплати
    brutto real,
    -- закритий шар (księgowość / готівка) — віддається лише з capability svodniSensitive
    hours_declared real,                       -- години «по księgowości»
    ksieg_brutto real,
    ksieg_netto real,
    gotowka real,
    konto real,
    is_student boolean,
    under_26 boolean,
    extras jsonb NOT NULL DEFAULT '{}',        -- фабричні нюанси (нічні, водійські, migawka, Ew., …)
    hr jsonb NOT NULL DEFAULT '{}',            -- кадрове (zaświadczenia, умова, дати)
    sheet_values jsonb NOT NULL DEFAULT '{}',  -- що стояло в клітинках (для звірки/аудиту)
    mismatch jsonb,                            -- розбіжності наш перерахунок vs таблиця (null = ок)
    created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS svodni_rows_month_city ON svodni_rows (period_month, city);
CREATE INDEX IF NOT EXISTS svodni_rows_worker ON svodni_rows (worker_id);
CREATE INDEX IF NOT EXISTS svodni_rows_source ON svodni_rows (source_id);

CREATE TABLE IF NOT EXISTS svodni_tab_checks (
    id serial PRIMARY KEY,
    period_month text NOT NULL,
    city text NOT NULL,
    firm text,
    factory_label text NOT NULL,
    metric text NOT NULL,                      -- hours | do_wyplaty | gotowka | zaliczka | …
    ours real,                                 -- сума наших рядків
    sheet_suma real,                           -- рядок SUMA у вкладці
    summary_tab real,                          -- GODZIN MIESIĘCZNIE / Total Miesiąc
    ok boolean NOT NULL,
    note text,
    created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS svodni_tab_checks_month_city ON svodni_tab_checks (period_month, city);

ALTER TABLE workers ADD COLUMN IF NOT EXISTS hourly_rate_netto real;

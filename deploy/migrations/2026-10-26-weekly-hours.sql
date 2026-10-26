-- Тижневий облік годин (26.10.2026, рішення власника): фабрика без довозу, де працівник
-- сам відмічає старт/кінець зміни кнопками в боті, у понеділок подає години за минулий
-- тиждень Пн–Нд (зміни по днях + тотал + фото рапорту), а фабрика шле години по тижнях.
-- Місячні monthly_reports / factory_hours для таких фабрик виводяться з тижнів по датах.
-- Ідемпотентна, даних не чіпає.
ALTER TABLE factories ADD COLUMN IF NOT EXISTS weekly_hours boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS worker_shift_logs (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id),
  entry_id integer REFERENCES schedule_entries(id) ON DELETE SET NULL,
  work_date date NOT NULL,
  shift text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  prompt_sent_at timestamp,
  prompt_chat_id text,
  prompt_message_id integer,
  end_chat_id text,
  end_message_id integer,
  started_at timestamp,
  start_source text,
  ended_at timestamp,
  end_source text,
  hours real,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_shift_logs_entry_uniq ON worker_shift_logs(entry_id);
CREATE INDEX IF NOT EXISTS worker_shift_logs_worker_date_idx ON worker_shift_logs(worker_id, work_date);

CREATE TABLE IF NOT EXISTS weekly_reports (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id),
  week_start date NOT NULL,
  days jsonb,
  hours_reported real,
  photo_link text,
  request_sent_at timestamp,
  remind_sent_at timestamp,
  submitted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS weekly_reports_worker_factory_week_uniq ON weekly_reports(worker_id, factory_id, week_start);

CREATE TABLE IF NOT EXISTS factory_week_hours (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id),
  week_start date NOT NULL,
  hours real NOT NULL,
  days jsonb,
  source text NOT NULL DEFAULT 'manual',
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_week_hours_worker_factory_week_uniq ON factory_week_hours(worker_id, factory_id, week_start);

-- Умови: статус оплати і спосіб оплати на записах місяців (agreement_charges) —
-- кшєнгова відмічає «оплачено» / переказ-готівка так само, як на фактурах.
-- payment_method на самій умові — дефолт для всіх місяців (charge NULL = наслідує).
ALTER TABLE agreement_conditions ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE agreement_charges ADD COLUMN IF NOT EXISTS paid boolean NOT NULL DEFAULT false;
ALTER TABLE agreement_charges ADD COLUMN IF NOT EXISTS paid_date date;
ALTER TABLE agreement_charges ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE agreement_charges ADD COLUMN IF NOT EXISTS cash_report boolean NOT NULL DEFAULT false;

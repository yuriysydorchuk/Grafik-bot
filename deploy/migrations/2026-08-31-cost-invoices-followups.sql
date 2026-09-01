-- Умови: сума завжди брутто (vat_included/gross_amount прибрані — жодного
-- розрахунку net→gross не було й не буде), vat_rate — інформаційний тег
-- '23' | '8' | 'zw' (zwolnione), не число.
ALTER TABLE agreement_conditions DROP COLUMN IF EXISTS vat_included;
ALTER TABLE agreement_conditions DROP COLUMN IF EXISTS gross_amount;
ALTER TABLE agreement_conditions ALTER COLUMN vat_rate DROP DEFAULT;
ALTER TABLE agreement_conditions ALTER COLUMN vat_rate TYPE text USING vat_rate::text;
UPDATE agreement_conditions SET vat_rate = '23' WHERE vat_rate NOT IN ('23', '8', 'zw');
ALTER TABLE agreement_conditions ALTER COLUMN vat_rate SET DEFAULT '23';

-- KSeF-фактури: ручна нотатка кшєнгової (як invoices.note) — бейдж+tooltip на /cost-invoices
ALTER TABLE ksef_invoices ADD COLUMN IF NOT EXISTS note text;

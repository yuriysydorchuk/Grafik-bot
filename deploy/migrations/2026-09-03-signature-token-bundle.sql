-- Комплект (факторі-пакет + сталий пакет, згенеровані разом) підписується
-- ОДНІЄЮ сесією — токен несе список "сусідніх" contractId, надісланих і
-- підписаних разом з основним contractId.
ALTER TABLE signature_tokens ADD COLUMN IF NOT EXISTS extra_contract_ids jsonb;

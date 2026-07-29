-- Авто-помітка авансів «виплачено» по факту банківського переказу:
-- трасування до транзакції (set null, бо API-рядки заміщаються витягом).
ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS paid_txn_id integer REFERENCES bank_transactions(id) ON DELETE SET NULL;

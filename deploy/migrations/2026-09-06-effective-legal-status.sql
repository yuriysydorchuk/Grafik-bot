-- Резолвер виплат (06.09.2026): ефективний статус легалізації для listy płac.
-- worker_legality: пише движок після кожного перерахунку (повністю оформлений за
-- документами → статус із документів, інакше ручне workers.legal_status).
-- svodni_rows: снапшот статусу/джерела на момент формування рядка.
ALTER TABLE worker_legality ADD COLUMN IF NOT EXISTS effective_legal_status text;
ALTER TABLE worker_legality ADD COLUMN IF NOT EXISTS effective_source text;
ALTER TABLE worker_legality ADD COLUMN IF NOT EXISTS effective_since date;
ALTER TABLE svodni_rows ADD COLUMN IF NOT EXISTS legal_status text;
ALTER TABLE svodni_rows ADD COLUMN IF NOT EXISTS legal_source text;

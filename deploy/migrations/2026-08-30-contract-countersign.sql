-- Компанія підписує умову ЛИШЕ після працівника (нове бізнес-правило,
-- worker-docs-signing): статус worker_signed з'являється між "sent" і
-- фінальним "signed"; ці два поля фіксують, коли й хто завершив підпис від
-- компанії (finalizeContractSignature). Адитивно, без зміни наявних даних.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS company_signed_by integer REFERENCES admins(id);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS company_signed_at timestamp;

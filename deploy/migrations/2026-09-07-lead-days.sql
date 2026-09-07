-- Строки легалізації (рішення власника 07.09.2026): жовта зона 24 дн., червона 7 дн. —
-- єдине джерело правило defaults.lead_days (defaultLeadDays / urgentDays). Власні строки
-- типів документів (60/90 для карт тощо) знімаються — усі йдуть за правилом; правило задач
-- doc_expiring теж читає правило (lead_days NULL).
UPDATE legal_rules
   SET conditions = conditions || '{"defaultLeadDays": 24, "urgentDays": 7, "documents": [24, 14, 7, 0], "cases": 24}'::jsonb
 WHERE code = 'defaults.lead_days' AND is_active;
UPDATE document_types SET renewal_lead_days = NULL WHERE renewal_lead_days IS NOT NULL;
UPDATE task_auto_rules SET lead_days = NULL WHERE code = 'doc_expiring';

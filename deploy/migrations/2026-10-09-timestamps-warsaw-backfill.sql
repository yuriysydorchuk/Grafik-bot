-- Конвенція часу БД (рішення власника 09.10.2026): `timestamp` = настінний час Europe/Warsaw.
-- До цього Drizzle писав JS-дати в UTC-настінному (toISOString), а DB-дефолти now() — у настінному
-- сесії (Berlin = Warsaw): у одній таблиці created_at і updated_at лежали в різних поясах (1–2 год).
-- Код з цього дня мапить усі timestamp-колонки у Warsaw (lib/db/src/warsawTime.ts); цей бекфіл
-- переводить ІСТОРИЧНІ JS-записані значення UTC→Warsaw (DST по кожному рядку через AT TIME ZONE):
--   • колонки без DB-дефолту (пише лише код) — усі рядки;
--   • updated_at — лише рядки, де updated_at <> created_at (оновлені кодом; дефолтні не чіпаємо);
--   • колонки, що їх пише SQL now()/DB-дефолт (revoked_at і last_seen_at сесій, review_dismissed_at,
--     restored_at, created_at, *_at подій/імпортів) — не чіпаємо; document_templates.updated_at теж
--     (міграція 2026-09-11-swiadectwo-off писала now()); user_states.updated_at — завжди код (upsert), усі рядки.
-- Ідемпотентно: маркер у settings; повторний прогін — no-op (подвійний зсув був би помилкою).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM settings WHERE key = 'tz_backfill_warsaw_2026_10') THEN
    RAISE NOTICE 'tz backfill already applied — skip';
    RETURN;
  END IF;

  -- колонки без DB-дефолту (лише код)
  UPDATE advance_requests SET decided_at = (decided_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE decided_at IS NOT NULL;
  UPDATE advance_requests SET paid_at = (paid_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE paid_at IS NOT NULL;
  UPDATE availability SET submitted_at = (submitted_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE submitted_at IS NOT NULL;
  UPDATE bank_api_accounts SET balance_at = (balance_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE balance_at IS NOT NULL;
  UPDATE bank_api_accounts SET last_sync_at = (last_sync_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE last_sync_at IS NOT NULL;
  UPDATE bank_api_consents SET expiry_warned_at = (expiry_warned_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE expiry_warned_at IS NOT NULL;
  UPDATE bank_api_consents SET revoked_at = (revoked_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE revoked_at IS NOT NULL;
  UPDATE bank_api_consents SET valid_until = (valid_until AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE valid_until IS NOT NULL;
  UPDATE candidates SET next_action_at = (next_action_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE next_action_at IS NOT NULL;
  UPDATE contracts SET approved_at = (approved_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE approved_at IS NOT NULL;
  UPDATE contracts SET company_signed_at = (company_signed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE company_signed_at IS NOT NULL;
  UPDATE contracts SET expiry_warned_at = (expiry_warned_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE expiry_warned_at IS NOT NULL;
  UPDATE contracts SET first_viewed_at = (first_viewed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE first_viewed_at IS NOT NULL;
  UPDATE contracts SET generated_at = (generated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE generated_at IS NOT NULL;
  UPDATE contracts SET sent_at = (sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE sent_at IS NOT NULL;
  UPDATE contracts SET signed_at = (signed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE signed_at IS NOT NULL;
  UPDATE contracts SET superseded_at = (superseded_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE superseded_at IS NOT NULL;
  UPDATE driver_trips SET arrived_factory_at = (arrived_factory_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE arrived_factory_at IS NOT NULL;
  UPDATE driver_trips SET pickup_started_at = (pickup_started_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE pickup_started_at IS NOT NULL;
  UPDATE driver_workdays SET ended_at = (ended_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE ended_at IS NOT NULL;
  UPDATE driver_workdays SET started_at = (started_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE started_at IS NOT NULL;
  UPDATE factory_hours SET ask_sent_at = (ask_sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE ask_sent_at IS NOT NULL;
  UPDATE factory_hours SET worker_response_at = (worker_response_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE worker_response_at IS NOT NULL;
  UPDATE hours_disputes SET resolved_at = (resolved_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE resolved_at IS NOT NULL;
  UPDATE invoices SET drive_synced_at = (drive_synced_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE drive_synced_at IS NOT NULL;
  UPDATE ksef_invoices SET drive_synced_at = (drive_synced_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE drive_synced_at IS NOT NULL;
  UPDATE legal_rules SET verified_at = (verified_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE verified_at IS NOT NULL;
  UPDATE passport_scan_tokens SET expires_at = (expires_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE expires_at IS NOT NULL;
  UPDATE passport_scan_tokens SET used_at = (used_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE used_at IS NOT NULL;
  UPDATE payroll_folders SET last_sync_at = (last_sync_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE last_sync_at IS NOT NULL;
  UPDATE payroll_sources SET last_sync_at = (last_sync_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE last_sync_at IS NOT NULL;
  UPDATE schedule_approvals SET approved_at = (approved_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE approved_at IS NOT NULL;
  UPDATE schedule_entries SET absence_explained_at = (absence_explained_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE absence_explained_at IS NOT NULL;
  UPDATE schedule_entries SET sent_at = (sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE sent_at IS NOT NULL;
  UPDATE schedule_weeks SET approved_at = (approved_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE approved_at IS NOT NULL;
  UPDATE signature_tokens SET expires_at = (expires_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE expires_at IS NOT NULL;
  UPDATE signature_tokens SET revoked_at = (revoked_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE revoked_at IS NOT NULL;
  UPDATE signature_tokens SET used_at = (used_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE used_at IS NOT NULL;
  UPDATE sms_campaigns SET finished_at = (finished_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE finished_at IS NOT NULL;
  UPDATE sms_campaigns SET started_at = (started_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE started_at IS NOT NULL;
  UPDATE sms_recipients SET bot_at = (bot_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE bot_at IS NOT NULL;
  UPDATE sms_recipients SET delivered_at = (delivered_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE delivered_at IS NOT NULL;
  UPDATE sms_recipients SET sent_at = (sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE sent_at IS NOT NULL;
  UPDATE sms_recipients SET viewed_at = (viewed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE viewed_at IS NOT NULL;
  UPDATE task_assignees SET responded_at = (responded_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE responded_at IS NOT NULL;
  UPDATE tasks SET completed_at = (completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE completed_at IS NOT NULL;
  UPDATE tasks SET escalated_at = (escalated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE escalated_at IS NOT NULL;
  UPDATE worker_documents SET expiry_warned_at = (expiry_warned_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE expiry_warned_at IS NOT NULL;
  UPDATE worker_documents SET request_reminded_at = (request_reminded_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE request_reminded_at IS NOT NULL;
  UPDATE worker_documents SET requested_at = (requested_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE requested_at IS NOT NULL;
  UPDATE worker_documents SET verified_at = (verified_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE verified_at IS NOT NULL;
  UPDATE worker_legality SET computed_at = (computed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE computed_at IS NOT NULL;
  UPDATE worker_questionnaires SET consents_at = (consents_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE consents_at IS NOT NULL;
  UPDATE worker_questionnaires SET imported_at = (imported_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE imported_at IS NOT NULL;
  UPDATE worker_questionnaires SET submitted_at = (submitted_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE submitted_at IS NOT NULL;
  UPDATE worker_questionnaires SET verified_at = (verified_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE verified_at IS NOT NULL;
  UPDATE workers SET do_not_hire_at = (do_not_hire_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE do_not_hire_at IS NOT NULL;
  UPDATE workers SET fired_at = (fired_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE fired_at IS NOT NULL;
  UPDATE workers SET nationality_verified_at = (nationality_verified_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE nationality_verified_at IS NOT NULL;

  UPDATE user_states SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw';

  -- updated_at: лише оновлені кодом рядки (дефолтне значення = created_at лишається)
  UPDATE agreement_charges SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;
  UPDATE agreement_conditions SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;
  UPDATE contracts SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;
  UPDATE email_templates SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;
  UPDATE factory_hours SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;
  UPDATE sms_campaigns SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;
  UPDATE tasks SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;
  UPDATE worker_documents SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;
  UPDATE worker_family_members SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;
  UPDATE worker_questionnaires SET updated_at = (updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw' WHERE updated_at <> created_at;

  INSERT INTO settings (key, value) VALUES ('tz_backfill_warsaw_2026_10', now()::text);
END $$;

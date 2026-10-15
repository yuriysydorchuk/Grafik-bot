-- Окремі типи документів (запит власника 15.10.2026: «песель, віза і такі документи побиту
-- загружаються в місце для карти побиту — треба окремі місця»):
--   pesel         — скан підтвердження надання номера PESEL (іноземці: окремий слот у профілі);
--                   номер з документа пишеться в workers.pesel, якщо там порожньо (documentEvents.ts);
--   decyzja_pobyt — скан decyzji o zezwoleniu na pobyt: дає побут на строк decyzji, працю — за
--                   статтею (attrs.article, stayArticles.ts) або «dostęp do rynku pracy», як TRC;
--                   статус для виплат — karta_pobytu (legalStatusMap.ts).
-- Дзеркало services/legalizationCatalog.ts (DOCUMENT_TYPE_SEED). Ідемпотентно.
INSERT INTO document_types (code, name, required, has_expiry, sort_order, icon, category, grants_stay, grants_work, requires_employer_match, default_validity_days, renewal_lead_days, applies_to_nationalities, is_system, worker_fields)
VALUES
  ('pesel',         'PESEL (potwierdzenie nadania numeru)',  false, false, 40,  'passport', 'identity', false, false, false, NULL, NULL, NULL, true, '["number"]'::jsonb),
  ('decyzja_pobyt', 'Decyzja o zezwoleniu na pobyt czasowy', false, true,  131, 'decision', 'stay',     true,  false, false, NULL, NULL, '["non_eu"]'::jsonb, true, '["validFrom","expiresAt"]'::jsonb)
ON CONFLICT (code) DO NOTHING;

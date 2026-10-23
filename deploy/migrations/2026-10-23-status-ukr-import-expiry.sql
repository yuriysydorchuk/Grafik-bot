-- Status UKR: імпорт HRappka (21.09.2026) переніс старий кінець спецустави (04.03.2026) у
-- worker_documents.expires_at і поставив status='expired' (дата < сьогодні). У панелі ця дата
-- не показується й не редагується (поле бере правило global.ukr_status_end), а рядок профілю
-- та движок читали саме її → хибне «прострочено» (кейс Hnatiuk, 23.10.2026).
-- Код з цього коміту збережену дату для status_ukr ігнорує; тут чистимо хвіст. Ідемпотентно.
UPDATE worker_documents d
   SET expires_at = NULL,
       status     = CASE WHEN d.status = 'expired' THEN 'present' ELSE d.status END,
       updated_at = now()
  FROM document_types t
 WHERE t.id = d.doc_type_id
   AND t.code = 'status_ukr'
   AND (d.expires_at IS NOT NULL OR d.status = 'expired');

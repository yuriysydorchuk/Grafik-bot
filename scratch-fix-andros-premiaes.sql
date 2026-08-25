-- ANDROS 2026-07: extras.premiaEs (погодинний бонус) вписали як разову премію в зл.
-- Перенос у колонку premia + перерахунок: do_wyplaty -= pes×hours - pes.
-- Розклад: патерн A (konto=ksieg_netto фікс.) → gotowka = do_new - ksieg_netto + doplataEs;
--          патерн B (все на конто: konto=ksieg=do, gotowka 0) → konto=ksieg=do_new.
-- Всі 48 рядків класифіковані заздалегідь (33 A + 14 B + 1 сегментований Balabei).
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE svodni_rows_backup_premiaes_20260814 AS
SELECT * FROM svodni_rows
WHERE (factory_label='ANDROS' AND period_month='2026-07' AND (extras->>'premiaEs') IS NOT NULL)
   OR segment_of = 474;

-- 47 несегментованих батьків
WITH t AS (
  SELECT r.id, (r.extras->>'premiaEs')::numeric pes, coalesce(r.hours,0) h,
         r.do_wyplaty dw, r.konto k, r.gotowka g, r.ksieg_netto kn,
         coalesce((r.extras->>'doplataEs')::numeric,0) dopl
  FROM svodni_rows r
  WHERE r.factory_label='ANDROS' AND r.period_month='2026-07' AND r.segment_of IS NULL
    AND (r.extras->>'premiaEs') IS NOT NULL AND r.id <> 474
)
UPDATE svodni_rows r SET
  premia = coalesce(r.premia,0) + t.pes,
  extras = r.extras - 'premiaEs',
  do_wyplaty = round((t.dw - t.pes*t.h + t.pes)::numeric,2),
  ksieg_netto = CASE WHEN abs(t.k-t.dw)<0.005 AND abs(t.kn-t.dw)<0.005 AND coalesce(t.g,0)=0
    THEN round((t.dw - t.pes*t.h + t.pes)::numeric,2) ELSE r.ksieg_netto END,
  konto = CASE WHEN abs(t.k-t.dw)<0.005 AND abs(t.kn-t.dw)<0.005 AND coalesce(t.g,0)=0
    THEN round((t.dw - t.pes*t.h + t.pes)::numeric,2) ELSE r.konto END,
  gotowka = CASE WHEN abs(t.k-t.dw)<0.005 AND abs(t.kn-t.dw)<0.005 AND coalesce(t.g,0)=0
    THEN t.g ELSE round((t.dw - t.pes*t.h + t.pes - t.kn + t.dopl)::numeric,2) END
FROM t WHERE t.id = r.id;

-- Balabei (порізаний на сегменти, pes=16, 120 год): 5688 - 1920 + 16 = 3784.
-- Премія — у робочий сегмент 642 (0-годинний 641 лише чистимо); Σ сегментів = батько.
UPDATE svodni_rows SET premia=16, extras=extras-'premiaEs',
  do_wyplaty=3784, konto=3784, ksieg_netto=3784
WHERE id=474;
UPDATE svodni_rows SET extras=extras-'premiaEs' WHERE id=641;
UPDATE svodni_rows SET premia=16, extras=extras-'premiaEs',
  do_wyplaty=3784, konto=3784, ksieg_netto=3784
WHERE id=642;

-- само-перевірки: інакше відкат усієї транзакції
DO $$
DECLARE leftover int; psum numeric; dsum numeric;
BEGIN
  SELECT count(*) INTO leftover FROM svodni_rows WHERE (extras->>'premiaEs') IS NOT NULL;
  IF leftover <> 0 THEN RAISE EXCEPTION 'premiaEs лишилась у % рядках', leftover; END IF;
  SELECT sum(premia) INTO psum FROM svodni_rows
    WHERE factory_label='ANDROS' AND period_month='2026-07' AND segment_of IS NULL
      AND id IN (SELECT id FROM svodni_rows_backup_premiaes_20260814);
  IF psum <> 1408 THEN RAISE EXCEPTION 'Σpremia = %, очікував 1408', psum; END IF;
  SELECT round(sum(b.do_wyplaty - r.do_wyplaty)::numeric,2) INTO dsum
  FROM svodni_rows_backup_premiaes_20260814 b JOIN svodni_rows r ON r.id=b.id
  WHERE b.segment_of IS NULL;
  IF dsum <> 213920.00 THEN RAISE EXCEPTION 'Δдо виплати = %, очікував 213920.00', dsum; END IF;
END $$;

COMMIT;

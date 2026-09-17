-- Реферальний код працівника для кампанії «приведи друга» (17.09.2026).
-- Формат ES-XXXXX, алфавіт Crockford base32 (без I L O U — читається по телефону).
-- Бекфіл усім наявним профілям (і звільненим — вони теж запрошують); новим профілям
-- код видається ліниво з коду (lib/referral.ts ensureReferralCode). Ідемпотентно.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS referral_code text;
CREATE UNIQUE INDEX IF NOT EXISTS workers_referral_code_key ON workers (referral_code);

DO $$
DECLARE
  w record;
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  code text;
  i int;
BEGIN
  FOR w IN SELECT id FROM workers WHERE referral_code IS NULL LOOP
    LOOP
      code := 'ES-';
      FOR i IN 1..5 LOOP
        code := code || substr(alphabet, 1 + floor(random() * 32)::int, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM workers WHERE referral_code = code);
    END LOOP;
    UPDATE workers SET referral_code = code WHERE id = w.id;
  END LOOP;
END $$;

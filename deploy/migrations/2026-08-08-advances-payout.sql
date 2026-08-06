-- Аванси: групи виплат «15-го / 30-го» + метод виплати; основний рахунок працівника.
-- Група ставиться при затвердженні за датою рішення (Warsaw): 1–14 → 15-го цього місяця,
-- 15–29 → 30-го цього місяця, 30–31 → 15-го наступного (lib/advancePayout.ts).

ALTER TABLE advance_requests
  ADD COLUMN IF NOT EXISTS payout_month text,
  ADD COLUMN IF NOT EXISTS payout_group text,
  ADD COLUMN IF NOT EXISTS paid_method text;

ALTER TABLE worker_bank_accounts
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

-- один основний рахунок на працівника
CREATE UNIQUE INDEX IF NOT EXISTS worker_bank_accounts_primary_uniq
  ON worker_bank_accounts (worker_id) WHERE is_primary;

-- бекфіл: затверджені/виплачені аванси отримують групу за датою рішення
UPDATE advance_requests SET
  payout_month = CASE
    WHEN extract(day FROM decided_at) >= 30
      THEN to_char(date_trunc('month', decided_at) + interval '1 month', 'YYYY-MM')
    ELSE to_char(decided_at, 'YYYY-MM') END,
  payout_group = CASE
    WHEN extract(day FROM decided_at) <= 14 THEN '15'
    WHEN extract(day FROM decided_at) <= 29 THEN '30'
    ELSE '15' END
WHERE status IN ('approved', 'paid') AND payout_group IS NULL AND decided_at IS NOT NULL;

-- бекфіл: авто-помічені по банку виплати — це перекази
UPDATE advance_requests SET paid_method = 'transfer'
WHERE paid_txn_id IS NOT NULL AND paid_method IS NULL;

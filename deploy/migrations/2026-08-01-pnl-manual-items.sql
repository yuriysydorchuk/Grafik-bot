-- P&L, блок «Фактичні платежі»: ручні суми VAT/ZUS по фірмах за місяць
-- (платяться в M+1 за M; вносить власник руками). Див. routes/pnl.ts /pnl/actuals.
CREATE TABLE IF NOT EXISTS pnl_manual_items (
  id           serial PRIMARY KEY,
  period_month text NOT NULL,          -- YYYY-MM (місяць, ЗА який податок)
  kind         text NOT NULL,          -- vat | zus
  firm         text NOT NULL,          -- ES / ESO / Klinex…
  amount       real NOT NULL DEFAULT 0,
  note         text,
  created_at   timestamp NOT NULL DEFAULT now(),
  UNIQUE (period_month, kind, firm)
);

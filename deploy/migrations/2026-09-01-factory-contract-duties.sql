-- {%Czynności%} у Umowa (worker-docs-signing) — опис обов'язків, задається на
-- рівні фабрики (рішення власника 01.09.2026: не per-worker/per-generation).
ALTER TABLE factories ADD COLUMN IF NOT EXISTS contract_duties text;

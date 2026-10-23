-- Чергування закріпленої зміни тиждень через тиждень (23.10.2026, рішення власника):
--  * workers.fixed_shift_alt — друга зміна ("1".."6");
--  * workers.fixed_shift_anchor — понеділок тижня, у який діє fixed_shift; наступний тиждень — alt,
--    далі по черзі (резолвер artifacts/api-server/src/lib/fixedShift.ts). NULL = без чергування.
-- Ідемпотентна, даних не чіпає.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS fixed_shift_alt text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS fixed_shift_anchor date;

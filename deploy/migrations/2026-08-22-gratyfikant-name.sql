-- Імʼя працівника в Gratyfikant nexo (точне написання «Nazwisko Imię» з кадрової
-- системи księgowej). Використовується лише в експорті naliczeń для Gratyfikanta
-- (GET /svodni/gratyfikant): пріоритет над full_name; NULL = збігається з профілем.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS gratyfikant_name text;

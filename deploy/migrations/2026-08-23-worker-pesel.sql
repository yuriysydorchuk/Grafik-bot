-- PESEL працівника (11 цифр, ТЕКСТ — зберігає провідні нулі). Джерело —
-- картотеки Pracownicy з Gratyfikant nexo (по підмiотах); використовується для
-- надійного матчингу експортів naliczeń (ідентифікатор "P" у WartoscZArkusza).
ALTER TABLE workers ADD COLUMN IF NOT EXISTS pesel text;

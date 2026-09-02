-- {%Drugie imię%} у Umowa (worker-docs-signing) — необов'язкове; порожньо → в документ не йде.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS middle_name text;

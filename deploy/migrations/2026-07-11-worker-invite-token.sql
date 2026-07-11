-- HIGH security fix: separate unguessable invite token for worker Telegram binding.
-- Previously ?start=<worker_code> was the binding secret, but worker_code is sequential
-- (00001, 00002, …) → enumerable → attacker could hijack any not-yet-bound worker profile.
-- Binding now uses a crypto-random invite_code via ?start=emp<code>; worker_code stays a
-- public display id only. Old ?start=<worker_code> links stop binding by design — the office
-- must re-send invite links (regenerated lazily on GET /workers/:id/invite) to unbound workers.

ALTER TABLE workers ADD COLUMN IF NOT EXISTS invite_code text;
-- Unique index tolerates multiple NULLs in Postgres (unbound workers have no token yet).
CREATE UNIQUE INDEX IF NOT EXISTS workers_invite_code_key ON workers(invite_code);

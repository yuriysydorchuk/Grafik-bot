-- MEDIUM security fix: server-side session revocation.
-- Session tokens are stateless HMAC (7-day TTL); previously logout only cleared the
-- cookie and a password change did not invalidate outstanding tokens, so a stolen
-- token stayed valid until exp. token_version is embedded in each issued token and
-- compared on every request; bumping it (logout / password set / reset-web) invalidates
-- every older token for that admin ("log out everywhere").
-- Existing pre-deploy tokens carry no version → treated as 0 → still valid while
-- token_version is 0 (no forced re-login on deploy).

ALTER TABLE admins ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

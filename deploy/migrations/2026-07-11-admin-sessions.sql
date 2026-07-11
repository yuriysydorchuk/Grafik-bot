-- Feature: web-panel session tracking + login audit (view who logged in, when, from where,
-- which device; revoke individual suspicious sessions). Tokens become session-bound (sid),
-- so pre-deploy tokens without a session row stop working → admins re-login once (expected:
-- that first login is what starts session tracking).

CREATE TABLE IF NOT EXISTS admin_sessions (
  id           text PRIMARY KEY,
  admin_id     integer NOT NULL REFERENCES admins(id),
  created_at   timestamp NOT NULL DEFAULT now(),
  last_seen_at timestamp NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text,
  device       text,
  geo          text,
  revoked_at   timestamp,
  revoked_by   integer
);
CREATE INDEX IF NOT EXISTS admin_sessions_admin_idx ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS admin_sessions_active_idx ON admin_sessions(admin_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS login_events (
  id             serial PRIMARY KEY,
  admin_id       integer,
  username_tried text,
  at             timestamp NOT NULL DEFAULT now(),
  ip             text,
  device         text,
  geo            text,
  event          text NOT NULL,
  session_id     text
);
CREATE INDEX IF NOT EXISTS login_events_at_idx ON login_events(at DESC);

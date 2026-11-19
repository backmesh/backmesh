-- `backmesh cue`'s own credential (owner, 2026-11-19): a fresh App sign-in,
-- whose GitHub token lasts 8 hours, is traded once for it, and cue sends no
-- GitHub token after. Bound to the user and the orgs whose App installation
-- their sign-in reached; only its SHA-256 is kept. Deleted once expired.
CREATE TABLE cue_credentials (
  hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  orgs TEXT NOT NULL, -- JSON [{ id, login }]
  expires_at INTEGER NOT NULL -- milliseconds
);

-- Uninstall's cleanups: an org admin's one
-- device sign-in, for the runners-only token, its re-mint and the App's
-- removal at the end. Only the cleanup_id's SHA-256 is stored. Deleted once
-- expired, by the daily cron.
CREATE TABLE cleanups (
  id TEXT PRIMARY KEY, -- SHA-256 of the cleanup_id
  org INTEGER NOT NULL,
  admin TEXT NOT NULL, -- the signed-in admin's login
  install TEXT, -- the install whose key came with the sign-in, revoked
  expires_at INTEGER NOT NULL, -- milliseconds
  finished INTEGER NOT NULL DEFAULT 0
);

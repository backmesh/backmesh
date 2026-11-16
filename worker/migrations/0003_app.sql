-- The backmesh GitHub App. Revoking an install's key
-- (an admin of its org, or uninstall) refuses it on every route; disowning
-- only stops its events counting toward a subscription.
ALTER TABLE installs ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;

-- Each org's installation of the App, found by the org's login and kept only
-- when its account.id is the org's. Dropped on a 404 from a mint, and read
-- again by its ID after an hour.
CREATE TABLE installations (
  org INTEGER PRIMARY KEY,
  id INTEGER NOT NULL, -- GitHub installation ID
  login TEXT NOT NULL,
  permissions TEXT NOT NULL, -- JSON, as the installation grants them
  checked_at INTEGER NOT NULL -- milliseconds
);

-- One row per token minted and per uninstall or cleanup call, refused or
-- not. The token itself is never stored. Deleted after 90 days.
CREATE TABLE audit (
  at INTEGER NOT NULL, -- milliseconds
  action TEXT NOT NULL CHECK (action IN ('token', 'uninstall', 'cleanup')),
  outcome TEXT NOT NULL, -- 'ok', or why it was refused
  install TEXT,
  org INTEGER,
  installation INTEGER,
  permissions TEXT, -- JSON
  expires_at TEXT,
  ip TEXT, -- CF-Connecting-IP
  ray TEXT -- CF-Ray
);

CREATE INDEX audit_org_at ON audit (org, at);
CREATE INDEX audit_at ON audit (at);

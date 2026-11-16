-- Installs. An org admin creates one through GitHub device sign-in
-- during `backmesh install`; the CLI stores its key, and only the key's
-- SHA-256 is kept. Signing in again replaces the key. An admin can disown an
-- install for good: its key stops working and its events stop counting.
CREATE TABLE installs (
  id TEXT PRIMARY KEY, -- random 128-bit
  org INTEGER NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, -- milliseconds
  disowned INTEGER NOT NULL DEFAULT 0
);

-- One row per job started, keyed by org and SHA-256 of the org ID and
-- GitHub's job ID, so a resent event counts once. details holds the event's
-- other fields as JSON. Deleted after 90 days into daily_counts.
CREATE TABLE events (
  org INTEGER NOT NULL,
  id TEXT NOT NULL,
  install TEXT NOT NULL REFERENCES installs (id),
  version TEXT NOT NULL,
  started_at INTEGER NOT NULL, -- milliseconds
  details TEXT NOT NULL,
  PRIMARY KEY (org, id)
);

CREATE INDEX events_org_started ON events (org, started_at);

CREATE TABLE daily_counts (
  day TEXT NOT NULL, -- YYYY-MM-DD, UTC
  org INTEGER NOT NULL,
  install TEXT NOT NULL,
  jobs INTEGER NOT NULL,
  PRIMARY KEY (day, org, install)
);

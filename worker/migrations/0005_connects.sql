-- Connect links: one row per
-- `backmesh.com/connect/<code>` a CLI started. The code, the poll secret and
-- the browser's state are stored only as their SHA-256, and the sign-in only
-- sealed to the CLI's X25519 key, at most 10 minutes. Deleted 15 minutes
-- after it was made, by the Worker's every-minute cron.
CREATE TABLE connects (
  id TEXT PRIMARY KEY, -- SHA-256 of the code
  poll_hash TEXT NOT NULL, -- SHA-256 of the poll secret
  purpose TEXT NOT NULL CHECK (purpose IN ('install', 'sign-in')),
  org TEXT, -- the login the CLI named; install only
  install TEXT, -- the install whose key a new sign-in replaces
  pub TEXT NOT NULL, -- the CLI's raw X25519 key, base64url
  kid TEXT NOT NULL,
  state_hash TEXT, -- SHA-256 of the browser's state
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'signing', 'sealed', 'fetched', 'refused')),
  refusal TEXT, -- why, for the CLI, once refused
  org_id INTEGER, -- the org's ID, once its admin signed in
  enc TEXT, -- the sealed sign-in, base64url, until fetched
  ct TEXT,
  created_at INTEGER NOT NULL, -- milliseconds
  sealed_at INTEGER -- milliseconds: when signing started, then when sealed
);

CREATE INDEX connects_created_at ON connects (created_at);

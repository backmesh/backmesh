-- Run actions through the Worker (owner, 2026-11-19): the App keeps
-- Actions write for these alone, and an install's own token can only read.
-- An install's runner tag, bound on its first run action: its key then acts
-- only on runs whose jobs ran on runners named with that tag.
ALTER TABLE installs ADD COLUMN tag TEXT;

-- One row per rerun or cancel call, refused or not, for its hourly limit
-- and audit. Deleted after 90 days.
CREATE TABLE run_actions (
  at INTEGER NOT NULL, -- milliseconds
  action TEXT NOT NULL CHECK (action IN ('rerun', 'cancel')),
  install TEXT NOT NULL,
  org INTEGER NOT NULL,
  run TEXT, -- owner/repo/run_id
  outcome TEXT NOT NULL, -- 'ok', 'pending', or why it was refused
  ip TEXT, -- CF-Connecting-IP
  ray TEXT -- CF-Ray
);

CREATE INDEX run_actions_install_at ON run_actions (install, action, at);

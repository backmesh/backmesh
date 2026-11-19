-- Spot-reclaim reruns through the Worker (owner, 2026-11-19): the App keeps
-- Actions write for them alone, and an install's own token can only read.
-- An install's runner tag, bound on its first rerun: its key then reruns
-- only runs whose failed jobs ran on runners named with that tag.
ALTER TABLE installs ADD COLUMN tag TEXT;

-- One row per rerun call, refused or not, for its hourly limit and audit.
-- Deleted after 90 days.
CREATE TABLE reruns (
  at INTEGER NOT NULL, -- milliseconds
  install TEXT NOT NULL,
  org INTEGER NOT NULL,
  run TEXT, -- owner/repo/run_id
  outcome TEXT NOT NULL, -- 'ok', or why it was refused
  ip TEXT, -- CF-Connecting-IP
  ray TEXT -- CF-Ray
);

CREATE INDEX reruns_install_at ON reruns (install, at);

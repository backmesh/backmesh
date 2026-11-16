-- Orgs whose admin declared non-commercial use (open source, a non-profit,
-- education or a personal project), free of charge with a public link back
-- to backmesh.com (owner, 2026-11-06). Self-declared; url is where the
-- link is.
CREATE TABLE noncommercial (
  org INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  claimed_by INTEGER NOT NULL, -- GitHub user ID
  claimed_at INTEGER NOT NULL -- milliseconds
);

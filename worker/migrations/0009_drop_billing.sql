-- Billing is gone (owner, 2026-11-11): backmesh is free, so subscriptions,
-- their enterprises, checkouts and the billing page's sign-ins go. Orgs keep
-- only their login, for installs and the broker.
CREATE TABLE orgs_new (
  id INTEGER PRIMARY KEY,
  login TEXT
);
INSERT INTO orgs_new (id, login) SELECT id, login FROM orgs;
DROP TABLE orgs;
ALTER TABLE orgs_new RENAME TO orgs;
DROP TABLE checkouts;
DROP TABLE sessions;
DROP TABLE enterprises;
DROP TABLE subscriptions;

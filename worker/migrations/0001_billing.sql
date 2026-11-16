-- Stripe subscriptions, rewritten from Stripe's current copy on each webhook
-- event. A voluntary cancellation deletes the row and unlinks its orgs.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, -- Stripe subscription ID
  customer TEXT NOT NULL, -- Stripe customer ID, for the portal
  owner INTEGER NOT NULL, -- GitHub user ID of the admin who checked out
  owner_login TEXT NOT NULL, -- for display
  email TEXT, -- the billing contact, from Checkout
  tier TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'unpaid', 'free')),
  amount_due INTEGER NOT NULL DEFAULT 0, -- unpaid balance, in minor units
  currency TEXT
);

CREATE TABLE enterprises (
  id INTEGER PRIMARY KEY, -- GitHub enterprise database ID
  slug TEXT NOT NULL,
  subscription TEXT NOT NULL REFERENCES subscriptions (id)
);

-- Every org the Worker has seen, by GitHub's numeric ID, which survives
-- renames. A NULL subscription is a free org already checked against the
-- linked enterprises.
CREATE TABLE orgs (
  id INTEGER PRIMARY KEY,
  login TEXT,
  subscription TEXT REFERENCES subscriptions (id),
  enterprise INTEGER REFERENCES enterprises (id)
);

CREATE INDEX orgs_subscription ON orgs (subscription);

-- What a signed-in admin chose before paying; the Checkout Session's
-- client_reference_id names the row, and the webhook links its orgs.
CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,
  owner INTEGER NOT NULL, -- GitHub user ID
  owner_login TEXT NOT NULL,
  orgs TEXT NOT NULL, -- JSON [{ id, login }]
  enterprise TEXT, -- JSON { id, slug }, when the orgs are its orgs
  created_at INTEGER NOT NULL -- seconds; deleted after a day
);

-- An hour-long sign-in. Expired rows, with their GitHub token, are deleted
-- on the next signed-in request and on each sign-in.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL, -- GitHub user ID: logins can be renamed and reused
  login TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

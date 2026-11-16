-- While Stripe's subscription is trialing, when the trial ends (seconds);
-- NULL otherwise. The status API reports such a subscription as `trialing`
-- (owner, 2026-11-09); its `state` stays `active`.
ALTER TABLE subscriptions ADD COLUMN trial_end INTEGER;

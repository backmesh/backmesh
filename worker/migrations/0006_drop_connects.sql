-- Connect links moved to a Durable Object per link (worker/src/link.ts),
-- which expires each by its own alarm (owner, 2026-11-08: no more crons).
-- Nothing reads this table now, and its rows lived 15 minutes at most.
DROP TABLE IF EXISTS connects;

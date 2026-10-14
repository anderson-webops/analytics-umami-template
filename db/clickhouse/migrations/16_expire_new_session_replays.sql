ALTER TABLE umami.session_replay
ADD COLUMN retention_policy UInt8 DEFAULT 0;

ALTER TABLE umami.session_replay
ADD COLUMN ingested_at DateTime('UTC') DEFAULT now('UTC');

ALTER TABLE umami.session_replay
MODIFY TTL ingested_at + INTERVAL 30 DAY DELETE WHERE retention_policy = 1;

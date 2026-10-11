ALTER TABLE umami.heatmap_event
ADD COLUMN retention_policy UInt8 DEFAULT 0;

ALTER TABLE umami.heatmap_event
ADD COLUMN ingested_at DateTime('UTC') DEFAULT now('UTC');

ALTER TABLE umami.heatmap_event
MODIFY TTL ingested_at + INTERVAL 30 DAY DELETE WHERE retention_policy = 1;

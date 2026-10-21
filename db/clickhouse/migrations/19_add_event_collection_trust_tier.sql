ALTER TABLE umami.website_event
ADD COLUMN trust_tier UInt8 DEFAULT 0;

ALTER TABLE umami.event_data
ADD COLUMN trust_tier UInt8 DEFAULT 0;

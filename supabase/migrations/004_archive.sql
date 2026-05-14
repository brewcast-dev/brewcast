-- Soft-delete via archived_at — rows with archived_at set are hidden from
-- normal views and auto-purged after 30 days by the queue cron processor.

alter table posts  add column if not exists archived_at timestamptz;
alter table drafts add column if not exists archived_at timestamptz;

-- Indexes so the cron's "purge older than 30 days" query and the
-- "hide archived from list" queries stay fast on large tables.
create index if not exists posts_archived_at_idx  on posts  (archived_at) where archived_at is not null;
create index if not exists drafts_archived_at_idx on drafts (archived_at) where archived_at is not null;

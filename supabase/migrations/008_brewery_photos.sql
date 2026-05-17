-- Registry of brewery photos with persistent vision analysis.
-- Pre-scoring on upload (via the cron) lets "pick best N" become a sorted
-- query instead of running fresh AI vision on every chat request.

create table if not exists brewery_photos (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,    -- filename in the brewery-photos bucket
  url              text not null,           -- public URL

  -- Vision analysis (filled in by the cron sweep after a row is inserted)
  mood             text,
  subjects         text[],
  suggested_filter text,
  score            integer,                 -- 0-100; higher = better
  confidence       real,                    -- 0-1
  description      text,
  analyzed_at      timestamptz,             -- null until analysis succeeds
  analysis_error   text,                    -- last error if all providers failed

  -- Lifecycle
  used_in_post_ids uuid[] not null default '{}', -- posts that have used this photo
  published_at     timestamptz,             -- set when a post using this photo goes live
                                            -- (hides from /upload library, starts 30d clock)

  created_at       timestamptz not null default now()
);

-- Fast "best N available" query
create index if not exists brewery_photos_score_idx
  on brewery_photos(score desc nulls last)
  where published_at is null;

-- 30-day archive sweep
create index if not exists brewery_photos_published_at_idx
  on brewery_photos(published_at)
  where published_at is not null;

-- Cron picks up unanalyzed rows
create index if not exists brewery_photos_analyzed_at_idx
  on brewery_photos(created_at)
  where analyzed_at is null;

alter table brewery_photos enable row level security;
create policy "service role full access" on brewery_photos using (true) with check (true);

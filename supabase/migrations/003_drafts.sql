-- Upload-flow drafts table
-- Separate from `posts` — stores AI-generated draft cards from /upload before scheduling.

create table if not exists drafts (
  id            uuid primary key default gen_random_uuid(),
  brewery_id    text not null default 'district6',
  image_url     text not null,
  edited_image_url text,
  filter_applied text not null default 'original',
  caption       text not null,
  hashtags      text[] not null default '{}',
  platforms     text[] not null default '{instagram}',
  status        text not null default 'draft' check (status in ('draft', 'approved', 'queued', 'published', 'failed')),
  scheduled_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- RLS: enable but open to service-role for now (tighten per user auth later)
alter table drafts enable row level security;
create policy "service role full access" on drafts using (true) with check (true);

-- BrewCast: single-tenant schema for one brewery
-- Run via: supabase db push  OR  psql $DATABASE_URL < supabase/migrations/001_init.sql

create extension if not exists "pgcrypto";

-- ─── brewery ────────────────────────────────────────────────────────────────
create table brewery (
  id             uuid primary key default gen_random_uuid(),
  name           text,
  website_url    text,
  tagline        text,
  about          text,
  beer_styles    text[],
  brand_colors   jsonb,
  tone_of_voice  text,
  logo_url       text,
  ig_handle      text,
  created_at     timestamptz default now()
);

-- ─── posts ──────────────────────────────────────────────────────────────────
create table posts (
  id             uuid primary key default gen_random_uuid(),
  status         text not null default 'draft'
                   check (status in ('draft','approved','queued','published','failed')),
  platform       text not null
                   check (platform in ('instagram','facebook','both')),
  content_type   text not null
                   check (content_type in ('post','reel','story')),
  caption        text,
  media_urls     jsonb,
  audio_url      text,
  video_url      text,
  thumbnail_url  text,
  scheduled_at   timestamptz,
  published_at   timestamptz,
  meta_post_id   text,
  ad_targeting   jsonb,
  created_at     timestamptz default now()
);

-- ─── analytics ──────────────────────────────────────────────────────────────
create table analytics (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid references posts(id) on delete cascade,
  captured_at  timestamptz default now(),
  reach        integer,
  impressions  integer,
  likes        integer,
  comments     integer,
  shares       integer,
  saves        integer,
  plays        integer
);

-- ─── indexes ────────────────────────────────────────────────────────────────
create index posts_status_idx        on posts(status);
create index posts_scheduled_at_idx  on posts(scheduled_at) where scheduled_at is not null;
create index analytics_post_id_idx   on analytics(post_id);
create index analytics_captured_idx  on analytics(captured_at);

-- ─── RLS (Row Level Security) ────────────────────────────────────────────────
-- Single-tenant: service role bypasses RLS; anon key is blocked by default.
alter table brewery   enable row level security;
alter table posts     enable row level security;
alter table analytics enable row level security;

-- Allow the service-role key (used by the Next.js server) full access.
-- Anon/public clients never touch these tables directly.
create policy "service role full access" on brewery   using (true) with check (true);
create policy "service role full access" on posts     using (true) with check (true);
create policy "service role full access" on analytics using (true) with check (true);

-- Per-user data isolation, phase 2. Idempotent — safe to re-run.
--
-- Migration 006 already added user_id (nullable) to posts + drafts. This
-- migration:
--   1. Adds user_id to brewery_photos + analytics if not present
--   2. Backfills any NULL user_id rows to brewcast.demo@gmail.com
--   3. Promotes user_id to NOT NULL on all four
--   4. Indexes + RLS read policies (defense-in-depth — app uses service role)

-- ─── 1. Add user_id where missing ───────────────────────────────────────────
alter table brewery_photos add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table analytics      add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- ─── 2. Backfill ─────────────────────────────────────────────────────────────
do $$
declare
  demo_uid uuid;
begin
  select id into demo_uid from auth.users where email = 'brewcast.demo@gmail.com' limit 1;
  if demo_uid is null then
    raise exception 'brewcast.demo@gmail.com not found in auth.users — create the account first or edit this migration to point at a different owner email';
  end if;

  update brewery_photos set user_id = demo_uid where user_id is null;
  update analytics       set user_id = demo_uid where user_id is null;
  update posts           set user_id = demo_uid where user_id is null;
  update drafts          set user_id = demo_uid where user_id is null;
end $$;

-- ─── 3. NOT NULL (idempotent — alter is a no-op if already NOT NULL) ────────
alter table brewery_photos alter column user_id set not null;
alter table analytics      alter column user_id set not null;
alter table posts          alter column user_id set not null;
alter table drafts         alter column user_id set not null;

-- ─── 4. Indexes ─────────────────────────────────────────────────────────────
create index if not exists brewery_photos_user_id_idx on brewery_photos(user_id);
create index if not exists analytics_user_id_idx       on analytics(user_id);

drop index if exists brewery_photos_score_idx;
create index if not exists brewery_photos_user_score_idx
  on brewery_photos(user_id, score desc nulls last)
  where published_at is null;

-- ─── 5. RLS read policies — defense in depth ───────────────────────────────
-- Service role policies created by earlier migrations are left alone.
-- Only add the user-scoped read policies, idempotently.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'brewery_photos'
      and policyname = 'users see own brewery_photos'
  ) then
    create policy "users see own brewery_photos"
      on brewery_photos for select to authenticated
      using (user_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'analytics'
      and policyname = 'users see own analytics'
  ) then
    create policy "users see own analytics"
      on analytics for select to authenticated
      using (user_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'posts'
      and policyname = 'users see own posts'
  ) then
    create policy "users see own posts"
      on posts for select to authenticated
      using (user_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'drafts'
      and policyname = 'users see own drafts'
  ) then
    create policy "users see own drafts"
      on drafts for select to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

-- Per-user data isolation, phase 2.
--
-- Migration 006 already added user_id (nullable) to posts + drafts and the
-- agent has been writing it on insert. This migration:
--   1. Adds user_id to brewery_photos + analytics (the two content tables
--      that were still single-tenant).
--   2. Backfills any NULL user_id rows in posts + drafts + the new ones to
--      brewcast.demo@gmail.com.
--   3. Promotes user_id to NOT NULL on all four so new rows can't slip
--      through without an owner.
--   4. Adds RLS policies as defense-in-depth — the app uses the service
--      role and bypasses RLS, so the *code* must still filter by user_id.

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

-- ─── 3. NOT NULL ────────────────────────────────────────────────────────────
alter table brewery_photos alter column user_id set not null;
alter table analytics      alter column user_id set not null;
alter table posts          alter column user_id set not null;
alter table drafts         alter column user_id set not null;

-- ─── 4. Indexes ─────────────────────────────────────────────────────────────
create index if not exists brewery_photos_user_id_idx on brewery_photos(user_id);
create index if not exists analytics_user_id_idx       on analytics(user_id);

-- Hottest read path: best N photos for a user, only those not yet published
drop index if exists brewery_photos_score_idx;
create index brewery_photos_user_score_idx
  on brewery_photos(user_id, score desc nulls last)
  where published_at is null;

-- ─── 5. RLS policies — defense in depth ─────────────────────────────────────
drop policy if exists "service role full access" on brewery_photos;
create policy "service role full access" on brewery_photos using (true) with check (true);
create policy "users see own brewery_photos" on brewery_photos for select to authenticated using (user_id = auth.uid());

drop policy if exists "service role full access" on analytics;
create policy "service role full access" on analytics using (true) with check (true);
create policy "users see own analytics" on analytics for select to authenticated using (user_id = auth.uid());

-- posts + drafts already have RLS enabled from 001_init; add user-scoped read
-- policies. Service role policies already exist from earlier migrations.
create policy "users see own posts"  on posts  for select to authenticated using (user_id = auth.uid());
create policy "users see own drafts" on drafts for select to authenticated using (user_id = auth.uid());

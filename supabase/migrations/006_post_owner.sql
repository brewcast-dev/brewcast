-- ── Track which authenticated user owns each post / draft ────────────────────
-- The cron processor needs this to look up the right Meta credentials from
-- brewery_configs when publishing scheduled posts. Without user_id, the cron
-- can only fall back to the single set of env vars on Vercel — fine for the
-- demo account but breaks the moment a second brewery account schedules a
-- post.
--
-- Nullable + on delete set null: old rows from before this migration keep
-- working via env-var fallback; deleting an auth user doesn't cascade-delete
-- their content.

alter table posts  add column user_id uuid references auth.users(id) on delete set null;
alter table drafts add column user_id uuid references auth.users(id) on delete set null;

create index posts_user_id_idx  on posts(user_id)  where user_id is not null;
create index drafts_user_id_idx on drafts(user_id) where user_id is not null;

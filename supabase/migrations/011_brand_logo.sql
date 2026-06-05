-- Per-brewery logo upload. Each client uploads their own logo in Settings;
-- the Design Director renderer stamps it top-centre on every post.
--
-- Adds logo columns to brewery_configs and a PUBLIC storage bucket for brand
-- assets. Uploads go through the service role (bypasses RLS); the bucket being
-- public means the renderer + the settings preview can read by URL.

alter table brewery_configs add column if not exists logo_url  text;  -- public URL (with cache-bust query)
alter table brewery_configs add column if not exists logo_path text;  -- storage object path, for replace/delete

insert into storage.buckets (id, name, public)
values ('brand-assets', 'brand-assets', true)
on conflict (id) do nothing;

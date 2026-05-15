-- ── Brewery configs: per-user API keys ────────────────────────────────────────
create table brewery_configs (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        references auth.users(id) on delete cascade unique not null,
  brewery_name    text,
  brand_context   text,        -- Injected into caption prompts; leave null to use default District 6 context
  google_api_key  text,
  groq_api_key    text,
  mistral_api_key text,
  meta_app_id     text,
  meta_app_secret text,
  meta_ig_user_id text,
  meta_access_token text,
  meta_fb_page_id text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── Allowlist: emails permitted to sign in ────────────────────────────────────
create table allowed_users (
  id            uuid        primary key default gen_random_uuid(),
  email         text        unique not null,
  user_id       uuid        references auth.users(id) on delete set null,
  brewery_name  text,
  is_admin      boolean     default false,
  created_at    timestamptz default now()
);

-- ── Seed: after creating brewcast.demo@gmail.com in Supabase Auth, run: ───────
-- insert into allowed_users (email, brewery_name, is_admin)
-- values ('brewcast.demo@gmail.com', 'District 6 Brewery', true);
--
-- Then seed brewery_configs:
-- insert into brewery_configs (user_id, brewery_name, brand_context,
--   google_api_key, groq_api_key, mistral_api_key,
--   meta_app_id, meta_app_secret, meta_ig_user_id, meta_access_token, meta_fb_page_id)
-- select
--   id,
--   'District 6 Brewery',
--   'District 6 Brewery is a craft brewery in Bangalore, India. Brand voice: casual, warm, craft-forward, local Bangalore pride, community-first. Signature hashtag: #District6Bangalore.',
--   '<GOOGLE_GENERATIVE_AI_API_KEY>',
--   '<GROQ_API_KEY>',
--   '<MISTRAL_API_KEY>',
--   '<META_APP_ID>',
--   '<META_APP_SECRET>',
--   '<META_IG_USER_ID>',
--   '<META_ACCESS_TOKEN>',
--   '<META_FB_PAGE_ID>'
-- from auth.users where email = 'brewcast.demo@gmail.com';

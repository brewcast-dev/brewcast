-- AI usage + cost ledger. Every LLM call (Gemini, Groq, Mistral) appends one
-- row so the app knows exactly how many tokens it burned and what it cost.
-- Drives the budget-status endpoint and the "approaching your prepaid cap"
-- warning. The app writes via the service role; the user-scoped read policy
-- is defense-in-depth only.
--
-- NOTE on billing model: the Gemini key is PREPAID, so Google can never charge
-- past the loaded balance — this table is for visibility + an early warning
-- before calls start failing, not to prevent an overage bill (impossible on
-- prepaid).

create table if not exists ai_usage (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),

  -- Nullable: deep AI helpers don't always have the request's user in scope,
  -- and billing is account-wide (one prepaid balance) anyway. Kept for later
  -- per-user slicing. ON DELETE SET NULL so usage history survives user removal.
  user_id             uuid references auth.users(id) on delete set null,

  provider            text not null,            -- 'google' | 'groq' | 'mistral'
  model               text not null,            -- normalized model id, e.g. 'gemini-2.5-flash'
  feature             text not null,            -- 'photo-analysis' | 'design-vision' | 'headline' | 'caption' | 'layout-director' | 'qa-loop'

  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cached_input_tokens integer not null default 0,  -- subset of input_tokens served from cache (cheaper)
  total_tokens        integer not null default 0,

  cost_usd            numeric(12,6) not null default 0,  -- 0 for providers we don't price (Groq/Mistral)
  cost_inr            numeric(12,4) not null default 0
);

-- Spend-window queries are "sum rows since <timestamp>", optionally per provider.
create index if not exists ai_usage_created_at_idx on ai_usage(created_at desc);
create index if not exists ai_usage_provider_created_idx on ai_usage(provider, created_at desc);
create index if not exists ai_usage_user_id_idx on ai_usage(user_id);

alter table ai_usage enable row level security;

-- Service role (the app) — full access. Matches the convention in 008.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ai_usage'
      and policyname = 'service role full access'
  ) then
    create policy "service role full access" on ai_usage using (true) with check (true);
  end if;

  -- Authenticated users may read their own rows (defense in depth).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ai_usage'
      and policyname = 'users see own ai_usage'
  ) then
    create policy "users see own ai_usage"
      on ai_usage for select to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

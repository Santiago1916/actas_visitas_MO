create table if not exists public.oauth_tokens (
  token_key text primary key,
  token_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

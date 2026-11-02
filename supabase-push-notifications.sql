-- Canta con el corazón: suscripciones Push privadas de dispositivos administradores
create table if not exists public.cch_push_subscriptions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 endpoint text not null unique,
 subscription jsonb not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists cch_push_subscriptions_user_id_idx on public.cch_push_subscriptions(user_id);
alter table public.cch_push_subscriptions enable row level security;
-- Sin políticas para usuarios finales: la API opera esta tabla únicamente con service_role.

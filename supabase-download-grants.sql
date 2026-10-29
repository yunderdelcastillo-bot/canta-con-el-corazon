-- Canta con el corazón: habilitar enlaces de descarga autorizados
-- Ejecuta este archivo completo en Supabase > SQL Editor > New query.

create extension if not exists pgcrypto;

create table if not exists public.download_grants (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references public.songs(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists download_grants_song_id_idx
  on public.download_grants(song_id);

create index if not exists download_grants_expires_at_idx
  on public.download_grants(expires_at);

alter table public.download_grants enable row level security;
revoke all on public.download_grants from anon, authenticated;
grant all on public.download_grants to service_role;

notify pgrst, 'reload schema';

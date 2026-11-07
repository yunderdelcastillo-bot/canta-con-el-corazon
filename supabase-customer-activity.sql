-- Monitoreo de actividad del cliente para Canta con el corazón.
-- Ejecutar una sola vez en Supabase SQL Editor.
create table if not exists public.customer_order_activity (
 order_id uuid primary key references public.customer_orders(id) on delete cascade,
 status text not null default 'online',
 event_type text not null default 'online',
 playback_position integer not null default 0,
 playback_duration integer not null default 0,
 first_seen_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now(),
 download_started_at timestamptz,
 download_completed_at timestamptz,
 updated_at timestamptz not null default now()
);
alter table public.customer_order_activity enable row level security;
revoke all on public.customer_order_activity from anon, authenticated;
notify pgrst, 'reload schema';

-- Canta con el corazón: pedidos de clientes (ejecutar una sola vez en Supabase SQL Editor)
create extension if not exists pgcrypto;
create table if not exists public.customer_orders (
 id uuid primary key default gen_random_uuid(),
 buyer text not null,
 contact text not null,
 recipient text not null,
 occasion text not null,
 story text not null,
 style text not null default '',
 custom_genre text not null default '',
 voice text not null default '',
 special_phrase text not null default '',
 lyric_duration text not null default '',
 lyric_tone text not null default '',
 package_name text not null default '',
 urgency text not null default '',
 lyrics text not null default '',
 status text not null default 'nuevo' check (status in ('nuevo','contactado','pago_verificado','en_proceso','entregado','cancelado')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.customer_orders enable row level security;
revoke all on public.customer_orders from anon, authenticated;
notify pgrst, 'reload schema';

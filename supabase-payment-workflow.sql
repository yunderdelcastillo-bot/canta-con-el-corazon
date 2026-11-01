-- Canta con el corazón: comprobantes y revisión de pagos (opción C)
-- Ejecutar UNA VEZ en Supabase > SQL Editor. No modifica canciones ni enlaces existentes.
create extension if not exists pgcrypto;

create table if not exists public.payment_submissions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.customer_orders(id) on delete cascade,
  access_token_hash text not null unique,
  amount numeric(10,2) not null default 20,
  package_name text not null default '',
  payment_status text not null default 'pending'
    check (payment_status in ('pending','voucher_submitted','approved','rejected')),
  provider text not null default 'manual'
    check (provider in ('manual','culqi','mercadopago')),
  provider_payment_id text unique,
  voucher_path text,
  song_id uuid references public.songs(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_submissions_status_idx
  on public.payment_submissions(payment_status,created_at desc);
alter table public.payment_submissions enable row level security;
revoke all on public.payment_submissions from anon, authenticated;
grant all on public.payment_submissions to service_role;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('payment-vouchers','payment-vouchers',false,8388608,
  array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public=false,file_size_limit=8388608,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','application/pdf'];

notify pgrst, 'reload schema';

-- Canta con el corazón: mensajería interna, notificaciones e integraciones pendientes.
-- Ejecutar UNA VEZ en Supabase > SQL Editor. No altera pedidos ni enlaces existentes.
create extension if not exists pgcrypto;
create table if not exists public.order_messages (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.customer_orders(id) on delete cascade,
 sender_role text not null check (sender_role in ('customer','admin')),
 message text not null check (char_length(message) between 1 and 1200),
 created_at timestamptz not null default now(),
 read_at timestamptz
);
create index if not exists order_messages_order_created_idx on public.order_messages(order_id,created_at);
create table if not exists public.system_notifications (
 id uuid primary key default gen_random_uuid(),
 order_id uuid references public.customer_orders(id) on delete cascade,
 event_type text not null check (event_type in ('new_order','voucher_received','new_message','payment_approved')),
 audience text not null check (audience in ('admin','customer')),
 title text not null,
 body text not null,
 is_read boolean not null default false,
 created_at timestamptz not null default now()
);
create index if not exists system_notifications_audience_created_idx on public.system_notifications(audience,is_read,created_at desc);
alter table public.order_messages enable row level security;
alter table public.system_notifications enable row level security;
revoke all on public.order_messages,public.system_notifications from anon,authenticated;
grant all on public.order_messages,public.system_notifications to service_role;
notify pgrst,'reload schema';

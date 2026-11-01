-- Canta con el corazón: paquetes y permisos independientes por compra
-- Ejecuta este archivo UNA SOLA VEZ en Supabase > SQL Editor > New query.

alter table public.songs
  add column if not exists package_key text not null default 'esencial',
  add column if not exists package_price numeric(10,2) not null default 20;

alter table public.songs
  drop constraint if exists songs_package_key_check;
alter table public.songs
  add constraint songs_package_key_check
  check (package_key in ('esencial','detalle','completo'));

-- Las autorizaciones antiguas conservan los permisos completos que tenían.
alter table public.download_grants
  add column if not exists package_key text not null default 'completo',
  add column if not exists package_price numeric(10,2) not null default 30,
  add column if not exists can_mp3 boolean not null default true,
  add column if not exists can_video boolean not null default true;

alter table public.download_grants
  drop constraint if exists download_grants_package_key_check;
alter table public.download_grants
  add constraint download_grants_package_key_check
  check (package_key in ('esencial','detalle','completo'));

create index if not exists download_grants_package_key_idx
  on public.download_grants(package_key);

notify pgrst, 'reload schema';

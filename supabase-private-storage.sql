-- CANTA CON EL CORAZÓN — migración a almacenamiento privado
-- Ejecutar en Supabase > SQL Editor. Antes, conserva copia de seguridad.
create extension if not exists pgcrypto;

-- El bucket debe ser privado. Esto impide las URL públicas permanentes.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('songs-audio','songs-audio',false,26214400,array['audio/mpeg'])
on conflict (id) do update set public=false,file_size_limit=26214400,allowed_mime_types=array['audio/mpeg'];

-- Mantener uploads solo para el usuario autenticado en su propia carpeta.
drop policy if exists "Public can listen song audio" on storage.objects;
drop policy if exists "Authenticated users upload song audio" on storage.objects;
drop policy if exists "Owners can update song audio" on storage.objects;
drop policy if exists "Owners can delete song audio" on storage.objects;

create policy "Authenticated users upload own song audio"
on storage.objects for insert to authenticated
with check (bucket_id='songs-audio' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "Owners update own song audio"
on storage.objects for update to authenticated
using (bucket_id='songs-audio' and (storage.foldername(name))[1]=auth.uid()::text)
with check (bucket_id='songs-audio' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "Owners delete own song audio"
on storage.objects for delete to authenticated
using (bucket_id='songs-audio' and (storage.foldername(name))[1]=auth.uid()::text);

-- Guarda la ruta de archivo (no una URL pública permanente).
alter table public.songs add column if not exists audio_path text;
-- Las filas antiguas que solo tienen audio_url no se migran automáticamente:
-- vuelve a subir cada MP3 desde el panel después de actualizar la aplicación.
alter table public.songs alter column audio_url drop not null;

create table if not exists public.download_grants (
 id uuid primary key default gen_random_uuid(),
 song_id uuid not null references public.songs(id) on delete cascade,
 token_hash text not null unique,
 created_by uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null
);
alter table public.download_grants enable row level security;
revoke all on public.download_grants from anon, authenticated;

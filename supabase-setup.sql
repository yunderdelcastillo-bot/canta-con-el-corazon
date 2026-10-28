-- CANTA CON EL CORAZÓN: configuración inicial de Supabase
-- 1) En Supabase > SQL Editor, pega todo este archivo y pulsa Run.
-- 2) En Storage crea un bucket público llamado songs-audio.
-- 3) En Authentication > Users crea tu usuario administradora.
-- 4) En el panel /admin.html introduce Project URL y la clave pública (anon/publishable).
-- No uses service_role/secret keys en el navegador.

create extension if not exists pgcrypto;

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  recipient text not null,
  dedication text not null,
  lyrics text default '',
  theme text not null default 'romantico',
  audio_url text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  published boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.songs enable row level security;

drop policy if exists "Public can read published songs" on public.songs;
create policy "Public can read published songs"
on public.songs for select to anon, authenticated
using (published = true or owner_id = auth.uid());

drop policy if exists "Owners can insert their songs" on public.songs;
create policy "Owners can insert their songs"
on public.songs for insert to authenticated
with check (owner_id = auth.uid());

drop policy if exists "Owners can update their songs" on public.songs;
create policy "Owners can update their songs"
on public.songs for update to authenticated
using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "Owners can delete their songs" on public.songs;
create policy "Owners can delete their songs"
on public.songs for delete to authenticated
using (owner_id = auth.uid());

-- Crear el bucket desde Storage > New bucket:
-- Name: songs-audio | Public bucket: ON | Allowed MIME types: audio/mpeg
-- File size limit: 25 MB
-- Luego ejecuta las políticas de abajo.

drop policy if exists "Authenticated users upload song audio" on storage.objects;
create policy "Authenticated users upload song audio"
on storage.objects for insert to authenticated
with check (bucket_id = 'songs-audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Public can listen song audio" on storage.objects;
create policy "Public can listen song audio"
on storage.objects for select to public
using (bucket_id = 'songs-audio');

drop policy if exists "Owners can update song audio" on storage.objects;
create policy "Owners can update song audio"
on storage.objects for update to authenticated
using (bucket_id = 'songs-audio' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'songs-audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Owners can delete song audio" on storage.objects;
create policy "Owners can delete song audio"
on storage.objects for delete to authenticated
using (bucket_id = 'songs-audio' and (storage.foldername(name))[1] = auth.uid()::text);

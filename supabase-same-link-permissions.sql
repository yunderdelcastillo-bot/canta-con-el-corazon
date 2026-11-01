-- Permisos persistentes por canción: el cliente conserva siempre el mismo enlace.
CREATE TABLE IF NOT EXISTS public.song_package_permissions (
  song_id uuid PRIMARY KEY REFERENCES public.songs(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  package_key text NOT NULL CHECK (package_key IN ('esencial','detalle','completo')),
  package_price numeric(10,2) NOT NULL,
  can_mp3 boolean NOT NULL DEFAULT false,
  can_video boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS song_package_permissions_owner_idx
  ON public.song_package_permissions(owner_id);
ALTER TABLE public.song_package_permissions ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
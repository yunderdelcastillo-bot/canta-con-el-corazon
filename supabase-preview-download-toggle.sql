-- Ejecutar una sola vez en Supabase SQL Editor.
-- Añade un interruptor remoto para permitir/bloquear descargas desde un enlace de muestra.
ALTER TABLE public.song_preview_links
ADD COLUMN IF NOT EXISTS download_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS song_preview_links_download_enabled_idx
ON public.song_preview_links(song_id, download_enabled);

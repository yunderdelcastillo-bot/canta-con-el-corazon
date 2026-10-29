CREATE TABLE IF NOT EXISTS public.song_preview_links (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 song_id UUID NOT NULL REFERENCES public.songs(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 created_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 started_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ
);
ALTER TABLE public.song_preview_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.song_preview_links FROM anon, authenticated;
GRANT ALL ON public.song_preview_links TO service_role;
CREATE INDEX IF NOT EXISTS song_preview_links_song_id_idx ON public.song_preview_links(song_id, created_at);

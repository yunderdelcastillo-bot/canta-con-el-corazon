-- Canta con el corazón: una sola reproducción de muestra por canción en todos los dispositivos.
-- Ejecuta este archivo UNA VEZ en Supabase > SQL Editor > New query.

CREATE TABLE IF NOT EXISTS public.song_preview_sessions (
  song_id UUID PRIMARY KEY REFERENCES public.songs(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.song_preview_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.song_preview_sessions FROM anon, authenticated;
GRANT ALL ON public.song_preview_sessions TO service_role;

CREATE OR REPLACE FUNCTION public.claim_song_preview(
  p_song_id UUID,
  p_token_hash TEXT,
  p_lease_minutes INTEGER DEFAULT 15
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_completed TIMESTAMPTZ;
  v_lease_until TIMESTAMPTZ;
  v_token_hash TEXT;
BEGIN
  INSERT INTO public.song_preview_sessions(song_id, token_hash, lease_until, completed_at, created_at)
  VALUES (p_song_id, p_token_hash, now() + make_interval(mins => greatest(1, least(p_lease_minutes, 30))), NULL, now())
  ON CONFLICT (song_id) DO UPDATE
    SET token_hash = EXCLUDED.token_hash,
        lease_until = EXCLUDED.lease_until,
        completed_at = NULL,
        created_at = now()
    WHERE public.song_preview_sessions.completed_at IS NULL
      AND (
        public.song_preview_sessions.lease_until < now()
        OR public.song_preview_sessions.token_hash = EXCLUDED.token_hash
      )
  RETURNING token_hash INTO v_token_hash;

  IF FOUND THEN
    RETURN 'claimed';
  END IF;

  SELECT completed_at, lease_until, token_hash
    INTO v_completed, v_lease_until, v_token_hash
    FROM public.song_preview_sessions
    WHERE song_id = p_song_id;

  IF v_completed IS NOT NULL THEN
    RETURN 'completed';
  END IF;

  RETURN 'in_use';
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_song_preview(
  p_song_id UUID,
  p_token_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.song_preview_sessions
     SET completed_at = now()
   WHERE song_id = p_song_id
     AND token_hash = p_token_hash
     AND completed_at IS NULL
     AND lease_until > now();

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_song_preview(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_song_preview(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_song_preview(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_song_preview(UUID, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';

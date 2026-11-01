-- Autorizaciones individuales de reproducción solicitadas por el cliente
CREATE TABLE IF NOT EXISTS public.song_replay_authorizations (
  song_id uuid PRIMARY KEY REFERENCES public.songs(id) ON DELETE CASCADE,
  replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  consumed_count integer NOT NULL DEFAULT 0 CHECK (consumed_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (consumed_count <= replay_count)
);
ALTER TABLE public.song_replay_authorizations ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';

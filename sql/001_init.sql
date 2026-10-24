BEGIN;

CREATE TABLE IF NOT EXISTS stoa_events (
  simulation_id text NOT NULL,
  sequence bigint NOT NULL,
  event_id uuid NOT NULL,
  simulated_at bigint NOT NULL CHECK (simulated_at >= 0),
  event_type text NOT NULL,
  actor text,
  visibility text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (simulation_id, sequence),
  UNIQUE (event_id)
);

CREATE TABLE IF NOT EXISTS stoa_snapshots (
  simulation_id text NOT NULL,
  version bigint NOT NULL,
  last_sequence bigint NOT NULL,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (simulation_id, version)
);

CREATE INDEX IF NOT EXISTS stoa_events_replay_idx
  ON stoa_events (simulation_id, sequence);

COMMIT;

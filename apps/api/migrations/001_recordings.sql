-- Recorded experiments: a workload, the operator inputs that were applied to it,
-- and the fingerprint of the trace it produced. Re-running the same source and
-- inputs on the same engine version must reproduce trace_hash exactly.
CREATE TABLE IF NOT EXISTS recordings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  notes          text        NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
  source         text        NOT NULL CHECK (char_length(source) <= 100000),
  inputs         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(inputs) = 'array'),
  trace_hash     char(8)     NOT NULL,
  status         text        NOT NULL CHECK (status IN ('done', 'deadlock', 'stalled', 'max-ticks')),
  ticks          integer     NOT NULL CHECK (ticks >= 0),
  summary        jsonb       NOT NULL,
  engine_version text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recordings_created_at_idx ON recordings (created_at DESC);
CREATE INDEX IF NOT EXISTS recordings_trace_hash_idx ON recordings (trace_hash);

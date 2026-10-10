-- Questions asked of the assistant, with the citations its answer used.
-- Kept so answers can be audited against the trace they were based on.
CREATE TABLE IF NOT EXISTS assistant_log (
  id           bigserial   PRIMARY KEY,
  recording_id uuid        REFERENCES recordings(id) ON DELETE CASCADE,
  trace_hash   char(8)     NOT NULL,
  question     text        NOT NULL CHECK (char_length(question) <= 2000),
  intent       text        NOT NULL,
  citations    integer[]   NOT NULL DEFAULT '{}',
  narrated     boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_log_trace_idx ON assistant_log (trace_hash, created_at DESC);

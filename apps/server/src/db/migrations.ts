// PostgreSQL 스키마 (docs/09-DATA-MODEL.md §3). 순서대로 한 번씩 적용하고 schema_migrations에 기록한다.
// 적용된 마이그레이션은 수정하지 않는다. 변경은 새 항목으로 추가한다.

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE users (
  id text PRIMARY KEY,
  nickname varchar(16) NOT NULL,
  kind text NOT NULL DEFAULT 'guest' CHECK (kind IN ('guest', 'member')),
  selected_character_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE uploads (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 char(64) NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  storage_key text NOT NULL,
  rights_attested boolean NOT NULL CHECK (rights_attested = true),
  status text NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)
);

CREATE TABLE characters (
  id text PRIMARY KEY,
  owner_id text REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('GENERATING', 'READY', 'FAILED')),
  tier text CHECK (tier IN ('T0', 'T1', 'T2')),
  skeleton text NOT NULL DEFAULT 'mba-humanoid-v1',
  manifest_version integer NOT NULL DEFAULT 0,
  skin jsonb,
  provenance jsonb,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
  builtin boolean NOT NULL DEFAULT false,
  thumbnail_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX characters_owner_created ON characters (owner_id, created_at DESC);
CREATE INDEX characters_builtin ON characters (builtin) WHERE builtin;

ALTER TABLE users ADD CONSTRAINT users_selected_character_fk
  FOREIGN KEY (selected_character_id) REFERENCES characters(id) ON DELETE SET NULL;

CREATE TABLE character_assets (
  id text PRIMARY KEY,
  character_id text NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('glb', 'thumbnail', 'texture', 'source_mesh', 'preview_turntable', 'manifest')),
  storage_key text NOT NULL,
  size_bytes integer NOT NULL,
  meta jsonb
);
CREATE INDEX character_assets_character ON character_assets (character_id);

CREATE TABLE ai_jobs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id text NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  character_id text NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN (
    'QUEUED', 'PREPROCESSING', 'GENERATING', 'POSTPROCESSING', 'RIGGING',
    'VALIDATING', 'EXPORTING', 'READY', 'FAILED', 'RETRY_WAIT')),
  -- 마지막으로 실행(또는 실패)한 단계. 재시작 지점. null이면 PREPROCESSING부터
  current_stage text,
  stage_started_at timestamptz,
  progress real NOT NULL DEFAULT 0,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  -- 점유(claim) 횟수 = ClaimedJob.attempt
  attempts_total integer NOT NULL DEFAULT 0,
  auto_retries integer NOT NULL DEFAULT 0,
  manual_retries integer NOT NULL DEFAULT 0,
  -- 현재 사이클에서 실제 처리에 쓴 누적 시간 (QUEUED/RETRY_WAIT 대기 제외, C13 전체 10분)
  processing_ms integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  claimed_at timestamptz,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX ai_jobs_queue ON ai_jobs (status, run_after) WHERE status IN ('QUEUED', 'RETRY_WAIT');
CREATE INDEX ai_jobs_user_created ON ai_jobs (user_id, created_at);
CREATE INDEX ai_jobs_character ON ai_jobs (character_id);

CREATE TABLE ai_job_stages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id text NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  stage text NOT NULL,
  attempt integer NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'OK', 'FAILED')),
  output_key text,
  metrics jsonb,
  error jsonb,
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);
CREATE INDEX ai_job_stages_job ON ai_job_stages (job_id, started_at);

-- 워커가 PUT으로 올린 산출물 (jobs/{jobId}/{name}). 재시도 시 ClaimedJob.artifacts로 돌려준다
CREATE TABLE ai_job_artifacts (
  job_id text NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  name text NOT NULL,
  storage_key text NOT NULL,
  size_bytes bigint NOT NULL,
  stage text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, name)
);

CREATE TABLE matches (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('ai', 'online')),
  difficulty text CHECK (difficulty IN ('easy', 'normal', 'hard')),
  result text NOT NULL CHECK (result IN ('KO', 'TIME_UP', 'FORFEIT', 'ABANDONED')),
  winner_user_id text REFERENCES users(id) ON DELETE SET NULL,
  duration_ms integer NOT NULL,
  room_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match_players (
  match_id text NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  character_id text,
  nickname varchar(16),
  slot integer NOT NULL CHECK (slot IN (0, 1)),
  hp_end integer,
  won boolean,
  stats jsonb NOT NULL,
  PRIMARY KEY (match_id, slot)
);
CREATE INDEX match_players_user ON match_players (user_id, match_id);

-- Idempotency-Key 응답 보관 (24시간, docs/08 §1)
CREATE TABLE idempotency_keys (
  user_id text NOT NULL,
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, key)
);
`,
  },
];

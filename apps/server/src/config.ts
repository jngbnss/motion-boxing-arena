// 환경 변수 → 서버 설정. 기본값은 로컬 개발용이다 (README 참조).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  /** DB(PGlite)·파일 저장소·개발용 비밀키 위치 */
  dataDir: string;
  /** 설정 시 PostgreSQL(pg), 없으면 `${dataDir}/pg`의 임베디드 PGlite */
  databaseUrl: string | null;
  /** 클라이언트에 돌려주는 절대 URL의 기준 (`${publicBaseUrl}/files/...`) */
  publicBaseUrl: string;
  corsOrigins: string[];
  authSecret: string;
  workerSecret: string;
  features: { online: boolean; generation: boolean };
  /** 인바운드 실시간 메시지에 더하는 인위 지연 (docs/07 §8) */
  simLatencyMs: number;
  simJitterMs: number;
  /** 늦게 도착한 방어자 포즈를 반영하려고 판정을 늦추는 시간 (C10 REWIND_GRACE) */
  rewindGraceMs: number;
  /** 자동 재시도 백오프 기준 (docs/09 §5: 30s × 2^(attempt-1)) */
  jobRetryBaseMs: number;
  logLevel: string;
}

const DEFAULT_CORS = 'http://localhost:5173,http://localhost:4173,https://jngbnss.github.io';

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got "${raw}"`);
  return Math.floor(n);
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/** AUTH_SECRET 미설정 시 DATA_DIR에 한 번 생성해 재시작 후에도 토큰이 유효하게 한다 */
function loadOrCreateSecret(dataDir: string): string {
  const file = join(dataDir, 'auth-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = intEnv(env, 'PORT', 2567);
  const dataDir = resolve(env.DATA_DIR || './.data');
  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir,
    databaseUrl: env.DATABASE_URL || null,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    corsOrigins: (env.CORS_ORIGINS || DEFAULT_CORS).split(',').map((s) => s.trim()).filter(Boolean),
    authSecret: env.AUTH_SECRET || loadOrCreateSecret(dataDir),
    workerSecret: env.WORKER_SECRET || 'dev-worker-secret',
    features: {
      online: boolEnv(env, 'FEATURE_ONLINE', true),
      generation: boolEnv(env, 'FEATURE_GENERATION', true),
    },
    simLatencyMs: intEnv(env, 'SIM_LATENCY_MS', 0),
    simJitterMs: intEnv(env, 'SIM_JITTER_MS', 0),
    rewindGraceMs: intEnv(env, 'REWIND_GRACE_MS', 80),
    jobRetryBaseMs: intEnv(env, 'JOB_RETRY_BASE_MS', 30_000),
    logLevel: env.LOG_LEVEL || 'info',
  };
}

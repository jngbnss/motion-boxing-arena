// 라우트들이 공유하는 서비스 묶음과 인증 도우미
import type { FastifyRequest } from 'fastify';
import { bearerToken, verifyToken } from '../auth.ts';
import type { ServerConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { JobQueue } from '../jobs/queue.ts';
import type { RoomRegistry } from '../realtime/registry.ts';
import type { FileStorage } from '../storage.ts';
import { unauthorized } from './errors.ts';
import type { IdempotencyStore } from './idempotency.ts';

export interface AppContext {
  config: ServerConfig;
  db: Db;
  storage: FileStorage;
  queue: JobQueue;
  registry: RoomRegistry;
  idempotency: IdempotencyStore;
  now: () => number;
}

export interface AuthUser {
  id: string;
  nickname: string;
}

/** Bearer 토큰 검증 + 사용자 존재 확인. 실패하면 401 */
export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<AuthUser> {
  const claims = verifyToken(ctx.config.authSecret, bearerToken(req.headers.authorization), ctx.now());
  if (!claims) throw unauthorized();
  const { rows } = await ctx.db.query<AuthUser>(
    'SELECT id, nickname FROM users WHERE id = $1 AND deleted_at IS NULL',
    [claims.userId],
  );
  if (!rows[0]) throw unauthorized();
  return rows[0];
}

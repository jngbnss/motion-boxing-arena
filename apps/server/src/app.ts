// 서버 조립: Fastify(REST·파일·매치메이킹 HTTP) + Colyseus(duel 룸 WebSocket)를 한 HTTP 서버/포트에서 돌린다.
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Server, ServerError, createAuthContext, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { API_PREFIX, INTERNAL_PREFIX, ROOM_NAME, UPLOAD_LIMITS } from '@mba/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.ts';
import { openDb, type Db } from './db/index.ts';
import { apiRoutes } from './http/api.ts';
import type { AppContext } from './http/context.ts';
import { HttpError, parseOr400 } from './http/errors.ts';
import { IdempotencyStore } from './http/idempotency.ts';
import { internalRoutes } from './http/internal.ts';
import { newId } from './ids.ts';
import { JobQueue } from './jobs/queue.ts';
import type { DuelResult } from './realtime/controller.ts';
import { createDuelRoom } from './realtime/DuelRoom.ts';
import { RoomRegistry } from './realtime/registry.ts';
import { FileStorage, isValidKey } from './storage.ts';
import { z } from 'zod';

const FileParams = z.object({ '*': z.string() });
const MatchmakeParams = z.object({ method: z.string().min(1).max(32), roomName: z.string().min(1).max(64) });

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  glb: 'model/gltf-binary',
  json: 'application/json',
};

/** 큐 점검 주기 (좀비·타임아웃) */
const SWEEP_INTERVAL_MS = 15_000;
/** 결과 저장 재시도 (docs/07 §4.12) */
const SAVE_ATTEMPTS = 3;

export interface MbaServer {
  app: FastifyInstance;
  ctx: AppContext;
  gameServer: Server;
  /** 포트 바인딩. 반환값은 실제 포트 (PORT=0 테스트용) */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  /** 테스트: 미리 연 DB (메모리 PGlite) */
  db?: Db;
  now?: () => number;
  logger?: boolean;
}

export async function createServer(config: ServerConfig, opts: CreateServerOptions = {}): Promise<MbaServer> {
  const now = opts.now ?? Date.now;
  const db = opts.db ?? (await openDb({ databaseUrl: config.databaseUrl, pgliteDir: join(config.dataDir, 'pg') }));
  const storage = new FileStorage(join(config.dataDir, 'files'), config.publicBaseUrl);
  const queue = new JobQueue(db, storage, { now, retryBaseMs: config.jobRetryBaseMs });
  const registry = new RoomRegistry();
  const ctx: AppContext = { config, db, storage, queue, registry, idempotency: new IdempotencyStore(db, now), now };

  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-None-Match', 'X-Worker-Secret'],
    exposedHeaders: ['ETag', 'Retry-After'],
    maxAge: 600,
  });
  await app.register(multipart, { limits: { fileSize: UPLOAD_LIMITS.maxBytes, files: 1, fields: 5, parts: 6 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).headers(err.headers).send(err.body());
    }
    const status = typeof err === 'object' && err && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status === 413) {
      return reply.code(413).send(new HttpError(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다').body());
    }
    if (status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : 'bad request';
      return reply.code(400).send(new HttpError(400, 'VALIDATION_FAILED', message).body());
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(new HttpError(500, 'INTERNAL', '서버 오류').body());
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(new HttpError(404, 'NOT_FOUND', `${req.method} ${req.url} not found`).body());
  });

  await app.register((scope) => apiRoutes(scope, ctx), { prefix: API_PREFIX });
  await app.register((scope) => internalRoutes(scope, ctx), { prefix: INTERNAL_PREFIX });

  // 읽기 전용 파일 서빙 (docs/09 §6 레이아웃)
  app.get('/files/*', async (req, reply) => {
    const { '*': key } = parseOr400(FileParams, req.params);
    if (!isValidKey(key)) throw new HttpError(404, 'NOT_FOUND', 'file not found');
    const size = await storage.size(key);
    if (size === null) throw new HttpError(404, 'NOT_FOUND', 'file not found');
    const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    // 버전 경로(characters/{id}/v{n}/)는 불변
    const immutable = key.startsWith('characters/');
    reply
      .header('content-type', CONTENT_TYPES[ext] ?? 'application/octet-stream')
      .header('content-length', size)
      .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'private, no-cache')
      .header('x-content-type-options', 'nosniff');
    return reply.send(storage.openRead(key));
  });

  // ── Colyseus ────────────────────────────────────────────────────────────
  // Colyseus의 기본 HTTP 라우터는 서버의 모든 request를 가로채므로 쓰지 않는다.
  // WebSocket upgrade만 트랜스포트에 맡기고, 매치메이킹 HTTP는 Fastify 라우트로 처리한다.
  const transport = new WebSocketTransport({ noServer: true });
  transport.attachToServer(app.server);
  const gameServer = new Server({ transport, greet: false, gracefullyShutdown: false });

  const saveResult = (result: DuelResult, roomCode: string) => {
    void persistDuel(db, result, roomCode, now, (err, attempt) =>
      app.log.error({ err, attempt, roomCode }, 'match result save failed'),
    );
  };
  gameServer.define(
    ROOM_NAME,
    createDuelRoom({
      authSecret: config.authSecret,
      registry,
      rewindGraceMs: config.rewindGraceMs,
      simLatencyMs: config.simLatencyMs,
      simJitterMs: config.simJitterMs,
      now,
      findUser: async (userId) => {
        const { rows } = await db.query<{ nickname: string }>('SELECT nickname FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
        return rows[0] ?? null;
      },
      validateCharacter: async (userId, characterId) => {
        if (characterId.startsWith('builtin:')) return characterId.length <= 64;
        const { rows } = await db.query('SELECT 1 FROM characters WHERE id = $1 AND owner_id = $2 AND status = $3', [characterId, userId, 'READY']);
        return rows.length > 0;
      },
      saveResult,
      log: (msg, data) => app.log.info(data ?? {}, msg),
    }),
  );

  app.post('/matchmake/:method/:roomName', async (req, reply) => {
    if (!config.features.online) throw new HttpError(503, 'FEATURE_DISABLED', '온라인 대전 기능이 꺼져 있습니다', { retryable: false });
    const { method, roomName } = parseOr400(MatchmakeParams, req.params);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const reservation = await matchMaker.controller.invokeMethod(
        method,
        roomName,
        body,
        createAuthContext({
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])),
          remoteAddress: req.ip,
        }),
      );
      return reservation;
    } catch (e) {
      // @colyseus/sdk는 HTTP 상태를 MatchMakeError.code로, body.error를 메시지로 쓴다
      const code = e instanceof ServerError ? e.code : 500;
      const status = code >= 400 && code < 600 ? code : 400;
      const message = e instanceof Error ? e.message : 'matchmake failed';
      return reply.code(status).send({ code, error: message });
    }
  });

  const sweeper = setInterval(() => {
    queue.sweep().catch((err) => app.log.error({ err }, 'job sweep failed'));
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  let closed = false;
  return {
    app,
    ctx,
    gameServer,
    async listen() {
      await matchMaker.accept();
      await app.listen({ port: config.port, host: config.host });
      const addr = app.server.address();
      return typeof addr === 'object' && addr ? addr.port : config.port;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      // 룸 정리(진행 중 경기는 ABANDONED 저장) → 소켓 → HTTP → DB
      await gameServer.gracefullyShutdown(false);
      await app.close();
      if (!opts.db) await db.close();
    },
  };
}

/** duel 결과 → matches/match_players. 실패 시 3회 재시도 후 로그만 (docs/07 §4.12) */
export async function persistDuel(
  db: Db,
  result: DuelResult,
  roomCode: string,
  now: () => number,
  onError: (err: unknown, attempt: number) => void,
): Promise<string | null> {
  const t = now();
  const matchId = newId('mat', t);
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
    try {
      await db.tx(async (q) => {
        await q.query(
          `INSERT INTO matches (id, mode, difficulty, result, winner_user_id, duration_ms, room_code, created_at)
           VALUES ($1, 'online', NULL, $2, $3, $4, $5, $6::timestamptz)`,
          [matchId, result.reason, result.winnerUserId, result.durationMs, roomCode, new Date(t).toISOString()],
        );
        for (const p of result.players) {
          await q.query(
            `INSERT INTO match_players (match_id, user_id, character_id, nickname, slot, hp_end, won, stats)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
            [matchId, p.userId, p.characterId, p.nickname, p.slot, p.hpEnd, p.won, JSON.stringify(p.stats)],
          );
        }
      });
      return matchId;
    } catch (err) {
      onError(err, attempt);
      if (attempt < SAVE_ATTEMPTS) await sleep(200 * attempt);
    }
  }
  return null;
}

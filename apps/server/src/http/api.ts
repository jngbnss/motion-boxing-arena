// 공개 REST API `/api/v1` (docs/08 §2, contracts.md)
import { createHash } from 'node:crypto';
import {
  GenerateRequestSchema,
  GuestSessionRequestSchema,
  MatchReportSchema,
  UPLOAD_LIMITS,
  type CharacterListResponse,
  type CharacterSummary,
  type GuestSessionResponse,
  type RoomLookupResponse,
  type RuntimeConfig,
  type UploadResponse,
} from '@mba/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { issueToken } from '../auth.ts';
import { newId } from '../ids.ts';
import { sniffImage } from '../image.ts';
import { buildManifest, type CharacterRow } from '../jobs/queue.ts';
import { requireUser, type AppContext } from './context.ts';
import { HttpError, forbidden, notFound, parseOr400 } from './errors.ts';
import { requireIdempotencyKey } from './idempotency.ts';
import { TokenBucketLimiter } from './rateLimit.ts';

/** 닉네임 금칙어 (간단 목록, docs/08 §2.1). 소문자 부분 일치 */
const BANNED_NICKNAME_PARTS = ['admin', 'system', 'fuck', 'shit', '씨발', '시발', '병신', '좆', '개새', '운영자'];

const IdParam = z.object({ id: z.string().min(1).max(64) });
const CodeParam = z.object({ code: z.string().regex(/^[A-Za-z0-9]{6}$/) });
const PageQuery = (max: number) =>
  z.object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(max).default(Math.min(20, max)),
  });

/** 커서 = base64url("createdAtISO|id"), 정렬 (created_at DESC, id DESC) */
function encodeCursor(createdAt: Date | string, id: string): string {
  return Buffer.from(`${new Date(createdAt).toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) throw new HttpError(400, 'VALIDATION_FAILED', 'invalid cursor');
  return { createdAt, id };
}

export async function apiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guestLimiter = new TokenBucketLimiter(10, 60_000, ctx.now);
  const uploadLimiter = new TokenBucketLimiter(20, 60 * 60_000, ctx.now);
  const pollLimiter = new TokenBucketLimiter(60, 60_000, ctx.now);
  const sweeper = setInterval(() => {
    guestLimiter.sweep();
    uploadLimiter.sweep();
    pollLimiter.sweep();
  }, 5 * 60_000);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));

  app.get('/health', async () => ({ ok: true }));

  app.get('/config', async (): Promise<RuntimeConfig> => ({
    features: { online: ctx.config.features.online, generation: ctx.config.features.generation },
    workerOnline: ctx.queue.workerOnline(),
  }));

  // ── 세션 ────────────────────────────────────────────────────────────────

  app.post('/sessions/guest', async (req, reply) => {
    guestLimiter.consume(`ip:${req.ip}`);
    const { nickname } = parseOr400(GuestSessionRequestSchema, req.body);
    const lower = nickname.toLowerCase();
    if (BANNED_NICKNAME_PARTS.some((w) => lower.includes(w))) {
      throw new HttpError(400, 'NICKNAME_REJECTED', '사용할 수 없는 닉네임입니다');
    }
    const t = ctx.now();
    const userId = newId('usr', t);
    await ctx.db.query(
      `INSERT INTO users (id, nickname, kind, created_at, last_seen_at) VALUES ($1, $2, 'guest', $3::timestamptz, $3::timestamptz)`,
      [userId, nickname, new Date(t).toISOString()],
    );
    const { token, expiresAt } = issueToken(ctx.config.authSecret, userId, t);
    const body: GuestSessionResponse = { userId, token, expiresAt: new Date(expiresAt).toISOString() };
    return reply.code(201).send(body);
  });

  // ── 업로드 (multipart 직접 업로드: file, rightsAttested) ─────────────────

  app.post('/uploads', async (req, reply) => {
    const user = await requireUser(ctx, req);
    uploadLimiter.consume(`user:${user.id}`);
    if (!req.isMultipart()) throw new HttpError(400, 'VALIDATION_FAILED', 'multipart/form-data 요청이어야 합니다');

    let file: Buffer | null = null;
    let rightsAttested = false;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (part.fieldname === 'file' && !file) file = buf;
      } else if (part.fieldname === 'rightsAttested') {
        rightsAttested = part.value === 'true' || part.value === true;
      }
    }
    if (!rightsAttested) {
      throw new HttpError(400, 'RIGHTS_NOT_ATTESTED', '이미지 사용 권리를 확인해야 합니다 (rightsAttested=true)');
    }
    if (!file) throw new HttpError(400, 'VALIDATION_FAILED', 'file 필드가 필요합니다');
    if (file.length > UPLOAD_LIMITS.maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '10MB를 넘는 파일입니다');

    const info = sniffImage(file);
    if (!info) {
      throw new HttpError(400, 'IMAGE_INVALID', 'PNG/JPEG/WebP 이미지가 아닙니다', { details: { reason: 'BAD_TYPE' } });
    }
    if (Math.min(info.width, info.height) < UPLOAD_LIMITS.minShortSidePx) {
      throw new HttpError(400, 'IMAGE_INVALID', `짧은 변이 ${UPLOAD_LIMITS.minShortSidePx}px 이상이어야 합니다`, {
        details: { reason: 'TOO_SMALL', width: info.width, height: info.height },
      });
    }
    const sha256 = createHash('sha256').update(file).digest('hex');

    const { rows: existing } = await ctx.db.query<{ id: string; width: number; height: number }>(
      'SELECT id, width, height FROM uploads WHERE user_id = $1 AND sha256 = $2',
      [user.id, sha256],
    );
    if (existing[0]) {
      const body: UploadResponse = { uploadId: existing[0].id, width: existing[0].width, height: existing[0].height, sha256, status: 'VERIFIED', alreadyExists: true };
      return reply.code(200).send(body);
    }

    const t = ctx.now();
    const uploadId = newId('upl', t);
    const key = `uploads/${user.id}/${sha256}.${info.ext}`;
    await ctx.storage.put(key, file);
    await ctx.db.query(
      `INSERT INTO uploads (id, user_id, sha256, content_type, size_bytes, width, height, storage_key, rights_attested, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, 'VERIFIED', $9::timestamptz)
       ON CONFLICT (user_id, sha256) DO NOTHING`,
      [uploadId, user.id, sha256, info.contentType, file.length, info.width, info.height, key, new Date(t).toISOString()],
    );
    const body: UploadResponse = { uploadId, width: info.width, height: info.height, sha256, status: 'VERIFIED', alreadyExists: false };
    return reply.code(201).send(body);
  });

  // ── 생성 작업 ───────────────────────────────────────────────────────────

  app.post('/characters/generate', async (req, reply) => {
    const user = await requireUser(ctx, req);
    if (!ctx.config.features.generation) {
      throw new HttpError(503, 'FEATURE_DISABLED', '캐릭터 생성 기능이 꺼져 있습니다', { retryable: false });
    }
    const key = requireIdempotencyKey(req.headers['idempotency-key']);
    const body = parseOr400(GenerateRequestSchema, req.body);
    const stored = await ctx.idempotency.run(user.id, 'generate', key, body, async () => {
      const r = await ctx.queue.createJob(user.id, body, key);
      return { statusCode: r.status, body: r.body };
    });
    return reply.code(stored.statusCode).send(stored.body);
  });

  app.get('/jobs/:id', async (req: FastifyRequest, reply) => {
    const user = await requireUser(ctx, req);
    pollLimiter.consume(`user:${user.id}`);
    const { id } = parseOr400(IdParam, req.params);
    const view = await ctx.queue.view(id, user.id);
    const etag = `"${createHash('sha1').update(JSON.stringify(view)).digest('base64url')}"`;
    reply.header('etag', etag).header('cache-control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return view;
  });

  app.post('/jobs/:id/retry', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = parseOr400(IdParam, req.params);
    return ctx.queue.retry(id, user.id);
  });

  // ── 캐릭터 ──────────────────────────────────────────────────────────────

  app.get('/characters', async (req): Promise<CharacterListResponse> => {
    const user = await requireUser(ctx, req);
    const { cursor, limit } = parseOr400(PageQuery(50), req.query);
    const after = decodeCursor(cursor);
    const { rows } = await ctx.db.query<CharacterRow & { job_id: string | null }>(
      `SELECT c.*, (SELECT j.id FROM ai_jobs j WHERE j.character_id = c.id ORDER BY j.created_at DESC LIMIT 1) AS job_id
       FROM characters c
       WHERE c.owner_id = $1 ${after ? 'AND (c.created_at, c.id) < ($3::timestamptz, $4)' : ''}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $2`,
      after ? [user.id, limit + 1, after.createdAt, after.id] : [user.id, limit + 1],
    );
    const page = rows.slice(0, limit);
    const items: CharacterSummary[] = page.map((r) => ({
      id: r.id,
      name: r.name,
      tier: r.tier,
      thumbnailUrl: r.thumbnail_key ? ctx.storage.urlOf(r.thumbnail_key) : null,
      status: r.status,
      builtin: r.builtin,
      jobId: r.job_id,
    }));
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
  });

  app.get('/characters/:id', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const { id } = parseOr400(IdParam, req.params);
    const { rows } = await ctx.db.query<CharacterRow>('SELECT * FROM characters WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) throw notFound('character');
    // private: 소유자, 또는 지금 같은 duel 룸에 있는 상대만 (docs/08 §2.6)
    const allowed = row.builtin || row.owner_id === user.id || (row.owner_id !== null && ctx.registry.sharesRoom(user.id, row.owner_id));
    if (!allowed) throw forbidden();
    if (row.status !== 'READY') {
      throw new HttpError(409, 'CHARACTER_NOT_READY', `character is ${row.status}`, { details: { status: row.status } });
    }
    reply.header('cache-control', 'private, max-age=3600');
    return buildManifest(row, ctx.storage);
  });

  // ── 경기 기록 ───────────────────────────────────────────────────────────

  app.post('/matches', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const key = requireIdempotencyKey(req.headers['idempotency-key']);
    const report = parseOr400(MatchReportSchema, req.body);
    const stored = await ctx.idempotency.run(user.id, 'matches', key, report, async () => {
      const t = ctx.now();
      const matchId = newId('mat', t);
      await ctx.db.tx(async (q) => {
        await q.query(
          `INSERT INTO matches (id, mode, difficulty, result, winner_user_id, duration_ms, created_at)
           VALUES ($1, 'ai', $2, $3, $4, $5, $6::timestamptz)`,
          [matchId, report.difficulty, report.result, report.won ? user.id : null, report.durationMs, new Date(t).toISOString()],
        );
        await q.query(
          `INSERT INTO match_players (match_id, user_id, nickname, slot, won, stats) VALUES ($1, $2, $3, 0, $4, $5::jsonb)`,
          [matchId, user.id, user.nickname, report.won, JSON.stringify(report.stats)],
        );
      });
      return { statusCode: 201, body: { matchId } };
    });
    return reply.code(stored.statusCode).send(stored.body);
  });

  app.get('/me/matches', async (req) => {
    const user = await requireUser(ctx, req);
    const { cursor, limit } = parseOr400(PageQuery(20), req.query);
    const after = decodeCursor(cursor);
    const { rows } = await ctx.db.query<{
      id: string;
      mode: 'ai' | 'online';
      difficulty: string | null;
      result: string;
      duration_ms: number;
      room_code: string | null;
      created_at: Date | string;
      won: boolean | null;
      character_id: string | null;
      hp_end: number | null;
      stats: unknown;
      opp_nickname: string | null;
      opp_character_id: string | null;
    }>(
      `SELECT m.id, m.mode, m.difficulty, m.result, m.duration_ms, m.room_code, m.created_at,
              mp.won, mp.character_id, mp.hp_end, mp.stats,
              op.nickname AS opp_nickname, op.character_id AS opp_character_id
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.id
         AND mp.slot = (SELECT min(slot) FROM match_players x WHERE x.match_id = m.id AND x.user_id = $1)
       LEFT JOIN match_players op ON op.match_id = m.id AND op.slot <> mp.slot
       WHERE mp.user_id = $1 ${after ? 'AND (m.created_at, m.id) < ($3::timestamptz, $4)' : ''}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $2`,
      after ? [user.id, limit + 1, after.createdAt, after.id] : [user.id, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        matchId: r.id,
        mode: r.mode,
        difficulty: r.difficulty,
        result: r.result,
        won: r.won,
        durationMs: r.duration_ms,
        characterId: r.character_id,
        hpEnd: r.hp_end,
        stats: r.stats,
        opponent: r.opp_nickname !== null ? { nickname: r.opp_nickname, characterId: r.opp_character_id } : null,
        roomCode: r.room_code,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  });

  // ── 룸 코드 ─────────────────────────────────────────────────────────────

  app.get('/rooms/:code', async (req): Promise<RoomLookupResponse> => {
    if (!ctx.config.features.online) throw new HttpError(503, 'FEATURE_DISABLED', '온라인 대전 기능이 꺼져 있습니다', { retryable: false });
    const { code } = parseOr400(CodeParam, req.params);
    const room = ctx.registry.lookup(code);
    if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', `room ${code.toUpperCase()} not found`);
    if (room.playerCount >= 2) throw new HttpError(409, 'ROOM_FULL', 'room is full');
    return room;
  });
}

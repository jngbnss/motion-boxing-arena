// Idempotency-Key 저장소 (docs/08 §1: 상태 변경 POST, 24시간 보관). 같은 키·같은 요청 → 최초 응답 그대로.
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { HttpError, badRequest } from './errors.ts';

const RETENTION_MS = 24 * 60 * 60_000;

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

export function requireIdempotencyKey(header: string | string[] | undefined): string {
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) throw badRequest('Idempotency-Key 헤더가 필요합니다');
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) throw badRequest('Idempotency-Key 형식이 올바르지 않습니다 (8~128자 영숫자/_.:-)');
  return key;
}

export class IdempotencyStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /**
   * 저장된 응답이 있으면 돌려주고, 없으면 run()을 실행해 저장한다.
   * 같은 키로 다른 본문을 보내면 409 IDEMPOTENCY_KEY_REUSED.
   */
  async run(userId: string, scope: string, key: string, request: unknown, run: () => Promise<StoredResponse>): Promise<StoredResponse> {
    const hash = createHash('sha256').update(JSON.stringify(request ?? null)).digest('hex');
    const cutoff = new Date(this.now() - RETENTION_MS).toISOString();
    await this.db.query('DELETE FROM idempotency_keys WHERE created_at < $1::timestamptz', [cutoff]);

    const existing = await this.find(userId, scope, key);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '같은 Idempotency-Key로 다른 요청을 보냈습니다');
      }
      return { statusCode: existing.status_code, body: existing.response };
    }

    const result = await run();
    const { rows } = await this.db.query<{ inserted: boolean }>(
      `INSERT INTO idempotency_keys (user_id, scope, key, request_hash, status_code, response, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT (user_id, scope, key) DO NOTHING
       RETURNING true AS inserted`,
      [userId, scope, key, hash, result.statusCode, JSON.stringify(result.body), new Date(this.now()).toISOString()],
    );
    if (rows.length === 0) {
      // 동시 요청이 먼저 저장했다: 그 응답으로 통일
      const winner = await this.find(userId, scope, key);
      if (winner) return { statusCode: winner.status_code, body: winner.response };
    }
    return result;
  }

  private async find(userId: string, scope: string, key: string) {
    const { rows } = await this.db.query<{ request_hash: string; status_code: number; response: unknown }>(
      'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND key = $3',
      [userId, scope, key],
    );
    return rows[0];
  }
}

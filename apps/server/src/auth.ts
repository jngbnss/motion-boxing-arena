// 게스트 토큰: `${userId}.${expiryMs}.${base64url(HMAC-SHA256(secret, userId.expiryMs))}` (30일 만료)
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TokenClaims {
  userId: string;
  expiresAt: number;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueToken(secret: string, userId: string, now: number = Date.now()): { token: string; expiresAt: number } {
  if (userId.includes('.')) throw new Error('userId must not contain "."');
  const expiresAt = now + TOKEN_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt };
}

/** 서명·만료를 검증한다. 실패하면 null */
export function verifyToken(secret: string, token: unknown, now: number = Date.now()): TokenClaims | null {
  if (typeof token !== 'string' || token.length > 256) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiryRaw, sig] = parts as [string, string, string];
  if (!userId || !/^\d+$/.test(expiryRaw)) return null;
  const expected = Buffer.from(sign(secret, `${userId}.${expiryRaw}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expiresAt = Number(expiryRaw);
  if (expiresAt <= now) return null;
  return { userId, expiresAt };
}

/** `Authorization: Bearer <token>` 헤더에서 토큰을 꺼낸다 */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/** 워커 공유 비밀 비교 (타이밍 안전) */
export function secretEquals(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

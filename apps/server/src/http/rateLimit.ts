// 인메모리 토큰 버킷 (단일 프로세스 MVP, docs/08 §5). 키별로 capacity개, perMs마다 capacity만큼 선형 충전.
import { HttpError } from './errors.ts';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(capacity: number, perMs: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerMs = capacity / perMs;
    this.now = now;
  }

  /** 토큰 1개 소비. 부족하면 다음 토큰까지 남은 ms를 반환, 성공하면 0 */
  take(key: string): number {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: t };
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.updatedAt) * this.refillPerMs);
    b.updatedAt = t;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / this.refillPerMs);
  }

  /** 소비 실패 시 429 RATE_LIMITED (Retry-After 초) */
  consume(key: string): void {
    const waitMs = this.take(key);
    if (waitMs > 0) {
      const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
      throw new HttpError(429, 'RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도하세요', {
        retryable: true,
        headers: { 'retry-after': String(retryAfter) },
      });
    }
  }

  /** 완전히 충전된 버킷을 버린다 (메모리 상한) */
  sweep(): void {
    const t = this.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + (t - b.updatedAt) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
  }
}

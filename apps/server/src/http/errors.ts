// 공통 오류 포맷 `{ error: { code, message, retryable, details? } }` (docs/08 §1)
import type { ApiError } from '@mba/shared';
import type { z } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: { retryable?: boolean; details?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = opts.retryable ?? (status === 429 || status >= 500);
    this.details = opts.details;
    this.headers = opts.headers ?? {};
  }

  body(): ApiError & { error: { details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new HttpError(400, 'VALIDATION_FAILED', message, details ? { details } : {});
export const unauthorized = () => new HttpError(401, 'UNAUTHORIZED', '인증 토큰이 없거나 만료되었습니다');
export const forbidden = () => new HttpError(403, 'FORBIDDEN', '소유자가 아닙니다');
export const notFound = (what = 'resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);

/** zod 파싱. 실패하면 400 VALIDATION_FAILED (issues를 details로) */
export function parseOr400<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest('요청 형식이 올바르지 않습니다', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

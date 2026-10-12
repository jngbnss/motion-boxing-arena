import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, resolveApiBase, type KeyValueStore } from './api.ts';

function memoryStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    load: <T,>(k: string, fb: T) => (data.has(k) ? (data.get(k) as T) : fb),
    save: (k, v) => { data.set(k, v); },
    remove: (k) => { data.delete(k); },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const future = () => new Date(Date.now() + 30 * 86_400_000).toISOString();

describe('resolveApiBase', () => {
  it('VITE_API_URL 우선, 빈 문자열은 미설정, 개발 모드 기본값은 localhost:2567', () => {
    expect(resolveApiBase({ VITE_API_URL: 'https://api.example.com/', DEV: false })).toBe('https://api.example.com');
    expect(resolveApiBase({ VITE_API_URL: '', DEV: true })).toBeNull();
    expect(resolveApiBase({ DEV: true })).toBe('http://localhost:2567');
    expect(resolveApiBase({ DEV: false })).toBeNull();
  });
});

describe('ApiClient', () => {
  it('게스트 세션을 1회만 발급해 저장하고 Bearer 토큰으로 호출한다', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/sessions/guest')) return json(201, { userId: 'usr_1', token: 'tok1', expiresAt: future() });
      return json(200, { items: [], nextCursor: null });
    }) as unknown as typeof fetch;
    const store = memoryStore();
    const c = new ApiClient('http://x', fetchFn, store);
    await Promise.all([c.listCharacters(), c.listCharacters()]);
    expect(calls.filter((x) => x.url.endsWith('/sessions/guest')).length).toBe(1);
    const authed = calls.filter((x) => x.url.endsWith('/characters'));
    expect(authed.length).toBe(2);
    expect((authed[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok1');
    // 새 클라이언트도 저장된 토큰을 재사용
    const c2 = new ApiClient('http://x', fetchFn, store);
    await c2.listCharacters();
    expect(calls.filter((x) => x.url.endsWith('/sessions/guest')).length).toBe(1);
  });

  it('401이면 세션을 재발급하고 1회 재시도한다', async () => {
    let n = 0;
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/sessions/guest')) return json(201, { userId: 'usr_1', token: `tok${++n}`, expiresAt: future() });
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer tok1' ? json(401, { error: { code: 'UNAUTHORIZED', message: 'x', retryable: false } }) : json(200, { ok: true });
    }) as unknown as typeof fetch;
    const c = new ApiClient('http://x', fetchFn, memoryStore());
    await expect(c.getJob('job_1')).resolves.toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('오류 응답을 ApiError(code, retryable)로, 연결 실패를 NETWORK로 바꾼다', async () => {
    const c = new ApiClient('http://x', (async (url: string) => {
      if (url.endsWith('/sessions/guest')) return json(201, { userId: 'u', token: 't', expiresAt: future() });
      return json(503, { error: { code: 'QUEUE_FULL', message: '가득', retryable: true } });
    }) as unknown as typeof fetch, memoryStore());
    const err = await c.generate({ uploadId: 'upl_1', name: 'a' }, 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('QUEUE_FULL');
    expect((err as ApiError).retryable).toBe(true);
    expect((err as ApiError).status).toBe(503);

    const down = new ApiClient('http://x', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, memoryStore());
    const r = await down.getConfig();
    expect(r.config).toBeNull();
    expect(r.error?.code).toBe('NETWORK');
  });
});

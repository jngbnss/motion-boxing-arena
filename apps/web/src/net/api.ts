// REST 클라이언트 (docs/08-API-DESIGN.md §2). 게스트 세션 자동 발급·토큰 저장, 공통 오류 타입, /config 게이팅.
// VITE_API_URL 미설정 프로덕션 빌드(GitHub Pages)는 서버 없이 동작한다(온라인·생성 UI 비활성).
import { z } from 'zod';
import {
  API_PREFIX,
  NicknameSchema,
  type CharacterListResponse,
  type CharacterManifest,
  type GenerateRequest,
  type GenerateResponse,
  type GuestSessionResponse,
  type JobView,
  type MatchReport,
  type RoomLookupResponse,
  type RuntimeConfig,
  type UploadResponse,
} from '@mba/shared';
import { loadJson, removeKey, saveJson } from '../storage.ts';

/** 서버 오류 본문 `{error:{code,message,retryable}}` (외부 입력이라 검증해서 읽는다) */
const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() }),
});

const DEV_DEFAULT_API = 'http://localhost:2567';

/** API 서버 주소. null = 서버 미설정(싱글 전용) */
export function resolveApiBase(env: { VITE_API_URL?: string; DEV?: boolean }): string | null {
  const raw = env.VITE_API_URL;
  if (raw != null) return raw.trim() === '' ? null : raw.trim().replace(/\/+$/, '');
  return env.DEV ? DEV_DEFAULT_API : null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface StoredSession extends GuestSessionResponse {
  nickname: string;
  apiBase: string;
}

export interface KeyValueStore {
  load<T>(key: string, fallback: T): T;
  save(key: string, value: unknown): void;
  remove(key: string): void;
}

const localStore: KeyValueStore = {
  load: loadJson,
  save: (k, v) => { saveJson(k, v); },
  remove: removeKey,
};

const SESSION_KEY = 'mba.session.v1';
const NICKNAME_KEY = 'mba.nickname.v1';
const CONFIG_TTL_MS = 30_000;

export function randomNickname(rand: () => number = Math.random): string {
  return `복서_${String(Math.floor(rand() * 10000)).padStart(4, '0')}`;
}

type Body = { json: unknown } | { form: FormData } | { raw: Blob | ArrayBuffer; contentType: string } | null;

export class ApiClient {
  private sessionPromise: Promise<StoredSession> | null = null;
  private config: { at: number; value: RuntimeConfig | null; error: ApiError | null } | null = null;

  constructor(
    readonly base: string,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly store: KeyValueStore = localStore,
  ) {}

  /** 서버 절대 URL (ws 엔드포인트 계산에도 사용) */
  url(path: string): string {
    return `${this.base}${path}`;
  }

  get nickname(): string {
    const n = this.store.load<string | null>(NICKNAME_KEY, null);
    if (n && NicknameSchema.safeParse(n).success) return n;
    const fresh = randomNickname();
    this.store.save(NICKNAME_KEY, fresh);
    return fresh;
  }

  private async raw(method: string, path: string, body: Body, headers: Record<string, string> = {}): Promise<Response> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body && 'json' in body) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body.json);
    } else if (body && 'form' in body) {
      init.body = body.form;
    } else if (body && 'raw' in body) {
      (init.headers as Record<string, string>)['Content-Type'] = body.contentType;
      init.body = body.raw;
    }
    try {
      return await this.fetchFn(this.url(path), init);
    } catch (e) {
      throw new ApiError(0, 'NETWORK', `서버에 연결할 수 없어요 (${String((e as Error)?.message ?? e)})`, true);
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = ErrorBodySchema.safeParse(data).data?.error;
      throw new ApiError(
        res.status,
        err?.code ?? `HTTP_${res.status}`,
        err?.message ?? `요청이 실패했어요 (HTTP ${res.status})`,
        err?.retryable ?? (res.status >= 500 || res.status === 429),
      );
    }
    return data as T;
  }

  /** 인증 없는 요청 */
  async publicRequest<T>(method: string, path: string, body: Body = null): Promise<T> {
    return this.parse<T>(await this.raw(method, path, body));
  }

  /** 인증 요청: 세션이 없으면 발급, 401이면 1회 재발급 후 재시도 */
  async request<T>(method: string, path: string, body: Body = null, headers: Record<string, string> = {}): Promise<T> {
    const s = await this.ensureSession();
    const res = await this.raw(method, path, body, { ...headers, Authorization: `Bearer ${s.token}` });
    if (res.status === 401) {
      this.clearSession();
      const s2 = await this.ensureSession();
      return this.parse<T>(await this.raw(method, path, body, { ...headers, Authorization: `Bearer ${s2.token}` }));
    }
    return this.parse<T>(res);
  }

  private loadSession(): StoredSession | null {
    const s = this.store.load<StoredSession | null>(SESSION_KEY, null);
    if (!s || typeof s.token !== 'string' || s.apiBase !== this.base) return null;
    // 만료 1시간 전부터 재발급
    if (Date.parse(s.expiresAt) - Date.now() < 3_600_000) return null;
    return s;
  }

  clearSession(): void {
    this.store.remove(SESSION_KEY);
    this.sessionPromise = null;
  }

  /** 저장된 게스트 세션 또는 새로 발급 (동시 호출은 1회로 합친다) */
  ensureSession(): Promise<StoredSession> {
    const cached = this.loadSession();
    if (cached) return Promise.resolve(cached);
    this.sessionPromise ??= (async () => {
      const nickname = this.nickname;
      const res = await this.publicRequest<GuestSessionResponse>('POST', `${API_PREFIX}/sessions/guest`, { json: { nickname } });
      const s: StoredSession = { ...res, nickname, apiBase: this.base };
      this.store.save(SESSION_KEY, s);
      return s;
    })().finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  /** 런타임 설정. 연결 실패 시 error를 담아 null 반환 (30초 캐시, force로 갱신) */
  async getConfig(force = false): Promise<{ config: RuntimeConfig | null; error: ApiError | null }> {
    if (!force && this.config && Date.now() - this.config.at < CONFIG_TTL_MS) return { config: this.config.value, error: this.config.error };
    try {
      const value = await this.publicRequest<RuntimeConfig>('GET', `${API_PREFIX}/config`);
      this.config = { at: Date.now(), value, error: null };
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(0, 'NETWORK', String(e), true);
      this.config = { at: Date.now(), value: null, error };
    }
    return { config: this.config.value, error: this.config.error };
  }

  upload(file: Blob, filename: string, rightsAttested: boolean): Promise<UploadResponse> {
    const form = new FormData();
    form.append('rightsAttested', rightsAttested ? 'true' : 'false');
    form.append('file', file, filename);
    return this.request<UploadResponse>('POST', `${API_PREFIX}/uploads`, { form });
  }

  generate(req: GenerateRequest, idempotencyKey: string): Promise<GenerateResponse> {
    return this.request<GenerateResponse>('POST', `${API_PREFIX}/characters/generate`, { json: req }, { 'Idempotency-Key': idempotencyKey });
  }

  getJob(jobId: string): Promise<JobView> {
    return this.request<JobView>('GET', `${API_PREFIX}/jobs/${encodeURIComponent(jobId)}`);
  }

  retryJob(jobId: string): Promise<JobView> {
    return this.request<JobView>('POST', `${API_PREFIX}/jobs/${encodeURIComponent(jobId)}/retry`, { json: {} });
  }

  listCharacters(): Promise<CharacterListResponse> {
    return this.request<CharacterListResponse>('GET', `${API_PREFIX}/characters`);
  }

  getCharacter(id: string): Promise<CharacterManifest> {
    return this.request<CharacterManifest>('GET', `${API_PREFIX}/characters/${encodeURIComponent(id)}`);
  }

  reportMatch(report: MatchReport, idempotencyKey: string): Promise<{ matchId: string }> {
    return this.request<{ matchId: string }>('POST', `${API_PREFIX}/matches`, { json: report }, { 'Idempotency-Key': idempotencyKey });
  }

  lookupRoom(code: string): Promise<RoomLookupResponse> {
    return this.request<RoomLookupResponse>('GET', `${API_PREFIX}/rooms/${encodeURIComponent(code.toUpperCase())}`);
  }
}

const apiBase = resolveApiBase(import.meta.env as { VITE_API_URL?: string; DEV?: boolean });

/** 앱 전역 클라이언트. null = 서버 미설정 */
export const api: ApiClient | null = apiBase ? new ApiClient(apiBase) : null;

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 사용자에게 보여줄 오류 문구 */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return String((e as Error)?.message ?? e);
}

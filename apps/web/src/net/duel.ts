// 온라인 1:1 duel 룸 연결 (Colyseus 0.18, @colyseus/sdk). 상태 스냅샷·일회성 메시지·시계 동기화·재접속 토큰 관리.
// 프로토콜: packages/shared/src/net.ts (ClientMessages / ServerMessages), docs/07-MULTIPLAYER.md, docs/08 §4.
import { Client, type Room } from '@colyseus/sdk';
import { z } from 'zod';
import {
  MATCH_PHASES,
  MATCH_RULES,
  ROOM_NAME,
  type CharacterManifest,
  type ClientMessage,
  type ClientMessageType,
  type MatchPhase,
  type ServerMessages,
} from '@mba/shared';
import { BUILTIN_CHARACTERS, manifestFromNetId } from '../characters.ts';
import { ApiError, type ApiClient } from './api.ts';
import { ClockSync } from './clock.ts';

const PlayerJsonSchema = z.object({
  userId: z.string().catch(''),
  nickname: z.string().catch(''),
  characterId: z.string().catch(''),
  connected: z.boolean().catch(true),
  ready: z.boolean().catch(false),
  calibrated: z.boolean().catch(false),
  hp: z.number().catch(MATCH_RULES.maxHp),
  action: z.string().catch('idle'),
  actionStartedAt: z.number().catch(0),
  stunUntil: z.number().catch(0),
  headX: z.number().catch(0),
  headY: z.number().catch(0),
  guard: z.number().catch(0),
});

const StateJsonSchema = z.object({
  phase: z.enum(MATCH_PHASES).catch('WAITING_OPPONENT'),
  phaseEndsAt: z.number().catch(0),
  code: z.string().catch(''),
  timeLeftMs: z.number().catch(MATCH_RULES.roundMs),
  players: z.record(z.string(), PlayerJsonSchema).catch({}),
});

export type DuelPlayer = z.infer<typeof PlayerJsonSchema> & { sessionId: string };

export interface DuelSnapshot {
  phase: MatchPhase;
  /** 서버 시각(ms). 0 = 기한 없음 */
  phaseEndsAt: number;
  code: string;
  timeLeftMs: number;
  players: DuelPlayer[];
  /** 수신 시각(로컬 performance.now) — 타이머 보간용 */
  receivedAt: number;
}

export type DuelStatus = 'connected' | 'reconnecting' | 'closed';

export type ServerErrorMessage = { code: string; message: string };
type AllServerMessages = ServerMessages & { error: ServerErrorMessage };
type AllServerMessageType = keyof AllServerMessages;

/** 수신 등록할 메시지 (Record라서 계약에 메시지가 추가되면 누락이 컴파일 오류가 된다) */
const SERVER_MESSAGES: Record<AllServerMessageType, true> = {
  'time:pong': true, 'match:countdown': true, 'match:start': true, 'match:paused': true, 'match:resumed': true,
  'combat:strike_start': true, 'strike:rejected': true, 'combat:hit': true, 'combat:blocked': true,
  'combat:dodged': true, 'match:end': true, error: true,
};
const SERVER_MESSAGE_TYPES = Object.keys(SERVER_MESSAGES) as AllServerMessageType[];

const RECONNECT_KEY = 'mba.duel.reconnect.v1';

/** 새로고침 후 재접속용 (sessionStorage, 탭 단위) */
export interface SavedDuel {
  reconnectionToken: string;
  code: string;
  inputKind: 'keyboard' | 'webcam';
  savedAt: number;
}

export function loadSavedDuel(): SavedDuel | null {
  try {
    const raw = sessionStorage.getItem(RECONNECT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedDuel;
    if (typeof s.reconnectionToken !== 'string' || Date.now() - s.savedAt > MATCH_RULES.reconnectWindowMs) return null;
    return s;
  } catch {
    return null;
  }
}

function saveDuel(s: SavedDuel | null): void {
  try {
    if (s) sessionStorage.setItem(RECONNECT_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(RECONNECT_KEY);
  } catch {
    /* 저장소 사용 불가: 새로고침 재접속만 불가 */
  }
}

/** 룸 참가 오류 → 사용자 문구 */
export function joinErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'ROOM_NOT_FOUND') return '방을 찾을 수 없어요. 코드를 확인해 주세요.';
    if (e.code === 'ROOM_FULL') return '방이 가득 찼어요 (최대 2명).';
    return e.message;
  }
  const msg = String((e as Error)?.message ?? e);
  if (/full|locked/i.test(msg)) return '방이 가득 찼어요 (최대 2명).';
  if (/not found|no rooms/i.test(msg)) return '방을 찾을 수 없어요. 코드를 확인해 주세요.';
  return `게임 서버에 접속하지 못했어요: ${msg}`;
}

export interface JoinOptions {
  characterId: string;
  inputKind: 'keyboard' | 'webcam';
}

type Handler<K extends AllServerMessageType> = (msg: AllServerMessages[K]) => void;

export class DuelConnection {
  readonly sync: ClockSync;
  state: DuelSnapshot;
  status: DuelStatus = 'connected';
  lastError: ServerErrorMessage | null = null;
  private stateListeners = new Set<(s: DuelSnapshot) => void>();
  private statusListeners = new Set<(s: DuelStatus) => void>();
  private handlers = new Map<AllServerMessageType, Set<(msg: unknown) => void>>();
  private manifests = new Map<string, Promise<CharacterManifest>>();
  private leaving = false;
  /** 새로고침·탭 닫기 시점을 재접속 창(20초)의 기준 시각으로 저장 */
  private readonly onPageHide = () => {
    if (!this.leaving) this.persist();
  };

  private constructor(
    private room: Room,
    private readonly client: Client,
    private readonly api: ApiClient,
    private readonly inputKind: 'keyboard' | 'webcam',
  ) {
    this.sync = new ClockSync((clientTime) => this.send('time:ping', { clientTime }));
    this.state = { phase: 'WAITING_OPPONENT', phaseEndsAt: 0, code: '', timeLeftMs: MATCH_RULES.roundMs, players: [], receivedAt: performance.now() };
    this.bind(room);
    this.sync.start();
    window.addEventListener('pagehide', this.onPageHide);
  }

  private static async open(api: ApiClient, how: (client: Client, opts: Record<string, string>) => Promise<Room>, inputKind: JoinOptions['inputKind'], characterId: string | null): Promise<DuelConnection> {
    const session = await api.ensureSession();
    const client = new Client(api.base);
    const opts: Record<string, string> = { token: session.token, nickname: session.nickname };
    if (characterId) opts.characterId = characterId;
    const room = await how(client, opts);
    return new DuelConnection(room, client, api, inputKind);
  }

  static create(api: ApiClient, o: JoinOptions): Promise<DuelConnection> {
    return DuelConnection.open(api, (c, opts) => c.create(ROOM_NAME, opts), o.inputKind, o.characterId);
  }

  static async joinByCode(api: ApiClient, code: string, o: JoinOptions): Promise<DuelConnection> {
    const { roomId } = await api.lookupRoom(code.trim().toUpperCase());
    return DuelConnection.open(api, (c, opts) => c.joinById(roomId, opts), o.inputKind, o.characterId);
  }

  /** 새로고침 등으로 끊긴 룸에 재접속 (서버 allowReconnection 20초) */
  static async reconnect(api: ApiClient, saved: SavedDuel): Promise<DuelConnection> {
    return DuelConnection.open(api, (c) => c.reconnect(saved.reconnectionToken), saved.inputKind, null);
  }

  get sessionId(): string {
    return this.room.sessionId;
  }

  get roomId(): string {
    return this.room.roomId;
  }

  me(): DuelPlayer | null {
    return this.state.players.find((p) => p.sessionId === this.room.sessionId) ?? null;
  }

  opponent(): DuelPlayer | null {
    return this.state.players.find((p) => p.sessionId !== this.room.sessionId) ?? null;
  }

  private bind(room: Room): void {
    room.onStateChange((raw: unknown) => this.applyState(raw));
    for (const type of SERVER_MESSAGE_TYPES) {
      room.onMessage(type, (msg: unknown) => {
        if (type === 'time:pong') this.sync.onPong(msg as ServerMessages['time:pong']);
        if (type === 'error') this.lastError = msg as ServerErrorMessage;
        for (const h of this.handlers.get(type) ?? []) h(msg);
      });
    }
    room.onDrop(() => this.setStatus('reconnecting'));
    room.onReconnect(() => {
      this.persist();
      this.setStatus('connected');
    });
    room.onLeave(() => {
      this.sync.stop();
      if (this.leaving) saveDuel(null);
      this.setStatus('closed');
    });
    this.persist();
    // 이미 받은 초기 상태 반영
    if (room.state) this.applyState(room.state);
  }

  private persist(): void {
    saveDuel({ reconnectionToken: this.room.reconnectionToken, code: this.state.code, inputKind: this.inputKind, savedAt: Date.now() });
  }

  private applyState(raw: unknown): void {
    const json = raw && typeof raw === 'object' && 'toJSON' in raw && typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
    const parsed = StateJsonSchema.safeParse(json);
    if (!parsed.success) return;
    const d = parsed.data;
    const codeChanged = d.code !== this.state.code;
    this.state = {
      phase: d.phase,
      phaseEndsAt: d.phaseEndsAt,
      code: d.code,
      timeLeftMs: d.timeLeftMs,
      players: Object.entries(d.players).map(([sessionId, p]) => ({ ...p, sessionId })),
      receivedAt: performance.now(),
    };
    if (codeChanged) this.persist();
    for (const l of this.stateListeners) l(this.state);
  }

  private setStatus(s: DuelStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  onState(l: (s: DuelSnapshot) => void): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }

  onStatus(l: (s: DuelStatus) => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  on<K extends AllServerMessageType>(type: K, h: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const fn = h as (msg: unknown) => void;
    set.add(fn);
    return () => set.delete(fn);
  }

  send<K extends ClientMessageType>(type: K, payload: ClientMessage<K>): void {
    if (this.status === 'closed') return;
    this.room.send(type, payload);
  }

  /** 서버 시각 기준 현재 */
  serverNow(): number {
    return this.sync.serverNow();
  }

  /** 룸 캐릭터 ID → 매니페스트 (기본·T0는 즉시, 서버 캐릭터는 GET /characters/:id, 실패 시 기본 복서) */
  resolveCharacter(netId: string, name?: string): Promise<CharacterManifest> {
    const local = manifestFromNetId(netId, name);
    if (local) return Promise.resolve(local);
    let p = this.manifests.get(netId);
    if (!p) {
      p = this.api.getCharacter(netId).catch((e: unknown) => {
        console.warn(`[duel] 상대 캐릭터 ${netId} 매니페스트를 받지 못해 기본 외형 사용:`, e);
        return BUILTIN_CHARACTERS[1]!;
      });
      this.manifests.set(netId, p);
    }
    return p;
  }

  /** 자발적 퇴장: 재접속 토큰 삭제 */
  async leave(): Promise<void> {
    this.leaving = true;
    this.sync.stop();
    window.removeEventListener('pagehide', this.onPageHide);
    saveDuel(null);
    if (this.status === 'closed') return;
    try {
      await this.room.leave(true);
    } catch {
      /* 이미 끊김 */
    }
  }

  /** 서버가 끊은 뒤 수동 재접속 시도 (SDK 자동 재접속이 포기한 경우) */
  async retryReconnect(): Promise<boolean> {
    if (this.leaving) return false;
    try {
      const room = await this.client.reconnect(this.room.reconnectionToken);
      this.room = room;
      this.bind(room);
      this.sync.start();
      this.setStatus('connected');
      return true;
    } catch {
      return false;
    }
  }
}

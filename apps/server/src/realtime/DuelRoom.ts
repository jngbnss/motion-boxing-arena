// Colyseus `duel` 룸 어댑터: 인증·메시지 검증·지연 주입·스키마 동기화. 경기 로직은 DuelController.
import { CloseCode, Room, ServerError, type AuthContext, type Client } from '@colyseus/core';
import { ClientMessages, MATCH_RULES, type ClientMessage, type ClientMessageType } from '@mba/shared';
import type { ZodType } from 'zod';
import { verifyToken } from '../auth.ts';
import { DuelController, TICK_MS, type DuelResult } from './controller.ts';
import type { RoomRegistry } from './registry.ts';
import { DuelState, PlayerState } from './schema.ts';

export interface DuelRoomDeps {
  authSecret: string;
  registry: RoomRegistry;
  rewindGraceMs: number;
  simLatencyMs: number;
  simJitterMs: number;
  /** 사용자 닉네임 (없으면 null → 인증 실패) */
  findUser(userId: string): Promise<{ nickname: string } | null>;
  /** builtin:* 또는 본인 소유 READY 캐릭터인가 */
  validateCharacter(userId: string, characterId: string): Promise<boolean>;
  saveResult(result: DuelResult, roomCode: string): void;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

interface AuthData {
  userId: string;
  nickname: string;
}

/** 검증 실패가 초당 이 횟수를 넘으면 연결을 끊는다 (docs/08 §4.1) */
const MAX_INVALID_PER_SECOND = 20;
/** Colyseus 자체 상한: 20Hz 포즈 + 이벤트 여유 */
const MAX_MESSAGES_PER_SECOND = 60;

const MESSAGE_TYPES = Object.keys(ClientMessages) as ClientMessageType[];
/** 키별 출력 타입을 보존한 스키마 표 (제네릭 K로 색인하기 위해) */
const SCHEMAS: { [K in ClientMessageType]: ZodType<ClientMessage<K>> } = ClientMessages;

type Handler<K extends ClientMessageType> = (c: DuelController, sessionId: string, msg: ClientMessage<K>) => Promise<void> | void;

/** 메시지 → 컨트롤러 호출. 비동기 처리(캐릭터 검증)는 끝난 뒤 다시 동기화한다 */
const HANDLERS: { [K in ClientMessageType]: Handler<K> } = {
  'time:ping': (c, sid, m) => c.ping(sid, m),
  'calib:done': (c, sid, m) => c.calibDone(sid, m),
  'room:ready': (c, sid, m) => c.setReady(sid, m),
  'input:pose': (c, sid, m) => c.pose(sid, m),
  'input:strike': (c, sid, m) => c.strike(sid, m),
  'player:character': (c, sid, m) => c.setCharacter(sid, m),
  'match:rematch': (c, sid) => c.rematch(sid),
  'match:forfeit': (c, sid) => c.forfeit(sid),
  'tracking:lost': (c, sid, m) => c.trackingLost(sid, m),
};

export function createDuelRoom(deps: DuelRoomDeps) {
  const now = deps.now ?? Date.now;

  return class DuelRoom extends Room<{ state: DuelState }> {
    override maxClients = 2;
    override maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

    private controller!: DuelController;
    private code = '';
    private disposed = false;
    private readonly invalid = new Map<string, { count: number; windowStart: number }>();
    /** SIM_LATENCY: 클라이언트별 마지막 전달 예정 시각 (순서 보존) */
    private readonly deliverAt = new Map<string, number>();

    static override async onAuth(token: string, options: unknown, _context: AuthContext): Promise<AuthData> {
      const fromOptions = options && typeof options === 'object' && 'token' in options ? options.token : undefined;
      const claims = verifyToken(deps.authSecret, fromOptions ?? token, now());
      if (!claims) throw new ServerError(401, 'UNAUTHORIZED');
      const user = await deps.findUser(claims.userId);
      if (!user) throw new ServerError(401, 'UNAUTHORIZED');
      return { userId: claims.userId, nickname: user.nickname };
    }

    override onCreate(): void {
      this.setState(new DuelState());
      this.code = deps.registry.allocate(this.roomId);
      this.state.code = this.code;
      this.state.phase = 'LOBBY';
      void this.setMetadata({ code: this.code });
      this.setPatchRate(TICK_MS);

      this.controller = new DuelController(
        {
          now,
          send: (sessionId, type, msg) => this.clients.getById(sessionId)?.send(type, msg),
          sendError: (sessionId, code, message) => this.clients.getById(sessionId)?.send('error', { code, message }),
          broadcast: (type, msg) => this.broadcast(type, msg),
          saveResult: (result) => deps.saveResult(result, this.code),
          validateCharacter: deps.validateCharacter,
        },
        { rewindGraceMs: deps.rewindGraceMs },
      );

      for (const type of MESSAGE_TYPES) {
        this.onMessage(type, (client: Client, raw: unknown) => this.inbound(client, type, raw));
      }
      this.setSimulationInterval(() => {
        this.controller.tick();
        this.sync();
      }, TICK_MS);
      this.sync();
    }

    override async onJoin(client: Client, options: unknown): Promise<void> {
      // Colyseus는 static onAuth의 반환값을 client.auth에 그대로 넣는다 (타입 정보는 전달되지 않음)
      const auth = client.auth as AuthData;
      const characterId =
        options && typeof options === 'object' && 'characterId' in options && typeof options.characterId === 'string'
          ? options.characterId
          : '';
      if (!characterId || !(await deps.validateCharacter(auth.userId, characterId))) {
        throw new ServerError(400, 'CHARACTER_NOT_READY');
      }
      // 비동기 검증 사이에 자리가 찼을 수 있다
      if (!this.controller.canJoin()) throw new ServerError(409, 'ROOM_FULL');
      this.controller.join(client.sessionId, { userId: auth.userId, nickname: auth.nickname, characterId });
      deps.log?.('duel join', { room: this.code, sessionId: client.sessionId, userId: auth.userId });
      this.sync();
    }

    override onDrop(client: Client): void {
      this.controller.drop(client.sessionId);
      this.sync();
      // 20초 재접속 대기. 실패하면 Colyseus가 onLeave를 호출한다
      this.allowReconnection(client, MATCH_RULES.reconnectWindowMs / 1000).catch(() => undefined);
    }

    override onReconnect(client: Client): void {
      this.controller.reconnect(client.sessionId);
      this.sync();
    }

    override onLeave(client: Client): void {
      this.controller.leave(client.sessionId);
      this.invalid.delete(client.sessionId);
      this.deliverAt.delete(client.sessionId);
      this.sync();
    }

    override onDispose(): void {
      this.disposed = true;
      this.controller.dispose();
      deps.registry.release(this.code);
    }

    /** SIM_LATENCY_MS(+지터)만큼 늦춰 처리. 클라이언트별 순서는 보존한다 */
    private inbound(client: Client, type: ClientMessageType, raw: unknown): void {
      const delay = deps.simLatencyMs + (deps.simJitterMs > 0 ? Math.random() * deps.simJitterMs : 0);
      if (delay <= 0) {
        this.handle(client, type, raw);
        return;
      }
      const t = Math.max(now() + delay, this.deliverAt.get(client.sessionId) ?? 0);
      this.deliverAt.set(client.sessionId, t);
      setTimeout(() => {
        if (!this.disposed) this.handle(client, type, raw);
      }, t - now());
    }

    private handle<K extends ClientMessageType>(client: Client, type: K, raw: unknown): void {
      const schema: ZodType<ClientMessage<K>> = SCHEMAS[type];
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) {
        client.send('error', { code: 'VALIDATION_FAILED', message: `${type}: ${parsed.error.issues[0]?.message ?? 'invalid'}` });
        this.countInvalid(client);
        return;
      }
      const handler: Handler<K> = HANDLERS[type];
      const pending = handler(this.controller, client.sessionId, parsed.data);
      if (pending) void pending.then(() => this.sync());
      this.sync();
    }

    private countInvalid(client: Client): void {
      const t = now();
      const w = this.invalid.get(client.sessionId);
      if (!w || t - w.windowStart >= 1000) {
        this.invalid.set(client.sessionId, { count: 1, windowStart: t });
        return;
      }
      w.count++;
      if (w.count > MAX_INVALID_PER_SECOND) {
        deps.log?.('duel kick: too many invalid messages', { room: this.code, sessionId: client.sessionId });
        client.leave(CloseCode.CONSENTED);
      }
    }

    /** 컨트롤러 → Colyseus 스키마 */
    private sync(): void {
      if (this.disposed) return;
      const s = this.state;
      const c = this.controller;
      s.phase = c.phase;
      s.phaseEndsAt = c.phaseEndsAt;
      s.timeLeftMs = c.timeLeftMs;
      const views = c.players();
      const seen = new Set<string>();
      for (const v of views) {
        seen.add(v.sessionId);
        let p = s.players.get(v.sessionId);
        if (!p) {
          p = new PlayerState();
          s.players.set(v.sessionId, p);
        }
        p.userId = v.userId;
        p.nickname = v.nickname;
        p.characterId = v.characterId;
        p.connected = v.connected;
        p.ready = v.ready;
        p.calibrated = v.calibrated;
        p.hp = v.hp;
        p.action = v.action;
        p.actionStartedAt = v.actionStartedAt;
        p.stunUntil = v.stunUntil;
        p.headX = v.headX;
        p.headY = v.headY;
        p.guard = v.guard;
      }
      for (const key of [...s.players.keys()]) {
        if (!seen.has(key)) s.players.delete(key);
      }
      deps.registry.setPlayers(this.code, c.userIds);
    }
  };
}

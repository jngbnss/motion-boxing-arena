// DuelRoom의 순수 경기 로직 (C8 단계 머신, C10~C12, C17, docs/07). Colyseus와 무관하고 시계를 주입받아 결정적으로 테스트한다.
// 서버 시각 = ports.now() (Date.now 기반 ms). 클라이언트는 t를 서버 시각으로 환산해 보낸다 (contracts).
// CombatSim에는 "시뮬레이션 시각" = 서버 시각 − 누적 정지 시간(simOffset)을 넣어 일시정지가 판정에 보이지 않게 한다.
import { CombatSim, STRIKES, type CombatEvent, type FighterId } from '@mba/combat';
import {
  GUARD_BLOCK_THRESHOLD,
  MATCH_RULES,
  MIN_STRIKE_CONFIDENCE,
  MVP_STRIKE_TYPES,
  canTransition,
  emptyStats,
  type ClientMessage,
  type FighterStats,
  type MatchEndReason,
  type MatchPhase,
  type PauseReason,
  type ServerMessages,
  type ServerMessageType,
} from '@mba/shared';

/** 입력 시각 허용 오차 (docs/07 §4.11) */
export const INPUT_CLOCK_TOLERANCE_MS = 1_000;
/** 이 시간 동안 input:pose가 없으면 그 사이 펀치는 무시 (포즈 생존) */
export const POSE_LIVENESS_MS = 1_000;
/** 연결은 살아 있지만 input:pose가 이만큼 끊기면 NETWORK 일시정지 */
export const POSE_SILENCE_PAUSE_MS = 3_000;
/** KO/TIME_UP/FORFEIT 연출 유지 후 RESULT */
export const END_HOLD_MS = 2_000;
/** 서버 틱 30Hz (docs/07 §7) */
export const TICK_MS = Math.round(1000 / 30);

export type ErrorCode = 'PHASE_INVALID' | 'NOT_CALIBRATED' | 'CHARACTER_NOT_READY' | 'VALIDATION_FAILED';

export interface DuelPorts {
  now(): number;
  send<K extends ServerMessageType>(sessionId: string, type: K, msg: ServerMessages[K]): void;
  sendError(sessionId: string, code: ErrorCode, message: string): void;
  broadcast<K extends ServerMessageType>(type: K, msg: ServerMessages[K]): void;
  /** 결과 저장 (비동기, 재시도는 구현 쪽) */
  saveResult(result: DuelResult): void;
  /** builtin: 또는 본인 소유 READY 캐릭터인가 */
  validateCharacter(userId: string, characterId: string): Promise<boolean>;
}

export interface DuelOptions {
  /** 판정 지연 (C10 REWIND_GRACE) */
  rewindGraceMs: number;
}

export interface DuelResultPlayer {
  sessionId: string;
  userId: string;
  nickname: string;
  characterId: string;
  slot: 0 | 1;
  hpEnd: number;
  won: boolean | null;
  stats: FighterStats;
}

export interface DuelResult {
  reason: MatchEndReason;
  winnerSessionId: string | null;
  winnerUserId: string | null;
  durationMs: number;
  players: DuelResultPlayer[];
}

export interface SeatInfo {
  userId: string;
  nickname: string;
  characterId: string;
}

interface Seat extends SeatInfo {
  sessionId: string;
  connected: boolean;
  ready: boolean;
  calibrated: boolean;
  calibQuality: number;
  rematch: boolean;
  lastSeq: number;
  lastPoseRecvAt: number;
  lastPoseT: number;
  headX: number;
  headY: number;
  guard: number;
  action: string;
  actionStartedAt: number;
  actionEndsAt: number;
  /** 추적 손실 시작 서버 시각 (보고 기준). null이면 추적 중 */
  trackingLostSince: number | null;
  /** 이번 경기 추적 손실 PAUSED 누적 (C12, 30초 예산) */
  trackingPausedMs: number;
}

interface PauseCause {
  reason: Exclude<PauseReason, 'USER'>;
  sessionId: string;
  since: number;
  deadline: number;
}

/** 스키마 동기화용 공개 뷰 */
export interface PlayerView {
  sessionId: string;
  userId: string;
  nickname: string;
  characterId: string;
  connected: boolean;
  ready: boolean;
  calibrated: boolean;
  hp: number;
  action: string;
  actionStartedAt: number;
  stunUntil: number;
  headX: number;
  headY: number;
  guard: number;
}

const JOINABLE: readonly MatchPhase[] = ['LOBBY', 'WAITING_OPPONENT'];
const CALIB_PHASES: readonly MatchPhase[] = ['LOBBY', 'WAITING_OPPONENT', 'CALIBRATING', 'READY'];
const READY_PHASES: readonly MatchPhase[] = ['WAITING_OPPONENT', 'CALIBRATING', 'READY'];
/** player:character는 READY 이전에만 (C13) */
const CHARACTER_PHASES: readonly MatchPhase[] = ['LOBBY', 'WAITING_OPPONENT', 'CALIBRATING', 'RESULT'];
const LIVE_PHASES: readonly MatchPhase[] = ['COUNTDOWN', 'FIGHTING', 'PAUSED'];
const END_PHASES: readonly MatchPhase[] = ['KO', 'TIME_UP', 'FORFEIT'];

export class DuelController {
  private readonly ports: DuelPorts;
  private readonly opts: DuelOptions;
  private readonly seats: Seat[] = [];

  phase: MatchPhase = 'LOBBY';
  /** 현재 단계의 마감 서버 시각 (카운트다운 시작 시각, 일시정지 마감, 종료 연출 끝). 없으면 0 */
  phaseEndsAt = 0;
  timeLeftMs: number = MATCH_RULES.roundMs;

  private sim: CombatSim | null = null;
  private started = false;
  /** 누적 정지 시간: simTime = serverTime − simOffset */
  private simOffset = 0;
  /** FIGHTING을 떠난 서버 시각 (재개 시 simOffset에 더한다) */
  private frozenAt = 0;
  private fightEndsAt = 0;
  private fightingEnteredAt = 0;
  private causes: PauseCause[] = [];

  constructor(ports: DuelPorts, opts: DuelOptions) {
    this.ports = ports;
    this.opts = opts;
  }

  // ── 조회 ────────────────────────────────────────────────────────────────

  get playerCount(): number {
    return this.seats.length;
  }

  get userIds(): string[] {
    return this.seats.map((s) => s.userId);
  }

  canJoin(): boolean {
    return this.seats.length < 2 && JOINABLE.includes(this.phase);
  }

  players(): PlayerView[] {
    const now = this.ports.now();
    return this.seats.map((s) => {
      const f = this.sim?.fighter(s.sessionId);
      let action = s.action;
      if (now >= s.actionEndsAt && action !== 'ko') action = s.guard >= GUARD_BLOCK_THRESHOLD ? 'guard' : 'idle';
      return {
        sessionId: s.sessionId,
        userId: s.userId,
        nickname: s.nickname,
        characterId: s.characterId,
        connected: s.connected,
        ready: s.ready,
        calibrated: s.calibrated,
        hp: f ? f.hp : MATCH_RULES.maxHp,
        action,
        actionStartedAt: s.actionStartedAt,
        stunUntil: f && this.started ? f.stunUntil + this.simOffset : 0,
        headX: s.headX,
        headY: s.headY,
        guard: s.guard,
      };
    });
  }

  // ── 입장·퇴장 ───────────────────────────────────────────────────────────

  join(sessionId: string, info: SeatInfo): void {
    if (!this.canJoin()) throw new Error('ROOM_FULL');
    this.seats.push({
      ...info,
      sessionId,
      connected: true,
      ready: false,
      calibrated: false,
      calibQuality: 0,
      rematch: false,
      lastSeq: -1,
      lastPoseRecvAt: -Infinity,
      lastPoseT: -Infinity,
      headX: 0,
      headY: 0,
      guard: 0,
      action: 'idle',
      actionStartedAt: 0,
      actionEndsAt: 0,
      trackingLostSince: null,
      trackingPausedMs: 0,
    });
    if (this.phase === 'LOBBY') this.transition('WAITING_OPPONENT');
    if (this.seats.length === 2) {
      this.transition('CALIBRATING');
      this.maybeAdvance();
    }
  }

  /** 비동의 연결 끊김. 재접속 대기(20초)는 어댑터가 allowReconnection으로 연다 */
  drop(sessionId: string): void {
    const seat = this.seat(sessionId);
    if (!seat) return;
    seat.connected = false;
    if (LIVE_PHASES.includes(this.phase)) this.addCause('DISCONNECT', seat);
  }

  reconnect(sessionId: string): void {
    const seat = this.seat(sessionId);
    if (!seat) return;
    seat.connected = true;
    // 재접속 직후 포즈가 다시 들어오기 전에 NETWORK 정지가 걸리지 않게 생존 시각을 갱신
    seat.lastPoseRecvAt = this.ports.now();
    this.removeCause('DISCONNECT', sessionId);
    this.maybeAdvance();
  }

  /** 영구 퇴장 (동의 퇴장 또는 재접속 실패) */
  leave(sessionId: string): void {
    const seat = this.seat(sessionId);
    if (!seat) return;
    if (LIVE_PHASES.includes(this.phase)) {
      const other = this.opponent(sessionId);
      const abandoned = !other || !other.connected;
      this.endMatch(abandoned ? 'ABANDONED' : 'FORFEIT', abandoned ? null : other.sessionId);
    }
    this.seats.splice(this.seats.indexOf(seat), 1);
    this.causes = this.causes.filter((c) => c.sessionId !== sessionId);
    if (END_PHASES.includes(this.phase)) return; // RESULT 진입 때 정리
    this.resetToLobbyIfAlone();
  }

  /** 룸 폐기: 진행 중 경기는 ABANDONED로 저장 */
  dispose(): void {
    if (LIVE_PHASES.includes(this.phase) && this.started) this.endMatch('ABANDONED', null);
  }

  // ── 메시지 ──────────────────────────────────────────────────────────────

  ping(sessionId: string, msg: ClientMessage<'time:ping'>): void {
    this.ports.send(sessionId, 'time:pong', { clientTime: msg.clientTime, serverTime: this.ports.now() });
  }

  calibDone(sessionId: string, msg: ClientMessage<'calib:done'>): void {
    const seat = this.seat(sessionId);
    if (!seat) return;
    if (!CALIB_PHASES.includes(this.phase)) {
      this.ports.sendError(sessionId, 'PHASE_INVALID', `calib:done not allowed in ${this.phase}`);
      return;
    }
    seat.calibrated = true;
    // 품질 0.5 미만은 경고만 하고 막지 않는다 (docs/07 §4.4)
    seat.calibQuality = msg.quality;
    this.maybeAdvance();
  }

  setReady(sessionId: string, msg: ClientMessage<'room:ready'>): void {
    const seat = this.seat(sessionId);
    if (!seat) return;
    if (!seat.calibrated) {
      this.ports.sendError(sessionId, 'NOT_CALIBRATED', 'calibrate before ready');
      return;
    }
    if (!READY_PHASES.includes(this.phase)) {
      this.ports.sendError(sessionId, 'PHASE_INVALID', `room:ready not allowed in ${this.phase}`);
      return;
    }
    seat.ready = msg.ready;
    this.maybeAdvance();
  }

  async setCharacter(sessionId: string, msg: ClientMessage<'player:character'>): Promise<void> {
    const seat = this.seat(sessionId);
    if (!seat) return;
    if (!CHARACTER_PHASES.includes(this.phase)) {
      this.ports.sendError(sessionId, 'PHASE_INVALID', `player:character not allowed in ${this.phase}`);
      return;
    }
    const ok = await this.ports.validateCharacter(seat.userId, msg.characterId);
    if (!ok) {
      this.ports.sendError(sessionId, 'CHARACTER_NOT_READY', `character ${msg.characterId} is not available`);
      return;
    }
    // 검증(비동기) 중에 단계가 바뀌었거나 퇴장했을 수 있다
    if (!CHARACTER_PHASES.includes(this.phase) || !this.seats.includes(seat)) {
      this.ports.sendError(sessionId, 'PHASE_INVALID', `player:character not allowed in ${this.phase}`);
      return;
    }
    seat.characterId = msg.characterId;
  }

  /** 범위 밖 시각·역행 샘플은 조용히 버린다 */
  pose(sessionId: string, msg: ClientMessage<'input:pose'>): void {
    const seat = this.seat(sessionId);
    if (!seat) return;
    const now = this.ports.now();
    if (Math.abs(msg.t - now) > INPUT_CLOCK_TOLERANCE_MS || msg.t <= seat.lastPoseT) return;
    seat.lastPoseT = msg.t;
    seat.lastPoseRecvAt = now;
    seat.headX = msg.headX;
    seat.headY = msg.headY;
    seat.guard = msg.guard;
    if (this.phase === 'FIGHTING' && this.sim && msg.t >= this.fightingEnteredAt) {
      this.sim.pushPose(sessionId, { headX: msg.headX, headY: msg.headY, guard: msg.guard, t: msg.t - this.simOffset });
    }
    if (this.phase === 'PAUSED') this.removeCause('NETWORK', sessionId);
  }

  strike(sessionId: string, msg: ClientMessage<'input:strike'>): void {
    const seat = this.seat(sessionId);
    if (!seat) return;
    // 중복·재전송: 조용히 버린다 (원래 공격의 예측 애니메이션을 취소시키지 않도록)
    if (msg.seq <= seat.lastSeq) return;
    seat.lastSeq = msg.seq;
    const reject = (reason: ServerMessages['strike:rejected']['reason']) =>
      this.ports.send(sessionId, 'strike:rejected', { seq: msg.seq, reason });

    const now = this.ports.now();
    // 종료 시각 이후(REWIND_GRACE 판정 대기 중)의 입력도 FIGHTING 밖으로 본다
    if (this.phase !== 'FIGHTING' || !this.sim || now >= this.fightEndsAt) return reject('PHASE');
    if (!MVP_STRIKE_TYPES.includes(msg.type) || !STRIKES[msg.type]) return reject('TYPE_DISABLED');
    // C12: 낮은 confidence 이벤트는 게임이 무시한다
    if (msg.confidence < MIN_STRIKE_CONFIDENCE) return;
    if (Math.abs(msg.t - now) > INPUT_CLOCK_TOLERANCE_MS) return reject('STALE');
    if (now - seat.lastPoseRecvAt > POSE_LIVENESS_MS) return reject('STALE');

    // 조준 고정 = 서버 수신 시각 (C10 PvP)
    const ev = this.sim.requestStrike(sessionId, { type: msg.type, hand: msg.hand, seq: msg.seq, t: now - this.simOffset });
    if (ev.kind === 'strike_rejected') return reject(ev.reason);
    if (ev.kind !== 'strike_start') return;
    const s = ev.strike;
    seat.action = `${s.type}_${s.hand}`;
    seat.actionStartedAt = now;
    seat.actionEndsAt = s.recoveryEndsAt + this.simOffset;
    this.ports.broadcast('combat:strike_start', {
      attacker: sessionId,
      type: s.type,
      hand: s.hand,
      seq: s.seq,
      activeAt: s.activeAt + this.simOffset,
    });
  }

  forfeit(sessionId: string): void {
    if (this.phase !== 'FIGHTING' && this.phase !== 'PAUSED') return;
    const other = this.opponent(sessionId);
    this.endMatch('FORFEIT', other?.sessionId ?? null);
  }

  rematch(sessionId: string): void {
    const seat = this.seat(sessionId);
    if (!seat || this.phase !== 'RESULT') return;
    seat.rematch = true;
    if (this.seats.length === 2 && this.seats.every((s) => s.rematch && s.connected)) {
      this.resetMatch();
      // 재대결은 캘리브레이션을 생략한다 (C8)
      this.transition('READY');
    }
  }

  trackingLost(sessionId: string, msg: ClientMessage<'tracking:lost'>): void {
    const seat = this.seat(sessionId);
    if (!seat) return;
    const now = this.ports.now();
    if (msg.lost) {
      // 클라이언트가 보고한 손실 시작 시각. 서버 시각 기준 [now − 3s, now]로 제한
      if (seat.trackingLostSince === null) {
        seat.trackingLostSince = Math.min(now, Math.max(now - MATCH_RULES.trackingLossPauseMs.online, msg.t));
      }
    } else {
      seat.trackingLostSince = null;
      this.removeCause('TRACKING_LOST', sessionId);
    }
  }

  // ── 틱 (30Hz) ───────────────────────────────────────────────────────────

  tick(): void {
    const now = this.ports.now();
    switch (this.phase) {
      case 'COUNTDOWN':
        if (now >= this.phaseEndsAt) this.enterFighting(now);
        break;
      case 'FIGHTING':
        this.tickFighting(now);
        break;
      case 'PAUSED':
        this.tickPaused(now);
        break;
      case 'KO':
      case 'TIME_UP':
      case 'FORFEIT':
        if (now >= this.phaseEndsAt) this.enterResult();
        break;
      default:
        break;
    }
  }

  private tickFighting(now: number): void {
    const sim = this.sim!;
    const endsAt = this.fightEndsAt;
    // 판정은 REWIND_GRACE만큼 늦게: 늦게 도착한 방어자 포즈를 반영 (방어자 우선)
    const judgeAt = Math.min(now - this.opts.rewindGraceMs, endsAt);
    this.handleEvents(sim.step(judgeAt - this.simOffset));
    if (this.phase !== 'FIGHTING') return;

    if (now >= endsAt + this.opts.rewindGraceMs) {
      this.timeLeftMs = 0;
      this.handleEvents(sim.step(endsAt - this.simOffset));
      if (this.phase !== 'FIGHTING') return;
      this.endByTime();
      return;
    }
    this.timeLeftMs = Math.max(0, endsAt - now);

    for (const seat of this.seats) {
      if (!seat.connected) continue;
      if (seat.trackingLostSince !== null && now - seat.trackingLostSince >= MATCH_RULES.trackingLossPauseMs.online) {
        this.addCause('TRACKING_LOST', seat);
      } else if (now - Math.max(seat.lastPoseRecvAt, this.fightingEnteredAt) >= POSE_SILENCE_PAUSE_MS) {
        this.addCause('NETWORK', seat);
      }
      if (this.phase !== 'FIGHTING' && this.phase !== 'PAUSED') return;
    }
  }

  private tickPaused(now: number): void {
    for (const cause of [...this.causes]) {
      const seat = this.seat(cause.sessionId);
      if (!seat) continue;
      const budgetExceeded =
        cause.reason === 'TRACKING_LOST' &&
        seat.trackingPausedMs + (now - cause.since) > MATCH_RULES.trackingPauseBudgetMs;
      if (now >= cause.deadline || budgetExceeded) {
        const other = this.opponent(seat.sessionId);
        const abandoned = !seat.connected && (!other || !other.connected);
        this.endMatch(abandoned ? 'ABANDONED' : 'FORFEIT', abandoned ? null : (other?.sessionId ?? null));
        return;
      }
    }
  }

  private handleEvents(events: CombatEvent[]): void {
    for (const ev of events) {
      switch (ev.kind) {
        case 'hit': {
          const target = this.seat(ev.strike.defender);
          const stunUntil = ev.stunUntil + this.simOffset;
          if (target) {
            target.action = `hit_${ev.zone}`;
            target.actionStartedAt = ev.t + this.simOffset;
            target.actionEndsAt = stunUntil;
          }
          this.ports.broadcast('combat:hit', {
            attacker: ev.strike.attacker,
            target: ev.strike.defender,
            zone: ev.zone,
            damage: ev.damage,
            hpAfter: ev.hpAfter,
            stunUntil,
            seq: ev.strike.seq,
          });
          break;
        }
        case 'blocked': {
          const target = this.seat(ev.strike.defender);
          if (target) {
            target.action = 'block';
            target.actionStartedAt = ev.t + this.simOffset;
            target.actionEndsAt = target.actionStartedAt + 200;
          }
          this.ports.broadcast('combat:blocked', {
            attacker: ev.strike.attacker,
            target: ev.strike.defender,
            chip: ev.chip,
            hpAfter: ev.hpAfter,
            seq: ev.strike.seq,
          });
          break;
        }
        case 'dodged':
          this.ports.broadcast('combat:dodged', { attacker: ev.strike.attacker, target: ev.strike.defender, seq: ev.strike.seq });
          break;
        case 'ko': {
          const loser = this.seat(ev.loser);
          if (loser) {
            loser.action = 'ko';
            loser.actionStartedAt = ev.t + this.simOffset;
            loser.actionEndsAt = Infinity;
          }
          this.endMatch('KO', ev.winner);
          return;
        }
        default:
          // strike_cancelled(경직으로 끊긴 공격)은 별도 메시지가 없다: 공격자에게 간 combat:hit으로 표현된다
          break;
      }
    }
  }

  // ── 단계 전이 ───────────────────────────────────────────────────────────

  private transition(to: MatchPhase): void {
    if (!canTransition(this.phase, to)) throw new Error(`illegal phase transition ${this.phase} → ${to}`);
    this.phase = to;
    this.phaseEndsAt = 0;
  }

  private maybeAdvance(): void {
    if (this.seats.length !== 2) return;
    if (this.phase === 'CALIBRATING' && this.seats.every((s) => s.calibrated)) this.transition('READY');
    if (this.phase === 'READY' && this.seats.every((s) => s.ready && s.connected)) {
      const now = this.ports.now();
      this.transition('COUNTDOWN');
      this.phaseEndsAt = now + MATCH_RULES.countdownMs;
      this.ports.broadcast('match:countdown', { startAt: this.phaseEndsAt, reason: 'start' });
    }
  }

  private enterFighting(now: number): void {
    this.transition('FIGHTING');
    this.fightingEnteredAt = now;
    if (!this.started) {
      const [a, b] = this.seats as [Seat, Seat];
      const fighters: readonly [FighterId, FighterId] = [a.sessionId, b.sessionId];
      this.started = true;
      this.simOffset = 0;
      this.sim = new CombatSim({ fighters, startTime: now, maxHp: MATCH_RULES.maxHp });
      this.timeLeftMs = MATCH_RULES.roundMs;
      for (const s of this.seats) s.trackingPausedMs = 0;
      this.ports.broadcast('match:start', { startedAt: now, durationMs: MATCH_RULES.roundMs });
    } else {
      this.simOffset += now - this.frozenAt;
    }
    this.fightEndsAt = now + this.timeLeftMs;
  }

  private addCause(reason: PauseCause['reason'], seat: Seat): void {
    if (this.causes.some((c) => c.reason === reason && c.sessionId === seat.sessionId)) return;
    const now = this.ports.now();
    const budgetLeft = Math.max(0, MATCH_RULES.trackingPauseBudgetMs - seat.trackingPausedMs);
    const window = reason === 'TRACKING_LOST' ? Math.min(MATCH_RULES.reconnectWindowMs, budgetLeft) : MATCH_RULES.reconnectWindowMs;
    const cause: PauseCause = { reason, sessionId: seat.sessionId, since: now, deadline: now + window };
    this.causes.push(cause);
    if (this.phase === 'FIGHTING') {
      this.frozenAt = now;
      this.timeLeftMs = Math.max(0, this.fightEndsAt - now);
      this.transition('PAUSED');
    } else if (this.phase === 'COUNTDOWN') {
      this.transition('PAUSED');
    }
    this.phaseEndsAt = Math.min(...this.causes.map((c) => c.deadline));
    this.ports.broadcast('match:paused', {
      reason,
      player: seat.sessionId,
      resumeDeadline: cause.deadline,
      pauseBudgetLeftMs: budgetLeft,
    });
  }

  private removeCause(reason: PauseCause['reason'], sessionId: string): void {
    const cause = this.causes.find((c) => c.reason === reason && c.sessionId === sessionId);
    if (!cause) return;
    const now = this.ports.now();
    this.causes = this.causes.filter((c) => c !== cause);
    const seat = this.seat(sessionId);
    if (seat && reason === 'TRACKING_LOST') seat.trackingPausedMs += now - cause.since;
    if (this.phase !== 'PAUSED') return;
    if (this.causes.length > 0) {
      this.phaseEndsAt = Math.min(...this.causes.map((c) => c.deadline));
      return;
    }
    // 모든 사유 해소 → 3초 카운트다운 후 재개
    this.transition('COUNTDOWN');
    this.phaseEndsAt = now + MATCH_RULES.resumeCountdownMs;
    this.ports.broadcast('match:resumed', { countdownStartAt: now });
    this.ports.broadcast('match:countdown', { startAt: this.phaseEndsAt, reason: 'resume' });
  }

  private endByTime(): void {
    const [a, b] = this.seats as [Seat, Seat];
    const hpA = this.sim!.fighter(a.sessionId).hp;
    const hpB = this.sim!.fighter(b.sessionId).hp;
    // 남은 HP 비율 판정, 동률은 무승부 (docs/07 §4.12)
    const winner = hpA === hpB ? null : hpA > hpB ? a.sessionId : b.sessionId;
    this.finish('TIME_UP', 'TIME_UP', winner);
  }

  private endMatch(reason: Exclude<MatchEndReason, 'TIME_UP'>, winner: string | null): void {
    if (this.phase === 'COUNTDOWN') this.transition('PAUSED');
    if (reason === 'KO') this.finish('KO', 'KO', winner);
    else this.finish('FORFEIT', reason, winner);
  }

  private finish(phase: 'KO' | 'TIME_UP' | 'FORFEIT', reason: MatchEndReason, winner: string | null): void {
    const now = this.ports.now();
    if (this.phase === 'FIGHTING') this.timeLeftMs = Math.max(0, this.fightEndsAt - now);
    this.transition(phase);
    this.phaseEndsAt = now + END_HOLD_MS;
    this.causes = [];
    const durationMs = this.started ? MATCH_RULES.roundMs - this.timeLeftMs : 0;
    const stats: Record<string, FighterStats> = {};
    const players: DuelResultPlayer[] = this.seats.map((s, i) => {
      const f = this.sim?.fighter(s.sessionId);
      stats[s.sessionId] = f ? f.stats : emptyStats();
      return {
        sessionId: s.sessionId,
        userId: s.userId,
        nickname: s.nickname,
        characterId: s.characterId,
        slot: i === 0 ? 0 : 1,
        hpEnd: f ? f.hp : MATCH_RULES.maxHp,
        won: winner === null ? null : s.sessionId === winner,
        stats: stats[s.sessionId]!,
      };
    });
    this.ports.broadcast('match:end', { reason, winner, stats, durationMs });
    const winnerSeat = winner ? this.seat(winner) : undefined;
    this.ports.saveResult({ reason, winnerSessionId: winner, winnerUserId: winnerSeat?.userId ?? null, durationMs, players });
  }

  private enterResult(): void {
    this.transition('RESULT');
    for (const s of this.seats) {
      s.rematch = false;
      s.ready = false;
      s.trackingLostSince = null;
    }
    this.resetToLobbyIfAlone();
  }

  /** 상대가 떠나 혼자 남으면 LOBBY → WAITING_OPPONENT로 돌아가 새 상대를 받는다 */
  private resetToLobbyIfAlone(): void {
    if (this.seats.length >= 2) return;
    if (this.phase !== 'LOBBY') {
      if (!canTransition(this.phase, 'LOBBY')) return;
      this.transition('LOBBY');
      this.resetMatch();
    }
    if (this.seats.length === 1) this.transition('WAITING_OPPONENT');
  }

  private resetMatch(): void {
    this.sim = null;
    this.started = false;
    this.simOffset = 0;
    this.frozenAt = 0;
    this.fightEndsAt = 0;
    this.timeLeftMs = MATCH_RULES.roundMs;
    this.causes = [];
    for (const s of this.seats) {
      s.ready = false;
      s.rematch = false;
      s.lastSeq = -1;
      s.action = 'idle';
      s.actionStartedAt = 0;
      s.actionEndsAt = 0;
      s.trackingLostSince = null;
      s.trackingPausedMs = 0;
    }
  }

  // ── 보조 ────────────────────────────────────────────────────────────────

  private seat(sessionId: string): Seat | undefined {
    return this.seats.find((s) => s.sessionId === sessionId);
  }

  private opponent(sessionId: string): Seat | undefined {
    return this.seats.find((s) => s.sessionId !== sessionId);
  }
}

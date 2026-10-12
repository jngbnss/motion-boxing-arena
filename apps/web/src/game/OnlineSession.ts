// 온라인 1:1 경기 세션 (GameSession과 병렬): 서버 권한 판정(docs/07).
// - 입력: input:pose 20Hz, input:strike 즉시 (t는 서버 시각으로 환산해 보낸다 — contracts 결정)
// - 내 펀치는 즉시 예측 재생, strike:rejected면 취소. 명중 연출은 combat:hit 수신 후.
// - 상대: 상태 패치의 headX/headY/guard를 약 100ms 보간 버퍼로 재생, combat:strike_start는 늦게 받은 만큼 앞당겨 재생.
// - HP·타이머·단계는 서버 상태(DuelState)를 그대로 표시.
import { COMBAT_RULES, STRIKES } from '@mba/combat';
import {
  MATCH_RULES,
  MIN_STRIKE_CONFIDENCE,
  neutralPose,
  emptyStats,
  type CharacterManifest,
  type FighterStats,
  type Hand,
  type MatchPhase,
  type PauseReason,
  type ServerMessages,
  type StrikeType,
} from '@mba/shared';
import type { StrikeTimeline } from '../avatar/types.ts';
import type { InputSource } from '../input/types.ts';
import type { DuelConnection, DuelSnapshot, DuelStatus } from '../net/duel.ts';
import type { Settings } from '../settings.ts';
import type { HudEvent, HudSnapshot, MotionLogEntry } from './GameSession.ts';
import type { MatchOutcome } from './LocalMatch.ts';
import { MatchScene } from './MatchScene.ts';

/** 상대 포즈 보간 지연 (docs/07 §4.7) */
export const INTERP_DELAY_MS = 100;
const POSE_SEND_INTERVAL_MS = 50;
/** HUD "네트워크 불안정" 표시 기준 (docs/07 §4.9) */
export const UNSTABLE_RTT_MS = 250;

export interface PoseSample {
  t: number;
  headX: number;
  headY: number;
  guard: number;
}

/** 보간 버퍼: renderAt 시각의 포즈 (양끝 밖은 가장 가까운 샘플 유지) */
export function samplePose(buf: readonly PoseSample[], renderAt: number): PoseSample | null {
  if (buf.length === 0) return null;
  if (renderAt <= buf[0]!.t) return buf[0]!;
  for (let i = buf.length - 1; i > 0; i--) {
    const a = buf[i - 1]!;
    const b = buf[i]!;
    if (renderAt >= a.t && renderAt <= b.t) {
      const k = b.t > a.t ? (renderAt - a.t) / (b.t - a.t) : 1;
      return { t: renderAt, headX: a.headX + (b.headX - a.headX) * k, headY: a.headY + (b.headY - a.headY) * k, guard: a.guard + (b.guard - a.guard) * k };
    }
  }
  return buf[buf.length - 1]!;
}

/** 공격 타임라인 (로컬 시각). startupAt부터 activeAt까지 startup, 이후 active·recovery */
export function strikeTimeline(type: StrikeType, hand: Hand, startupAt: number): StrikeTimeline {
  const spec = STRIKES[type] ?? STRIKES.jab!;
  const activeAt = startupAt + spec.startupMs;
  return { hand, type, aimLockAt: startupAt, startupAt, activeAt, activeEndsAt: activeAt + spec.activeMs, recoveryEndsAt: activeAt + spec.activeMs + spec.recoveryMs };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface OnlineSessionOptions {
  container: HTMLElement;
  input: InputSource;
  player: CharacterManifest;
  /** 처음 보일 상대 외형 (매니페스트 해석 전 임시) */
  opponent: CharacterManifest;
  settings: Settings;
  duel: DuelConnection;
}

type Listener = (s: HudSnapshot) => void;

export class OnlineSession {
  private readonly stage: MatchScene;
  private readonly duel: DuelConnection;
  private listeners = new Set<Listener>();
  private unsubs: Array<() => void> = [];
  private raf = 0;
  private running = false;
  private disposed = false;
  private lastReal = 0;
  private lastEmit = 0;
  private frameTimes: number[] = [];
  private phase: MatchPhase;
  private events: HudEvent[] = [];
  private eventId = 0;
  private motionLog: MotionLogEntry[] = [];
  private lastPlayerHitAt = -1e9;
  private lastDodgeAt = -1e9;
  private lastPoseSentAt = -1e9;
  private lastInput = { tracking: true, trackingLostMs: 0, defense: 'none' };
  private trackingLostReported = false;
  /** 예측 재생 중인 내 펀치 seq → 손 */
  private pending = new Map<number, Hand>();
  private handReadyAt: Record<Hand, number> = { lead: 0, rear: 0 };
  private strikeTimes: number[] = [];
  private oppSamples: PoseSample[] = [];
  private oppCharacterId = '';
  private countdownEndsAtServer = 0;
  private pause: { reason: PauseReason; player: string; resumeDeadline: number; pauseBudgetLeftMs: number } | null = null;
  private outcome: MatchOutcome | null = null;
  private stats: { player: FighterStats; ai: FighterStats } = { player: emptyStats(), ai: emptyStats() };
  private rematchRequested = false;
  private notice: string | null = null;
  /** 상대가 떠난 뒤에도 결과 화면에 남길 마지막 값 */
  private lastOpp = { hp: MATCH_RULES.maxHp as number, nickname: '상대' };
  private reconnecting = false;

  constructor(private readonly opts: OnlineSessionOptions) {
    this.duel = opts.duel;
    this.phase = this.duel.state.phase;
    this.stage = new MatchScene({ container: opts.container, player: opts.player, opponent: opts.opponent, stance: opts.settings.stance, cameraShake: opts.settings.cameraShake });
    if (this.phase === 'COUNTDOWN') this.countdownEndsAtServer = this.duel.state.phaseEndsAt;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async start(): Promise<void> {
    await this.opts.input.start();
    await this.stage.opponent.load();
    if (this.disposed) return;
    const d = this.duel;
    this.unsubs.push(
      d.onState((s) => this.onState(s)),
      d.onStatus((s) => this.onStatus(s)),
      d.on('match:countdown', (m) => { this.countdownEndsAtServer = m.startAt; this.pause = null; }),
      d.on('match:paused', (m) => { this.pause = m; this.emit(performance.now(), true); }),
      d.on('match:resumed', (m) => { this.pause = null; this.countdownEndsAtServer = m.countdownStartAt + MATCH_RULES.resumeCountdownMs; }),
      d.on('combat:strike_start', (m) => this.onStrikeStart(m)),
      d.on('strike:rejected', (m) => this.onRejected(m)),
      d.on('combat:hit', (m) => this.onHit(m)),
      d.on('combat:blocked', (m) => this.onBlocked(m)),
      d.on('combat:dodged', (m) => this.onDodged(m)),
      d.on('match:end', (m) => this.onEnd(m)),
      d.on('error', (m) => { this.notice = m.message || m.code; this.emit(performance.now(), true); }),
    );
    this.onState(d.state);
    this.running = true;
    this.lastReal = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.frame(performance.now());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // ── 서버 상태 ────────────────────────────────────────────────────────────────

  private onState(s: DuelSnapshot): void {
    const now = performance.now();
    const opp = this.duel.opponent();
    if (opp) {
      this.lastOpp = { hp: opp.hp, nickname: opp.nickname || '상대' };
      this.oppSamples.push({ t: s.receivedAt, headX: opp.headX, headY: opp.headY, guard: opp.guard });
      while (this.oppSamples.length > 2 && this.oppSamples[1]!.t < now - INTERP_DELAY_MS - 400) this.oppSamples.shift();
      if (opp.characterId && opp.characterId !== this.oppCharacterId) {
        this.oppCharacterId = opp.characterId;
        void this.duel.resolveCharacter(opp.characterId, opp.nickname).then((m) => {
          if (!this.disposed) return this.stage.replaceOpponent(m, performance.now());
        });
      }
    }
    if (s.phase !== this.phase) this.onPhase(this.phase, s.phase, now);
  }

  private onPhase(from: MatchPhase, to: MatchPhase, now: number): void {
    this.phase = to;
    if (to === 'COUNTDOWN') {
      this.countdownEndsAtServer = this.duel.state.phaseEndsAt || this.countdownEndsAtServer;
      if (from !== 'PAUSED') this.resetForMatch(now);
    }
    if (to !== 'PAUSED') this.pause = null;
    if (to === 'KO') {
      const me = this.duel.me();
      const opp = this.duel.opponent();
      if (me && me.hp <= 0) {
        this.stage.fp.knockedOut(now);
        this.pushEvent('다운…', 'bad', now);
      } else if (opp && opp.hp <= 0) {
        this.stage.opponent.play('ko', { now });
        this.pushEvent('K.O.!', 'good', now);
      }
    }
    // 재대결: RESULT → READY(캘리브레이션 생략). 내가 요청했으면 바로 준비 완료
    if (to === 'READY' && this.rematchRequested) {
      this.duel.send('room:ready', { ready: true });
      this.rematchRequested = false;
    }
    if ((to === 'WAITING_OPPONENT' || to === 'CALIBRATING') && from !== 'LOBBY') {
      this.notice = '상대가 나갔어요. 로비로 돌아가 새 방을 만들거나 기다려 주세요.';
    }
    this.emit(now, true);
  }

  private resetForMatch(now: number): void {
    this.outcome = null;
    this.stats = { player: emptyStats(), ai: emptyStats() };
    this.events = [];
    this.pending.clear();
    this.handReadyAt = { lead: 0, rear: 0 };
    this.strikeTimes = [];
    this.notice = null;
    this.stage.fp.reset();
    this.stage.opponent.play('idle', { now });
  }

  private onStatus(s: DuelStatus): void {
    const now = performance.now();
    if (s === 'closed' && !this.disposed && !this.reconnecting) this.reconnectLoop(now + MATCH_RULES.reconnectWindowMs);
    this.emit(now, true);
  }

  /** SDK 자동 재접속이 포기하면 재접속 창(20초) 안에서 수동 재시도 */
  private reconnectLoop(deadline: number): void {
    this.reconnecting = true;
    void this.duel.retryReconnect().then((ok) => {
      if (this.disposed) return;
      if (ok) {
        this.reconnecting = false;
        this.notice = null;
      } else if (performance.now() < deadline) {
        setTimeout(() => this.reconnectLoop(deadline), 1500);
      } else {
        this.reconnecting = false;
        this.notice = '서버와 연결이 끊겼어요. 로비로 돌아가 주세요.';
      }
      this.emit(performance.now(), true);
    });
  }

  // ── 전투 메시지 ──────────────────────────────────────────────────────────────

  private onStrikeStart(m: ServerMessages['combat:strike_start']): void {
    if (m.attacker === this.duel.sessionId) {
      this.pending.delete(m.seq);
      return;
    }
    // 상대 펀치: 서버 activeAt을 로컬 시각으로 옮겨 클립을 재생 → 늦게 받은 만큼 자연히 앞당겨진다
    const spec = STRIKES[m.type] ?? STRIKES.jab!;
    const activeLocal = this.duel.sync.clock.toLocal(m.activeAt);
    this.stage.opponent.playStrike(strikeTimeline(m.type, m.hand, activeLocal - spec.startupMs));
  }

  private onRejected(m: ServerMessages['strike:rejected']): void {
    const hand = this.pending.get(m.seq);
    if (!hand) return;
    this.pending.delete(m.seq);
    this.stage.fp.cancelStrike(hand);
    this.handReadyAt[hand] = 0;
    if (m.reason !== 'COOLDOWN' && m.reason !== 'RATE') this.pushEvent(`펀치 무효 (${m.reason})`, 'info', performance.now());
  }

  private onHit(m: ServerMessages['combat:hit']): void {
    const now = performance.now();
    if (m.target === this.duel.sessionId) {
      this.lastPlayerHitAt = now;
      this.stage.fp.hitImpulse(m.zone === 'head' ? 1.2 : 0.7);
      this.pushEvent(`피격 -${m.damage}`, 'bad', now);
    } else {
      this.stage.sparks.burst(this.stage.opponentHead(), 26, '#ffd27a');
      this.stage.opponent.play(m.zone === 'head' ? 'hit_head' : 'hit_body', { now });
      this.pushEvent(`명중! -${m.damage}`, 'good', now);
    }
    this.emit(now, true);
  }

  private onBlocked(m: ServerMessages['combat:blocked']): void {
    const now = performance.now();
    if (m.target === this.duel.sessionId) {
      this.stage.fp.hitImpulse(0.3);
      this.pushEvent(`가드 -${m.chip}`, 'info', now);
    } else {
      const p = this.stage.opponentHead();
      p.y -= 0.05;
      p.z += 0.15;
      this.stage.sparks.burst(p, 10, '#9fd3ff', 1.5);
      this.pushEvent('막힘', 'info', now);
    }
  }

  private onDodged(m: ServerMessages['combat:dodged']): void {
    const now = performance.now();
    if (m.target === this.duel.sessionId) {
      this.lastDodgeAt = now;
      this.pushEvent('회피 성공!', 'good', now);
    } else {
      this.pushEvent('상대가 피했다', 'info', now);
    }
  }

  private onEnd(m: ServerMessages['match:end']): void {
    const now = performance.now();
    const me = this.duel.sessionId;
    const oppId = Object.keys(m.stats).find((k) => k !== me) ?? this.duel.opponent()?.sessionId ?? '';
    this.outcome = { reason: m.reason, winner: m.winner == null ? null : m.winner === me ? 'player' : 'ai', durationMs: m.durationMs };
    this.stats = { player: { ...emptyStats(), ...m.stats[me] }, ai: { ...emptyStats(), ...m.stats[oppId] } };
    if (this.outcome.winner === 'ai' && m.reason !== 'KO') this.stage.opponent.play('victory', { now });
    this.emit(now, true);
  }

  private pushEvent(text: string, tone: HudEvent['tone'], now: number): void {
    this.events.push({ id: ++this.eventId, text, tone, at: now });
    if (this.events.length > 6) this.events.shift();
  }

  // ── 조작 ─────────────────────────────────────────────────────────────────────

  /** 결과 화면의 재대결: 양쪽 동의 시 서버가 READY로 돌린다 */
  rematch(): void {
    if (this.phase !== 'RESULT') return;
    this.rematchRequested = true;
    this.duel.send('match:rematch', {});
    this.emit(performance.now(), true);
  }

  forfeit(): void {
    if (this.phase === 'FIGHTING' || this.phase === 'PAUSED' || this.phase === 'COUNTDOWN') this.duel.send('match:forfeit', {});
  }

  // ── 프레임 ───────────────────────────────────────────────────────────────────

  private frame(now: number): void {
    const dtMs = Math.min(100, now - this.lastReal);
    this.lastReal = now;
    const dt = dtMs / 1000;
    this.frameTimes.push(now);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const serverNow = this.duel.serverNow();
    const phase = this.phase;

    const inp = this.opts.input.poll(now);
    this.lastInput = { tracking: inp.tracking, trackingLostMs: inp.trackingLostMs, defense: inp.defense };
    // 추적 손실 프레임은 중앙·무방비 포즈를 보낸다 (C12)
    const pose = inp.tracking ? inp.pose : neutralPose(now);

    // input:pose 20Hz (카운트다운부터 생존 신호 겸용)
    if ((phase === 'FIGHTING' || phase === 'COUNTDOWN') && now - this.lastPoseSentAt >= POSE_SEND_INTERVAL_MS) {
      this.lastPoseSentAt = now;
      this.duel.send('input:pose', { headX: clamp(pose.headX, -1, 1), headY: clamp(pose.headY, -1, 1), guard: clamp(pose.guard, 0, 1), t: serverNow });
    }
    // 추적 손실 시작 즉시 서버에 손실 시작 시각(서버 시계)을 보고 → 서버가 3초 경과 시 PAUSED 결정 (C12)
    if (this.opts.input.kind !== 'keyboard') {
      if (!this.trackingLostReported && phase === 'FIGHTING' && !inp.tracking && inp.trackingLostMs > 0) {
        this.trackingLostReported = true;
        // 서버는 t가 현재 ±1초 안이어야 받는다 (카운트다운 중 시작된 손실은 FIGHTING 진입 시점 기준)
        this.duel.send('tracking:lost', { lost: true, t: serverNow - Math.min(inp.trackingLostMs, 900) });
      } else if (this.trackingLostReported && inp.tracking) {
        this.trackingLostReported = false;
        this.duel.send('tracking:lost', { lost: false, t: serverNow });
      }
    }

    for (const s of inp.strikes) {
      const ok = phase === 'FIGHTING' && s.confidence >= MIN_STRIKE_CONFIDENCE && this.canStrike(s.hand, now, serverNow);
      this.motionLog.push({ id: ++this.eventId, t: s.t, type: s.type, hand: s.hand, confidence: s.confidence, ignored: !ok });
      if (this.motionLog.length > 20) this.motionLog.shift();
      if (!ok) continue;
      // 예측: 내 펀치 즉시 재생, 서버에는 서버 시각으로 요청
      const tl = strikeTimeline(s.type, s.hand, now);
      this.stage.fp.playStrike(tl);
      this.handReadyAt[s.hand] = tl.recoveryEndsAt;
      this.strikeTimes.push(now);
      this.pending.set(s.seq, s.hand);
      this.duel.send('input:strike', { kind: 'strike', type: s.type, hand: s.hand, t: serverNow, confidence: s.confidence, seq: s.seq });
    }

    // 상대 포즈 보간 재생
    const op = samplePose(this.oppSamples, now - INTERP_DELAY_MS);
    if (op) {
      this.stage.opponent.setHeadOffset(op.headX, op.headY);
      this.stage.opponent.setGuardWeight(op.guard);
    }

    this.stage.fp.setHeadOffset(pose.headX, pose.headY);
    this.stage.fp.setGuardWeight(pose.guard);
    if (phase !== 'PAUSED') this.stage.animate(dt, now);
    this.stage.render();
    if (now - this.lastEmit > 50) this.emit(now, false);
  }

  /** 로컬 사전 차단(UX): 손별 쿨다운, 내 경직, 초당 4회. 최종 판정은 서버 */
  private canStrike(hand: Hand, now: number, serverNow: number): boolean {
    if (now < this.handReadyAt[hand]) return false;
    const me = this.duel.me();
    if (me && serverNow < me.stunUntil) return false;
    this.strikeTimes = this.strikeTimes.filter((t) => t > now - 1000);
    return this.strikeTimes.length < COMBAT_RULES.maxStrikesPerSecond;
  }

  private emit(now: number, force: boolean): void {
    if (!force && now - this.lastEmit < 50) return;
    this.lastEmit = now;
    const s = this.duel.state;
    const me = this.duel.me();
    const opp = this.duel.opponent();
    const serverNow = this.duel.serverNow();
    const ft = this.frameTimes;
    const span = ft.length > 1 ? ft[ft.length - 1]! - ft[0]! : 0;
    const remaining = s.phase === 'FIGHTING' ? s.timeLeftMs - (now - s.receivedAt) : s.timeLeftMs;
    const countdownEnd = s.phase === 'COUNTDOWN' ? (s.phaseEndsAt || this.countdownEndsAtServer) : 0;
    const snap: HudSnapshot = {
      phase: s.phase,
      countdownLeftMs: countdownEnd ? Math.max(0, countdownEnd - serverNow) : 0,
      remainingMs: clamp(remaining, 0, MATCH_RULES.roundMs),
      playerHp: me?.hp ?? MATCH_RULES.maxHp,
      aiHp: opp?.hp ?? this.lastOpp.hp,
      maxHp: MATCH_RULES.maxHp,
      events: [...this.events],
      telegraph: false,
      tracking: this.lastInput.tracking,
      trackingLostMs: this.lastInput.trackingLostMs,
      pauseReason: this.pause?.reason ?? (s.phase === 'PAUSED' ? 'NETWORK' : null),
      lastPlayerHitAt: this.lastPlayerHitAt,
      lastDodgeAt: this.lastDodgeAt,
      outcome: this.outcome,
      stats: { player: { ...this.stats.player }, ai: { ...this.stats.ai } },
      renderFps: span > 0 ? ((ft.length - 1) * 1000) / span : 0,
      diag: this.opts.input.diagnostics(),
      defense: this.lastInput.defense,
      motionLog: [...this.motionLog],
      online: {
        rttMs: this.duel.sync.clock.rtt,
        connection: this.duel.status === 'closed' && this.reconnecting ? 'reconnecting' : this.duel.status,
        opponentName: opp?.nickname || this.lastOpp.nickname,
        opponentConnected: opp?.connected ?? false,
        opponentLeft: !opp,
        pause: this.pause
          ? {
            reason: this.pause.reason,
            byMe: this.pause.player === this.duel.sessionId,
            deadlineLeftMs: Math.max(0, this.pause.resumeDeadline - serverNow),
            budgetLeftMs: this.pause.pauseBudgetLeftMs,
          }
          : null,
        rematchRequested: this.rematchRequested,
        notice: this.notice,
      },
    };
    for (const l of this.listeners) l(snap);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.opts.input.stop();
    this.stage.dispose();
    this.listeners.clear();
  }
}

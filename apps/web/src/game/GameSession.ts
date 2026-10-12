// 싱글 경기 세션: 입력 → 고정 60Hz 전투 시뮬레이션(packages/combat) → AI → 렌더.
// 시계 3종: real(performance.now), sim(FIGHTING 중에만 흐름, 판정 기준), anim(PAUSED 제외 실시간, 연출 기준).
import * as THREE from 'three';
import { AiBrain, COMBAT_RULES, CombatSim, mulberry32, STRIKES, type ActiveStrike, type CombatEvent } from '@mba/combat';
import { MIN_STRIKE_CONFIDENCE, type CharacterManifest, type Difficulty, type FighterStats, type MatchPhase, type PauseReason, type PoseState } from '@mba/shared';
import type { BoxerAvatar, StrikeTimeline } from '../avatar/types.ts';
import type { InputDiagnostics, InputSource } from '../input/types.ts';
import type { FirstPersonRig } from '../render/FirstPersonRig.ts';
import type { Sparks } from '../render/Effects.ts';
import type { Settings } from '../settings.ts';
import { LocalMatch, type MatchOutcome } from './LocalMatch.ts';
import { MatchScene } from './MatchScene.ts';

export const PLAYER = 'player';
export const AI = 'ai';
const STEP_MS = 1000 / COMBAT_RULES.simHz;

export interface HudEvent {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'info';
  at: number;
}

export interface HudSnapshot {
  phase: MatchPhase;
  countdownLeftMs: number;
  remainingMs: number;
  playerHp: number;
  aiHp: number;
  maxHp: number;
  events: HudEvent[];
  telegraph: boolean;
  tracking: boolean;
  trackingLostMs: number;
  pauseReason: PauseReason | null;
  /** 마지막 피격 시각(real) — 비네트 */
  lastPlayerHitAt: number;
  /** 마지막 회피 성공 시각(real) — SLIP! */
  lastDodgeAt: number;
  outcome: MatchOutcome | null;
  stats: { player: FighterStats; ai: FighterStats };
  renderFps: number;
  diag: InputDiagnostics | null;
  defense: string;
  /** 인식된 펀치 이벤트 로그 (최근 20개, 디버그 오버레이) */
  motionLog: MotionLogEntry[];
  /** 온라인 대전 전용 (싱글은 undefined). playerHp/aiHp = 나/상대, stats.player/ai = 나/상대 */
  online?: OnlineHud;
}

export interface OnlineHud {
  rttMs: number;
  connection: 'connected' | 'reconnecting' | 'closed';
  opponentName: string;
  opponentConnected: boolean;
  /** 상대가 룸을 떠남(결과 화면 이후 등) */
  opponentLeft: boolean;
  pause: { reason: PauseReason; byMe: boolean; deadlineLeftMs: number; budgetLeftMs: number } | null;
  rematchRequested: boolean;
  /** 서버 error 메시지 등 안내 */
  notice: string | null;
}

export interface MotionLogEntry {
  id: number;
  t: number;
  type: string;
  hand: string;
  confidence: number;
  /** confidence 미달 또는 경기 중이 아니라서 무시됨 */
  ignored: boolean;
}

export interface GameSessionOptions {
  container: HTMLElement;
  input: InputSource;
  player: CharacterManifest;
  opponent: CharacterManifest;
  difficulty: Difficulty;
  settings: Settings;
  seed?: number;
}

type Listener = (s: HudSnapshot) => void;

function timeline(s: ActiveStrike, offset: number): StrikeTimeline {
  const spec = STRIKES[s.type];
  const activeMs = spec?.activeMs ?? 80;
  return {
    hand: s.hand,
    type: s.type,
    aimLockAt: s.aimLockAt + offset,
    startupAt: s.startupAt + offset,
    activeAt: s.activeAt + offset,
    activeEndsAt: s.activeAt + activeMs + offset,
    recoveryEndsAt: s.recoveryEndsAt + offset,
  };
}

export class GameSession {
  private readonly stage: MatchScene;
  private readonly fp: FirstPersonRig;
  private readonly sparks: Sparks;
  private sim!: CombatSim;
  private ai!: AiBrain;
  private match = new LocalMatch();
  private listeners = new Set<Listener>();
  private raf = 0;
  private running = false;
  private lastReal = 0;
  private acc = 0;
  private simNow = 0;
  private animNow = 0;
  private lastEvents: CombatEvent[] = [];
  private events: HudEvent[] = [];
  private eventId = 0;
  private lastPlayerHitAt = -1e9;
  private lastDodgeAt = -1e9;
  private lastEmit = 0;
  private lastPhase: MatchPhase = 'READY';
  private frameTimes: number[] = [];
  private lastInput = { tracking: true, trackingLostMs: 0, defense: 'none' };
  private playerPose: PoseState = { headX: 0, headY: 0, guard: 0, t: 0 };
  private seed: number;
  private motionLog: MotionLogEntry[] = [];
  private disposed = false;

  private onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape') this.togglePause();
  };

  constructor(private opts: GameSessionOptions) {
    this.seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.stage = new MatchScene({ container: opts.container, player: opts.player, opponent: opts.opponent, stance: opts.settings.stance, cameraShake: opts.settings.cameraShake });
    this.fp = this.stage.fp;
    this.sparks = this.stage.sparks;
    this.resetMatch();
  }

  private resetMatch(): void {
    this.sim = new CombatSim({ fighters: [PLAYER, AI], startTime: 0 });
    this.ai = new AiBrain({ self: AI, opponent: PLAYER, difficulty: this.opts.difficulty, random: mulberry32(this.seed++) });
    this.simNow = 0;
    this.acc = 0;
    this.lastEvents = [];
    this.events = [];
    this.opponent.play('idle', { now: this.animNow });
    this.fp.reset();
  }

  private get opponent(): BoxerAvatar {
    return this.stage.opponent;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async start(): Promise<void> {
    await this.opts.input.start();
    await this.opponent.load();
    if (this.disposed) return;
    window.addEventListener('keydown', this.onKey);
    this.running = true;
    this.lastReal = performance.now();
    this.match.start(this.lastReal);
    const loop = () => {
      if (!this.running) return;
      this.frame(performance.now());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  rematch(): void {
    if (this.match.phase !== 'RESULT') return;
    const now = performance.now();
    this.match.rematch(now);
    this.resetMatch();
    this.match.start(now);
    this.emit(now, true);
  }

  togglePause(): void {
    const now = performance.now();
    if (this.match.phase === 'PAUSED') {
      if (this.match.pauseReason === 'USER' || this.lastInput.tracking) this.match.resume(now);
    } else {
      this.match.pause(now, 'USER');
    }
    this.emit(now, true);
  }

  private pushEvent(text: string, tone: HudEvent['tone'], now: number): void {
    this.events.push({ id: ++this.eventId, text, tone, at: now });
    if (this.events.length > 6) this.events.shift();
  }

  private frame(now: number): void {
    const dtMs = Math.min(100, now - this.lastReal);
    this.lastReal = now;
    const dt = dtMs / 1000;
    this.frameTimes.push(now);
    if (this.frameTimes.length > 60) this.frameTimes.shift();

    // 입력
    const inp = this.opts.input.poll(now);
    this.lastInput = { tracking: inp.tracking, trackingLostMs: inp.trackingLostMs, defense: inp.defense };
    this.playerPose = inp.pose;
    if (inp.pauseGesture) this.togglePause();
    const usesCamera = this.opts.input.kind !== 'keyboard';
    if (usesCamera) {
      if ((this.match.phase === 'FIGHTING' || this.match.phase === 'COUNTDOWN') && inp.trackingLostMs >= 2000) {
        this.match.pause(now, 'TRACKING_LOST');
      } else if (this.match.phase === 'PAUSED' && this.match.pauseReason === 'TRACKING_LOST' && inp.tracking) {
        this.match.resume(now);
      }
    }

    const phase = this.match.phase;
    if (phase !== 'PAUSED') this.animNow += dtMs;
    for (const s of inp.strikes) {
      this.motionLog.push({ id: ++this.eventId, t: s.t, type: s.type, hand: s.hand, confidence: s.confidence, ignored: phase !== 'FIGHTING' || s.confidence < MIN_STRIKE_CONFIDENCE });
      if (this.motionLog.length > 20) this.motionLog.shift();
    }

    // 고정 스텝 전투 시뮬레이션 (FIGHTING 중에만 sim 시계가 흐른다)
    let pendingStrikes = phase === 'FIGHTING' ? inp.strikes.filter((s) => s.confidence >= MIN_STRIKE_CONFIDENCE) : [];
    if (phase === 'FIGHTING') {
      this.acc += dtMs;
      while (this.acc >= STEP_MS) {
        this.acc -= STEP_MS;
        this.simNow += STEP_MS;
        const offset = this.animNow - this.simNow;
        this.sim.pushPose(PLAYER, { ...this.playerPose, t: this.simNow });
        const out = this.ai.update(this.simNow, this.sim, this.lastEvents);
        this.sim.pushPose(AI, { ...out.pose, t: this.simNow });
        const immediate: CombatEvent[] = [];
        if (out.strike) immediate.push(this.sim.requestStrike(AI, out.strike));
        for (const s of pendingStrikes) {
          immediate.push(this.sim.requestStrike(PLAYER, { type: s.type, hand: s.hand, seq: s.seq, t: this.simNow }));
        }
        pendingStrikes = [];
        const stepped = this.sim.step(this.simNow);
        this.lastEvents = [...immediate, ...stepped];
        for (const ev of this.lastEvents) this.handleEvent(ev, offset, now);
        this.opponent.setHeadOffset(out.pose.headX, out.pose.headY);
        this.opponent.setGuardWeight(out.pose.guard);
      }
    } else {
      this.acc = 0;
    }

    const koLoser = this.sim.winner ? (this.sim.winner === PLAYER ? 'ai' : 'player') : null;
    this.match.tick(now, { player: this.sim.fighter(PLAYER).hp, ai: this.sim.fighter(AI).hp }, koLoser);
    if (this.match.phase !== this.lastPhase) {
      if (this.match.phase === 'TIME_UP' || this.match.phase === 'KO') {
        const o = this.match.outcome;
        if (o?.winner === 'player' && this.match.phase === 'TIME_UP') this.opponent.play('idle', { now: this.animNow });
        if (o?.winner === 'ai') this.opponent.play('victory', { now: this.animNow });
      }
      this.lastPhase = this.match.phase;
      this.emit(now, true);
    }

    // 렌더
    this.fp.setHeadOffset(this.playerPose.headX, this.playerPose.headY);
    this.fp.setGuardWeight(this.playerPose.guard);
    if (phase !== 'PAUSED') this.stage.animate(dt, this.animNow);
    this.stage.render();
    if (now - this.lastEmit > 50) this.emit(now, false);
  }

  private handleEvent(ev: CombatEvent, offset: number, real: number): void {
    const head = this.stage.opponentHead();
    switch (ev.kind) {
      case 'strike_start': {
        const tl = timeline(ev.strike, offset);
        if (ev.strike.attacker === PLAYER) this.fp.playStrike(tl);
        else this.opponent.playStrike(tl);
        break;
      }
      case 'strike_cancelled':
        if (ev.strike.attacker === PLAYER) this.fp.cancelStrike(ev.strike.hand);
        else this.opponent.cancelStrike(ev.strike.hand);
        break;
      case 'strike_rejected':
        break;
      case 'hit':
        if (ev.strike.defender === AI) {
          this.sparks.burst(head, 26, '#ffd27a');
          this.opponent.play(ev.zone === 'head' ? 'hit_head' : 'hit_body', { now: this.animNow });
          this.pushEvent(`명중! -${ev.damage}`, 'good', real);
        } else {
          this.lastPlayerHitAt = real;
          this.fp.hitImpulse(ev.zone === 'head' ? 1.2 : 0.7);
          this.pushEvent(`피격 -${ev.damage}`, 'bad', real);
        }
        break;
      case 'blocked':
        if (ev.strike.defender === AI) {
          this.sparks.burst(head.clone().add(new THREE.Vector3(0, -0.05, 0.15)), 10, '#9fd3ff', 1.5);
          this.pushEvent('막힘', 'info', real);
        } else {
          this.fp.hitImpulse(0.3);
          this.pushEvent(`가드 -${ev.chip}`, 'info', real);
        }
        break;
      case 'dodged':
        if (ev.strike.defender === PLAYER) {
          this.lastDodgeAt = real;
          this.pushEvent('회피 성공!', 'good', real);
        } else {
          this.pushEvent('상대가 피했다', 'info', real);
        }
        break;
      case 'ko':
        if (ev.loser === AI) {
          this.opponent.play('ko', { now: this.animNow });
          this.pushEvent('K.O.!', 'good', real);
        } else {
          this.fp.knockedOut(this.animNow);
          this.pushEvent('다운…', 'bad', real);
        }
        break;
    }
  }

  private emit(now: number, force: boolean): void {
    if (!force && now - this.lastEmit < 50) return;
    this.lastEmit = now;
    const ft = this.frameTimes;
    const span = ft.length > 1 ? ft[ft.length - 1]! - ft[0]! : 0;
    const snap: HudSnapshot = {
      phase: this.match.phase,
      countdownLeftMs: this.match.countdownLeftMs(now),
      remainingMs: this.match.remainingMs(),
      playerHp: this.sim.fighter(PLAYER).hp,
      aiHp: this.sim.fighter(AI).hp,
      maxHp: COMBAT_RULES.maxHp,
      events: [...this.events],
      telegraph: this.opponent.isTelegraphing(this.animNow),
      tracking: this.lastInput.tracking,
      trackingLostMs: this.lastInput.trackingLostMs,
      pauseReason: this.match.pauseReason,
      lastPlayerHitAt: this.lastPlayerHitAt,
      lastDodgeAt: this.lastDodgeAt,
      outcome: this.match.outcome,
      stats: { player: { ...this.sim.fighter(PLAYER).stats }, ai: { ...this.sim.fighter(AI).stats } },
      renderFps: span > 0 ? ((ft.length - 1) * 1000) / span : 0,
      diag: this.opts.input.diagnostics(),
      defense: this.lastInput.defense,
      motionLog: [...this.motionLog],
    };
    for (const l of this.listeners) l(snap);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.opts.input.stop();
    this.stage.dispose();
    this.listeners.clear();
  }
}

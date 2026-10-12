// 싱글(AI 대전) 경기 단계 머신 (C8). 서버 DuelRoom과 같은 전이 규칙(canTransition)을 쓴다.
// 순수 로직: 시간은 인자로 받는다.
import { canTransition, MATCH_RULES, type MatchEndReason, type MatchPhase, type PauseReason } from '@mba/shared';

export type Side = 'player' | 'ai';

export interface MatchOutcome {
  reason: MatchEndReason;
  /** null = 무승부 */
  winner: Side | null;
  durationMs: number;
}

export interface LocalMatchOptions {
  roundMs?: number;
  countdownMs?: number;
  resumeCountdownMs?: number;
  /** KO/TIME_UP 연출 후 RESULT까지 */
  koHoldMs?: number;
  timeUpHoldMs?: number;
}

export class LocalMatch {
  phase: MatchPhase = 'READY';
  pauseReason: PauseReason | null = null;
  outcome: MatchOutcome | null = null;

  private readonly roundMs: number;
  private readonly countdownMs: number;
  private readonly resumeCountdownMs: number;
  private readonly koHoldMs: number;
  private readonly timeUpHoldMs: number;

  private phaseStartedAt = 0;
  private countdownLen = 0;
  private fightElapsed = 0;
  private lastTick = 0;

  constructor(opts: LocalMatchOptions = {}) {
    this.roundMs = opts.roundMs ?? MATCH_RULES.roundMs;
    this.countdownMs = opts.countdownMs ?? MATCH_RULES.countdownMs;
    this.resumeCountdownMs = opts.resumeCountdownMs ?? MATCH_RULES.resumeCountdownMs;
    this.koHoldMs = opts.koHoldMs ?? 2500;
    this.timeUpHoldMs = opts.timeUpHoldMs ?? 1500;
  }

  private go(to: MatchPhase, now: number): void {
    if (!canTransition(this.phase, to)) throw new Error(`invalid transition ${this.phase} → ${to}`);
    this.phase = to;
    this.phaseStartedAt = now;
  }

  start(now: number): void {
    this.fightElapsed = 0;
    this.outcome = null;
    this.countdownLen = this.countdownMs;
    this.go('COUNTDOWN', now);
    this.lastTick = now;
  }

  /** 매 프레임 호출. hp는 [player, ai] 현재값, koLoser는 sim이 판정한 KO 패자 */
  tick(now: number, hp: { player: number; ai: number }, koLoser: Side | null): MatchPhase {
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    switch (this.phase) {
      case 'COUNTDOWN':
        if (now - this.phaseStartedAt >= this.countdownLen) this.go('FIGHTING', now);
        break;
      case 'FIGHTING':
        this.fightElapsed += dt;
        if (koLoser) {
          this.outcome = { reason: 'KO', winner: koLoser === 'player' ? 'ai' : 'player', durationMs: this.fightElapsed };
          this.go('KO', now);
        } else if (this.fightElapsed >= this.roundMs) {
          this.fightElapsed = this.roundMs;
          // HP 비율 판정, 동률이면 무승부 (C17)
          const winner: Side | null = hp.player === hp.ai ? null : hp.player > hp.ai ? 'player' : 'ai';
          this.outcome = { reason: 'TIME_UP', winner, durationMs: this.fightElapsed };
          this.go('TIME_UP', now);
        }
        break;
      case 'KO':
        if (now - this.phaseStartedAt >= this.koHoldMs) this.go('RESULT', now);
        break;
      case 'TIME_UP':
        if (now - this.phaseStartedAt >= this.timeUpHoldMs) this.go('RESULT', now);
        break;
      case 'FORFEIT':
        this.go('RESULT', now);
        break;
      default:
        break;
    }
    return this.phase;
  }

  pause(now: number, reason: PauseReason): boolean {
    if (this.phase !== 'FIGHTING' && this.phase !== 'COUNTDOWN') return false;
    this.pauseReason = reason;
    this.go('PAUSED', now);
    return true;
  }

  resume(now: number): boolean {
    if (this.phase !== 'PAUSED') return false;
    this.pauseReason = null;
    this.countdownLen = this.resumeCountdownMs;
    this.go('COUNTDOWN', now);
    this.lastTick = now;
    return true;
  }

  forfeit(now: number, loser: Side): void {
    if (!canTransition(this.phase, 'FORFEIT')) return;
    this.outcome = { reason: 'FORFEIT', winner: loser === 'player' ? 'ai' : 'player', durationMs: this.fightElapsed };
    this.go('FORFEIT', now);
  }

  /** 재대결: RESULT → READY (캘리브레이션 유지) */
  rematch(now: number): void {
    this.go('READY', now);
    this.outcome = null;
    this.fightElapsed = 0;
  }

  countdownLeftMs(now: number): number {
    return this.phase === 'COUNTDOWN' ? Math.max(0, this.countdownLen - (now - this.phaseStartedAt)) : 0;
  }

  remainingMs(): number {
    return Math.max(0, this.roundMs - this.fightElapsed);
  }

  elapsedMs(): number {
    return this.fightElapsed;
  }
}

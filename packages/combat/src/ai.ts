// AI 상대 복서 FSM (게임 AI, 학습 모델 아님). docs/06-COMBAT-SYSTEM.md §AI
// 결정적: 시간은 인자로, 난수는 주입한다.
import type { Hand, PoseState } from '@mba/shared';
import { AI_DIFFICULTY, STRIKES, type AiDifficultySpec } from './constants.ts';
import type {
  AiBrainApi,
  AiBrainOptions,
  AiOutput,
  AiState,
  CombatEvent,
  CombatSimApi,
  FighterId,
  StrikeRequest,
} from './types.ts';

const DODGE_HOLD_MS = 400;
const DODGE_RETURN_MS = 200;
const GUARD_HOLD_MS = 500;
const RECOVER_MS = 300;
const COMBO_GAP_MS = 120;
const APPROACH_LEAD_MS = 600;
const IDLE_GUARD = 0.3;

interface OwnStrike {
  seq: number;
  aimLockAt: number;
  startupAt: number;
  recoveryEndsAt: number;
}

export class AiBrain implements AiBrainApi {
  readonly spec: AiDifficultySpec;
  private readonly self: FighterId;
  private readonly random: () => number;

  private nextAttackAt: number | null = null;
  private comboLeft = 0;
  private nextHand: Hand = 'lead';
  private seq = 0;
  private own: OwnStrike | null = null;

  private reactions: { at: number; strikeId: string }[] = [];
  private dodgeDir = 0;
  private dodgeStart = -Infinity;
  private guardUntil = -Infinity;
  private hitUntil = -Infinity;
  private recoverUntil = -Infinity;
  private knockedOut = false;

  constructor(opts: AiBrainOptions) {
    this.self = opts.self;
    this.random = opts.random;
    this.spec = { ...AI_DIFFICULTY[opts.difficulty], ...opts.spec };
  }

  update(now: number, sim: CombatSimApi, events: readonly CombatEvent[]): AiOutput {
    this.consume(now, events);

    if (this.knockedOut) return this.output(now, 'Knockout', null);

    this.runReactions(now);

    const stunned = now < this.hitUntil || now < sim.fighter(this.self).stunUntil;
    if (stunned) return this.output(now, 'Hit', null);
    if (now < this.recoverUntil) return this.output(now, 'Recover', null);

    if (this.own && now < this.own.recoveryEndsAt) {
      return this.output(now, now < this.own.startupAt ? 'Telegraph' : 'Attack', null);
    }
    this.own = null;

    const dodging = now < this.dodgeStart + DODGE_HOLD_MS + DODGE_RETURN_MS;
    if (dodging) return this.output(now, 'Dodge', null);
    if (now < this.guardUntil) return this.output(now, 'Guard', null);

    if (this.nextAttackAt === null) this.nextAttackAt = now + this.interval();
    if (now >= this.nextAttackAt && sim.winner === null) {
      const strike = this.makeStrike(now);
      return this.output(now, 'Telegraph', strike);
    }
    return this.output(now, this.nextAttackAt - now <= APPROACH_LEAD_MS ? 'Approach' : 'Idle', null);
  }

  private consume(now: number, events: readonly CombatEvent[]): void {
    for (const e of events) {
      switch (e.kind) {
        case 'strike_start':
          if (e.strike.defender === this.self) {
            this.reactions.push({ at: e.strike.aimLockAt + this.spec.reactionMs, strikeId: e.strike.id });
          }
          break;
        case 'strike_rejected':
          if (e.attacker === this.self && this.own?.seq === e.seq) this.own = null;
          break;
        case 'strike_cancelled':
          if (e.strike.attacker === this.self && this.own?.seq === e.strike.seq) this.own = null;
          break;
        case 'hit':
          if (e.strike.defender === this.self) {
            this.hitUntil = Math.max(this.hitUntil, e.stunUntil);
            this.recoverUntil = this.hitUntil + RECOVER_MS;
            this.own = null;
            this.comboLeft = 0;
            this.dodgeStart = -Infinity;
            this.guardUntil = -Infinity;
            // 맞은 뒤에는 공격 간격을 다시 잡는다
            this.nextAttackAt = this.recoverUntil + this.interval();
          }
          break;
        case 'ko':
          if (e.loser === this.self) this.knockedOut = true;
          break;
        default:
          break;
      }
    }
    void now;
  }

  private runReactions(now: number): void {
    const ready = this.reactions.filter((r) => r.at <= now);
    this.reactions = this.reactions.filter((r) => r.at > now);
    for (const r of ready) {
      void r;
      if (now < this.hitUntil) continue;
      if (this.random() < this.spec.dodgeProb) {
        this.dodgeDir = this.random() < 0.5 ? -1 : 1;
        this.dodgeStart = now;
      } else if (this.random() < this.spec.guardProb) {
        this.guardUntil = now + GUARD_HOLD_MS;
      }
    }
  }

  private makeStrike(now: number): StrikeRequest {
    if (this.comboLeft <= 0) this.comboLeft = 1 + Math.floor(this.random() * this.spec.comboMax);
    const hand = this.nextHand;
    this.nextHand = hand === 'lead' ? 'rear' : 'lead';
    const type = hand === 'lead' ? 'jab' : 'straight';
    const spec = STRIKES[type]!;
    const telegraphMs = this.spec.telegraphMs;
    const startupAt = now + telegraphMs;
    const recoveryEndsAt = startupAt + spec.startupMs + spec.activeMs + spec.recoveryMs;
    this.seq++;
    this.own = { seq: this.seq, aimLockAt: now, startupAt, recoveryEndsAt };
    this.comboLeft--;
    this.nextAttackAt = this.comboLeft > 0 ? recoveryEndsAt + COMBO_GAP_MS : recoveryEndsAt + this.interval();
    return { type, hand, seq: this.seq, t: now, telegraphMs };
  }

  private interval(): number {
    const [lo, hi] = this.spec.attackIntervalMs;
    return lo + this.random() * (hi - lo);
  }

  private output(now: number, state: AiState, strike: StrikeRequest | null): AiOutput {
    return { pose: this.pose(now, state), strike, state };
  }

  private pose(now: number, state: AiState): PoseState {
    let headX = 0.08 * Math.sin(now / 650);
    let headY = 0;
    let guard = IDLE_GUARD;
    const sinceDodge = now - this.dodgeStart;
    if (sinceDodge >= 0 && sinceDodge < DODGE_HOLD_MS) {
      headX = this.dodgeDir;
    } else if (sinceDodge >= DODGE_HOLD_MS && sinceDodge < DODGE_HOLD_MS + DODGE_RETURN_MS) {
      headX = this.dodgeDir * (1 - (sinceDodge - DODGE_HOLD_MS) / DODGE_RETURN_MS);
    }
    if (state === 'Guard') guard = 1;
    if (state === 'Telegraph' || state === 'Attack' || state === 'Hit') guard = 0;
    if (state === 'Knockout') {
      headX = 0;
      headY = -1;
      guard = 0;
    }
    return { headX: clamp(headX), headY: clamp(headY), guard, t: now };
  }
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

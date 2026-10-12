// 결정적 전투 시뮬레이터 (C6, C10, C11, C17). 싱글(브라우저)과 서버(DuelRoom)가 같은 코드를 쓴다.
import {
  GUARD_BLOCK_THRESHOLD,
  HIT_VOLUMES,
  emptyStats,
  neutralPose,
  type FighterStats,
  type Hand,
  type PoseState,
} from '@mba/shared';
import { COMBAT_RULES, STRIKES } from './constants.ts';
import { distance, headWorldOffset } from './geometry.ts';
import type {
  ActiveStrike,
  CombatEvent,
  CombatSimApi,
  CombatSimOptions,
  FighterId,
  FighterView,
  StrikeRequest,
} from './types.ts';

interface FighterInternal {
  id: FighterId;
  hp: number;
  stunUntil: number;
  handReadyAt: Record<Hand, number>;
  stats: FighterStats;
  /** t 오름차순 포즈 샘플 */
  poses: PoseState[];
  /** 수락된 공격의 시작 시각 (속도 제한용) */
  strikeTimes: number[];
  /** 이전 step들에서 확정된 피격 시각(공격의 activeAt) */
  hitsTaken: number[];
}

/** 이 이상 머리를 옮겼으면(|headX|) 회피를 "시도"한 것으로 집계 (통계용 근사) */
const DODGE_ATTEMPT_HEADX = 0.5;

export class CombatSim implements CombatSimApi {
  private readonly fighters = new Map<FighterId, FighterInternal>();
  private readonly order: readonly [FighterId, FighterId];
  private pending: ActiveStrike[] = [];
  private winnerId: FighterId | null = null;

  constructor(opts: CombatSimOptions) {
    if (opts.fighters[0] === opts.fighters[1]) throw new Error('fighter ids must differ');
    this.order = opts.fighters;
    const maxHp = opts.maxHp ?? COMBAT_RULES.maxHp;
    for (const id of opts.fighters) {
      this.fighters.set(id, {
        id,
        hp: maxHp,
        stunUntil: opts.startTime,
        handReadyAt: { lead: opts.startTime, rear: opts.startTime },
        stats: emptyStats(),
        poses: [],
        strikeTimes: [],
        hitsTaken: [],
      });
    }
  }

  get winner(): FighterId | null {
    return this.winnerId;
  }

  pushPose(fighter: FighterId, pose: PoseState): void {
    const f = this.get(fighter);
    if (!Number.isFinite(pose.t)) return;
    const sample: PoseState = { headX: pose.headX, headY: pose.headY, guard: pose.guard, t: pose.t };
    const buf = f.poses;
    let i = buf.length;
    while (i > 0 && buf[i - 1]!.t > sample.t) i--;
    buf.splice(i, 0, sample);
    const latest = buf[buf.length - 1]!.t;
    const cutoff = latest - COMBAT_RULES.poseBufferMs;
    // 컷오프 이전 샘플 하나는 남긴다: 창 시작 시점에 "유효한" 샘플이 필요하다
    while (buf.length > 1 && buf[1]!.t <= cutoff) buf.shift();
  }

  requestStrike(attacker: FighterId, req: StrikeRequest): CombatEvent {
    const a = this.get(attacker);
    const reject = (reason: Extract<CombatEvent, { kind: 'strike_rejected' }>['reason']): CombatEvent => ({
      kind: 'strike_rejected',
      attacker,
      seq: req.seq,
      reason,
    });
    if (this.winnerId !== null) return reject('PHASE');
    const spec = STRIKES[req.type];
    if (!spec) return reject('TYPE_DISABLED');
    if (req.t < a.stunUntil) return reject('STUNNED');
    if (req.t < a.handReadyAt[req.hand]) return reject('COOLDOWN');
    a.strikeTimes = a.strikeTimes.filter((s) => s > req.t - 1000);
    if (a.strikeTimes.length >= COMBAT_RULES.maxStrikesPerSecond) return reject('RATE');

    const defender = this.opponentOf(attacker);
    const telegraphMs = Math.max(0, req.telegraphMs ?? 0);
    const aimLockAt = req.t;
    const startupAt = aimLockAt + telegraphMs;
    const activeAt = startupAt + spec.startupMs;
    const recoveryEndsAt = activeAt + spec.activeMs + spec.recoveryMs;
    const attackerPose = this.sampleAt(a, aimLockAt);
    const strike: ActiveStrike = {
      id: `${attacker}:${req.seq}`,
      attacker,
      defender,
      type: req.type,
      hand: req.hand,
      seq: req.seq,
      aimLockAt,
      startupAt,
      activeAt,
      recoveryEndsAt,
      zone: attackerPose.headY <= COMBAT_RULES.bodyShotHeadY ? 'body' : 'head',
      aim: headWorldOffset(this.sampleAt(this.get(defender), aimLockAt)),
    };
    a.handReadyAt[req.hand] = recoveryEndsAt;
    a.strikeTimes.push(req.t);
    a.stats.punches++;
    this.pending.push(strike);
    return { kind: 'strike_start', strike };
  }

  step(now: number): CombatEvent[] {
    const events: CombatEvent[] = [];
    if (this.winnerId !== null) return events;

    const due = this.pending
      .filter((s) => s.activeAt <= now)
      .sort((x, y) => x.activeAt - y.activeAt || x.id.localeCompare(y.id));
    if (due.length === 0) return events;
    this.pending = this.pending.filter((s) => s.activeAt > now);

    // 이전 step에서 확정된 피격만 인터럽트 근거로 쓴다. 같은 step 안의 명중은 동시 명중(C17)
    const hitsBefore = new Map<FighterId, number[]>();
    for (const f of this.fighters.values()) hitsBefore.set(f.id, [...f.hitsTaken]);
    const hpBefore = new Map<FighterId, number>();
    for (const f of this.fighters.values()) hpBefore.set(f.id, f.hp);

    for (const strike of due) {
      const interrupted = (hitsBefore.get(strike.attacker) ?? []).some(
        (t) => t >= strike.aimLockAt && t < strike.activeAt,
      );
      if (interrupted) {
        events.push({ kind: 'strike_cancelled', strike, reason: 'INTERRUPTED' });
        continue;
      }
      events.push(this.resolve(strike));
    }

    const downed = this.order.filter((id) => this.get(id).hp <= 0);
    if (downed.length > 0) {
      let loser: FighterId;
      if (downed.length === 1) {
        loser = downed[0]!;
      } else {
        // 양쪽 동시 KO: step 시작 시 HP가 낮았던 쪽이 패배, 같으면 두 번째 파이터가 패배(첫 파이터 승)
        const [p, q] = this.order;
        loser = (hpBefore.get(p) ?? 0) < (hpBefore.get(q) ?? 0) ? p : q;
      }
      const winner = this.opponentOf(loser);
      this.winnerId = winner;
      this.pending = [];
      const t = Math.max(...due.map((s) => s.activeAt));
      events.push({ kind: 'ko', loser, winner, t });
    }
    return events;
  }

  fighter(id: FighterId): FighterView {
    const f = this.get(id);
    const last = f.poses[f.poses.length - 1];
    return {
      id: f.id,
      hp: f.hp,
      stunUntil: f.stunUntil,
      handReadyAt: { ...f.handReadyAt },
      stats: { ...f.stats },
      pose: last ? { ...last } : neutralPose(0),
    };
  }

  pendingStrikes(): readonly ActiveStrike[] {
    return this.pending.map((s) => ({ ...s, aim: { ...s.aim } }));
  }

  private resolve(strike: ActiveStrike): CombatEvent {
    const attacker = this.get(strike.attacker);
    const defender = this.get(strike.defender);
    const spec = STRIKES[strike.type]!;
    const t = strike.activeAt;
    const atActive = this.sampleAt(defender, t);

    if (strike.zone === 'head') {
      // C10 slip hold: 창 [max(aimLockAt, activeAt − 250), activeAt]에서 조준점과 가장 먼 단일 샘플
      const windowStart = Math.max(strike.aimLockAt, t - COMBAT_RULES.slipHoldMs);
      const samples = [this.sampleAt(defender, windowStart), ...defender.poses.filter((p) => p.t > windowStart && p.t <= t)];
      let maxDist = 0;
      for (const s of samples) maxDist = Math.max(maxDist, distance(headWorldOffset(s), strike.aim));
      const dodged = maxDist >= HIT_VOLUMES.headRadius + HIT_VOLUMES.gloveRadius;
      if (dodged || Math.abs(atActive.headX) >= DODGE_ATTEMPT_HEADX) defender.stats.dodgesAttempted++;
      if (dodged) {
        defender.stats.dodgesSucceeded++;
        return { kind: 'dodged', strike, t };
      }
    }
    // 몸통 공격은 slip으로 피할 수 없다(가드만 가능)

    const damage = strike.zone === 'head' ? spec.damageHead : spec.damageBody;
    if (atActive.guard >= GUARD_BLOCK_THRESHOLD) {
      const chip = Math.round(damage * COMBAT_RULES.chipRatio);
      defender.hp = Math.max(0, defender.hp - chip);
      // 'blocked'는 공격자 기준: 내 펀치가 가드에 막힌 수
      attacker.stats.blocked++;
      return { kind: 'blocked', strike, chip, hpAfter: defender.hp, t };
    }

    defender.hp = Math.max(0, defender.hp - damage);
    defender.stunUntil = Math.max(defender.stunUntil, t + COMBAT_RULES.hitstunMs);
    defender.hitsTaken.push(t);
    if (defender.hitsTaken.length > 32) defender.hitsTaken.shift();
    attacker.stats.hits++;
    return { kind: 'hit', strike, zone: strike.zone, damage, hpAfter: defender.hp, stunUntil: defender.stunUntil, t };
  }

  /** 시각 t에 유효한 샘플: t 이하 마지막 샘플, 없으면 중앙·무방비 */
  private sampleAt(f: FighterInternal, t: number): PoseState {
    let found: PoseState | undefined;
    for (const p of f.poses) {
      if (p.t <= t) found = p;
      else break;
    }
    return found ?? neutralPose(t);
  }

  private opponentOf(id: FighterId): FighterId {
    const [p, q] = this.order;
    if (id === p) return q;
    if (id === q) return p;
    throw new Error(`unknown fighter ${id}`);
  }

  private get(id: FighterId): FighterInternal {
    const f = this.fighters.get(id);
    if (!f) throw new Error(`unknown fighter ${id}`);
    return f;
  }
}

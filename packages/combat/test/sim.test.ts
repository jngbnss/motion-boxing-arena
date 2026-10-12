import { describe, expect, it } from 'vitest';
import { CombatSim, COMBAT_RULES, STRIKES, type CombatEvent } from '../src/index.ts';

const A = 'A';
const B = 'B';

function makeSim(maxHp?: number) {
  return new CombatSim({ fighters: [A, B], startTime: 0, ...(maxHp !== undefined ? { maxHp } : {}) });
}

function pose(sim: CombatSim, f: string, t: number, headX = 0, headY = 0, guard = 0) {
  sim.pushPose(f, { headX, headY, guard, t });
}

function strike(sim: CombatSim, f: string, t: number, hand: 'lead' | 'rear' = 'lead', seq = Math.round(t), telegraphMs?: number) {
  return sim.requestStrike(f, {
    type: hand === 'lead' ? 'jab' : 'straight',
    hand,
    seq,
    t,
    ...(telegraphMs !== undefined ? { telegraphMs } : {}),
  });
}

function kinds(events: CombatEvent[]) {
  return events.map((e) => e.kind);
}

describe('requestStrike', () => {
  it('accepts a jab and computes the C6 timeline', () => {
    const sim = makeSim();
    const e = strike(sim, A, 1000);
    expect(e.kind).toBe('strike_start');
    if (e.kind !== 'strike_start') return;
    expect(e.strike.aimLockAt).toBe(1000);
    expect(e.strike.startupAt).toBe(1000);
    expect(e.strike.activeAt).toBe(1100);
    expect(e.strike.recoveryEndsAt).toBe(1100 + 80 + 200);
    expect(e.strike.defender).toBe(B);
    expect(e.strike.id).toBe('A:1000');
  });

  it('telegraph delays startup but aim locks at request time', () => {
    const sim = makeSim();
    const e = strike(sim, A, 1000, 'rear', 1, 500);
    if (e.kind !== 'strike_start') throw new Error('rejected');
    expect(e.strike.aimLockAt).toBe(1000);
    expect(e.strike.startupAt).toBe(1500);
    expect(e.strike.activeAt).toBe(1500 + STRIKES.straight!.startupMs);
  });

  it('rejects the same hand during recovery (COOLDOWN)', () => {
    const sim = makeSim();
    strike(sim, A, 0, 'lead', 1);
    const e = strike(sim, A, 379, 'lead', 2);
    expect(e).toMatchObject({ kind: 'strike_rejected', reason: 'COOLDOWN' });
    expect(strike(sim, A, 380, 'lead', 3).kind).toBe('strike_start');
  });

  it('allows the other hand while one hand recovers', () => {
    const sim = makeSim();
    strike(sim, A, 0, 'lead', 1);
    expect(strike(sim, A, 10, 'rear', 2).kind).toBe('strike_start');
  });

  it('rejects the 5th strike within one second (RATE)', () => {
    const sim = makeSim();
    expect(strike(sim, A, 0, 'lead', 1).kind).toBe('strike_start');
    expect(strike(sim, A, 10, 'rear', 2).kind).toBe('strike_start');
    expect(strike(sim, A, 400, 'lead', 3).kind).toBe('strike_start');
    expect(strike(sim, A, 600, 'rear', 4).kind).toBe('strike_start');
    expect(strike(sim, A, 800, 'lead', 5)).toMatchObject({ kind: 'strike_rejected', reason: 'RATE' });
  });

  it('rejects disabled strike types (TYPE_DISABLED)', () => {
    const sim = makeSim();
    const e = sim.requestStrike(A, { type: 'hook', hand: 'lead', seq: 1, t: 0 });
    expect(e).toMatchObject({ kind: 'strike_rejected', reason: 'TYPE_DISABLED' });
  });

  it('rejects while stunned and accepts once hitstun ends', () => {
    const sim = makeSim();
    strike(sim, B, 0, 'lead', 1);
    sim.step(100);
    const stunUntil = 100 + COMBAT_RULES.hitstunMs;
    expect(sim.fighter(A).stunUntil).toBe(stunUntil);
    expect(strike(sim, A, stunUntil - 1, 'lead', 2)).toMatchObject({ kind: 'strike_rejected', reason: 'STUNNED' });
    expect(strike(sim, A, stunUntil, 'lead', 3).kind).toBe('strike_start');
  });

  it('rejects after a KO (PHASE)', () => {
    const sim = makeSim(6);
    strike(sim, A, 0);
    sim.step(100);
    expect(sim.winner).toBe(A);
    expect(strike(sim, B, 500, 'lead', 9)).toMatchObject({ kind: 'strike_rejected', reason: 'PHASE' });
  });

  it('throws for unknown fighters', () => {
    const sim = makeSim();
    expect(() => strike(sim, 'Z', 0)).toThrow();
  });
});

describe('resolution', () => {
  it('does not resolve before activeAt', () => {
    const sim = makeSim();
    strike(sim, A, 0);
    expect(sim.step(99)).toEqual([]);
    expect(sim.pendingStrikes()).toHaveLength(1);
  });

  it('jab to the head deals 6 damage', () => {
    const sim = makeSim();
    strike(sim, A, 0);
    const ev = sim.step(100);
    expect(ev[0]).toMatchObject({ kind: 'hit', zone: 'head', damage: 6, hpAfter: 94 });
    expect(sim.fighter(B).hp).toBe(94);
  });

  it('straight to the head deals 12 damage', () => {
    const sim = makeSim();
    strike(sim, A, 0, 'rear');
    expect(sim.step(200)[0]).toMatchObject({ kind: 'hit', damage: 12 });
  });

  it('crouched attacker throws a body shot', () => {
    const sim = makeSim();
    pose(sim, A, 0, 0, -0.6);
    const e = strike(sim, A, 10, 'rear');
    if (e.kind !== 'strike_start') throw new Error('rejected');
    expect(e.strike.zone).toBe('body');
    expect(sim.step(500)[0]).toMatchObject({ kind: 'hit', zone: 'body', damage: 8 });
  });

  it('body shots cannot be slipped', () => {
    const sim = makeSim();
    pose(sim, A, 0, 0, -0.6);
    strike(sim, A, 10, 'rear');
    pose(sim, B, 50, 1);
    expect(sim.step(500)[0]?.kind).toBe('hit');
  });

  it('guard ≥ 0.7 blocks with 20% chip damage', () => {
    const sim = makeSim();
    pose(sim, B, 0, 0, 0, 0.7);
    strike(sim, A, 10, 'rear');
    const ev = sim.step(500);
    expect(ev[0]).toMatchObject({ kind: 'blocked', chip: Math.round(12 * 0.2), hpAfter: 100 - 2 });
    expect(sim.fighter(B).stunUntil).toBe(0);
  });

  it('guard 0.69 does not block', () => {
    const sim = makeSim();
    pose(sim, B, 0, 0, 0, 0.69);
    strike(sim, A, 10);
    expect(sim.step(500)[0]?.kind).toBe('hit');
  });

  it('slipping |headX| ≥ 0.70 after aim lock dodges', () => {
    const sim = makeSim();
    pose(sim, B, 0, 0);
    strike(sim, A, 10, 'rear');
    pose(sim, B, 100, 0.8);
    expect(sim.step(500)[0]?.kind).toBe('dodged');
  });

  it('slipping only 0.6 is not enough (0.18m < 0.21m)', () => {
    const sim = makeSim();
    pose(sim, B, 0, 0);
    strike(sim, A, 10, 'rear');
    pose(sim, B, 100, 0.6);
    expect(sim.step(500)[0]?.kind).toBe('hit');
  });

  it('does not credit a slip made before the aim lock (R3-1)', () => {
    const sim = makeSim();
    pose(sim, B, 0, 1); // 공격 전에 피했다가
    pose(sim, B, 50, 0); // 중앙으로 돌아옴
    strike(sim, A, 100, 'lead'); // 조준 고정: 중앙
    pose(sim, B, 150, 0);
    expect(sim.step(300)[0]?.kind).toBe('hit');
  });

  it('slip hold credits a slip that returned to center inside the window', () => {
    const sim = makeSim();
    pose(sim, B, 0, 0);
    strike(sim, A, 10, 'rear'); // active 170
    pose(sim, B, 60, -0.9);
    pose(sim, B, 120, 0); // active 전에 돌아옴
    expect(sim.step(500)[0]?.kind).toBe('dodged');
  });

  it('a slip before the 250ms window (but after aim lock) is not credited', () => {
    const sim = makeSim();
    pose(sim, B, 0, 0);
    strike(sim, A, 0, 'lead', 1, 500); // aim 0, active 600, window [350, 600]
    pose(sim, B, 100, 1);
    pose(sim, B, 200, 0);
    expect(sim.step(700)[0]?.kind).toBe('hit');
  });

  it('a defender already slipped at aim lock is still hit (aim follows the head)', () => {
    const sim = makeSim();
    pose(sim, B, 0, 1);
    strike(sim, A, 10);
    pose(sim, B, 60, 1);
    expect(sim.step(500)[0]?.kind).toBe('hit');
  });

  it('tracking-loss neutral pose gives no dodge credit', () => {
    const sim = makeSim();
    pose(sim, B, 0, 0);
    strike(sim, A, 10, 'rear');
    pose(sim, B, 50, 0, 0, 0); // 화면 밖으로 빠졌지만 판정용은 중앙·무방비
    pose(sim, B, 100, 0, 0, 0);
    expect(sim.step(500)[0]?.kind).toBe('hit');
  });

  it('out-of-order pose samples are inserted by time', () => {
    const sim = makeSim();
    pose(sim, B, 100, 0.9);
    pose(sim, B, 0, 0);
    // 조준 시점(50)에는 t=0 샘플(중앙)이 유효해야 한다
    const e = strike(sim, A, 50, 'rear');
    if (e.kind !== 'strike_start') throw new Error('rejected');
    expect(e.strike.aim).toEqual({ x: 0, y: 0 });
    expect(sim.step(500)[0]?.kind).toBe('dodged');
  });

  it('pose buffer keeps the sample in effect before the cutoff', () => {
    const sim = makeSim();
    pose(sim, B, 0, 1);
    for (let t = 100; t <= 2000; t += 500) pose(sim, B, t, 0);
    expect(sim.fighter(B).pose.t).toBe(1600);
    strike(sim, A, 1700);
    expect(sim.step(2000)[0]?.kind).toBe('hit');
  });
});

describe('interrupts, simultaneity, KO', () => {
  it('getting hit during startup cancels your strike', () => {
    const sim = makeSim();
    strike(sim, A, 0, 'lead'); // active 100
    strike(sim, B, 50, 'rear'); // active 210
    expect(kinds(sim.step(100))).toEqual(['hit']);
    const ev = sim.step(210);
    expect(ev[0]).toMatchObject({ kind: 'strike_cancelled', reason: 'INTERRUPTED' });
    expect(sim.fighter(A).hp).toBe(100);
  });

  it('a hit taken before the strike started does not cancel it', () => {
    const sim = makeSim();
    strike(sim, A, 0);
    sim.step(100); // B stunned until 400
    strike(sim, B, 400, 'lead', 1);
    expect(sim.step(500)[0]?.kind).toBe('hit');
  });

  it('simultaneous hits in the same step both apply (trade)', () => {
    const sim = makeSim();
    strike(sim, A, 0);
    strike(sim, B, 0);
    expect(kinds(sim.step(100))).toEqual(['hit', 'hit']);
    expect(sim.fighter(A).hp).toBe(94);
    expect(sim.fighter(B).hp).toBe(94);
  });

  it('KO when hp reaches 0, sets the winner and clears pending strikes', () => {
    const sim = makeSim(6);
    strike(sim, A, 0);
    strike(sim, B, 50, 'rear');
    const ev = sim.step(100);
    expect(ev.at(-1)).toMatchObject({ kind: 'ko', loser: B, winner: A });
    expect(sim.winner).toBe(A);
    expect(sim.pendingStrikes()).toHaveLength(0);
    expect(sim.step(1000)).toEqual([]);
  });

  it('double KO with equal hp: first fighter wins', () => {
    const sim = makeSim(6);
    strike(sim, A, 0);
    strike(sim, B, 0);
    const ev = sim.step(100);
    expect(ev.at(-1)).toMatchObject({ kind: 'ko', winner: A, loser: B });
  });

  it('hp never goes below 0', () => {
    const sim = makeSim(3);
    strike(sim, A, 0, 'rear');
    sim.step(500);
    expect(sim.fighter(B).hp).toBe(0);
  });
});

describe('stats and views', () => {
  it('counts punches, hits, blocks and dodges', () => {
    const sim = makeSim();
    strike(sim, A, 0, 'lead', 1);
    sim.step(100); // hit
    pose(sim, B, 1000, 0, 0, 1);
    strike(sim, A, 1000, 'lead', 2);
    sim.step(1100); // blocked
    pose(sim, B, 2000, 0, 0, 0);
    strike(sim, A, 2000, 'rear', 3);
    pose(sim, B, 2050, 1);
    sim.step(2200); // dodged
    const a = sim.fighter(A).stats;
    const b = sim.fighter(B).stats;
    expect(a).toMatchObject({ punches: 3, hits: 1, blocked: 1 });
    expect(b).toMatchObject({ dodgesAttempted: 1, dodgesSucceeded: 1 });
  });

  it('fighter() returns a copy', () => {
    const sim = makeSim();
    const v = sim.fighter(A);
    v.hp = 1;
    v.handReadyAt.lead = 999;
    expect(sim.fighter(A).hp).toBe(100);
    expect(sim.fighter(A).handReadyAt.lead).toBe(0);
  });

  it('is deterministic for identical inputs', () => {
    const run = () => {
      const sim = makeSim();
      const out: CombatEvent[] = [];
      for (let t = 0; t < 3000; t += 16) {
        pose(sim, B, t, Math.sin(t / 200));
        if (t % 400 === 0) out.push(strike(sim, A, t, t % 800 === 0 ? 'lead' : 'rear', t));
        out.push(...sim.step(t));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

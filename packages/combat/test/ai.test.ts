import { describe, expect, it } from 'vitest';
import { AI_DIFFICULTY, AiBrain, CombatSim, mulberry32, type AiBrainOptions, type AiOutput, type CombatEvent } from '../src/index.ts';

const AI = 'ai';
const P = 'player';

interface PlayerAction {
  t: number;
  hand: 'lead' | 'rear';
}

function simulate(opts: Partial<AiBrainOptions> & { seed?: number; until: number; player?: PlayerAction[]; playerGuard?: number }) {
  const sim = new CombatSim({ fighters: [P, AI], startTime: 0 });
  const brain = new AiBrain({
    self: AI,
    opponent: P,
    difficulty: opts.difficulty ?? 'normal',
    random: mulberry32(opts.seed ?? 1),
    ...(opts.spec ? { spec: opts.spec } : {}),
  });
  const outputs: { t: number; out: AiOutput }[] = [];
  const log: CombatEvent[] = [];
  let pending: CombatEvent[] = [];
  let seq = 0;
  for (let t = 0; t <= opts.until; t += 16) {
    sim.pushPose(P, { headX: 0, headY: 0, guard: opts.playerGuard ?? 0, t });
    for (const a of opts.player ?? []) {
      if (a.t >= t - 15 && a.t <= t) {
        pending.push(sim.requestStrike(P, { type: a.hand === 'lead' ? 'jab' : 'straight', hand: a.hand, seq: ++seq, t }));
      }
    }
    const out = brain.update(t, sim, pending);
    outputs.push({ t, out });
    sim.pushPose(AI, out.pose);
    const next: CombatEvent[] = [];
    if (out.strike) next.push(sim.requestStrike(AI, out.strike));
    next.push(...sim.step(t));
    log.push(...pending);
    pending = next;
  }
  log.push(...pending);
  return { sim, outputs, log };
}

describe('AiBrain', () => {
  it('is deterministic for the same seed', () => {
    const a = simulate({ seed: 42, until: 8000, player: [{ t: 2000, hand: 'lead' }] });
    const b = simulate({ seed: 42, until: 8000, player: [{ t: 2000, hand: 'lead' }] });
    expect(a.outputs).toEqual(b.outputs);
  });

  it('different seeds diverge', () => {
    const a = simulate({ seed: 1, until: 8000 });
    const b = simulate({ seed: 2, until: 8000 });
    expect(a.outputs).not.toEqual(b.outputs);
  });

  it.each(['easy', 'normal', 'hard'] as const)('uses the %s telegraph length', (difficulty) => {
    const { outputs } = simulate({ difficulty, until: 6000 });
    const first = outputs.find((o) => o.out.strike)?.out.strike;
    expect(first?.telegraphMs).toBe(AI_DIFFICULTY[difficulty].telegraphMs);
  });

  it('is in Telegraph state during the wind-up, then Attack', () => {
    const { outputs } = simulate({ until: 6000 });
    const i = outputs.findIndex((o) => o.out.strike);
    const t0 = outputs[i]!.t;
    const tele = outputs.find((o) => o.t > t0 && o.t < t0 + AI_DIFFICULTY.normal.telegraphMs);
    const atk = outputs.find((o) => o.t > t0 + AI_DIFFICULTY.normal.telegraphMs + 20);
    expect(tele?.out.state).toBe('Telegraph');
    expect(atk?.out.state).toBe('Attack');
  });

  it('alternates hands', () => {
    const { outputs } = simulate({ until: 20000, spec: { comboMax: 1 } });
    const hands = outputs.filter((o) => o.out.strike).map((o) => o.out.strike!.hand);
    expect(hands.length).toBeGreaterThan(3);
    expect(hands.slice(0, 4)).toEqual(['lead', 'rear', 'lead', 'rear']);
  });

  it('lands hits on a static player', () => {
    const { sim } = simulate({ until: 15000 });
    expect(sim.fighter(P).hp).toBeLessThan(100);
  });

  it('dodges a player straight when dodgeProb = 1', () => {
    const { log } = simulate({ until: 1000, spec: { dodgeProb: 1, attackIntervalMs: [10000, 10000] }, player: [{ t: 304, hand: 'rear' }] });
    expect(log.some((e) => e.kind === 'dodged')).toBe(true);
  });

  it('easy (reaction 140ms) cannot dodge a 100ms jab even with dodgeProb = 1', () => {
    const { log } = simulate({
      difficulty: 'easy',
      until: 1000,
      spec: { dodgeProb: 1, attackIntervalMs: [10000, 10000] },
      player: [{ t: 304, hand: 'lead' }],
    });
    expect(log.some((e) => e.kind === 'hit')).toBe(true);
    expect(log.some((e) => e.kind === 'dodged')).toBe(false);
  });

  it('guards when dodgeProb = 0 and guardProb = 1', () => {
    const { log } = simulate({ until: 1000, spec: { dodgeProb: 0, guardProb: 1, attackIntervalMs: [10000, 10000] }, player: [{ t: 304, hand: 'rear' }] });
    expect(log.some((e) => e.kind === 'blocked')).toBe(true);
  });

  it('enters Hit state when hit and does not attack while stunned', () => {
    const { outputs } = simulate({ until: 1500, spec: { dodgeProb: 0, guardProb: 0, attackIntervalMs: [10000, 10000] }, player: [{ t: 304, hand: 'lead' }] });
    const hit = outputs.filter((o) => o.out.state === 'Hit');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((o) => o.out.strike === null)).toBe(true);
    expect(outputs.some((o) => o.out.state === 'Recover')).toBe(true);
  });

  it('goes to Knockout when KOed', () => {
    const sim = new CombatSim({ fighters: [P, AI], startTime: 0, maxHp: 6 });
    const brain = new AiBrain({ self: AI, opponent: P, difficulty: 'easy', random: mulberry32(3), spec: { dodgeProb: 0, guardProb: 0 } });
    const start = sim.requestStrike(P, { type: 'jab', hand: 'lead', seq: 1, t: 0 });
    brain.update(0, sim, [start]);
    const ev = sim.step(100);
    const out = brain.update(116, sim, ev);
    expect(out.state).toBe('Knockout');
    expect(out.pose.headY).toBe(-1);
  });

  it('idle head bob stays well inside the dodge threshold', () => {
    const { outputs } = simulate({ until: 5000, spec: { attackIntervalMs: [10000, 10000] } });
    const idle = outputs.filter((o) => o.out.state === 'Idle' || o.out.state === 'Approach');
    expect(idle.length).toBeGreaterThan(0);
    expect(Math.max(...idle.map((o) => Math.abs(o.out.pose.headX)))).toBeLessThan(0.2);
  });
});

describe('mulberry32', () => {
  it('produces values in [0,1) and repeats per seed', () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(r2());
    }
  });
});

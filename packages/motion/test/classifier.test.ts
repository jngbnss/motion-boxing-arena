import { describe, expect, it } from 'vitest';
import type { StrikeEvent } from '@mba/shared';
import { MotionClassifier, defaultProfile, OneEuroFilter } from '../src/index.ts';
import type { MotionOutput } from '../src/types.ts';
import { SyntheticSession } from './synthetic.ts';

function run(s: SyntheticSession, stance: 'orthodox' | 'southpaw' = 'orthodox'): { outs: MotionOutput[]; strikes: StrikeEvent[] } {
  const c = new MotionClassifier({ profile: defaultProfile(stance) });
  const outs = s.frames.map((f) => c.process(f));
  return { outs, strikes: outs.flatMap((o) => o.strikes) };
}

describe('OneEuroFilter', () => {
  it('passes constant signal and reduces jitter', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    let out = 0;
    for (let i = 0; i < 60; i++) out = f.filter(5, i * 33);
    expect(out).toBeCloseTo(5, 6);
    const g = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    const ys = Array.from({ length: 200 }, (_, i) => g.filter(i % 2 === 0 ? 1 : -1, i * 33));
    const tail = ys.slice(100);
    expect(Math.max(...tail.map(Math.abs))).toBeLessThan(0.5);
  });

  it('tracks fast motion with high beta (low lag)', () => {
    const slow = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    const fast = new OneEuroFilter({ minCutoff: 1, beta: 10, dCutoff: 1 });
    let a = 0, b = 0;
    for (let i = 0; i < 10; i++) {
      a = slow.filter(i * 0.1, i * 33);
      b = fast.filter(i * 0.1, i * 33);
    }
    expect(Math.abs(0.9 - b)).toBeLessThan(Math.abs(0.9 - a));
  });
});

describe('MotionClassifier punches', () => {
  it('detects one jab with lead hand', () => {
    const s = new SyntheticSession({ seed: 2 }).hold(1500).jab().hold(800);
    const { strikes } = run(s);
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ kind: 'strike', type: 'jab', hand: 'lead' });
    const seg = s.segments[0]!;
    expect(strikes[0]!.t).toBeGreaterThanOrEqual(seg.start);
    expect(strikes[0]!.t).toBeLessThanOrEqual(seg.end);
  });

  it('detects one straight with rear hand', () => {
    const s = new SyntheticSession({ seed: 3 }).hold(1500).straight().hold(800);
    const { strikes } = run(s);
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ type: 'straight', hand: 'rear' });
  });

  it('emits each of a fast 1-2 combo exactly once, seq increasing', () => {
    const s = new SyntheticSession({ seed: 4 }).hold(1500).jab().straight().hold(300).jab().hold(800);
    const { strikes } = run(s);
    expect(strikes.map((e) => e.type)).toEqual(['jab', 'straight', 'jab']);
    expect(strikes.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('no strikes during 60s of idle guard noise', () => {
    const s = new SyntheticSession({ seed: 5, noise: 0.004 }).hold(60_000);
    expect(run(s).strikes).toHaveLength(0);
  });

  it('no strikes when lowering and raising guard', () => {
    const s = new SyntheticSession({ seed: 6 }).hold(1000);
    for (let i = 0; i < 5; i++) s.rest(300).hold(300).guardUp(250).hold(400);
    expect(run(s).strikes).toHaveLength(0);
  });

  it('southpaw: right hand jab is lead', () => {
    const s = new SyntheticSession({ seed: 7, leadSide: 'right' }).hold(1500).jab().hold(800);
    const { strikes } = run(s, 'southpaw');
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ type: 'jab', hand: 'lead' });
  });

  it('orthodox profile reading a southpaw jab reports rear/straight (sides are mapped by stance)', () => {
    const s = new SyntheticSession({ seed: 8, leadSide: 'right' }).hold(1500).jab().hold(800);
    const { strikes } = run(s, 'orthodox');
    expect(strikes[0]).toMatchObject({ type: 'straight', hand: 'rear' });
  });
});

describe('MotionClassifier defense', () => {
  it('reports guard weight ≥ 0.7 while guarding and low when hands down', () => {
    const s = new SyntheticSession({ seed: 9 }).hold(1500);
    const guardEnd = s.frames.length;
    s.rest(300).hold(1000);
    const { outs } = run(s);
    expect(outs[guardEnd - 1]!.pose.guard).toBeGreaterThanOrEqual(0.7);
    expect(outs[guardEnd - 1]!.defense).toBe('guard');
    expect(outs.at(-1)!.pose.guard).toBeLessThan(0.1);
    expect(outs.at(-1)!.defense).toBe('none');
  });

  it('slip left → headX ≈ −1 and slip_left; slip right → +1 and slip_right', () => {
    const s = new SyntheticSession({ seed: 10 }).hold(1500).to({ shiftX: -0.5 }, 200).hold(300);
    const iLeft = s.frames.length - 1;
    s.to({ shiftX: 0 }, 300).hold(500).to({ shiftX: 0.5 }, 200).hold(300);
    const iRight = s.frames.length - 1;
    const { outs } = run(s);
    expect(outs[iLeft]!.pose.headX).toBeLessThan(-0.8);
    expect(outs[iLeft]!.defense).toBe('slip_left');
    expect(outs[iRight]!.pose.headX).toBeGreaterThan(0.8);
    expect(outs[iRight]!.defense).toBe('slip_right');
  });

  it('slow sideways drift is not a slip (head0 drift compensation)', () => {
    const s = new SyntheticSession({ seed: 11 }).hold(1000).to({ shiftX: 0.5 }, 25_000).hold(3000);
    const { outs } = run(s);
    expect(outs.some((o) => o.defense === 'slip_left' || o.defense === 'slip_right')).toBe(false);
    expect(Math.abs(outs.at(-1)!.pose.headX)).toBeLessThan(0.3);
  });

  it('a real slip still registers after drift compensation', () => {
    const s = new SyntheticSession({ seed: 12 }).hold(1000).to({ shiftX: 0.4 }, 20_000).hold(2000);
    s.to({ shiftX: 0.9 }, 200).hold(300);
    const { outs } = run(s);
    expect(outs.at(-1)!.defense).toBe('slip_right');
  });

  it('duck lowers headY below −0.6', () => {
    const s = new SyntheticSession({ seed: 13 }).hold(1500).to({ shiftY: 0.5 }, 200).hold(300);
    const { outs } = run(s);
    expect(outs.at(-1)!.pose.headY).toBeLessThan(-0.6);
  });
});

describe('MotionClassifier tracking loss (C12)', () => {
  it('neutral pose, no strikes, trackingLostMs grows, then recovers', () => {
    const s = new SyntheticSession({ seed: 14 }).hold(1000).to({ shiftX: 0.6 }, 200);
    const before = s.frames.length;
    s.occlude(1000, 'null');
    const afterLoss = s.frames.length;
    s.occlude(500, 'lowvis');
    const afterLow = s.frames.length;
    s.to({ shiftX: 0 }, 200).hold(1000);
    const { outs, strikes } = run(s);
    expect(outs[before - 1]!.pose.headX).toBeGreaterThan(0.6);
    const lost = outs.slice(before, afterLow);
    expect(lost.every((o) => !o.tracking && o.pose.headX === 0 && o.pose.headY === 0 && o.pose.guard === 0)).toBe(true);
    expect(outs[afterLoss - 1]!.trackingLostMs).toBeGreaterThan(900);
    expect(outs[afterLow - 1]!.trackingLostMs).toBeGreaterThan(1400);
    expect(strikes).toHaveLength(0);
    expect(outs.at(-1)!.tracking).toBe(true);
    expect(outs.at(-1)!.trackingLostMs).toBe(0);
  });

  it('a jab during occlusion is not emitted', () => {
    const s = new SyntheticSession({ seed: 15 }).hold(1000);
    s.occlude(100, 'null');
    const c = new MotionClassifier({ profile: defaultProfile() });
    // 가려진 동안 손을 뻗고(프레임은 null), 복귀 후에는 정지
    const extra = new SyntheticSession({ seed: 16 }).hold(800);
    const outs = [...s.frames, ...extra.frames.map((f) => ({ ...f, t: f.t + s.frames.at(-1)!.t + 33 }))].map((f) => c.process(f));
    expect(outs.flatMap((o) => o.strikes)).toHaveLength(0);
  });
});

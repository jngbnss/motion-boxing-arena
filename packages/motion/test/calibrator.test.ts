import { describe, expect, it } from 'vitest';
import { Calibrator, MotionClassifier, defaultProfile } from '../src/index.ts';
import { SyntheticSession, SW, ASPECT } from './synthetic.ts';

/** 캘리브레이션 절차를 따라 움직이는 합성 사용자 (SW·위치를 기본과 다르게: 더 가깝고 오른쪽에 섬) */
function calibrationSession(): SyntheticSession {
  const s = new SyntheticSession({ seed: 21 });
  s.rest(200).hold(3500); // neutral
  s.guardUp(300).hold(2300); // guard
  for (let i = 0; i < 3; i++) s.jab().hold(500);
  for (let i = 0; i < 3; i++) s.straight().hold(500);
  for (let i = 0; i < 3; i++) s.slip(-1, 0.6).hold(300);
  for (let i = 0; i < 3; i++) s.slip(1, 0.4).hold(300);
  return s;
}

describe('Calibrator', () => {
  it('walks all steps and produces a profile', () => {
    const c = new Calibrator('orthodox');
    expect(c.step).toBe('neutral');
    expect(c.instruction).toMatch(/움직이지/);
    const seen = new Set<string>();
    for (const f of calibrationSession().frames) {
      c.push(f);
      seen.add(c.step);
    }
    expect([...seen]).toEqual(['neutral', 'guard', 'jab', 'straight', 'slip_left', 'slip_right', 'done']);
    const p = c.result()!;
    expect(p).not.toBeNull();
    expect(p.shoulderWidth0).toBeCloseTo(SW, 2);
    expect(p.head0.x).toBeCloseTo((0.5 * ASPECT) / SW, 1);
    expect(p.guardWristNoseDist).toBeGreaterThan(0.3);
    expect(p.guardWristNoseDist).toBeLessThan(0.55);
    expect(p.punch.lead.peakHandScale).toBeGreaterThan(1.3);
    expect(p.punch.rear.peakSpeed).toBeGreaterThan(1.5);
    // 비대칭 slip이 반영됨
    expect(p.slipLeft).toBeGreaterThan(p.slipRight);
    expect(p.slipLeft).toBeCloseTo(0.6, 1);
    expect(p.slipRight).toBeCloseTo(0.4, 1);
  });

  it('result() is null before done; tracking loss restarts neutral', () => {
    const c = new Calibrator();
    const s = new SyntheticSession({ seed: 22 }).hold(2000).occlude(200).hold(1500);
    for (const f of s.frames) c.push(f);
    expect(c.step).toBe('neutral');
    expect(c.result()).toBeNull();
    expect(c.progress).toBeGreaterThan(0.3);
    expect(c.progress).toBeLessThan(1);
  });

  it('calibrated profile then classifies punches and slips correctly', () => {
    const c = new Calibrator();
    for (const f of calibrationSession().frames) c.push(f);
    const profile = c.result()!;
    const play = new SyntheticSession({ seed: 23 }).hold(1500).jab().hold(500).straight().hold(500).slip(-1, 0.6);
    const cls = new MotionClassifier({ profile });
    const outs = play.frames.map((f) => cls.process(f));
    expect(outs.flatMap((o) => o.strikes).map((e) => e.type)).toEqual(['jab', 'straight']);
    expect(outs.some((o) => o.defense === 'slip_left')).toBe(true);
    expect(Math.min(...outs.map((o) => o.pose.headX))).toBeLessThan(-0.85);
  });

  it('defaultProfile matches stance', () => {
    expect(defaultProfile('southpaw').stance).toBe('southpaw');
  });
});

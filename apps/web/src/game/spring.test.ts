import { describe, expect, it } from 'vitest';
import { clamp, stepCriticalSpring, Spring2 } from './spring.ts';

describe('critical spring', () => {
  it('목표로 수렴하고 오버슈트하지 않는다', () => {
    let s = { x: 0, v: 0 };
    let max = 0;
    for (let i = 0; i < 120; i++) {
      s = stepCriticalSpring(s, 1, 12, 1 / 60);
      max = Math.max(max, s.x);
    }
    expect(s.x).toBeCloseTo(1, 3);
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('큰 dt에도 발산하지 않는다', () => {
    const s = stepCriticalSpring({ x: 0, v: 0 }, 1, 12, 5);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(s.x).toBeCloseTo(1, 3);
  });

  it('Spring2는 두 축을 독립적으로 추종', () => {
    const sp = new Spring2(12);
    let p = { x: 0, y: 0 };
    for (let i = 0; i < 200; i++) p = sp.update(0.25, -0.1, 1 / 60);
    expect(p.x).toBeCloseTo(0.25, 3);
    expect(p.y).toBeCloseTo(-0.1, 3);
  });

  it('clamp', () => {
    expect(clamp(2, -1, 1)).toBe(1);
    expect(clamp(-2, -1, 1)).toBe(-1);
    expect(clamp(0.3, -1, 1)).toBe(0.3);
  });
});

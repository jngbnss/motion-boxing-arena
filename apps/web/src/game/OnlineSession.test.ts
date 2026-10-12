import { describe, expect, it } from 'vitest';
import { STRIKES } from '@mba/combat';
import { samplePose, strikeTimeline, type PoseSample } from './OnlineSession.ts';

describe('samplePose (상대 포즈 보간 버퍼)', () => {
  const buf: PoseSample[] = [
    { t: 0, headX: 0, headY: 0, guard: 0 },
    { t: 50, headX: 1, headY: -1, guard: 1 },
    { t: 100, headX: 0, headY: 0, guard: 0.5 },
  ];
  it('두 샘플 사이를 선형 보간한다', () => {
    const p = samplePose(buf, 25)!;
    expect(p.headX).toBeCloseTo(0.5);
    expect(p.headY).toBeCloseTo(-0.5);
    expect(p.guard).toBeCloseTo(0.5);
    expect(samplePose(buf, 75)!.guard).toBeCloseTo(0.75);
  });
  it('버퍼 밖은 가장 가까운 샘플을 유지한다', () => {
    expect(samplePose(buf, -10)).toEqual(buf[0]);
    expect(samplePose(buf, 500)).toEqual(buf[2]);
    expect(samplePose([], 10)).toBeNull();
  });
});

describe('strikeTimeline', () => {
  it('combat STRIKES 규격으로 startup → active → recovery를 만든다', () => {
    const tl = strikeTimeline('straight', 'rear', 1000);
    const s = STRIKES.straight!;
    expect(tl.activeAt).toBe(1000 + s.startupMs);
    expect(tl.activeEndsAt).toBe(tl.activeAt + s.activeMs);
    expect(tl.recoveryEndsAt).toBe(tl.activeEndsAt + s.recoveryMs);
    expect(tl.aimLockAt).toBe(1000);
  });
});

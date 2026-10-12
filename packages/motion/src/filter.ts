// One Euro Filter (Casiez et al., CHI 2012). 저속에서는 지터를 강하게 줄이고 고속에서는 지연을 줄인다.
// 시간 단위는 ms로 받지만 내부 계산은 초 단위.
import type { Landmark } from './types.ts';

function alpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

export interface OneEuroParams {
  /** 최소 차단 주파수(Hz). 낮을수록 정지 상태 지터 감소 */
  minCutoff: number;
  /** 속도 계수. 높을수록 빠른 움직임에서 지연 감소 */
  beta: number;
  /** 미분값 차단 주파수(Hz) */
  dCutoff: number;
}

export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(private readonly params: OneEuroParams = { minCutoff: 1.5, beta: 8, dCutoff: 1 }) {}

  filter(value: number, tMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = value;
      this.tPrev = tMs;
      this.dxPrev = 0;
      return value;
    }
    const dt = (tMs - this.tPrev) / 1000;
    if (dt <= 0) return this.xPrev;
    const dx = (value - this.xPrev) / dt;
    const aD = alpha(this.params.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(dxHat);
    const a = alpha(cutoff, dt);
    const xHat = a * value + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tMs;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }
}

/** 랜드마크 배열을 좌표별로 필터링. 지정한 인덱스만 처리하고 나머지는 원본 유지 */
export class LandmarkFilter {
  private readonly filters = new Map<number, [OneEuroFilter, OneEuroFilter, OneEuroFilter]>();

  constructor(
    private readonly params: OneEuroParams,
    private readonly indices: readonly number[],
  ) {}

  apply(landmarks: readonly Landmark[], tMs: number): Landmark[] {
    const out = landmarks.map((l) => ({ ...l }));
    for (const i of this.indices) {
      const l = out[i];
      if (!l) continue;
      let f = this.filters.get(i);
      if (!f) {
        f = [new OneEuroFilter(this.params), new OneEuroFilter(this.params), new OneEuroFilter(this.params)];
        this.filters.set(i, f);
      }
      l.x = f[0].filter(l.x, tMs);
      l.y = f[1].filter(l.y, tMs);
      l.z = f[2].filter(l.z, tMs);
    }
    return out;
  }

  reset(): void {
    for (const f of this.filters.values()) for (const c of f) c.reset();
  }
}

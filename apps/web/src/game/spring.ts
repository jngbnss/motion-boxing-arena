// 임계 감쇠 스프링 (카메라·머리 시각 표현용). 판정에는 쓰지 않는다 (C11).

export interface SpringState {
  x: number;
  v: number;
}

/** 해석해(critically damped) 한 스텝. 큰 dt에도 안정적이다 */
export function stepCriticalSpring(s: SpringState, target: number, omega: number, dt: number): SpringState {
  const x0 = s.x - target;
  const exp = Math.exp(-omega * dt);
  const c = s.v + omega * x0;
  const x = target + (x0 + c * dt) * exp;
  const v = (c - omega * (x0 + c * dt)) * exp;
  return { x, v };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Spring2 {
  x: SpringState = { x: 0, v: 0 };
  y: SpringState = { x: 0, v: 0 };
  constructor(public omega: number) {}
  update(tx: number, ty: number, dt: number): { x: number; y: number } {
    this.x = stepCriticalSpring(this.x, tx, this.omega, dt);
    this.y = stepCriticalSpring(this.y, ty, this.omega, dt);
    return { x: this.x.x, y: this.y.x };
  }
  reset(): void {
    this.x = { x: 0, v: 0 };
    this.y = { x: 0, v: 0 };
  }
}

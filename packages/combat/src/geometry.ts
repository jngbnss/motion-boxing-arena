import { HEAD_HIT_OFFSET_SCALE, type PoseState } from '@mba/shared';

export interface Vec2 {
  x: number;
  y: number;
}

/** C11: PoseState(정규 오프셋) → 히트 판정용 머리 구 변위(m, 비감쇠) */
export function headWorldOffset(pose: Pick<PoseState, 'headX' | 'headY'>): Vec2 {
  return { x: pose.headX * HEAD_HIT_OFFSET_SCALE.x, y: pose.headY * HEAD_HIT_OFFSET_SCALE.y };
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

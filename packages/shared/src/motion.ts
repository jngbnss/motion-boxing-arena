// C2. 행동 이벤트 (motion → game). 네트워크 계약은 StrikeEvent와 PoseState뿐이다.
import { z } from 'zod';

export const HANDS = ['lead', 'rear'] as const;
export type Hand = (typeof HANDS)[number];

export const STRIKE_TYPES = ['jab', 'straight', 'hook', 'uppercut'] as const;
export type StrikeType = (typeof STRIKE_TYPES)[number];

/** MVP에서 실제로 허용하는 기술. hook/uppercut은 스키마만 예약한다. */
export const MVP_STRIKE_TYPES: readonly StrikeType[] = ['jab', 'straight'];

/** 로컬 UI/디버그 전용 파생값. 네트워크로 보내지 않는다 (C11). */
export type DefenseState = 'none' | 'guard' | 'slip_left' | 'slip_right' | 'duck';

export type Stance = 'orthodox' | 'southpaw';

export const StrikeEventSchema = z.object({
  kind: z.literal('strike'),
  type: z.enum(STRIKE_TYPES),
  hand: z.enum(HANDS),
  /** 이벤트 발생 시각(ms, performance.now 기준 클라이언트 시계) */
  t: z.number().finite(),
  confidence: z.number().min(0).max(1),
  seq: z.number().int().nonnegative(),
});
export type StrikeEvent = z.infer<typeof StrikeEventSchema>;

export const PoseStateSchema = z.object({
  /** 캘리브레이션 기준 정규화 머리 오프셋. ±1 = 사용자가 캘리브레이션한 최대 slip */
  headX: z.number().min(-1).max(1),
  headY: z.number().min(-1).max(1),
  /** 가드 가중치 0..1. 판정은 ≥ GUARD_BLOCK_THRESHOLD (C11) */
  guard: z.number().min(0).max(1),
  t: z.number().finite(),
});
export type PoseState = z.infer<typeof PoseStateSchema>;

/** 추적 손실 프레임에 판정으로 보내는 중앙·무방비 상태 (C12) */
export function neutralPose(t: number): PoseState {
  return { headX: 0, headY: 0, guard: 0, t };
}

/** 이 값 미만 confidence의 StrikeEvent는 게임이 무시한다 (C12) */
export const MIN_STRIKE_CONFIDENCE = 0.4;

/** 오소독스: lead=왼손. 사우스포는 반전 */
export function handForSide(side: 'left' | 'right', stance: Stance): Hand {
  const leadSide = stance === 'orthodox' ? 'left' : 'right';
  return side === leadSide ? 'lead' : 'rear';
}

/** MVP 매핑: lead → jab, rear → straight */
export function strikeTypeForHand(hand: Hand): StrikeType {
  return hand === 'lead' ? 'jab' : 'straight';
}

// C3. 공통 스켈레톤 mba-humanoid-v1 + 정규 히트 볼륨, C11 머리 오프셋 → 월드 변위.

export const SKELETON_ID = 'mba-humanoid-v1' as const;
export type SkeletonId = typeof SKELETON_ID;

/** Mixamo 명명 호환 22본 부분집합 (접두어 없음). 레스트 포즈 A-pose(팔 45°), 키 1.8m, +Y up, 정면 +Z */
export const BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
] as const;
export type BoneName = (typeof BONES)[number];

export const CANONICAL_HEIGHT_M = 1.8;

/** 정규 히트 볼륨 (캐릭터 메쉬와 무관, 모든 캐릭터 동일) */
export const HIT_VOLUMES = {
  headRadius: 0.13,
  bodyRadius: 0.18,
  bodyHeight: 0.5,
  gloveRadius: 0.08,
} as const;

/** 파이터 로컬 좌표계에서의 기본 위치 (발 원점, 상대를 향해 +Z) */
export const NEUTRAL_HEAD_POS = { x: 0, y: 1.62, z: 0 } as const;
export const NEUTRAL_BODY_CENTER = { x: 0, y: 1.2, z: 0 } as const;

/** C11: 히트 판정용 머리 구 변위 (비감쇠) */
export const HEAD_HIT_OFFSET_SCALE = { x: 0.3, y: 0.15 } as const;
/** C11: 카메라 연출용 변위 (감쇠, 판정에 쓰지 않음) */
export const HEAD_CAMERA_OFFSET_SCALE = { x: 0.25, y: 0.15 } as const;
export const CAMERA_SPRING_OMEGA = 12;

/** C11: 가드 판정 임계 */
export const GUARD_BLOCK_THRESHOLD = 0.7;

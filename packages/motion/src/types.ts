// packages/motion 공개 인터페이스 (계약). DOM·MediaPipe 의존 없음: 랜드마크 배열만 받는다.
// 이미지 좌표는 MediaPipe 정규 좌표(x,y ∈ 0..1, 원본(비미러) 카메라 프레임 기준).
// 랜드마크 라벨은 피사체 기준(11 = 사용자 왼쪽 어깨). 비미러 영상에서 사용자 왼쪽은 이미지 +x 방향이다.
// PoseState.headX 부호: +1 = 사용자 오른쪽으로 slip.
import type { DefenseState, PoseState, Stance, StrikeEvent } from '@mba/shared';

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface MotionFrame {
  /** 프레임 캡처 시각(ms) */
  t: number;
  /** 33개 포즈 랜드마크. 미검출 프레임은 null */
  landmarks: Landmark[] | null;
  /** 33개 월드 랜드마크(m). 선택 */
  world?: Landmark[] | null;
}

export const LM = {
  nose: 0,
  leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftPinky: 17, rightPinky: 18,
  leftIndex: 19, rightIndex: 20,
  leftThumb: 21, rightThumb: 22,
  leftHip: 23, rightHip: 24,
} as const;

/** 사용자별 캘리브레이션 결과 (모두 어깨 너비로 정규화된 단위) */
export interface CalibrationProfile {
  version: 1;
  stance: Stance;
  /** 중립 머리(코) 위치: 어깨 너비 단위, 카메라 프레임 기준 */
  head0: { x: number; y: number };
  /** 중립 어깨 너비(이미지 정규 좌표) */
  shoulderWidth0: number;
  /** 가드 자세의 손목-코 거리 평균 */
  guardWristNoseDist: number;
  /** 손별 펀치 피크 특징 */
  punch: Record<'lead' | 'rear', { peakSpeed: number; peakHandScale: number; peakElbowAngle: number }>;
  /** 최대 slip 변위 (headX=±1 기준) */
  slipLeft: number;
  slipRight: number;
  /** 최대 duck 변위 (headY=-1 기준) */
  duck: number;
}

export interface MotionDebug {
  tracking: boolean;
  hands: Record<'lead' | 'rear', { state: PunchPhase; speed: number; handScale: number; elbowAngle: number; score: number }>;
  guardScore: number;
  headOffset: { x: number; y: number };
  shoulderTilt: number;
}

export type PunchPhase = 'IDLE' | 'EXTENDING' | 'PEAK' | 'RETRACTING' | 'COOLDOWN';

export interface MotionOutput {
  strikes: StrikeEvent[];
  /** 판정용. 추적 손실 프레임에는 중앙·무방비(neutralPose) */
  pose: PoseState;
  defense: DefenseState;
  /** 이번 프레임 추적 여부 (어깨 visibility ≥ 0.5) */
  tracking: boolean;
  /** 추적 손실이 지속된 시간(ms). 0이면 추적 중 */
  trackingLostMs: number;
  debug: MotionDebug;
}

export interface MotionClassifierOptions {
  profile: CalibrationProfile;
  /** 경계값 배율 등 튜닝 파라미터 (분류기 v2 그리드 탐색 대상) */
  params?: Partial<ClassifierParams>;
}

export interface ClassifierParams {
  /** 펀치 속도 임계 = k × 캘리브레이션 피크 속도 */
  speedK: number;
  /** 손 크기 증가 임계 = 1 + k × (피크 비율 - 1) */
  handScaleK: number;
  /** slip 진입 임계 (|headX|) */
  slipEnter: number;
  /** guard 판정 지속 시간 */
  guardHoldMs: number;
  /** 펀치 FSM 최소 쿨다운 */
  cooldownMs: number;
  /** One Euro 필터 */
  minCutoff: number;
  beta: number;
}

export interface MotionClassifierApi {
  process(frame: MotionFrame): MotionOutput;
  reset(): void;
}

/** 단계별 캘리브레이션 (UI가 단계를 안내하고 프레임을 공급) */
export type CalibrationStep = 'neutral' | 'guard' | 'jab' | 'straight' | 'slip_left' | 'slip_right' | 'done';

export interface CalibratorApi {
  readonly step: CalibrationStep;
  /** 현재 단계 진행률 0..1 */
  readonly progress: number;
  /** 사용자에게 보여줄 안내 */
  readonly instruction: string;
  push(frame: MotionFrame): void;
  /** step === 'done'일 때 결과 */
  result(): CalibrationProfile | null;
}

/** 녹화 포맷 (JSONL 한 줄 = 한 프레임). tools/datasets/FORMAT.md */
export interface RecordingLine {
  t: number;
  lm: [number, number, number, number][] | null;
  wlm?: [number, number, number][] | null;
  label: 'none' | 'jab' | 'straight' | 'guard' | 'slip_left' | 'slip_right' | 'duck';
  hand?: 'lead' | 'rear';
  meta?: Record<string, unknown> | null;
}

// InputSource: 웹캠·키보드·리플레이를 같은 인터페이스로 (docs/02 §7).
import type { DefenseState, PoseState, StrikeEvent } from '@mba/shared';
import type { Landmark, MotionDebug } from '@mba/motion';

export type InputKind = 'webcam' | 'keyboard' | 'replay';

export interface InputFrame {
  /** 지난 poll 이후 발생한 펀치 */
  strikes: StrikeEvent[];
  /** 최신 판정용 포즈 (t는 입력 시계 기준, 게임이 sim 시계로 다시 찍는다) */
  pose: PoseState;
  defense: DefenseState;
  tracking: boolean;
  trackingLostMs: number;
  /** 양손 머리 위 2초 제스처 */
  pauseGesture: boolean;
}

export interface InputDiagnostics {
  landmarks: Landmark[] | null;
  debug: MotionDebug | null;
  inferenceFps: number;
  inferenceMsP50: number;
  inferenceMsP95: number;
  /** 프레임 캡처 → 이벤트 처리 완료 지연(ms) p50 */
  latencyMsP50: number;
  multiplePeople: boolean;
}

export interface InputSource {
  readonly kind: InputKind;
  start(): Promise<void>;
  poll(now: number): InputFrame;
  diagnostics(): InputDiagnostics | null;
  stop(): void;
}

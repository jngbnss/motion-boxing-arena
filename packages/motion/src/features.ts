// 프레임 → 특징 추출. 정규화: 원점 = 어깨 중점, 스케일 = 어깨 너비(등방 좌표).
// 등방 좌표: X = x × aspect, Y = y (이미지 정규 좌표 0..1, 비미러, y 아래 방향).
import { LandmarkFilter, type OneEuroParams } from './filter.ts';
import { LM, type Landmark, type MotionFrame } from './types.ts';

export type Side = 'left' | 'right';

export interface SideFeatures {
  /** 어깨 중점 기준 손목 위치(현재 어깨 너비 단위) */
  wrist: { x: number; y: number };
  /** 손목 속도(어깨 너비/초). 첫 프레임은 0 */
  speed: number;
  /** 손 겉보기 크기(손 끝점 3개 평균 쌍거리 / 어깨 너비). 카메라에 가까워질수록 커진다(깊이 대용) */
  handScale: number;
  /** 어깨-팔꿈치-손목 각도(도). world 랜드마크가 있으면 3D, 없으면 2D */
  elbowAngle: number;
  /** 손목-코 거리(어깨 너비 단위) */
  wristNoseDist: number;
  /** 손목이 어깨선보다 위 */
  wristAboveShoulder: boolean;
}

export interface Features {
  t: number;
  /** 등방 좌표 어깨 너비 */
  shoulderWidth: number;
  /** 카메라 프레임 기준 코 위치(등방 좌표). 캘리브레이션 기준점과 비교한다 */
  nose: { x: number; y: number };
  shoulderMid: { x: number; y: number };
  /** 어깨선 기울기(라디안). 사용자 오른쪽 어깨가 내려가면 양수 */
  shoulderTilt: number;
  sides: Record<Side, SideFeatures>;
}

const USED = [
  LM.nose, LM.leftEar, LM.rightEar,
  LM.leftShoulder, LM.rightShoulder, LM.leftElbow, LM.rightElbow,
  LM.leftWrist, LM.rightWrist, LM.leftPinky, LM.rightPinky,
  LM.leftIndex, LM.rightIndex, LM.leftThumb, LM.rightThumb,
] as const;

const SIDE_IDX = {
  left: { shoulder: LM.leftShoulder, elbow: LM.leftElbow, wrist: LM.leftWrist, pinky: LM.leftPinky, index: LM.leftIndex, thumb: LM.leftThumb },
  right: { shoulder: LM.rightShoulder, elbow: LM.rightElbow, wrist: LM.rightWrist, pinky: LM.rightPinky, index: LM.rightIndex, thumb: LM.rightThumb },
} as const;

export const MIN_SHOULDER_VISIBILITY = 0.5;

export function isTracking(landmarks: readonly Landmark[] | null | undefined): landmarks is Landmark[] {
  if (!landmarks || landmarks.length < 25) return false;
  const l = landmarks[LM.leftShoulder];
  const r = landmarks[LM.rightShoulder];
  return !!l && !!r && l.visibility >= MIN_SHOULDER_VISIBILITY && r.visibility >= MIN_SHOULDER_VISIBILITY;
}

type P2 = { x: number; y: number };
type P3 = { x: number; y: number; z: number };

function dist(a: P2, b: P2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleDeg(a: P3, b: P3, c: P3): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const n1 = Math.hypot(v1.x, v1.y, v1.z);
  const n2 = Math.hypot(v2.x, v2.y, v2.z);
  if (n1 < 1e-9 || n2 < 1e-9) return 180;
  const cos = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (n1 * n2);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

export interface FeatureExtractorOptions {
  /** 프레임 가로/세로 비 (기본 4:3) */
  aspect?: number;
  filter?: OneEuroParams;
}

/** 상태 보유: 필터와 이전 손목 위치(속도 계산용). 추적 손실 시 reset() */
export class FeatureExtractor {
  private readonly aspect: number;
  private readonly lmFilter: LandmarkFilter;
  private prev: { t: number; wrist: Record<Side, P2> } | null = null;

  constructor(opts: FeatureExtractorOptions = {}) {
    this.aspect = opts.aspect ?? 4 / 3;
    this.lmFilter = new LandmarkFilter(opts.filter ?? { minCutoff: 1.5, beta: 8, dCutoff: 1 }, USED);
  }

  reset(): void {
    this.lmFilter.reset();
    this.prev = null;
  }

  /** 추적 중이 아니면 null (내부 상태 reset) */
  extract(frame: MotionFrame): Features | null {
    if (!isTracking(frame.landmarks)) {
      this.reset();
      return null;
    }
    const raw = frame.landmarks.map((l) => ({ ...l, x: l.x * this.aspect }));
    const lm = this.lmFilter.apply(raw, frame.t);
    const g = (i: number): Landmark => lm[i] as Landmark;

    const ls = g(LM.leftShoulder);
    const rs = g(LM.rightShoulder);
    const mid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const sw = Math.max(dist(ls, rs), 1e-4);
    // 사용자 오른쪽(이미지 −x) 어깨가 내려가면(y 증가) 양수
    const shoulderTilt = Math.atan2(rs.y - ls.y, ls.x - rs.x);
    const nose = g(LM.nose);
    const rel = (p: P2): P2 => ({ x: (p.x - mid.x) / sw, y: (p.y - mid.y) / sw });
    const noseRel = rel(nose);

    const world = frame.world && frame.world.length >= 25 ? frame.world : null;
    const dtSec = this.prev ? (frame.t - this.prev.t) / 1000 : 0;

    const side = (s: Side): SideFeatures => {
      const ix = SIDE_IDX[s];
      const wrist = rel(g(ix.wrist));
      const hp = [g(ix.pinky), g(ix.index), g(ix.thumb)];
      const handScale = (dist(hp[0]!, hp[1]!) + dist(hp[1]!, hp[2]!) + dist(hp[0]!, hp[2]!)) / 3 / sw;
      const elbowAngle = world
        ? angleDeg(world[ix.shoulder]!, world[ix.elbow]!, world[ix.wrist]!)
        : angleDeg({ ...g(ix.shoulder), z: 0 }, { ...g(ix.elbow), z: 0 }, { ...g(ix.wrist), z: 0 });
      const prevW = this.prev?.wrist[s];
      const speed = prevW && dtSec > 0 ? dist(wrist, prevW) / dtSec : 0;
      return {
        wrist,
        speed,
        handScale,
        elbowAngle,
        wristNoseDist: dist(wrist, noseRel),
        wristAboveShoulder: wrist.y < 0,
      };
    };

    const sides = { left: side('left'), right: side('right') };
    this.prev = { t: frame.t, wrist: { left: sides.left.wrist, right: sides.right.wrist } };
    return { t: frame.t, shoulderWidth: sw, nose: { x: nose.x, y: nose.y }, shoulderMid: mid, shoulderTilt, sides };
  }
}

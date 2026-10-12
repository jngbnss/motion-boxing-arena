// 규칙 기반 동작 분류기 v1. 랜드마크 → StrikeEvent / PoseState / DefenseState.
// 설계: docs/05-MOTION-RECOGNITION.md, 결정 기록 C2·C11·C12.
//
// 펀치 점수 (손별, 0..1):
//   score = 0.40·cs + 0.35·cg + 0.25·ce
//   cs = clamp(speed / (speedK·peakSpeed))                      손목 2D 속도
//   cg = clamp((scaleRatio − 1) / (handScaleK·(peakHandScale − 1)))  손 겉보기 크기 증가(카메라 쪽 이동 = 깊이 대용)
//   ce = clamp((elbow − elbowBase) / (0.5·(peakElbowAngle − elbowBase)))  팔꿈치 펴짐
// 정면 펀치는 2D에서 팔이 짧아 보이므로 속도 단독이 아니라 손 크기 증가(cg)를 필수 조건으로 둔다.
// 가드 조정·옆으로 손 흔들기(크기 증가 없음)는 발행되지 않는다.
import {
  handForSide, neutralPose, strikeTypeForHand,
  type DefenseState, type Hand, type PoseState, type StrikeEvent,
} from '@mba/shared';
import { FeatureExtractor, type Features, type Side } from './features.ts';
import type {
  CalibrationProfile, ClassifierParams, MotionClassifierApi, MotionClassifierOptions,
  MotionDebug, MotionFrame, MotionOutput, PunchPhase,
} from './types.ts';

export const DEFAULT_PARAMS: ClassifierParams = {
  speedK: 0.5,
  handScaleK: 0.5,
  slipEnter: 0.6,
  guardHoldMs: 150,
  cooldownMs: 120,
  minCutoff: 1.5,
  beta: 8,
};

/** EXTENDING 진입 최소 점수 */
const ENTER_SCORE = 0.55;
/** 발행 최소 최대점수 */
const EMIT_SCORE = 0.7;
/** 발행에 필요한 최소 손 크기 성분 */
const EMIT_MIN_CG = 0.5;
const EXTEND_TIMEOUT_MS = 350;
const RETRACT_TIMEOUT_MS = 800;
/** 기준선(손 크기·팔꿈치) EMA 시간상수 */
const BASELINE_TAU_MS = 1500;
const SCALE_TAU_MS = 50;
/** head0 드리프트 보정 시간상수 (C12 문서: 5초) */
const DRIFT_TAU_MS = 5000;
const DRIFT_GATE = 0.45;
const DUCK_ENTER = 0.6;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const emaK = (dtMs: number, tauMs: number): number => 1 - Math.exp(-Math.max(dtMs, 0) / tauMs);

interface HandTrack {
  phase: PunchPhase;
  phaseSince: number;
  maxScore: number;
  maxCg: number;
  maxRatio: number;
  framesSinceMaxRatio: number;
  lastEmit: number;
  scaleBase: number | null;
  scaleSmooth: number | null;
  elbowBase: number | null;
  last: { speed: number; handScale: number; elbowAngle: number; score: number };
}

function newHand(): HandTrack {
  return {
    phase: 'IDLE', phaseSince: 0, maxScore: 0, maxCg: 0, maxRatio: 1, framesSinceMaxRatio: 0,
    lastEmit: -Infinity, scaleBase: null, scaleSmooth: null, elbowBase: null,
    last: { speed: 0, handScale: 0, elbowAngle: 0, score: 0 },
  };
}

export class MotionClassifier implements MotionClassifierApi {
  private readonly profile: CalibrationProfile;
  private readonly params: ClassifierParams;
  private readonly extractor: FeatureExtractor;
  private hands: Record<Hand, HandTrack> = { lead: newHand(), rear: newHand() };
  private head0: { x: number; y: number };
  private guardW = 0;
  private seq = 0;
  private lastT: number | null = null;
  private lostSince: number | null = null;

  constructor(opts: MotionClassifierOptions) {
    this.profile = opts.profile;
    this.params = { ...DEFAULT_PARAMS, ...opts.params };
    this.extractor = new FeatureExtractor({ filter: { minCutoff: this.params.minCutoff, beta: this.params.beta, dCutoff: 1 } });
    this.head0 = { ...opts.profile.head0 };
  }

  reset(): void {
    this.extractor.reset();
    this.hands = { lead: newHand(), rear: newHand() };
    this.head0 = { ...this.profile.head0 };
    this.guardW = 0;
    this.lastT = null;
    this.lostSince = null;
  }

  process(frame: MotionFrame): MotionOutput {
    const dtMs = this.lastT === null ? 0 : frame.t - this.lastT;
    this.lastT = frame.t;
    const f = this.extractor.extract(frame);
    if (!f) return this.lostOutput(frame.t);
    this.lostSince = null;

    // 사이드 → lead/rear
    const sideOf: Record<Hand, Side> = handForSide('left', this.profile.stance) === 'lead'
      ? { lead: 'left', rear: 'right' }
      : { lead: 'right', rear: 'left' };

    const strikes: StrikeEvent[] = [];
    for (const hand of ['lead', 'rear'] as const) {
      const ev = this.updateHand(hand, f.sides[sideOf[hand]], f.t, dtMs);
      if (ev) strikes.push(ev);
    }
    const punching = (['lead', 'rear'] as const).some((h) => this.hands[h].phase === 'EXTENDING' || this.hands[h].phase === 'PEAK');

    // 머리 오프셋: 카메라 프레임 기준(어깨 기준 아님), 캘리브레이션 어깨 너비 단위
    const sw0 = this.profile.shoulderWidth0;
    const hx = f.nose.x / sw0;
    const hy = f.nose.y / sw0;
    const userDx = -(hx - this.head0.x); // +: 사용자 오른쪽 (비미러 영상에서 이미지 −x)
    const dy = hy - this.head0.y; // +: 아래
    const headX = clamp(userDx / (userDx >= 0 ? this.profile.slipRight : this.profile.slipLeft), -1, 1);
    const headY = clamp(-dy / this.profile.duck, -1, 1);

    // 느린 드리프트 보정: 중앙 근처·펀치 아님일 때만
    if (Math.abs(headX) < DRIFT_GATE && Math.abs(headY) < DRIFT_GATE && !punching) {
      const k = emaK(dtMs, DRIFT_TAU_MS);
      this.head0.x += (hx - this.head0.x) * k;
      this.head0.y += (hy - this.head0.y) * k;
    }

    // 가드: 두 손목이 얼굴 근처 + 어깨선 위
    const gLimit = 1.3 * this.profile.guardWristNoseDist;
    const near = (s: Side): boolean => f.sides[s].wristNoseDist <= gLimit && f.sides[s].wristAboveShoulder;
    const guardRaw = near('left') && near('right') ? 1 : 0;
    this.guardW += (guardRaw - this.guardW) * emaK(dtMs, this.params.guardHoldMs / 3);
    const guard = clamp01(this.guardW);

    const slipThr = this.params.slipEnter * (punching ? 1.5 : 1);
    let defense: DefenseState = 'none';
    if (headX <= -slipThr) defense = 'slip_left';
    else if (headX >= slipThr) defense = 'slip_right';
    else if (headY <= -DUCK_ENTER) defense = 'duck';
    else if (guard >= 0.7) defense = 'guard';

    const pose: PoseState = { headX, headY, guard, t: f.t };
    return { strikes, pose, defense, tracking: true, trackingLostMs: 0, debug: this.debug(true, f, guard, { x: headX, y: headY }) };
  }

  private lostOutput(t: number): MotionOutput {
    if (this.lostSince === null) this.lostSince = t;
    this.hands.lead = { ...newHand(), scaleBase: this.hands.lead.scaleBase, elbowBase: this.hands.lead.elbowBase, lastEmit: this.hands.lead.lastEmit };
    this.hands.rear = { ...newHand(), scaleBase: this.hands.rear.scaleBase, elbowBase: this.hands.rear.elbowBase, lastEmit: this.hands.rear.lastEmit };
    this.guardW = 0;
    return {
      strikes: [],
      pose: neutralPose(t),
      defense: 'none',
      tracking: false,
      trackingLostMs: t - this.lostSince,
      debug: this.debug(false, null, 0, { x: 0, y: 0 }),
    };
  }

  private updateHand(hand: Hand, s: Features['sides'][Side], t: number, dtMs: number): StrikeEvent | null {
    const h = this.hands[hand];
    const peak = this.profile.punch[hand];
    if (h.scaleBase === null) h.scaleBase = s.handScale;
    if (h.elbowBase === null) h.elbowBase = s.elbowAngle;

    // 손 크기는 끝점 3개 지터에 민감하므로 짧은 EMA로 한 번 더 평활
    h.scaleSmooth = h.scaleSmooth === null ? s.handScale : h.scaleSmooth + (s.handScale - h.scaleSmooth) * emaK(dtMs, SCALE_TAU_MS);
    const ratio = h.scaleSmooth / Math.max(h.scaleBase, 1e-6);
    const cs = clamp01(s.speed / (this.params.speedK * peak.peakSpeed));
    const cg = clamp01((ratio - 1) / (this.params.handScaleK * Math.max(peak.peakHandScale - 1, 0.05)));
    const ce = clamp01((s.elbowAngle - h.elbowBase) / (0.5 * Math.max(peak.peakElbowAngle - h.elbowBase, 20)));
    const score = 0.4 * cs + 0.35 * cg + 0.25 * ce;
    h.last = { speed: s.speed, handScale: s.handScale, elbowAngle: s.elbowAngle, score };

    let emitted: StrikeEvent | null = null;
    const go = (phase: PunchPhase): void => {
      h.phase = phase;
      h.phaseSince = t;
    };

    switch (h.phase) {
      case 'IDLE': {
        // 기준선은 쉬는 동안만 갱신
        if (cs < 0.5) {
          const k = emaK(dtMs, BASELINE_TAU_MS);
          h.scaleBase += (h.scaleSmooth - h.scaleBase) * k;
          h.elbowBase += (s.elbowAngle - h.elbowBase) * k;
        }
        if (cs >= 1 && score >= ENTER_SCORE) {
          go('EXTENDING');
          h.maxScore = score;
          h.maxCg = cg;
          h.maxRatio = ratio;
          h.framesSinceMaxRatio = 0;
        }
        break;
      }
      case 'EXTENDING': {
        h.maxScore = Math.max(h.maxScore, score);
        h.maxCg = Math.max(h.maxCg, cg);
        if (ratio > h.maxRatio) {
          h.maxRatio = ratio;
          h.framesSinceMaxRatio = 0;
        } else {
          h.framesSinceMaxRatio++;
        }
        const stopped = cs < 0.5;
        const shrinking = h.framesSinceMaxRatio >= 2;
        const timedOut = t - h.phaseSince > EXTEND_TIMEOUT_MS;
        if (stopped || shrinking || timedOut) {
          // 머리 높이 펀치만: 정점에서 손목이 어깨선 위 (손 내리기·가드 올리기 중 오인식 차단)
          if (h.maxScore >= EMIT_SCORE && h.maxCg >= EMIT_MIN_CG && s.wristAboveShoulder && t - h.lastEmit >= this.params.cooldownMs) {
            emitted = {
              kind: 'strike',
              type: strikeTypeForHand(hand),
              hand,
              t,
              confidence: clamp01(h.maxScore),
              seq: this.seq++,
            };
            h.lastEmit = t;
            go('PEAK');
          } else {
            go('IDLE');
          }
        }
        break;
      }
      case 'PEAK':
        go('RETRACTING');
        break;
      case 'RETRACTING': {
        // 손 크기가 기준선 근처로 돌아오고 속도가 낮아지면 복귀 완료
        const back = ratio < 1 + 0.35 * (h.maxRatio - 1) && cs < 0.5;
        if (back || t - h.phaseSince > RETRACT_TIMEOUT_MS) go('COOLDOWN');
        break;
      }
      case 'COOLDOWN':
        if (t - h.lastEmit >= this.params.cooldownMs) go('IDLE');
        break;
    }
    return emitted;
  }

  private debug(tracking: boolean, f: Features | null, guard: number, head: { x: number; y: number }): MotionDebug {
    const hd = (hand: Hand): MotionDebug['hands']['lead'] => ({ state: this.hands[hand].phase, ...this.hands[hand].last });
    return {
      tracking,
      hands: { lead: hd('lead'), rear: hd('rear') },
      guardScore: guard,
      headOffset: head,
      shoulderTilt: f?.shoulderTilt ?? 0,
    };
  }
}

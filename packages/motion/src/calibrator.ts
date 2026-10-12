// 사용자별 캘리브레이션: neutral(3s) → guard(2s) → jab ×3 → straight ×3 → slip_left ×3 → slip_right ×3 → done.
// UI는 instruction/progress를 보여주고 프레임을 push한다.
import { handForSide, type Hand, type Stance } from '@mba/shared';
import { FeatureExtractor, type Features, type Side } from './features.ts';
import type { CalibrationProfile, CalibrationStep, CalibratorApi, MotionFrame } from './types.ts';

/** 개발·키보드 모드·테스트용 기본값 (화면 중앙, 약 2m 거리 가정) */
export function defaultProfile(stance: Stance = 'orthodox'): CalibrationProfile {
  return {
    version: 1,
    stance,
    head0: { x: (0.5 * 4) / 3 / 0.25, y: 0.3625 / 0.25 },
    shoulderWidth0: 0.25,
    guardWristNoseDist: 0.42,
    punch: {
      lead: { peakSpeed: 3, peakHandScale: 1.6, peakElbowAngle: 150 },
      rear: { peakSpeed: 3, peakHandScale: 1.6, peakElbowAngle: 150 },
    },
    slipLeft: 0.5,
    slipRight: 0.5,
    duck: 0.5,
  };
}

const NEUTRAL_MS = 3000;
const GUARD_MS = 2000;
const REPS = 3;
/** 캘리브레이션 중 반복 감지 임계 (분류기보다 낮게) */
const REP_SPEED_START = 1.0;
const REP_SPEED_END = 0.4;
const REP_MIN_SCALE_RATIO = 1.12;
const SLIP_START = 0.15;
const SLIP_END = 0.07;
const NEUTRAL_MAX_DRIFT = 0.15;

const INSTRUCTIONS: Record<CalibrationStep, string> = {
  neutral: '편하게 서서 카메라를 보세요. 3초간 움직이지 마세요.',
  guard: '양손을 얼굴 앞으로 올려 가드 자세를 2초간 유지하세요.',
  jab: '앞손으로 잽을 3번 던지세요. 매번 가드로 돌아오세요.',
  straight: '뒷손으로 스트레이트를 3번 던지세요.',
  slip_left: '상체를 왼쪽으로 3번 피했다가 돌아오세요.',
  slip_right: '상체를 오른쪽으로 3번 피했다가 돌아오세요.',
  done: '캘리브레이션 완료!',
};

const ORDER: CalibrationStep[] = ['neutral', 'guard', 'jab', 'straight', 'slip_left', 'slip_right', 'done'];

interface Rep { active: boolean; peakSpeed: number; peakRatio: number; peakElbow: number; extreme: number }

export class Calibrator implements CalibratorApi {
  private readonly extractor = new FeatureExtractor();
  private stepIdx = 0;
  private accumMs = 0;
  private lastT: number | null = null;
  private samples: Features[] = [];
  private rep: Rep = { active: false, peakSpeed: 0, peakRatio: 0, peakElbow: 0, extreme: 0 };
  private reps: Rep[] = [];
  private readonly out: CalibrationProfile;
  private scaleBase: Record<Side, number> = { left: 0, right: 0 };

  constructor(private readonly stance: Stance = 'orthodox') {
    this.out = defaultProfile(stance);
  }

  get step(): CalibrationStep {
    return ORDER[this.stepIdx] ?? 'done';
  }

  get progress(): number {
    switch (this.step) {
      case 'neutral': return Math.min(1, this.accumMs / NEUTRAL_MS);
      case 'guard': return Math.min(1, this.accumMs / GUARD_MS);
      case 'done': return 1;
      default: return this.reps.length / REPS;
    }
  }

  get instruction(): string {
    return INSTRUCTIONS[this.step];
  }

  result(): CalibrationProfile | null {
    return this.step === 'done' ? JSON.parse(JSON.stringify(this.out)) as CalibrationProfile : null;
  }

  private side(hand: Hand): Side {
    return handForSide('left', this.stance) === hand ? 'left' : 'right';
  }

  private next(): void {
    this.stepIdx++;
    this.accumMs = 0;
    this.samples = [];
    this.reps = [];
    this.rep = { active: false, peakSpeed: 0, peakRatio: 0, peakElbow: 0, extreme: 0 };
  }

  push(frame: MotionFrame): void {
    if (this.step === 'done') return;
    const dt = this.lastT === null ? 0 : frame.t - this.lastT;
    this.lastT = frame.t;
    const f = this.extractor.extract(frame);
    if (!f) {
      // 추적이 끊기면 시간 누적형 단계는 처음부터
      if (this.step === 'neutral' || this.step === 'guard') {
        this.accumMs = 0;
        this.samples = [];
      }
      return;
    }
    switch (this.step) {
      case 'neutral': return this.pushNeutral(f, dt);
      case 'guard': return this.pushGuard(f, dt);
      case 'jab': return this.pushPunch(f, 'lead');
      case 'straight': return this.pushPunch(f, 'rear');
      case 'slip_left': return this.pushSlip(f, -1);
      case 'slip_right': return this.pushSlip(f, 1);
    }
  }

  private pushNeutral(f: Features, dt: number): void {
    if (this.samples.length > 0) {
      const mx = mean(this.samples.map((s) => s.nose.x));
      const my = mean(this.samples.map((s) => s.nose.y));
      const sw = mean(this.samples.map((s) => s.shoulderWidth));
      if (Math.hypot(f.nose.x - mx, f.nose.y - my) / sw > NEUTRAL_MAX_DRIFT) {
        this.samples = [];
        this.accumMs = 0;
      }
    }
    this.samples.push(f);
    this.accumMs += dt;
    if (this.accumMs >= NEUTRAL_MS) {
      const sw0 = mean(this.samples.map((s) => s.shoulderWidth));
      this.out.shoulderWidth0 = sw0;
      this.out.head0 = {
        x: mean(this.samples.map((s) => s.nose.x)) / sw0,
        y: mean(this.samples.map((s) => s.nose.y)) / sw0,
      };
      this.next();
    }
  }

  private pushGuard(f: Features, dt: number): void {
    const up = f.sides.left.wristAboveShoulder && f.sides.right.wristAboveShoulder
      && f.sides.left.wristNoseDist < 0.9 && f.sides.right.wristNoseDist < 0.9;
    if (!up) return;
    this.samples.push(f);
    this.accumMs += dt;
    if (this.accumMs >= GUARD_MS) {
      this.out.guardWristNoseDist = mean(this.samples.flatMap((s) => [s.sides.left.wristNoseDist, s.sides.right.wristNoseDist]));
      this.scaleBase = {
        left: mean(this.samples.map((s) => s.sides.left.handScale)),
        right: mean(this.samples.map((s) => s.sides.right.handScale)),
      };
      this.next();
    }
  }

  private pushPunch(f: Features, hand: Hand): void {
    const s = f.sides[this.side(hand)];
    const ratio = s.handScale / Math.max(this.scaleBase[this.side(hand)] || s.handScale, 1e-6);
    const r = this.rep;
    if (!r.active) {
      if (s.speed >= REP_SPEED_START) {
        this.rep = { active: true, peakSpeed: s.speed, peakRatio: ratio, peakElbow: s.elbowAngle, extreme: 0 };
      }
      return;
    }
    r.peakSpeed = Math.max(r.peakSpeed, s.speed);
    r.peakRatio = Math.max(r.peakRatio, ratio);
    r.peakElbow = Math.max(r.peakElbow, s.elbowAngle);
    // 끝: 속도가 떨어지고 손이 기준 크기 근처로 복귀
    if (s.speed < REP_SPEED_END && ratio < 1 + 0.3 * (r.peakRatio - 1)) {
      r.active = false;
      if (r.peakRatio >= REP_MIN_SCALE_RATIO) this.reps.push({ ...r });
      if (this.reps.length >= REPS) {
        this.out.punch[hand] = {
          peakSpeed: mean(this.reps.map((x) => x.peakSpeed)),
          peakHandScale: mean(this.reps.map((x) => x.peakRatio)),
          peakElbowAngle: mean(this.reps.map((x) => x.peakElbow)),
        };
        this.next();
      }
    }
  }

  /** dir: −1 = 사용자 왼쪽, +1 = 오른쪽 */
  private pushSlip(f: Features, dir: -1 | 1): void {
    const sw0 = this.out.shoulderWidth0;
    const userX = -(f.nose.x / sw0 - this.out.head0.x);
    const v = userX * dir;
    const r = this.rep;
    if (!r.active) {
      if (v >= SLIP_START) this.rep = { active: true, peakSpeed: 0, peakRatio: 0, peakElbow: 0, extreme: v };
      return;
    }
    r.extreme = Math.max(r.extreme, v);
    if (v <= SLIP_END) {
      r.active = false;
      this.reps.push({ ...r });
      if (this.reps.length >= REPS) {
        const m = mean(this.reps.map((x) => x.extreme));
        if (dir < 0) this.out.slipLeft = m;
        else this.out.slipRight = m;
        this.next();
      }
    }
  }
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

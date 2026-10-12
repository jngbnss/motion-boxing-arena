// 합성 사람 랜드마크 생성기. 비미러 카메라 이미지 좌표(0..1), 30fps, 시드 고정 노이즈.
// 기하(어깨 너비 SW 단위, 어깨 중점 기준): 사용자 왼쪽 = 이미지 +x.
import type { Landmark, MotionFrame, RecordingLine } from '../src/types.ts';
import { LM } from '../src/types.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ASPECT = 4 / 3;
export const SW = 0.25; // 등방 좌표 어깨 너비
const MID_X = 0.5 * ASPECT;
const SH_Y = 0.5;

export interface ArmState { g: number; e: number }
export interface BodyState { shiftX: number; shiftY: number; left: ArmState; right: ArmState }

type Label = RecordingLine['label'];
export interface Segment { label: 'jab' | 'straight'; hand: 'lead' | 'rear'; start: number; end: number }

type V = { x: number; y: number };
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const lerp = (a: V, b: V, k: number): V => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
const smooth = (k: number): number => k * k * (3 - 2 * k);

export interface SessionOptions {
  seed?: number;
  noise?: number; // 이미지 좌표 σ
  fps?: number;
  /** lead 손 = 'left'(오소독스) 또는 'right'(사우스포) */
  leadSide?: 'left' | 'right';
}

export class SyntheticSession {
  readonly frames: MotionFrame[] = [];
  readonly labels: Label[] = [];
  readonly segments: Segment[] = [];
  private t = 0;
  private readonly dt: number;
  private readonly rand: () => number;
  private readonly noise: number;
  private readonly leadSide: 'left' | 'right';
  state: BodyState = { shiftX: 0, shiftY: 0, left: { g: 1, e: 0 }, right: { g: 1, e: 0 } };

  constructor(opts: SessionOptions = {}) {
    this.dt = 1000 / (opts.fps ?? 30);
    this.rand = mulberry32(opts.seed ?? 1);
    this.noise = opts.noise ?? 0.003;
    this.leadSide = opts.leadSide ?? 'left';
  }

  private gauss(): number {
    const u = Math.max(this.rand(), 1e-12);
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private arm(name: 'lead' | 'rear'): 'left' | 'right' {
    return name === 'lead' ? this.leadSide : this.leadSide === 'left' ? 'right' : 'left';
  }

  /** 현재 상태로 프레임 하나 생성 */
  private emit(label: Label | null, occluded: 'none' | 'null' | 'lowvis' = 'none'): void {
    const st = this.state;
    const mid: V = { x: MID_X - st.shiftX * SW, y: SH_Y + st.shiftY * SW };
    const pts: V[] = Array.from({ length: 33 }, () => ({ x: mid.x, y: mid.y + 2 * SW }));
    const at = (rel: V): V => add(mid, mul(rel, SW));
    const nose = at({ x: 0, y: -0.55 });
    pts[LM.nose] = nose;
    pts[LM.leftEar] = add(nose, mul({ x: 0.12, y: 0.02 }, SW));
    pts[LM.rightEar] = add(nose, mul({ x: -0.12, y: 0.02 }, SW));
    pts[LM.leftHip] = at({ x: 0.35, y: 1.6 });
    pts[LM.rightHip] = at({ x: -0.35, y: 1.6 });
    for (const side of ['left', 'right'] as const) {
      const s = side === 'left' ? 1 : -1;
      const a = st[side];
      const sh: V = { x: s * 0.5, y: 0 };
      const restE = add(sh, { x: s * 0.15, y: 0.7 });
      const restW = add(sh, { x: s * 0.05, y: 1.3 });
      const guardE = add(sh, { x: s * 0.05, y: 0.45 });
      const guardW: V = { x: s * 0.3, y: -0.25 };
      const extW: V = { x: s * 0.05, y: -0.4 };
      const extE: V = add(lerp(sh, extW, 0.5), { x: s * 0.03, y: 0.03 });
      const e = smooth(Math.min(1, Math.max(0, a.e)));
      const elbow = lerp(lerp(restE, guardE, a.g), extE, e);
      const wrist = lerp(lerp(restW, guardW, a.g), extW, e);
      const hs = 0.12 * (1 + 0.6 * e);
      const idx = side === 'left'
        ? { sh: LM.leftShoulder, el: LM.leftElbow, wr: LM.leftWrist, pi: LM.leftPinky, ix: LM.leftIndex, th: LM.leftThumb }
        : { sh: LM.rightShoulder, el: LM.rightElbow, wr: LM.rightWrist, pi: LM.rightPinky, ix: LM.rightIndex, th: LM.rightThumb };
      pts[idx.sh] = at(sh);
      pts[idx.el] = at(elbow);
      pts[idx.wr] = at(wrist);
      pts[idx.pi] = at(add(wrist, mul({ x: s * 0.6, y: -0.7 }, hs)));
      pts[idx.ix] = at(add(wrist, mul({ x: -s * 0.1, y: -1.0 }, hs)));
      pts[idx.th] = at(add(wrist, mul({ x: -s * 0.6, y: -0.4 }, hs)));
    }
    let landmarks: Landmark[] | null = pts.map((p) => ({
      x: (p.x + this.gauss() * this.noise * ASPECT) / ASPECT,
      y: p.y + this.gauss() * this.noise,
      z: 0,
      visibility: 0.99,
    }));
    if (occluded === 'null') landmarks = null;
    if (occluded === 'lowvis' && landmarks) {
      landmarks[LM.leftShoulder]!.visibility = 0.2;
      landmarks[LM.rightShoulder]!.visibility = 0.2;
    }
    this.frames.push({ t: this.t, landmarks });
    this.labels.push(label ?? this.autoLabel());
    this.t += this.dt;
  }

  private autoLabel(): Label {
    const st = this.state;
    if (st.shiftX <= -0.3) return 'slip_left';
    if (st.shiftX >= 0.3) return 'slip_right';
    if (st.left.g >= 0.95 && st.right.g >= 0.95 && st.left.e < 0.05 && st.right.e < 0.05) return 'guard';
    return 'none';
  }

  hold(ms: number, label: Label | null = null): this {
    const n = Math.round(ms / this.dt);
    for (let i = 0; i < n; i++) this.emit(label);
    return this;
  }

  /** target 상태로 ms 동안 smoothstep 보간 */
  to(target: { shiftX?: number; shiftY?: number; lead?: Partial<ArmState>; rear?: Partial<ArmState> }, ms: number, label: Label | null = null): this {
    const from = JSON.parse(JSON.stringify(this.state)) as BodyState;
    const goal = JSON.parse(JSON.stringify(this.state)) as BodyState;
    if (target.shiftX !== undefined) goal.shiftX = target.shiftX;
    if (target.shiftY !== undefined) goal.shiftY = target.shiftY;
    if (target.lead) Object.assign(goal[this.arm('lead')], target.lead);
    if (target.rear) Object.assign(goal[this.arm('rear')], target.rear);
    const n = Math.max(1, Math.round(ms / this.dt));
    for (let i = 1; i <= n; i++) {
      const k = smooth(i / n);
      const mix = (a: number, b: number): number => a + (b - a) * k;
      this.state = {
        shiftX: mix(from.shiftX, goal.shiftX),
        shiftY: mix(from.shiftY, goal.shiftY),
        left: { g: mix(from.left.g, goal.left.g), e: from.left.e + (goal.left.e - from.left.e) * (i / n) },
        right: { g: mix(from.right.g, goal.right.g), e: from.right.e + (goal.right.e - from.right.e) * (i / n) },
      };
      this.emit(label);
    }
    return this;
  }

  private strike(label: 'jab' | 'straight', hand: 'lead' | 'rear', outMs: number, holdMs: number, backMs: number): this {
    const start = this.t;
    this.to({ [hand]: { e: 1 } }, outMs, label).hold(holdMs, label).to({ [hand]: { e: 0 } }, backMs, label);
    this.segments.push({ label, hand, start, end: this.t });
    return this;
  }

  jab(): this {
    return this.strike('jab', 'lead', 120, 60, 200);
  }

  straight(): this {
    return this.strike('straight', 'rear', 160, 60, 240);
  }

  /** dir: −1 사용자 왼쪽, +1 오른쪽. amount: 어깨 너비 단위 */
  slip(dir: -1 | 1, amount = 0.5): this {
    return this.to({ shiftX: dir * amount }, 200).hold(300).to({ shiftX: 0 }, 300);
  }

  guardUp(ms = 250): this {
    return this.to({ lead: { g: 1 }, rear: { g: 1 } }, ms);
  }

  rest(ms = 300): this {
    return this.to({ lead: { g: 0 }, rear: { g: 0 } }, ms);
  }

  occlude(ms: number, mode: 'null' | 'lowvis' = 'null'): this {
    const n = Math.round(ms / this.dt);
    for (let i = 0; i < n; i++) this.emit('none', mode);
    return this;
  }

  /** 랜덤 순서 라벨 세션 (평가용) */
  static labeled(seed: number, rounds: number, leadSide: 'left' | 'right' = 'left'): SyntheticSession {
    const s = new SyntheticSession({ seed, leadSide });
    const r = mulberry32(seed + 1000);
    s.hold(1000);
    const acts = ['jab', 'straight', 'slipL', 'slipR', 'rest'] as const;
    for (let i = 0; i < rounds; i++) {
      const a = acts[Math.floor(r() * acts.length)]!;
      if (a === 'jab') s.jab();
      else if (a === 'straight') s.straight();
      else if (a === 'slipL') s.slip(-1);
      else if (a === 'slipR') s.slip(1);
      else s.rest().hold(600).guardUp();
      s.hold(400 + r() * 600);
    }
    return s;
  }
}

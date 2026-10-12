// 웹캠 입력: PoseTracker 프레임 → MotionClassifier → StrikeEvent/PoseState.
import { neutralPose, type DefenseState, type PoseState, type StrikeEvent } from '@mba/shared';
import { LM, MotionClassifier, type CalibrationProfile, type Landmark, type MotionDebug, type MotionFrame, type MotionOutput } from '@mba/motion';
import type { InputDiagnostics, InputFrame, InputSource } from './types.ts';
import type { PoseTracker, TrackerFrame } from './PoseTracker.ts';

const PAUSE_GESTURE_MS = 2000;

/** 양손이 코보다 확실히 위에 있으면 true (이미지 y는 아래로 증가) */
export function handsOverHead(lm: Landmark[] | null): boolean {
  if (!lm) return false;
  const nose = lm[LM.nose], lw = lm[LM.leftWrist], rw = lm[LM.rightWrist];
  if (!nose || !lw || !rw) return false;
  if (lw.visibility < 0.5 || rw.visibility < 0.5) return false;
  return lw.y < nose.y - 0.08 && rw.y < nose.y - 0.08;
}

/** 분류기 출력 누적기: 웹캠·리플레이가 공유 */
export class ClassifierPipe {
  readonly classifier: MotionClassifier;
  private queue: StrikeEvent[] = [];
  private last: MotionOutput | null = null;
  private overHeadSince: number | null = null;
  private gestureFired = false;
  lastLandmarks: Landmark[] | null = null;
  multiplePeople = false;

  constructor(profile: CalibrationProfile) {
    this.classifier = new MotionClassifier({ profile });
  }

  push(frame: MotionFrame, numPoses = 1): void {
    const out = this.classifier.process(frame);
    this.last = out;
    this.lastLandmarks = frame.landmarks;
    this.multiplePeople = numPoses > 1;
    this.queue.push(...out.strikes);
    if (handsOverHead(frame.landmarks)) {
      this.overHeadSince ??= frame.t;
    } else {
      this.overHeadSince = null;
      this.gestureFired = false;
    }
  }

  take(now: number): InputFrame {
    const strikes = this.queue;
    this.queue = [];
    const o = this.last;
    let pauseGesture = false;
    if (this.overHeadSince != null && !this.gestureFired && now - this.overHeadSince >= PAUSE_GESTURE_MS) {
      pauseGesture = true;
      this.gestureFired = true;
    }
    const pose: PoseState = o ? o.pose : neutralPose(now);
    const defense: DefenseState = o ? o.defense : 'none';
    return {
      strikes,
      pose,
      defense,
      tracking: o?.tracking ?? false,
      trackingLostMs: o ? o.trackingLostMs : 0,
      pauseGesture,
    };
  }

  debug(): MotionDebug | null {
    return this.last?.debug ?? null;
  }
}

export class WebcamInput implements InputSource {
  readonly kind = 'webcam' as const;
  private pipe: ClassifierPipe;
  private unsub: (() => void) | null = null;

  constructor(private tracker: PoseTracker, profile: CalibrationProfile) {
    this.pipe = new ClassifierPipe(profile);
  }

  async start(): Promise<void> {
    this.unsub = this.tracker.subscribe((f: TrackerFrame) => this.pipe.push(f, f.numPoses));
    this.tracker.startLoop();
  }

  poll(now: number): InputFrame {
    return this.pipe.take(now);
  }

  diagnostics(): InputDiagnostics {
    const s = this.tracker.stats();
    return { landmarks: this.pipe.lastLandmarks, debug: this.pipe.debug(), multiplePeople: this.pipe.multiplePeople, ...s };
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }
}

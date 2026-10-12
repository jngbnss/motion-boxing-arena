// 리플레이 입력: 녹화한 랜드마크 JSONL을 원래 타이밍으로 재생 → 웹캠 없이 게임·분류기 테스트.
import { parseRecording, type CalibrationProfile, type Landmark, type MotionFrame, type RecordingLine } from '@mba/motion';
import { ClassifierPipe } from './WebcamInput.ts';
import type { InputDiagnostics, InputFrame, InputSource } from './types.ts';

export function lineToFrame(line: RecordingLine, t: number): MotionFrame {
  const toLm = (a: number[]): Landmark => ({ x: a[0] ?? 0, y: a[1] ?? 0, z: a[2] ?? 0, visibility: a[3] ?? 1 });
  return {
    t,
    landmarks: line.lm ? line.lm.map(toLm) : null,
    world: line.wlm ? line.wlm.map((a) => toLm([...a, 1])) : null,
  };
}

export class ReplayInput implements InputSource {
  readonly kind = 'replay' as const;
  private pipe: ClassifierPipe;
  private lines: RecordingLine[];
  private idx = 0;
  private startedAt = 0;
  private t0 = 0;
  private timer = 0;
  loop = true;

  constructor(text: string, profile: CalibrationProfile) {
    this.lines = parseRecording(text);
    this.pipe = new ClassifierPipe(profile);
  }

  get length(): number {
    return this.lines.length;
  }

  async start(): Promise<void> {
    if (this.lines.length === 0) throw new Error('녹화 파일에 프레임이 없어요.');
    this.startedAt = performance.now();
    this.t0 = this.lines[0]!.t;
    this.idx = 0;
    const tick = () => {
      const now = performance.now();
      const rel = now - this.startedAt;
      while (this.idx < this.lines.length && this.lines[this.idx]!.t - this.t0 <= rel) {
        const line = this.lines[this.idx++]!;
        this.pipe.push(lineToFrame(line, this.startedAt + (line.t - this.t0)));
      }
      if (this.idx >= this.lines.length && this.loop) {
        this.idx = 0;
        this.startedAt = now;
      }
      this.timer = window.setTimeout(tick, 8);
    };
    tick();
  }

  poll(now: number): InputFrame {
    return this.pipe.take(now);
  }

  diagnostics(): InputDiagnostics {
    return { landmarks: this.pipe.lastLandmarks, debug: this.pipe.debug(), inferenceFps: 0, inferenceMsP50: 0, inferenceMsP95: 0, latencyMsP50: 0, multiplePeople: false };
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

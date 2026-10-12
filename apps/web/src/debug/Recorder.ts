// 랜드마크 JSONL 녹화 (영상 아님). 숫자키로 라벨: 1 잽, 2 스트레이트, 3 가드, 4 좌회피, 5 우회피, 6 숙이기, 0 없음
import { toRecordingLine, type RecordingLine } from '@mba/motion';
import type { PoseTracker, TrackerFrame } from '../input/PoseTracker.ts';

export type Label = RecordingLine['label'];

export const KEY_LABELS: Record<string, Label> = {
  Digit0: 'none', Digit1: 'jab', Digit2: 'straight', Digit3: 'guard', Digit4: 'slip_left', Digit5: 'slip_right', Digit6: 'duck',
};

export class Recorder {
  private lines: RecordingLine[] = [];
  private unsub: (() => void) | null = null;
  label: Label = 'none';
  recording = false;

  constructor(private tracker: PoseTracker, private stance: 'orthodox' | 'southpaw') {}

  start(): void {
    this.lines = [];
    this.recording = true;
    this.unsub = this.tracker.subscribe((f: TrackerFrame) => {
      const hand = this.label === 'jab' ? 'lead' : this.label === 'straight' ? 'rear' : undefined;
      const line = toRecordingLine(f, this.label, hand);
      if (this.lines.length === 0) line.meta = { stance: this.stance, source: 'web-debug', userAgent: navigator.userAgent };
      this.lines.push(line);
    });
    this.tracker.startLoop();
  }

  stop(): string {
    this.unsub?.();
    this.unsub = null;
    this.recording = false;
    return this.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }

  get count(): number {
    return this.lines.length;
  }
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

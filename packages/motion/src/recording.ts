// 랜드마크 녹화 JSONL (한 줄 = 한 프레임). 영상은 저장하지 않는다. 형식: tools/datasets/FORMAT.md
import type { Landmark, MotionFrame, RecordingLine } from './types.ts';

const LABELS = new Set<RecordingLine['label']>(['none', 'jab', 'straight', 'guard', 'slip_left', 'slip_right', 'duck']);
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;

export function toRecordingLine(frame: MotionFrame, label: RecordingLine['label'] = 'none', hand?: 'lead' | 'rear'): RecordingLine {
  const line: RecordingLine = {
    t: Math.round(frame.t * 10) / 10,
    lm: frame.landmarks ? frame.landmarks.map((l) => [r5(l.x), r5(l.y), r5(l.z), r5(l.visibility)]) : null,
    label,
  };
  if (frame.world !== undefined) line.wlm = frame.world ? frame.world.map((l) => [r5(l.x), r5(l.y), r5(l.z)]) : null;
  if (hand) line.hand = hand;
  return line;
}

/** JSONL 텍스트 → RecordingLine[]. 형식 오류는 줄 번호와 함께 throw */
export function parseRecording(text: string): RecordingLine[] {
  const out: RecordingLine[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const s = raw.trim();
    if (!s) return;
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      throw new Error(`recording line ${i + 1}: invalid JSON`);
    }
    const o = v as Partial<RecordingLine>;
    if (typeof o.t !== 'number') throw new Error(`recording line ${i + 1}: missing t`);
    if (o.lm !== null && !Array.isArray(o.lm)) throw new Error(`recording line ${i + 1}: lm must be array or null`);
    const label = (o.label ?? 'none') as RecordingLine['label'];
    if (!LABELS.has(label)) throw new Error(`recording line ${i + 1}: unknown label ${String(label)}`);
    out.push({ ...(o as RecordingLine), label });
  });
  return out;
}

/** RecordingLine → MotionFrame (리플레이 입력·오프라인 평가용) */
export function recordingToFrames(lines: readonly RecordingLine[]): MotionFrame[] {
  return lines.map((l) => ({
    t: l.t,
    landmarks: l.lm ? l.lm.map(([x, y, z, visibility]): Landmark => ({ x, y, z, visibility })) : null,
    world: l.wlm ? l.wlm.map(([x, y, z]): Landmark => ({ x, y, z, visibility: 1 })) : l.wlm === null ? null : undefined,
  }));
}

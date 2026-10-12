// 라벨 프레임 + 분류기 출력 → 클래스별 Precision / Recall / F1.
// 펀치: 이벤트 단위(라벨 구간 ±toleranceMs 안의 같은 종류 이벤트 1개 = TP).
// 상태(guard/slip): 프레임 단위, 라벨 경계 ±boundaryMs 프레임과 펀치 구간 프레임은 제외.
import type { DefenseState, StrikeEvent } from '@mba/shared';
import type { RecordingLine } from '../src/types.ts';

export interface PRF { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }

function prf(tp: number, fp: number, fn: number): PRF {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

export interface StrikeSegment { label: 'jab' | 'straight'; start: number; end: number }

export function evalStrikes(segments: readonly StrikeSegment[], events: readonly StrikeEvent[], toleranceMs = 100): Record<'jab' | 'straight', PRF> {
  const out = {} as Record<'jab' | 'straight', PRF>;
  for (const cls of ['jab', 'straight'] as const) {
    const segs = segments.filter((s) => s.label === cls);
    const evs = events.filter((e) => e.type === cls);
    const used = new Set<number>();
    let tp = 0;
    for (const s of segs) {
      const i = evs.findIndex((e, k) => !used.has(k) && e.t >= s.start - toleranceMs && e.t <= s.end + toleranceMs);
      if (i >= 0) {
        used.add(i);
        tp++;
      }
    }
    out[cls] = prf(tp, evs.length - used.size, segs.length - tp);
  }
  return out;
}

export type StateClass = 'guard' | 'slip_left' | 'slip_right';

export function evalStates(
  times: readonly number[],
  labels: readonly RecordingLine['label'][],
  predicted: readonly DefenseState[],
  boundaryMs = 200,
): Record<StateClass, PRF> {
  const n = times.length;
  const changes: number[] = [];
  for (let i = 1; i < n; i++) if (labels[i] !== labels[i - 1]) changes.push(times[i]!);
  const nearBoundary = (t: number): boolean => changes.some((c) => Math.abs(c - t) <= boundaryMs);
  const out = {} as Record<StateClass, PRF>;
  for (const cls of ['guard', 'slip_left', 'slip_right'] as const) {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < n; i++) {
      const lab = labels[i]!;
      if (lab === 'jab' || lab === 'straight' || nearBoundary(times[i]!)) continue;
      const isL = lab === cls;
      const isP = predicted[i] === cls;
      if (isL && isP) tp++;
      else if (!isL && isP) fp++;
      else if (isL && !isP) fn++;
    }
    out[cls] = prf(tp, fp, fn);
  }
  return out;
}

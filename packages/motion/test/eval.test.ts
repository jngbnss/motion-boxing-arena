import { describe, expect, it } from 'vitest';
import { MotionClassifier, defaultProfile, parseRecording, recordingToFrames, toRecordingLine } from '../src/index.ts';
import { evalStates, evalStrikes } from './eval.ts';
import { SyntheticSession } from './synthetic.ts';

describe('recording JSONL', () => {
  it('round-trips frames and labels', () => {
    const s = new SyntheticSession({ seed: 31 }).hold(200).occlude(66);
    const text = s.frames.map((f, i) => JSON.stringify(toRecordingLine(f, s.labels[i]!))).join('\n');
    const lines = parseRecording(text + '\n');
    expect(lines).toHaveLength(s.frames.length);
    const frames = recordingToFrames(lines);
    expect(frames[0]!.landmarks![0]!.x).toBeCloseTo(s.frames[0]!.landmarks![0]!.x, 4);
    expect(frames.at(-1)!.landmarks).toBeNull();
  });

  it('reports bad lines with line numbers', () => {
    expect(() => parseRecording('{"t":1,"lm":null,"label":"none"}\nnot json')).toThrow(/line 2/);
    expect(() => parseRecording('{"t":1,"lm":null,"label":"kick"}')).toThrow(/unknown label/);
  });
});

describe('synthetic labeled session evaluation', () => {
  it.each([
    ['orthodox', 'left', 41],
    ['southpaw', 'right', 42],
  ] as const)('F1 ≥ 0.9 per class (%s)', (stance, leadSide, seed) => {
    const s = SyntheticSession.labeled(seed, 80, leadSide);
    const c = new MotionClassifier({ profile: defaultProfile(stance) });
    const outs = s.frames.map((f) => c.process(f));
    const strikes = evalStrikes(s.segments, outs.flatMap((o) => o.strikes));
    const states = evalStates(s.frames.map((f) => f.t), s.labels, outs.map((o) => o.defense));
    for (const [cls, m] of Object.entries({ ...strikes, ...states })) {
      expect(m.f1, `${cls} ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(0.9);
    }
  });
});

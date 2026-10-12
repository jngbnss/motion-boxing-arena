import { describe, expect, it, vi } from 'vitest';
import { CLOCK_INITIAL_SAMPLES, CLOCK_RESAMPLE_MS, ClockSync, ServerClock } from './clock.ts';

describe('ServerClock', () => {
  it('초기 5회 중 RTT 최소 샘플로 오프셋을 정한다', () => {
    const c = new ServerClock();
    const trueOffset = 5000;
    // (send, rtt, 비대칭 지연) — RTT 20ms 샘플만 대칭
    const samples: Array<[number, number, number]> = [[0, 80, 60], [100, 20, 10], [200, 50, 45], [300, 60, 10], [400, 90, 80]];
    for (const [send, rtt, up] of samples) {
      const serverTime = send + up + trueOffset;
      c.addSample(send, serverTime, send + rtt);
    }
    expect(c.synced).toBe(true);
    expect(c.offset).toBeCloseTo(trueOffset, 6);
    expect(c.toServer(1000)).toBeCloseTo(6000, 6);
    expect(c.toLocal(6000)).toBeCloseTo(1000, 6);
  });

  it('재샘플은 EMA로 천천히 보정하고, 부풀려진 RTT 샘플은 오프셋에 반영하지 않는다', () => {
    const c = new ServerClock();
    for (let i = 0; i < CLOCK_INITIAL_SAMPLES; i++) c.addSample(i * 100, i * 100 + 10 + 1000, i * 100 + 20);
    expect(c.offset).toBeCloseTo(1000, 6);
    // 드리프트 +50ms, RTT 정상
    c.addSample(10_000, 10_000 + 10 + 1050, 10_020);
    expect(c.offset).toBeGreaterThan(1000);
    expect(c.offset).toBeLessThan(1050);
    const before = c.offset;
    // RTT 400ms(큐잉) 샘플은 무시
    c.addSample(20_000, 20_000 + 390 + 3000, 20_400);
    expect(c.offset).toBe(before);
    expect(c.rtt).toBeGreaterThan(20);
  });

  it('음수 RTT 샘플은 버린다', () => {
    const c = new ServerClock();
    expect(c.addSample(100, 5, 50)).toBeNull();
    expect(c.synced).toBe(false);
  });
});

describe('ClockSync', () => {
  it('버스트 5회 후 10초 간격으로 핑을 보낸다', () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      let now = 0;
      const sync = new ClockSync((t) => sent.push(t), () => now);
      sync.start();
      vi.advanceTimersByTime(1000);
      expect(sent.length).toBe(CLOCK_INITIAL_SAMPLES);
      vi.advanceTimersByTime(CLOCK_RESAMPLE_MS);
      expect(sent.length).toBe(CLOCK_INITIAL_SAMPLES + 1);
      now = 50;
      sync.onPong({ clientTime: 30, serverTime: 1040 });
      expect(sync.serverNow()).toBeCloseTo(50 + 1000, 6);
      sync.stop();
      vi.advanceTimersByTime(CLOCK_RESAMPLE_MS * 3);
      expect(sent.length).toBe(CLOCK_INITIAL_SAMPLES + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

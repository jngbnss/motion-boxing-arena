import { describe, expect, it } from 'vitest';
import { LocalMatch } from './LocalMatch.ts';

const hp = (player: number, ai: number) => ({ player, ai });

describe('LocalMatch', () => {
  it('READY → COUNTDOWN(3s) → FIGHTING', () => {
    const m = new LocalMatch();
    m.start(0);
    expect(m.phase).toBe('COUNTDOWN');
    expect(m.tick(2999, hp(100, 100), null)).toBe('COUNTDOWN');
    expect(m.countdownLeftMs(2000)).toBe(1000);
    expect(m.tick(3000, hp(100, 100), null)).toBe('FIGHTING');
  });

  it('KO → (hold) → RESULT, 승자는 KO 상대', () => {
    const m = new LocalMatch({ countdownMs: 0, koHoldMs: 1000 });
    m.start(0);
    m.tick(0, hp(100, 100), null);
    m.tick(5000, hp(100, 0), 'ai');
    expect(m.phase).toBe('KO');
    expect(m.outcome).toEqual({ reason: 'KO', winner: 'player', durationMs: 5000 });
    m.tick(5999, hp(100, 0), 'ai');
    expect(m.phase).toBe('KO');
    m.tick(6000, hp(100, 0), 'ai');
    expect(m.phase).toBe('RESULT');
  });

  it('시간 종료: HP 높은 쪽 승, 동률 무승부', () => {
    const a = new LocalMatch({ countdownMs: 0, roundMs: 1000 });
    a.start(0); a.tick(0, hp(60, 40), null); a.tick(1000, hp(60, 40), null);
    expect(a.outcome?.reason).toBe('TIME_UP');
    expect(a.outcome?.winner).toBe('player');

    const b = new LocalMatch({ countdownMs: 0, roundMs: 1000 });
    b.start(0); b.tick(0, hp(50, 50), null); b.tick(1000, hp(50, 50), null);
    expect(b.outcome?.winner).toBeNull();
  });

  it('PAUSED 동안 경기 시간이 흐르지 않고, 재개는 3초 카운트다운', () => {
    const m = new LocalMatch({ countdownMs: 0, resumeCountdownMs: 3000, roundMs: 90_000 });
    m.start(0);
    m.tick(0, hp(100, 100), null);
    m.tick(10_000, hp(100, 100), null);
    expect(m.pause(10_000, 'TRACKING_LOST')).toBe(true);
    m.tick(40_000, hp(100, 100), null);
    expect(m.elapsedMs()).toBe(10_000);
    m.resume(40_000);
    expect(m.phase).toBe('COUNTDOWN');
    m.tick(43_000, hp(100, 100), null);
    expect(m.phase).toBe('FIGHTING');
    m.tick(44_000, hp(100, 100), null);
    expect(m.elapsedMs()).toBe(11_000);
  });

  it('RESULT → 재대결 READY', () => {
    const m = new LocalMatch({ countdownMs: 0, koHoldMs: 0 });
    m.start(0); m.tick(0, hp(100, 100), null); m.tick(1, hp(0, 100), 'player'); m.tick(2, hp(0, 100), 'player');
    expect(m.phase).toBe('RESULT');
    expect(m.outcome?.winner).toBe('ai');
    m.rematch(3);
    expect(m.phase).toBe('READY');
    m.start(3);
    expect(m.phase).toBe('COUNTDOWN');
  });

  it('잘못된 전이는 무시하거나 거부', () => {
    const m = new LocalMatch();
    expect(m.pause(0, 'USER')).toBe(false);
    expect(m.resume(0)).toBe(false);
    expect(() => m.rematch(0)).toThrow();
  });
});

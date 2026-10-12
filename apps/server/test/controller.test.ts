import { MATCH_RULES, type ServerMessages } from '@mba/shared';
import { describe, expect, it } from 'vitest';
import { DuelController, END_HOLD_MS, TICK_MS, type DuelPorts, type DuelResult } from '../src/realtime/controller.ts';

interface Sent {
  to: string;
  type: string;
  msg: unknown;
}

/** 주입 시계 + 기록 포트로 컨트롤러를 결정적으로 구동한다 */
function harness(opts: { rewindGraceMs?: number } = {}) {
  let t = 1_000_000;
  const sent: Sent[] = [];
  const results: DuelResult[] = [];
  const ports: DuelPorts = {
    now: () => t,
    send: (to, type, msg) => sent.push({ to, type, msg }),
    sendError: (to, code, message) => sent.push({ to, type: 'error', msg: { code, message } }),
    broadcast: (type, msg) => sent.push({ to: '*', type, msg }),
    saveResult: (r) => results.push(r),
    validateCharacter: async (_userId, id) => id.startsWith('builtin:') || id === 'chr_ready',
  };
  const c = new DuelController(ports, { rewindGraceMs: opts.rewindGraceMs ?? 80 });
  /** 플레이어별 20Hz 포즈 자동 송신 (null이면 송신 중단) */
  const poses: Record<string, { headX: number; headY: number; guard: number } | null> = {};
  let lastPoseAt = -Infinity;

  const advance = (ms: number) => {
    const end = t + ms;
    while (t < end) {
      t = Math.min(end, t + TICK_MS);
      if (t - lastPoseAt >= 50) {
        lastPoseAt = t;
        for (const [sid, p] of Object.entries(poses)) if (p) c.pose(sid, { ...p, t });
      }
      c.tick();
    }
  };
  const of = <K extends keyof ServerMessages>(type: K, to?: string) =>
    sent.filter((s) => s.type === type && (to === undefined || s.to === to)).map((s) => s.msg as ServerMessages[K]);
  const errors = (to: string) => sent.filter((s) => s.type === 'error' && s.to === to).map((s) => s.msg as { code: string });

  const join = () => {
    c.join('A', { userId: 'uA', nickname: 'alice', characterId: 'builtin:red' });
    c.join('B', { userId: 'uB', nickname: 'bob', characterId: 'builtin:blue' });
  };
  const startFight = () => {
    join();
    c.calibDone('A', { quality: 0.9, profileHash: 'a' });
    c.calibDone('B', { quality: 0.9, profileHash: 'b' });
    c.setReady('A', { ready: true });
    c.setReady('B', { ready: true });
    poses.A = { headX: 0, headY: 0, guard: 0 };
    poses.B = { headX: 0, headY: 0, guard: 0 };
    advance(MATCH_RULES.countdownMs);
    expect(c.phase).toBe('FIGHTING');
  };
  let seq = 0;
  const strike = (sid: string, over: Partial<{ type: 'jab' | 'straight' | 'hook' | 'uppercut'; hand: 'lead' | 'rear'; t: number; seq: number; confidence: number }> = {}) => {
    c.strike(sid, { kind: 'strike', type: 'jab', hand: 'lead', t, confidence: 0.9, seq: ++seq, ...over });
    return seq;
  };
  return { c, sent, results, poses, advance, of, errors, join, startFight, strike, now: () => t };
}

describe('DuelController phase machine (C8)', () => {
  it('goes LOBBY → WAITING_OPPONENT → CALIBRATING → READY → COUNTDOWN → FIGHTING', () => {
    const h = harness();
    expect(h.c.phase).toBe('LOBBY');
    h.c.join('A', { userId: 'uA', nickname: 'alice', characterId: 'builtin:red' });
    expect(h.c.phase).toBe('WAITING_OPPONENT');
    h.c.join('B', { userId: 'uB', nickname: 'bob', characterId: 'builtin:blue' });
    expect(h.c.phase).toBe('CALIBRATING');
    expect(h.c.canJoin()).toBe(false);

    h.c.setReady('A', { ready: true });
    expect(h.errors('A').map((e) => e.code)).toEqual(['NOT_CALIBRATED']);

    h.c.calibDone('A', { quality: 0.3, profileHash: 'a' }); // 품질 낮아도 막지 않는다
    expect(h.c.phase).toBe('CALIBRATING');
    h.c.calibDone('B', { quality: 0.9, profileHash: 'b' });
    expect(h.c.phase).toBe('READY');

    h.c.setReady('A', { ready: true });
    expect(h.c.phase).toBe('READY');
    const before = h.now();
    h.c.setReady('B', { ready: true });
    expect(h.c.phase).toBe('COUNTDOWN');
    expect(h.of('match:countdown')).toEqual([{ startAt: before + 3000, reason: 'start' }]);

    h.advance(2_990);
    expect(h.c.phase).toBe('COUNTDOWN');
    h.advance(20);
    expect(h.c.phase).toBe('FIGHTING');
    expect(h.of('match:start')).toHaveLength(1);
    expect(h.of('match:start')[0]!.durationMs).toBe(MATCH_RULES.roundMs);
  });

  it('answers time:ping with server time', () => {
    const h = harness();
    h.join();
    h.c.ping('A', { clientTime: 42 });
    expect(h.of('time:pong', 'A')).toEqual([{ clientTime: 42, serverTime: h.now() }]);
  });

  it('returns to WAITING_OPPONENT when the opponent leaves before the fight', () => {
    const h = harness();
    h.join();
    h.c.calibDone('A', { quality: 1, profileHash: 'a' });
    h.c.leave('B');
    expect(h.c.phase).toBe('WAITING_OPPONENT');
    expect(h.c.canJoin()).toBe(true);
    h.c.join('C', { userId: 'uC', nickname: 'carol', characterId: 'builtin:green' });
    expect(h.c.phase).toBe('CALIBRATING');
    h.c.calibDone('C', { quality: 1, profileHash: 'c' });
    expect(h.c.phase).toBe('READY');
  });
});

describe('strike validation and server-authoritative judgement', () => {
  it('rejects strikes outside FIGHTING with PHASE', () => {
    const h = harness();
    h.join();
    const seq = h.strike('A');
    expect(h.of('strike:rejected', 'A')).toEqual([{ seq, reason: 'PHASE' }]);
  });

  it('broadcasts strike_start and resolves a hit after startup + REWIND_GRACE', () => {
    const h = harness();
    h.startFight();
    const t0 = h.now();
    const seq = h.strike('A');
    expect(h.of('combat:strike_start')).toEqual([{ attacker: 'A', type: 'jab', hand: 'lead', seq, activeAt: t0 + 100 }]);
    h.advance(100 + 40); // active 시각은 지났지만 grace(80ms) 전
    expect(h.of('combat:hit')).toHaveLength(0);
    h.advance(60);
    const hits = h.of('combat:hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ attacker: 'A', target: 'B', zone: 'head', damage: 6, hpAfter: 94, seq });
    expect(h.c.players().find((p) => p.sessionId === 'B')!.hp).toBe(94);
  });

  it('judges dodge and guard from the defender pose ring buffer', () => {
    const h = harness();
    h.startFight();
    // 조준은 공격 시작 시점 머리 위치에 고정된다 (C10): 그 뒤에 머리를 빼야 회피
    const s1 = h.strike('A');
    h.poses.B = { headX: 1, headY: 0, guard: 0 };
    h.advance(300);
    expect(h.of('combat:dodged')).toEqual([{ attacker: 'A', target: 'B', seq: s1 }]);

    h.poses.B = { headX: 0, headY: 0, guard: 1 };
    h.advance(400);
    const s2 = h.strike('A', { type: 'straight', hand: 'rear' });
    h.advance(400);
    expect(h.of('combat:blocked')).toEqual([{ attacker: 'A', target: 'B', chip: 2, hpAfter: 98, seq: s2 }]);
  });

  it('rejects disabled types, stale timestamps, dead pose streams; drops duplicate seq silently', () => {
    const h = harness();
    h.startFight();
    const hook = h.strike('A', { type: 'hook' });
    const stale = h.strike('A', { t: h.now() - 1_500 });
    h.strike('A', { seq: stale }); // 같은 seq 재전송
    h.poses.A = null;
    h.advance(1_100);
    const dead = h.strike('A');
    expect(h.of('strike:rejected', 'A')).toEqual([
      { seq: hook, reason: 'TYPE_DISABLED' },
      { seq: stale, reason: 'STALE' },
      { seq: dead, reason: 'STALE' },
    ]);
    expect(h.of('combat:strike_start')).toHaveLength(0);
  });

  it('enforces per-hand cooldown through CombatSim', () => {
    const h = harness();
    h.startFight();
    h.strike('A');
    h.advance(100);
    const again = h.strike('A');
    expect(h.of('strike:rejected', 'A')).toEqual([{ seq: again, reason: 'COOLDOWN' }]);
  });
});

describe('match end, results and rematch', () => {
  it('ends by KO, saves the result, holds then RESULT, rematch skips calibration', () => {
    const h = harness();
    h.startFight();
    for (let i = 0; i < 40 && h.c.phase === 'FIGHTING'; i++) {
      h.strike('A');
      h.advance(400);
    }
    expect(h.c.phase).toBe('KO');
    const end = h.of('match:end');
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ reason: 'KO', winner: 'A' });
    expect(end[0]!.stats.A!.hits).toBe(17);
    expect(h.results[0]).toMatchObject({ reason: 'KO', winnerUserId: 'uA' });
    expect(h.results[0]!.players.map((p) => [p.userId, p.hpEnd, p.won])).toEqual([
      ['uA', 100, true],
      ['uB', 0, false],
    ]);

    h.advance(END_HOLD_MS);
    expect(h.c.phase).toBe('RESULT');
    h.c.rematch('A');
    expect(h.c.phase).toBe('RESULT');
    h.c.rematch('B');
    expect(h.c.phase).toBe('READY');
    expect(h.c.players().every((p) => p.calibrated && !p.ready && p.hp === 100)).toBe(true);
    h.c.setReady('A', { ready: true });
    h.c.setReady('B', { ready: true });
    expect(h.c.phase).toBe('COUNTDOWN');
  });

  it('ends by TIME_UP with HP-ratio winner; paused time does not count', () => {
    const h = harness();
    h.startFight();
    h.strike('A');
    h.advance(10_000);
    h.c.drop('B');
    expect(h.c.phase).toBe('PAUSED');
    const left = h.c.timeLeftMs;
    h.advance(5_000);
    expect(h.c.timeLeftMs).toBe(left);
    h.c.reconnect('B');
    expect(h.c.phase).toBe('COUNTDOWN');
    expect(h.of('match:countdown').at(-1)!.reason).toBe('resume');
    h.advance(MATCH_RULES.resumeCountdownMs);
    expect(h.c.phase).toBe('FIGHTING');
    h.advance(left - 100);
    expect(h.c.phase).toBe('FIGHTING');
    h.advance(300);
    expect(h.c.phase).toBe('TIME_UP');
    expect(h.of('match:end')[0]).toMatchObject({ reason: 'TIME_UP', winner: 'A', durationMs: MATCH_RULES.roundMs });
  });

  it('allows character swap in RESULT but not after READY', async () => {
    const h = harness();
    h.startFight();
    h.c.forfeit('B');
    h.advance(END_HOLD_MS);
    expect(h.c.phase).toBe('RESULT');
    await h.c.setCharacter('A', { characterId: 'chr_ready' });
    await h.c.setCharacter('B', { characterId: 'chr_generating' });
    expect(h.c.players().find((p) => p.sessionId === 'A')!.characterId).toBe('chr_ready');
    expect(h.errors('B').map((e) => e.code)).toEqual(['CHARACTER_NOT_READY']);
    h.c.rematch('A');
    h.c.rematch('B');
    await h.c.setCharacter('A', { characterId: 'builtin:green' });
    expect(h.errors('A').map((e) => e.code)).toEqual(['PHASE_INVALID']);
  });
});

describe('pauses: disconnect, tracking loss, network (C12)', () => {
  it('forfeits the disconnected player after the 20s reconnect window', () => {
    const h = harness();
    h.startFight();
    h.c.drop('B');
    const paused = h.of('match:paused');
    expect(paused).toEqual([{ reason: 'DISCONNECT', player: 'B', resumeDeadline: h.now() + 20_000, pauseBudgetLeftMs: 30_000 }]);
    h.advance(19_900);
    expect(h.c.phase).toBe('PAUSED');
    h.advance(200);
    expect(h.c.phase).toBe('FORFEIT');
    expect(h.of('match:end')[0]).toMatchObject({ reason: 'FORFEIT', winner: 'A' });
  });

  it('records ABANDONED when both players are gone', () => {
    const h = harness();
    h.startFight();
    h.c.drop('A');
    h.c.drop('B');
    h.advance(20_100);
    expect(h.of('match:end')[0]).toMatchObject({ reason: 'ABANDONED', winner: null });
    expect(h.results[0]!.reason).toBe('ABANDONED');
  });

  it('pauses after 3s of tracking loss and forfeits when the 30s budget runs out', () => {
    const h = harness();
    h.startFight();
    const loseFor = (ms: number) => {
      h.c.trackingLost('B', { lost: true, t: h.now() });
      h.advance(3_000);
      expect(h.c.phase).toBe('PAUSED');
      h.advance(ms);
    };
    loseFor(12_000);
    h.c.trackingLost('B', { lost: false, t: h.now() });
    expect(h.c.phase).toBe('COUNTDOWN');
    h.advance(3_000);
    loseFor(12_000);
    h.c.trackingLost('B', { lost: false, t: h.now() });
    h.advance(3_000);
    expect(h.c.phase).toBe('FIGHTING');

    // 예산 30s 중 약 24s 사용 → 다음 정지는 남은 약 6s 뒤 몰수패 (틱 33ms 오차)
    h.c.trackingLost('B', { lost: true, t: h.now() });
    h.advance(3_000);
    const last = h.of('match:paused').at(-1)!;
    expect(last).toMatchObject({ reason: 'TRACKING_LOST', player: 'B' });
    expect(last.pauseBudgetLeftMs).toBeGreaterThan(5_900);
    expect(last.pauseBudgetLeftMs).toBeLessThan(6_100);
    h.advance(5_700);
    expect(h.c.phase).toBe('PAUSED');
    h.advance(500);
    expect(h.c.phase).toBe('FORFEIT');
    expect(h.of('match:end')[0]).toMatchObject({ reason: 'FORFEIT', winner: 'A' });
  });

  it('pauses with NETWORK when a connected client stops sending poses, resumes when they return', () => {
    const h = harness();
    h.startFight();
    h.poses.B = null;
    h.advance(3_100);
    expect(h.c.phase).toBe('PAUSED');
    expect(h.of('match:paused').at(-1)).toMatchObject({ reason: 'NETWORK', player: 'B' });
    h.poses.B = { headX: 0, headY: 0, guard: 0 };
    h.advance(100);
    expect(h.c.phase).toBe('COUNTDOWN');
    expect(h.of('match:resumed')).toHaveLength(1);
  });

  it('keeps pending strikes consistent across a pause (sim time excludes paused time)', () => {
    const h = harness();
    h.startFight();
    const t0 = h.now();
    h.strike('A', { type: 'straight', hand: 'rear' }); // startup 160ms
    h.advance(60);
    h.c.drop('A');
    h.advance(10_000);
    h.c.reconnect('A');
    h.advance(MATCH_RULES.resumeCountdownMs);
    expect(h.of('combat:hit')).toHaveLength(0);
    h.advance(200);
    const hit = h.of('combat:hit');
    expect(hit).toHaveLength(1);
    // 재개 후 남은 startup(100ms)이 지난 뒤 판정, stunUntil은 서버 시각 기준
    expect(hit[0]!.stunUntil).toBeGreaterThan(t0 + 10_000 + MATCH_RULES.resumeCountdownMs);
  });
});

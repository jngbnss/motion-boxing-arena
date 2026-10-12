// 실제 서버(Fastify + Colyseus, 같은 포트)에 @colyseus/sdk 0.18 클라이언트 2개로 접속하는 통합 테스트
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, type Room } from '@colyseus/sdk';
import type { GuestSessionResponse, RoomLookupResponse, ServerMessages } from '@mba/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type MbaServer } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';

let server: MbaServer;
let dir: string;
let base: string;

interface DuelStateView {
  phase: string;
  code: string;
  players: Map<string, { userId: string; hp: number; connected: boolean; characterId: string }>;
}

async function guest(nickname: string): Promise<GuestSessionResponse> {
  const res = await fetch(`${base}/api/v1/sessions/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }) });
  return (await res.json()) as GuestSessionResponse;
}

/**
 * 조건(수신 메시지·상태 패치·DB 행)이 참이 될 때까지 폴링한다.
 * 실제 소켓·Colyseus 시계·3초 카운트다운을 통과하는 통합 테스트라 가짜 타이머를 쓸 수 없다
 * (결정적 시간 제어 테스트는 controller.test.ts).
 */
async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 8_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await sleep(20);
  }
}

/** 수신 메시지 기록 */
function record(room: Room) {
  const log: Array<{ type: string; msg: unknown }> = [];
  room.onMessage('*', (type, msg) => log.push({ type: String(type), msg }));
  return {
    log,
    of: <K extends keyof ServerMessages | 'error'>(type: K) =>
      log.filter((m) => m.type === type).map((m) => m.msg as K extends keyof ServerMessages ? ServerMessages[K] : { code: string }),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mba-duel-'));
  const config = loadConfig({ DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', AUTH_SECRET: 'duel-secret', REWIND_GRACE_MS: '80' });
  server = await createServer(config, { db: await openDb(), logger: false });
  const port = await server.listen();
  base = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('duel room over the network', () => {
  it('create → code lookup → join → calib/ready → strike/hit → forfeit → result saved → reconnect', async () => {
    const [alice, bob] = await Promise.all([guest('alice'), guest('bob')]);
    const client = new Client(base);

    // 토큰 없으면 거절
    await expect(client.create('duel', { characterId: 'builtin:red' })).rejects.toThrow();

    const a = await client.create('duel', { token: alice.token, characterId: 'builtin:red', nickname: 'alice' });
    const ra = record(a);
    const sa = () => a.state as unknown as DuelStateView;
    const code = await until(() => sa().code);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    await until(() => sa().phase === 'WAITING_OPPONENT');

    const lookup = await fetch(`${base}/api/v1/rooms/${code.toLowerCase()}`);
    expect(lookup.status).toBe(200);
    const { roomId, playerCount } = (await lookup.json()) as RoomLookupResponse;
    expect(playerCount).toBe(1);

    // 캐릭터가 READY가 아니면 입장 거절
    await expect(client.joinById(roomId, { token: bob.token, characterId: 'chr_not_mine' })).rejects.toThrow();
    const b = await client.joinById(roomId, { token: bob.token, characterId: 'builtin:blue', nickname: 'bob' });
    const rb = record(b);
    await until(() => sa().phase === 'CALIBRATING');
    expect((await fetch(`${base}/api/v1/rooms/${code}`)).status).toBe(409);

    // 시계 동기화
    a.send('time:ping', { clientTime: 123 });
    const pong = await until(() => ra.of('time:pong')[0]);
    expect(pong.clientTime).toBe(123);
    expect(Math.abs(pong.serverTime - Date.now())).toBeLessThan(1_000);

    // 검증 실패는 error로 회신
    a.send('calib:done', { quality: 5, profileHash: 'x' });
    await until(() => ra.of('error')[0]);
    expect(ra.of('error')[0]).toMatchObject({ code: 'VALIDATION_FAILED' });

    for (const r of [a, b]) r.send('calib:done', { quality: 0.9, profileHash: 'h' });
    await until(() => sa().phase === 'READY');
    for (const r of [a, b]) r.send('room:ready', { ready: true });
    const countdown = await until(() => rb.of('match:countdown')[0]);
    expect(countdown.reason).toBe('start');

    // 20Hz 포즈 (같은 프로세스라 Date.now()가 서버 시각)
    const poser = setInterval(() => {
      for (const r of [a, b]) r.send('input:pose', { headX: 0, headY: 0, guard: 0, t: Date.now() });
    }, 50);
    try {
      await until(() => ra.of('match:start')[0], 6_000);
      await until(() => sa().phase === 'FIGHTING');

      a.send('input:strike', { kind: 'strike', type: 'jab', hand: 'lead', t: Date.now(), confidence: 0.95, seq: 1 });
      a.send('input:strike', { kind: 'strike', type: 'hook', hand: 'rear', t: Date.now(), confidence: 0.95, seq: 2 });
      const start = await until(() => rb.of('combat:strike_start')[0]);
      expect(start).toMatchObject({ attacker: a.sessionId, type: 'jab', seq: 1 });
      expect(await until(() => ra.of('strike:rejected')[0])).toEqual({ seq: 2, reason: 'TYPE_DISABLED' });
      const hit = await until(() => rb.of('combat:hit')[0]);
      expect(hit).toMatchObject({ attacker: a.sessionId, target: b.sessionId, damage: 6, hpAfter: 94 });
      await until(() => sa().players.get(b.sessionId)?.hp === 94);

      b.send('match:forfeit', {});
      const end = await until(() => ra.of('match:end')[0]);
      expect(end).toMatchObject({ reason: 'FORFEIT', winner: a.sessionId });
      expect(end.stats[a.sessionId]).toMatchObject({ punches: 1, hits: 1 });
    } finally {
      clearInterval(poser);
    }

    const saved = await until(async () => {
      const { rows } = await server.ctx.db.query<{ result: string; winner_user_id: string; room_code: string }>(
        `SELECT result, winner_user_id, room_code FROM matches WHERE mode = 'online'`,
      );
      return rows.length > 0 && rows;
    });
    expect(saved).toEqual([{ result: 'FORFEIT', winner_user_id: alice.userId, room_code: code }]);

    await until(() => sa().phase === 'RESULT', 5_000);

    // 상대가 떠나면 혼자 WAITING_OPPONENT, 비동의 끊김 후 재접속 (두 번 연속: 새 토큰 사용)
    await b.leave(true);
    await until(() => sa().phase === 'WAITING_OPPONENT');
    let room = a;
    for (let i = 0; i < 2; i++) {
      const token = room.reconnectionToken;
      const sid = room.sessionId;
      // 페이지 새로고침 재현: SDK 자동 재접속을 끄고 소켓만 끊은 뒤, 보관한 토큰으로 직접 재접속
      room.reconnection.enabled = false;
      await room.leave(false);
      await until(() => (server.ctx.registry.lookup(code)?.playerCount ?? 0) === 1);
      room = await client.reconnect(token);
      expect(room.sessionId).toBe(sid);
      const s = () => room.state as unknown as DuelStateView;
      await until(() => s().players?.get(sid)?.connected === true);
      expect(s().phase).toBe('WAITING_OPPONENT');
    }
    await room.leave(true);
  }, 30_000);
});

// REST + 내부 워커 API 종단 테스트 (Fastify inject, 메모리 PGlite)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterManifest, ClaimedJob, GenerateResponse, GuestSessionResponse, UploadResponse } from '@mba/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type MbaServer } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { makeGlb, makePng } from './fixtures.ts';

let server: MbaServer;
let dir: string;
const WORKER = { 'x-worker-secret': 'test-worker-secret' };

function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer; type: string }) {
  const boundary = '----mba-test-boundary';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function guest(nickname: string): Promise<{ auth: { authorization: string }; userId: string }> {
  const res = await server.app.inject({ method: 'POST', url: '/api/v1/sessions/guest', payload: { nickname } });
  expect(res.statusCode).toBe(201);
  const body = res.json<GuestSessionResponse>();
  return { auth: { authorization: `Bearer ${body.token}` }, userId: body.userId };
}

async function upload(auth: Record<string, string>, data: Buffer, rights = 'true') {
  const mp = multipart({ rightsAttested: rights }, { name: 'me.png', data, type: 'image/png' });
  return server.app.inject({ method: 'POST', url: '/api/v1/uploads', payload: mp.payload, headers: { ...auth, ...mp.headers } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mba-http-'));
  const config = loadConfig({ DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', AUTH_SECRET: 'test-secret', WORKER_SECRET: 'test-worker-secret', PUBLIC_BASE_URL: 'http://files.test' });
  server = await createServer(config, { db: await openDb(), logger: false });
  await server.listen();
}, 30_000);

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sessions and auth', () => {
  it('issues guest tokens and rejects missing/forged/garbage tokens with the error format', async () => {
    const { auth } = await guest('복서_01');
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/characters', headers: auth })).json()).toEqual({ items: [], nextCursor: null });

    const forged = auth.authorization.slice(0, -2) + (auth.authorization.endsWith('AA') ? 'BB' : 'AA');
    for (const authorization of [undefined, forged, 'Bearer nope']) {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/characters', headers: authorization ? { authorization } : {} });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String), retryable: false } });
    }
  });

  it('validates nicknames', async () => {
    const res = await server.app.inject({ method: 'POST', url: '/api/v1/sessions/guest', payload: { nickname: 'a b' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    const banned = await server.app.inject({ method: 'POST', url: '/api/v1/sessions/guest', payload: { nickname: 'admin_kim' } });
    expect(banned.json().error.code).toBe('NICKNAME_REJECTED');
  });
});

describe('uploads', () => {
  it('verifies rights, magic bytes and the 512px short side; dedupes by sha256', async () => {
    const { auth } = await guest('uploader');
    const png = makePng(600, 512);

    const noRights = await upload(auth, png, 'false');
    expect(noRights.statusCode).toBe(400);
    expect(noRights.json().error.code).toBe('RIGHTS_NOT_ATTESTED');

    const small = await upload(auth, makePng(600, 300));
    expect(small.statusCode).toBe(400);
    expect(small.json().error).toMatchObject({ code: 'IMAGE_INVALID', details: { reason: 'TOO_SMALL' } });

    const fake = await upload(auth, Buffer.from('GIF89a definitely not a png'));
    expect(fake.json().error).toMatchObject({ code: 'IMAGE_INVALID', details: { reason: 'BAD_TYPE' } });

    const ok = await upload(auth, png);
    expect(ok.statusCode).toBe(201);
    const body = ok.json<UploadResponse>();
    expect(body).toMatchObject({ width: 600, height: 512, status: 'VERIFIED', alreadyExists: false });

    const again = await upload(auth, png);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ uploadId: body.uploadId, alreadyExists: true });
  });
});

describe('generation → worker → manifest', () => {
  it('runs the whole job lifecycle through REST and the internal API', async () => {
    const { auth, userId } = await guest('maker');
    const { uploadId } = (await upload(auth, makePng(512, 768))).json<UploadResponse>();

    const gen = (key: string | null, name = 'Tony') =>
      server.app.inject({
        method: 'POST',
        url: '/api/v1/characters/generate',
        headers: { ...auth, ...(key ? { 'idempotency-key': key } : {}) },
        payload: { uploadId, name },
      });
    expect((await gen(null)).json().error.code).toBe('VALIDATION_FAILED');
    const first = await gen('gen-key-0001');
    expect(first.statusCode).toBe(202);
    const job = first.json<GenerateResponse>();
    const replay = await gen('gen-key-0001');
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(job);
    expect((await gen('gen-key-0001', 'Other')).json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    expect((await server.app.inject({ method: 'GET', url: '/api/v1/config' })).json().workerOnline).toBe(false);
    expect((await server.app.inject({ method: 'POST', url: '/internal/v1/jobs/claim', payload: { workerId: 'w' } })).statusCode).toBe(401);
    const claim = await server.app.inject({ method: 'POST', url: '/internal/v1/jobs/claim', headers: WORKER, payload: { workerId: 'gpu-1' } });
    expect(claim.statusCode).toBe(200);
    const claimed = claim.json<{ job: ClaimedJob }>().job;
    expect(claimed).toMatchObject({ jobId: job.jobId, characterId: job.characterId, name: 'Tony', attempt: 1, resumeStage: 'PREPROCESSING' });
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/config' })).json().workerOnline).toBe(true);

    // 원본 이미지는 /files로 받을 수 있다
    const img = await server.app.inject({ method: 'GET', url: claimed.imageUrl.replace('http://files.test', '') });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');

    const prog = await server.app.inject({ method: 'POST', url: `/internal/v1/jobs/${job.jobId}/progress`, headers: WORKER, payload: { stage: 'RIGGING', progress: 0.5 } });
    expect(prog.statusCode).toBe(200);
    const view = await server.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.jobId}`, headers: auth });
    expect(view.json()).toMatchObject({ status: 'RIGGING', stage: 'RIGGING', progress: 0.725, queuePosition: null });
    const notModified = await server.app.inject({ method: 'GET', url: `/api/v1/jobs/${job.jobId}`, headers: { ...auth, 'if-none-match': view.headers.etag as string } });
    expect(notModified.statusCode).toBe(304);

    const glb = makeGlb();
    const put = await server.app.inject({
      method: 'PUT',
      url: `/internal/v1/jobs/${job.jobId}/artifacts/rigged_rigid.glb`,
      headers: { ...WORKER, 'content-type': 'application/octet-stream' },
      payload: glb,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().url).toBe(`http://files.test/files/jobs/${job.jobId}/rigged_rigid.glb`);
    const badName = await server.app.inject({ method: 'PUT', url: `/internal/v1/jobs/${job.jobId}/artifacts/..`, headers: { ...WORKER, 'content-type': 'application/octet-stream' }, payload: glb });
    expect(badName.statusCode).toBeGreaterThanOrEqual(400);

    const notReady = await server.app.inject({ method: 'GET', url: `/api/v1/characters/${job.characterId}`, headers: auth });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().error.code).toBe('CHARACTER_NOT_READY');

    const done = await server.app.inject({
      method: 'POST',
      url: `/internal/v1/jobs/${job.jobId}/complete`,
      headers: WORKER,
      payload: {
        tier: 'T1', rigger: 'rigid', model: 'triposr', modelVersion: 'test', seed: null,
        glbArtifact: 'rigged_rigid.glb', thumbnailArtifact: null, assetMeta: { tris: 1, bones: 22, glbBytes: glb.length },
      },
    });
    expect(done.statusCode).toBe(200);

    const manifest = (await server.app.inject({ method: 'GET', url: `/api/v1/characters/${job.characterId}`, headers: auth })).json<CharacterManifest>();
    expect(manifest).toMatchObject({ id: job.characterId, ownerId: userId, tier: 'T1', skeleton: 'mba-humanoid-v1', provenance: { rigger: 'rigid' } });
    const file = await server.app.inject({ method: 'GET', url: manifest.glbUrl!.replace('http://files.test', '') });
    expect(file.headers['content-type']).toBe('model/gltf-binary');
    expect(file.rawPayload.equals(glb)).toBe(true);

    // 다른 사용자는 (같은 룸에 있지 않으면) private 매니페스트를 볼 수 없다
    const stranger = await guest('stranger');
    expect((await server.app.inject({ method: 'GET', url: `/api/v1/characters/${job.characterId}`, headers: stranger.auth })).statusCode).toBe(403);

    const list = (await server.app.inject({ method: 'GET', url: '/api/v1/characters', headers: auth })).json();
    expect(list.items).toEqual([expect.objectContaining({ id: job.characterId, status: 'READY', tier: 'T1', jobId: job.jobId, builtin: false })]);

    expect((await server.app.inject({ method: 'POST', url: '/internal/v1/jobs/claim', headers: WORKER, payload: { workerId: 'gpu-1' } })).statusCode).toBe(204);
  });
});

describe('matches and rooms', () => {
  it('stores AI match reports idempotently and lists them', async () => {
    const { auth } = await guest('fighter');
    const report = { difficulty: 'normal', result: 'KO', won: true, durationMs: 42_000, stats: { punches: 30, hits: 17, blocked: 3, dodgesAttempted: 4, dodgesSucceeded: 2 } };
    const post = () => server.app.inject({ method: 'POST', url: '/api/v1/matches', headers: { ...auth, 'idempotency-key': 'match-key-01' }, payload: report });
    const a = await post();
    const b = await post();
    expect(a.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    const mine = (await server.app.inject({ method: 'GET', url: '/api/v1/me/matches', headers: auth })).json();
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ matchId: a.json().matchId, mode: 'ai', result: 'KO', won: true, durationMs: 42_000, opponent: null });
  });

  it('returns ROOM_NOT_FOUND for unknown codes', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/rooms/ABCDEF' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROOM_NOT_FOUND');
  });
});

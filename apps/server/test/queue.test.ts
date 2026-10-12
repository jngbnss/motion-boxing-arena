import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_TOTAL_TIMEOUT_MS } from '@mba/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.ts';
import { HttpError } from '../src/http/errors.ts';
import { JobQueue, overallProgress } from '../src/jobs/queue.ts';
import { FileStorage } from '../src/storage.ts';
import { makeGlb } from './fixtures.ts';

let db: Db;
let dir: string;
let storage: FileStorage;
let t: number;
let queue: JobQueue;

async function seedUpload(userId: string, sha: string): Promise<string> {
  await db.query(`INSERT INTO users (id, nickname) VALUES ($1, 'tester') ON CONFLICT DO NOTHING`, [userId]);
  const id = `upl_${sha.slice(0, 8)}_${userId}`;
  await db.query(
    `INSERT INTO uploads (id, user_id, sha256, content_type, size_bytes, width, height, storage_key, rights_attested, status)
     VALUES ($1, $2, $3, 'image/png', 10, 512, 512, $4, true, 'VERIFIED')`,
    [id, userId, sha.padEnd(64, '0'), `uploads/${userId}/${sha}.png`],
  );
  return id;
}

async function rejects(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected HttpError');
}

// PGlite 기동은 수 초가 걸리므로 파일당 한 번 열고, 테스트마다 테이블을 비운다
beforeAll(async () => {
  db = await openDb();
}, 30_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query(
    'TRUNCATE users, uploads, characters, character_assets, ai_jobs, ai_job_stages, ai_job_artifacts, matches, match_players, idempotency_keys CASCADE',
  );
  dir = mkdtempSync(join(tmpdir(), 'mba-queue-'));
  storage = new FileStorage(dir, 'http://test');
  t = Date.parse('2026-10-12T00:00:00Z');
  queue = new JobQueue(db, storage, { now: () => t, retryBaseMs: 30_000 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('job creation limits', () => {
  it('deduplicates same image+options, enforces 3/day and the 20-job queue cap', async () => {
    const up = await seedUpload('usr_a', 'aaaa');
    const first = await queue.createJob('usr_a', { uploadId: up, name: 'Tony' }, 'key-00001');
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: 'QUEUED', queuePosition: 1, deduplicated: false });

    const dup = await queue.createJob('usr_a', { uploadId: up, name: 'Other' }, 'key-00002');
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ jobId: first.body.jobId, deduplicated: true });

    await queue.createJob('usr_a', { uploadId: up, name: 'T', options: { seed: 1 } }, 'key-00003');
    await queue.createJob('usr_a', { uploadId: up, name: 'T', options: { seed: 2 } }, 'key-00004');
    const limited = await rejects(queue.createJob('usr_a', { uploadId: up, name: 'T', options: { seed: 3 } }, 'key-00005'));
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe(String(24 * 3600));

    // 하루가 지나면 다시 허용
    t += 24 * 3600_000 + 1;
    const again = await queue.createJob('usr_a', { uploadId: up, name: 'T', options: { seed: 3 } }, 'key-00006');
    expect(again.status).toBe(202);

    for (let i = 0; i < 16; i++) {
      const u = await seedUpload(`usr_q${i}`, `b${i}`);
      await queue.createJob(`usr_q${i}`, { uploadId: u, name: 'Q' }, `key-q${i}-0001`);
    }
    const u = await seedUpload('usr_late', 'cccc');
    const full = await rejects(queue.createJob('usr_late', { uploadId: u, name: 'L' }, 'key-late-001'));
    expect(full).toMatchObject({ status: 503, code: 'QUEUE_FULL', retryable: true });
  });

  it('refuses uploads owned by someone else', async () => {
    const up = await seedUpload('usr_owner', 'dddd');
    await db.query(`INSERT INTO users (id, nickname) VALUES ('usr_thief', 'thief')`);
    const err = await rejects(queue.createJob('usr_thief', { uploadId: up, name: 'X' }, 'key-thief-1'));
    expect(err.status).toBe(403);
  });
});

describe('claim / progress / retry / resume (docs/09 §5)', () => {
  it('claims FIFO, computes weighted progress, backs off retryable failures and resumes at the failed stage', async () => {
    const up = await seedUpload('usr_a', 'eeee');
    const { body } = await queue.createJob('usr_a', { uploadId: up, name: 'Tony' }, 'key-claim-1');
    expect(await queue.claim('w2')).toMatchObject({ jobId: body.jobId, attempt: 1, resumeStage: 'PREPROCESSING', artifacts: {} });
    expect(await queue.claim('w2')).toBeNull();

    await queue.progress(body.jobId, 'GENERATING', 0.5);
    let view = await queue.view(body.jobId, 'usr_a');
    expect(view.status).toBe('GENERATING');
    expect(view.progress).toBeCloseTo(0.05 + 0.45 * 0.5);
    expect(view.progress).toBeCloseTo(overallProgress('GENERATING', 0.5));

    await storage.put(`jobs/${body.jobId}/raw.glb`, makeGlb());
    await queue.recordArtifact(body.jobId, 'raw.glb', `jobs/${body.jobId}/raw.glb`, 10, 'GENERATING');
    await queue.progress(body.jobId, 'POSTPROCESSING', 0.1);

    const r = await queue.fail(body.jobId, { stage: 'POSTPROCESSING', code: 'MESH_EMPTY', retryable: true, message: 'empty' });
    expect(r.status).toBe('RETRY_WAIT');
    expect(Date.parse(r.runAfter!)).toBe(t + 30_000);
    view = await queue.view(body.jobId, 'usr_a');
    expect(view).toMatchObject({ status: 'QUEUED', stage: 'POSTPROCESSING', queuePosition: 1, error: null });

    t += 29_000;
    expect(await queue.claim('w2')).toBeNull();
    t += 1_000;
    const resumed = await queue.claim('w2');
    expect(resumed).toMatchObject({ jobId: body.jobId, attempt: 2, resumeStage: 'POSTPROCESSING' });
    expect(resumed!.artifacts).toEqual({ 'raw.glb': `http://test/files/jobs/${body.jobId}/raw.glb` });

    // 자동 재시도는 1회: 두 번째 retryable 실패는 FAILED
    const r2 = await queue.fail(body.jobId, { stage: 'POSTPROCESSING', code: 'MESH_EMPTY', retryable: true, message: 'again' });
    expect(r2.status).toBe('FAILED');
    view = await queue.view(body.jobId, 'usr_a');
    expect(view).toMatchObject({ status: 'FAILED', error: { stage: 'POSTPROCESSING', code: 'MESH_EMPTY', retryable: true } });
    const { rows } = await db.query<{ status: string }>('SELECT status FROM characters WHERE id = $1', [body.characterId]);
    expect(rows[0]!.status).toBe('FAILED');

    // 수동 재시도 2회까지, 실패 단계부터
    for (let i = 0; i < 2; i++) {
      expect((await queue.retry(body.jobId, 'usr_a')).status).toBe('QUEUED');
      expect(await queue.claim('w2')).toMatchObject({ resumeStage: 'POSTPROCESSING' });
      await queue.fail(body.jobId, { stage: 'POSTPROCESSING', code: 'MESH_EMPTY', retryable: true, message: 'x' });
    }
    expect((await rejects(queue.retry(body.jobId, 'usr_a'))).code).toBe('RETRY_LIMIT');
  });

  it('fails non-retryable errors immediately and refuses manual retry', async () => {
    const up = await seedUpload('usr_a', 'ffff');
    const { body } = await queue.createJob('usr_a', { uploadId: up, name: 'Blob' }, 'key-nh-0001');
    await queue.claim('w1');
    const r = await queue.fail(body.jobId, { stage: 'PREPROCESSING', code: 'NOT_HUMANOID', retryable: false, message: 'no' });
    expect(r.status).toBe('FAILED');
    expect((await rejects(queue.retry(body.jobId, 'usr_a'))).code).toBe('NOT_RETRYABLE');
  });

  it('fails stuck stages via sweep (STAGE_TIMEOUT → auto retry once → FAILED)', async () => {
    const up = await seedUpload('usr_a', '1111');
    const { body } = await queue.createJob('usr_a', { uploadId: up, name: 'Slow' }, 'key-slow-001');
    await queue.claim('w1');
    t += 31_000; // PREPROCESSING 상한 30s
    await queue.sweep();
    const v = await db.query<{ status: string; error: { code: string } }>('SELECT status, error FROM ai_jobs WHERE id = $1', [body.jobId]);
    expect(v.rows[0]).toMatchObject({ status: 'RETRY_WAIT', error: { code: 'STAGE_TIMEOUT' } });

    // 재점유 후 워커가 GENERATING에서 멈춤 (상한 5분) → 자동 재시도 소진 → FAILED (사용자 재시도 가능)
    t += 60_000;
    expect(await queue.claim('w1')).toMatchObject({ attempt: 2, resumeStage: 'PREPROCESSING' });
    await queue.progress(body.jobId, 'GENERATING', 0.1);
    t += 5 * 60_000 + 1;
    await queue.sweep();
    const failed = await queue.view(body.jobId, 'usr_a');
    expect(failed).toMatchObject({ status: 'FAILED', error: { stage: 'GENERATING', code: 'STAGE_TIMEOUT', retryable: true } });
  });

  it('fails with JOB_TIMEOUT when processing exceeds 10 minutes in total, without auto retry', async () => {
    const up = await seedUpload('usr_a', '4444');
    const { body } = await queue.createJob('usr_a', { uploadId: up, name: 'Long' }, 'key-long-001');
    t += 3_600_000; // 대기 시간은 전체 10분에 포함하지 않는다
    await queue.claim('w1');
    const steps: Array<[Parameters<JobQueue['progress']>[1], number]> = [
      ['PREPROCESSING', 20_000],
      ['GENERATING', 290_000],
      ['POSTPROCESSING', 110_000],
      ['RIGGING', 110_000],
      ['VALIDATING', 55_000],
    ];
    for (const [stage, ms] of steps) {
      await queue.progress(body.jobId, stage, 0.5);
      t += ms;
      await queue.sweep();
      expect((await queue.view(body.jobId, 'usr_a')).status).toBe(stage);
    }
    await queue.progress(body.jobId, 'EXPORTING', 0.5);
    t += 20_000;
    await queue.sweep();
    expect(JOB_TOTAL_TIMEOUT_MS).toBe(600_000);
    expect(await queue.view(body.jobId, 'usr_a')).toMatchObject({ status: 'FAILED', error: { code: 'JOB_TIMEOUT', stage: 'EXPORTING' } });
  });

  it('completes: copies assets, writes the C5 manifest, marks character READY', async () => {
    const up = await seedUpload('usr_a', '2222');
    const { body } = await queue.createJob('usr_a', { uploadId: up, name: 'Tin Can' }, 'key-done-001');
    await queue.claim('w1');
    await queue.progress(body.jobId, 'EXPORTING', 0.9);
    const glb = makeGlb();
    await storage.put(`jobs/${body.jobId}/final.glb`, glb);
    await queue.recordArtifact(body.jobId, 'final.glb', `jobs/${body.jobId}/final.glb`, glb.length, 'EXPORTING');
    await storage.put(`jobs/${body.jobId}/thumb.png`, Buffer.from('png'));
    await queue.recordArtifact(body.jobId, 'thumb.png', `jobs/${body.jobId}/thumb.png`, 3, 'EXPORTING');

    const manifest = await queue.complete(body.jobId, {
      tier: 'T1',
      rigger: 'rigid',
      model: 'triposr',
      modelVersion: '1.0',
      seed: 7,
      glbArtifact: 'final.glb',
      thumbnailArtifact: 'thumb.png',
      palette: ['#aabbcc'],
      assetMeta: { tris: 1, bones: 22, glbBytes: glb.length },
    });
    expect(manifest).toMatchObject({
      id: body.characterId,
      ownerId: 'usr_a',
      skeleton: 'mba-humanoid-v1',
      tier: 'T1',
      glbUrl: `http://test/files/characters/${body.characterId}/v1/model.glb`,
      thumbnailUrl: `http://test/files/characters/${body.characterId}/v1/thumb.png`,
      skin: { palette: ['#aabbcc'], decals: {} },
      provenance: { model: 'triposr', rigger: 'rigid', seed: 7 },
      license: { userAttestedRights: true, visibility: 'private' },
    });
    expect((await storage.read(`characters/${body.characterId}/v1/model.glb`)).equals(glb)).toBe(true);
    expect(JSON.parse((await storage.read(`characters/${body.characterId}/v1/character.json`)).toString())).toEqual(manifest);
    expect(await queue.view(body.jobId, 'usr_a')).toMatchObject({ status: 'READY', progress: 1 });

    // 끝난 작업에 대한 보고는 409
    expect((await rejects(queue.progress(body.jobId, 'EXPORTING', 1))).status).toBe(409);
  });

  it('rejects a complete whose GLB artifact is not glTF 2.0', async () => {
    const up = await seedUpload('usr_a', '3333');
    const { body } = await queue.createJob('usr_a', { uploadId: up, name: 'Bad' }, 'key-bad-0001');
    await queue.claim('w1');
    await storage.put(`jobs/${body.jobId}/x.glb`, Buffer.from('not a glb at all, sorry'));
    await queue.recordArtifact(body.jobId, 'x.glb', `jobs/${body.jobId}/x.glb`, 22, 'EXPORTING');
    const err = await rejects(
      queue.complete(body.jobId, {
        tier: 'T1', rigger: 'rigid', model: 'm', modelVersion: '1', seed: null, glbArtifact: 'x.glb', thumbnailArtifact: null,
        assetMeta: { tris: 1, bones: 22, glbBytes: 22 },
      }),
    );
    expect(err.code).toBe('GLB_INVALID');
  });
});

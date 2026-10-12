// 내부 워커 API `/internal/v1` (헤더 X-Worker-Secret). contracts.md "Internal worker API"
import { JobCompleteSchema, JobFailSchema, JobProgressSchema } from '@mba/shared';
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { secretEquals } from '../auth.ts';
import { SizeLimitError } from '../storage.ts';
import type { AppContext } from './context.ts';
import { HttpError, parseOr400 } from './errors.ts';

export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

const WorkerBody = z.object({ workerId: z.string().min(1).max(128) });
const JobParam = z.object({ id: z.string().min(1).max(64) });
const ArtifactParam = z.object({
  id: z.string().min(1).max(64),
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(128).refine((n) => n !== '.' && n !== '..', 'invalid name'),
});

export async function internalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // 산출물 PUT: 본문을 파싱하지 않고 스트림 그대로 받는다 (크기 제한은 저장 시)
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.addHook('onRequest', async (req) => {
    if (!secretEquals(ctx.config.workerSecret, req.headers['x-worker-secret'])) {
      throw new HttpError(401, 'UNAUTHORIZED', 'invalid worker secret');
    }
  });

  app.post('/heartbeat', async (req) => {
    const { workerId } = parseOr400(WorkerBody, req.body);
    ctx.queue.heartbeat(workerId);
    return { ok: true };
  });

  app.post('/jobs/claim', async (req, reply) => {
    const { workerId } = parseOr400(WorkerBody, req.body);
    const job = await ctx.queue.claim(workerId);
    if (!job) return reply.code(204).send();
    return { job };
  });

  app.post('/jobs/:id/progress', async (req) => {
    const { id } = parseOr400(JobParam, req.params);
    const body = parseOr400(JobProgressSchema, req.body);
    await ctx.queue.progress(id, body.stage, body.progress);
    return { ok: true };
  });

  app.put('/jobs/:id/artifacts/:name', { bodyLimit: MAX_ARTIFACT_BYTES }, async (req) => {
    const { id, name } = parseOr400(ArtifactParam, req.params);
    const stage = await ctx.queue.assertRunning(id);
    const key = `jobs/${id}/${name}`;
    const body = req.body;
    let size: number;
    try {
      if (Buffer.isBuffer(body)) {
        if (body.length > MAX_ARTIFACT_BYTES) throw new SizeLimitError(MAX_ARTIFACT_BYTES);
        await ctx.storage.put(key, body);
        size = body.length;
      } else if (body instanceof Readable) {
        size = await ctx.storage.putStream(key, body, MAX_ARTIFACT_BYTES);
      } else {
        throw new HttpError(400, 'VALIDATION_FAILED', 'raw body required (application/octet-stream)');
      }
    } catch (err) {
      if (err instanceof SizeLimitError) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
      throw err;
    }
    await ctx.queue.recordArtifact(id, name, key, size, stage);
    return { url: ctx.storage.urlOf(key) };
  });

  app.post('/jobs/:id/complete', async (req) => {
    const { id } = parseOr400(JobParam, req.params);
    const body = parseOr400(JobCompleteSchema, req.body);
    const manifest = await ctx.queue.complete(id, body);
    return { ok: true, characterId: manifest.id, manifest };
  });

  app.post('/jobs/:id/fail', async (req) => {
    const { id } = parseOr400(JobParam, req.params);
    const body = parseOr400(JobFailSchema, req.body);
    const r = await ctx.queue.fail(id, body);
    return { ok: true, ...r };
  });
}

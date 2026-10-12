// AI 생성 작업 큐 (C9, C13, docs/09 §5). Postgres 테이블 + FOR UPDATE SKIP LOCKED. 시각은 주입한 now()로 계산한다.
import {
  JOB_AUTO_RETRIES,
  JOB_MANUAL_RETRIES,
  JOB_STAGES,
  JOB_TOTAL_TIMEOUT_MS,
  SKELETON_ID,
  STAGE_TIMEOUT_MS,
  type CharacterManifest,
  type ClaimedJob,
  type GenerateRequest,
  type GenerateResponse,
  type JobComplete,
  type JobError,
  type JobFail,
  type JobStage,
  type JobView,
} from '@mba/shared';
import type { Db, Queryable } from '../db/index.ts';
import { HttpError, forbidden, notFound } from '../http/errors.ts';
import { newId } from '../ids.ts';
import { isValidGlb } from '../image.ts';
import type { FileStorage } from '../storage.ts';

export type WorkStage = Exclude<JobStage, 'QUEUED' | 'READY'>;
export const WORK_STAGES = JOB_STAGES.filter((s): s is WorkStage => s !== 'QUEUED' && s !== 'READY');

/** 전체 진행률 단계 가중치 (docs/09 §5) */
export const STAGE_WEIGHTS: Record<WorkStage, number> = {
  PREPROCESSING: 0.05,
  GENERATING: 0.45,
  POSTPROCESSING: 0.1,
  RIGGING: 0.25,
  VALIDATING: 0.1,
  EXPORTING: 0.05,
};

/** 단계 시작 전까지 누적 가중치 + 단계 내 진행 */
export function overallProgress(stage: JobStage, inStage: number): number {
  if (stage === 'QUEUED') return 0;
  if (stage === 'READY') return 1;
  let base = 0;
  for (const s of WORK_STAGES) {
    if (s === stage) break;
    base += STAGE_WEIGHTS[s];
  }
  return Math.min(1, base + STAGE_WEIGHTS[stage] * Math.min(1, Math.max(0, inStage)));
}

export const MAX_QUEUED = 20;
export const DAILY_GENERATIONS = 3;
const DAY_MS = 24 * 60 * 60_000;
/** 대기열 1칸당 예상 소요 (C13 p50 목표 2분) */
const ESTIMATE_PER_JOB_S = 120;

type DbStatus = JobStage | 'FAILED' | 'RETRY_WAIT';

interface JobRow {
  id: string;
  user_id: string;
  upload_id: string;
  character_id: string;
  status: DbStatus;
  current_stage: WorkStage | null;
  stage_started_at: Date | string | null;
  progress: number;
  options: { preferTier?: 'T2' | 'T1' | 'T0'; seed?: number };
  attempts_total: number;
  auto_retries: number;
  manual_retries: number;
  processing_ms: number;
  run_after: Date | string;
  locked_by: string | null;
  locked_at: Date | string | null;
  claimed_at: Date | string | null;
  error: JobError | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CharacterRow {
  id: string;
  owner_id: string | null;
  name: string;
  status: 'GENERATING' | 'READY' | 'FAILED';
  tier: 'T0' | 'T1' | 'T2' | null;
  manifest_version: number;
  skin: CharacterManifest['skin'] | null;
  provenance: (CharacterManifest['provenance'] & Record<string, unknown>) | null;
  builtin: boolean;
  /** 최종 썸네일 키 (characters/{id}/v{n}/thumb.*) */
  thumbnail_key: string | null;
  created_at: Date | string;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
const iso = (t: number): string => new Date(t).toISOString();
const isWorkStage = (s: string | null): s is WorkStage => s !== null && (WORK_STAGES as readonly string[]).includes(s);

export interface JobQueueOptions {
  now?: () => number;
  /** 자동 재시도 백오프 기준(ms). run_after = now + base × 2^(attempt-1) */
  retryBaseMs?: number;
}

export interface CreateJobResult {
  status: 200 | 202;
  body: GenerateResponse;
}

export class JobQueue {
  private readonly db: Db;
  private readonly storage: FileStorage;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  /** workerId → 마지막 claim/heartbeat 시각 */
  private readonly workers = new Map<string, number>();

  constructor(db: Db, storage: FileStorage, opts: JobQueueOptions = {}) {
    this.db = db;
    this.storage = storage;
    this.now = opts.now ?? Date.now;
    this.retryBaseMs = opts.retryBaseMs ?? 30_000;
  }

  // ── 워커 생존 ────────────────────────────────────────────────────────────

  heartbeat(workerId: string): void {
    this.workers.set(workerId, this.now());
  }

  /** 최근 30초 안에 claim/heartbeat한 워커가 있는가 (/config workerOnline) */
  workerOnline(windowMs = 30_000): boolean {
    const t = this.now();
    for (const [id, seen] of this.workers) {
      if (t - seen <= windowMs) return true;
      this.workers.delete(id);
    }
    return false;
  }

  // ── 생성 요청 (POST /characters/generate) ─────────────────────────────────

  async createJob(userId: string, req: GenerateRequest, idempotencyKey: string): Promise<CreateJobResult> {
    const t = this.now();
    const options = { ...(req.options?.preferTier ? { preferTier: req.options.preferTier } : {}), ...(req.options?.seed !== undefined ? { seed: req.options.seed } : {}) };

    const { rows: uploads } = await this.db.query<{ id: string; user_id: string; status: string; sha256: string }>(
      'SELECT id, user_id, status, sha256 FROM uploads WHERE id = $1',
      [req.uploadId],
    );
    const upload = uploads[0];
    if (!upload) throw notFound('upload');
    if (upload.user_id !== userId) throw forbidden();
    if (upload.status !== 'VERIFIED') throw new HttpError(409, 'UPLOAD_NOT_VERIFIED', '검증되지 않은 업로드입니다');

    // 같은 사용자 + 같은 이미지 + 같은 옵션으로 진행 중/완료된 작업이 있으면 그것을 돌려준다
    const { rows: dup } = await this.db.query<JobRow>(
      `SELECT j.* FROM ai_jobs j JOIN uploads u ON u.id = j.upload_id
       WHERE j.user_id = $1 AND u.sha256 = $2 AND j.options = $3::jsonb AND j.status <> 'FAILED'
       ORDER BY j.created_at DESC LIMIT 1`,
      [userId, upload.sha256, JSON.stringify(options)],
    );
    if (dup[0]) return { status: 200, body: await this.generateResponse(dup[0], true) };

    const { rows: recent } = await this.db.query<{ created_at: Date | string }>(
      'SELECT created_at FROM ai_jobs WHERE user_id = $1 AND created_at > $2::timestamptz ORDER BY created_at ASC',
      [userId, iso(t - DAY_MS)],
    );
    if (recent.length >= DAILY_GENERATIONS) {
      const retryAfterS = Math.max(1, Math.ceil((ms(recent[0]!.created_at) + DAY_MS - t) / 1000));
      throw new HttpError(429, 'RATE_LIMITED', `하루 ${DAILY_GENERATIONS}회 생성 한도를 넘었습니다`, {
        retryable: true,
        headers: { 'retry-after': String(retryAfterS) },
        details: { limit: DAILY_GENERATIONS },
      });
    }

    const { rows: queued } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_jobs WHERE status IN ('QUEUED', 'RETRY_WAIT')`,
    );
    if ((queued[0]?.n ?? 0) >= MAX_QUEUED) {
      throw new HttpError(503, 'QUEUE_FULL', '생성 대기열이 가득 찼습니다. T0 스킨으로 진행하세요', { retryable: true });
    }

    const jobId = newId('job', t);
    const characterId = newId('chr', t);
    try {
      await this.db.tx(async (q) => {
        await q.query(
          `INSERT INTO characters (id, owner_id, name, status, created_at) VALUES ($1, $2, $3, 'GENERATING', $4::timestamptz)`,
          [characterId, userId, req.name, iso(t)],
        );
        await q.query(
          `INSERT INTO ai_jobs (id, user_id, upload_id, character_id, status, options, idempotency_key, run_after, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'QUEUED', $5::jsonb, $6, $7::timestamptz, $7::timestamptz, $7::timestamptz)`,
          [jobId, userId, upload.id, characterId, JSON.stringify(options), idempotencyKey, iso(t)],
        );
      });
    } catch (err) {
      // 같은 Idempotency-Key 동시 요청: 먼저 들어간 작업을 돌려준다
      if (err instanceof Error && 'code' in err && err.code === '23505') {
        const { rows } = await this.db.query<JobRow>('SELECT * FROM ai_jobs WHERE user_id = $1 AND idempotency_key = $2', [userId, idempotencyKey]);
        if (rows[0]) return { status: 200, body: await this.generateResponse(rows[0], true) };
      }
      throw err;
    }
    const job = await this.getRow(this.db, jobId);
    return { status: 202, body: await this.generateResponse(job!, false) };
  }

  private async generateResponse(job: JobRow, deduplicated: boolean): Promise<GenerateResponse> {
    const view = await this.toView(job);
    const position = view.queuePosition ?? 0;
    return {
      jobId: job.id,
      characterId: job.character_id,
      status: view.status,
      queuePosition: position,
      estimatedSeconds: job.status === 'READY' ? 0 : (position + 1) * ESTIMATE_PER_JOB_S,
      deduplicated,
    };
  }

  // ── 조회 ─────────────────────────────────────────────────────────────────

  private async getRow(q: Queryable, jobId: string, forUpdate = false): Promise<JobRow | undefined> {
    const { rows } = await q.query<JobRow>(`SELECT * FROM ai_jobs WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [jobId]);
    return rows[0];
  }

  /** 대기 중이면 1부터의 순번, 아니면 null */
  private async queuePosition(job: JobRow): Promise<number | null> {
    if (job.status !== 'QUEUED' && job.status !== 'RETRY_WAIT') return null;
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_jobs WHERE status IN ('QUEUED', 'RETRY_WAIT') AND (created_at, id) < ($1::timestamptz, $2)`,
      [iso(ms(job.created_at)), job.id],
    );
    return (rows[0]?.n ?? 0) + 1;
  }

  private async toView(job: JobRow): Promise<JobView> {
    // RETRY_WAIT는 클라이언트에는 "대기 중(QUEUED)"으로, stage는 재시작 단계로 보인다
    const status = job.status === 'RETRY_WAIT' ? 'QUEUED' : job.status;
    const stage: JobStage =
      job.status === 'FAILED' || job.status === 'RETRY_WAIT' ? (job.current_stage ?? 'QUEUED') : job.status;
    return {
      jobId: job.id,
      status,
      stage,
      progress: job.status === 'READY' ? 1 : Number(job.progress),
      queuePosition: await this.queuePosition(job),
      characterId: job.character_id,
      error: job.status === 'FAILED' ? job.error : null,
      updatedAt: new Date(ms(job.updated_at)).toISOString(),
    };
  }

  /** GET /jobs/:id — 소유자만 */
  async view(jobId: string, userId: string): Promise<JobView> {
    const job = await this.getRow(this.db, jobId);
    if (!job) throw notFound('job');
    if (job.user_id !== userId) throw forbidden();
    return this.toView(job);
  }

  // ── 워커 API ────────────────────────────────────────────────────────────

  /** 다음 작업 하나를 점유한다. 없으면 null. 호출 자체가 하트비트다 */
  async claim(workerId: string): Promise<ClaimedJob | null> {
    this.heartbeat(workerId);
    await this.sweep();
    const t = this.now();
    const claimed = await this.db.tx(async (q) => {
      const { rows } = await q.query<JobRow>(
        `WITH next AS (
           SELECT id FROM ai_jobs
           WHERE status IN ('QUEUED', 'RETRY_WAIT') AND run_after <= $2::timestamptz
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE ai_jobs j
         SET status = COALESCE(j.current_stage, 'PREPROCESSING'),
             current_stage = COALESCE(j.current_stage, 'PREPROCESSING'),
             stage_started_at = $2::timestamptz,
             locked_by = $1, locked_at = $2::timestamptz, claimed_at = $2::timestamptz,
             attempts_total = j.attempts_total + 1,
             updated_at = $2::timestamptz
         FROM next WHERE j.id = next.id
         RETURNING j.*`,
        [workerId, iso(t)],
      );
      const job = rows[0];
      if (!job) return null;
      const stage = job.current_stage as WorkStage;
      await q.query(
        `UPDATE ai_jobs SET progress = $2 WHERE id = $1`,
        [job.id, overallProgress(stage, 0)],
      );
      await q.query(
        `INSERT INTO ai_job_stages (job_id, stage, attempt, status, started_at) VALUES ($1, $2, $3, 'RUNNING', $4::timestamptz)`,
        [job.id, stage, job.attempts_total, iso(t)],
      );
      return job;
    });
    if (!claimed) return null;

    const { rows: meta } = await this.db.query<{ storage_key: string; name: string }>(
      `SELECT u.storage_key, c.name FROM uploads u, characters c WHERE u.id = $1 AND c.id = $2`,
      [claimed.upload_id, claimed.character_id],
    );
    const { rows: arts } = await this.db.query<{ name: string; storage_key: string }>(
      'SELECT name, storage_key FROM ai_job_artifacts WHERE job_id = $1 ORDER BY name',
      [claimed.id],
    );
    return {
      jobId: claimed.id,
      characterId: claimed.character_id,
      name: meta[0]!.name,
      attempt: claimed.attempts_total,
      resumeStage: claimed.current_stage as WorkStage,
      imageUrl: this.storage.urlOf(meta[0]!.storage_key),
      options: claimed.options,
      artifacts: Object.fromEntries(arts.map((a) => [a.name, this.storage.urlOf(a.storage_key)])),
    };
  }

  /** 진행 중(점유된) 작업을 잠그고 가져온다. 아니면 404/409 */
  private async lockRunning(q: Queryable, jobId: string): Promise<JobRow & { status: WorkStage }> {
    const job = await this.getRow(q, jobId, true);
    if (!job) throw notFound('job');
    if (!isWorkStage(job.status)) {
      throw new HttpError(409, 'JOB_NOT_RUNNING', `job is ${job.status}`, { details: { status: job.status } });
    }
    return job as JobRow & { status: WorkStage };
  }

  async progress(jobId: string, stage: JobStage, inStage: number): Promise<void> {
    if (!isWorkStage(stage)) throw new HttpError(400, 'VALIDATION_FAILED', `stage ${stage} is not a work stage`);
    const t = this.now();
    await this.db.tx(async (q) => {
      const job = await this.lockRunning(q, jobId);
      if (job.locked_by) this.heartbeat(job.locked_by);
      if (stage !== job.status) {
        await q.query(
          `UPDATE ai_job_stages SET status = 'OK', ended_at = $2::timestamptz WHERE job_id = $1 AND status = 'RUNNING'`,
          [jobId, iso(t)],
        );
        await q.query(
          `INSERT INTO ai_job_stages (job_id, stage, attempt, status, started_at) VALUES ($1, $2, $3, 'RUNNING', $4::timestamptz)`,
          [jobId, stage, job.attempts_total, iso(t)],
        );
      }
      await q.query(
        `UPDATE ai_jobs SET status = $2, current_stage = $2,
           stage_started_at = CASE WHEN status = $2 THEN stage_started_at ELSE $4::timestamptz END,
           progress = $3, locked_at = $4::timestamptz, updated_at = $4::timestamptz
         WHERE id = $1`,
        [jobId, stage, overallProgress(stage, inStage), iso(t)],
      );
    });
  }

  /** 산출물 PUT 전 검사: 작업이 진행 중이어야 한다 */
  async assertRunning(jobId: string): Promise<WorkStage> {
    const job = await this.getRow(this.db, jobId);
    if (!job) throw notFound('job');
    if (!isWorkStage(job.status)) throw new HttpError(409, 'JOB_NOT_RUNNING', `job is ${job.status}`);
    return job.status;
  }

  async recordArtifact(jobId: string, name: string, storageKey: string, sizeBytes: number, stage: WorkStage): Promise<void> {
    const t = this.now();
    await this.db.query(
      `INSERT INTO ai_job_artifacts (job_id, name, storage_key, size_bytes, stage, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       ON CONFLICT (job_id, name) DO UPDATE SET storage_key = EXCLUDED.storage_key, size_bytes = EXCLUDED.size_bytes,
         stage = EXCLUDED.stage, created_at = EXCLUDED.created_at`,
      [jobId, name, storageKey, sizeBytes, stage, iso(t)],
    );
    await this.db.query(
      `UPDATE ai_job_stages SET output_key = $2 WHERE id = (
         SELECT id FROM ai_job_stages WHERE job_id = $1 AND status = 'RUNNING' ORDER BY started_at DESC LIMIT 1)`,
      [jobId, storageKey],
    );
    await this.db.query(`UPDATE ai_jobs SET locked_at = $2::timestamptz WHERE id = $1`, [jobId, iso(t)]);
  }

  /** 완료: 최종 에셋을 characters/{id}/v1/로 복사하고 매니페스트를 쓴다 */
  async complete(jobId: string, body: JobComplete): Promise<CharacterManifest> {
    const t = this.now();
    const job = await this.getRow(this.db, jobId);
    if (!job) throw notFound('job');
    if (!isWorkStage(job.status)) throw new HttpError(409, 'JOB_NOT_RUNNING', `job is ${job.status}`);

    const artifact = async (name: string) => {
      const { rows } = await this.db.query<{ storage_key: string }>(
        'SELECT storage_key FROM ai_job_artifacts WHERE job_id = $1 AND name = $2',
        [jobId, name],
      );
      if (!rows[0]) throw new HttpError(400, 'ARTIFACT_MISSING', `artifact "${name}" was not uploaded`);
      return rows[0].storage_key;
    };
    const glbKey = await artifact(body.glbArtifact);
    const glb = await this.storage.read(glbKey);
    if (!isValidGlb(glb)) throw new HttpError(400, 'GLB_INVALID', 'glbArtifact is not a valid glTF 2.0 binary');
    const thumbKey = body.thumbnailArtifact ? await artifact(body.thumbnailArtifact) : null;

    const { rows: chars } = await this.db.query<CharacterRow>('SELECT * FROM characters WHERE id = $1', [job.character_id]);
    const { rows: ups } = await this.db.query<{ sha256: string }>('SELECT sha256 FROM uploads WHERE id = $1', [job.upload_id]);
    const character = chars[0]!;
    const version = 1;
    const dir = `characters/${character.id}/v${version}`;
    const modelKey = `${dir}/model.glb`;
    const thumbExt = thumbKey ? (/\.(png|webp|jpe?g)$/i.exec(thumbKey)?.[1]?.toLowerCase() ?? 'png') : null;
    const finalThumbKey = thumbKey ? `${dir}/thumb.${thumbExt}` : null;
    await this.storage.copy(glbKey, modelKey);
    if (thumbKey && finalThumbKey) await this.storage.copy(thumbKey, finalThumbKey);

    const provenance = {
      model: body.model,
      modelVersion: body.modelVersion,
      seed: body.seed,
      rigger: body.rigger,
      createdAt: iso(t),
      sourceUploadSha256: ups[0]?.sha256 ?? null,
      assetMeta: body.assetMeta,
    };
    const skin = body.palette ? { palette: body.palette, decals: {} } : null;
    const updated: CharacterRow = {
      ...character,
      status: 'READY',
      tier: body.tier,
      manifest_version: version,
      provenance,
      skin,
      thumbnail_key: finalThumbKey,
    };
    const manifest = buildManifest(updated, this.storage);
    await this.storage.put(`${dir}/character.json`, JSON.stringify(manifest, null, 2));

    await this.db.tx(async (q) => {
      // 경합 방지: 같은 작업이 이미 끝났으면 중단
      await this.lockRunning(q, jobId);
      await q.query(
        `UPDATE characters SET status = 'READY', tier = $2, manifest_version = $3, provenance = $4::jsonb, skin = $5::jsonb, thumbnail_key = $6
         WHERE id = $1`,
        [character.id, body.tier, version, JSON.stringify(provenance), skin ? JSON.stringify(skin) : null, finalThumbKey],
      );
      await q.query('DELETE FROM character_assets WHERE character_id = $1', [character.id]);
      await q.query(
        `INSERT INTO character_assets (id, character_id, kind, storage_key, size_bytes, meta) VALUES ($1, $2, 'glb', $3, $4, $5::jsonb)`,
        [newId('ast', t), character.id, modelKey, glb.length, JSON.stringify(body.assetMeta)],
      );
      if (finalThumbKey) {
        const size = (await this.storage.size(finalThumbKey)) ?? 0;
        await q.query(
          `INSERT INTO character_assets (id, character_id, kind, storage_key, size_bytes) VALUES ($1, $2, 'thumbnail', $3, $4)`,
          [newId('ast', t), character.id, finalThumbKey, size],
        );
      }
      await q.query(
        `UPDATE ai_job_stages SET status = 'OK', ended_at = $2::timestamptz WHERE job_id = $1 AND status = 'RUNNING'`,
        [jobId, iso(t)],
      );
      await q.query(
        `UPDATE ai_jobs SET status = 'READY', progress = 1, error = NULL, locked_by = NULL, locked_at = NULL,
           processing_ms = $3, finished_at = $2::timestamptz, updated_at = $2::timestamptz
         WHERE id = $1`,
        [jobId, iso(t), job.processing_ms + (job.claimed_at ? Math.max(0, t - ms(job.claimed_at)) : 0)],
      );
    });
    return manifest;
  }

  /** 워커 실패 보고 */
  async fail(jobId: string, body: JobFail): Promise<{ status: 'RETRY_WAIT' | 'FAILED'; runAfter: string | null }> {
    return this.db.tx(async (q) => {
      const job = await this.lockRunning(q, jobId);
      const stage = isWorkStage(body.stage) ? body.stage : job.status;
      return this.applyFailure(q, job, { stage, code: body.code, retryable: body.retryable, message: body.message }, true);
    });
  }

  /**
   * 실패 처리 공통. retryable이고 자동 재시도가 남았으면 RETRY_WAIT(백오프), 아니면 FAILED.
   * allowAuto=false면 자동 재시도 없이 FAILED (전체 타임아웃).
   */
  private async applyFailure(
    q: Queryable,
    job: JobRow,
    error: JobError & { stage: WorkStage },
    allowAuto: boolean,
  ): Promise<{ status: 'RETRY_WAIT' | 'FAILED'; runAfter: string | null }> {
    const t = this.now();
    const spentMs = job.claimed_at ? Math.max(0, t - ms(job.claimed_at)) : 0;
    const processingMs = job.processing_ms + spentMs;
    await q.query(
      `UPDATE ai_job_stages SET status = 'FAILED', ended_at = $2::timestamptz, error = $3::jsonb WHERE job_id = $1 AND status = 'RUNNING'`,
      [job.id, iso(t), JSON.stringify(error)],
    );
    const auto = allowAuto && error.retryable && job.auto_retries < JOB_AUTO_RETRIES && processingMs < JOB_TOTAL_TIMEOUT_MS;
    if (auto) {
      const runAfter = t + this.retryBaseMs * 2 ** Math.max(0, job.attempts_total - 1);
      await q.query(
        `UPDATE ai_jobs SET status = 'RETRY_WAIT', current_stage = $2, auto_retries = auto_retries + 1, run_after = $3::timestamptz,
           locked_by = NULL, locked_at = NULL, processing_ms = $4, error = $5::jsonb, updated_at = $6::timestamptz
         WHERE id = $1`,
        [job.id, error.stage, iso(runAfter), processingMs, JSON.stringify(error), iso(t)],
      );
      return { status: 'RETRY_WAIT', runAfter: iso(runAfter) };
    }
    await q.query(
      `UPDATE ai_jobs SET status = 'FAILED', current_stage = $2, locked_by = NULL, locked_at = NULL, processing_ms = $3,
         error = $4::jsonb, finished_at = $5::timestamptz, updated_at = $5::timestamptz
       WHERE id = $1`,
      [job.id, error.stage, processingMs, JSON.stringify(error), iso(t)],
    );
    await q.query(`UPDATE characters SET status = 'FAILED' WHERE id = $1`, [job.character_id]);
    return { status: 'FAILED', runAfter: null };
  }

  /**
   * 주기 점검 (C13): 단계 타임아웃 → retryable 실패(자동 재시도 규칙), 처리 누적 10분 초과 → FAILED.
   * 워커가 죽은 작업(좀비)도 여기서 회수된다: 단계 상한(≤5분)이 docs/09의 10분 좀비 기준보다 먼저 걸린다.
   * claim 때와 주기 타이머에서 호출한다.
   */
  async sweep(): Promise<void> {
    const t = this.now();
    const { rows } = await this.db.query<JobRow>(
      `SELECT id FROM ai_jobs WHERE status IN (${WORK_STAGES.map((s) => `'${s}'`).join(', ')})`,
    );
    for (const { id } of rows) {
      await this.db.tx(async (q) => {
        const job = await this.getRow(q, id, true);
        if (!job || !isWorkStage(job.status)) return;
        const stage = job.status;
        const total = job.processing_ms + (job.claimed_at ? t - ms(job.claimed_at) : 0);
        if (total > JOB_TOTAL_TIMEOUT_MS) {
          await this.applyFailure(q, job, { stage, code: 'JOB_TIMEOUT', retryable: true, message: '전체 처리 시간 10분을 넘었습니다' }, false);
          return;
        }
        const stageLimit = STAGE_TIMEOUT_MS[stage];
        if (stageLimit !== undefined && job.stage_started_at && t - ms(job.stage_started_at) > stageLimit) {
          await this.applyFailure(q, job, { stage, code: 'STAGE_TIMEOUT', retryable: true, message: `${stage} 단계가 ${stageLimit / 1000}s를 넘었습니다` }, true);
        }
      });
    }
  }

  /** 사용자 수동 재시도: 실패 단계부터 다시 대기열에 (작업당 2회) */
  async retry(jobId: string, userId: string): Promise<JobView> {
    const t = this.now();
    await this.db.tx(async (q) => {
      const job = await this.getRow(q, jobId, true);
      if (!job) throw notFound('job');
      if (job.user_id !== userId) throw forbidden();
      if (job.status !== 'FAILED') throw new HttpError(409, 'CONFLICT', `job is ${job.status}, only FAILED jobs can be retried`);
      if (job.error && !job.error.retryable) throw new HttpError(409, 'NOT_RETRYABLE', `${job.error.code} 오류는 재시도할 수 없습니다`);
      if (job.manual_retries >= JOB_MANUAL_RETRIES) {
        throw new HttpError(409, 'RETRY_LIMIT', `수동 재시도는 작업당 ${JOB_MANUAL_RETRIES}회까지입니다`);
      }
      await q.query(
        `UPDATE ai_jobs SET status = 'QUEUED', manual_retries = manual_retries + 1, processing_ms = 0, run_after = $2::timestamptz,
           error = NULL, finished_at = NULL, updated_at = $2::timestamptz
         WHERE id = $1`,
        [jobId, iso(t)],
      );
      await q.query(`UPDATE characters SET status = 'GENERATING' WHERE id = $1`, [job.character_id]);
    });
    return this.view(jobId, userId);
  }
}

/** characters 행 → C5 매니페스트 (URL은 현재 PUBLIC_BASE_URL 기준) */
export function buildManifest(row: CharacterRow, storage: FileStorage): CharacterManifest {
  const dir = `characters/${row.id}/v${row.manifest_version}`;
  const prov = row.provenance;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    skeleton: SKELETON_ID,
    tier: row.tier ?? 'T0',
    glbUrl: row.tier === 'T1' || row.tier === 'T2' ? storage.urlOf(`${dir}/model.glb`) : null,
    thumbnailUrl: row.thumbnail_key ? storage.urlOf(row.thumbnail_key) : null,
    ...(row.skin ? { skin: row.skin } : {}),
    scale: 1,
    provenance: {
      model: prov?.model ?? 'none',
      modelVersion: prov?.modelVersion ?? 'none',
      seed: prov?.seed ?? null,
      rigger: prov?.rigger ?? 'none',
      createdAt: prov?.createdAt ?? new Date(ms(row.created_at)).toISOString(),
    },
    license: { userAttestedRights: true, visibility: 'private' },
    builtin: row.builtin,
  };
}

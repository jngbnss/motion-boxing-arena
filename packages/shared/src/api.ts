// C9. AI 생성 작업 상태 + REST 공통 타입. 상세: docs/08-API-DESIGN.md, docs/09-DATA-MODEL.md
import { z } from 'zod';

export const JOB_STAGES = [
  'QUEUED', 'PREPROCESSING', 'GENERATING', 'POSTPROCESSING',
  'RIGGING', 'VALIDATING', 'EXPORTING', 'READY',
] as const;
export type JobStage = (typeof JOB_STAGES)[number];
export type JobStatus = JobStage | 'FAILED';

/** C13: 단계별 타임아웃(ms). QUEUED 대기는 전체 타임아웃에 포함하지 않는다 */
export const STAGE_TIMEOUT_MS: Partial<Record<JobStage, number>> = {
  PREPROCESSING: 30_000,
  GENERATING: 5 * 60_000,
  POSTPROCESSING: 2 * 60_000,
  RIGGING: 2 * 60_000,
  VALIDATING: 60_000,
  EXPORTING: 60_000,
};
export const JOB_TOTAL_TIMEOUT_MS = 10 * 60_000;
export const JOB_AUTO_RETRIES = 1;
export const JOB_MANUAL_RETRIES = 2;

export interface JobError {
  stage: JobStage;
  code: string;
  retryable: boolean;
  message: string;
}

export interface JobView {
  jobId: string;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  queuePosition: number | null;
  characterId: string | null;
  error: JobError | null;
  updatedAt: string;
}

export interface ApiError {
  error: { code: string; message: string; retryable: boolean };
}

export const UPLOAD_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  minShortSidePx: 512,
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
} as const;

// ── REST 요청·응답 (docs/08-API-DESIGN.md §2). Base: `${API_BASE}/api/v1` ──────────────────

export const API_PREFIX = '/api/v1';

export const NicknameSchema = z.string().regex(/^[0-9A-Za-z_가-힣]{2,16}$/);

export const GuestSessionRequestSchema = z.object({ nickname: NicknameSchema });
export interface GuestSessionResponse { userId: string; token: string; expiresAt: string }

/** `POST /uploads` multipart/form-data: 필드 `file`(이미지), `rightsAttested`("true") */
export interface UploadResponse { uploadId: string; width: number; height: number; sha256: string; status: 'VERIFIED'; alreadyExists: boolean }

export const GenerateRequestSchema = z.object({
  uploadId: z.string().min(1),
  name: z.string().min(1).max(20),
  options: z.object({ preferTier: z.enum(['T2', 'T1', 'T0']).optional(), seed: z.number().int().nonnegative().optional() }).optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export interface GenerateResponse { jobId: string; characterId: string; status: JobStatus; queuePosition: number; estimatedSeconds: number; deduplicated: boolean }

export type CharacterStatus = 'GENERATING' | 'READY' | 'FAILED';
export interface CharacterSummary { id: string; name: string; tier: 'T0' | 'T1' | 'T2' | null; thumbnailUrl: string | null; status: CharacterStatus; builtin: boolean; jobId: string | null }
export interface CharacterListResponse { items: CharacterSummary[]; nextCursor: string | null }

export const MatchReportSchema = z.object({
  difficulty: z.enum(['easy', 'normal', 'hard']),
  result: z.enum(['KO', 'TIME_UP', 'FORFEIT', 'ABANDONED']),
  won: z.boolean().nullable(),
  durationMs: z.number().int().nonnegative().max(10 * 60_000),
  stats: z.object({
    punches: z.number().int().nonnegative(), hits: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(),
    dodgesAttempted: z.number().int().nonnegative(), dodgesSucceeded: z.number().int().nonnegative(),
  }),
});
export type MatchReport = z.infer<typeof MatchReportSchema>;

export interface RoomLookupResponse { roomId: string; playerCount: number }

export interface RuntimeConfig { features: { online: boolean; generation: boolean }; workerOnline: boolean }

// ── 내부 워커 API (`/internal/v1`, 헤더 `X-Worker-Secret`) ─────────────────────────────────

export const INTERNAL_PREFIX = '/internal/v1';

export interface ClaimedJob {
  jobId: string;
  characterId: string;
  name: string;
  /** 1부터. 자동 재시도마다 증가 */
  attempt: number;
  /** 재시작 단계. 이전 단계 산출물은 artifacts에서 읽는다 */
  resumeStage: Exclude<JobStage, 'QUEUED' | 'READY'>;
  imageUrl: string;
  options: { preferTier?: 'T2' | 'T1' | 'T0'; seed?: number };
  /** 이전 시도에서 올린 산출물 이름 → URL */
  artifacts: Record<string, string>;
}

export const JobProgressSchema = z.object({ stage: z.enum(JOB_STAGES), progress: z.number().min(0).max(1) });
export const JobCompleteSchema = z.object({
  tier: z.enum(['T1', 'T2']),
  rigger: z.enum(['smooth', 'rigid']),
  model: z.string().min(1),
  modelVersion: z.string().min(1),
  seed: z.number().int().nullable(),
  /** PUT으로 먼저 올린 산출물 이름 */
  glbArtifact: z.string().min(1),
  thumbnailArtifact: z.string().min(1).nullable(),
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(1).max(8).optional(),
  assetMeta: z.object({ tris: z.number().int(), bones: z.number().int(), glbBytes: z.number().int() }),
});
export type JobComplete = z.infer<typeof JobCompleteSchema>;
export const JobFailSchema = z.object({ stage: z.enum(JOB_STAGES), code: z.string().min(1).max(64), retryable: z.boolean(), message: z.string().max(500) });
export type JobFail = z.infer<typeof JobFailSchema>;

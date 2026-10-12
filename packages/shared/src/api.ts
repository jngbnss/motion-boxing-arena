// C9. AI 생성 작업 상태 + REST 공통 타입. 상세: docs/08-API-DESIGN.md, docs/09-DATA-MODEL.md

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

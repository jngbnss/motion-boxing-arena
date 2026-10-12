// AI 3D 생성 작업 진행 표시 (docs/10 §2 화면 3·§5): GET /jobs/:id 폴링(2초, 대기 중 5초) → 단계 스테퍼·진행률·대기 순번,
// 재시도 가능한 실패는 "다시 시도"(POST /jobs/:id/retry), 완료 시 매니페스트를 받아 캐시한다. T0 스킨은 이미 저장돼 있다.
import { useEffect, useRef, useState } from 'react';
import { JOB_STAGES, type CharacterManifest, type JobStage, type JobView } from '@mba/shared';
import { removeGenerationJob, saveServerCharacter } from '../characters.ts';
import { api, ApiError, errorMessage } from '../net/api.ts';

const STAGE_LABEL: Record<JobStage, string> = {
  QUEUED: '대기열',
  PREPROCESSING: '배경 제거',
  GENERATING: '3D 생성',
  POSTPROCESSING: '메쉬 정리',
  RIGGING: '리깅',
  VALIDATING: '검증',
  EXPORTING: '내보내기',
  READY: '완료',
};

const FAIL_HINT: Record<string, string> = {
  NOT_HUMANOID_AND_RIGID_FAILED: '사람 모양을 찾지 못했어요. 정면 전신, 팔을 벌린 그림이 좋아요.',
  NOT_HUMANOID: '사람 모양을 찾지 못했어요. 정면 전신, 팔을 벌린 그림이 좋아요.',
  BG_REMOVAL_FAILED: '배경이 복잡해서 캐릭터를 분리하지 못했어요.',
  MESH_EMPTY: '3D 모양을 만들지 못했어요. 더 또렷한 이미지로 시도해 보세요.',
  GEN_OOM: '생성 서버의 GPU 메모리가 부족했어요. 잠시 후 다시 시도해 주세요.',
  STAGE_TIMEOUT: '처리 시간이 너무 오래 걸렸어요.',
  JOB_TIMEOUT: '처리 시간이 너무 오래 걸렸어요.',
  IMAGE_INVALID: '이미지를 읽을 수 없어요.',
  IMAGE_DOWNLOAD_FAILED: '생성 서버가 이미지를 받지 못했어요.',
};

const POLL_MS = 2000;
const POLL_QUEUED_MS = 5000;

export function GenerationPanel({ jobId, estimatedSeconds, onReady }: {
  jobId: string;
  estimatedSeconds: number;
  onReady: (m: CharacterManifest) => void;
}) {
  const [job, setJob] = useState<JobView | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [nonce, setNonce] = useState(0);
  const startedAt = useRef(performance.now());
  const readyFired = useRef(false);

  useEffect(() => {
    if (!api) return;
    const client = api;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      let next = POLL_MS;
      try {
        const j = await client.getJob(jobId);
        if (!alive) return;
        setJob(j);
        setPollError(null);
        if (j.status === 'READY') {
          if (!readyFired.current && j.characterId) {
            readyFired.current = true;
            const m = await client.getCharacter(j.characterId);
            saveServerCharacter(m);
            removeGenerationJob(jobId);
            if (alive) onReady(m);
          }
          return;
        }
        if (j.status === 'FAILED') return;
        if (j.status === 'QUEUED') next = POLL_QUEUED_MS;
      } catch (e) {
        if (!alive) return;
        setPollError(errorMessage(e));
        // 429/네트워크 오류는 백오프
        next = e instanceof ApiError && e.status === 429 ? 10_000 : POLL_QUEUED_MS;
      }
      if (alive) timer = window.setTimeout(tick, next);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [jobId, nonce]);

  const retry = async () => {
    if (!api) return;
    setRetrying(true);
    try {
      setJob(await api.retryJob(jobId));
      startedAt.current = performance.now();
      setNonce((n) => n + 1);
    } catch (e) {
      setPollError(errorMessage(e));
    } finally {
      setRetrying(false);
    }
  };

  const status = job?.status ?? 'QUEUED';
  const stage = job?.stage ?? 'QUEUED';
  const stageIdx = JOB_STAGES.indexOf(stage);
  const elapsedS = (performance.now() - startedAt.current) / 1000;
  const slow = status !== 'QUEUED' && status !== 'READY' && status !== 'FAILED' && estimatedSeconds > 0 && elapsedS > estimatedSeconds * 2;

  return (
    <div className="card" data-testid="generation-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <b>AI 3D 변환 {status === 'READY' ? '완료' : status === 'FAILED' ? '실패' : '진행 중'}</b>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {JOB_STAGES.map((s, i) => (
          <span
            key={s}
            className="chip"
            data-testid={`stage-${s}`}
            style={{
              borderColor: status === 'FAILED' && s === stage ? '#ff4d6d' : i < stageIdx || status === 'READY' ? '#3ddc84' : i === stageIdx ? '#ffc93c' : undefined,
              opacity: i <= stageIdx || status === 'READY' ? 1 : 0.5,
            }}
          >{STAGE_LABEL[s]}</span>
        ))}
      </div>
      {status !== 'FAILED' && (
        <div className="hpbar" style={{ height: 10 }}><div style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%`, background: '#3ddc84' }} /></div>
      )}
      <span className="muted" style={{ fontSize: 13 }} data-testid="job-status">
        {status === 'QUEUED' && `대기 중${job?.queuePosition != null ? ` · 순번 ${job.queuePosition}` : ''} — 생성 워커가 작업을 가져가면 시작돼요.`}
        {status !== 'QUEUED' && status !== 'FAILED' && status !== 'READY' && `${STAGE_LABEL[stage]} 중 · ${Math.round((job?.progress ?? 0) * 100)}%${estimatedSeconds > 0 ? ` · 예상 ${Math.round(estimatedSeconds)}초` : ''}`}
        {status === 'READY' && '3D 캐릭터가 준비됐어요. 캐릭터 선택에서 고를 수 있어요.'}
      </span>
      {slow && <span className="warn-box" style={{ fontSize: 13 }}>평소보다 오래 걸려요. 먼저 한 판 하고 오세요 — 완성되면 다음 경기부터 적용돼요.</span>}
      {status === 'FAILED' && job?.error && (
        <div className="error-box" style={{ fontSize: 14 }}>
          <b>{STAGE_LABEL[job.error.stage]} 단계 실패</b> — {FAIL_HINT[job.error.code] ?? job.error.message} <span className="muted">({job.error.code})</span>
          <p style={{ margin: '6px 0 0' }}>T0 스킨 캐릭터는 이미 저장돼 있어서 바로 플레이할 수 있어요.</p>
          {job.error.retryable && (
            <button style={{ marginTop: 8 }} disabled={retrying} onClick={retry}>{retrying ? '요청 중…' : '다시 시도'}</button>
          )}
        </div>
      )}
      {pollError && <span className="muted" style={{ fontSize: 12 }}>상태 확인 실패: {pollError} (자동 재시도)</span>}
    </div>
  );
}

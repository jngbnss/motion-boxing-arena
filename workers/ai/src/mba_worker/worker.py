"""폴링 루프: claim(2초 간격) → 파이프라인 → complete/fail. 10초마다 heartbeat."""

from __future__ import annotations

import logging
import threading

import httpx

from . import errors
from .api import ApiClient, RemoteStore
from .errors import StageError
from .pipeline import JobSpec, Pipeline
from .preprocess import warmup

log = logging.getLogger(__name__)

HEARTBEAT_S = 10.0


class Worker:
    def __init__(self, api: ApiClient, backend, poll_s: float = 2.0) -> None:
        self.api = api
        self.backend = backend
        self.poll_s = poll_s
        self.stop = threading.Event()
        self._job_id: str | None = None
        self.pipeline = Pipeline(backend, self._report_progress)

    def _report_progress(self, stage: str, p: float) -> None:
        if self._job_id is None:
            return
        try:
            self.api.progress(self._job_id, stage, p)
        except httpx.HTTPError as e:
            log.warning("진행률 보고 실패: %s", e)

    def _heartbeat_loop(self) -> None:
        while not self.stop.wait(HEARTBEAT_S):
            try:
                self.api.heartbeat()
            except httpx.HTTPError as e:
                log.warning("heartbeat 실패: %s", e)

    def run_forever(self) -> None:
        log.info("모델 로드 중 (첫 실행은 HF 가중치 다운로드)…")
        self.backend.load()
        warmup()
        threading.Thread(target=self._heartbeat_loop, name="heartbeat", daemon=True).start()
        log.info("작업 대기: %s (worker=%s)", self.api.base, self.api.worker_id)
        while not self.stop.is_set():
            try:
                job = self.api.claim()
            except httpx.HTTPError as e:
                log.warning("claim 실패: %s", e)
                self.stop.wait(max(self.poll_s, 5.0))
                continue
            if job is None:
                self.stop.wait(self.poll_s)
                continue
            self.handle(job)

    def handle(self, job: dict) -> None:
        job_id = job["jobId"]
        options = job.get("options") or {}
        log.info("작업 %s (attempt %s, resume %s)", job_id, job.get("attempt"), job.get("resumeStage"))
        store = RemoteStore(self.api, job_id, job.get("artifacts") or {})

        def load_image() -> bytes:
            try:
                return self.api.download(job["imageUrl"])
            except httpx.HTTPError as e:
                raise StageError(errors.IMAGE_DOWNLOAD_FAILED, f"원본 이미지 다운로드 실패: {e}", retryable=True) from e

        spec = JobSpec(
            job_id=job_id,
            load_image=load_image,
            resume_stage=job.get("resumeStage") or "PREPROCESSING",
            seed=options.get("seed"),
            prefer_tier=options.get("preferTier"),
        )
        self._job_id = job_id
        try:
            result = self.pipeline.run(spec, store)
            self.api.complete(job_id, result.complete)
            log.info("작업 %s 완료: %s %s", job_id, result.complete["tier"], result.timings)
        except StageError as e:
            log.warning("작업 %s 실패 [%s] %s: %s", job_id, e.stage, e.code, e.message)
            self._safe_fail(job_id, e.stage or spec.resume_stage, e.code, e.retryable, e.message)
        except httpx.HTTPError as e:
            # 산출물 업로드·complete 실패: 서버가 살아 있으면 재시도 가능한 실패로 남긴다
            log.warning("작업 %s 서버 통신 실패: %s", job_id, e)
            self._safe_fail(job_id, self.pipeline.current_stage or spec.resume_stage, errors.INTERNAL, True, f"서버 통신 실패: {e}")
        finally:
            self._job_id = None
            # 타임아웃된 단계 스레드가 GPU 를 잡고 있으면 끝날 때까지 다음 claim 을 미룬다
            self.pipeline.wait_idle()

    def _safe_fail(self, job_id: str, stage: str, code: str, retryable: bool, message: str) -> None:
        try:
            self.api.fail(job_id, stage, code, retryable, message)
        except httpx.HTTPError as e:
            log.error("fail 보고도 실패 (좀비 회수에 맡김): %s", e)

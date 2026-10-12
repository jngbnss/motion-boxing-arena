"""단계 실패 → `/fail` 코드 (docs/04 §3.I, docs/09 §5)."""

from __future__ import annotations


class StageError(Exception):
    def __init__(self, code: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.stage: str | None = None

    def with_stage(self, stage: str) -> StageError:
        """실패 단계 기록 (처음 기록된 단계를 유지)."""
        if self.stage is None:
            self.stage = stage
        return self


# 재시도 가능
GEN_OOM = "GEN_OOM"
MESH_EMPTY = "MESH_EMPTY"
STAGE_TIMEOUT = "STAGE_TIMEOUT"
JOB_TIMEOUT = "JOB_TIMEOUT"
IMAGE_DOWNLOAD_FAILED = "IMAGE_DOWNLOAD_FAILED"
INTERNAL = "INTERNAL"
# 재시도 불가 (클라이언트는 T0 유지)
IMAGE_INVALID = "IMAGE_INVALID"
BG_REMOVAL_FAILED = "BG_REMOVAL_FAILED"
NOT_HUMANOID_AND_RIGID_FAILED = "NOT_HUMANOID_AND_RIGID_FAILED"

import time

import pytest
import torch
from PIL import Image

from mba_worker import pipeline as pl
from mba_worker.errors import StageError
from mba_worker.generate import ATTEMPTS, TripoSRBackend
from test_pipeline import SyntheticBackend, _seed_preprocess


class _OomRenderer:
    def set_chunk_size(self, n: int) -> None:
        self.chunk = n


class _OomModel:
    """forward 에서 CUDA OOM 을 던지는 TripoSR 대역."""

    def __init__(self) -> None:
        self.renderer = _OomRenderer()
        self.calls = 0

    def __call__(self, images, device):
        self.calls += 1
        raise torch.cuda.OutOfMemoryError("CUDA out of memory (test)")


def test_oom_retries_smaller_then_reports_gen_oom():
    backend = TripoSRBackend(device="cpu")
    backend.model = _OomModel()
    with pytest.raises(StageError) as e:
        backend.generate(Image.new("RGBA", (32, 32)), seed=0)
    assert e.value.code == "GEN_OOM" and e.value.retryable
    assert backend.model.calls == len(ATTEMPTS)  # 작은 청크·해상도로 한 번 더 시도했다
    assert backend.model.renderer.chunk == ATTEMPTS[-1][0]


class _SlowBackend(SyntheticBackend):
    def generate(self, rgba, seed, progress=None):
        time.sleep(1.0)
        return super().generate(rgba, seed, progress)


def test_stage_timeout_is_retryable_and_waits_for_zombie(tmp_path, monkeypatch):
    monkeypatch.setitem(pl.STAGE_TIMEOUT_S, "GENERATING", 0.2)
    store = pl.LocalStore(tmp_path)
    _seed_preprocess(store)
    p = pl.Pipeline(_SlowBackend())
    t0 = time.monotonic()
    with pytest.raises(StageError) as e:
        p.run(pl.JobSpec("job_t", lambda: b"", resume_stage="GENERATING"), store)
    assert time.monotonic() - t0 < 0.9  # 타임아웃은 단계가 끝나기 전에 보고된다
    assert (e.value.code, e.value.stage, e.value.retryable) == ("STAGE_TIMEOUT", "GENERATING", True)
    assert not store.has("generated.npz")  # 타임아웃된 단계 결과는 올리지 않는다
    p.wait_idle()  # 다음 작업 전에 남은 GPU 스레드가 끝날 때까지 기다린다
    assert time.monotonic() - t0 >= 1.0


def test_unexpected_exception_becomes_retryable_internal(tmp_path):
    store = pl.LocalStore(tmp_path)
    store.put("normalized.npz", b"not an npz")
    _seed_preprocess(store)
    store.put("generated.npz", b"x")
    store.put("generate.json", b"{}")
    with pytest.raises(StageError) as e:
        pl.Pipeline(SyntheticBackend()).run(pl.JobSpec("job_x", lambda: b"", resume_stage="RIGGING"), store)
    assert (e.value.code, e.value.stage, e.value.retryable) == ("INTERNAL", "RIGGING", True)

"""GENERATING: TripoSR (MIT, VAST-AI-Research/TripoSR 벤더링) 이미지 → 정점 색 메쉬.

ImageTo3DBackend 인터페이스(docs/04 §5)를 따른다. 모델은 워커 프로세스에 상주한다.
6GB VRAM 대응: 렌더러 청크 질의(chunk_size) + 마칭 큐브는 CPU(scikit-image).
OOM 이면 더 작은 청크·해상도로 한 번 더 시도하고, 그래도 실패하면 GEN_OOM(재시도 가능).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
from PIL import Image

from . import errors
from .errors import StageError
from .meshdata import MeshData

log = logging.getLogger(__name__)

MODEL_REPO = "stabilityai/TripoSR"
MODEL_NAME = "TripoSR"
MODEL_VERSION = "stabilityai/TripoSR@model.ckpt"
# (chunk_size, marching cubes 해상도) 순서대로 시도
ATTEMPTS: tuple[tuple[int, int], ...] = ((8192, 256), (2048, 192))
DENSITY_THRESHOLD = 25.0


@dataclass
class GenerationResult:
    mesh: MeshData
    timings: dict[str, float] = field(default_factory=dict)
    vram_peak_mb: float | None = None  # torch 할당 피크 (모델 가중치 포함)
    vram_reserved_mb: float | None = None  # torch 캐시 할당자 예약 피크 (nvidia-smi 에 가까운 값)


class TripoSRBackend:
    name = MODEL_NAME
    version = MODEL_VERSION

    def __init__(self, device: str | None = None) -> None:
        import torch

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model = None

    def load(self) -> None:
        if self.model is not None:
            return
        from .vendor.tsr.system import TSR

        t0 = time.perf_counter()
        model = TSR.from_pretrained(MODEL_REPO, config_name="config.yaml", weight_name="model.ckpt")
        model.eval()
        self.model = model.to(self.device)
        log.info("TripoSR 로드 %.1fs (device=%s)", time.perf_counter() - t0, self.device)

    def generate(self, rgba: Image.Image, seed: int, progress: Callable[[float], None] | None = None) -> GenerationResult:
        import torch

        from .preprocess import composite_gray

        self.load()
        assert self.model is not None
        image = composite_gray(rgba)
        last_oom: Exception | None = None
        for chunk, resolution in ATTEMPTS:
            torch.manual_seed(seed)
            if self.device == "cuda":
                torch.cuda.empty_cache()
                torch.cuda.reset_peak_memory_stats()
            try:
                return self._run(image, chunk, resolution, progress)
            except torch.cuda.OutOfMemoryError as e:
                last_oom = e
                log.warning("TripoSR OOM (chunk=%d, res=%d) → 더 작은 설정으로 재시도", chunk, resolution)
                torch.cuda.empty_cache()
        raise StageError(errors.GEN_OOM, f"GPU 메모리 부족: {last_oom}", retryable=True)

    def _run(self, image: Image.Image, chunk: int, resolution: int, progress: Callable[[float], None] | None) -> GenerationResult:
        import torch

        model = self.model
        assert model is not None
        timings: dict[str, float] = {}
        model.renderer.set_chunk_size(chunk)
        t0 = time.perf_counter()
        with torch.no_grad():
            scene_codes = model([image], device=self.device)
        if self.device == "cuda":
            torch.cuda.synchronize()
        timings["forward"] = time.perf_counter() - t0
        if progress:
            progress(0.5)
        t1 = time.perf_counter()
        meshes = model.extract_mesh(scene_codes, True, resolution=resolution, threshold=DENSITY_THRESHOLD)
        timings["extract"] = time.perf_counter() - t1
        peak = torch.cuda.max_memory_allocated() / 2**20 if self.device == "cuda" else None
        reserved = torch.cuda.max_memory_reserved() / 2**20 if self.device == "cuda" else None
        del scene_codes
        tm = meshes[0]
        if len(tm.faces) == 0:
            raise StageError(errors.MESH_EMPTY, "TripoSR 가 빈 메쉬를 출력", retryable=True)
        colors = np.asarray(tm.visual.vertex_colors, dtype=np.float32)[:, :3] / 255.0
        log.info("TripoSR %d verts / %d faces, %s, peak %.0f MiB (reserved %.0f)", len(tm.vertices), len(tm.faces), timings, peak or 0, reserved or 0)
        return GenerationResult(MeshData(np.asarray(tm.vertices), np.asarray(tm.faces), colors), timings, peak, reserved)

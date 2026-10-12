"""단계 오케스트레이션: 단계별 산출물 저장·재개·타임아웃·진행률 (docs/04 §3.G, docs/09 §5)."""

from __future__ import annotations

import io
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

import numpy as np
from PIL import Image

from . import errors
from .errors import StageError
from .meshdata import MeshData, RigData

log = logging.getLogger(__name__)

PIPELINE_VERSION = "mba-worker/0.1.0"
STAGES = ("PREPROCESSING", "GENERATING", "POSTPROCESSING", "RIGGING", "VALIDATING", "EXPORTING")
# packages/shared/src/api.ts STAGE_TIMEOUT_MS / JOB_TOTAL_TIMEOUT_MS (C13)
STAGE_TIMEOUT_S = {
    "PREPROCESSING": 30.0,
    "GENERATING": 300.0,
    "POSTPROCESSING": 120.0,
    "RIGGING": 120.0,
    "VALIDATING": 60.0,
    "EXPORTING": 60.0,
}
JOB_TOTAL_TIMEOUT_S = 600.0

GLB_ARTIFACT = "character.glb"
THUMBNAIL_ARTIFACT = "thumbnail.png"
# 단계 → 산출물 / 필요한 이전 단계 산출물
OUTPUTS: dict[str, tuple[str, ...]] = {
    "PREPROCESSING": ("preprocessed.png", "preprocess.json"),
    "GENERATING": ("generated.npz", "generate.json"),
    "POSTPROCESSING": ("normalized.npz",),
    "RIGGING": ("rig.npz",),
    "VALIDATING": ("validation.json", "skin.npz"),
    "EXPORTING": (GLB_ARTIFACT, THUMBNAIL_ARTIFACT),
}
INPUTS: dict[str, tuple[str, ...]] = {
    "PREPROCESSING": (),
    "GENERATING": ("preprocessed.png",),
    "POSTPROCESSING": ("generated.npz",),
    "RIGGING": ("normalized.npz", "preprocess.json"),
    "VALIDATING": ("rig.npz", "preprocess.json"),
    "EXPORTING": ("rig.npz", "skin.npz", "validation.json", "preprocess.json", "generate.json"),
}
PRODUCER = {name: stage for stage, names in OUTPUTS.items() for name in names}


class ArtifactStore(Protocol):
    def has(self, name: str) -> bool: ...
    def get(self, name: str) -> bytes: ...
    def put(self, name: str, data: bytes) -> None: ...


class LocalStore:
    """오프라인 실행: 디렉터리에 산출물을 쓴다."""

    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def has(self, name: str) -> bool:
        return (self.root / name).exists()

    def get(self, name: str) -> bytes:
        return (self.root / name).read_bytes()

    def put(self, name: str, data: bytes) -> None:
        (self.root / name).write_bytes(data)


@dataclass
class JobSpec:
    job_id: str
    load_image: Callable[[], bytes]
    resume_stage: str = "PREPROCESSING"
    seed: int | None = None
    prefer_tier: str | None = None


@dataclass
class JobResult:
    complete: dict  # JobCompleteSchema 페이로드
    timings: dict[str, float] = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)


def plan_start(resume_stage: str, store: ArtifactStore) -> int:
    """resume_stage 부터 재개하되, 필요한 이전 산출물이 없으면 그 생산 단계까지 거슬러 올라간다."""
    start = STAGES.index(resume_stage) if resume_stage in STAGES else 0
    changed = True
    while changed:
        changed = False
        for stage in STAGES[start:]:
            for name in INPUTS[stage]:
                producer = STAGES.index(PRODUCER[name])
                if producer < start and not store.has(name):
                    start = producer
                    changed = True
    return start


def _json(data: dict) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=1).encode()


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


class Pipeline:
    def __init__(self, backend, progress: Callable[[str, float], None] | None = None) -> None:
        self.backend = backend
        self._progress = progress or (lambda stage, p: None)
        # 타임아웃 난 단계 스레드는 강제 종료할 수 없으므로 끝날 때까지 다음 작업을 시작하지 않는다
        self._zombies: list[ThreadPoolExecutor] = []
        self.current_stage: str | None = None

    def wait_idle(self) -> None:
        for ex in self._zombies:
            ex.shutdown(wait=True)
        self._zombies.clear()

    def run(self, spec: JobSpec, store: ArtifactStore) -> JobResult:
        self.wait_idle()
        start = plan_start(spec.resume_stage, store)
        if STAGES[start] != spec.resume_stage:
            log.info("재개 단계 %s → 산출물 부족으로 %s 부터", spec.resume_stage, STAGES[start])
        t_job = time.monotonic()
        timings: dict[str, float] = {}
        metrics: dict = {}
        result: dict | None = None
        for stage in STAGES[start:]:
            self.current_stage = stage
            remaining = JOB_TOTAL_TIMEOUT_S - (time.monotonic() - t_job)
            if remaining <= 0:
                raise StageError(errors.JOB_TIMEOUT, "전체 10분 제한 초과", retryable=True).with_stage(stage)
            limit = min(STAGE_TIMEOUT_S[stage], remaining)
            self._progress(stage, 0.0)
            t0 = time.monotonic()
            fn = getattr(self, f"_stage_{stage.lower()}")
            report = lambda p, s=stage: self._progress(s, p)  # noqa: E731
            outputs, stage_metrics = self._run_limited(stage, limit, lambda f=fn, r=report: f(spec, store, r))
            for name, data in outputs.items():
                store.put(name, data)
            timings[stage] = round(time.monotonic() - t0, 3)
            metrics[stage] = stage_metrics
            self._progress(stage, 1.0)
            log.info("%s 완료 %.2fs %s", stage, timings[stage], stage_metrics)
            if stage == "EXPORTING":
                result = stage_metrics["complete"]
        if result is None:  # pragma: no cover - EXPORTING 은 항상 마지막 단계
            raise StageError(errors.INTERNAL, "EXPORTING 결과 없음", retryable=True)
        return JobResult(result, timings, metrics)

    def _run_limited(self, stage: str, limit: float, fn):
        ex = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"stage-{stage}")
        fut = ex.submit(fn)
        try:
            return fut.result(timeout=limit)
        except FutureTimeout:
            self._zombies.append(ex)
            raise StageError(errors.STAGE_TIMEOUT, f"{stage} {limit:.0f}s 제한 초과", retryable=True).with_stage(stage) from None
        except StageError as e:
            raise e.with_stage(stage)
        except Exception as e:  # noqa: BLE001 - 알 수 없는 오류는 재시도 가능한 INTERNAL 로 보고
            log.exception("%s 실패", stage)
            raise StageError(errors.INTERNAL, f"{type(e).__name__}: {e}", retryable=True).with_stage(stage) from e
        finally:
            if fut.done():
                ex.shutdown(wait=False)

    # ── 단계 구현: (산출물 dict, 지표 dict) 를 돌려준다. 업로드는 run() 이 한다 ─────────────

    def _stage_preprocessing(self, spec: JobSpec, store: ArtifactStore, progress):
        from .preprocess import preprocess

        res = preprocess(spec.load_image())
        metrics = {k: v for k, v in res.info.items() if k != "pose"} | {"poseLandmarks": res.info.get("pose") is not None}
        return {"preprocessed.png": _png(res.image), "preprocess.json": _json(res.info)}, metrics

    def _stage_generating(self, spec: JobSpec, store: ArtifactStore, progress):
        image = Image.open(io.BytesIO(store.get("preprocessed.png"))).convert("RGBA")
        seed = spec.seed if spec.seed is not None else 0
        gen = self.backend.generate(image, seed, progress)
        info = {
            "model": self.backend.name,
            "modelVersion": self.backend.version,
            "seed": spec.seed,
            "timings": {k: round(v, 3) for k, v in gen.timings.items()},
            "vramPeakMiB": round(gen.vram_peak_mb, 1) if gen.vram_peak_mb is not None else None,
            "vramReservedMiB": round(gen.vram_reserved_mb, 1) if gen.vram_reserved_mb is not None else None,
            "rawTris": int(len(gen.mesh.faces)),
        }
        return {"generated.npz": gen.mesh.to_bytes(), "generate.json": _json(info)}, info

    def _stage_postprocessing(self, spec: JobSpec, store: ArtifactStore, progress):
        from .postprocess import postprocess

        m = postprocess(MeshData.from_bytes(store.get("generated.npz")))
        v = m.vertices
        info = {"tris": int(len(m.faces)), "verts": int(len(v)), "bboxMin": v.min(0).round(4).tolist(), "bboxMax": v.max(0).round(4).tolist()}
        return {"normalized.npz": m.to_bytes()}, info

    def _stage_rigging(self, spec: JobSpec, store: ArtifactStore, progress):
        from .rig import PoseHint, build_rig

        pose = PoseHint.from_info(json.loads(store.get("preprocess.json")))
        rig = build_rig(MeshData.from_bytes(store.get("normalized.npz")), pose)
        info = {k: (round(float(v), 4) if isinstance(v, float) else v) for k, v in rig.meta.items()}
        return {"rig.npz": rig.to_bytes()}, info

    def _stage_validating(self, spec: JobSpec, store: ArtifactStore, progress):
        from .validate import choose_binding

        rig = RigData.from_bytes(store.get("rig.npz"))
        pre = json.loads(store.get("preprocess.json"))
        binding = choose_binding(rig, bool(pre.get("humanoid")), spec.prefer_tier)
        report = binding.report
        if not report["pass"]:
            # 보고서는 남기고 실패 (재시도 불가 → 클라이언트는 T0 유지)
            store.put("validation.json", _json(report))
            raise StageError(
                errors.NOT_HUMANOID_AND_RIGID_FAILED,
                "rigid 기본 검증 실패: " + "; ".join(report["rigid"]["problems"])[:400],
                retryable=False,
            )
        buf = io.BytesIO()
        np.savez_compressed(buf, joint_idx=binding.joint_idx, joint_w=binding.joint_w)
        return {"validation.json": _json(report), "skin.npz": buf.getvalue()}, {"tier": report["tier"], "rigger": report["rigger"]}

    def _stage_exporting(self, spec: JobSpec, store: ArtifactStore, progress):
        from .export_glb import build_glb
        from .skeleton import BONES
        from .thumbnail import render_thumbnail

        rig = RigData.from_bytes(store.get("rig.npz"))
        report = json.loads(store.get("validation.json"))
        pre = json.loads(store.get("preprocess.json"))
        gen = json.loads(store.get("generate.json"))
        with np.load(io.BytesIO(store.get("skin.npz")), allow_pickle=False) as skin:
            idx, w = skin["joint_idx"], skin["joint_w"]
        extras = {"tier": report["tier"], "rigger": report["rigger"], "pipelineVersion": PIPELINE_VERSION, "model": gen["model"]}
        glb = build_glb(rig.mesh, rig.joints, idx, w, extras)
        progress(0.6)
        thumb = render_thumbnail(rig.mesh)
        complete = {
            "tier": report["tier"],
            "rigger": report["rigger"],
            "model": gen["model"],
            "modelVersion": gen["modelVersion"],
            "seed": gen["seed"],
            "glbArtifact": GLB_ARTIFACT,
            "thumbnailArtifact": THUMBNAIL_ARTIFACT,
            "palette": pre.get("palette") or None,
            "assetMeta": {"tris": int(len(rig.mesh.faces)), "bones": len(BONES), "glbBytes": len(glb)},
        }
        if complete["palette"] is None:
            del complete["palette"]
        return {GLB_ARTIFACT: glb, THUMBNAIL_ARTIFACT: thumb}, {"complete": complete}

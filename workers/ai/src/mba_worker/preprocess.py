"""PREPROCESSING: 배경 제거(rembg) → 크롭·정사각 패딩 → 휴머노이드 판정 → 팔레트."""

from __future__ import annotations

import io
import logging
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from . import errors
from .errors import StageError

log = logging.getLogger(__name__)

OUTPUT_SIZE = 512
FOREGROUND_RATIO = 0.85
MASK_MIN_RATIO = 0.05
MASK_MAX_RATIO = 0.95

# MediaPipe 33 랜드마크 중 COCO 17 대응 핵심 랜드마크 (코·눈·귀·어깨·팔꿈치·손목·골반·무릎·발목)
CORE_LANDMARKS = (0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28)
CORE_VISIBLE_MIN = 13
VISIBILITY_MIN = 0.5
POSE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_full/float16/latest/pose_landmarker_full.task"
)


@dataclass
class PreprocessResult:
    image: Image.Image  # RGBA, OUTPUT_SIZE 정사각, 전경 비율 FOREGROUND_RATIO
    info: dict  # humanoid, method, maskRatio, coreVisible, palette, aspect


def cache_dir() -> Path:
    d = Path(os.environ.get("MBA_WORKER_CACHE", Path.home() / ".cache" / "mba-worker"))
    d.mkdir(parents=True, exist_ok=True)
    return d


_rembg_session = None


def _rembg():
    global _rembg_session
    if _rembg_session is None:
        import rembg

        _rembg_session = rembg.new_session("u2net", providers=["CPUExecutionProvider"])
    return _rembg_session


def load_image(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:  # noqa: BLE001 - PIL 은 다양한 예외를 던진다
        raise StageError(errors.IMAGE_INVALID, f"이미지를 열 수 없음: {e}", retryable=False) from e
    return ImageOps.exif_transpose(img).convert("RGBA")


def remove_background(img: Image.Image) -> Image.Image:
    """이미 투명 배경이 있으면 그대로 쓰고, 아니면 rembg(U²-Net)로 알파를 만든다."""
    alpha = np.asarray(img)[..., 3]
    if alpha.min() < 250 and (alpha < 128).mean() > 0.02:
        return img
    import rembg

    out = rembg.remove(img, session=_rembg())
    return out.convert("RGBA")


def crop_to_square(img: Image.Image, ratio: float = FOREGROUND_RATIO, size: int = OUTPUT_SIZE) -> Image.Image:
    """전경 bbox 로 자르고 정사각 패딩, 전경이 한 변의 ratio 를 차지하도록 여백 → size 로 리사이즈."""
    arr = np.asarray(img)
    ys, xs = np.nonzero(arr[..., 3] > 16)
    if len(xs) == 0:
        raise StageError(errors.BG_REMOVAL_FAILED, "전경이 없음", retryable=False)
    fg = arr[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    side = int(round(max(fg.shape[0], fg.shape[1]) / ratio))
    canvas = np.zeros((side, side, 4), dtype=np.uint8)
    oy, ox = (side - fg.shape[0]) // 2, (side - fg.shape[1]) // 2
    canvas[oy : oy + fg.shape[0], ox : ox + fg.shape[1]] = fg
    return Image.fromarray(canvas, "RGBA").resize((size, size), Image.Resampling.LANCZOS)


def composite_gray(img: Image.Image) -> Image.Image:
    """TripoSR 입력 규약: 알파를 회색(0.5) 배경에 합성한 RGB."""
    arr = np.asarray(img).astype(np.float32) / 255.0
    rgb = arr[..., :3] * arr[..., 3:4] + (1.0 - arr[..., 3:4]) * 0.5
    return Image.fromarray((rgb * 255.0 + 0.5).astype(np.uint8), "RGB")


def warmup() -> None:
    """첫 작업 단계 타임아웃(30s)에 모델 다운로드가 걸리지 않도록 rembg(U²-Net)·포즈 모델을 미리 받는다."""
    _rembg()
    try:
        _pose_model_path()
    except OSError as e:
        log.warning("포즈 모델 다운로드 실패 (%s) → 실행 시 다시 시도, 실패하면 실루엣 규칙", e)


def _pose_model_path() -> Path:
    path = cache_dir() / "pose_landmarker_full.task"
    if not path.exists():
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(POSE_MODEL_URL, tmp)
        tmp.replace(path)
    return path


def detect_pose(img: Image.Image) -> dict | None:
    """MediaPipe PoseLandmarker. {coreVisible, landmarks[33][u,v,vis] | None}. 실행 불가면 None (실루엣 규칙 사용)."""
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python import vision
    except Exception as e:  # noqa: BLE001 - 설치 안 된 환경은 실루엣 규칙으로 대체
        log.warning("mediapipe 사용 불가 (%s) → 실루엣 규칙 사용", e)
        return None
    try:
        model = _pose_model_path()
        opts = vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(model)),
            running_mode=vision.RunningMode.IMAGE,
            num_poses=1,
        )
        rgb = np.ascontiguousarray(np.asarray(composite_white(img)))
        with vision.PoseLandmarker.create_from_options(opts) as det:
            res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    except Exception as e:  # noqa: BLE001
        log.warning("mediapipe 실행 실패 (%s) → 실루엣 규칙 사용", e)
        return None
    if not res.pose_landmarks:
        return {"coreVisible": 0, "landmarks": None}
    lms = res.pose_landmarks[0]
    core = sum(1 for i in CORE_LANDMARKS if (lms[i].visibility or 0.0) >= VISIBILITY_MIN)
    return {
        "coreVisible": core,
        "landmarks": [[round(float(p.x), 5), round(float(p.y), 5), round(float(p.visibility or 0.0), 4)] for p in lms],
    }


def foreground_box(alpha: np.ndarray) -> list[float]:
    """전경 bbox 정규 좌표 [u0, v0, u1, v1] (픽셀 경계 기준)."""
    ys, xs = np.nonzero(alpha > 128)
    h, w = alpha.shape
    return [round(xs.min() / w, 5), round(ys.min() / h, 5), round((xs.max() + 1) / w, 5), round((ys.max() + 1) / h, 5)]


def composite_white(img: Image.Image) -> Image.Image:
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    return Image.alpha_composite(bg, img).convert("RGB")


def silhouette_humanoid(alpha: np.ndarray) -> tuple[bool, float]:
    """MediaPipe 대체 규칙: 전경 bbox 세로/가로 비 1.1~4.5 + 하단 25%에 다리 사이 틈(좌우 두 덩어리)."""
    ys, xs = np.nonzero(alpha > 128)
    h = ys.max() - ys.min() + 1
    w = xs.max() - xs.min() + 1
    aspect = float(h / w)
    rows = alpha[ys.min() + int(h * 0.8) : ys.max() + 1, xs.min() : xs.max() + 1] > 128
    two_legs = 0
    for r in rows:
        runs = np.flatnonzero(np.diff(np.concatenate([[0], r.astype(np.int8), [0]])) == 1)
        if len(runs) >= 2:
            two_legs += 1
    legs = two_legs > 0.3 * len(rows)
    return (1.1 <= aspect <= 4.5) and legs, aspect


def preprocess(data: bytes) -> PreprocessResult:
    from .palette import extract_palette

    img = load_image(data)
    if min(img.size) < 64:
        raise StageError(errors.IMAGE_INVALID, f"이미지가 너무 작음: {img.size}", retryable=False)
    cut = remove_background(img)
    mask_ratio = float((np.asarray(cut)[..., 3] > 128).mean())
    if mask_ratio < MASK_MIN_RATIO or mask_ratio > MASK_MAX_RATIO:
        raise StageError(
            errors.BG_REMOVAL_FAILED,
            f"배경 제거 마스크 면적 {mask_ratio:.1%} (허용 5~95%) → 배경이 단순한 그림으로 다시 시도",
            retryable=False,
        )
    square = crop_to_square(cut)
    alpha = np.asarray(square)[..., 3]
    sil_ok, aspect = silhouette_humanoid(alpha)
    pose = detect_pose(square)
    core = pose["coreVisible"] if pose is not None else None
    # MediaPipe 는 사진에 강하고 그림 인식률은 낮다(docs/04 §2) → 랜드마크 통과 또는 실루엣 규칙 통과면 휴머노이드
    if core is not None and core >= CORE_VISIBLE_MIN:
        humanoid, method = True, "mediapipe"
    else:
        humanoid, method = sil_ok, "silhouette"
    info = {
        "humanoid": bool(humanoid),
        "method": method,
        "coreVisible": core,
        "silhouetteHumanoid": bool(sil_ok),
        "aspect": round(aspect, 3),
        "maskRatio": round(mask_ratio, 4),
        "palette": extract_palette(square),
        "pose": {"landmarks": pose["landmarks"], "fgBox": foreground_box(alpha)} if pose and pose["landmarks"] else None,
    }
    return PreprocessResult(square, info)

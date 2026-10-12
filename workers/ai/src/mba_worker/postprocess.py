"""POSTPROCESSING: floater 제거 → 데시메이트(≤20k tris) → +Y up·정면 +Z → 키 1.8m·발 y=0·x/z 중심."""

from __future__ import annotations

import numpy as np
import trimesh
from scipy.spatial import cKDTree

from . import errors
from .errors import StageError
from .meshdata import MeshData
from .skeleton import CANONICAL_HEIGHT_M

MAX_TRIS = 20_000
TARGET_TRIS = 19_000
# 가장 큰 연결 요소 대비 이 비율 이상인 요소는 함께 남긴다 (떨어져 생성된 팔 등)
KEEP_COMPONENT_RATIO = 0.2

# TripoSR 좌표계: 입력 카메라가 +X 에서 원점을 보고 +Z 가 위. 이미지 오른쪽(= 캐릭터 왼쪽)이 +Y.
# 게임 좌표계: +Y 위, 정면 +Z, 캐릭터 왼쪽 +X  →  (x, y, z)_game = (y, z, x)_tsr (짝순열, det=+1)
TRIPOSR_TO_GAME = np.array([[0, 1, 0], [0, 0, 1], [1, 0, 0]], dtype=np.float64)


def to_trimesh(m: MeshData) -> trimesh.Trimesh:
    rgba = np.concatenate([np.clip(m.colors, 0, 1), np.ones((len(m.colors), 1), np.float32)], axis=1)
    return trimesh.Trimesh(m.vertices, m.faces, vertex_colors=(rgba * 255).astype(np.uint8), process=False)


def from_trimesh(tm: trimesh.Trimesh) -> MeshData:
    colors = np.asarray(tm.visual.vertex_colors, dtype=np.float32)[:, :3] / 255.0
    return MeshData(np.asarray(tm.vertices), np.asarray(tm.faces), colors)


def keep_main_components(tm: trimesh.Trimesh) -> trimesh.Trimesh:
    parts = tm.split(only_watertight=False)
    if len(parts) <= 1:
        return tm
    parts = sorted(parts, key=lambda p: len(p.faces), reverse=True)
    biggest = len(parts[0].faces)
    keep = [p for p in parts if len(p.faces) >= KEEP_COMPONENT_RATIO * biggest]
    return trimesh.util.concatenate(keep)


def decimate(m: MeshData, target: int = TARGET_TRIS) -> MeshData:
    """quadric 데시메이트(fast-simplification). 정점 색은 원본 최근접 정점에서 옮긴다."""
    if len(m.faces) <= MAX_TRIS:
        return m
    import fast_simplification

    verts, faces = m.vertices, m.faces
    for _ in range(4):
        reduction = 1.0 - target / len(faces)
        verts, faces = fast_simplification.simplify(verts, faces, target_reduction=reduction)
        if len(faces) <= MAX_TRIS:
            break
        target = int(target * 0.95)
    _, nn = cKDTree(m.vertices).query(verts)
    return MeshData(verts, faces, m.colors[nn])


def normalization(vertices: np.ndarray, height: float = CANONICAL_HEIGHT_M) -> tuple[np.ndarray, float]:
    """키 height, 발(최저점) y=0, bbox 중심 x/z=0 으로 만드는 (원점 이동량, 배율). p' = (p - origin) * scale."""
    v = vertices.astype(np.float64)
    lo, hi = v.min(0), v.max(0)
    h = hi[1] - lo[1]
    if h <= 1e-6:
        raise StageError(errors.MESH_EMPTY, "메쉬 높이가 0", retryable=True)
    return np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]), height / h


def normalize(m: MeshData, height: float = CANONICAL_HEIGHT_M) -> MeshData:
    origin, s = normalization(m.vertices, height)
    return MeshData((m.vertices.astype(np.float64) - origin) * s, m.faces, m.colors)


def postprocess(raw: MeshData) -> MeshData:
    if len(raw.faces) == 0:
        raise StageError(errors.MESH_EMPTY, "빈 메쉬", retryable=True)
    oriented = MeshData(raw.vertices.astype(np.float64) @ TRIPOSR_TO_GAME.T, raw.faces, raw.colors)
    tm = to_trimesh(oriented)
    tm.merge_vertices()
    tm.update_faces(tm.nondegenerate_faces())
    tm.remove_unreferenced_vertices()
    tm = keep_main_components(tm)
    if len(tm.faces) < 100:
        raise StageError(errors.MESH_EMPTY, f"유효 면이 너무 적음 ({len(tm.faces)})", retryable=True)
    # 마칭 큐브 감김 방향 보정: 부호 있는 부피가 음수면 뒤집는다
    if tm.volume < 0:
        tm.invert()
    m = decimate(from_trimesh(tm))
    tm = to_trimesh(m)
    tm.update_faces(tm.nondegenerate_faces())
    tm.remove_unreferenced_vertices()
    return normalize(from_trimesh(tm))

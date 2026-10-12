"""테스트용 합성 휴머노이드 메쉬 (캡슐·원기둥 조합, 키 1.8m, 정면 +Z, 캐릭터 왼쪽 +X)."""

from __future__ import annotations

import math

import numpy as np
import pytest
import trimesh

from mba_worker.meshdata import MeshData

SKIN = (0.88, 0.70, 0.56)
SHIRT = (0.84, 0.23, 0.18)
TRUNKS = (0.12, 0.16, 0.27)


def _segment(a, b, radius: float, color) -> trimesh.Trimesh:
    a, b = np.asarray(a, float), np.asarray(b, float)
    m = trimesh.creation.capsule(height=float(np.linalg.norm(b - a)), radius=radius, count=[16, 16])
    # capsule 은 z 축 (0..height) 기준 → a→b 로 회전·이동
    m.apply_translation([0, 0, -m.bounds[0][2] - radius])
    d = (b - a) / np.linalg.norm(b - a)
    R = trimesh.geometry.align_vectors([0, 0, 1], d)
    m.apply_transform(R)
    m.apply_translation(a)
    m.visual.vertex_colors = np.tile([*(np.array(color) * 255).astype(np.uint8), 255], (len(m.vertices), 1))
    return m


def make_humanoid(arm_deg: float = 45.0) -> tuple[MeshData, dict[str, np.ndarray]]:
    t = math.radians(arm_deg)
    parts = []
    truth: dict[str, np.ndarray] = {}
    torso = trimesh.creation.cylinder(radius=0.15, segment=[[0, 0.88, 0], [0, 1.45, 0]], sections=24)
    torso.visual.vertex_colors = np.tile([*(np.array(SHIRT) * 255).astype(np.uint8), 255], (len(torso.vertices), 1))
    parts.append(torso)
    parts.append(_segment([0, 1.42, 0], [0, 1.56, 0], 0.05, SKIN))
    head = trimesh.creation.icosphere(subdivisions=3, radius=0.13)
    head.apply_translation([0, 1.67, 0])
    head.visual.vertex_colors = np.tile([*(np.array(SKIN) * 255).astype(np.uint8), 255], (len(head.vertices), 1))
    parts.append(head)
    for sign, side in ((1, "Left"), (-1, "Right")):
        arm = np.array([sign * 0.18, 1.42, 0.0])
        d = np.array([sign * math.cos(t), -math.sin(t), 0.0])
        fore = arm + 0.30 * d
        hand = fore + 0.28 * d
        parts.append(_segment(arm, hand + 0.08 * d, 0.05, SKIN))
        up = np.array([sign * 0.09, 0.96, 0.0])
        knee = np.array([sign * 0.09, 0.52, 0.0])
        ankle = np.array([sign * 0.09, 0.10, 0.0])
        parts.append(_segment(up, ankle, 0.065, TRUNKS))
        foot = trimesh.creation.box(extents=[0.09, 0.06, 0.24])
        foot.apply_translation([sign * 0.09, 0.03, 0.06])
        foot.visual.vertex_colors = np.tile([40, 40, 40, 255], (len(foot.vertices), 1))
        parts.append(foot)
        truth.update({f"{side}Arm": arm, f"{side}ForeArm": fore, f"{side}Hand": hand, f"{side}UpLeg": up, f"{side}Leg": knee, f"{side}Foot": ankle})
    truth.update({"Hips": np.array([0, 1.0, 0]), "Neck": np.array([0, 1.48, 0]), "Head": np.array([0, 1.56, 0])})
    tm = trimesh.util.concatenate(parts)
    v = np.asarray(tm.vertices)
    v[:, 1] -= v[:, 1].min()
    colors = np.asarray(tm.visual.vertex_colors, dtype=np.float32)[:, :3] / 255.0
    return MeshData(v, np.asarray(tm.faces), colors), truth


def make_connected_humanoid(arm_deg: float = 45.0, pitch: float = 0.015) -> MeshData:
    """부품 합집합을 복셀화 → 마칭 큐브로 하나의 연결 메쉬 (TripoSR 출력과 비슷한 형태)."""
    from scipy.spatial import cKDTree

    parts, _ = make_humanoid(arm_deg)
    tm = trimesh.Trimesh(parts.vertices, parts.faces, process=False)
    vox = tm.voxelized(pitch).fill()
    surf = vox.marching_cubes
    surf.apply_transform(vox.transform)
    v = np.asarray(surf.vertices)
    _, nn = cKDTree(parts.vertices).query(v)
    return MeshData(v, np.asarray(surf.faces), parts.colors[nn])


@pytest.fixture(scope="session")
def humanoid() -> tuple[MeshData, dict[str, np.ndarray]]:
    return make_humanoid(45.0)

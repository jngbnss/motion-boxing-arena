"""VALIDATING: 검증 포즈 세트로 smooth 바인딩을 측정해 T2/T1 을 고른다 (docs/04 §3.F).

지표 (초기 기준값은 docs/04 표):
- 최대 엣지 늘어남: 포즈 후/레스트 엣지 길이 (늘어남·줄어듦 대칭) p99 ≤ 2.0
- 관절 주변 부피 유지: 관절 반경 내 정점의 볼록 껍질 부피 비 ≥ 0.6
- 머리 정점 끌림: 머리 영역(rigid=Head) 정점 중 Head 외 가중치 > 0.3 비율 ≤ 5%
- 좌우 대칭: 좌우 관절 높이 차 / 키 ≤ 3%
- (추가) A-pose 재포즈 왜곡 p99 ≤ 2.0, 팔이 몸통과 분리
smooth 실패 시 가중치 평활을 키워 재검증(복구 1단계) → 그래도 실패하면 rigid.
rigid 기본 검증: 관절 높이 순서·좌우 배치·주요 부위 정점 존재.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import ConvexHull, QhullError

from .export_glb import rigid_to_vec4
from .meshdata import RigData
from .rig import apply_skin, rot, skinning_matrices, smooth_weights
from .skeleton import BONE_INDEX, BONES, LEFT_RIGHT_PAIRS

STRETCH_P99_MAX = 2.0
VOLUME_RATIO_MIN = 0.6
HEAD_DRAG_MAX = 0.05
SYMMETRY_MAX = 0.03
VOLUME_RADIUS = 0.12


def _j(rig: RigData, name: str) -> np.ndarray:
    return rig.joints[BONE_INDEX[name]].astype(np.float64)


def validation_poses(rig: RigData) -> dict[str, tuple[dict[str, np.ndarray], list[str]]]:
    """포즈 이름 → (로컬 회전, 부피를 잴 관절)."""
    z = np.array([0.0, 0.0, 1.0])
    poses: dict[str, tuple[dict[str, np.ndarray], list[str]]] = {
        "arm_raise_90": ({"LeftArm": rot(z, 90), "RightArm": rot(z, -90)}, ["LeftArm", "RightArm"]),
        "head_turn_60": ({"Head": rot([0, 1, 0], 60)}, ["Head"]),
    }
    bend: dict[str, np.ndarray] = {}
    jab: dict[str, np.ndarray] = {}
    for side in ("Left", "Right"):
        d_fore = _j(rig, f"{side}Hand") - _j(rig, f"{side}ForeArm")
        d_fore /= np.linalg.norm(d_fore)
        bend[f"{side}ForeArm"] = rot(np.cross(d_fore, z), 90)
        d_arm = _j(rig, f"{side}ForeArm") - _j(rig, f"{side}Arm")
        d_arm /= np.linalg.norm(d_arm)
        ang = float(np.degrees(np.arccos(np.clip(d_arm @ z, -1, 1))))
        jab[f"{side}Arm"] = rot(np.cross(d_arm, z), ang)
    poses["elbow_bend_90"] = (bend, ["LeftForeArm", "RightForeArm"])
    poses["jab"] = (jab, ["LeftArm", "RightArm"])
    return poses


def unique_edges(faces: np.ndarray) -> np.ndarray:
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e.sort(axis=1)
    return np.unique(e, axis=0)


def _hull_volume(p: np.ndarray) -> float:
    if len(p) < 8:
        return 0.0
    try:
        return float(ConvexHull(p).volume)
    except QhullError:
        return 0.0


def measure_smooth(rig: RigData, joint_idx: np.ndarray | None = None, joint_w: np.ndarray | None = None) -> dict:
    idx = rig.smooth_idx if joint_idx is None else joint_idx
    wts = rig.smooth_w if joint_w is None else joint_w
    v = rig.mesh.vertices.astype(np.float64)
    edges = unique_edges(rig.mesh.faces)
    rest_len = np.linalg.norm(v[edges[:, 0]] - v[edges[:, 1]], axis=1)
    ok = rest_len > 1e-6
    edges, rest_len = edges[ok], rest_len[ok]
    worst_stretch = 0.0
    worst_volume = 1.0
    per_pose: dict[str, dict] = {}
    for name, (rots, vol_joints) in validation_poses(rig).items():
        mats, posed_j = skinning_matrices(rig.joints.astype(np.float64), rots)
        pv = apply_skin(v, idx, wts, mats)
        ln = np.linalg.norm(pv[edges[:, 0]] - pv[edges[:, 1]], axis=1)
        ratio = ln / rest_len
        stretch = float(np.percentile(np.maximum(ratio, 1.0 / np.maximum(ratio, 1e-9)), 99))
        vols = []
        for jn in vol_joints:
            sel = np.linalg.norm(v - _j(rig, jn), axis=1) < VOLUME_RADIUS
            rv = _hull_volume(v[sel])
            if rv > 1e-9:
                vols.append(_hull_volume(pv[sel]) / rv)
        vol = float(min(vols)) if vols else 1.0
        per_pose[name] = {"stretchP99": round(stretch, 3), "volumeRatio": round(vol, 3)}
        worst_stretch = max(worst_stretch, stretch)
        worst_volume = min(worst_volume, vol)
    hi = BONE_INDEX["Head"]
    head_region = rig.rigid_idx == hi
    non_head = np.where(idx == hi, 0.0, wts).sum(1)
    head_drag = float((non_head[head_region] > 0.3).mean()) if head_region.any() else 0.0
    height = float(v[:, 1].max() - v[:, 1].min())
    sym = max(abs(float(_j(rig, a)[1] - _j(rig, b)[1])) / height for a, b in LEFT_RIGHT_PAIRS)
    repose = float(rig.meta.get("reposeStretchP99", 1.0))
    checks = {
        "stretch": worst_stretch <= STRETCH_P99_MAX,
        "volume": worst_volume >= VOLUME_RATIO_MIN,
        "headDrag": head_drag <= HEAD_DRAG_MAX,
        "symmetry": sym <= SYMMETRY_MAX,
        # A-pose 재포즈로 이미 찢어진 메쉬(팔이 몸통에 붙은 그림)는 부드러운 관절로 인정하지 않는다
        "repose": repose <= STRETCH_P99_MAX,
        # 팔이 몸통에 붙어 생성되면 겨드랑이가 한 덩어리 → smooth 바인딩 1순위 실패 원인 (docs/04 §3.A)
        "armsFree": bool(rig.meta.get("leftArmFree", True) and rig.meta.get("rightArmFree", True)),
    }
    return {
        "pass": all(checks.values()),
        "checks": checks,
        "stretchP99": round(worst_stretch, 3),
        "volumeRatio": round(worst_volume, 3),
        "headDrag": round(head_drag, 4),
        "symmetry": round(sym, 4),
        "reposeStretchP99": round(repose, 3),
        "poses": per_pose,
    }


def check_rigid(rig: RigData) -> dict:
    """T1 기본 검증: 관절 순서·높이 정합 + 주요 부위에 정점이 할당됐는지."""
    v = rig.mesh.vertices
    y = {b: float(rig.joints[i, 1]) for i, b in enumerate(BONES)}
    x = {b: float(rig.joints[i, 0]) for i, b in enumerate(BONES)}
    lo, hi = v.min(0) - 0.05, v.max(0) + 0.05
    problems: list[str] = []
    if not np.all(np.isfinite(rig.joints)):
        problems.append("관절 좌표가 유한하지 않음")
    elif np.any(rig.joints < lo) or np.any(rig.joints > hi):
        problems.append("관절이 메쉬 bbox 밖")
    chain = ["Head", "Neck", "Spine2", "Spine1", "Spine", "Hips"]
    if any(y[a] <= y[b] for a, b in zip(chain, chain[1:])):
        problems.append("척추 관절 높이 순서 오류")
    for s, sign in (("Left", 1), ("Right", -1)):
        if not (y[f"{s}UpLeg"] > y[f"{s}Leg"] > y[f"{s}Foot"] >= float(v[:, 1].min()) - 0.01):
            problems.append(f"{s} 다리 관절 높이 순서 오류")
        if y[f"{s}UpLeg"] >= y["Spine"]:
            problems.append(f"{s} 골반 관절이 척추보다 높음")
        if sign * (x[f"{s}Hand"] - x["Hips"]) <= 0 or sign * (x[f"{s}Arm"] - x["Hips"]) <= 0:
            problems.append(f"{s} 팔이 반대편에 있음")
        if y[f"{s}Arm"] <= y["Spine"]:
            problems.append(f"{s} 어깨가 너무 낮음")
    counts = np.bincount(rig.rigid_idx, minlength=len(BONES))
    n = len(rig.rigid_idx)
    groups = {
        "head": ["Head", "Neck"],
        "torso": ["Hips", "Spine", "Spine1", "Spine2"],
        "leftArm": ["LeftArm", "LeftForeArm", "LeftHand"],
        "rightArm": ["RightArm", "RightForeArm", "RightHand"],
        "leftLeg": ["LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"],
        "rightLeg": ["RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"],
    }
    shares = {g: float(sum(counts[BONE_INDEX[b]] for b in bs) / n) for g, bs in groups.items()}
    for g, share in shares.items():
        if share < 0.005:
            problems.append(f"{g} 부위 정점 없음 ({share:.2%})")
    return {"pass": not problems, "problems": problems, "shares": {k: round(s, 4) for k, s in shares.items()}}


# docs/04 §3.F 복구 1단계: 가중치를 더 넓게 퍼뜨리고 메쉬 이웃 평활을 늘려 재검증 (sigma, 평활 반복)
SMOOTH_VARIANTS: tuple[tuple[float, int], ...] = ((0.35, 3), (0.5, 8), (0.7, 16))
# 가중치를 바꿔도 해결되지 않는 실패 (형상·관절 배치 문제)
_GEOMETRIC_CHECKS = ("symmetry", "repose", "armsFree")


@dataclass
class Binding:
    report: dict
    joint_idx: np.ndarray | None  # (N,4) uint8
    joint_w: np.ndarray | None  # (N,4) float32


def choose_binding(rig: RigData, humanoid: bool, prefer_tier: str | None) -> Binding:
    """smooth 통과 → T2, 아니면 rigid 기본 검증 통과 → T1, 아니면 pass=False (T0 유지)."""
    report: dict = {"humanoid": humanoid, "preferTier": prefer_tier}
    rigid = check_rigid(rig)
    report["rigid"] = rigid
    if humanoid and prefer_tier not in ("T1", "T0"):
        attempts = []
        hw = float(rig.meta.get("torsoHalfWidth", 0.15))
        for i, (sigma, iters) in enumerate(SMOOTH_VARIANTS):
            if i == 0:
                idx, w = rig.smooth_idx, rig.smooth_w
            else:
                idx, w = smooth_weights(rig.mesh, rig.joints, hw, sigma=sigma, smooth_iters=iters)
            res = measure_smooth(rig, idx, w) | {"sigma": sigma, "smoothIters": iters}
            attempts.append(res)
            if res["pass"]:
                report.update({"smooth": attempts, "tier": "T2", "rigger": "smooth", "pass": True})
                return Binding(report, idx, w)
            if any(not res["checks"][c] for c in _GEOMETRIC_CHECKS):
                break
        report["smooth"] = attempts
    if rigid["pass"]:
        idx, w = rigid_to_vec4(rig.rigid_idx)
        report.update({"tier": "T1", "rigger": "rigid", "pass": True})
        return Binding(report, idx, w)
    report.update({"tier": None, "rigger": None, "pass": False})
    return Binding(report, None, None)

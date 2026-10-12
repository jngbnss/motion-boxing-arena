"""공통 스켈레톤 mba-humanoid-v1 (packages/shared/src/skeleton.ts 와 동일해야 한다)."""

from __future__ import annotations

import numpy as np

SKELETON_ID = "mba-humanoid-v1"
CANONICAL_HEIGHT_M = 1.8
A_POSE_ARM_DEG = 45.0

BONES: tuple[str, ...] = (
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
)
BONE_INDEX: dict[str, int] = {name: i for i, name in enumerate(BONES)}

PARENT: dict[str, str | None] = {
    "Hips": None,
    "Spine": "Hips", "Spine1": "Spine", "Spine2": "Spine1", "Neck": "Spine2", "Head": "Neck",
    "LeftShoulder": "Spine2", "LeftArm": "LeftShoulder", "LeftForeArm": "LeftArm", "LeftHand": "LeftForeArm",
    "RightShoulder": "Spine2", "RightArm": "RightShoulder", "RightForeArm": "RightArm", "RightHand": "RightForeArm",
    "LeftUpLeg": "Hips", "LeftLeg": "LeftUpLeg", "LeftFoot": "LeftLeg", "LeftToeBase": "LeftFoot",
    "RightUpLeg": "Hips", "RightLeg": "RightUpLeg", "RightFoot": "RightLeg", "RightToeBase": "RightFoot",
}
PARENT_INDEX = np.array([-1 if PARENT[b] is None else BONE_INDEX[PARENT[b]] for b in BONES], dtype=np.int32)

CHILDREN: dict[str, list[str]] = {b: [c for c in BONES if PARENT[c] == b] for b in BONES}

# 스킨 세그먼트의 끝점이 되는 자식 (말단 뼈는 별도 끝점을 쓴다)
SEGMENT_CHILD: dict[str, str | None] = {
    "Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head", "Head": None,
    "LeftShoulder": "LeftArm", "LeftArm": "LeftForeArm", "LeftForeArm": "LeftHand", "LeftHand": None,
    "RightShoulder": "RightArm", "RightArm": "RightForeArm", "RightForeArm": "RightHand", "RightHand": None,
    "LeftUpLeg": "LeftLeg", "LeftLeg": "LeftFoot", "LeftFoot": "LeftToeBase", "LeftToeBase": None,
    "RightUpLeg": "RightLeg", "RightLeg": "RightFoot", "RightFoot": "RightToeBase", "RightToeBase": None,
}

LEFT_RIGHT_PAIRS: tuple[tuple[str, str], ...] = (
    ("LeftShoulder", "RightShoulder"), ("LeftArm", "RightArm"), ("LeftForeArm", "RightForeArm"),
    ("LeftHand", "RightHand"), ("LeftUpLeg", "RightUpLeg"), ("LeftLeg", "RightLeg"),
    ("LeftFoot", "RightFoot"), ("LeftToeBase", "RightToeBase"),
)

ARM_CHAINS: dict[str, tuple[str, ...]] = {
    "Left": ("LeftArm", "LeftForeArm", "LeftHand"),
    "Right": ("RightArm", "RightForeArm", "RightHand"),
}


def descendants(bone: str) -> list[str]:
    """bone 자신과 모든 하위 뼈 (BONES 순서)."""
    out: list[str] = []
    stack = [bone]
    while stack:
        b = stack.pop()
        out.append(b)
        stack.extend(CHILDREN[b])
    return [b for b in BONES if b in out]


def world_to_local_offsets(joints: np.ndarray) -> np.ndarray:
    """월드 관절 위치(22×3) → 부모 기준 이동량(레스트 회전은 항등)."""
    out = joints.copy()
    for i, p in enumerate(PARENT_INDEX):
        if p >= 0:
            out[i] = joints[i] - joints[p]
    return out

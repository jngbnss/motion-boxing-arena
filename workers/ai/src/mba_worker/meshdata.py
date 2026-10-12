"""단계 간 전달하는 메쉬·리그 데이터와 npz 직렬화 (단계 산출물 = 재개 입력)."""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import numpy as np


@dataclass
class MeshData:
    vertices: np.ndarray  # (N, 3) float32
    faces: np.ndarray  # (M, 3) int32
    colors: np.ndarray  # (N, 3) float32, sRGB 0..1

    def __post_init__(self) -> None:
        self.vertices = np.ascontiguousarray(self.vertices, dtype=np.float32)
        self.faces = np.ascontiguousarray(self.faces, dtype=np.int32)
        self.colors = np.ascontiguousarray(self.colors, dtype=np.float32)

    def to_bytes(self) -> bytes:
        buf = io.BytesIO()
        np.savez_compressed(buf, vertices=self.vertices, faces=self.faces, colors=self.colors)
        return buf.getvalue()

    @staticmethod
    def from_bytes(data: bytes) -> MeshData:
        with np.load(io.BytesIO(data), allow_pickle=False) as z:
            return MeshData(z["vertices"], z["faces"], z["colors"])


@dataclass
class RigData:
    mesh: MeshData
    joints: np.ndarray  # (22, 3) float32 월드 위치 (BONES 순서)
    smooth_idx: np.ndarray  # (N, 4) uint8
    smooth_w: np.ndarray  # (N, 4) float32, 합 1
    rigid_idx: np.ndarray  # (N,) uint8
    meta: dict = field(default_factory=dict)

    def to_bytes(self) -> bytes:
        import json

        buf = io.BytesIO()
        np.savez_compressed(
            buf,
            vertices=self.mesh.vertices, faces=self.mesh.faces, colors=self.mesh.colors,
            joints=self.joints.astype(np.float32), smooth_idx=self.smooth_idx.astype(np.uint8),
            smooth_w=self.smooth_w.astype(np.float32), rigid_idx=self.rigid_idx.astype(np.uint8),
            meta=np.frombuffer(json.dumps(self.meta).encode(), dtype=np.uint8),
        )
        return buf.getvalue()

    @staticmethod
    def from_bytes(data: bytes) -> RigData:
        import json

        with np.load(io.BytesIO(data), allow_pickle=False) as z:
            return RigData(
                mesh=MeshData(z["vertices"], z["faces"], z["colors"]),
                joints=z["joints"].astype(np.float32),
                smooth_idx=z["smooth_idx"], smooth_w=z["smooth_w"], rigid_idx=z["rigid_idx"],
                meta=json.loads(z["meta"].tobytes().decode()),
            )

"""EXPORTING: 스킨 glTF 2.0 바이너리(GLB) 작성 (pygltflib).

구조: 장면 루트 = [Body(메쉬+스킨), Hips(루트 뼈)]. 뼈 노드는 BONES 이름 그대로, 레스트 회전 항등(이동만).
JOINTS_0 = BONES 인덱스(UNSIGNED_BYTE), WEIGHTS_0 = FLOAT 합 1, inverseBindMatrices = translate(-관절 월드 위치).
COLOR_0 = 선형 RGB(float), NORMAL 포함, 인덱스는 정점 수에 따라 UNSIGNED_SHORT/UNSIGNED_INT.
"""

from __future__ import annotations

import numpy as np
import pygltflib as g

from .meshdata import MeshData
from .skeleton import BONES, PARENT_INDEX, SKELETON_ID, world_to_local_offsets

ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    v = vertices.astype(np.float64)
    fn = np.cross(v[faces[:, 1]] - v[faces[:, 0]], v[faces[:, 2]] - v[faces[:, 0]])
    n = np.zeros_like(v)
    for k in range(3):
        np.add.at(n, faces[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.where(ln > 1e-12, n / np.maximum(ln, 1e-12), [0.0, 1.0, 0.0])
    return n.astype(np.float32)


class _Builder:
    def __init__(self) -> None:
        self.blob = bytearray()
        self.views: list[g.BufferView] = []
        self.accessors: list[g.Accessor] = []

    def add(self, arr: np.ndarray, component: int, type_: str, target: int | None, minmax: bool = False, normalized: bool = False) -> int:
        while len(self.blob) % 4:
            self.blob.append(0)
        data = np.ascontiguousarray(arr).tobytes()
        self.views.append(g.BufferView(buffer=0, byteOffset=len(self.blob), byteLength=len(data), target=target))
        self.blob.extend(data)
        count = arr.shape[0] if type_ != "SCALAR" else arr.size
        acc = g.Accessor(bufferView=len(self.views) - 1, componentType=component, count=int(count), type=type_, normalized=normalized or None)
        if minmax:
            flat = arr.reshape(count, -1)
            acc.min = flat.min(0).astype(float).tolist()
            acc.max = flat.max(0).astype(float).tolist()
        self.accessors.append(acc)
        return len(self.accessors) - 1


def build_glb(mesh: MeshData, joints: np.ndarray, joint_idx: np.ndarray, joint_w: np.ndarray, extras: dict | None = None) -> bytes:
    """joint_idx/joint_w: (N,4) — rigid 는 (rigid,0,0,0)/(1,0,0,0) 로 넘긴다."""
    n = len(mesh.vertices)
    b = _Builder()
    pos = b.add(mesh.vertices.astype(np.float32), g.FLOAT, g.VEC3, ARRAY_BUFFER, minmax=True)
    nor = b.add(vertex_normals(mesh.vertices, mesh.faces), g.FLOAT, g.VEC3, ARRAY_BUFFER)
    col = b.add(srgb_to_linear(mesh.colors).astype(np.float32), g.FLOAT, g.VEC3, ARRAY_BUFFER)
    jnt = b.add(joint_idx.astype(np.uint8), g.UNSIGNED_BYTE, g.VEC4, ARRAY_BUFFER)
    w = joint_w.astype(np.float32)
    w = w / w.sum(1, keepdims=True)
    wts = b.add(w, g.FLOAT, g.VEC4, ARRAY_BUFFER)
    if n < 65536:
        idx = b.add(mesh.faces.astype(np.uint16).reshape(-1), g.UNSIGNED_SHORT, g.SCALAR, ELEMENT_ARRAY_BUFFER, minmax=True)
    else:
        idx = b.add(mesh.faces.astype(np.uint32).reshape(-1), g.UNSIGNED_INT, g.SCALAR, ELEMENT_ARRAY_BUFFER, minmax=True)
    ibm = np.tile(np.eye(4, dtype=np.float32), (len(BONES), 1, 1))
    ibm[:, :3, 3] = -joints
    # glTF 행렬은 열 우선(column-major) → 전치해서 기록
    ibm_acc = b.add(np.ascontiguousarray(ibm.transpose(0, 2, 1)).reshape(len(BONES), 16), g.FLOAT, g.MAT4, None)

    offsets = world_to_local_offsets(joints.astype(np.float64))
    bone_nodes = [
        g.Node(name=name, translation=[float(x) for x in offsets[i]], children=[j + 1 for j, p in enumerate(PARENT_INDEX) if p == i] or None)
        for i, name in enumerate(BONES)
    ]
    body = g.Node(name="Body", mesh=0, skin=0)
    gltf = g.GLTF2(
        asset=g.Asset(version="2.0", generator="mba-worker"),
        scene=0,
        scenes=[g.Scene(name="Character", nodes=[0, 1])],
        nodes=[body, *bone_nodes],
        meshes=[
            g.Mesh(
                name="Body",
                primitives=[
                    g.Primitive(
                        attributes=g.Attributes(POSITION=pos, NORMAL=nor, COLOR_0=col, JOINTS_0=jnt, WEIGHTS_0=wts),
                        indices=idx,
                        material=0,
                        mode=g.TRIANGLES,
                    )
                ],
            )
        ],
        materials=[
            g.Material(
                name="VertexColor",
                pbrMetallicRoughness=g.PbrMetallicRoughness(baseColorFactor=[1, 1, 1, 1], metallicFactor=0.0, roughnessFactor=0.8),
                doubleSided=False,
            )
        ],
        skins=[g.Skin(name=SKELETON_ID, joints=list(range(1, len(BONES) + 1)), skeleton=1, inverseBindMatrices=ibm_acc)],
        accessors=b.accessors,
        bufferViews=b.views,
        buffers=[g.Buffer(byteLength=len(b.blob))],
        extras={"skeleton": SKELETON_ID, **(extras or {})},
    )
    gltf.set_binary_blob(bytes(b.blob))
    return b"".join(gltf.save_to_bytes())


def rigid_to_vec4(rigid_idx: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    n = len(rigid_idx)
    idx = np.zeros((n, 4), dtype=np.uint8)
    idx[:, 0] = rigid_idx
    w = np.zeros((n, 4), dtype=np.float32)
    w[:, 0] = 1.0
    return idx, w

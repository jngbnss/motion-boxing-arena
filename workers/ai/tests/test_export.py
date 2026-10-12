import struct

import numpy as np
import pygltflib

from mba_worker.export_glb import build_glb, rigid_to_vec4
from mba_worker.rig import build_rig
from mba_worker.skeleton import BONES, PARENT
from mba_worker.thumbnail import render_thumbnail

COMPONENT_DTYPE = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
TYPE_SIZE = {"SCALAR": 1, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _read(gltf: pygltflib.GLTF2, blob: bytes, acc_index: int) -> np.ndarray:
    acc = gltf.accessors[acc_index]
    view = gltf.bufferViews[acc.bufferView]
    dtype = COMPONENT_DTYPE[acc.componentType]
    n = acc.count * TYPE_SIZE[acc.type]
    start = (view.byteOffset or 0) + (acc.byteOffset or 0)
    return np.frombuffer(blob, dtype=dtype, count=n, offset=start).reshape(acc.count, -1)


def test_glb_skin_structure(humanoid):
    mesh, _ = humanoid
    rig = build_rig(mesh)
    data = build_glb(rig.mesh, rig.joints, rig.smooth_idx, rig.smooth_w, {"tier": "T2"})
    assert data[:4] == b"glTF"
    version, length = struct.unpack("<II", data[4:12])
    assert version == 2 and length == len(data)
    gltf = pygltflib.GLTF2.load_from_bytes(data)
    blob = gltf.binary_blob()
    assert len(gltf.skins) == 1 and len(gltf.meshes) == 1
    skin = gltf.skins[0]
    names = [gltf.nodes[j].name for j in skin.joints]
    assert names == list(BONES)
    # 계층: 각 뼈 노드의 children 이 PARENT 와 일치, 레스트 회전 없음
    node_of = {gltf.nodes[j].name: j for j in skin.joints}
    for b in BONES:
        node = gltf.nodes[node_of[b]]
        assert node.rotation is None and node.matrix is None
        for c in node.children or []:
            assert PARENT[gltf.nodes[c].name] == b
    assert set(gltf.scenes[0].nodes) == {0, node_of["Hips"]}
    body = gltf.nodes[0]
    assert body.mesh == 0 and body.skin == 0
    prim = gltf.meshes[0].primitives[0]
    pos = _read(gltf, blob, prim.attributes.POSITION)
    joints = _read(gltf, blob, prim.attributes.JOINTS_0)
    weights = _read(gltf, blob, prim.attributes.WEIGHTS_0)
    color = _read(gltf, blob, prim.attributes.COLOR_0)
    idx = _read(gltf, blob, prim.indices)
    assert pos.shape == (len(rig.mesh.vertices), 3)
    assert joints.shape == weights.shape == (len(pos), 4)
    np.testing.assert_allclose(weights.sum(1), 1.0, atol=1e-5)
    assert joints.max() < len(BONES)
    assert color.min() >= 0 and color.max() <= 1
    assert idx.size == 3 * len(rig.mesh.faces)
    acc = gltf.accessors[prim.attributes.POSITION]
    assert abs((acc.max[1] - acc.min[1]) - 1.8) < 1e-3 and abs(acc.min[1]) < 1e-4
    # inverseBindMatrices = translate(-관절), 열 우선
    ibm = _read(gltf, blob, skin.inverseBindMatrices).reshape(-1, 4, 4).transpose(0, 2, 1)
    np.testing.assert_allclose(ibm[:, :3, 3], -rig.joints, atol=1e-6)
    np.testing.assert_allclose(ibm[:, :3, :3], np.tile(np.eye(3), (22, 1, 1)), atol=1e-7)
    # 노드 이동을 누적하면 관절 월드 위치가 된다
    world = {}
    for b in BONES:
        t = np.array(gltf.nodes[node_of[b]].translation)
        world[b] = t if PARENT[b] is None else world[PARENT[b]] + t
    np.testing.assert_allclose(np.array([world[b] for b in BONES]), rig.joints, atol=1e-5)
    assert gltf.extras["skeleton"] == "mba-humanoid-v1"


def test_rigid_vec4_and_thumbnail(humanoid):
    mesh, _ = humanoid
    rig = build_rig(mesh)
    idx, w = rigid_to_vec4(rig.rigid_idx)
    assert (w[:, 0] == 1).all() and (w[:, 1:] == 0).all()
    data = build_glb(rig.mesh, rig.joints, idx, w)
    gltf = pygltflib.GLTF2.load_from_bytes(data)
    assert len(gltf.skins[0].joints) == 22
    png = render_thumbnail(rig.mesh, size=128)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"

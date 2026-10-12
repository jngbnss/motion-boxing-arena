import numpy as np
import pytest
import trimesh

from mba_worker.errors import StageError
from mba_worker.meshdata import MeshData
from mba_worker.postprocess import MAX_TRIS, TRIPOSR_TO_GAME, decimate, normalize, postprocess


def _mesh(tm: trimesh.Trimesh, color=(0.5, 0.2, 0.1)) -> MeshData:
    return MeshData(np.asarray(tm.vertices), np.asarray(tm.faces), np.tile(color, (len(tm.vertices), 1)))


def test_triposr_axes_are_proper_rotation():
    assert np.linalg.det(TRIPOSR_TO_GAME) == pytest.approx(1.0)
    # TripoSR: +Z 위, +X 입력 카메라(정면), +Y 이미지 오른쪽 = 캐릭터 왼쪽
    np.testing.assert_array_equal(TRIPOSR_TO_GAME @ [0, 0, 1], [0, 1, 0])
    np.testing.assert_array_equal(TRIPOSR_TO_GAME @ [1, 0, 0], [0, 0, 1])
    np.testing.assert_array_equal(TRIPOSR_TO_GAME @ [0, 1, 0], [1, 0, 0])


def test_normalize_height_feet_center():
    box = trimesh.creation.box(extents=[0.3, 0.9, 0.2])
    box.apply_translation([5, 7, -3])
    m = normalize(_mesh(box))
    v = m.vertices
    assert v[:, 1].min() == pytest.approx(0.0, abs=1e-6)
    assert v[:, 1].max() == pytest.approx(1.8, abs=1e-5)
    assert (v[:, 0].min() + v[:, 0].max()) / 2 == pytest.approx(0.0, abs=1e-6)
    assert (v[:, 2].min() + v[:, 2].max()) / 2 == pytest.approx(0.0, abs=1e-6)
    assert v[:, 0].max() - v[:, 0].min() == pytest.approx(0.6, abs=1e-5)  # 비율 유지


def test_decimate_caps_triangles_and_keeps_colors():
    sphere = trimesh.creation.icosphere(subdivisions=6)  # 81920 tris
    colors = (np.asarray(sphere.vertices) + 1) / 2
    m = MeshData(np.asarray(sphere.vertices), np.asarray(sphere.faces), colors)
    d = decimate(m)
    assert len(d.faces) <= MAX_TRIS
    assert len(d.faces) > 10_000
    assert d.colors.shape == (len(d.vertices), 3)
    np.testing.assert_allclose(d.colors, (d.vertices + 1) / 2, atol=0.05)


def test_postprocess_removes_floaters_orients_and_normalizes():
    # TripoSR 좌표계(Z 위)의 세로로 긴 몸 + 작은 부유물
    body = trimesh.creation.capsule(height=1.0, radius=0.2, count=[24, 24])  # z 축
    floater = trimesh.creation.icosphere(subdivisions=1, radius=0.02)
    floater.apply_translation([0.5, 0.5, 0.5])
    raw = _mesh(trimesh.util.concatenate([body, floater]))
    out = postprocess(raw)
    v = out.vertices
    assert v[:, 1].max() - v[:, 1].min() == pytest.approx(1.8, abs=1e-4)
    assert v[:, 1].min() == pytest.approx(0.0, abs=1e-6)
    # 부유물 제거: 정점 수가 몸 하나와 같고, 높이 축이 Y 로 바뀌었다
    assert len(out.faces) == len(body.faces)
    assert np.ptp(v[:, 1]) > 2 * np.ptp(v[:, 0])
    tm = trimesh.Trimesh(v, out.faces, process=False)
    assert tm.volume > 0  # 바깥을 향하는 감김


def test_postprocess_rejects_empty():
    with pytest.raises(StageError) as e:
        postprocess(MeshData(np.zeros((0, 3)), np.zeros((0, 3), int), np.zeros((0, 3))))
    assert e.value.code == "MESH_EMPTY" and e.value.retryable

import io
import json

import numpy as np
import pygltflib
from PIL import Image

from conftest import make_connected_humanoid
from mba_worker.generate import GenerationResult
from mba_worker.meshdata import MeshData
from mba_worker.palette import extract_palette
from mba_worker.pipeline import GLB_ARTIFACT, JobSpec, LocalStore, Pipeline, plan_start
from mba_worker.postprocess import TRIPOSR_TO_GAME
from mba_worker.validate import check_rigid, choose_binding
from mba_worker.rig import build_rig


class SyntheticBackend:
    """테스트 대역: TripoSR 좌표계로 합성 휴머노이드를 돌려준다 (GPU 없이 파이프라인 후반부 검증)."""

    name = "synthetic"
    version = "test"

    def __init__(self) -> None:
        mesh = make_connected_humanoid(60.0)
        self.mesh = MeshData(mesh.vertices @ TRIPOSR_TO_GAME, mesh.faces, mesh.colors)  # 게임 → TripoSR 역변환

    def load(self) -> None:
        pass

    def generate(self, rgba, seed, progress=None):
        return GenerationResult(self.mesh, {"forward": 0.0}, None)


def _seed_preprocess(store: LocalStore, humanoid: bool = True) -> None:
    img = Image.new("RGBA", (64, 64), (200, 50, 40, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    store.put("preprocessed.png", buf.getvalue())
    store.put("preprocess.json", json.dumps({"humanoid": humanoid, "palette": ["#c83228"]}).encode())


def test_plan_start_falls_back_to_missing_producer(tmp_path):
    store = LocalStore(tmp_path)
    assert plan_start("RIGGING", store) == 0  # 아무 산출물도 없음 → 처음부터
    _seed_preprocess(store)
    assert plan_start("GENERATING", store) == 1
    assert plan_start("RIGGING", store) == 1  # generated.npz·normalized.npz 없음
    store.put("generated.npz", b"x")
    store.put("generate.json", b"{}")
    store.put("normalized.npz", b"x")
    assert plan_start("RIGGING", store) == 3
    assert plan_start("EXPORTING", store) == 3  # rig.npz·validation.json 없음


def test_pipeline_from_generating_produces_skinned_glb(tmp_path):
    store = LocalStore(tmp_path)
    _seed_preprocess(store)
    progress: list[tuple[str, float]] = []
    result = Pipeline(SyntheticBackend(), lambda s, p: progress.append((s, p))).run(JobSpec("job_test", lambda: b"", resume_stage="GENERATING"), store)
    c = result.complete
    assert c["tier"] in ("T1", "T2") and c["rigger"] in ("smooth", "rigid")
    assert (c["tier"] == "T2") == (c["rigger"] == "smooth")
    assert c["glbArtifact"] == GLB_ARTIFACT and c["thumbnailArtifact"] == "thumbnail.png"
    assert c["assetMeta"]["bones"] == 22 and c["assetMeta"]["tris"] <= 20_000
    assert c["palette"] == ["#c83228"]
    assert [s for s, p in progress if p == 1.0] == ["GENERATING", "POSTPROCESSING", "RIGGING", "VALIDATING", "EXPORTING"]
    glb = store.get(GLB_ARTIFACT)
    assert c["assetMeta"]["glbBytes"] == len(glb)
    gltf = pygltflib.GLTF2.load_from_bytes(glb)
    assert len(gltf.skins[0].joints) == 22
    # 재개: EXPORTING 만 다시 돌려도 같은 결과
    again = Pipeline(SyntheticBackend()).run(JobSpec("job_test", lambda: b"", resume_stage="EXPORTING"), store)
    assert again.complete["tier"] == c["tier"]
    assert list(again.timings) == ["EXPORTING"]


def test_validation_on_synthetic_humanoid(humanoid):
    mesh, _ = humanoid
    rig = build_rig(mesh)
    rigid = check_rigid(rig)
    assert rigid["pass"], rigid["problems"]
    binding = choose_binding(rig, humanoid=True, prefer_tier=None)
    report = binding.report
    assert report["pass"] and report["tier"] in ("T1", "T2")
    assert set(report["smooth"][0]["poses"]) == {"arm_raise_90", "head_turn_60", "elbow_bend_90", "jab"}
    assert binding.joint_idx.shape == binding.joint_w.shape == (len(rig.mesh.vertices), 4)
    np.testing.assert_allclose(binding.joint_w.sum(1), 1.0, atol=1e-5)
    # 비휴머노이드·T1 선호 → smooth 를 시도하지 않는다 (rigid: 정점당 뼈 1개)
    for b in (choose_binding(rig, humanoid=False, prefer_tier=None), choose_binding(rig, humanoid=True, prefer_tier="T1")):
        assert b.report["tier"] == "T1" and "smooth" not in b.report
        assert (b.joint_w[:, 0] == 1).all() and (b.joint_w[:, 1:] == 0).all()


def test_check_rigid_rejects_scrambled_skeleton(humanoid):
    mesh, _ = humanoid
    rig = build_rig(mesh)
    rig.joints = rig.joints[::-1].copy()  # 관절 순서 뒤섞기 → 높이 순서 위반
    assert not check_rigid(rig)["pass"]


def test_palette_finds_dominant_colors():
    arr = np.zeros((100, 100, 4), np.uint8)
    arr[:70, :, :3] = (255, 0, 0)
    arr[70:, :, :3] = (0, 0, 255)
    arr[..., 3] = 255
    arr[:5, :5, 3] = 0  # 투명 픽셀 제외
    pal = extract_palette(Image.fromarray(arr, "RGBA"))
    assert pal[0] == "#ff0000" and pal[1] == "#0000ff"

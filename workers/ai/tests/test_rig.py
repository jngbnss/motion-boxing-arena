import numpy as np
import pytest

from conftest import make_humanoid
from mba_worker.rig import (
    arm_angle_deg,
    build_rig,
    fit_joints,
    limit_influences,
    rigid_weights,
    rot,
    skinning_matrices,
    smooth_weights,
    apply_skin,
)
from mba_worker.skeleton import BONE_INDEX, BONES, PARENT, PARENT_INDEX, world_to_local_offsets


def test_skeleton_matches_shared_contract():
    assert len(BONES) == 22
    assert BONES[0] == "Hips" and PARENT["Hips"] is None
    for i, b in enumerate(BONES):
        p = PARENT_INDEX[i]
        assert p < i, f"{b} 부모가 먼저 나와야 한다"
    chain = ["Head", "Neck", "Spine2", "Spine1", "Spine", "Hips"]
    for c, p in zip(chain, chain[1:]):
        assert PARENT[c] == p


def test_fit_joints_close_to_truth(humanoid):
    mesh, truth = humanoid
    joints, meta = fit_joints(mesh)
    assert joints.shape == (22, 3)
    assert meta["legsSplit"]
    for name, tol in [("Hips", 0.08), ("Neck", 0.06), ("Head", 0.06), ("LeftUpLeg", 0.08), ("RightUpLeg", 0.08),
                      ("LeftLeg", 0.06), ("RightLeg", 0.06), ("LeftFoot", 0.06), ("RightFoot", 0.06),
                      ("LeftArm", 0.08), ("RightArm", 0.08), ("LeftHand", 0.08), ("RightHand", 0.08)]:
        err = float(np.linalg.norm(joints[BONE_INDEX[name]] - truth[name]))
        assert err < tol, f"{name} 오차 {err:.3f} m"
    # 왼쪽 = +X
    assert joints[BONE_INDEX["LeftHand"], 0] > 0 > joints[BONE_INDEX["RightHand"], 0]
    assert joints[BONE_INDEX["LeftToeBase"], 2] > joints[BONE_INDEX["LeftFoot"], 2]


def test_limit_influences_normalizes_and_caps():
    rng = np.random.default_rng(1)
    w = rng.random((500, 22)) ** 4
    w[0] = 0.0  # 모든 가중치 0 → Hips 1.0 으로 대체
    idx, top = limit_influences(w)
    assert idx.shape == (500, 4) and top.shape == (500, 4)
    np.testing.assert_allclose(top.sum(1), 1.0, atol=1e-6)
    assert (top >= 0).all()
    assert idx[0, 0] == 0 and top[0, 0] == 1.0
    # 상위 1개는 원래 최댓값 뼈
    np.testing.assert_array_equal(idx[1:, 0], w[1:].argmax(1))


def test_smooth_and_rigid_weights(humanoid):
    mesh, _ = humanoid
    joints, meta = fit_joints(mesh)
    idx, w = smooth_weights(mesh, joints, meta["torsoHalfWidth"])
    np.testing.assert_allclose(w.sum(1), 1.0, atol=1e-5)
    assert ((w > 0).sum(1) <= 4).all()
    assert idx.max() < 22
    rigid = rigid_weights(mesh, joints, meta["torsoHalfWidth"])
    v = mesh.vertices
    # 머리 꼭대기 정점은 Head, 왼손 끝 정점은 왼팔 체인
    top = int(np.argmax(v[:, 1]))
    assert rigid[top] == BONE_INDEX["Head"]
    assert idx[top, 0] == BONE_INDEX["Head"] and w[top, 0] == pytest.approx(1.0)
    left_tip = int(np.argmax(v[:, 0]))
    assert BONES[rigid[left_tip]] in ("LeftForeArm", "LeftHand")
    foot = int(np.argmin(v[:, 1] + np.where(v[:, 0] > 0, 0, 10)))
    assert BONES[rigid[foot]] in ("LeftFoot", "LeftToeBase")


def test_skinning_identity_and_rotation(humanoid):
    mesh, _ = humanoid
    joints, meta = fit_joints(mesh)
    idx, w = smooth_weights(mesh, joints, meta["torsoHalfWidth"])
    mats, posed = skinning_matrices(joints.astype(np.float64), {})
    np.testing.assert_allclose(apply_skin(mesh.vertices, idx, w, mats), mesh.vertices, atol=1e-5)
    np.testing.assert_allclose(posed, joints, atol=1e-6)
    mats, posed = skinning_matrices(joints.astype(np.float64), {"LeftArm": rot([0, 0, 1], 90)})
    arm, hand = joints[BONE_INDEX["LeftArm"]], joints[BONE_INDEX["LeftHand"]]
    expected = arm + rot([0, 0, 1], 90) @ (hand - arm)
    np.testing.assert_allclose(posed[BONE_INDEX["LeftHand"]], expected, atol=1e-5)
    np.testing.assert_allclose(posed[BONE_INDEX["RightHand"]], joints[BONE_INDEX["RightHand"]], atol=1e-6)


@pytest.mark.parametrize("arm_deg", [20.0, 45.0, 70.0])
def test_build_rig_reposes_arms_to_a_pose(arm_deg):
    mesh, _ = make_humanoid(arm_deg)
    rig = build_rig(mesh)
    for side in ("Left", "Right"):
        assert arm_angle_deg(rig.joints, side) == pytest.approx(45.0, abs=3.0)
    if arm_deg == 45.0:
        assert abs(rig.meta["leftArmDeg"] - 45.0) < 8.0 and abs(rig.meta["rightArmDeg"] - 45.0) < 8.0
    else:
        assert rig.meta["reposed"]
    assert rig.mesh.vertices.shape == mesh.vertices.shape
    v = rig.mesh.vertices
    assert v[:, 1].min() == pytest.approx(0.0, abs=1e-5) and np.ptp(v[:, 1]) == pytest.approx(1.8, abs=1e-4)
    np.testing.assert_allclose(rig.smooth_w.sum(1), 1.0, atol=1e-5)
    # 레스트 오프셋 = 관절 차이 (회전 항등)
    off = world_to_local_offsets(rig.joints.astype(np.float64))
    np.testing.assert_allclose(off[BONE_INDEX["LeftForeArm"]], rig.joints[BONE_INDEX["LeftForeArm"]] - rig.joints[BONE_INDEX["LeftArm"]], atol=1e-6)

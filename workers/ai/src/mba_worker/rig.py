"""RIGGING: 템플릿 맞춤 관절 배치 + A-pose 재포즈 + smooth/rigid 가중치.

관절 배치(docs/04 §3.C "템플릿 맞춤"): 정규화된 메쉬(키 1.8m, +Y up, 정면 +Z)의 정면 실루엣에서
높이별 단면(가랑이·목·어깨)과 팔 끝을 찾고, 각 관절의 z 는 그 높이의 메쉬 단면 중앙으로 둔다.
가중치: 뼈 세그먼트까지의 거리를 뼈 굵기로 나눈 정규 거리 기반.
- smooth: 가우시안 감쇠 + 골격 그래프 2홉 이내 뼈만 + 메쉬 이웃 평활 + 머리 영역 Head 고정, 정점당 ≤4 영향.
- rigid: 정규 거리 최소 뼈 하나(가중치 1), 이웃 다수결로 잡음 제거.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp
from PIL import Image, ImageDraw

from .meshdata import MeshData, RigData
from .skeleton import A_POSE_ARM_DEG, ARM_CHAINS, BONE_INDEX, BONES, PARENT_INDEX, SEGMENT_CHILD

PIXEL = 0.0075  # 실루엣 래스터 해상도 (m/px)
MAX_INFLUENCES = 4


@dataclass
class Silhouette:
    mask: np.ndarray  # (rows, cols) bool, row 0 = 최저 y
    x0: float
    y0: float

    def row_of(self, y: float) -> int:
        return int(np.clip((y - self.y0) / PIXEL, 0, self.mask.shape[0] - 1))

    def col_of(self, x: float) -> int:
        return int(np.clip((x - self.x0) / PIXEL, 0, self.mask.shape[1] - 1))

    def x_of(self, col: float) -> float:
        return self.x0 + (col + 0.5) * PIXEL

    def y_of(self, row: float) -> float:
        return self.y0 + (row + 0.5) * PIXEL

    def runs(self, row: int) -> list[tuple[int, int]]:
        """채워진 구간 [start, end] (열 인덱스, 포함)."""
        r = self.mask[row].astype(np.int8)
        d = np.diff(np.concatenate([[0], r, [0]]))
        starts = np.flatnonzero(d == 1)
        ends = np.flatnonzero(d == -1) - 1
        return list(zip(starts.tolist(), ends.tolist()))

    def run_at(self, row: int, col: int) -> tuple[int, int] | None:
        for s, e in self.runs(row):
            if s <= col <= e:
                return s, e
        return None


def front_silhouette(m: MeshData) -> Silhouette:
    v = m.vertices
    x0, y0 = float(v[:, 0].min()) - 2 * PIXEL, float(v[:, 1].min()) - 2 * PIXEL
    cols = int(math.ceil((v[:, 0].max() - x0) / PIXEL)) + 3
    rows = int(math.ceil((v[:, 1].max() - y0) / PIXEL)) + 3
    img = Image.new("1", (cols, rows), 0)
    draw = ImageDraw.Draw(img)
    px = (v[:, 0] - x0) / PIXEL
    py = (v[:, 1] - y0) / PIXEL
    for f in m.faces:
        draw.polygon([(px[i], py[i]) for i in f], fill=1, outline=1)
    return Silhouette(np.asarray(img, dtype=bool), x0, y0)


def _z_mid(v: np.ndarray, sel: np.ndarray, fallback: float) -> float:
    if sel.sum() < 3:
        return fallback
    z = v[sel, 2]
    return float((np.percentile(z, 5) + np.percentile(z, 95)) / 2)


def _section_z(v: np.ndarray, x: float, y: float, r: float, fallback: float) -> float:
    sel = (np.abs(v[:, 0] - x) < r) & (np.abs(v[:, 1] - y) < r)
    return _z_mid(v, sel, fallback)


# MediaPipe Pose 랜드마크 인덱스 (사람 기준 좌/우)
LM = {
    "LeftArm": 11, "RightArm": 12, "LeftForeArm": 13, "RightForeArm": 14, "LeftHand": 15, "RightHand": 16,
    "LeftUpLeg": 23, "RightUpLeg": 24, "LeftLeg": 25, "RightLeg": 26, "LeftFoot": 27, "RightFoot": 28,
}
LM_VISIBILITY_MIN = 0.5


@dataclass
class PoseHint:
    """전처리 이미지의 2D 포즈 랜드마크 → 메쉬 정면(x, y) 투영 (docs/04 §2 "2D 포즈 랜드마크 투영").

    전처리 이미지의 전경 bbox 와 메쉬 정면 실루엣 bbox 를 대응시킨다. 이미지 오른쪽 = 캐릭터 왼쪽 = +X.
    """

    landmarks: np.ndarray  # (33, 3) u, v (0..1, 이미지 정규 좌표), visibility
    fg_box: tuple[float, float, float, float]  # u0, v0, u1, v1

    @staticmethod
    def from_info(info: dict | None) -> PoseHint | None:
        pose = (info or {}).get("pose")
        if not pose or not pose.get("landmarks") or not pose.get("fgBox"):
            return None
        lms = np.asarray(pose["landmarks"], dtype=np.float64)
        if lms.shape != (33, 3):
            return None
        return PoseHint(lms, tuple(pose["fgBox"]))

    def project(self, idx: int, sil: Silhouette, lo: np.ndarray, hi: np.ndarray) -> np.ndarray | None:
        u, v, vis = self.landmarks[idx]
        if vis < LM_VISIBILITY_MIN:
            return None
        u0, v0, u1, v1 = self.fg_box
        x = lo[0] + (u - u0) / max(u1 - u0, 1e-6) * (hi[0] - lo[0])
        y = hi[1] - (v - v0) / max(v1 - v0, 1e-6) * (hi[1] - lo[1])
        r, c = sil.row_of(y), sil.col_of(x)
        win = sil.mask[max(r - 4, 0) : r + 5, max(c - 4, 0) : c + 5]
        return np.array([x, y]) if win.any() else None  # 실루엣 밖이면 믿지 않는다


def fit_joints(m: MeshData, pose: PoseHint | None = None) -> tuple[np.ndarray, dict]:
    """정면 실루엣 + 단면 휴리스틱(+ 있으면 2D 포즈 랜드마크)으로 22 관절 월드 위치를 추정한다."""
    v = m.vertices.astype(np.float64)
    sil = front_silhouette(m)
    lo, hi = v.min(0), v.max(0)
    top, bottom = float(hi[1]), float(lo[1])
    height = top - bottom
    lm: dict[str, np.ndarray] = {}
    if pose is not None:
        for name, i in LM.items():
            p = pose.project(i, sil, lo, hi)
            if p is not None:
                lm[name] = p
        # 뒤돌아선 그림 등으로 좌우가 뒤집힌 경우 교환
        if "LeftArm" in lm and "RightArm" in lm and lm["LeftArm"][0] < lm["RightArm"][0]:
            lm = {(k.replace("Left", "#").replace("Right", "Left").replace("#", "Right")): p for k, p in lm.items()}
    # 몸 중심 x: 높이 45~65% 띠의 실루엣 중앙값
    band = sil.mask[sil.row_of(bottom + 0.45 * height) : sil.row_of(bottom + 0.65 * height) + 1]
    cols = np.nonzero(band)[1]
    xc_col = int(np.median(cols)) if len(cols) else sil.col_of(0.0)
    xc = sil.x_of(xc_col)
    z_body = _z_mid(v, np.abs(v[:, 1] - (bottom + 0.55 * height)) < 0.05, 0.0)

    # 가랑이: 높이 60%에서 아래로 내려가며 중심 열이 처음 비는 지점
    crotch = None
    for row in range(sil.row_of(bottom + 0.6 * height), sil.row_of(bottom + 0.15 * height), -1):
        if not sil.mask[row, xc_col]:
            crotch = sil.y_of(row) + PIXEL / 2
            break
    legs_split = crotch is not None
    if crotch is None:
        crotch = bottom + 0.45 * height
    if "LeftUpLeg" in lm and "RightUpLeg" in lm:
        # 골반 랜드마크(고관절)보다 가랑이가 높을 수는 없다
        crotch = min(crotch, float(min(lm["LeftUpLeg"][1], lm["RightUpLeg"][1])))

    # 목: 가랑이~머리꼭대기의 40~92% 띠에서 중심 구간 폭이 가장 좁은 높이
    def torso_width(row: int) -> int:
        run = sil.run_at(row, xc_col)
        return (run[1] - run[0] + 1) if run else 10**6

    span = top - crotch
    rows = range(sil.row_of(crotch + 0.40 * span), sil.row_of(crotch + 0.92 * span) + 1)
    widths = np.array([torso_width(r) for r in rows])
    if len(widths):
        # 가장 좁은 폭(+1px 허용) 연속 구간의 가운데 = 목 중간
        first = int(np.argmin(widths))
        limit = widths[first] + 1
        end = first
        while end + 1 < len(widths) and widths[end + 1] <= limit:
            end += 1
        narrow_row = rows[(first + end) // 2]
    else:
        narrow_row = sil.row_of(crotch + 0.66 * span)
    narrow = sil.y_of(narrow_row)
    head_h = top - narrow
    neck_y = narrow - 0.15 * head_h
    head_y = narrow + 0.10 * head_h
    if "LeftArm" in lm and "RightArm" in lm:
        neck_y = max(neck_y, float(max(lm["LeftArm"][1], lm["RightArm"][1])) + 0.02 * height)
        head_y = max(head_y, neck_y + 0.03 * height)
    torso_len = neck_y - crotch

    # 몸통 반폭: 겨드랑이 아래 가슴 높이 (A-pose 에서 팔과 분리된 구간)
    chest_row = sil.row_of(neck_y - 0.35 * torso_len)
    run = sil.run_at(chest_row, xc_col)
    hw = (run[1] - run[0] + 1) * PIXEL / 2 if run else 0.15 * height / 1.8
    if "LeftArm" in lm and "RightArm" in lm:
        # 어깨 랜드마크는 팔 중심선 위 → 몸통 반폭은 그보다 팔 반지름만큼 좁다 (팔이 붙어 있으면 실루엣 폭이 과대)
        hw = min(hw, 0.85 * float(lm["LeftArm"][0] - lm["RightArm"][0]) / 2)
    hw = float(np.clip(hw, 0.04 * height, 0.2 * height))

    J = np.zeros((len(BONES), 3), dtype=np.float64)

    def setj(name: str, x: float, y: float, z: float) -> None:
        J[BONE_INDEX[name]] = (x, y, z)

    # 골반·척추: 고관절 랜드마크가 있으면 그 위, 없으면 가랑이 기준
    if "LeftUpLeg" in lm and "RightUpLeg" in lm:
        upleg_y = float((lm["LeftUpLeg"][1] + lm["RightUpLeg"][1]) / 2)
        hips_y = upleg_y + 0.07 * (neck_y - upleg_y)
    else:
        hips_y = crotch + 0.19 * torso_len
        upleg_y = crotch + 0.6 * (hips_y - crotch)
    setj("Hips", xc, hips_y, _z_mid(v, (np.abs(v[:, 1] - hips_y) < 0.03) & (np.abs(v[:, 0] - xc) < 0.6 * hw), z_body))
    for name, f in {"Spine": 0.2, "Spine1": 0.48, "Spine2": 0.76}.items():
        y = hips_y + f * (neck_y - hips_y)
        sel = (np.abs(v[:, 1] - y) < 0.03) & (np.abs(v[:, 0] - xc) < 0.6 * hw)
        setj(name, xc, y, _z_mid(v, sel, z_body))
    neck_sel = (np.abs(v[:, 1] - neck_y) < 0.03) & (np.abs(v[:, 0] - xc) < 0.5 * hw)
    setj("Neck", xc, neck_y, _z_mid(v, neck_sel, z_body))
    setj("Head", xc, head_y, _z_mid(v, v[:, 1] > narrow, z_body))

    meta: dict = {
        "crotchY": crotch, "neckNarrowY": narrow, "torsoHalfWidth": hw, "centerX": xc, "legsSplit": legs_split,
        "landmarks": sorted(lm),
    }
    torso_run = lambda y: sil.run_at(sil.row_of(y), xc_col)  # noqa: E731
    for side, sign in (("Left", 1.0), ("Right", -1.0)):
        if f"{side}Arm" in lm:
            arm_x, arm_y = (float(c) for c in lm[f"{side}Arm"])
        else:
            arm_x, arm_y = xc + sign * 0.9 * hw, neck_y - 0.10 * torso_len
        arm_z = _section_z(v, arm_x, arm_y, 0.06, z_body)
        setj(f"{side}Shoulder", xc + 0.22 * (arm_x - xc), arm_y, arm_z)
        setj(f"{side}Arm", arm_x, arm_y, arm_z)
        origin = np.array([arm_x, arm_y])
        if f"{side}Hand" in lm:
            wrist = lm[f"{side}Hand"]
            elbow = lm.get(f"{side}ForeArm", origin + 0.55 * (wrist - origin))
            run = torso_run(float(wrist[1]))
            # 손목이 몸통 실루엣 구간 안에 있으면 팔이 몸에 붙어 있다
            arms_free = not (run and sil.x_of(run[0]) <= wrist[0] <= sil.x_of(run[1]))
            tip = wrist + 0.22 * (wrist - elbow)
        else:
            lateral = sign * (v[:, 0] - xc) > 1.15 * hw
            vert_band = (v[:, 1] > crotch - 0.3 * torso_len) & (v[:, 1] < neck_y + 0.05 * torso_len)
            cand = v[lateral & vert_band]
            if len(cand) >= 20:
                d = np.linalg.norm(cand[:, :2] - origin, axis=1)
                tip = cand[int(np.argmax(d)), :2]
                arms_free = True
            else:
                # 팔이 몸통에 붙음: 몸통 옆으로 곧게 내린 것으로 가정 (팔 길이 ≈ 키의 0.42)
                tip = origin + np.array([sign * 0.1, -1.0]) / np.hypot(0.1, 1.0) * 0.42 * height
                arms_free = False
            vec = tip - origin
            elbow, wrist = origin + 0.45 * vec, origin + 0.82 * vec
        meta[f"{side.lower()}ArmFree"] = bool(arms_free)
        meta[f"{side.lower()}ArmTip"] = [float(tip[0]), float(tip[1])]
        for name, (x, y) in ((f"{side}ForeArm", elbow), (f"{side}Hand", wrist)):
            setj(name, float(x), float(y), _section_z(v, float(x), float(y), 0.05, arm_z))

    # 다리
    for side, sign in (("Left", 1.0), ("Right", -1.0)):
        def leg_x(y: float, default: float) -> float:
            row = sil.row_of(y)
            runs = [(s, e) for s, e in sil.runs(row) if sign * (sil.x_of((s + e) / 2) - xc) > 0]
            spanning = sil.run_at(row, xc_col)
            if runs:
                s, e = min(runs, key=lambda r: abs(sil.x_of((r[0] + r[1]) / 2) - default))
                return sil.x_of((s + e) / 2)
            if spanning:
                edge = sil.x_of(spanning[1] if sign > 0 else spanning[0])
                return (xc + edge) / 2
            return default

        thigh = lm.get(f"{side}UpLeg")
        thigh_x = float(thigh[0]) if thigh is not None else leg_x(crotch - 0.05 * crotch, xc + sign * 0.55 * hw)
        knee = lm.get(f"{side}Leg")
        knee_x, knee_y = (float(knee[0]), float(knee[1])) if knee is not None else (None, bottom + 0.54 * (upleg_y - bottom))
        if knee_x is None:
            knee_x = leg_x(knee_y, thigh_x)
        ankle = lm.get(f"{side}Foot")
        ankle_x, ankle_y = (float(ankle[0]), float(ankle[1])) if ankle is not None else (None, bottom + 0.095 * (upleg_y - bottom))
        if ankle_x is None:
            ankle_x = leg_x(ankle_y, knee_x)
        # 순서 보정: 고관절 > 무릎 > 발목 > 바닥
        ankle_y = float(np.clip(ankle_y, bottom + 0.02 * height, upleg_y - 0.1 * height))
        knee_y = float(np.clip(knee_y, ankle_y + 0.04 * height, upleg_y - 0.04 * height))
        setj(f"{side}UpLeg", thigh_x, upleg_y, _section_z(v, thigh_x, upleg_y, 0.06, z_body))
        setj(f"{side}Leg", knee_x, knee_y, _section_z(v, knee_x, knee_y, 0.05, z_body))
        ankle_z = _section_z(v, ankle_x, ankle_y, 0.05, z_body)
        setj(f"{side}Foot", ankle_x, ankle_y, ankle_z)
        foot_sel = (v[:, 1] < bottom + 0.6 * (ankle_y - bottom) + 0.03 * height) & (sign * (v[:, 0] - xc) > 0)
        front_z = float(np.percentile(v[foot_sel, 2], 98)) if foot_sel.sum() > 3 else ankle_z + 0.1
        setj(f"{side}ToeBase", ankle_x, bottom + 0.3 * (ankle_y - bottom), ankle_z + 0.6 * (front_z - ankle_z))
    meta["top"] = top
    return J.astype(np.float32), meta


# ── 세그먼트 거리·가중치 ──────────────────────────────────────────────────────────────


def segment_ends(joints: np.ndarray, top: float) -> np.ndarray:
    """각 뼈 세그먼트의 끝점 (자식 관절, 말단은 연장)."""
    ends = np.zeros_like(joints, dtype=np.float64)
    for i, b in enumerate(BONES):
        child = SEGMENT_CHILD[b]
        if child is not None:
            ends[i] = joints[BONE_INDEX[child]]
        elif b == "Head":
            ends[i] = (joints[i, 0], top, joints[i, 2])
        elif b.endswith("Hand"):
            p = joints[PARENT_INDEX[i]]
            ends[i] = joints[i] + 0.5 * (joints[i] - p)
        else:  # ToeBase
            ends[i] = joints[i] + np.array([0.0, 0.0, 0.06])
    return ends


def bone_radii(joints: np.ndarray, top: float, torso_hw: float) -> np.ndarray:
    """정규 거리용 뼈 굵기 (m). 몸통은 실루엣 반폭, 나머지는 키 1.8m 기준 템플릿."""
    tpl = {
        "Hips": torso_hw, "Spine": torso_hw, "Spine1": torso_hw, "Spine2": torso_hw,
        "Neck": 0.06, "Head": max(0.08, 0.45 * (top - joints[BONE_INDEX["Head"], 1])),
        "Shoulder": 0.07, "Arm": 0.06, "ForeArm": 0.05, "Hand": 0.05,
        "UpLeg": 0.09, "Leg": 0.07, "Foot": 0.09, "ToeBase": 0.07,
    }
    out = np.zeros(len(BONES))
    for i, b in enumerate(BONES):
        key = b.removeprefix("Left").removeprefix("Right")
        out[i] = tpl[key]
    return out


def segment_distances(points: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """points (N,3) 와 세그먼트 a[i]→b[i] (S,3) 사이 거리 (N,S)."""
    ab = b - a
    ap = points[:, None, :] - a[None, :, :]
    denom = np.maximum((ab * ab).sum(-1), 1e-12)
    t = np.clip((ap * ab[None]).sum(-1) / denom, 0.0, 1.0)
    closest = a[None] + t[..., None] * ab[None]
    return np.linalg.norm(points[:, None, :] - closest, axis=-1)


def _hop_matrix() -> np.ndarray:
    n = len(BONES)
    hop = np.full((n, n), 99, dtype=np.int32)
    adj = [[] for _ in range(n)]
    for i, p in enumerate(PARENT_INDEX):
        if p >= 0:
            adj[i].append(int(p))
            adj[int(p)].append(i)
    for s in range(n):
        hop[s, s] = 0
        frontier = [s]
        while frontier:
            nxt = []
            for u in frontier:
                for w in adj[u]:
                    if hop[s, w] > hop[s, u] + 1:
                        hop[s, w] = hop[s, u] + 1
                        nxt.append(w)
            frontier = nxt
    return hop


HOPS = _hop_matrix()


def vertex_adjacency(n: int, faces: np.ndarray) -> sp.csr_matrix:
    """행 정규화된 정점 인접 행렬 (자기 자신 포함)."""
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1], np.stack([np.arange(n), np.arange(n)], 1)])
    a = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    a.data[:] = 1.0
    deg = np.asarray(a.sum(1)).ravel()
    return sp.diags(1.0 / deg) @ a


def normalized_distances(m: MeshData, joints: np.ndarray, torso_hw: float, refine: int = 2) -> np.ndarray:
    """세그먼트 거리 / 뼈 굵기. 굵기는 템플릿에서 시작해, 각 뼈에 배정된 정점의 거리 중앙값으로 다듬는다
    (팔이 굵은 만화 캐릭터에서 팔 정점이 몸통으로 끌려가지 않게)."""
    top = float(m.vertices[:, 1].max())
    ends = segment_ends(joints.astype(np.float64), top)
    d = segment_distances(m.vertices.astype(np.float64), joints.astype(np.float64), ends)
    # 발목보다 낮은 정점(발뒤꿈치·발바닥)은 정강이 뼈에 붙이지 않는다
    for side in ("Left", "Right"):
        below = m.vertices[:, 1] < joints[BONE_INDEX[f"{side}Foot"], 1]
        d[below, BONE_INDEX[f"{side}Leg"]] += 10.0
    radii = bone_radii(joints, top, torso_hw)
    for _ in range(refine):
        labels = (d / radii[None]).argmin(1)
        for b in range(len(BONES)):
            mine = d[labels == b, b]
            if len(mine) >= 20:
                radii[b] = float(np.clip(np.median(mine), 0.5 * radii[b], 2.0 * radii[b]))
    return d / radii[None]


def limit_influences(w: np.ndarray, k: int = MAX_INFLUENCES, min_w: float = 0.01) -> tuple[np.ndarray, np.ndarray]:
    """밀집 가중치 (N,B) → 상위 k 개 (idx uint8, w float32 합 1)."""
    idx = np.argsort(-w, axis=1)[:, :k]
    top = np.take_along_axis(w, idx, axis=1)
    top = np.where(top < min_w, 0.0, top)
    s = top.sum(1, keepdims=True)
    bad = s[:, 0] <= 0
    top[bad] = [1.0] + [0.0] * (k - 1)
    s[bad] = 1.0
    top = top / s
    idx = np.where(top > 0, idx, 0)
    return idx.astype(np.uint8), top.astype(np.float32)


def smooth_weights(m: MeshData, joints: np.ndarray, torso_hw: float, sigma: float = 0.35, smooth_iters: int = 3) -> tuple[np.ndarray, np.ndarray]:
    dn = normalized_distances(m, joints, torso_hw)
    nearest = dn.argmin(1)
    dmin = dn[np.arange(len(dn)), nearest]
    w = np.exp(-(((dn - dmin[:, None]) / sigma) ** 2))
    w *= HOPS[nearest] <= 2  # 다른 팔다리로 번지지 않게 골격 2홉 이내만
    if smooth_iters:
        adj = vertex_adjacency(len(m.vertices), m.faces)
        for _ in range(smooth_iters):
            w = adj @ w
    # 머리 영역 고정: Head 관절 위·머리 뼈가 가장 가까운 정점은 Head 단독
    hi = BONE_INDEX["Head"]
    head_lock = (nearest == hi) & (m.vertices[:, 1] > joints[hi, 1])
    w[head_lock] = 0.0
    w[head_lock, hi] = 1.0
    return limit_influences(w)


def rigid_weights(m: MeshData, joints: np.ndarray, torso_hw: float, vote_iters: int = 2) -> np.ndarray:
    dn = normalized_distances(m, joints, torso_hw)
    labels = dn.argmin(1)
    if vote_iters:
        adj = vertex_adjacency(len(m.vertices), m.faces)
        for _ in range(vote_iters):
            onehot = sp.csr_matrix((np.ones(len(labels)), (np.arange(len(labels)), labels)), shape=(len(labels), len(BONES)))
            labels = np.asarray((adj @ onehot).argmax(1)).ravel()
    return labels.astype(np.uint8)


# ── 포즈·스키닝 ───────────────────────────────────────────────────────────────────────


def rot(axis: np.ndarray, deg: float) -> np.ndarray:
    a = np.asarray(axis, dtype=np.float64)
    a = a / np.linalg.norm(a)
    t = math.radians(deg)
    k = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(t) * k + (1 - math.cos(t)) * (k @ k)


def skinning_matrices(joints: np.ndarray, local_rot: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """레스트 회전이 항등인 스켈레톤에 로컬 회전을 적용 → (스킨 행렬 (B,4,4), 포즈 관절 위치 (B,3))."""
    n = len(BONES)
    G = np.zeros((n, 4, 4))
    for i, b in enumerate(BONES):
        L = np.eye(4)
        p = PARENT_INDEX[i]
        L[:3, 3] = joints[i] - (joints[p] if p >= 0 else 0.0)
        if b in local_rot:
            L[:3, :3] = local_rot[b]
        G[i] = L if p < 0 else G[p] @ L
    inv_bind = np.tile(np.eye(4), (n, 1, 1))
    inv_bind[:, :3, 3] = -joints
    return G @ inv_bind, G[:, :3, 3]


def apply_skin(vertices: np.ndarray, idx: np.ndarray, w: np.ndarray, mats: np.ndarray) -> np.ndarray:
    vh = np.concatenate([vertices.astype(np.float64), np.ones((len(vertices), 1))], 1)
    out = np.zeros((len(vertices), 3))
    for k in range(idx.shape[1]):
        M = mats[idx[:, k]]  # (N,4,4)
        out += w[:, k : k + 1] * np.einsum("nij,nj->ni", M, vh)[:, :3]
    return out


def arm_angle_deg(joints: np.ndarray, side: str) -> float:
    """어깨(Arm)→손목(Hand) 방향의 정면 평면 각도: 바깥쪽 수평 기준 아래로 + (손이 안쪽이면 90° 초과)."""
    a = joints[BONE_INDEX[f"{side}Arm"]]
    h = joints[BONE_INDEX[f"{side}Hand"]]
    outward = (1.0 if side == "Left" else -1.0) * (h[0] - a[0])
    return math.degrees(math.atan2(-(h[1] - a[1]), outward))


def rot_between(u: np.ndarray, w: np.ndarray) -> np.ndarray:
    """u 방향을 w 방향으로 보내는 최소 회전 행렬."""
    u = np.asarray(u, dtype=np.float64) / np.linalg.norm(u)
    w = np.asarray(w, dtype=np.float64) / np.linalg.norm(w)
    axis = np.cross(u, w)
    s, c = float(np.linalg.norm(axis)), float(np.clip(u @ w, -1.0, 1.0))
    if s < 1e-9:
        if c > 0:
            return np.eye(3)
        perp = np.cross(u, [1.0, 0.0, 0.0] if abs(u[0]) < 0.9 else [0.0, 1.0, 0.0])
        return rot(perp, 180.0)
    return rot(axis, math.degrees(math.atan2(s, c)))


def repose_to_a_pose(m: MeshData, joints: np.ndarray, idx: np.ndarray, w: np.ndarray) -> tuple[MeshData, np.ndarray, dict]:
    """팔을 곧게 펴서 정면 평면 45° 아래(A-pose)로 돌려 메쉬에 굽는다 (docs/04 §3.E-4).

    레스트 회전이 항등이므로 ForeArm 로컬 회전 = R_arm^T · R_fore_world · R_arm.
    """
    rots: dict[str, np.ndarray] = {}
    info: dict = {}
    s45 = math.sin(math.radians(A_POSE_ARM_DEG))
    for side, sign in (("Left", 1.0), ("Right", -1.0)):
        arm_n, fore_n, hand_n = ARM_CHAINS[side]
        a, f, h = (joints[BONE_INDEX[n]].astype(np.float64) for n in (arm_n, fore_n, hand_n))
        target = np.array([sign * s45, -s45, 0.0])
        upper, lower = f - a, h - f
        bend = math.degrees(math.acos(float(np.clip(upper @ lower / (np.linalg.norm(upper) * np.linalg.norm(lower)), -1, 1))))
        off = math.degrees(math.acos(float(np.clip(upper @ target / np.linalg.norm(upper), -1, 1))))
        info[f"{side.lower()}ArmDeg"] = round(arm_angle_deg(joints, side), 1)
        info[f"{side.lower()}ElbowBendDeg"] = round(bend, 1)
        if off <= 2.0 and bend <= 5.0:
            continue
        r_arm = rot_between(upper, target)
        r_fore_world = rot_between(r_arm @ lower, target)
        rots[arm_n] = r_arm
        rots[fore_n] = r_arm.T @ r_fore_world @ r_arm
    if not rots:
        return m, joints, info
    mats, posed_joints = skinning_matrices(joints.astype(np.float64), rots)
    verts = apply_skin(m.vertices, idx, w, mats)
    return MeshData(verts, m.faces, m.colors), posed_joints.astype(np.float32), info


def edge_stretch_p99(faces: np.ndarray, rest: np.ndarray, posed: np.ndarray) -> float:
    """엣지 길이 비(늘어남·줄어듦 대칭)의 99 백분위."""
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    r = np.linalg.norm(rest[e[:, 0]] - rest[e[:, 1]], axis=1)
    p = np.linalg.norm(posed[e[:, 0]] - posed[e[:, 1]], axis=1)
    ok = r > 1e-6
    ratio = p[ok] / r[ok]
    return float(np.percentile(np.maximum(ratio, 1.0 / np.maximum(ratio, 1e-9)), 99)) if ok.any() else 1.0


def build_rig(m: MeshData, pose: PoseHint | None = None) -> RigData:
    joints, meta = fit_joints(m, pose)
    hw = meta["torsoHalfWidth"]
    idx, w = smooth_weights(m, joints, hw)
    m2, joints2, info = repose_to_a_pose(m, joints, idx, w)
    meta.update(info)
    meta["reposed"] = m2 is not m
    # 재포즈가 메쉬를 얼마나 찢었는지 (팔이 몸통에 붙은 그림은 크다 → smooth 검증에서 반영)
    meta["reposeStretchP99"] = round(edge_stretch_p99(m.faces, m.vertices.astype(np.float64), m2.vertices.astype(np.float64)), 3)
    if m2 is not m:
        # 팔을 내리거나 올리면 bbox 가 바뀐다 → 키 1.8m·발 y=0·x/z 중심을 다시 맞춘다 (관절도 같은 변환)
        from .postprocess import normalization

        origin, s = normalization(m2.vertices)
        m2 = MeshData((m2.vertices.astype(np.float64) - origin) * s, m2.faces, m2.colors)
        joints2 = ((joints2.astype(np.float64) - origin) * s).astype(np.float32)
        hw *= s
        meta["torsoHalfWidth"] = hw
        meta["renormalizeScale"] = s
    idx2, w2 = smooth_weights(m2, joints2, hw)
    rigid = rigid_weights(m2, joints2, hw)
    return RigData(mesh=m2, joints=joints2, smooth_idx=idx2, smooth_w=w2, rigid_idx=rigid, meta=meta)

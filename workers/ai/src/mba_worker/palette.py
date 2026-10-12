"""컷아웃 전경 픽셀의 k-means 팔레트 (C5 skin.palette: [주색, 보조색, 강조색, 글러브색])."""

from __future__ import annotations

import numpy as np
from PIL import Image


def kmeans(pixels: np.ndarray, k: int, iters: int = 20, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """결정적 k-means++ 초기화. pixels (N,3) float → (centers (k,3), counts (k,))."""
    rng = np.random.default_rng(seed)
    n = len(pixels)
    k = min(k, n)
    centers = [pixels[rng.integers(n)]]
    for _ in range(1, k):
        d2 = np.min(((pixels[:, None, :] - np.asarray(centers)[None]) ** 2).sum(-1), axis=1)
        total = d2.sum()
        if total <= 0:
            break
        centers.append(pixels[rng.choice(n, p=d2 / total)])
    c = np.asarray(centers, dtype=np.float64)
    labels = np.zeros(n, dtype=np.int64)
    for _ in range(iters):
        labels = ((pixels[:, None, :] - c[None]) ** 2).sum(-1).argmin(1)
        new = np.array([pixels[labels == i].mean(0) if np.any(labels == i) else c[i] for i in range(len(c))])
        if np.allclose(new, c, atol=1e-3):
            c = new
            break
        c = new
    counts = np.bincount(labels, minlength=len(c))
    return c, counts


def extract_palette(img: Image.Image, k: int = 5, max_colors: int = 4) -> list[str]:
    arr = np.asarray(img.convert("RGBA"))
    fg = arr[arr[..., 3] > 128][:, :3].astype(np.float64)
    if len(fg) == 0:
        return ["#808080"]
    if len(fg) > 20000:
        fg = fg[np.random.default_rng(0).choice(len(fg), 20000, replace=False)]
    centers, counts = kmeans(fg, k)
    order = np.argsort(-counts)
    centers = centers[order][counts[order] > 0]
    # 주색·보조색은 빈도순, 강조색은 남은 것 중 채도가 가장 높은 색
    picked = list(centers[:2])
    rest = list(centers[2:])
    if rest:
        sat = [float(c.max() - c.min()) for c in rest]
        picked.append(rest.pop(int(np.argmax(sat))))
    picked.extend(rest)
    picked = picked[:max_colors]
    return ["#{:02x}{:02x}{:02x}".format(*np.clip(np.round(c), 0, 255).astype(int)) for c in picked]

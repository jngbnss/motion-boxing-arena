"""썸네일 PNG: 소프트웨어 래스터 (화가 알고리즘 + 램버트 셰이딩, 정점 색). GPU·OpenGL 불필요."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageDraw

from .meshdata import MeshData
from .rig import rot


def render_thumbnail(m: MeshData, size: int = 512, yaw_deg: float = 20.0, supersample: int = 2) -> bytes:
    s = size * supersample
    v = m.vertices.astype(np.float64)
    center = (v.min(0) + v.max(0)) / 2
    v = (v - center) @ rot([0, 1, 0], yaw_deg).T
    f = m.faces
    tri = v[f]  # (M,3,3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = n / np.maximum(ln, 1e-12)
    visible = n[:, 2] > 0  # 정면(+Z, 카메라 쪽)을 보는 면만
    light = np.array([0.35, 0.55, 0.75])
    light /= np.linalg.norm(light)
    shade = 0.35 + 0.65 * np.clip(n @ light, 0, 1)
    col = m.colors[f].mean(1) * shade[:, None]
    extent = float(max(np.ptp(v[:, 0]), np.ptp(v[:, 1]))) * 1.1
    scale = s / extent
    px = v[:, 0] * scale + s / 2
    py = s / 2 - v[:, 1] * scale
    order = np.argsort(tri[:, :, 2].mean(1))  # 먼 면부터
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    rgb = np.clip(col * 255 + 0.5, 0, 255).astype(np.uint8)
    for i in order:
        if not visible[i]:
            continue
        a, b, c = f[i]
        fill = (int(rgb[i, 0]), int(rgb[i, 1]), int(rgb[i, 2]), 255)
        draw.polygon([(px[a], py[a]), (px[b], py[b]), (px[c], py[c])], fill=fill, outline=fill)
    img = img.resize((size, size), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()

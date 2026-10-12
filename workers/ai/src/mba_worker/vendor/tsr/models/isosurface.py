import warnings
from typing import Callable, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from skimage.measure import marching_cubes as _sk_marching_cubes


def marching_cubes(level: torch.Tensor, threshold: float) -> Tuple[torch.Tensor, torch.Tensor]:
    """mba-worker 수정: torchmcubes(Windows 빌드 실패) 대신 scikit-image 마칭 큐브.

    torchmcubes.marching_cubes 와 같은 규약을 따른다: 입력 grid[i, j, k] 의 인덱스 공간 좌표를
    (k, j, i) 순서로 돌려준다(호출부가 [..., [2, 1, 0]] 으로 다시 뒤집는다). 면 감김 방향은
    후처리(mba_worker.postprocess)가 부호 있는 부피로 바로잡는다.
    """
    vol = level.detach().float().cpu().numpy()
    if not (vol.min() <= threshold <= vol.max()):
        return torch.zeros((0, 3), dtype=torch.float32), torch.zeros((0, 3), dtype=torch.long)
    with warnings.catch_warnings():
        # scikit-image 0.26 내부의 NumPy 2.5 deprecation 경고 (결과 영향 없음)
        warnings.simplefilter("ignore", DeprecationWarning)
        verts, faces, _normals, _values = _sk_marching_cubes(vol, level=threshold)
    verts = np.ascontiguousarray(verts[:, ::-1], dtype=np.float32)
    faces = np.ascontiguousarray(faces, dtype=np.int64)
    return torch.from_numpy(verts), torch.from_numpy(faces)


class IsosurfaceHelper(nn.Module):
    points_range: Tuple[float, float] = (0, 1)

    @property
    def grid_vertices(self) -> torch.FloatTensor:
        raise NotImplementedError


class MarchingCubeHelper(IsosurfaceHelper):
    def __init__(self, resolution: int) -> None:
        super().__init__()
        self.resolution = resolution
        self.mc_func: Callable = marching_cubes
        self._grid_vertices: Optional[torch.FloatTensor] = None

    @property
    def grid_vertices(self) -> torch.FloatTensor:
        if self._grid_vertices is None:
            # keep the vertices on CPU so that we can support very large resolution
            x, y, z = (
                torch.linspace(*self.points_range, self.resolution),
                torch.linspace(*self.points_range, self.resolution),
                torch.linspace(*self.points_range, self.resolution),
            )
            x, y, z = torch.meshgrid(x, y, z, indexing="ij")
            verts = torch.cat(
                [x.reshape(-1, 1), y.reshape(-1, 1), z.reshape(-1, 1)], dim=-1
            ).reshape(-1, 3)
            self._grid_vertices = verts
        return self._grid_vertices

    def forward(
        self,
        level: torch.FloatTensor,
    ) -> Tuple[torch.FloatTensor, torch.LongTensor]:
        level = -level.view(self.resolution, self.resolution, self.resolution)
        v_pos, t_pos_idx = self.mc_func(level.detach(), 0.0)
        v_pos = v_pos[..., [2, 1, 0]]
        v_pos = v_pos / (self.resolution - 1.0)
        return v_pos.to(level.device), t_pos_idx.to(level.device)

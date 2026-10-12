import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SKELETON_ID, type BoneName, type CharacterManifest } from '@mba/shared';
import { ProceduralBoxer } from '../avatar/ProceduralBoxer.ts';
import { fitToTemplate, FIGURE_BOX, foregroundMask, hasDrawnFace, HEAD, maskBounds, TEMPLATE_H, TEMPLATE_W, traceTemplate } from './bodyTemplate.ts';

type Pt = [number, number];

/** traceTemplate가 그리는 실루엣을 다각형으로 기록: [몸통, 오른팔(이미지 왼쪽), 오른다리, 왼팔(이미지 오른쪽), 왼다리] */
function templatePolygons(): Pt[][] {
  const polys: Pt[][] = [];
  let cur: Pt[] | null = null;
  const path = {
    moveTo: (x: number, y: number) => { cur = [[x, y]]; },
    lineTo: (x: number, y: number) => { cur!.push([x, y]); },
    closePath: () => { polys.push(cur!); cur = null; },
    arc: () => { cur = null; },
  };
  traceTemplate(path as unknown as CanvasPath);
  return polys;
}

function inside(poly: Pt[], [x, y]: Pt): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function manifest(body?: string): CharacterManifest {
  return {
    id: 't0-test', name: 'T', ownerId: 'local', skeleton: SKELETON_ID, tier: 'T0', glbUrl: null, thumbnailUrl: null,
    skin: { palette: ['#112233', '#445566', '#778899', '#aabbcc'], decals: body ? { body } : {} },
    scale: 1,
    provenance: { model: 'test', modelVersion: '1', seed: null, rigger: 'none', createdAt: '2026-10-12T00:00:00Z' },
    license: { userAttestedRights: true, visibility: 'private' },
    builtin: false,
  };
}

/** 본에 붙은, 스킨 재질을 쓰는 메쉬들의 UV → 템플릿 픽셀 */
function skinPixels(boxer: ProceduralBoxer, bone: BoneName): Pt[] {
  const out: Pt[] = [];
  for (const o of boxer.bones[bone].children) {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m.material as THREE.Material).customProgramCacheKey() !== 'mba-body-skin') continue;
    const uv = m.geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) out.push([uv.getX(i) * TEMPLATE_W, (1 - uv.getY(i)) * TEMPLATE_H]);
  }
  return out;
}

describe('전신 스킨 UV', () => {
  it('각 부위 정점이 템플릿의 같은 부위(좌우 포함) 안으로 투영된다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boxer = new ProceduralBoxer(manifest('data:image/png;base64,AAAA'));
    await boxer.load(); // 노드엔 Image가 없어 텍스처는 실패 → 팔레트 대체(경고만)
    warn.mockRestore();
    const [torso, armR, legR, armL, legL] = templatePolygons();
    const expectIn = (bones: BoneName[], test: (p: Pt) => boolean) => {
      for (const b of bones) {
        const px = skinPixels(boxer, b);
        expect(px.length, b).toBeGreaterThan(0);
        for (const p of px) expect(test(p), `${b} ${p}`).toBe(true);
      }
    };
    expectIn(['Head', 'Neck'], ([x, y]) => Math.hypot(x - HEAD.cx, y - HEAD.cy) < HEAD.r);
    expectIn(['Hips', 'Spine1'], (p) => inside(torso!, p));
    // 정면 그림: 캐릭터 왼쪽 = 이미지 오른쪽
    expectIn(['LeftArm', 'LeftForeArm', 'LeftHand'], (p) => inside(armL!, p));
    expectIn(['RightArm', 'RightForeArm', 'RightHand'], (p) => inside(armR!, p));
    expectIn(['LeftUpLeg', 'LeftLeg', 'LeftFoot'], (p) => inside(legL!, p));
    expectIn(['RightUpLeg', 'RightLeg', 'RightFoot'], (p) => inside(legR!, p));
    boxer.dispose();
  });

  it('전신 스킨이 없으면 기본 재질을 그대로 쓴다', () => {
    const boxer = new ProceduralBoxer(manifest());
    expect(skinPixels(boxer, 'Spine1')).toHaveLength(0);
    boxer.dispose();
  });
});

function rgba(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fill(x, y), (y * w + x) * 4);
  return d;
}

describe('업로드 전경 분리', () => {
  it('테두리 배경색을 지우되 인물 안쪽의 같은 색(눈 흰자)은 남긴다', () => {
    const w = 40, h = 60;
    const fig = (x: number, y: number) => x >= 10 && x < 30 && y >= 5 && y < 55;
    const data = rgba(w, h, (x, y) => (fig(x, y) ? (x === 15 && y === 10 ? [250, 250, 250, 255] : [200, 30, 30, 255]) : [252, 252, 248, 255]));
    const mask = foregroundMask(data, w, h);
    expect(mask[10 * w + 15]).toBe(1);
    expect(mask[0]).toBe(0);
    expect(maskBounds(mask, w, h)).toEqual({ x: 10, y: 5, w: 20, h: 50 });
  });

  it('테두리가 투명하면 알파로 분리한다', () => {
    const w = 20, h = 20;
    const data = rgba(w, h, (x, y) => (x > 5 && x < 15 && y > 5 && y < 15 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(maskBounds(foregroundMask(data, w, h), w, h)).toEqual({ x: 6, y: 6, w: 9, h: 9 });
  });

  it('전경이 거의 없으면 분리 실패(null)', () => {
    expect(maskBounds(new Uint8Array(100 * 100), 100, 100)).toBeNull();
  });

  it('세로로 긴 전경은 전신 영역 높이에 맞추고 가로 가운데 정렬', () => {
    const r = fitToTemplate({ w: 100, h: 400 });
    expect(r.h).toBeCloseTo(FIGURE_BOX.h);
    expect(r.y).toBe(FIGURE_BOX.y);
    expect(r.x + r.w / 2).toBeCloseTo(TEMPLATE_W / 2);
  });
});

describe('그린 얼굴 감지', () => {
  const w = 128, h = 192, s = w / TEMPLATE_W;
  const inHead = (x: number, y: number) => Math.hypot(x / s - HEAD.cx, y / s - HEAD.cy) < HEAD.r;
  it('단색으로 칠한 머리(외곽선 포함)는 얼굴이 아니다', () => {
    const data = rgba(w, h, (x, y) => {
      if (!inHead(x, y)) return [0, 0, 0, 0];
      return Math.hypot(x / s - HEAD.cx, y / s - HEAD.cy) > HEAD.r - 8 ? [10, 10, 10, 255] : [230, 190, 150, 255];
    });
    expect(hasDrawnFace(data, w, h)).toBe(false);
  });
  it('눈·입을 그린 머리는 얼굴이다', () => {
    const data = rgba(w, h, (x, y) => {
      if (!inHead(x, y)) return [0, 0, 0, 0];
      const dy = y / s - HEAD.cy;
      return Math.abs(dy + 12) < 6 || Math.abs(dy - 18) < 4 ? [20, 20, 20, 255] : [230, 190, 150, 255];
    });
    expect(hasDrawnFace(data, w, h)).toBe(true);
  });
});

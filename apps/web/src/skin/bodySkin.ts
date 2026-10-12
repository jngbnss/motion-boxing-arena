// T0 전신 스킨 렌더링: 템플릿 그림 텍스처를 부위별 UV로 입히고, 텍스처가 투명한 곳은 재질 색(팔레트)을 그대로 쓴다.
import * as THREE from 'three';
import { hasDrawnFace, TEMPLATE_H, TEMPLATE_W, type TemplatePx } from './bodyTemplate.ts';

/**
 * 스킨 텍스처를 팔레트 색 위에 알파로 덮는 표준 재질. 텍스처는 프리멀티플라이 알파로 올려서
 * 가장자리 필터링(투명 픽셀의 검은 RGB) 번짐 없이 `텍스처 + 재질색 × (1 - α)`로 합성한다.
 */
export function bodySkinMaterial(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial(params);
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
  vec4 skinTexel = texture2D( map, vMapUv );
  diffuseColor.rgb = skinTexel.rgb + diffuseColor.rgb * ( 1.0 - skinTexel.a );
#endif`,
    );
  };
  mat.customProgramCacheKey = () => 'mba-body-skin';
  return mat;
}

/** 지오메트리 정점(matrix로 옮긴 좌표)을 템플릿 픽셀로 투영해 uv를 다시 쓴다 */
export function setTemplateUv(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, project: (p: THREE.Vector3) => TemplatePx): void {
  const pos = geometry.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    const [x, y] = project(p);
    uv[i * 2] = x / TEMPLATE_W;
    uv[i * 2 + 1] = 1 - y / TEMPLATE_H; // 이미지 텍스처 flipY
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export interface BodySkin {
  texture: THREE.Texture;
  /** 머리에 얼굴을 그렸는가 (기본 눈 숨김) */
  drawnFace: boolean;
}

/** 스킨 이미지(data URL) → 텍스처 */
export async function loadBodySkin(url: string): Promise<BodySkin> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const probe = document.createElement('canvas');
  probe.width = 128;
  probe.height = 192;
  const g = probe.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, probe.width, probe.height);
  const drawnFace = hasDrawnFace(g.getImageData(0, 0, probe.width, probe.height).data, probe.width, probe.height);
  const texture = new THREE.Texture(img);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.premultiplyAlpha = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { texture, drawnFace };
}

/** 재질들에 스킨 텍스처 적용 */
export function applyBodySkin(materials: readonly THREE.MeshStandardMaterial[], texture: THREE.Texture): void {
  for (const m of materials) {
    m.map = texture;
    m.needsUpdate = true;
  }
}

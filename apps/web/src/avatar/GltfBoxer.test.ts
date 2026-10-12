// 최소 스킨드 GLB(워커 출력 계약과 같은 형식: 22본, 단위 회전 레스트, A-pose 팔 45°, rigid 가중치)를
// three GLTFExporter로 만들어 GltfBoxer가 본을 찾고 절차 애니메이션을 리타깃하는지 검증한다.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BONES, SKELETON_ID, type BoneName, type CharacterManifest } from '@mba/shared';
import { findBones, GltfBoxer } from './GltfBoxer.ts';
import { createAvatar } from './createAvatar.ts';
import { ProceduralBoxer } from './ProceduralBoxer.ts';

const S45 = Math.SQRT1_2;
/** 부모 기준 이동 (A-pose: 팔은 45° 아래로) */
const LAYOUT: Record<BoneName, [BoneName | null, [number, number, number]]> = {
  Hips: [null, [0, 1.0, 0]],
  Spine: ['Hips', [0, 0.1, 0]],
  Spine1: ['Spine', [0, 0.14, 0]],
  Spine2: ['Spine1', [0, 0.14, 0]],
  Neck: ['Spine2', [0, 0.12, 0]],
  Head: ['Neck', [0, 0.06, 0]],
  LeftShoulder: ['Spine2', [0.04, 0.08, 0]],
  LeftArm: ['LeftShoulder', [0.14, 0, 0]],
  LeftForeArm: ['LeftArm', [0.3 * S45, -0.3 * S45, 0]],
  LeftHand: ['LeftForeArm', [0.28 * S45, -0.28 * S45, 0]],
  RightShoulder: ['Spine2', [-0.04, 0.08, 0]],
  RightArm: ['RightShoulder', [-0.14, 0, 0]],
  RightForeArm: ['RightArm', [-0.3 * S45, -0.3 * S45, 0]],
  RightHand: ['RightForeArm', [-0.28 * S45, -0.28 * S45, 0]],
  LeftUpLeg: ['Hips', [0.1, -0.04, 0]],
  LeftLeg: ['LeftUpLeg', [0, -0.44, 0]],
  LeftFoot: ['LeftLeg', [0, -0.43, 0]],
  LeftToeBase: ['LeftFoot', [0, -0.04, 0.12]],
  RightUpLeg: ['Hips', [-0.1, -0.04, 0]],
  RightLeg: ['RightUpLeg', [0, -0.44, 0]],
  RightFoot: ['RightLeg', [0, -0.43, 0]],
  RightToeBase: ['RightFoot', [0, -0.04, 0.12]],
};

/** 본마다 상자 하나를 rigid(가중치 1)로 붙인 스킨드 메쉬 */
function buildTestCharacter(skip: BoneName[] = []): THREE.Scene {
  const scene = new THREE.Scene();
  const bones = {} as Record<BoneName, THREE.Bone>;
  for (const n of BONES) {
    const b = new THREE.Bone();
    b.name = n;
    b.position.set(...LAYOUT[n][1]);
    bones[n] = b;
  }
  for (const n of BONES) {
    const p = LAYOUT[n][0];
    if (p) bones[p].add(bones[n]);
  }
  scene.add(bones.Hips);
  scene.updateMatrixWorld(true);
  const used = BONES.filter((n) => !skip.includes(n));
  const parts = used.map((n, i) => {
    const g = new THREE.BoxGeometry(0.08, 0.08, 0.08).toNonIndexed();
    const w = bones[n].getWorldPosition(new THREE.Vector3());
    g.translate(w.x, w.y, w.z);
    const count = g.getAttribute('position').count;
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0).map((_, k) => (k % 4 === 0 ? i : 0)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(count * 4).fill(0).map((_, k) => (k % 4 === 0 ? 1 : 0)), 4));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(count * 3).fill(0.6), 3));
    g.deleteAttribute('uv');
    return g;
  });
  const geom = mergeGeometries(parts)!;
  const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0 }));
  mesh.name = 'Body';
  scene.add(mesh);
  // skip된 본은 이름을 바꿔 "누락" 상황을 만든다
  for (const n of skip) bones[n].name = `${n}_x`;
  mesh.bind(new THREE.Skeleton(used.map((n) => bones[n])));
  return scene;
}

async function exportGlb(scene: THREE.Scene): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}

const loader = new GLTFLoader();
const parseGlb = (buf: ArrayBuffer) => loader.parseAsync(buf, '');

function manifest(): CharacterManifest {
  return {
    id: 'chr_test',
    name: '테스트',
    ownerId: 'usr_1',
    skeleton: SKELETON_ID,
    tier: 'T1',
    glbUrl: 'memory://test.glb',
    thumbnailUrl: null,
    skin: { palette: ['#112233', '#445566', '#778899', '#aabbcc'], decals: {} },
    scale: 1,
    provenance: { model: 'test', modelVersion: '1', seed: null, rigger: 'rigid', createdAt: '2026-10-12T00:00:00Z' },
    license: { userAttestedRights: true, visibility: 'private' },
    builtin: false,
  };
}

function worldOf(root: THREE.Object3D, name: string): THREE.Vector3 {
  const o = root.getObjectByName(name);
  if (!o) throw new Error(`no ${name}`);
  return o.getWorldPosition(new THREE.Vector3());
}

beforeAll(() => {
  // GLTFExporter(binary)는 Blob → FileReader로 ArrayBuffer를 만든다. Node에는 FileReader가 없어 최소 구현을 둔다
  if (!('FileReader' in globalThis)) {
    class NodeFileReader {
      result: ArrayBuffer | string | null = null;
      onload: ((e: unknown) => void) | null = null;
      onloadend: ((e: unknown) => void) | null = null;
      readAsArrayBuffer(blob: Blob): void {
        void blob.arrayBuffer().then((b) => {
          this.result = b;
          this.onload?.({ target: this });
          this.onloadend?.({ target: this });
        });
      }
    }
    Object.assign(globalThis, { FileReader: NodeFileReader });
  }
});

describe('GltfBoxer', () => {
  it('GLB에서 22본을 찾고 GLB 외형으로 전환한다', async () => {
    const buf = await exportGlb(buildTestCharacter());
    const gltf = await parseGlb(buf);
    expect(findBones(gltf.scene).missing).toEqual([]);
    const boxer = new GltfBoxer(manifest(), { loadGltf: async () => parseGlb(buf) });
    await boxer.load();
    expect(boxer.loadError).toBeNull();
    expect(boxer.usingGlb).toBe(true);
    let skinned = 0;
    boxer.object.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++; });
    expect(skinned).toBe(1);
  });

  it('기본 복서와 같은 타임라인으로 손을 움직인다 (가드 → 잽 신전 → 복귀)', async () => {
    const buf = await exportGlb(buildTestCharacter());
    const boxer = new GltfBoxer(manifest(), { loadGltf: async () => parseGlb(buf) });
    const ref = new ProceduralBoxer(manifest());
    await boxer.load();
    const scene = new THREE.Scene();
    scene.add(boxer.object, ref.object);
    for (let t = 0; t <= 1000; t += 16) {
      boxer.update(0.016, t);
      ref.update(0.016, t);
    }
    // A-pose로 내려가 있던 손이 가드 높이(가슴 위)로 올라온다
    const guardHand = worldOf(boxer.object, 'LeftHand');
    expect(guardHand.y).toBeGreaterThan(1.2);
    const refLead = ref.getHitVolumes().gloves.lead.center;
    expect(guardHand.distanceTo(refLead)).toBeLessThan(0.03);

    const t0 = 1000;
    const tl = { hand: 'lead' as const, type: 'jab' as const, aimLockAt: t0, startupAt: t0, activeAt: t0 + 100, activeEndsAt: t0 + 180, recoveryEndsAt: t0 + 380 };
    boxer.playStrike(tl);
    ref.playStrike(tl);
    for (let t = t0; t <= t0 + 140; t += 10) {
      boxer.update(0.01, t);
      ref.update(0.01, t);
    }
    const punchHand = worldOf(boxer.object, 'LeftHand');
    expect(punchHand.z - guardHand.z).toBeGreaterThan(0.25);
    expect(punchHand.distanceTo(ref.getHitVolumes().gloves.lead.center)).toBeLessThan(0.03);
    // 반대손은 가드 유지
    expect(worldOf(boxer.object, 'RightHand').z).toBeLessThan(punchHand.z - 0.2);

    for (let t = t0 + 140; t <= t0 + 900; t += 16) boxer.update(0.016, t);
    expect(worldOf(boxer.object, 'LeftHand').distanceTo(guardHand)).toBeLessThan(0.08);
  });

  it('KO 시 GLB 몸통이 뒤로 쓰러진다', async () => {
    const buf = await exportGlb(buildTestCharacter());
    const boxer = new GltfBoxer(manifest(), { loadGltf: async () => parseGlb(buf) });
    await boxer.load();
    new THREE.Scene().add(boxer.object);
    boxer.update(0.016, 0);
    boxer.play('ko', { now: 0 });
    for (let t = 0; t <= 1200; t += 16) boxer.update(0.016, t);
    expect(worldOf(boxer.object, 'Head').y).toBeLessThan(0.6);
  });

  it('로드 실패·본 누락이면 스킨 팔레트 기본 복서로 대체한다', async () => {
    const failing = new GltfBoxer(manifest(), { loadGltf: async () => { throw new Error('404'); } });
    await failing.load();
    expect(failing.usingGlb).toBe(false);
    expect(failing.loadError).toContain('404');
    let visibleMeshes = 0;
    failing.object.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) visibleMeshes++; });
    expect(visibleMeshes).toBeGreaterThan(10);

    const buf = await exportGlb(buildTestCharacter(['LeftForeArm']));
    const partial = new GltfBoxer(manifest(), { loadGltf: async () => parseGlb(buf) });
    await partial.load();
    expect(partial.usingGlb).toBe(false);
    expect(partial.loadError).toContain('LeftForeArm');
  });

  it('티어별 팩토리: T1/T2 + glbUrl → GltfBoxer, 그 외 → ProceduralBoxer', () => {
    expect(createAvatar(manifest())).toBeInstanceOf(GltfBoxer);
    expect(createAvatar({ ...manifest(), tier: 'T0', glbUrl: null })).toBeInstanceOf(ProceduralBoxer);
    expect(createAvatar({ ...manifest(), glbUrl: null })).toBeInstanceOf(ProceduralBoxer);
  });
});

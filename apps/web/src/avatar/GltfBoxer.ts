// T1/T2 GLB 복서: manifest.glbUrl의 스킨드 메쉬(mba-humanoid-v1 22본)를 불러와,
// ProceduralBoxer를 보이지 않는 "컨트롤러"로 돌린 뒤 그 본 자세를 GLB 본에 리타깃한다.
// → idle/guard/jab/straight/hit/ko/victory·머리 오프셋·가드 가중치가 기본 복서와 같은 타임라인으로 움직인다.
// 로드 실패 시 컨트롤러(스킨 팔레트를 입힌 기본 복서)를 그대로 보여준다(C13 T0 대체).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BONES, type BoneName, type CharacterManifest, type Hand } from '@mba/shared';
import { ProceduralBoxer, type ProceduralBoxerOptions } from './ProceduralBoxer.ts';
import type { AvatarAction, BoxerAvatar, HitVolumes, StrikeTimeline } from './types.ts';

/** 방향(본 → 자식) 정렬로 리타깃하는 본과 그 자식. A-pose ↔ 컨트롤러 T자 레스트 차이를 흡수한다 */
const SEGMENT_CHILD: Partial<Record<BoneName, BoneName>> = {
  Spine: 'Spine1',
  Spine1: 'Spine2',
  Neck: 'Head',
  LeftShoulder: 'LeftArm',
  LeftArm: 'LeftForeArm',
  LeftForeArm: 'LeftHand',
  RightShoulder: 'RightArm',
  RightArm: 'RightForeArm',
  RightForeArm: 'RightHand',
  LeftUpLeg: 'LeftLeg',
  LeftLeg: 'LeftFoot',
  RightUpLeg: 'RightLeg',
  RightLeg: 'RightFoot',
};

export type GltfLoadFn = (url: string) => Promise<{ scene: THREE.Object3D }>;

export interface GltfBoxerOptions extends ProceduralBoxerOptions {
  /** 테스트 주입용. 기본: three GLTFLoader */
  loadGltf?: GltfLoadFn;
}

interface BoneLink {
  name: BoneName;
  glb: THREE.Object3D;
  ctrl: THREE.Bone;
  child: BoneName | null;
  /** 레스트 자세: 아바타 object 좌표계 기준 회전 */
  ctrlRestQ: THREE.Quaternion;
  glbRestQ: THREE.Quaternion;
  /** GLB 레스트 본 방향(object 좌표계, 정규화) */
  glbRestDir: THREE.Vector3 | null;
  glbRestLocalQ: THREE.Quaternion;
}

/** 이름으로 본 찾기. Mixamo 접두어(`mixamorig:` → 로더가 `mixamorig`로 정리)도 허용 */
export function findBones(root: THREE.Object3D): { bones: Partial<Record<BoneName, THREE.Object3D>>; missing: BoneName[] } {
  const bones: Partial<Record<BoneName, THREE.Object3D>> = {};
  const wanted = new Set<string>(BONES);
  root.traverse((o) => {
    const name = o.name.replace(/^mixamorig[:_]?/, '') as BoneName;
    if (!wanted.has(name)) return;
    const prev = bones[name];
    // 같은 이름의 메쉬/그룹보다 실제 Bone 우선
    if (!prev || (!(prev as THREE.Bone).isBone && (o as THREE.Bone).isBone)) bones[name] = o;
  });
  return { bones, missing: BONES.filter((n) => !bones[n]) };
}

export class GltfBoxer implements BoxerAvatar {
  readonly object = new THREE.Group();
  /** 애니메이션 원본. GLB가 없거나 실패하면 이 기본 복서가 그대로 보인다 */
  private readonly ctrl: ProceduralBoxer;
  private model: THREE.Object3D | null = null;
  private links: BoneLink[] = [];
  private hips: { glb: THREE.Object3D; ctrl: THREE.Bone; glbRestObj: THREE.Vector3; ctrlRestObj: THREE.Vector3; ratio: number } | null = null;
  private readonly loadGltf: GltfLoadFn;
  private disposed = false;
  /** 로드 실패 사유 (대체 외형 사용 중) */
  loadError: string | null = null;

  constructor(readonly manifest: CharacterManifest, opts: GltfBoxerOptions = {}) {
    this.ctrl = new ProceduralBoxer(manifest, opts);
    this.object.add(this.ctrl.object);
    this.loadGltf = opts.loadGltf ?? ((url) => new GLTFLoader().loadAsync(url));
  }

  /** GLB를 실제로 쓰고 있는가 (false = 대체 외형) */
  get usingGlb(): boolean {
    return this.model != null;
  }

  async load(): Promise<void> {
    const url = this.manifest.glbUrl;
    if (!url) {
      this.loadError = 'glbUrl 없음';
      return;
    }
    try {
      const gltf = await this.loadGltf(url);
      if (this.disposed) {
        disposeTree(gltf.scene);
        return;
      }
      this.attach(gltf.scene);
    } catch (e) {
      this.loadError = String((e as Error)?.message ?? e);
      console.warn(`[GltfBoxer] GLB 로드 실패 → 기본 복서로 대체: ${this.loadError}`);
      this.ctrl.object.visible = true;
    }
  }

  private attach(scene: THREE.Object3D): void {
    const { bones, missing } = findBones(scene);
    if (missing.length) throw new Error(`스켈레톤 본 누락: ${missing.join(', ')}`);
    scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.castShadow = true;
        // 스킨드 메쉬 경계는 바인드 포즈 기준이라 KO·러지 시 잘못 컬링될 수 있다
        m.frustumCulled = false;
      }
    });
    const model = new THREE.Group();
    model.add(scene);
    model.scale.setScalar(this.manifest.scale ?? 1);
    this.object.add(model);
    // 레스트 자세 측정: 컨트롤러도 레스트(모든 본 단위 회전)에서 잰다
    this.ctrl.restPose();
    this.object.updateMatrixWorld(true);
    const inv = this.object.getWorldQuaternion(new THREE.Quaternion()).invert();
    const objQ = (o: THREE.Object3D) => inv.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion()));
    const objPos = (o: THREE.Object3D) => this.object.worldToLocal(o.getWorldPosition(new THREE.Vector3()));

    this.links = BONES.map((name) => {
      const glb = bones[name]!;
      const child = SEGMENT_CHILD[name] ?? null;
      const glbRestDir = child ? objPos(bones[child]!).sub(objPos(glb)) : null;
      return {
        name,
        glb,
        ctrl: this.ctrl.bones[name],
        child,
        ctrlRestQ: objQ(this.ctrl.bones[name]),
        glbRestQ: objQ(glb),
        glbRestDir: glbRestDir && glbRestDir.lengthSq() > 1e-10 ? glbRestDir.normalize() : null,
        glbRestLocalQ: glb.quaternion.clone(),
      };
    });
    const glbHips = bones.Hips!;
    const glbRestObj = objPos(glbHips);
    const ctrlRestObj = objPos(this.ctrl.bones.Hips);
    this.hips = { glb: glbHips, ctrl: this.ctrl.bones.Hips, glbRestObj, ctrlRestObj, ratio: ctrlRestObj.y > 0.01 ? glbRestObj.y / ctrlRestObj.y : 1 };
    this.model = model;
    this.ctrl.object.visible = false;
  }

  play(action: AvatarAction, opts?: { speed?: number; now?: number }): void {
    this.ctrl.play(action, opts);
  }

  playStrike(tl: StrikeTimeline): void {
    this.ctrl.playStrike(tl);
  }

  cancelStrike(hand: Hand): void {
    this.ctrl.cancelStrike(hand);
  }

  setHeadOffset(x: number, y: number): void {
    this.ctrl.setHeadOffset(x, y);
  }

  setGuardWeight(w: number): void {
    this.ctrl.setGuardWeight(w);
  }

  isTelegraphing(now: number): boolean {
    return this.ctrl.isTelegraphing(now);
  }

  /** 판정·디버그 볼륨은 캐릭터 메쉬와 무관한 정규 볼륨(컨트롤러 기준) */
  getHitVolumes(): HitVolumes {
    return this.ctrl.getHitVolumes();
  }

  update(dt: number, now: number): void {
    this.ctrl.update(dt, now);
    if (!this.model || !this.hips) return;
    this.object.updateMatrixWorld(true);
    const inv = this.object.getWorldQuaternion(new THREE.Quaternion()).invert();
    const tmpQ = new THREE.Quaternion();
    const objQ = (o: THREE.Object3D) => inv.clone().multiply(o.getWorldQuaternion(tmpQ));
    const objPos = (o: THREE.Object3D) => this.object.worldToLocal(o.getWorldPosition(new THREE.Vector3()));

    // 골반 위치: 컨트롤러의 레스트 대비 변위(바운스·숙이기·러지·KO)를 GLB 골반 높이 비율로 옮긴다
    const h = this.hips;
    const delta = objPos(h.ctrl).sub(h.ctrlRestObj).multiplyScalar(h.ratio);
    const target = this.object.localToWorld(h.glbRestObj.clone().add(delta));
    h.glb.position.copy(h.glb.parent ? h.glb.parent.worldToLocal(target) : target);
    h.glb.updateMatrixWorld(true);

    for (const l of this.links) {
      if (l.name !== 'Hips' && !l.child) {
        // 손·발·머리 등 말단: 컨트롤러가 회전시키지 않으므로 부모를 따라간다(레스트 로컬 회전 유지)
        l.glb.quaternion.copy(l.glbRestLocalQ);
        l.glb.updateMatrixWorld(true);
        continue;
      }
      // 컨트롤러 본의 레스트 대비 회전(object 좌표계)을 GLB 레스트에 적용
      const d = objQ(l.ctrl).multiply(l.ctrlRestQ.clone().invert());
      const want = d.clone().multiply(l.glbRestQ);
      if (l.child && l.glbRestDir) {
        // 본 방향을 컨트롤러 본 방향에 정확히 맞춘다 (레스트 자세 차이 보정)
        const ctrlDir = objPos(this.ctrl.bones[l.child]).sub(objPos(l.ctrl));
        if (ctrlDir.lengthSq() > 1e-10) {
          const cur = l.glbRestDir.clone().applyQuaternion(d);
          want.premultiply(new THREE.Quaternion().setFromUnitVectors(cur, ctrlDir.normalize()));
        }
      }
      const parentQ = l.glb.parent ? objQ(l.glb.parent) : new THREE.Quaternion();
      l.glb.quaternion.copy(parentQ.invert().multiply(want));
      l.glb.updateMatrixWorld(true);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.model) disposeTree(this.model);
    this.ctrl.dispose();
    this.object.removeFromParent();
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
  root.removeFromParent();
}

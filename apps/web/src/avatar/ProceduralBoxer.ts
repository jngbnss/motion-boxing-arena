// 절차적 프리미티브 복서: mba-humanoid-v1 본 계층에 프리미티브 메쉬를 강체로 붙인다(= rigid bind, T1과 같은 방식).
// 애니메이션은 클립 대신 절차적 컨트롤러(아이들 바운스, 가드, 2본 IK 펀치, 피격, KO).
import * as THREE from 'three';
import { BONES, HIT_VOLUMES, type BoneName, type CharacterManifest, type Hand, type Stance } from '@mba/shared';
import { stepCriticalSpring, type SpringState } from '../game/spring.ts';
import type { AvatarAction, BoxerAvatar, HitVolumes, StrikeTimeline } from './types.ts';

const UPPER_ARM = 0.3;
const FOREARM = 0.28;
const SKIN = '#e0b48f';

/** 본 레스트 오프셋 (부모 기준, 정면 +Z, 캐릭터 왼쪽 +X) */
const REST: Record<BoneName, { parent: BoneName | null; pos: [number, number, number] }> = {
  Hips: { parent: null, pos: [0, 1.0, 0] },
  Spine: { parent: 'Hips', pos: [0, 0.1, 0] },
  Spine1: { parent: 'Spine', pos: [0, 0.14, 0] },
  Spine2: { parent: 'Spine1', pos: [0, 0.14, 0] },
  Neck: { parent: 'Spine2', pos: [0, 0.12, 0] },
  Head: { parent: 'Neck', pos: [0, 0.06, 0] },
  LeftShoulder: { parent: 'Spine2', pos: [0.04, 0.08, 0] },
  LeftArm: { parent: 'LeftShoulder', pos: [0.14, 0, 0] },
  LeftForeArm: { parent: 'LeftArm', pos: [UPPER_ARM, 0, 0] },
  LeftHand: { parent: 'LeftForeArm', pos: [FOREARM, 0, 0] },
  RightShoulder: { parent: 'Spine2', pos: [-0.04, 0.08, 0] },
  RightArm: { parent: 'RightShoulder', pos: [-0.14, 0, 0] },
  RightForeArm: { parent: 'RightArm', pos: [-UPPER_ARM, 0, 0] },
  RightHand: { parent: 'RightForeArm', pos: [-FOREARM, 0, 0] },
  LeftUpLeg: { parent: 'Hips', pos: [0.1, -0.04, 0] },
  LeftLeg: { parent: 'LeftUpLeg', pos: [0, -0.44, 0] },
  LeftFoot: { parent: 'LeftLeg', pos: [0, -0.43, 0] },
  LeftToeBase: { parent: 'LeftFoot', pos: [0, -0.04, 0.12] },
  RightUpLeg: { parent: 'Hips', pos: [-0.1, -0.04, 0] },
  RightLeg: { parent: 'RightUpLeg', pos: [0, -0.44, 0] },
  RightFoot: { parent: 'RightLeg', pos: [0, -0.43, 0] },
  RightToeBase: { parent: 'RightFoot', pos: [0, -0.04, 0.12] },
};

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** 공격 타임라인에서 손 신전도(-1 = 예비동작 최대, 0 = 가드, 1 = 최대 신전)와 예비동작 여부 */
export function strikeExtension(tl: StrikeTimeline | null, now: number): { ext: number; telegraph: number } {
  if (!tl || now < tl.aimLockAt || now >= tl.recoveryEndsAt) return { ext: 0, telegraph: 0 };
  if (now < tl.startupAt) {
    const p = (now - tl.aimLockAt) / Math.max(1, tl.startupAt - tl.aimLockAt);
    return { ext: -0.35 * smooth(p / 0.4), telegraph: 1 };
  }
  if (now < tl.activeAt) {
    const p = (now - tl.startupAt) / Math.max(1, tl.activeAt - tl.startupAt);
    return { ext: smooth(p), telegraph: 0 };
  }
  if (now < tl.activeEndsAt) return { ext: 1, telegraph: 0 };
  const p = (now - tl.activeEndsAt) / Math.max(1, tl.recoveryEndsAt - tl.activeEndsAt);
  return { ext: 1 - smooth(p), telegraph: 0 };
}

function capsule(radius: number, length: number, color: THREE.ColorRepresentation, axis: 'x+' | 'x-' | 'y-' | 'y+'): THREE.Mesh {
  const g = new THREE.CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 6, 12);
  const half = length / 2;
  if (axis === 'x+') { g.rotateZ(-Math.PI / 2); g.translate(half, 0, 0); }
  if (axis === 'x-') { g.rotateZ(Math.PI / 2); g.translate(-half, 0, 0); }
  if (axis === 'y-') g.translate(0, -half, 0);
  if (axis === 'y+') g.translate(0, half, 0);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
  m.castShadow = true;
  return m;
}

export interface ProceduralBoxerOptions {
  stance?: Stance;
}

export class ProceduralBoxer implements BoxerAvatar {
  readonly object = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly bones = {} as Record<BoneName, THREE.Bone>;
  private readonly gloveMats: Record<'left' | 'right', THREE.MeshStandardMaterial>;
  private readonly stance: Stance;
  private strikes: Record<Hand, StrikeTimeline | null> = { lead: null, rear: null };
  private guardTarget = 0;
  private guard: SpringState = { x: 0, v: 0 };
  private headTarget = { x: 0, y: 0 };
  private headX: SpringState = { x: 0, v: 0 };
  private headY: SpringState = { x: 0, v: 0 };
  private hitUntil = 0;
  private hitZone: 'head' | 'body' = 'head';
  private koAt: number | null = null;
  private victoryAt: number | null = null;
  private time = 0;
  private disposables: Array<{ dispose(): void }> = [];

  constructor(readonly manifest: CharacterManifest, opts: ProceduralBoxerOptions = {}) {
    this.stance = opts.stance ?? 'orthodox';
    const pal = manifest.skin?.palette ?? ['#d63a2f', '#1f2a44', '#ffcf3f', '#e8231a'];
    const [shirt, trunks, accent, gloves] = [pal[0]!, pal[1] ?? pal[0]!, pal[2] ?? pal[0]!, pal[3] ?? pal[0]!];

    for (const name of BONES) {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(...REST[name].pos);
      this.bones[name] = b;
    }
    for (const name of BONES) {
      const parent = REST[name].parent;
      if (parent) this.bones[parent].add(this.bones[name]);
    }
    this.body.add(this.bones.Hips);
    this.object.add(this.body);
    this.object.scale.setScalar(manifest.scale ?? 1);

    const B = this.bones;
    // 몸통·하체
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.15, 0.24, 16), new THREE.MeshStandardMaterial({ color: trunks, roughness: 0.5 }));
    trunk.position.y = -0.02;
    B.Hips.add(trunk);
    B.Spine1.add(capsule(0.17, 0.42, shirt, 'y+').translateY(-0.12));
    const chestDecal = manifest.skin?.decals?.chest;
    if (chestDecal) {
      const tex = new THREE.TextureLoader().load(chestDecal);
      tex.colorSpace = THREE.SRGBColorSpace;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshStandardMaterial({ map: tex, transparent: true }));
      plane.position.set(0, 0.05, 0.172);
      B.Spine2.add(plane);
      this.disposables.push(tex);
    }
    B.Neck.add(capsule(0.06, 0.12, SKIN, 'y+'));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.7 }));
    head.position.y = 0.07;
    head.castShadow = true;
    B.Head.add(head);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.118, 0.018, 8, 24), new THREE.MeshStandardMaterial({ color: accent }));
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.11;
    B.Head.add(band);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), new THREE.MeshStandardMaterial({ color: '#111' }));
      eye.position.set(sx * 0.04, 0.08, 0.108);
      B.Head.add(eye);
    }
    // 팔
    const mkGlove = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.35, emissive: new THREE.Color('#ffb020'), emissiveIntensity: 0 });
    this.gloveMats = { left: mkGlove(gloves), right: mkGlove(gloves) };
    for (const side of ['Left', 'Right'] as const) {
      const ax = side === 'Left' ? 'x+' : 'x-';
      B[`${side}Arm`].add(capsule(0.055, UPPER_ARM, SKIN, ax));
      B[`${side}ForeArm`].add(capsule(0.05, FOREARM, SKIN, ax));
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.09, 18, 14), this.gloveMats[side === 'Left' ? 'left' : 'right']);
      glove.scale.set(1, 0.95, 1.15);
      glove.castShadow = true;
      B[`${side}Hand`].add(glove);
      B[`${side}UpLeg`].add(capsule(0.075, 0.44, SKIN, 'y-'));
      B[`${side}Leg`].add(capsule(0.06, 0.43, SKIN, 'y-'));
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.22), new THREE.MeshStandardMaterial({ color: accent }));
      shoe.position.set(0, -0.03, 0.05);
      B[`${side}Foot`].add(shoe);
    }
  }

  async load(): Promise<void> {
    /* 절차적 모델: 로딩할 에셋 없음. GLB 아바타(T1/T2)는 같은 인터페이스로 추가 예정 */
  }

  play(action: AvatarAction, opts: { speed?: number; now?: number } = {}): void {
    const now = opts.now ?? this.time;
    switch (action) {
      case 'hit_head':
      case 'hit_body':
        this.hitUntil = now + 300;
        this.hitZone = action === 'hit_head' ? 'head' : 'body';
        break;
      case 'ko':
        this.koAt = now;
        this.strikes = { lead: null, rear: null };
        break;
      case 'victory':
        this.victoryAt = now;
        break;
      case 'guard':
        this.guardTarget = 1;
        break;
      case 'idle':
        this.koAt = null;
        this.victoryAt = null;
        this.hitUntil = 0;
        this.guardTarget = 0;
        this.strikes = { lead: null, rear: null };
        break;
    }
  }

  playStrike(tl: StrikeTimeline): void {
    this.strikes[tl.hand] = tl;
  }

  cancelStrike(hand: Hand): void {
    this.strikes[hand] = null;
  }

  setHeadOffset(x: number, y: number): void {
    this.headTarget = { x, y };
  }

  setGuardWeight(w: number): void {
    this.guardTarget = w;
  }

  /** 지금 예비동작 중인 손이 있는가 (HUD "!" 표시용) */
  isTelegraphing(now: number): boolean {
    return (['lead', 'rear'] as const).some((h) => strikeExtension(this.strikes[h], now).telegraph > 0);
  }

  getHitVolumes(): HitVolumes {
    const w = (b: THREE.Object3D, off = new THREE.Vector3()) => b.localToWorld(off.clone());
    const leadSide = this.stance === 'orthodox' ? 'Left' : 'Right';
    const rearSide = leadSide === 'Left' ? 'Right' : 'Left';
    return {
      head: { center: w(this.bones.Head, new THREE.Vector3(0, 0.07, 0)), radius: HIT_VOLUMES.headRadius },
      body: { center: w(this.bones.Spine1), radius: HIT_VOLUMES.bodyRadius, height: HIT_VOLUMES.bodyHeight },
      gloves: {
        lead: { center: w(this.bones[`${leadSide}Hand`]), radius: HIT_VOLUMES.gloveRadius },
        rear: { center: w(this.bones[`${rearSide}Hand`]), radius: HIT_VOLUMES.gloveRadius },
      },
    };
  }

  update(dt: number, now: number): void {
    this.time = now;
    const B = this.bones;
    const sec = now / 1000;
    this.guard = stepCriticalSpring(this.guard, this.guardTarget, 14, dt);
    this.headX = stepCriticalSpring(this.headX, this.headTarget.x, 12, dt);
    this.headY = stepCriticalSpring(this.headY, this.headTarget.y, 12, dt);
    const hx = this.headX.x;
    const duck = Math.max(0, -this.headY.x);

    // 리셋
    for (const name of BONES) B[name].quaternion.identity();
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);

    // KO
    if (this.koAt != null) {
      const p = smooth((now - this.koAt) / 900);
      this.body.rotation.x = -1.45 * p;
      this.body.position.z = -0.25 * p;
      B.Neck.rotation.x = -0.3 * p;
      this.solveArm('Left', new THREE.Vector3(0.32, 1.0, 0.05));
      this.solveArm('Right', new THREE.Vector3(-0.32, 1.0, 0.05));
      return;
    }

    // 아이들 바운스 + 하체
    const bounce = Math.sin(sec * Math.PI * 2 * 1.6);
    B.Hips.position.y = REST.Hips.pos[1] + 0.018 * bounce - duck * 0.2;
    B.Hips.rotation.y = 0.05 * Math.sin(sec * 1.3);
    B.LeftUpLeg.rotation.x = -0.12 - duck * 0.5;
    B.RightUpLeg.rotation.x = 0.1 - duck * 0.5;
    B.LeftLeg.rotation.x = 0.15 + duck * 0.9 + 0.03 * bounce;
    B.RightLeg.rotation.x = 0.12 + duck * 0.9 + 0.03 * bounce;
    B.LeftFoot.rotation.x = -0.03 - duck * 0.4;
    B.RightFoot.rotation.x = -0.02 - duck * 0.4;

    // 머리 오프셋(시각): 자기 오른쪽(+headX) = -X 방향으로 상체 기울임, 숙이기는 앞으로 굽힘
    B.Spine.rotation.z = hx * 0.3;
    B.Spine.rotation.x = duck * 0.35;
    B.Neck.rotation.z = -hx * 0.1;

    // 공격
    const leadSide: 'Left' | 'Right' = this.stance === 'orthodox' ? 'Left' : 'Right';
    const sideOf = (h: Hand): 'Left' | 'Right' => (h === 'lead' ? leadSide : leadSide === 'Left' ? 'Right' : 'Left');
    const exts: Record<'Left' | 'Right', { ext: number; telegraph: number }> = { Left: { ext: 0, telegraph: 0 }, Right: { ext: 0, telegraph: 0 } };
    for (const h of ['lead', 'rear'] as const) {
      const r = strikeExtension(this.strikes[h], now);
      exts[sideOf(h)] = r;
      if (this.strikes[h] && now >= this.strikes[h]!.recoveryEndsAt) this.strikes[h] = null;
    }
    const lunge = Math.max(0, exts.Left.ext, exts.Right.ext);
    this.body.position.z = 0.3 * lunge;
    // 펀치하는 쪽 어깨가 앞으로 오도록 몸통 비틀기 (왼쪽 펀치 = 음의 Y 회전)
    B.Spine1.rotation.y = -0.35 * exts.Left.ext + 0.35 * exts.Right.ext;
    this.gloveMats.left.emissiveIntensity = exts.Left.telegraph * (0.6 + 0.4 * Math.sin(sec * 40));
    this.gloveMats.right.emissiveIntensity = exts.Right.telegraph * (0.6 + 0.4 * Math.sin(sec * 40));

    // 피격
    if (now < this.hitUntil) {
      const k = Math.sin(((this.hitUntil - now) / 300) * Math.PI);
      if (this.hitZone === 'head') {
        B.Neck.rotation.x = -0.45 * k;
        B.Spine.rotation.x -= 0.12 * k;
      } else {
        B.Spine.rotation.x += 0.35 * k;
      }
    }

    this.object.updateMatrixWorld(true);

    // 손 목표점 (몸체 로컬). 가드 가중치: 기본 복싱 자세 0.45 + 가드 입력
    const g = this.victoryAt != null ? 0 : 0.45 + 0.55 * Math.min(1, Math.max(0, this.guard.x));
    for (const side of ['Left', 'Right'] as const) {
      const s = side === 'Left' ? 1 : -1;
      const isLead = side === leadSide;
      const low = new THREE.Vector3(0.2 * s, 1.25, isLead ? 0.34 : 0.26);
      const high = new THREE.Vector3(0.09 * s, 1.58, isLead ? 0.24 : 0.19);
      const target = low.lerp(high, g);
      target.x -= hx * 0.12;
      target.y -= duck * 0.25;
      const { ext } = exts[side];
      if (ext > 0) {
        const punch = new THREE.Vector3(0.03 * s - hx * 0.1, 1.56 - duck * 0.2, 0.68);
        target.lerp(punch, ext);
      } else if (ext < 0) {
        target.z += ext * 0.35;
        target.y += -ext * 0.06;
      }
      if (this.victoryAt != null) target.set(0.25 * s, 2.1, 0.05);
      this.solveArm(side, target);
    }
  }

  /** 2본 해석 IK: 목표점(몸체 로컬)으로 팔·전완 회전을 정한다 */
  private solveArm(side: 'Left' | 'Right', targetLocal: THREE.Vector3): void {
    const arm = this.bones[`${side}Arm`];
    const fore = this.bones[`${side}ForeArm`];
    const s = side === 'Left' ? 1 : -1;
    this.body.updateMatrixWorld(true);
    const S = arm.getWorldPosition(new THREE.Vector3());
    const T = this.body.localToWorld(targetLocal.clone());
    const bodyQ = this.body.getWorldQuaternion(new THREE.Quaternion());
    const pole = new THREE.Vector3(0.6 * s, -1, -0.3).normalize().applyQuaternion(bodyQ);
    const a = UPPER_ARM;
    const b = FOREARM;
    const toT = T.clone().sub(S);
    const d = Math.min(Math.max(toT.length(), 0.05), a + b - 1e-3);
    const u = toT.normalize();
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const w = pole.clone().sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
    const E = S.clone().add(u.clone().multiplyScalar(a * cosA)).add(w.multiplyScalar(a * sinA));
    const Tc = S.clone().add(u.clone().multiplyScalar(d));
    const axis = new THREE.Vector3(s, 0, 0);
    const aim = (bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3) => {
      const parentQ = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
      const dirLocal = to.clone().sub(from).normalize().applyQuaternion(parentQ.invert());
      bone.quaternion.setFromUnitVectors(axis, dirLocal);
      bone.updateMatrixWorld(true);
    };
    aim(arm, S, E);
    aim(fore, E, Tc);
  }

  dispose(): void {
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
      }
    });
    this.disposables.forEach((d) => d.dispose());
    this.object.removeFromParent();
  }
}

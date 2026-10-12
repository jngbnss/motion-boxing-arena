// 1인칭 카메라 리그: 자기 글러브 + 전완만 표시 (docs/10 §3). 머리 오프셋은 감쇠 스프링으로 카메라에만 반영(C11).
import * as THREE from 'three';
import { CAMERA_SPRING_OMEGA, HEAD_CAMERA_OFFSET_SCALE, NEUTRAL_HEAD_POS, type Hand, type Skin, type Stance } from '@mba/shared';
import { ARM_SKIN_T, strikeExtension } from '../avatar/ProceduralBoxer.ts';
import type { StrikeTimeline } from '../avatar/types.ts';
import { clamp, Spring2 } from '../game/spring.ts';
import { applyBodySkin, bodySkinMaterial, loadBodySkin, setTemplateUv } from '../skin/bodySkin.ts';
import { armPoint } from '../skin/bodyTemplate.ts';

const SKIN = '#e0b48f';
const MAX_ROLL = (5 * Math.PI) / 180;

export class FirstPersonRig {
  readonly rig = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  private spring = new Spring2(CAMERA_SPRING_OMEGA);
  private gloves: Record<'left' | 'right', THREE.Mesh>;
  private forearms: Record<'left' | 'right', THREE.Mesh>;
  private strikes: Record<Hand, StrikeTimeline | null> = { lead: null, rear: null };
  private guard = 0;
  private guardTarget = 0;
  private headTarget = { x: 0, y: 0 };
  private impulse = new THREE.Vector3();
  private impulseVel = new THREE.Vector3();
  private koAt: number | null = null;
  shake = 1;

  private disposables: Array<{ dispose(): void }> = [];
  private disposed = false;

  constructor(private stance: Stance, skin: Skin | undefined) {
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.03, 60);
    this.rig.position.set(NEUTRAL_HEAD_POS.x, NEUTRAL_HEAD_POS.y, 0.02);
    this.rig.add(this.camera);
    const bodyUrl = skin?.decals?.body;
    const mat = (p: THREE.MeshStandardMaterialParameters) => (bodyUrl ? bodySkinMaterial(p) : new THREE.MeshStandardMaterial(p));
    const gloveMat = mat({ color: skin?.palette[3] ?? '#e8231a', roughness: 0.35 });
    const armMat = mat({ color: SKIN, roughness: 0.7 });
    const mkGlove = () => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.075, 24, 18), gloveMat);
      m.scale.set(1, 0.92, 1.2);
      return m;
    };
    const mkArm = () => new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.045, 1, 12), armMat);
    this.gloves = { left: mkGlove(), right: mkGlove() };
    this.forearms = { left: mkArm(), right: mkArm() };
    for (const s of ['left', 'right'] as const) {
      this.camera.add(this.gloves[s]);
      this.camera.add(this.forearms[s]);
    }
    if (bodyUrl) {
      // 전신 스킨의 팔 구간을 입힌다. 화면 왼쪽 손 = 내 왼손 = 템플릿(정면 그림)의 오른쪽 팔
      const id = new THREE.Matrix4();
      for (const s of ['left', 'right'] as const) {
        const side = s === 'left' ? 1 : -1;
        // 글러브: 카메라 쪽(+z) = 손목, 먼 쪽(-z) = 주먹 끝
        setTemplateUv(this.gloves[s].geometry, id, (p) => armPoint(side, ARM_SKIN_T.glove + (1 - ARM_SKIN_T.glove) * (0.5 - p.z / 0.15), p.y / 0.075));
        // 전완: 로컬 -y 끝 = 손목(글러브 쪽), +y 끝 = 팔꿈치
        setTemplateUv(this.forearms[s].geometry, id, (p) => armPoint(side, ARM_SKIN_T.glove - (ARM_SKIN_T.glove - ARM_SKIN_T.forearm) * (p.y + 0.5), p.x / 0.045));
      }
      loadBodySkin(bodyUrl).then(
        ({ texture }) => {
          if (this.disposed) { texture.dispose(); return; }
          applyBodySkin([gloveMat, armMat], texture);
          this.disposables.push(texture);
        },
        (e: unknown) => console.warn('전신 스킨을 불러오지 못해 팔레트 색으로 표시합니다', e),
      );
    }
  }

  setStance(stance: Stance): void {
    this.stance = stance;
  }

  setHeadOffset(x: number, y: number): void {
    this.headTarget = { x, y };
  }

  setGuardWeight(w: number): void {
    this.guardTarget = w;
  }

  playStrike(tl: StrikeTimeline): void {
    this.strikes[tl.hand] = tl;
  }

  cancelStrike(hand: Hand): void {
    this.strikes[hand] = null;
  }

  /** 피격 시 카메라 임펄스 (m/s, 카메라 로컬) */
  hitImpulse(strength: number): void {
    this.impulseVel.add(new THREE.Vector3((Math.random() - 0.5) * strength, (Math.random() - 0.2) * strength * 0.5, strength));
  }

  knockedOut(now: number): void {
    this.koAt = now;
  }

  reset(): void {
    this.koAt = null;
    this.strikes = { lead: null, rear: null };
    this.spring.reset();
    this.impulse.set(0, 0, 0);
    this.impulseVel.set(0, 0, 0);
    this.camera.rotation.set(0, 0, 0);
  }

  update(dt: number, now: number): void {
    // 카메라: 머리 오프셋 × 0.25m, 임계 감쇠, 클램프, yaw/pitch 없음, 롤 ≤ 5°
    const tx = this.headTarget.x * HEAD_CAMERA_OFFSET_SCALE.x * this.shake;
    const ty = this.headTarget.y * HEAD_CAMERA_OFFSET_SCALE.y * this.shake;
    const p = this.spring.update(tx, ty, dt);
    const cx = clamp(p.x, -HEAD_CAMERA_OFFSET_SCALE.x, HEAD_CAMERA_OFFSET_SCALE.x);
    const cy = clamp(p.y, -HEAD_CAMERA_OFFSET_SCALE.y, HEAD_CAMERA_OFFSET_SCALE.y);
    // 임펄스: 감쇠 스프링으로 원점 복귀
    this.impulseVel.addScaledVector(this.impulse, -260 * dt);
    this.impulseVel.multiplyScalar(Math.exp(-18 * dt));
    this.impulse.addScaledVector(this.impulseVel, dt);
    this.rig.position.set(cx + this.impulse.x, NEUTRAL_HEAD_POS.y + cy + this.impulse.y, 0.02 + this.impulse.z);
    let roll = clamp((-cx / HEAD_CAMERA_OFFSET_SCALE.x) * MAX_ROLL, -MAX_ROLL, MAX_ROLL);
    let pitch = 0;
    if (this.koAt != null) {
      const k = Math.min(1, (now - this.koAt) / 1200);
      pitch = 0.9 * k;
      roll += 0.35 * k;
      this.rig.position.y -= 0.9 * k;
    }
    this.camera.rotation.set(pitch, 0, roll);

    // 글러브: 리드 손 = 오소독스면 화면 왼쪽
    this.guard += (this.guardTarget - this.guard) * Math.min(1, dt * 14);
    const g = 0.45 + 0.55 * clamp(this.guard, 0, 1);
    const leadSide: 'left' | 'right' = this.stance === 'orthodox' ? 'left' : 'right';
    for (const side of ['left', 'right'] as const) {
      const s = side === 'left' ? -1 : 1;
      const hand: Hand = side === leadSide ? 'lead' : 'rear';
      const tl = this.strikes[hand];
      const { ext } = strikeExtension(tl, now);
      if (tl && now >= tl.recoveryEndsAt) this.strikes[hand] = null;
      const isLead = hand === 'lead';
      const low = new THREE.Vector3(0.19 * s, -0.24, isLead ? -0.4 : -0.35);
      const high = new THREE.Vector3(0.085 * s, -0.085, isLead ? -0.29 : -0.26);
      const pos = low.lerp(high, g);
      if (ext > 0) pos.lerp(new THREE.Vector3(0.03 * s, -0.02, -0.8), ext);
      if (this.koAt != null) pos.set(0.3 * s, -0.6, -0.3);
      const glove = this.gloves[side];
      glove.position.copy(pos);
      glove.rotation.set(-0.2, 0.25 * s, 0);
      // 전완: 글러브 뒤쪽에서 화면 아래 바깥으로
      const elbow = new THREE.Vector3(pos.x * 1.5 + 0.12 * s, -0.55, pos.z * 0.35 + 0.05);
      const start = pos.clone().add(new THREE.Vector3(0, -0.02, 0.06));
      const dir = elbow.clone().sub(start);
      const len = dir.length();
      const arm = this.forearms[side];
      arm.position.copy(start).addScaledVector(dir, 0.5);
      arm.scale.set(1, len, 1);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    }
  }

  dispose(): void {
    this.disposed = true;
    const mats = new Set<THREE.Material>();
    this.rig.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        mats.add(m.material as THREE.Material);
      }
    });
    mats.forEach((m) => m.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}

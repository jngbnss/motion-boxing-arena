// C4. BoxerAvatar 인터페이스. 판정은 packages/combat가 비감쇠 PoseState로 계산하고(C11),
// 아바타는 시각 표현만 담당한다.
import type * as THREE from 'three';
import type { CharacterManifest, Hand, StrikeType } from '@mba/shared';

export type AvatarAction = 'idle' | 'guard' | 'hit_head' | 'hit_body' | 'ko' | 'victory';

/** 공격 타임라인(절대 시각, ms, 게임 시계) */
export interface StrikeTimeline {
  hand: Hand;
  type: StrikeType;
  aimLockAt: number;
  startupAt: number;
  activeAt: number;
  activeEndsAt: number;
  recoveryEndsAt: number;
}

export interface HitVolumes {
  head: { center: THREE.Vector3; radius: number };
  body: { center: THREE.Vector3; radius: number; height: number };
  gloves: Record<Hand, { center: THREE.Vector3; radius: number }>;
}

export interface BoxerAvatar {
  readonly manifest: CharacterManifest;
  readonly object: THREE.Object3D;
  load(): Promise<void>;
  play(action: AvatarAction, opts?: { speed?: number; now?: number }): void;
  /** 공격 애니메이션 (telegraph → startup → active → recovery) */
  playStrike(tl: StrikeTimeline): void;
  cancelStrike(hand: Hand): void;
  /** 시각 표현 전용(감쇠 적용). 판정에 쓰지 않음 */
  setHeadOffset(x: number, y: number): void;
  setGuardWeight(w: number): void;
  /** 디버그 표시용 정규 볼륨 */
  getHitVolumes(): HitVolumes;
  /** 지금 예비동작 중인 손이 있는가 (HUD "!" 표시용) */
  isTelegraphing(now: number): boolean;
  update(dt: number, now: number): void;
  dispose(): void;
}

// 경기 3D 무대 공용부: 렌더 출력·아레나·1인칭 리그(내 글러브)·상대 아바타·스파크·리사이즈.
// 싱글(GameSession)과 온라인(OnlineSession)이 같은 무대를 쓴다.
import * as THREE from 'three';
import type { CharacterManifest, Stance } from '@mba/shared';
import { createAvatar } from '../avatar/createAvatar.ts';
import type { BoxerAvatar } from '../avatar/types.ts';
import { buildArena } from '../render/Arena.ts';
import { Sparks } from '../render/Effects.ts';
import { FirstPersonRig } from '../render/FirstPersonRig.ts';
import { SingleViewOutput, type ViewOutput } from '../render/ViewOutput.ts';

export const OPPONENT_DISTANCE = 1.1;

export interface MatchSceneOptions {
  container: HTMLElement;
  player: CharacterManifest;
  opponent: CharacterManifest;
  stance: Stance;
  cameraShake: number;
}

export class MatchScene {
  readonly scene = new THREE.Scene();
  readonly fp: FirstPersonRig;
  readonly sparks = new Sparks();
  opponent: BoxerAvatar;
  private readonly view: ViewOutput;
  private readonly disposeArena: () => void;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly opts: MatchSceneOptions) {
    this.view = new SingleViewOutput();
    opts.container.appendChild(this.view.domElement);
    this.disposeArena = buildArena(this.scene);

    const gloveColor = opts.player.skin?.palette[3] ?? '#e8231a';
    this.fp = new FirstPersonRig(opts.stance, gloveColor);
    this.fp.shake = opts.cameraShake;
    this.scene.add(this.fp.rig);

    this.opponent = this.makeOpponent(opts.opponent);
    this.scene.add(this.sparks.points);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(opts.container);
    this.resize();
  }

  private makeOpponent(m: CharacterManifest): BoxerAvatar {
    const a = createAvatar(m, { stance: 'orthodox' });
    a.object.position.set(0, 0, -OPPONENT_DISTANCE);
    this.scene.add(a.object);
    return a;
  }

  /** 상대 외형 교체 (온라인: 상대 캐릭터 매니페스트를 늦게 받은 경우) */
  async replaceOpponent(m: CharacterManifest, now: number): Promise<void> {
    if (m.id === this.opponent.manifest.id && m.glbUrl === this.opponent.manifest.glbUrl) return;
    const next = createAvatar(m, { stance: 'orthodox' });
    await next.load();
    this.opponent.dispose();
    next.object.position.set(0, 0, -OPPONENT_DISTANCE);
    next.play('idle', { now });
    this.scene.add(next.object);
    this.opponent = next;
  }

  /** 상대 머리 부근(히트 스파크 위치) */
  opponentHead(): THREE.Vector3 {
    return new THREE.Vector3(0, 1.63, -OPPONENT_DISTANCE + 0.02);
  }

  private resize(): void {
    const w = this.opts.container.clientWidth || 1;
    const h = this.opts.container.clientHeight || 1;
    this.view.resize(w, h);
    this.fp.camera.aspect = w / h;
    this.fp.camera.updateProjectionMatrix();
  }

  /** 애니메이션 진행 (일시정지 중에는 호출하지 않는다) */
  animate(dt: number, animNow: number): void {
    this.fp.update(dt, animNow);
    this.opponent.update(dt, animNow);
    this.sparks.update(dt);
  }

  render(): void {
    this.view.render(this.scene, this.fp.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.opponent.dispose();
    this.fp.dispose();
    this.sparks.dispose();
    this.disposeArena();
    this.view.dispose();
    this.view.domElement.remove();
  }
}

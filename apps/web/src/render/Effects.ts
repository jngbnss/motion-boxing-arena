// 타격 스파크 파티클 (풀링).
import * as THREE from 'three';

const MAX = 256;
const LIFE = 0.38;

export class Sparks {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private col = new Float32Array(MAX * 3);
  private next = 0;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const m = new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }

  burst(at: THREE.Vector3, count: number, color: THREE.ColorRepresentation, speed = 2.5): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const k = this.next;
      this.next = (this.next + 1) % MAX;
      this.pos.set([at.x, at.y, at.z], k * 3);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      this.vel.set([v.x, v.y, v.z], k * 3);
      this.life[k] = LIFE;
      this.col.set([c.r, c.g, c.b], k * 3);
    }
  }

  update(dt: number): void {
    for (let k = 0; k < MAX; k++) {
      if (this.life[k]! <= 0) {
        this.pos[k * 3 + 1] = -100;
        continue;
      }
      this.life[k]! -= dt;
      this.vel[k * 3 + 1]! -= 6 * dt;
      for (let a = 0; a < 3; a++) this.pos[k * 3 + a]! += this.vel[k * 3 + a]! * dt;
      const f = Math.max(0, this.life[k]! / LIFE);
      for (let a = 0; a < 3; a++) this.col[k * 3 + a]! *= 0.9 + 0.1 * f;
    }
    this.points.geometry.attributes.position!.needsUpdate = true;
    this.points.geometry.attributes.color!.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

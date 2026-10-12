// 복싱 링: 바닥 매트, 에이프런, 코너 포스트, 로프 3단, 조명, 안개.
import * as THREE from 'three';

export const RING_HALF = 3;
/** 링 중심 (플레이어 z=0, 상대 z=-1.1 사이) */
export const RING_CENTER_Z = -0.55;

function matTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1d3b6e';
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.font = 'bold 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('MOTION BOXING', 256, 280);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildArena(scene: THREE.Scene): () => void {
  const disposables: Array<{ dispose(): void }> = [];
  const add = <T extends THREE.Object3D>(o: T) => { scene.add(o); return o; };

  scene.background = new THREE.Color('#07080c');
  scene.fog = new THREE.Fog('#07080c', 6, 18);

  const tex = matTexture();
  disposables.push(tex);
  const floor = add(new THREE.Mesh(new THREE.BoxGeometry(RING_HALF * 2, 0.2, RING_HALF * 2), [
    new THREE.MeshStandardMaterial({ color: '#7a1010' }), new THREE.MeshStandardMaterial({ color: '#7a1010' }),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }), new THREE.MeshStandardMaterial({ color: '#7a1010' }),
    new THREE.MeshStandardMaterial({ color: '#7a1010' }), new THREE.MeshStandardMaterial({ color: '#7a1010' }),
  ]));
  floor.position.set(0, -0.1, RING_CENTER_Z);
  floor.receiveShadow = true;

  const ground = add(new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#0b0c10', roughness: 1 })));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.6;

  const postMat = new THREE.MeshStandardMaterial({ color: '#c9ccd6', metalness: 0.6, roughness: 0.3 });
  const ropeMats = [new THREE.MeshStandardMaterial({ color: '#d92b2b' }), new THREE.MeshStandardMaterial({ color: '#f2f2f2' }), new THREE.MeshStandardMaterial({ color: '#2b5bd9' })];
  const corners: Array<[number, number]> = [[-RING_HALF, -RING_HALF], [RING_HALF, -RING_HALF], [RING_HALF, RING_HALF], [-RING_HALF, RING_HALF]];
  for (const [x, z] of corners) {
    const post = add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 12), postMat));
    post.position.set(x, 0.75, z + RING_CENTER_Z);
  }
  for (let i = 0; i < 4; i++) {
    const [x1, z1] = corners[i]!;
    const [x2, z2] = corners[(i + 1) % 4]!;
    const len = Math.hypot(x2 - x1, z2 - z1);
    [0.45, 0.85, 1.25].forEach((y, k) => {
      const rope = add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 8), ropeMats[k]!));
      rope.position.set((x1 + x2) / 2, y, (z1 + z2) / 2 + RING_CENTER_Z);
      rope.rotation.z = Math.PI / 2;
      rope.rotation.y = Math.atan2(-(z2 - z1), x2 - x1);
    });
  }

  add(new THREE.HemisphereLight('#9fb6ff', '#1a0f0f', 0.55));
  const key = add(new THREE.SpotLight('#fff3e0', 60, 20, Math.PI / 5, 0.5, 1.2));
  key.position.set(0, 7, RING_CENTER_Z + 1);
  key.target.position.set(0, 1, RING_CENTER_Z);
  scene.add(key.target);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const rim = add(new THREE.PointLight('#ff4d3a', 6, 8));
  rim.position.set(-2.5, 2.2, -3);
  const rim2 = add(new THREE.PointLight('#4da3ff', 6, 8));
  rim2.position.set(2.5, 2.2, -3);

  // 관중석 실루엣 (어두운 박스)
  const crowdMat = new THREE.MeshStandardMaterial({ color: '#12131a', roughness: 1 });
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const r = 7 + (i % 3) * 0.6;
    const m = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1 + (i % 4) * 0.25, 0.4), crowdMat));
    m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r + RING_CENTER_Z);
  }

  return () => {
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
      }
    });
    disposables.forEach((d) => d.dispose());
  };
}

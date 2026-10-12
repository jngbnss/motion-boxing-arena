// 회전하는 복서 미리보기 (메인·캐릭터 선택·생성 화면 공용)
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { CharacterManifest } from '@mba/shared';
import { ProceduralBoxer } from '../avatar/ProceduralBoxer.ts';

export function BoxerPreview({ character, height = 320, punch = true }: { character: CharacterManifest; height?: number; punch?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      el.textContent = '3D 미리보기를 표시할 수 없어요 (WebGL 미지원).';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    camera.position.set(0, 1.3, 3.4);
    camera.lookAt(0, 1.05, 0);
    scene.add(new THREE.HemisphereLight('#bcd0ff', '#2a1a1a', 1.1));
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(2, 4, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight('#ff4d3a', 1.5);
    rim.position.set(-3, 2, -2);
    scene.add(rim);
    const boxer = new ProceduralBoxer(character);
    scene.add(boxer.object);

    const resize = () => {
      const w = el.clientWidth || 300;
      renderer.setSize(w, height, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let raf = 0;
    let last = performance.now();
    let nextPunch = last + 1200;
    let hand: 'lead' | 'rear' = 'lead';
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      boxer.object.rotation.y = Math.sin(now / 2400) * 0.6;
      if (punch && now > nextPunch) {
        const t0 = now;
        boxer.playStrike({ hand, type: hand === 'lead' ? 'jab' : 'straight', aimLockAt: t0, startupAt: t0 + 250, activeAt: t0 + 400, activeEndsAt: t0 + 480, recoveryEndsAt: t0 + 800 });
        hand = hand === 'lead' ? 'rear' : 'lead';
        nextPunch = now + 1400;
      }
      boxer.update(dt, now);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      boxer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [character, height, punch]);

  return <div ref={ref} style={{ width: '100%', minHeight: height }} />;
}

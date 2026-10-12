// 렌더 출력 추상화. 기본은 단일 뷰. 홀로그램(다중 뷰·퀼트) 구현체는 확장에서 같은 인터페이스로 추가한다(docs/02 §7).
import * as THREE from 'three';

export interface ViewOutput {
  readonly domElement: HTMLCanvasElement;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export class SingleViewOutput implements ViewOutput {
  readonly renderer: THREE.WebGLRenderer;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'three';
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

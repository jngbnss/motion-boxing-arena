import type { Difficulty, Stance } from '@mba/shared';
import { loadJson, saveJson } from './storage.ts';

export type PoseModel = 'lite' | 'full';
export type InputMode = 'webcam' | 'keyboard';

export interface Settings {
  stance: Stance;
  poseModel: PoseModel;
  debugOverlay: boolean;
  /** 카메라 흔들림(머리 추종) 강도 0..1 */
  cameraShake: number;
  /** 미니 웹캠 패널: 스켈레톤만 표시 */
  miniCam: boolean;
  difficulty: Difficulty;
  inputMode: InputMode;
  /** 3D 캐릭터 완성 시 다음 경기에 자동 교체 (C13) */
  autoSwapCharacter: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  stance: 'orthodox',
  poseModel: 'lite',
  debugOverlay: false,
  cameraShake: 1,
  miniCam: true,
  difficulty: 'normal',
  inputMode: 'webcam',
  autoSwapCharacter: true,
};

const KEY = 'mba.settings.v1';

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...loadJson<Partial<Settings>>(KEY, {}) };
}

export function saveSettings(s: Settings): void {
  saveJson(KEY, s);
}

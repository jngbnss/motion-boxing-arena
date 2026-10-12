// 티어별 아바타 생성: T1/T2(glbUrl 있음) → GltfBoxer, 기본·T0 → ProceduralBoxer(스킨 팔레트)
import type { CharacterManifest } from '@mba/shared';
import { GltfBoxer } from './GltfBoxer.ts';
import { ProceduralBoxer, type ProceduralBoxerOptions } from './ProceduralBoxer.ts';
import type { BoxerAvatar } from './types.ts';

export function createAvatar(manifest: CharacterManifest, opts: ProceduralBoxerOptions = {}): BoxerAvatar {
  if ((manifest.tier === 'T1' || manifest.tier === 'T2') && manifest.glbUrl) return new GltfBoxer(manifest, opts);
  return new ProceduralBoxer(manifest, opts);
}

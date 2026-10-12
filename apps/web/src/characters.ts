import { CharacterManifestSchema, SKELETON_ID, type CharacterManifest } from '@mba/shared';
import { loadJson, saveJson } from './storage.ts';

function builtin(id: string, name: string, palette: string[]): CharacterManifest {
  return {
    id,
    name,
    ownerId: null,
    skeleton: SKELETON_ID,
    tier: 'T0',
    glbUrl: null,
    thumbnailUrl: null,
    // 팔레트 순서: [주색(상의), 보조색(트렁크), 강조색(밴드·신발), 글러브색]
    skin: { palette, decals: {} },
    scale: 1,
    provenance: { model: 'builtin', modelVersion: '1', seed: null, rigger: 'manual', createdAt: '2026-10-12T00:00:00Z' },
    license: { userAttestedRights: true, visibility: 'private' },
    builtin: true,
  };
}

export const BUILTIN_CHARACTERS: readonly CharacterManifest[] = [
  builtin('builtin-red', '레드 블레이즈', ['#d63a2f', '#1f2a44', '#ffcf3f', '#e8231a']),
  builtin('builtin-blue', '블루 아이언', ['#2e6fd8', '#f2f2f2', '#9fd3ff', '#1d4fbf']),
  builtin('builtin-green', '그린 바이퍼', ['#2f9e57', '#111111', '#c6ff4a', '#23843f']),
];

/** AI 상대 기본 외형 */
export const AI_OPPONENT = builtin('ai-opponent', 'AI 복서', ['#5b5f6b', '#8a1c1c', '#ff7a1a', '#202020']);

const KEY = 'mba.characters.v1';
const SELECTED_KEY = 'mba.selectedCharacter.v1';

export function loadCustomCharacters(): CharacterManifest[] {
  const raw = loadJson<unknown[]>(KEY, []);
  const out: CharacterManifest[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const parsed = CharacterManifestSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function saveCustomCharacter(c: CharacterManifest): boolean {
  const list = loadCustomCharacters().filter((x) => x.id !== c.id);
  list.unshift(c);
  return saveJson(KEY, list.slice(0, 12));
}

export function deleteCustomCharacter(id: string): void {
  saveJson(KEY, loadCustomCharacters().filter((x) => x.id !== id));
}

export function allCharacters(): CharacterManifest[] {
  return [...BUILTIN_CHARACTERS, ...loadCustomCharacters()];
}

export function loadSelectedCharacterId(): string {
  return loadJson<string>(SELECTED_KEY, BUILTIN_CHARACTERS[0]!.id);
}

export function saveSelectedCharacterId(id: string): void {
  saveJson(SELECTED_KEY, id);
}

export function findCharacter(id: string): CharacterManifest {
  return allCharacters().find((c) => c.id === id) ?? BUILTIN_CHARACTERS[0]!;
}

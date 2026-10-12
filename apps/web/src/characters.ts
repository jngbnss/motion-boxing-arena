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
const SERVER_KEY = 'mba.serverCharacters.v1';
const JOBS_KEY = 'mba.generationJobs.v1';
const SELECTED_KEY = 'mba.selectedCharacter.v1';

function loadManifestList(key: string): CharacterManifest[] {
  const raw = loadJson<unknown[]>(key, []);
  const out: CharacterManifest[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const parsed = CharacterManifestSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** 로컬 T0 스킨 캐릭터 (브라우저 저장소 전용) */
export function loadCustomCharacters(): CharacterManifest[] {
  return loadManifestList(KEY);
}

export function saveCustomCharacter(c: CharacterManifest): boolean {
  const list = loadCustomCharacters().filter((x) => x.id !== c.id);
  list.unshift(c);
  return saveJson(KEY, list.slice(0, 12));
}

export function deleteCustomCharacter(id: string): void {
  saveJson(KEY, loadCustomCharacters().filter((x) => x.id !== id));
}

/** 서버에서 생성 완료(READY)된 캐릭터 매니페스트 캐시. 서버 목록(GET /characters)과 동기화한다 */
export function loadServerCharacters(): CharacterManifest[] {
  return loadManifestList(SERVER_KEY);
}

export function saveServerCharacter(c: CharacterManifest): void {
  const list = loadServerCharacters().filter((x) => x.id !== c.id);
  list.unshift(c);
  saveJson(SERVER_KEY, list.slice(0, 50));
}

/** 서버 목록에 없는(삭제·다른 서버) 캐시 항목 정리 */
export function pruneServerCharacters(keepIds: readonly string[]): void {
  saveJson(SERVER_KEY, loadServerCharacters().filter((x) => keepIds.includes(x.id)));
}

/** 진행 중인 3D 생성 작업 ↔ 먼저 만든 T0 캐릭터 연결 (완성 시 자동 교체용, C13) */
export interface GenerationJobRef {
  jobId: string;
  characterId: string;
  t0Id: string;
  name: string;
  createdAt: string;
}

export function loadGenerationJobs(): GenerationJobRef[] {
  const raw = loadJson<GenerationJobRef[]>(JOBS_KEY, []);
  return Array.isArray(raw) ? raw.filter((j) => typeof j?.jobId === 'string' && typeof j.characterId === 'string') : [];
}

export function saveGenerationJob(j: GenerationJobRef): void {
  saveJson(JOBS_KEY, [j, ...loadGenerationJobs().filter((x) => x.jobId !== j.jobId)].slice(0, 20));
}

export function removeGenerationJob(jobId: string): void {
  saveJson(JOBS_KEY, loadGenerationJobs().filter((x) => x.jobId !== jobId));
}

export function allCharacters(): CharacterManifest[] {
  return [...BUILTIN_CHARACTERS, ...loadServerCharacters(), ...loadCustomCharacters()];
}

// ── 온라인 룸용 캐릭터 ID (서버는 `builtin:` 접두어 값을 그대로 허용한다) ──────────────────
// 기본 캐릭터: `builtin:red` / 로컬 T0: `builtin:t0:<팔레트 hex 4개>` (서버에 없는 캐릭터라 색만 전달) / 서버 생성: `chr_...`

const NET_BUILTIN_PREFIX = 'builtin:';
const NET_T0_PREFIX = 'builtin:t0:';

export function toNetCharacterId(c: CharacterManifest): string {
  if (c.builtin) return `${NET_BUILTIN_PREFIX}${c.id.replace(/^builtin-/, '')}`;
  if (c.tier === 'T0' && c.ownerId === 'local') {
    const pal = (c.skin?.palette ?? []).slice(0, 4).map((p) => p.replace('#', '').toLowerCase());
    return `${NET_T0_PREFIX}${pal.join(',')}`;
  }
  return c.id;
}

/** 동기 해석 가능한 ID(기본·T0)는 매니페스트로, 서버 캐릭터는 캐시에 있으면 캐시, 없으면 null */
export function manifestFromNetId(netId: string, name?: string): CharacterManifest | null {
  if (netId.startsWith(NET_T0_PREFIX)) {
    const pal = netId.slice(NET_T0_PREFIX.length).split(',').filter((h) => /^[0-9a-f]{6}$/i.test(h)).map((h) => `#${h.toLowerCase()}`);
    const base = builtin(netId, name ?? '상대 복서', pal.length ? pal : BUILTIN_CHARACTERS[0]!.skin!.palette);
    return { ...base, builtin: false };
  }
  if (netId.startsWith(NET_BUILTIN_PREFIX)) {
    const id = `builtin-${netId.slice(NET_BUILTIN_PREFIX.length)}`;
    return BUILTIN_CHARACTERS.find((c) => c.id === id) ?? BUILTIN_CHARACTERS[0]!;
  }
  return loadServerCharacters().find((c) => c.id === netId) ?? null;
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

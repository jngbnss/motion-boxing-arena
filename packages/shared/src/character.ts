// C5. 캐릭터 매니페스트 character.json
import { z } from 'zod';
import { SKELETON_ID } from './skeleton.ts';

export const TIERS = ['T0', 'T1', 'T2'] as const;
export type Tier = (typeof TIERS)[number];

export const SkinSchema = z.object({
  /** 이미지에서 추출한 팔레트 (#rrggbb). [주색, 보조색, 강조색, 글러브색] */
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(1).max(8),
  /** 데칼 이미지 URL (가슴·트렁크 등). 로컬 T0는 data/blob URL일 수 있다 */
  decals: z.partialRecord(z.enum(['chest', 'trunks', 'gloves', 'face']), z.string()).default({}),
});
export type Skin = z.infer<typeof SkinSchema>;

export const CharacterManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(32),
  ownerId: z.string().nullable(),
  skeleton: z.literal(SKELETON_ID),
  tier: z.enum(TIERS),
  /** T1/T2만. T0·기본 캐릭터는 null(기본 복서 사용) */
  glbUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  skin: SkinSchema.optional(),
  scale: z.number().positive().default(1),
  provenance: z.object({
    model: z.string(),
    modelVersion: z.string(),
    seed: z.number().int().nullable(),
    rigger: z.enum(['none', 'smooth', 'rigid', 'manual']),
    createdAt: z.string(),
  }),
  license: z.object({
    userAttestedRights: z.boolean(),
    /** MVP는 private만 (C16) */
    visibility: z.literal('private'),
  }),
  builtin: z.boolean().default(false),
});
export type CharacterManifest = z.infer<typeof CharacterManifestSchema>;

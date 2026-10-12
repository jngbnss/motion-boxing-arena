// Colyseus 상태 스키마 (docs/08 §4.4 + timeLeftMs). 데코레이터 없이 schema()로 정의한다 (Node 타입 스트리핑 호환).
import { schema, t, type SchemaType } from '@colyseus/schema';

export const PlayerState = schema(
  {
    userId: t.string(),
    nickname: t.string(),
    characterId: t.string(),
    connected: t.boolean(),
    ready: t.boolean(),
    calibrated: t.boolean(),
    /** 0..100 */
    hp: t.uint8(),
    /** 'idle' | 'guard' | 'jab_lead' | 'straight_rear' | 'hit_head' | 'hit_body' | 'block' | 'ko' … */
    action: t.string(),
    actionStartedAt: t.number(),
    stunUntil: t.number(),
    headX: t.float32(),
    headY: t.float32(),
    guard: t.float32(),
  },
  'PlayerState',
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const DuelState = schema(
  {
    /** C8 MatchPhase */
    phase: t.string(),
    /** 현재 단계 마감 서버 시각(ms). 없으면 0 */
    phaseEndsAt: t.number(),
    /** 남은 경기 시간(ms). 일시정지 중에는 멈춘다 */
    timeLeftMs: t.number(),
    code: t.string(),
    /** sessionId → 플레이어 */
    players: t.map(PlayerState),
  },
  'DuelState',
);
export type DuelState = SchemaType<typeof DuelState>;

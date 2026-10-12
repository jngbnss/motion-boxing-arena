// C7. 실시간 메시지 (Colyseus duel 룸). 상세 규칙: docs/08-API-DESIGN.md §4
import { z } from 'zod';
import { HANDS, PoseStateSchema, STRIKE_TYPES, StrikeEventSchema } from './motion.ts';
import type { PauseReason, MatchEndReason } from './match.ts';
import type { FighterStats } from './match.ts';

export const ROOM_NAME = 'duel';

/** 클라이언트 → 서버 */
export const ClientMessages = {
  'time:ping': z.object({ clientTime: z.number() }),
  'calib:done': z.object({ quality: z.number().min(0).max(1), profileHash: z.string().max(64) }),
  'room:ready': z.object({ ready: z.boolean() }),
  'input:pose': PoseStateSchema,
  'input:strike': StrikeEventSchema,
  'player:character': z.object({ characterId: z.string().min(1) }),
  'match:rematch': z.object({}),
  'match:forfeit': z.object({}),
  'tracking:lost': z.object({ lost: z.boolean(), t: z.number() }),
} as const;
export type ClientMessageType = keyof typeof ClientMessages;
export type ClientMessage<K extends ClientMessageType> = z.infer<(typeof ClientMessages)[K]>;

export type StrikeRejectReason = 'COOLDOWN' | 'STUNNED' | 'RATE' | 'PHASE' | 'STALE' | 'TYPE_DISABLED';

/** 서버 → 클라이언트 */
export interface ServerMessages {
  'time:pong': { clientTime: number; serverTime: number };
  'match:countdown': { startAt: number; reason: 'start' | 'resume' };
  'match:start': { startedAt: number; durationMs: number };
  'match:paused': { reason: PauseReason; player: string; resumeDeadline: number; pauseBudgetLeftMs: number };
  'match:resumed': { countdownStartAt: number };
  'combat:strike_start': { attacker: string; type: (typeof STRIKE_TYPES)[number]; hand: (typeof HANDS)[number]; seq: number; activeAt: number };
  'strike:rejected': { seq: number; reason: StrikeRejectReason };
  'combat:hit': { attacker: string; target: string; zone: 'head' | 'body'; damage: number; hpAfter: number; stunUntil: number; seq: number };
  'combat:blocked': { attacker: string; target: string; chip: number; hpAfter: number; seq: number };
  'combat:dodged': { attacker: string; target: string; seq: number };
  'match:end': { reason: MatchEndReason; winner: string | null; stats: Record<string, FighterStats>; durationMs: number };
}
export type ServerMessageType = keyof ServerMessages;

// C8. 경기 단계 상태 머신, C12 일시정지, C17 경계 규칙에 쓰이는 상수.

export const MATCH_PHASES = [
  'LOBBY', 'WAITING_OPPONENT', 'CALIBRATING', 'READY', 'COUNTDOWN',
  'FIGHTING', 'PAUSED', 'KO', 'TIME_UP', 'FORFEIT', 'RESULT',
] as const;
export type MatchPhase = (typeof MATCH_PHASES)[number];

export type PauseReason = 'DISCONNECT' | 'TRACKING_LOST' | 'NETWORK' | 'USER';
export type MatchEndReason = 'KO' | 'TIME_UP' | 'FORFEIT' | 'ABANDONED';
export type MatchMode = 'ai' | 'online';
export type Difficulty = 'easy' | 'normal' | 'hard';

export const MATCH_RULES = {
  roundMs: 90_000,
  countdownMs: 3_000,
  resumeCountdownMs: 3_000,
  reconnectWindowMs: 20_000,
  /** 추적 손실 → PAUSED 진입 지연 (C12) */
  trackingLossPauseMs: { single: 2_000, online: 3_000 },
  /** 추적 손실 상태 판정 (UI 경고) */
  trackingLossStateMs: 500,
  /** 온라인 추적 손실 PAUSED 누적 예산 (C12) */
  trackingPauseBudgetMs: 30_000,
  maxHp: 100,
} as const;

/** 허용된 단계 전이 (C8). 싱글(LocalMatch)과 서버(DuelRoom)가 공유 */
export const PHASE_TRANSITIONS: Readonly<Record<MatchPhase, readonly MatchPhase[]>> = {
  LOBBY: ['WAITING_OPPONENT', 'CALIBRATING'],
  WAITING_OPPONENT: ['CALIBRATING', 'LOBBY'],
  CALIBRATING: ['READY', 'LOBBY'],
  READY: ['COUNTDOWN', 'CALIBRATING', 'LOBBY'],
  COUNTDOWN: ['FIGHTING', 'PAUSED'],
  FIGHTING: ['PAUSED', 'KO', 'TIME_UP', 'FORFEIT'],
  PAUSED: ['COUNTDOWN', 'FORFEIT'],
  KO: ['RESULT'],
  TIME_UP: ['RESULT'],
  FORFEIT: ['RESULT'],
  RESULT: ['READY', 'LOBBY'],
};

export function canTransition(from: MatchPhase, to: MatchPhase): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

export interface FighterStats {
  punches: number;
  hits: number;
  blocked: number;
  dodgesAttempted: number;
  dodgesSucceeded: number;
}

export function emptyStats(): FighterStats {
  return { punches: 0, hits: 0, blocked: 0, dodgesAttempted: 0, dodgesSucceeded: 0 };
}

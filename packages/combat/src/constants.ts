// C6 전투 타임라인 + C10 회피 창 + AI 난이도. 튜닝 대상 값은 모두 여기에 모은다.
import type { Difficulty, StrikeType } from '@mba/shared';

export interface StrikeSpec {
  startupMs: number;
  activeMs: number;
  recoveryMs: number;
  damageHead: number;
  damageBody: number;
}

export const STRIKES: Readonly<Partial<Record<StrikeType, StrikeSpec>>> = {
  jab: { startupMs: 100, activeMs: 80, recoveryMs: 200, damageHead: 6, damageBody: 4 },
  straight: { startupMs: 160, activeMs: 100, recoveryMs: 300, damageHead: 12, damageBody: 8 },
};

export const COMBAT_RULES = {
  maxHp: 100,
  hitstunMs: 300,
  /** 가드 시 칩 데미지 비율 */
  chipRatio: 0.2,
  /** 전체(양손 합) 1초 창 내 최대 펀치 수 */
  maxStrikesPerSecond: 4,
  /** C10 slip hold 창 길이 */
  slipHoldMs: 250,
  /** 공격자가 웅크렸을 때(headY ≤ 이 값) 몸통 공격으로 판정 */
  bodyShotHeadY: -0.5,
  /** 포즈 링버퍼 보존 길이 */
  poseBufferMs: 600,
  /** 싱글 고정 시뮬레이션 틱 (C17) */
  simHz: 60,
} as const;

export interface AiDifficultySpec {
  /** C10 telegraph: startup 앞에 붙는 예비동작 */
  telegraphMs: number;
  /**
   * 플레이어 펀치 시작(strike_start)부터 회피·가드 동작까지.
   * 플레이어 펀치 startup이 100~160ms라 이보다 짧아야 회피가 성립한다
   * (easy는 straight만, normal/hard는 jab도 피할 수 있다).
   */
  reactionMs: number;
  /** 플레이어 펀치에 대해 회피 시도 확률 */
  dodgeProb: number;
  /** 플레이어 펀치에 대해 가드 시도 확률 (회피 실패 시) */
  guardProb: number;
  /** 공격 간격 [min, max] ms */
  attackIntervalMs: readonly [number, number];
  /** 연속 공격 최대 수 */
  comboMax: number;
}

export const AI_DIFFICULTY: Readonly<Record<Difficulty, AiDifficultySpec>> = {
  easy: { telegraphMs: 700, reactionMs: 140, dodgeProb: 0.15, guardProb: 0.25, attackIntervalMs: [1800, 3000], comboMax: 1 },
  normal: { telegraphMs: 500, reactionMs: 90, dodgeProb: 0.3, guardProb: 0.35, attackIntervalMs: [1200, 2200], comboMax: 2 },
  hard: { telegraphMs: 350, reactionMs: 60, dodgeProb: 0.45, guardProb: 0.4, attackIntervalMs: [800, 1500], comboMax: 3 },
};

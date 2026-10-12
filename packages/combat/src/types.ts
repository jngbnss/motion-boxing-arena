// packages/combat 공개 인터페이스 (계약). 구현은 sim.ts / ai.ts.
// 순수 TS, 결정적: 시간은 항상 인자로 받는다(Date.now/performance.now 금지). 난수는 주입한다.
import type { Difficulty, FighterStats, Hand, PoseState, StrikeType } from '@mba/shared';
import type { StrikeRejectReason } from '@mba/shared';

export type FighterId = string;

export interface StrikeRequest {
  type: StrikeType;
  hand: Hand;
  seq: number;
  /** 공격 시작 시각 = 조준 고정 시각(시뮬레이션/서버 시계) */
  t: number;
  /** AI 전용 예비동작. 조준 고정은 telegraph 시작(t) 시점, startup은 t + telegraphMs부터 */
  telegraphMs?: number;
}

export interface ActiveStrike {
  id: string; // `${attacker}:${seq}`
  attacker: FighterId;
  defender: FighterId;
  type: StrikeType;
  hand: Hand;
  seq: number;
  aimLockAt: number;
  startupAt: number; // aimLockAt + telegraphMs
  activeAt: number; // startupAt + startupMs
  recoveryEndsAt: number;
  zone: 'head' | 'body';
  /** 조준 고정 시점 방어자 머리 월드 변위(m), 파이터 로컬 X/Y */
  aim: { x: number; y: number };
}

export interface FighterView {
  id: FighterId;
  hp: number;
  stunUntil: number;
  /** 손별 다음 입력 가능 시각 */
  handReadyAt: Record<Hand, number>;
  stats: FighterStats;
  /** 최신 PoseState (없으면 중앙) */
  pose: PoseState;
}

export type CombatEvent =
  | { kind: 'strike_start'; strike: ActiveStrike }
  | { kind: 'strike_rejected'; attacker: FighterId; seq: number; reason: StrikeRejectReason }
  | { kind: 'strike_cancelled'; strike: ActiveStrike; reason: 'INTERRUPTED' }
  | { kind: 'hit'; strike: ActiveStrike; zone: 'head' | 'body'; damage: number; hpAfter: number; stunUntil: number; t: number }
  | { kind: 'blocked'; strike: ActiveStrike; chip: number; hpAfter: number; t: number }
  | { kind: 'dodged'; strike: ActiveStrike; t: number }
  | { kind: 'ko'; loser: FighterId; winner: FighterId; t: number };

export interface CombatSimOptions {
  fighters: readonly [FighterId, FighterId];
  startTime: number;
  maxHp?: number;
}

/** 결정적 전투 시뮬레이터. 싱글(브라우저)과 서버(DuelRoom)가 같은 코드를 쓴다. */
export interface CombatSimApi {
  /** 방어 판정용 포즈 샘플 입력 (t는 시뮬레이션 시계로 환산된 값) */
  pushPose(fighter: FighterId, pose: PoseState): void;
  /** 공격 요청. 쿨다운·경직·속도 제한 위반이면 strike_rejected 이벤트 반환 */
  requestStrike(attacker: FighterId, req: StrikeRequest): CombatEvent;
  /** now까지 진행: activeAt ≤ now인 공격을 판정. 같은 step에서 active된 공격은 동시 명중으로 모두 적용 */
  step(now: number): CombatEvent[];
  fighter(id: FighterId): FighterView;
  pendingStrikes(): readonly ActiveStrike[];
  readonly winner: FighterId | null;
}

/** AI 상대의 출력: 이번 틱에 할 일 */
export interface AiOutput {
  pose: PoseState;
  strike: StrikeRequest | null;
  /** 연출용 상태 (애니메이션 선택) */
  state: AiState;
}

export type AiState = 'Idle' | 'Approach' | 'Telegraph' | 'Attack' | 'Guard' | 'Dodge' | 'Hit' | 'Recover' | 'Knockout';

export interface AiBrainOptions {
  self: FighterId;
  opponent: FighterId;
  difficulty: Difficulty;
  /** [0,1) 난수. 테스트는 시드 고정 PRNG 주입 */
  random: () => number;
}

export interface AiBrainApi {
  /** 매 틱 호출. sim은 읽기 전용으로만 사용 */
  update(now: number, sim: CombatSimApi, events: readonly CombatEvent[]): AiOutput;
}

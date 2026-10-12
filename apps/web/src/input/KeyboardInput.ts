// 키보드 입력 (개발용·웹캠 실패 시 대체, AI 대전 전용).
// J 잽(lead), K 스트레이트(rear), Space 가드(유지), A/D 좌우 회피(유지), S 숙이기(유지)
import type { DefenseState, PoseState, StrikeEvent } from '@mba/shared';
import type { InputFrame, InputSource } from './types.ts';

const RAMP_PER_SEC = 9; // 머리 오프셋이 ±1까지 가는 속도

export class KeyboardInput implements InputSource {
  readonly kind = 'keyboard' as const;
  private held = new Set<string>();
  private queue: StrikeEvent[] = [];
  private seq = 0;
  private pose: PoseState = { headX: 0, headY: 0, guard: 0, t: 0 };
  private lastPoll = 0;

  private onDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const k = e.code;
    if (k === 'KeyJ' || k === 'KeyK') {
      const hand = k === 'KeyJ' ? 'lead' : 'rear';
      this.queue.push({ kind: 'strike', type: hand === 'lead' ? 'jab' : 'straight', hand, t: performance.now(), confidence: 1, seq: ++this.seq });
    }
    if (['Space', 'KeyA', 'KeyD', 'KeyS'].includes(k)) {
      this.held.add(k);
      if (k === 'Space') e.preventDefault();
    }
  };
  private onUp = (e: KeyboardEvent) => this.held.delete(e.code);
  private onBlur = () => this.held.clear();

  async start(): Promise<void> {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.onBlur);
    this.lastPoll = performance.now();
  }

  poll(now: number): InputFrame {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastPoll) / 1000));
    this.lastPoll = now;
    const targetX = (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0);
    const targetY = this.held.has('KeyS') ? -1 : 0;
    const approach = (v: number, t: number) => {
      const step = RAMP_PER_SEC * dt;
      return Math.abs(t - v) <= step ? t : v + Math.sign(t - v) * step;
    };
    this.pose = {
      headX: approach(this.pose.headX, targetX),
      headY: approach(this.pose.headY, targetY),
      guard: this.held.has('Space') ? 1 : 0,
      t: now,
    };
    const defense: DefenseState = this.pose.guard >= 0.7 ? 'guard'
      : this.pose.headX <= -0.6 ? 'slip_left' : this.pose.headX >= 0.6 ? 'slip_right'
      : this.pose.headY <= -0.6 ? 'duck' : 'none';
    const strikes = this.queue;
    this.queue = [];
    return { strikes, pose: this.pose, defense, tracking: true, trackingLostMs: 0, pauseGesture: false };
  }

  diagnostics() {
    return null;
  }

  stop(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
    this.held.clear();
  }
}

// 서버 시계 오프셋 추정 (docs/07 §4.5): 입장 직후 time:ping 5회 → RTT 최소 샘플로 offset 결정,
// 이후 10초마다 재샘플해 EMA로 보정. offset = serverTime + RTT/2 - clientRecv  (serverNow = clientNow + offset)

export const CLOCK_INITIAL_SAMPLES = 5;
export const CLOCK_RESAMPLE_MS = 10_000;
/** 재샘플 EMA 가중치 */
export const CLOCK_EMA_ALPHA = 0.2;
/** 초기 버스트 핑 간격 */
export const CLOCK_BURST_GAP_MS = 120;

export interface ClockSample {
  rtt: number;
  offset: number;
}

export class ServerClock {
  private burst: ClockSample[] = [];
  private _offset = 0;
  private _rtt = 0;
  private _synced = false;
  private bestRtt = Infinity;

  get offset(): number {
    return this._offset;
  }

  /** 최근 RTT(EMA, ms) */
  get rtt(): number {
    return this._rtt;
  }

  /** 초기 5회 샘플이 끝났는가 */
  get synced(): boolean {
    return this._synced;
  }

  /** time:pong 처리. clientSend/clientRecv는 같은 로컬 시계(performance.now) */
  addSample(clientSend: number, serverTime: number, clientRecv: number): ClockSample | null {
    const rtt = clientRecv - clientSend;
    if (!Number.isFinite(rtt) || rtt < 0 || !Number.isFinite(serverTime)) return null;
    const sample: ClockSample = { rtt, offset: serverTime + rtt / 2 - clientRecv };
    this.bestRtt = Math.min(this.bestRtt, rtt);
    if (!this._synced) {
      this.burst.push(sample);
      // 첫 샘플부터 대략값을 쓰고, 5개가 모이면 RTT 최소 샘플로 확정
      const best = this.burst.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      this._offset = best.offset;
      this._rtt = this.burst.reduce((s, x) => s + x.rtt, 0) / this.burst.length;
      if (this.burst.length >= CLOCK_INITIAL_SAMPLES) {
        this._synced = true;
        this.burst = [];
      }
      return sample;
    }
    this._rtt += CLOCK_EMA_ALPHA * (rtt - this._rtt);
    // 큐잉 지연으로 부풀려진 샘플은 오프셋 보정에서 제외 (RTT 측정에는 반영)
    if (rtt <= Math.max(this.bestRtt * 2, this.bestRtt + 40)) {
      this._offset += CLOCK_EMA_ALPHA * (sample.offset - this._offset);
    }
    return sample;
  }

  /** 로컬 시각 → 서버 시각 */
  toServer(local: number): number {
    return local + this._offset;
  }

  /** 서버 시각 → 로컬 시각 */
  toLocal(server: number): number {
    return server - this._offset;
  }
}

/** 핑 송신 일정: 초기 버스트 후 10초마다. send는 clientTime을 실어 보낸다 */
export class ClockSync {
  readonly clock = new ServerClock();
  private timer: number | undefined;
  private sent = 0;
  private stopped = false;

  constructor(
    private readonly sendPing: (clientTime: number) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(): void {
    this.stopped = false;
    this.sent = 0;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.sendPing(this.now());
      this.sent++;
      this.schedule(this.sent < CLOCK_INITIAL_SAMPLES ? CLOCK_BURST_GAP_MS : CLOCK_RESAMPLE_MS);
    }, delay);
  }

  onPong(msg: { clientTime: number; serverTime: number }): void {
    this.clock.addSample(msg.clientTime, msg.serverTime, this.now());
  }

  /** 서버 시각 기준 현재 */
  serverNow(): number {
    return this.clock.toServer(this.now());
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

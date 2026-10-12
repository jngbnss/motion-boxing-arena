// 카메라 + MediaPipe Pose Landmarker 래퍼. 웹캠 설정·캘리브레이션·게임 화면이 한 인스턴스를 공유한다.
// 영상 프레임은 이 클래스 밖(네트워크 포함)으로 나가지 않는다 (Premise 7).
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, MotionFrame } from '@mba/motion';
import type { PoseModel } from '../settings.ts';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm';
const modelUrl = (m: PoseModel) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`;

export type CameraErrorCode = 'insecure' | 'unsupported' | 'denied' | 'notfound' | 'busy' | 'model' | 'unknown';

export class CameraError extends Error {
  constructor(public readonly code: CameraErrorCode, message: string) {
    super(message);
  }
}

export interface TrackerFrame extends MotionFrame {
  /** 프레임 캡처 시각(performance.now 기준) */
  captureTime: number;
  /** 추론 완료 시각 */
  processedAt: number;
  inferenceMs: number;
  numPoses: number;
}

type Listener = (f: TrackerFrame) => void;

class Ring {
  private buf: number[] = [];
  constructor(private size: number) {}
  push(v: number) {
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
  }
  percentile(p: number): number {
    if (this.buf.length === 0) return 0;
    const s = [...this.buf].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  }
  values(): readonly number[] {
    return this.buf;
  }
}

export function checkEnvironment(): CameraError | null {
  if (typeof window === 'undefined') return new CameraError('unsupported', '브라우저 환경이 아닙니다.');
  if (!window.isSecureContext) return new CameraError('insecure', '웹캠은 HTTPS 또는 localhost에서만 사용할 수 있어요.');
  if (!navigator.mediaDevices?.getUserMedia) return new CameraError('unsupported', '이 브라우저는 웹캠을 지원하지 않아요. 최신 Chrome/Edge를 사용해 주세요.');
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return new CameraError('unsupported', 'WebGL2를 사용할 수 없어요. 최신 Chrome/Edge를 사용해 주세요.');
  return null;
}

function mapGumError(e: unknown): CameraError {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return new CameraError('denied', '카메라 권한이 거부되었어요.');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new CameraError('notfound', '카메라를 찾을 수 없어요.');
  if (name === 'NotReadableError' || name === 'AbortError') return new CameraError('busy', '다른 앱(화상회의 등)이 카메라를 쓰고 있어요.');
  return new CameraError('unknown', `카메라를 열 수 없어요: ${String((e as Error)?.message ?? e)}`);
}

export class PoseTracker {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private landmarker: PoseLandmarker | null = null;
  private loadedModel: PoseModel | null = null;
  private listeners = new Set<Listener>();
  private running = false;
  private rafId = 0;
  private lastTs = 0;
  private inferMs = new Ring(120);
  private frameTimes = new Ring(60);
  private latency = new Ring(120);
  delegate: 'GPU' | 'CPU' | null = null;
  lastFrame: TrackerFrame | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
  }

  get isOpen(): boolean {
    return this.stream != null;
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  async openCamera(deviceId?: string): Promise<void> {
    const env = checkEnvironment();
    if (env) throw env;
    this.closeCamera();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        },
      });
    } catch (e) {
      throw mapGumError(e);
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
  }

  async loadModel(model: PoseModel): Promise<void> {
    if (this.landmarker && this.loadedModel === model) return;
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      const make = (delegate: 'GPU' | 'CPU') =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelUrl(model), delegate },
          runningMode: 'VIDEO',
          numPoses: 2,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      let lm: PoseLandmarker;
      try {
        lm = await make('GPU');
        this.delegate = 'GPU';
      } catch {
        lm = await make('CPU');
        this.delegate = 'CPU';
      }
      this.landmarker?.close();
      this.landmarker = lm;
      this.loadedModel = model;
    } catch (e) {
      throw new CameraError('model', `포즈 모델을 불러오지 못했어요(네트워크 확인): ${String((e as Error)?.message ?? e)}`);
    }
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  startLoop(): void {
    if (this.running) return;
    this.running = true;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { captureTime?: number; expectedDisplayTime?: number }) => void) => number;
    };
    const process = (captureTime: number) => {
      if (!this.running) return;
      if (this.landmarker && v.readyState >= 2) {
        let ts = performance.now();
        if (ts <= this.lastTs) ts = this.lastTs + 0.01;
        this.lastTs = ts;
        const t0 = performance.now();
        let landmarks: Landmark[] | null = null;
        let world: Landmark[] | null = null;
        let numPoses = 0;
        try {
          const r = this.landmarker.detectForVideo(v, ts);
          numPoses = r.landmarks.length;
          const first = r.landmarks[0];
          if (first) landmarks = first.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 0 }));
          const w = r.worldLandmarks[0];
          if (w) world = w.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 0 }));
        } catch {
          /* 일시적 추론 실패: 이 프레임은 미검출 처리 */
        }
        const processedAt = performance.now();
        this.inferMs.push(processedAt - t0);
        this.frameTimes.push(processedAt);
        this.latency.push(processedAt - captureTime);
        const frame: TrackerFrame = { t: captureTime, landmarks, world, captureTime, processedAt, inferenceMs: processedAt - t0, numPoses };
        this.lastFrame = frame;
        for (const l of this.listeners) l(frame);
      }
      schedule();
    };
    const schedule = () => {
      if (!this.running) return;
      if (v.requestVideoFrameCallback) {
        v.requestVideoFrameCallback((now, meta) => process(meta.captureTime ?? meta.expectedDisplayTime ?? now));
      } else {
        this.rafId = requestAnimationFrame(() => process(performance.now()));
      }
    };
    schedule();
  }

  stopLoop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  stats() {
    const ft = this.frameTimes.values();
    const span = ft.length > 1 ? ft[ft.length - 1]! - ft[0]! : 0;
    return {
      inferenceFps: span > 0 ? ((ft.length - 1) * 1000) / span : 0,
      inferenceMsP50: this.inferMs.percentile(0.5),
      inferenceMsP95: this.inferMs.percentile(0.95),
      latencyMsP50: this.latency.percentile(0.5),
    };
  }

  /** 조명 지표: 프레임 평균 밝기 0..255 (32×24로 축소 샘플) */
  brightness(): number {
    if (this.video.readyState < 2) return 0;
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 24;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;
    ctx.drawImage(this.video, 0, 0, 32, 24);
    const d = ctx.getImageData(0, 0, 32, 24).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    return s / (d.length / 4);
  }

  closeCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  dispose(): void {
    this.stopLoop();
    this.closeCamera();
    this.landmarker?.close();
    this.landmarker = null;
    this.listeners.clear();
  }
}

import { useEffect, useRef, useState } from 'react';
import { CameraError, type PoseTracker } from '../../input/PoseTracker.ts';
import type { Settings } from '../../settings.ts';
import { drawLandmarks } from '../drawLandmarks.ts';
import { CameraErrorView } from '../CameraErrorView.tsx';

export function WebcamSetupScreen({ tracker, settings, onSettings, onNext, onKeyboard, onBack }: {
  tracker: PoseTracker;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onNext: () => void;
  onKeyboard: () => void;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<'idle' | 'opening' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<CameraError | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [info, setInfo] = useState({ res: '', brightness: 0, people: 0, fps: 0 });
  const videoHost = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const open = async (id?: string) => {
    setError(null);
    try {
      setStatus('opening');
      await tracker.openCamera(id || undefined);
      setDevices(await tracker.listDevices());
      setStatus('loading');
      await tracker.loadModel(settings.poseModel);
      tracker.startLoop();
      setStatus('ready');
    } catch (e) {
      setError(e instanceof CameraError ? e : new CameraError('unknown', String(e)));
      setStatus('error');
    }
  };

  useEffect(() => {
    void open();
  }, [settings.poseModel]);

  useEffect(() => {
    const host = videoHost.current;
    if (!host) return;
    host.prepend(tracker.video);
    const unsub = tracker.subscribe((f) => {
      const c = canvasRef.current;
      const g = c?.getContext('2d');
      if (c && g) drawLandmarks(g, f.landmarks);
    });
    const t = setInterval(() => {
      const v = tracker.video;
      setInfo({ res: v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '-', brightness: tracker.brightness(), people: tracker.lastFrame?.numPoses ?? 0, fps: tracker.stats().inferenceFps });
    }, 500);
    return () => { unsub(); clearInterval(t); tracker.video.remove(); };
  }, [tracker]);

  const dark = status === 'ready' && info.brightness > 0 && info.brightness < 50;

  return (
    <div className="screen">
      <h1>웹캠 설정</h1>
      {error ? (
        <CameraErrorView error={error} onRetry={() => open(deviceId)} onKeyboard={onKeyboard} />
      ) : (
        <div className="card" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <div className="video-wrap" ref={videoHost}>
            <canvas ref={canvasRef} width={640} height={480} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p className="muted" style={{ margin: 0 }}>
              {status === 'opening' && '카메라 권한을 요청하는 중…'}
              {status === 'loading' && `포즈 모델(${settings.poseModel}) 불러오는 중… (${settings.poseModel === 'lite' ? '약 6MB' : '약 9MB'})`}
              {status === 'ready' && `준비됨 · ${tracker.delegate === 'GPU' ? 'GPU' : 'CPU'} 추론`}
            </p>
            <label>카메라
              <select value={deviceId} onChange={(e) => { setDeviceId(e.target.value); void open(e.target.value); }}>
                <option value="">기본 카메라</option>
                {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `카메라 ${i + 1}`}</option>)}
              </select>
            </label>
            <label>모델
              <select value={settings.poseModel} onChange={(e) => onSettings({ ...settings, poseModel: e.target.value as Settings['poseModel'] })}>
                <option value="lite">lite (빠름, 기본)</option>
                <option value="full">full (정확, 느림)</option>
              </select>
            </label>
            <div className="muted" style={{ fontSize: 14 }}>해상도 {info.res} · 추론 {info.fps.toFixed(0)} FPS · 밝기 {info.brightness.toFixed(0)}</div>
            {dark && <div className="warn-box">얼굴과 손이 잘 보이게 앞쪽 조명을 켜 주세요.</div>}
            {status === 'ready' && info.people === 0 && <div className="warn-box">화면 안으로 들어와 주세요 (카메라에서 1.5~2.5m).</div>}
            {info.people > 1 && <div className="warn-box">한 명만 화면에 있어야 해요.</div>}
            <div className="row">
              <button className="primary" disabled={status !== 'ready'} onClick={onNext}>캘리브레이션으로</button>
              <button className="ghost" onClick={onBack}>로비로</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

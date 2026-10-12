import { useEffect, useRef, useState } from 'react';
import { Calibrator, defaultProfile, type CalibrationProfile, type CalibrationStep } from '@mba/motion';
import { CameraError, type PoseTracker } from '../../input/PoseTracker.ts';
import type { Settings } from '../../settings.ts';
import { drawLandmarks } from '../drawLandmarks.ts';
import { CameraErrorView } from '../CameraErrorView.tsx';

const STEPS: Array<{ id: CalibrationStep; label: string }> = [
  { id: 'neutral', label: '기본 자세' },
  { id: 'guard', label: '가드' },
  { id: 'jab', label: '잽' },
  { id: 'straight', label: '스트레이트' },
  { id: 'slip_left', label: '왼쪽 회피' },
  { id: 'slip_right', label: '오른쪽 회피' },
];

function Ring({ value }: { value: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring-progress" viewBox="0 0 120 120" aria-label={`진행률 ${Math.round(value * 100)}%`}>
      <circle cx="60" cy="60" r={r} stroke="#2a3145" strokeWidth="10" fill="none" />
      <circle cx="60" cy="60" r={r} stroke="#ff4d3a" strokeWidth="10" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - value)} transform="rotate(-90 60 60)" strokeLinecap="round" />
      <text x="60" y="68" textAnchor="middle" fill="#e9ecf3" fontSize="24" fontWeight="700">{Math.round(value * 100)}%</text>
    </svg>
  );
}

export function CalibrationScreen({ tracker, settings, onDone, onBack }: {
  tracker: PoseTracker;
  settings: Settings;
  onDone: (p: CalibrationProfile) => void;
  onBack: () => void;
}) {
  const [safe, setSafe] = useState(false);
  const [ui, setUi] = useState<{ step: CalibrationStep; progress: number; instruction: string }>({ step: 'neutral', progress: 0, instruction: '' });
  const [error, setError] = useState<CameraError | null>(null);
  const [noPerson, setNoPerson] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const calRef = useRef<Calibrator | null>(null);
  const videoHost = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    if (!tracker.isOpen) {
      (async () => {
        try {
          await tracker.openCamera();
          await tracker.loadModel(settings.poseModel);
        } catch (e) {
          setError(e instanceof CameraError ? e : new CameraError('unknown', String(e)));
        }
      })();
    }
  }, [tracker, settings.poseModel]);

  useEffect(() => {
    const host = videoHost.current;
    if (!host || !safe) return;
    host.prepend(tracker.video);
    const cal = new Calibrator(settings.stance);
    calRef.current = cal;
    finished.current = false;
    let missing = 0;
    const unsub = tracker.subscribe((f) => {
      const g = canvasRef.current?.getContext('2d');
      if (g) drawLandmarks(g, f.landmarks);
      missing = f.landmarks ? 0 : missing + 1;
      setNoPerson(missing > 30);
      if (finished.current) return;
      cal.push(f);
      setUi({ step: cal.step, progress: cal.progress, instruction: cal.instruction });
      if (cal.step === 'done') {
        const p = cal.result();
        if (p) {
          finished.current = true;
          setTimeout(() => onDone(p), 600);
        }
      }
    });
    tracker.startLoop();
    return () => { unsub(); tracker.video.remove(); };
  }, [safe, tracker, settings.stance, attempt]);

  if (error) return <div className="screen"><CameraErrorView error={error} onRetry={() => { setError(null); setAttempt((a) => a + 1); }} onKeyboard={onBack} /></div>;

  if (!safe) {
    return (
      <div className="screen">
        <h1>캘리브레이션 전에</h1>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0 }}>실제로 팔을 휘두르는 게임입니다.</p>
          <ul style={{ margin: 0 }}>
            <li>주변 <b>1.5m × 1.5m</b>를 비워 주세요.</li>
            <li>모니터·벽과 팔 길이 이상 떨어지세요. 카메라에서 1.5~2.5m가 좋아요.</li>
            <li>상반신과 양손이 화면에 모두 보이게 서 주세요.</li>
            <li>언제든 <b>ESC</b> 또는 <b>양손을 머리 위로 2초</b> 들어 일시정지할 수 있어요.</li>
          </ul>
          <label><input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} /> 공간을 확인했어요</label>
          <div className="row"><button className="ghost" onClick={onBack}>로비로</button></div>
        </div>
      </div>
    );
  }

  const idx = STEPS.findIndex((s) => s.id === ui.step);
  return (
    <div className="screen">
      <h1>자세 캘리브레이션</h1>
      <div className="card" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <div className="video-wrap" ref={videoHost}>
          <canvas ref={canvasRef} width={640} height={480} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {STEPS.map((s, i) => (
              <li key={s.id} style={{ color: i < idx || ui.step === 'done' ? '#3ddc84' : i === idx ? '#fff' : '#8d96ab', fontWeight: i === idx ? 700 : 400 }}>
                {s.label} {(i < idx || ui.step === 'done') && '✓'}
              </li>
            ))}
          </ol>
          <Ring value={ui.step === 'done' ? 1 : ui.progress} />
          <div style={{ fontSize: 20, fontWeight: 700 }}>{ui.step === 'done' ? '완료! 경기를 시작합니다.' : ui.instruction}</div>
          {noPerson && <div className="warn-box">사람이 보이지 않아요. 화면 안으로 들어와 주세요.</div>}
          <div className="row">
            <button onClick={() => setAttempt((a) => a + 1)}>처음부터 다시</button>
            <button className="ghost" onClick={() => onDone(defaultProfile(settings.stance))}>건너뛰기(기본값)</button>
            <button className="ghost" onClick={onBack}>로비로</button>
          </div>
        </div>
      </div>
    </div>
  );
}

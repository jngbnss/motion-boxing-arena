// 랜드마크 디버그 오버레이 (docs/10 §4): 스켈레톤·신뢰도 색·손별 FSM·가드 게이지·이벤트 로그·성능·REC
import { useEffect, useRef, useState } from 'react';
import type { Stance } from '@mba/shared';
import type { HudSnapshot } from '../game/GameSession.ts';
import type { PoseTracker } from '../input/PoseTracker.ts';
import { downloadText, KEY_LABELS, Recorder, type Label } from '../debug/Recorder.ts';
import { drawLandmarks } from './drawLandmarks.ts';

function Meter({ value, max = 1, color = '#4da3ff' }: { value: number; max?: number; color?: string }) {
  return <div className="meter"><div style={{ width: `${Math.max(0, Math.min(1, value / max)) * 100}%`, background: color }} /></div>;
}

export function DebugOverlay({ snap, tracker, stance }: { snap: HudSnapshot; tracker: PoseTracker | null; stance: Stance }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recRef = useRef<Recorder | null>(null);
  const [rec, setRec] = useState<{ on: boolean; label: Label; count: number }>({ on: false, label: 'none', count: 0 });

  useEffect(() => {
    const g = canvasRef.current?.getContext('2d');
    if (g) drawLandmarks(g, snap.diag?.landmarks ?? null, snap.diag?.debug, { background: true });
    if (recRef.current?.recording) setRec((r) => ({ ...r, count: recRef.current!.count }));
  }, [snap]);

  useEffect(() => {
    if (!rec.on) return;
    const onKey = (e: KeyboardEvent) => {
      const label = KEY_LABELS[e.code];
      if (label && recRef.current) {
        recRef.current.label = label;
        setRec((r) => ({ ...r, label }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rec.on]);

  useEffect(() => () => { recRef.current?.stop(); }, []);

  const toggleRec = () => {
    if (!tracker) return;
    if (recRef.current?.recording) {
      const text = recRef.current.stop();
      downloadText(`mba-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`, text);
      setRec({ on: false, label: 'none', count: 0 });
    } else {
      recRef.current = new Recorder(tracker, stance);
      recRef.current.start();
      setRec({ on: true, label: 'none', count: 0 });
    }
  };

  const d = snap.diag?.debug ?? null;
  return (
    <div className="debug-panel">
      <canvas ref={canvasRef} width={320} height={240} style={{ transform: 'scaleX(-1)' }} />
      <div>render {snap.renderFps.toFixed(0)} fps · infer {snap.diag?.inferenceFps.toFixed(0) ?? '-'} fps</div>
      <div>infer ms p50 {snap.diag?.inferenceMsP50.toFixed(1) ?? '-'} / p95 {snap.diag?.inferenceMsP95.toFixed(1) ?? '-'} · capture→event p50 {snap.diag?.latencyMsP50.toFixed(0) ?? '-'}ms</div>
      {snap.diag?.multiplePeople && <div style={{ color: '#ffc93c' }}>⚠ 2명 이상 검출</div>}
      {d ? (
        <>
          <div style={{ marginTop: 6 }}>tracking: {d.tracking ? 'OK' : 'LOST'} · head ({d.headOffset.x.toFixed(2)}, {d.headOffset.y.toFixed(2)}) · tilt {d.shoulderTilt.toFixed(2)}</div>
          {(['lead', 'rear'] as const).map((h) => (
            <div key={h} style={{ marginTop: 4 }}>
              <b>{h}</b> {d.hands[h].state} · score {d.hands[h].score.toFixed(2)} · elbow {d.hands[h].elbowAngle.toFixed(0)}°
              <Meter value={d.hands[h].speed} max={3} />
              <Meter value={d.hands[h].handScale - 0.5} max={1.5} color="#ffb020" />
            </div>
          ))}
          <div style={{ marginTop: 4 }}>guard {d.guardScore.toFixed(2)}<Meter value={d.guardScore} color="#3ddc84" /></div>
        </>
      ) : (
        <div className="muted">모션 디버그 정보 없음(키보드 모드)</div>
      )}
      <div style={{ marginTop: 6 }}>
        <b>이벤트</b>
        {snap.motionLog.slice().reverse().map((e) => (
          <div key={e.id} style={{ color: e.ignored ? '#666' : '#e9ecf3' }}>{(e.t / 1000).toFixed(2)} {e.type}/{e.hand} c={e.confidence.toFixed(2)}{e.ignored ? ' (무시)' : ''}</div>
        ))}
      </div>
      {tracker && (
        <div style={{ marginTop: 8 }}>
          <button onClick={toggleRec} style={{ color: rec.on ? '#ff4d6d' : undefined }}>{rec.on ? `■ 저장 (${rec.count}프레임)` : '● REC'}</button>
          {rec.on && <div>라벨: <b>{rec.label}</b> — 1 잽 2 스트레이트 3 가드 4 좌회피 5 우회피 6 숙이기 0 없음</div>}
          <div className="muted">녹화는 랜드마크 좌표만 저장합니다(영상 아님).</div>
        </div>
      )}
    </div>
  );
}

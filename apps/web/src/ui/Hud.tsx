import { useEffect, useRef } from 'react';
import type { CharacterManifest, Difficulty } from '@mba/shared';
import type { HudSnapshot } from '../game/GameSession.ts';
import { drawLandmarks } from './drawLandmarks.ts';

const fmt = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const TONE = { good: '#3ddc84', bad: '#ff4d6d', info: '#9fd3ff' } as const;

export function Hud({ snap, character, opponent, difficulty, miniCam, onResume, onExit }: {
  snap: HudSnapshot;
  character: CharacterManifest;
  opponent: CharacterManifest;
  difficulty: Difficulty;
  miniCam: boolean;
  onResume: () => void;
  onExit: () => void;
}) {
  const now = performance.now();
  const miniRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = miniRef.current?.getContext('2d');
    if (g && snap.diag) drawLandmarks(g, snap.diag.landmarks, snap.diag.debug, { background: true });
  }, [snap]);

  const pct = (hp: number) => `${Math.max(0, (hp / snap.maxHp) * 100)}%`;
  const recog = !snap.tracking ? { c: '#ff4d6d', t: '인식 끊김' } : snap.diag && snap.diag.inferenceFps > 0 && snap.diag.inferenceFps < 15 ? { c: '#ffc93c', t: '인식 느림' } : { c: '#3ddc84', t: '인식 양호' };

  return (
    <div className="hud">
      <div className={`vignette ${now - snap.lastPlayerHitAt < 220 ? 'on' : ''}`} />
      <div className="bars">
        <div>
          <div className="hpbar"><div style={{ width: pct(snap.playerHp) }} /></div>
          <div style={{ marginTop: 4 }}>{character.name} <span className={`badge ${character.tier}`}>{character.tier}</span> <span className="muted">{Math.max(0, Math.round(snap.playerHp))}</span></div>
        </div>
        <div className="timer">{fmt(snap.remainingMs)}</div>
        <div style={{ textAlign: 'right' }}>
          <div className="hpbar right"><div style={{ width: pct(snap.aiHp) }} /></div>
          <div style={{ marginTop: 4 }}><span className="muted">{Math.max(0, Math.round(snap.aiHp))}</span> {opponent.name} ({difficulty.toUpperCase()})</div>
        </div>
      </div>

      {snap.phase === 'COUNTDOWN' && <div className="center-text">{Math.max(1, Math.ceil(snap.countdownLeftMs / 1000))}</div>}
      {snap.phase === 'FIGHTING' && now - snap.lastDodgeAt < 700 && <div className="center-text" style={{ color: '#3ddc84', fontSize: 'clamp(32px,7vw,80px)' }}>SLIP!</div>}
      {snap.phase === 'KO' && <div className="center-text" style={{ color: '#ff4d3a' }}>K.O.</div>}
      {snap.phase === 'TIME_UP' && <div className="center-text">TIME UP</div>}
      {snap.phase === 'FIGHTING' && snap.telegraph && difficulty === 'easy' && <div className="telegraph">!</div>}
      {snap.phase === 'FIGHTING' && snap.tracking === false && snap.trackingLostMs > 0 && (
        <div className="banner">인식 끊김 — 이 동안 회피·가드가 무효예요</div>
      )}

      <div className="chips">
        <span className="chip"><span className="dot" style={{ background: recog.c }} />{recog.t}</span>
        {snap.defense !== 'none' && <span className="chip">{snap.defense.toUpperCase()}</span>}
        {snap.events.filter((e) => now - e.at < 1500).map((e) => (
          <span key={e.id} className="chip" style={{ borderColor: TONE[e.tone], color: TONE[e.tone] }}>{e.text}</span>
        ))}
      </div>

      {miniCam && snap.diag && <canvas ref={miniRef} className="minicam" width={240} height={180} style={{ transform: 'scaleX(-1)' }} />}

      {snap.phase === 'PAUSED' && (
        <div className="overlay-panel">
          <div className="card" style={{ width: 'min(420px, 92%)', textAlign: 'center' }}>
            <h2>{snap.pauseReason === 'TRACKING_LOST' ? '카메라 앞으로 돌아오세요' : '일시정지'}</h2>
            <p className="muted">{snap.pauseReason === 'TRACKING_LOST' ? '다시 인식되면 3초 카운트다운 후 재개합니다.' : 'ESC 또는 양손을 머리 위로 2초 들면 재개합니다.'}</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              {snap.pauseReason !== 'TRACKING_LOST' && <button className="primary" onClick={onResume}>계속하기</button>}
              <button onClick={onExit}>로비로</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

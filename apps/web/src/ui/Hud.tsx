import { useEffect, useRef } from 'react';
import type { CharacterManifest, Difficulty } from '@mba/shared';
import type { HudSnapshot, OnlineHud } from '../game/GameSession.ts';
import { UNSTABLE_RTT_MS } from '../game/OnlineSession.ts';
import { drawLandmarks } from './drawLandmarks.ts';

const fmt = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const TONE = { good: '#3ddc84', bad: '#ff4d6d', info: '#9fd3ff' } as const;

/** 온라인 일시정지 안내 (docs/10 §5) */
function onlinePauseText(o: OnlineHud): { title: string; desc: string } {
  const p = o.pause;
  const left = p ? `${Math.ceil(p.deadlineLeftMs / 1000)}초` : '';
  if (!p) return { title: '일시정지', desc: '서버가 경기를 잠시 멈췄어요.' };
  switch (p.reason) {
    case 'DISCONNECT':
      return p.byMe ? { title: '재연결 중…', desc: `${left} 안에 복귀하지 않으면 기권 처리돼요.` } : { title: '상대 재접속 대기', desc: `${left} 안에 상대가 돌아오지 않으면 승리로 끝나요.` };
    case 'TRACKING_LOST':
      return p.byMe
        ? { title: '카메라 앞으로 돌아오세요', desc: `${left} 안에 복귀하지 않으면 기권. 남은 일시정지 예산 ${Math.ceil(p.budgetLeftMs / 1000)}초.` }
        : { title: '상대가 카메라 밖에 있어요', desc: `${left} 동안 기다립니다.` };
    case 'NETWORK':
      return { title: '네트워크 불안정', desc: `연결이 안정되면 3초 카운트다운 후 재개해요 (${left}).` };
    case 'USER':
      return { title: '일시정지', desc: `${left}` };
  }
}

export function Hud({ snap, character, opponent, difficulty, miniCam, onResume, onExit, onForfeit }: {
  snap: HudSnapshot;
  character: CharacterManifest;
  opponent: CharacterManifest;
  /** null = 온라인 대전 */
  difficulty: Difficulty | null;
  miniCam: boolean;
  onResume: () => void;
  onExit: () => void;
  onForfeit?: () => void;
}) {
  const now = performance.now();
  const miniRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = miniRef.current?.getContext('2d');
    if (g && snap.diag) drawLandmarks(g, snap.diag.landmarks, snap.diag.debug, { background: true });
  }, [snap]);

  const online = snap.online;
  const pct = (hp: number) => `${Math.max(0, (hp / snap.maxHp) * 100)}%`;
  const recog = !snap.tracking ? { c: '#ff4d6d', t: '인식 끊김' } : snap.diag && snap.diag.inferenceFps > 0 && snap.diag.inferenceFps < 15 ? { c: '#ffc93c', t: '인식 느림' } : { c: '#3ddc84', t: '인식 양호' };
  const opponentTag = online ? online.opponentName : difficulty?.toUpperCase() ?? '';
  const pauseText = online ? onlinePauseText(online) : null;

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
          <div style={{ marginTop: 4 }}><span className="muted">{Math.max(0, Math.round(snap.aiHp))}</span> {opponent.name} {online && <span className={`badge ${opponent.tier}`}>{opponent.tier}</span>} ({opponentTag})</div>
        </div>
      </div>

      {snap.phase === 'COUNTDOWN' && <div className="center-text">{Math.max(1, Math.ceil(snap.countdownLeftMs / 1000))}</div>}
      {snap.phase === 'FIGHTING' && now - snap.lastDodgeAt < 700 && <div className="center-text" style={{ color: '#3ddc84', fontSize: 'clamp(32px,7vw,80px)' }}>SLIP!</div>}
      {snap.phase === 'KO' && <div className="center-text" style={{ color: '#ff4d3a' }}>K.O.</div>}
      {snap.phase === 'TIME_UP' && <div className="center-text">TIME UP</div>}
      {snap.phase === 'FORFEIT' && <div className="center-text">기권</div>}
      {snap.phase === 'READY' && online && <div className="center-text" style={{ fontSize: 'clamp(24px,5vw,48px)' }}>재대결 준비 중…</div>}
      {snap.phase === 'FIGHTING' && snap.telegraph && difficulty === 'easy' && <div className="telegraph">!</div>}
      {snap.phase === 'FIGHTING' && snap.tracking === false && snap.trackingLostMs > 0 && (
        <div className="banner">인식 끊김 — 이 동안 회피·가드가 무효예요</div>
      )}
      {online?.notice && !snap.outcome && <div className="banner" style={{ top: 110 }}>{online.notice}</div>}

      <div className="chips">
        <span className="chip"><span className="dot" style={{ background: recog.c }} />{recog.t}</span>
        {online && online.rttMs > UNSTABLE_RTT_MS && <span className="chip" style={{ borderColor: '#ffc93c', color: '#ffc93c' }}>네트워크 불안정 ({Math.round(online.rttMs)}ms)</span>}
        {online && !online.opponentLeft && !online.opponentConnected && <span className="chip" style={{ borderColor: '#ff4d6d', color: '#ff4d6d' }}>상대 연결 끊김</span>}
        {snap.defense !== 'none' && <span className="chip">{snap.defense.toUpperCase()}</span>}
        {snap.events.filter((e) => now - e.at < 1500).map((e) => (
          <span key={e.id} className="chip" style={{ borderColor: TONE[e.tone], color: TONE[e.tone] }}>{e.text}</span>
        ))}
      </div>

      {miniCam && snap.diag && <canvas ref={miniRef} className="minicam" width={240} height={180} style={{ transform: 'scaleX(-1)' }} />}

      {online && online.connection !== 'connected' && snap.phase !== 'RESULT' && (
        <div className="overlay-panel">
          <div className="card" style={{ width: 'min(420px, 92%)', textAlign: 'center' }}>
            <h2>{online.connection === 'reconnecting' ? '재연결 중…' : '연결 끊김'}</h2>
            <p className="muted">{online.notice ?? '서버와 다시 연결하고 있어요. 20초 안에 복귀하면 경기가 이어집니다.'}</p>
            <button onClick={onExit}>로비로</button>
          </div>
        </div>
      )}

      {snap.phase === 'PAUSED' && (!online || online.connection === 'connected') && (
        <div className="overlay-panel">
          <div className="card" style={{ width: 'min(420px, 92%)', textAlign: 'center' }}>
            {pauseText ? (
              <>
                <h2>{pauseText.title}</h2>
                <p className="muted">{pauseText.desc}</p>
              </>
            ) : (
              <>
                <h2>{snap.pauseReason === 'TRACKING_LOST' ? '카메라 앞으로 돌아오세요' : '일시정지'}</h2>
                <p className="muted">{snap.pauseReason === 'TRACKING_LOST' ? '다시 인식되면 3초 카운트다운 후 재개합니다.' : 'ESC 또는 양손을 머리 위로 2초 들면 재개합니다.'}</p>
              </>
            )}
            <div className="row" style={{ justifyContent: 'center' }}>
              {!online && snap.pauseReason !== 'TRACKING_LOST' && <button className="primary" onClick={onResume}>계속하기</button>}
              {online && onForfeit && <button onClick={onForfeit}>기권</button>}
              <button onClick={onExit}>로비로</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import type { HudSnapshot } from '../game/GameSession.ts';

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '-');

export function ResultView({ snap, onRematch, onExit, saveNote }: { snap: HudSnapshot; onRematch: () => void; onExit: () => void; saveNote?: string | null }) {
  const o = snap.outcome!;
  const p = snap.stats.player;
  const online = snap.online;
  const title = o.winner == null ? '무승부' : o.winner === 'player' ? '승리!' : '패배';
  const reason = o.reason === 'KO' ? 'K.O.' : o.reason === 'TIME_UP' ? '판정' : o.reason === 'FORFEIT' ? '기권' : o.reason === 'ABANDONED' ? '중단' : o.reason;
  const rematchBlocked = online != null && (online.opponentLeft || online.connection !== 'connected');
  return (
    <div className="overlay-panel" style={{ pointerEvents: 'auto' }}>
      <div className="card" style={{ width: 'min(640px, 94%)' }}>
        <h1 style={{ fontSize: 44, color: o.winner === 'player' ? '#3ddc84' : o.winner == null ? '#ffc93c' : '#ff4d6d' }}>{title} <span className="muted" style={{ fontSize: 20 }}>{reason}</span></h1>
        {online && <p className="muted" style={{ marginTop: 0 }}>상대: {online.opponentName}</p>}
        <div className="stat-grid">
          <div className="stat"><span className="muted">명중률</span><b>{pct(p.hits, p.punches)}</b></div>
          <div className="stat"><span className="muted">펀치 수</span><b>{p.punches}</b></div>
          <div className="stat"><span className="muted">명중 / 막힘</span><b>{p.hits} / {p.blocked}</b></div>
          <div className="stat"><span className="muted">회피 성공률</span><b>{pct(p.dodgesSucceeded, p.dodgesAttempted)}</b></div>
          <div className="stat"><span className="muted">경기 시간</span><b>{(o.durationMs / 1000).toFixed(1)}초</b></div>
          <div className="stat"><span className="muted">남은 HP</span><b>{Math.max(0, Math.round(snap.playerHp))} : {Math.max(0, Math.round(snap.aiHp))}</b></div>
        </div>
        {online?.opponentLeft && <p className="warn-box">상대가 방을 나갔어요. 재대결은 새 방에서 할 수 있어요.</p>}
        {saveNote && <p className="muted" style={{ fontSize: 12 }}>{saveNote}</p>}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={onRematch} disabled={rematchBlocked || online?.rematchRequested}>
            {online?.rematchRequested ? '상대 수락 대기 중…' : '재대결'}
          </button>
          <button onClick={onExit}>로비로</button>
        </div>
      </div>
    </div>
  );
}

// 온라인 대기실: 방 코드·초대 링크, 두 선수의 연결·캘리브레이션·준비 상태, 내 준비 토글.
// 양쪽 ready && calibrated → 서버가 COUNTDOWN으로 전환하면 게임 화면으로 넘어간다 (docs/07 §4.3).
import { useEffect, useRef, useState } from 'react';
import type { CalibrationProfile } from '@mba/motion';
import type { CharacterManifest, MatchPhase } from '@mba/shared';
import type { DuelConnection, DuelPlayer, DuelSnapshot, DuelStatus } from '../../net/duel.ts';

const IN_MATCH: readonly MatchPhase[] = ['COUNTDOWN', 'FIGHTING', 'PAUSED', 'KO', 'TIME_UP', 'FORFEIT', 'RESULT'];

const PHASE_TEXT: Partial<Record<MatchPhase, string>> = {
  WAITING_OPPONENT: '상대를 기다리는 중',
  CALIBRATING: '캘리브레이션 확인 중',
  READY: '양쪽 모두 준비를 누르면 시작해요',
};

/** 캘리브레이션 프로필 요약 해시 (서버는 표시·기록용으로만 쓴다) */
function profileHash(p: CalibrationProfile | null): string {
  if (!p) return 'keyboard';
  const s = JSON.stringify(p);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a-${(h >>> 0).toString(16)}`;
}

export function inviteLink(code: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.toString();
}

function PlayerRow({ p, label, duel }: { p: DuelPlayer | null; label: string; duel: DuelConnection }) {
  const [name, setName] = useState<string>('');
  useEffect(() => {
    if (!p?.characterId) return;
    let alive = true;
    void duel.resolveCharacter(p.characterId, p.nickname).then((m) => { if (alive) setName(m.name); });
    return () => { alive = false; };
  }, [p?.characterId]);
  if (!p) return <div className="char-card"><b>{label}</b><span className="muted">비어 있음 — 초대 링크를 보내세요</span></div>;
  const dot = (ok: boolean) => <span className="dot" style={{ background: ok ? '#3ddc84' : '#666', display: 'inline-block', width: 10, height: 10, borderRadius: 5, marginRight: 6 }} />;
  return (
    <div className="char-card" data-testid={`player-${label}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>{label}: {p.nickname || '플레이어'}</b><span className="muted">{name}</span></div>
      <span>{dot(p.connected)}{p.connected ? '연결됨' : '재접속 대기'}</span>
      <span>{dot(p.calibrated)}{p.calibrated ? '캘리브레이션 완료' : '캘리브레이션 대기'}</span>
      <span>{dot(p.ready)}{p.ready ? '준비 완료' : '준비 전'}</span>
    </div>
  );
}

export function RoomScreen({ duel, character, inputKind, profile, onStartGame, onLeave }: {
  duel: DuelConnection;
  character: CharacterManifest;
  inputKind: 'keyboard' | 'webcam';
  profile: CalibrationProfile | null;
  onStartGame: () => void;
  onLeave: () => void;
}) {
  const [state, setState] = useState<DuelSnapshot>(duel.state);
  const [status, setStatus] = useState<DuelStatus>(duel.status);
  const [copied, setCopied] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const calibSent = useRef(false);

  useEffect(() => {
    const offs = [
      duel.onState(setState),
      duel.onStatus(setStatus),
      duel.on('error', (m) => setServerError(`${m.message} (${m.code})`)),
    ];
    setState(duel.state);
    return () => offs.forEach((o) => o());
  }, [duel]);

  const me = state.players.find((p) => p.sessionId === duel.sessionId) ?? null;
  const opp = state.players.find((p) => p.sessionId !== duel.sessionId) ?? null;

  // 캘리브레이션 완료 통보: 서버는 CALIBRATING/READY 단계에서만 받는다. 키보드는 품질 1로 통보(개발·시연용)
  useEffect(() => {
    if (!me || me.calibrated || calibSent.current) return;
    if (state.phase !== 'CALIBRATING' && state.phase !== 'READY') return;
    calibSent.current = true;
    duel.send('calib:done', { quality: 1, profileHash: profileHash(inputKind === 'webcam' ? profile : null) });
  }, [state.phase, me?.calibrated]);
  useEffect(() => {
    if (me && !me.calibrated && state.phase === 'WAITING_OPPONENT') calibSent.current = false;
  }, [state.phase]);

  useEffect(() => {
    if (IN_MATCH.includes(state.phase)) onStartGame();
  }, [state.phase]);

  const copy = async () => {
    const link = inviteLink(state.code);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('초대 링크를 복사하세요', link);
    }
  };

  const canReady = me != null && me.calibrated && (state.phase === 'READY' || state.phase === 'CALIBRATING');

  return (
    <div className="screen">
      <h1>친구와 1:1 대전</h1>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <span className="muted">방 코드</span>
            <div className="title-xl" style={{ fontSize: 44, letterSpacing: 6 }} data-testid="room-code">{state.code || '······'}</div>
          </div>
          <div className="row">
            <button onClick={copy} disabled={!state.code}>{copied ? '복사됨 ✓' : '초대 링크 복사'}</button>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>{PHASE_TEXT[state.phase] ?? state.phase}{status !== 'connected' && ` · ${status === 'reconnecting' ? '재연결 중…' : '연결 끊김'}`}</p>
      </div>

      <div className="card">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <PlayerRow p={me} label="나" duel={duel} />
          <PlayerRow p={opp} label="상대" duel={duel} />
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          내 캐릭터: <b>{character.name}</b> <span className={`badge ${character.tier}`}>{character.tier}</span> · 입력: {inputKind === 'webcam' ? '웹캠' : '키보드(개발·시연용 — J 잽 · K 스트레이트 · Space 가드 · A/D 회피 · S 숙이기)'}
        </p>
        {serverError && <div className="error-box">{serverError}</div>}
        {status === 'closed' && <div className="error-box">게임 서버와 연결이 끊겼어요. 로비로 돌아가 다시 시도해 주세요.</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={!canReady} onClick={() => duel.send('room:ready', { ready: !me?.ready })} data-testid="ready-toggle">
            {me?.ready ? '준비 취소' : '준비'}
          </button>
          <button onClick={onLeave}>방 나가기</button>
        </div>
      </div>
    </div>
  );
}

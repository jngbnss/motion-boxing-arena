import { useState } from 'react';
import type { CharacterManifest, Difficulty } from '@mba/shared';
import { featureBlockedReason, type ServerConfigState } from '../../net/useServerConfig.ts';
import type { Settings } from '../../settings.ts';
import type { GameInputChoice } from './GameScreen.tsx';

/** 룸 코드: 대문자+숫자 6자리, 혼동 문자(0 O 1 I) 제외 (docs/07 §4.1) */
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

const DIFFS: Array<{ id: Difficulty; label: string; desc: string }> = [
  { id: 'easy', label: 'Easy', desc: '예비동작 0.7초 + "!" 표시. 처음이라면 여기서' },
  { id: 'normal', label: 'Normal', desc: '예비동작 0.5초. 회피·가드를 섞어 씀' },
  { id: 'hard', label: 'Hard', desc: '예비동작 0.35초. 빠른 연타' },
];

export function LobbyScreen({ settings, character, hasProfile, server, onlineBusy, onlineError, onSettings, onChangeCharacter, onStart, onCreateRoom, onJoinRoom }: {
  settings: Settings;
  character: CharacterManifest;
  hasProfile: boolean;
  server: ServerConfigState;
  onlineBusy: boolean;
  onlineError: string | null;
  onSettings: (s: Settings) => void;
  onChangeCharacter: () => void;
  onStart: (choice: GameInputChoice) => void;
  onCreateRoom: () => void;
  onJoinRoom: (code: string) => void;
}) {
  const [replayError, setReplayError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const blocked = featureBlockedReason(server, 'online');
  const normCode = code.trim().toUpperCase();

  const start = () => {
    if (settings.inputMode === 'webcam') onStart({ kind: 'webcam' });
    else onStart({ kind: 'keyboard' });
  };

  const onReplay = async (file: File | undefined) => {
    setReplayError(null);
    if (!file) return;
    try {
      const text = await file.text();
      onStart({ kind: 'replay', text, name: file.name });
    } catch (e) {
      setReplayError(`파일을 읽지 못했어요: ${String((e as Error).message)}`);
    }
  };

  return (
    <div className="screen">
      <h1>게임 로비</h1>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <span>선택한 캐릭터:</span> <b>{character.name}</b> <span className={`badge ${character.tier}`}>{character.tier}</span>
            <div className="swatches">{character.skin?.palette.map((p, i) => <span key={i} className="swatch" style={{ background: p }} />)}</div>
          </div>
          <button onClick={onChangeCharacter}>캐릭터 변경</button>
        </div>
      </div>

      <div className="card">
        <h2>AI 대전</h2>
        <div className="grid">
          {DIFFS.map((d) => (
            <button key={d.id} className={`char-card ${settings.difficulty === d.id ? 'selected' : ''}`} onClick={() => onSettings({ ...settings, difficulty: d.id })}>
              <b>{d.label}</b>
              <span className="muted" style={{ fontSize: 13 }}>{d.desc}</span>
            </button>
          ))}
        </div>
        <h3 style={{ marginTop: 18 }}>입력 방식</h3>
        <div className="row">
          <button className={settings.inputMode === 'webcam' ? 'selected' : ''} onClick={() => onSettings({ ...settings, inputMode: 'webcam' })}>📷 웹캠 (모션)</button>
          <button className={settings.inputMode === 'keyboard' ? 'selected' : ''} onClick={() => onSettings({ ...settings, inputMode: 'keyboard' })}>⌨ 키보드</button>
          <label className="muted" style={{ fontSize: 13 }}>
            리플레이(.jsonl):
            <input type="file" accept=".jsonl,.ndjson,application/x-ndjson,text/plain" onChange={(e) => onReplay(e.target.files?.[0])} />
          </label>
        </div>
        {settings.inputMode === 'keyboard' && <p className="muted" style={{ fontSize: 13 }}>J 잽 · K 스트레이트 · Space 가드(유지) · A/D 좌우 회피(유지) · S 숙이기 · ESC 일시정지. 키보드는 AI 대전용이며, 온라인에서는 개발·시연용으로만 허용됩니다.</p>}
        {settings.inputMode === 'webcam' && <p className="muted" style={{ fontSize: 13 }}>{hasProfile ? '저장된 캘리브레이션을 사용합니다(설정에서 다시 측정 가능).' : '처음 한 번 30초 캘리브레이션을 진행합니다.'}</p>}
        {replayError && <div className="error-box">{replayError}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={start}>AI와 대전 시작</button>
        </div>
      </div>

      <div className="card">
        <h2>친구와 1:1 대전</h2>
        {blocked ? (
          <div className="warn-box row" style={{ justifyContent: 'space-between' }}>
            <span>{blocked}</span>
            {server.status === 'offline' && <button onClick={server.retry}>재연결</button>}
          </div>
        ) : (
          <p className="muted">방을 만들고 초대 링크를 보내거나, 친구에게 받은 6자리 코드로 참가하세요. 위에서 고른 입력 방식({settings.inputMode === 'webcam' ? '웹캠' : '키보드'})으로 참가합니다.</p>
        )}
        <div className="row">
          <button className="primary" disabled={!!blocked || onlineBusy} onClick={onCreateRoom}>방 만들기</button>
          <input
            disabled={!!blocked || onlineBusy}
            placeholder="방 코드"
            value={code}
            maxLength={6}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter' && ROOM_CODE_RE.test(normCode)) onJoinRoom(normCode); }}
            style={{ width: 120, textTransform: 'uppercase', letterSpacing: 2 }}
            aria-label="방 코드"
          />
          <button disabled={!!blocked || onlineBusy || !ROOM_CODE_RE.test(normCode)} onClick={() => onJoinRoom(normCode)}>참가</button>
          {onlineBusy && <span className="muted">접속 중…</span>}
        </div>
        {onlineError && <div className="error-box" style={{ marginTop: 10 }}>{onlineError}</div>}
      </div>
    </div>
  );
}

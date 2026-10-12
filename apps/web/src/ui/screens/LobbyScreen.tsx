import { useState } from 'react';
import type { CharacterManifest, Difficulty } from '@mba/shared';
import type { Settings } from '../../settings.ts';
import type { GameInputChoice } from './GameScreen.tsx';

const DIFFS: Array<{ id: Difficulty; label: string; desc: string }> = [
  { id: 'easy', label: 'Easy', desc: '예비동작 0.7초 + "!" 표시. 처음이라면 여기서' },
  { id: 'normal', label: 'Normal', desc: '예비동작 0.5초. 회피·가드를 섞어 씀' },
  { id: 'hard', label: 'Hard', desc: '예비동작 0.35초. 빠른 연타' },
];

export function LobbyScreen({ settings, character, hasProfile, onSettings, onChangeCharacter, onStart }: {
  settings: Settings;
  character: CharacterManifest;
  hasProfile: boolean;
  onSettings: (s: Settings) => void;
  onChangeCharacter: () => void;
  onStart: (choice: GameInputChoice) => void;
}) {
  const [replayError, setReplayError] = useState<string | null>(null);

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
        {settings.inputMode === 'keyboard' && <p className="muted" style={{ fontSize: 13 }}>J 잽 · K 스트레이트 · Space 가드(유지) · A/D 좌우 회피(유지) · S 숙이기 · ESC 일시정지. 키보드는 AI 대전 전용입니다.</p>}
        {settings.inputMode === 'webcam' && <p className="muted" style={{ fontSize: 13 }}>{hasProfile ? '저장된 캘리브레이션을 사용합니다(설정에서 다시 측정 가능).' : '처음 한 번 30초 캘리브레이션을 진행합니다.'}</p>}
        {replayError && <div className="error-box">{replayError}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={start}>AI와 대전 시작</button>
        </div>
      </div>

      <div className="card">
        <h2>친구와 1:1 대전</h2>
        <p className="muted">온라인 대전(방 만들기·코드 입력·초대 링크)은 게임 서버가 준비되면 열립니다.</p>
        <div className="row">
          <button disabled>방 만들기</button>
          <input disabled placeholder="방 코드" style={{ width: 120 }} />
          <button disabled>참가</button>
        </div>
      </div>
    </div>
  );
}

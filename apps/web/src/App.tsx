// 화면 흐름 상태 머신 (라우터 없음): 메인 → 캐릭터 선택 → (생성) → 로비 → 웹캠 설정 → 캘리브레이션 → 게임(결과 포함)
// 온라인: 로비(방 만들기/코드 참가) 또는 초대 링크(?room=CODE) → (웹캠·캘리브레이션 또는 키보드) → 대기실 → 게임
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CalibrationProfile } from '@mba/motion';
import { findCharacter, loadSelectedCharacterId, saveSelectedCharacterId, toNetCharacterId } from './characters.ts';
import { PoseTracker } from './input/PoseTracker.ts';
import { api } from './net/api.ts';
import { DuelConnection, joinErrorMessage, loadSavedDuel, type SavedDuel } from './net/duel.ts';
import { useServerConfig } from './net/useServerConfig.ts';
import { loadSettings, saveSettings, type InputMode, type Settings } from './settings.ts';
import { loadJson, saveJson } from './storage.ts';
import { CalibrationScreen } from './ui/screens/CalibrationScreen.tsx';
import { CharacterCreateScreen } from './ui/screens/CharacterCreateScreen.tsx';
import { CharacterSelectScreen } from './ui/screens/CharacterSelectScreen.tsx';
import { GameScreen, type GameInputChoice } from './ui/screens/GameScreen.tsx';
import { LobbyScreen } from './ui/screens/LobbyScreen.tsx';
import { MainScreen } from './ui/screens/MainScreen.tsx';
import { RoomScreen } from './ui/screens/RoomScreen.tsx';
import { WebcamSetupScreen } from './ui/screens/WebcamSetupScreen.tsx';
import { SettingsPanel } from './ui/SettingsPanel.tsx';

export type ScreenId = 'main' | 'select' | 'create' | 'lobby' | 'webcam' | 'calibration' | 'room' | 'game';

type OnlineIntent = { kind: 'create' } | { kind: 'join'; code: string } | { kind: 'resume'; saved: SavedDuel };

const PROFILE_KEY = 'mba.calibration.v1';

/** 초대 링크 ?room=CODE 를 읽고 주소창에서 지운다 */
function takeInviteCode(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('room')?.trim().toUpperCase() ?? null;
  if (url.searchParams.has('room')) {
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url.toString());
  }
  return code && /^[A-Z0-9]{4,8}$/.test(code) ? code : null;
}

export function App() {
  const [invite, setInvite] = useState<string | null>(() => takeInviteCode());
  const [screen, setScreen] = useState<ScreenId>(() => (invite ? 'select' : 'main'));
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const [characterId, setCharacterId] = useState<string>(() => loadSelectedCharacterId());
  const [profile, setProfileState] = useState<CalibrationProfile | null>(() => loadJson<CalibrationProfile | null>(PROFILE_KEY, null));
  const [showSettings, setShowSettings] = useState(false);
  const [gameInput, setGameInput] = useState<GameInputChoice>({ kind: 'keyboard' });
  const [charactersVersion, setCharactersVersion] = useState(0);
  const [duel, setDuel] = useState<DuelConnection | null>(null);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const pendingOnline = useRef<OnlineIntent | null>(null);
  const trackerRef = useRef<PoseTracker | null>(null);
  const server = useServerConfig();

  const tracker = useCallback(() => {
    trackerRef.current ??= new PoseTracker();
    return trackerRef.current;
  }, []);

  const setSettings = (s: Settings) => {
    setSettingsState(s);
    saveSettings(s);
  };
  const setProfile = (p: CalibrationProfile) => {
    setProfileState(p);
    saveJson(PROFILE_KEY, p);
  };
  const selectCharacter = (id: string) => {
    setCharacterId(id);
    saveSelectedCharacterId(id);
  };
  const character = useMemo(() => findCharacter(characterId), [characterId, charactersVersion]);

  const startGame = (choice: GameInputChoice) => {
    setGameInput(choice);
    if (choice.kind === 'webcam') {
      setScreen(tracker().isOpen ? (profile && profile.stance === settings.stance ? 'game' : 'calibration') : 'webcam');
    } else {
      setScreen('game');
    }
  };

  // ── 온라인 ──────────────────────────────────────────────────────────────────

  const connectOnline = async (intent: OnlineIntent, inputKind: InputMode) => {
    pendingOnline.current = null;
    if (!api) return;
    setOnlineBusy(true);
    setOnlineError(null);
    try {
      // 선택 상태가 오래됐을 수 있다(세션 재발급·서버 변경으로 서버 캐릭터 캐시가 정리됨). 참가 직전에 저장소 기준으로 다시 해석한다
      const opts = { characterId: toNetCharacterId(findCharacter(characterId)), inputKind };
      const d = intent.kind === 'create'
        ? await DuelConnection.create(api, opts)
        : intent.kind === 'join'
          ? await DuelConnection.joinByCode(api, intent.code, opts)
          : await DuelConnection.reconnect(api, intent.saved);
      setGameInput({ kind: inputKind });
      setDuel(d);
      setInvite(null);
      setScreen('room');
    } catch (e) {
      setOnlineError(intent.kind === 'resume' ? '이전 방에 다시 들어가지 못했어요 (방이 닫혔거나 재접속 시간 20초가 지났어요).' : joinErrorMessage(e));
      setScreen('lobby');
    } finally {
      setOnlineBusy(false);
    }
  };

  /** 온라인 참가 전 입력 준비: 웹캠이면 카메라·캘리브레이션을 먼저 거친다 */
  const startOnline = (intent: OnlineIntent, inputKind: InputMode = settings.inputMode) => {
    if (inputKind === 'webcam') {
      if (!tracker().isOpen) {
        pendingOnline.current = intent;
        setScreen('webcam');
        return;
      }
      if (!profile || profile.stance !== settings.stance) {
        pendingOnline.current = intent;
        setScreen('calibration');
        return;
      }
    }
    void connectOnline(intent, inputKind);
  };

  const leaveOnline = (to: ScreenId = 'lobby') => {
    void duel?.leave();
    setDuel(null);
    setScreen(to);
  };

  // 새로고침 재접속: sessionStorage의 reconnectionToken (20초 창)
  // (StrictMode 개발 모드의 effect 2회 실행에도 재접속은 1회만: 같은 토큰으로 두 번 붙으면 한쪽이 실패한다)
  const resumeTried = useRef(false);
  useEffect(() => {
    if (resumeTried.current) return;
    resumeTried.current = true;
    const saved = loadSavedDuel();
    if (saved && api) startOnline({ kind: 'resume', saved }, saved.inputKind);
  }, []);

  const afterCalibration = () => {
    const pending = pendingOnline.current;
    if (pending) void connectOnline(pending, 'webcam');
    else {
      setGameInput({ kind: 'webcam' });
      setScreen('game');
    }
  };

  return (
    <>
      <div className={screen === 'game' ? 'topbar in-game' : 'topbar'}>
        {screen !== 'main' && screen !== 'game' && (
          <button className="ghost" onClick={() => (duel ? leaveOnline('main') : setScreen('main'))}>메인</button>
        )}
        <button className="ghost" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>⚙ 설정</button>
      </div>
      {showSettings && <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} onRecalibrate={() => { setShowSettings(false); setScreen(tracker().isOpen ? 'calibration' : 'webcam'); }} />}

      {screen === 'main' && <MainScreen character={character} onStart={() => setScreen('lobby')} onCharacters={() => setScreen('select')} onCreate={() => setScreen('create')} />}
      {screen === 'select' && (
        <CharacterSelectScreen
          selectedId={characterId}
          version={charactersVersion}
          settings={settings}
          invite={invite}
          onSettings={setSettings}
          onSelect={selectCharacter}
          onCreate={() => setScreen('create')}
          onDone={() => (invite ? startOnline({ kind: 'join', code: invite }) : setScreen('lobby'))}
          onChanged={() => setCharactersVersion((v) => v + 1)}
        />
      )}
      {screen === 'create' && (
        <CharacterCreateScreen
          settings={settings}
          onCreated={(id) => { setCharactersVersion((v) => v + 1); selectCharacter(id); }}
          onDone={() => setScreen('select')}
          onCancel={() => setScreen('select')}
        />
      )}
      {screen === 'lobby' && (
        <LobbyScreen
          settings={settings}
          character={character}
          hasProfile={profile != null}
          server={server}
          onlineBusy={onlineBusy}
          onlineError={onlineError}
          onSettings={setSettings}
          onChangeCharacter={() => setScreen('select')}
          onStart={startGame}
          onCreateRoom={() => startOnline({ kind: 'create' })}
          onJoinRoom={(code) => startOnline({ kind: 'join', code })}
        />
      )}
      {screen === 'webcam' && (
        <WebcamSetupScreen
          tracker={tracker()}
          settings={settings}
          onSettings={setSettings}
          onNext={() => {
            const pending = pendingOnline.current;
            if (pending && profile && profile.stance === settings.stance) void connectOnline(pending, 'webcam');
            else setScreen('calibration');
          }}
          onKeyboard={() => {
            const pending = pendingOnline.current;
            if (pending) {
              setSettings({ ...settings, inputMode: 'keyboard' });
              void connectOnline(pending, 'keyboard');
            } else {
              setGameInput({ kind: 'keyboard' });
              setScreen('game');
            }
          }}
          onBack={() => { pendingOnline.current = null; setScreen('lobby'); }}
        />
      )}
      {screen === 'calibration' && (
        <CalibrationScreen
          tracker={tracker()}
          settings={settings}
          onDone={(p) => { setProfile(p); afterCalibration(); }}
          onBack={() => { pendingOnline.current = null; setScreen('lobby'); }}
        />
      )}
      {screen === 'room' && duel && (
        <RoomScreen
          duel={duel}
          character={character}
          inputKind={gameInput.kind === 'webcam' ? 'webcam' : 'keyboard'}
          profile={profile}
          onStartGame={() => setScreen('game')}
          onLeave={() => leaveOnline()}
        />
      )}
      {screen === 'game' && (
        <GameScreen
          key={`${gameInput.kind}-${characterId}-${duel?.roomId ?? 'ai'}`}
          input={gameInput}
          tracker={gameInput.kind === 'webcam' ? tracker() : null}
          profile={profile}
          settings={settings}
          character={character}
          mode={duel ? { kind: 'online', duel } : { kind: 'ai' }}
          onExit={() => (duel ? leaveOnline() : setScreen('lobby'))}
        />
      )}
    </>
  );
}

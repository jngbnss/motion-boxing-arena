// 화면 흐름 상태 머신 (라우터 없음): 메인 → 캐릭터 선택 → (생성) → 로비 → 웹캠 설정 → 캘리브레이션 → 게임(결과 포함)
import { useCallback, useMemo, useRef, useState } from 'react';
import type { CalibrationProfile } from '@mba/motion';
import { findCharacter, loadSelectedCharacterId, saveSelectedCharacterId } from './characters.ts';
import { PoseTracker } from './input/PoseTracker.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { loadJson, saveJson } from './storage.ts';
import { CalibrationScreen } from './ui/screens/CalibrationScreen.tsx';
import { CharacterCreateScreen } from './ui/screens/CharacterCreateScreen.tsx';
import { CharacterSelectScreen } from './ui/screens/CharacterSelectScreen.tsx';
import { GameScreen, type GameInputChoice } from './ui/screens/GameScreen.tsx';
import { LobbyScreen } from './ui/screens/LobbyScreen.tsx';
import { MainScreen } from './ui/screens/MainScreen.tsx';
import { WebcamSetupScreen } from './ui/screens/WebcamSetupScreen.tsx';
import { SettingsPanel } from './ui/SettingsPanel.tsx';

export type ScreenId = 'main' | 'select' | 'create' | 'lobby' | 'webcam' | 'calibration' | 'game';

const PROFILE_KEY = 'mba.calibration.v1';

export function App() {
  const [screen, setScreen] = useState<ScreenId>('main');
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const [characterId, setCharacterId] = useState<string>(() => loadSelectedCharacterId());
  const [profile, setProfileState] = useState<CalibrationProfile | null>(() => loadJson<CalibrationProfile | null>(PROFILE_KEY, null));
  const [showSettings, setShowSettings] = useState(false);
  const [gameInput, setGameInput] = useState<GameInputChoice>({ kind: 'keyboard' });
  const [charactersVersion, setCharactersVersion] = useState(0);
  const trackerRef = useRef<PoseTracker | null>(null);

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

  return (
    <>
      <div className={screen === 'game' ? 'topbar in-game' : 'topbar'}>
        {screen !== 'main' && screen !== 'game' && (
          <button className="ghost" onClick={() => setScreen('main')}>메인</button>
        )}
        <button className="ghost" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>⚙ 설정</button>
      </div>
      {showSettings && <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} onRecalibrate={() => { setShowSettings(false); setScreen(tracker().isOpen ? 'calibration' : 'webcam'); }} />}

      {screen === 'main' && <MainScreen character={character} onStart={() => setScreen('lobby')} onCharacters={() => setScreen('select')} onCreate={() => setScreen('create')} />}
      {screen === 'select' && (
        <CharacterSelectScreen
          selectedId={characterId}
          version={charactersVersion}
          onSelect={selectCharacter}
          onCreate={() => setScreen('create')}
          onDone={() => setScreen('lobby')}
          onChanged={() => setCharactersVersion((v) => v + 1)}
        />
      )}
      {screen === 'create' && (
        <CharacterCreateScreen
          onCreated={(id) => { setCharactersVersion((v) => v + 1); selectCharacter(id); setScreen('select'); }}
          onCancel={() => setScreen('select')}
        />
      )}
      {screen === 'lobby' && (
        <LobbyScreen
          settings={settings}
          character={character}
          hasProfile={profile != null}
          onSettings={setSettings}
          onChangeCharacter={() => setScreen('select')}
          onStart={startGame}
        />
      )}
      {screen === 'webcam' && (
        <WebcamSetupScreen
          tracker={tracker()}
          settings={settings}
          onSettings={setSettings}
          onNext={() => setScreen('calibration')}
          onKeyboard={() => { setGameInput({ kind: 'keyboard' }); setScreen('game'); }}
          onBack={() => setScreen('lobby')}
        />
      )}
      {screen === 'calibration' && (
        <CalibrationScreen
          tracker={tracker()}
          settings={settings}
          onDone={(p) => { setProfile(p); setGameInput({ kind: 'webcam' }); setScreen('game'); }}
          onBack={() => setScreen('lobby')}
        />
      )}
      {screen === 'game' && (
        <GameScreen
          key={`${gameInput.kind}-${characterId}`}
          input={gameInput}
          tracker={gameInput.kind === 'webcam' ? tracker() : null}
          profile={profile}
          settings={settings}
          character={character}
          onExit={() => setScreen('lobby')}
        />
      )}
    </>
  );
}

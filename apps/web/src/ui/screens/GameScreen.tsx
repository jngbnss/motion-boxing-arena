import { useEffect, useRef, useState } from 'react';
import { defaultProfile, type CalibrationProfile } from '@mba/motion';
import type { CharacterManifest } from '@mba/shared';
import { AI_OPPONENT } from '../../characters.ts';
import { GameSession, type HudSnapshot } from '../../game/GameSession.ts';
import { KeyboardInput } from '../../input/KeyboardInput.ts';
import type { PoseTracker } from '../../input/PoseTracker.ts';
import { ReplayInput } from '../../input/ReplayInput.ts';
import type { InputSource } from '../../input/types.ts';
import { WebcamInput } from '../../input/WebcamInput.ts';
import type { Settings } from '../../settings.ts';
import { DebugOverlay } from '../DebugOverlay.tsx';
import { Hud } from '../Hud.tsx';
import { ResultView } from '../ResultView.tsx';

export type GameInputChoice = { kind: 'keyboard' } | { kind: 'webcam' } | { kind: 'replay'; text: string; name: string };

export function GameScreen({ input, tracker, profile, settings, character, onExit }: {
  input: GameInputChoice;
  tracker: PoseTracker | null;
  profile: CalibrationProfile | null;
  settings: Settings;
  character: CharacterManifest;
  onExit: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const [snap, setSnap] = useState<HudSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let source: InputSource;
    const prof = profile && profile.stance === settings.stance ? profile : defaultProfile(settings.stance);
    try {
      if (input.kind === 'webcam' && tracker) source = new WebcamInput(tracker, prof);
      else if (input.kind === 'replay') source = new ReplayInput(input.text, prof);
      else source = new KeyboardInput();
    } catch (e) {
      setError(String((e as Error).message ?? e));
      return;
    }
    let session: GameSession;
    try {
      session = new GameSession({ container: el, input: source, player: character, opponent: AI_OPPONENT, difficulty: settings.difficulty, settings });
    } catch (e) {
      setError(`3D 화면을 시작하지 못했어요(WebGL 확인): ${String((e as Error).message ?? e)}`);
      return;
    }
    sessionRef.current = session;
    const unsub = session.subscribe(setSnap);
    session.start().catch((e) => setError(String((e as Error).message ?? e)));
    return () => {
      unsub();
      session.dispose();
      sessionRef.current = null;
    };
    // 세션은 화면 진입 시 1회 생성 (설정 변경은 다음 경기에 반영)
  }, []);

  return (
    <div className="game-root" ref={host}>
      {error && <div className="overlay-panel"><div className="card error-box"><p>{error}</p><button onClick={onExit}>로비로</button></div></div>}
      {snap && <Hud snap={snap} character={character} opponent={AI_OPPONENT} difficulty={settings.difficulty} miniCam={settings.miniCam && input.kind !== 'keyboard'} onResume={() => sessionRef.current?.togglePause()} onExit={onExit} />}
      {snap && settings.debugOverlay && <DebugOverlay snap={snap} tracker={tracker} stance={settings.stance} />}
      {snap?.phase === 'RESULT' && snap.outcome && (
        <ResultView snap={snap} onRematch={() => sessionRef.current?.rematch()} onExit={onExit} />
      )}
    </div>
  );
}

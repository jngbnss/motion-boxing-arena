import { useEffect, useRef, useState } from 'react';
import { defaultProfile, type CalibrationProfile } from '@mba/motion';
import type { CharacterManifest, MatchPhase, MatchReport } from '@mba/shared';
import { AI_OPPONENT, BUILTIN_CHARACTERS, manifestFromNetId } from '../../characters.ts';
import { GameSession, type HudSnapshot } from '../../game/GameSession.ts';
import { OnlineSession } from '../../game/OnlineSession.ts';
import { KeyboardInput } from '../../input/KeyboardInput.ts';
import type { PoseTracker } from '../../input/PoseTracker.ts';
import { ReplayInput } from '../../input/ReplayInput.ts';
import type { InputSource } from '../../input/types.ts';
import { WebcamInput } from '../../input/WebcamInput.ts';
import { api, newIdempotencyKey } from '../../net/api.ts';
import type { DuelConnection } from '../../net/duel.ts';
import type { Settings } from '../../settings.ts';
import { DebugOverlay } from '../DebugOverlay.tsx';
import { Hud } from '../Hud.tsx';
import { ResultView } from '../ResultView.tsx';

export type GameInputChoice = { kind: 'keyboard' } | { kind: 'webcam' } | { kind: 'replay'; text: string; name: string };

/** 싱글(AI) 또는 온라인 대전 */
export type GameMode = { kind: 'ai' } | { kind: 'online'; duel: DuelConnection };

/** 온라인 결과 이후 상대가 떠났을 때 서버가 돌아가는 단계 (결과 화면 유지) */
const AFTER_RESULT: readonly MatchPhase[] = ['LOBBY', 'WAITING_OPPONENT', 'CALIBRATING'];

interface MatchSession {
  subscribe(l: (s: HudSnapshot) => void): () => void;
  start(): Promise<void>;
  rematch(): void;
  /** 싱글 전용 (온라인은 사용자 일시정지가 없다) */
  togglePause?(): void;
  dispose(): void;
}

/** AI 대전 결과 보고 (서버 설정 시 best effort, docs/08 §2.10) */
async function reportAiMatch(snap: HudSnapshot, difficulty: Settings['difficulty'], key: string): Promise<string> {
  if (!api || !snap.outcome) return '';
  const { config } = await api.getConfig();
  if (!config) return '';
  const o = snap.outcome;
  const report: MatchReport = {
    difficulty,
    result: o.reason,
    won: o.winner == null ? null : o.winner === 'player',
    durationMs: Math.round(Math.min(o.durationMs, 10 * 60_000)),
    stats: snap.stats.player,
  };
  await api.reportMatch(report, key);
  return '경기 기록이 저장됐어요.';
}

export function GameScreen({ input, tracker, profile, settings, character, mode = { kind: 'ai' }, onExit }: {
  input: GameInputChoice;
  tracker: PoseTracker | null;
  profile: CalibrationProfile | null;
  settings: Settings;
  character: CharacterManifest;
  mode?: GameMode;
  onExit: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<MatchSession | null>(null);
  const onlineRef = useRef<OnlineSession | null>(null);
  const [snap, setSnap] = useState<HudSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const reportKey = useRef<string | null>(null);
  const [opponent, setOpponent] = useState<CharacterManifest>(() => {
    if (mode.kind === 'ai') return AI_OPPONENT;
    const opp = mode.duel.opponent();
    return (opp && manifestFromNetId(opp.characterId, opp.nickname)) ?? BUILTIN_CHARACTERS[1]!;
  });

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
    let session: MatchSession;
    try {
      if (mode.kind === 'online') {
        const online = new OnlineSession({ container: el, input: source, player: character, opponent, settings, duel: mode.duel });
        onlineRef.current = online;
        session = online;
      } else {
        session = new GameSession({ container: el, input: source, player: character, opponent: AI_OPPONENT, difficulty: settings.difficulty, settings });
      }
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
      onlineRef.current = null;
    };
    // 세션은 화면 진입 시 1회 생성 (설정 변경은 다음 경기에 반영)
  }, []);

  // 온라인: 상대 캐릭터 매니페스트 해석 (HUD 이름·배지)
  const oppCharacterId = mode.kind === 'online' ? mode.duel.opponent()?.characterId ?? '' : '';
  useEffect(() => {
    if (mode.kind !== 'online' || !oppCharacterId) return;
    let alive = true;
    void mode.duel.resolveCharacter(oppCharacterId, mode.duel.opponent()?.nickname).then((m) => { if (alive) setOpponent(m); });
    return () => { alive = false; };
  }, [oppCharacterId]);

  // 온라인: ESC = 경기 메뉴(기권). 서버 경기는 멈추지 않는다
  useEffect(() => {
    if (mode.kind !== 'online') return;
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') setMenu((v) => !v); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 싱글: 결과 화면 진입 시 1회 보고 (재대결마다 새 Idempotency-Key)
  const resultReady = snap?.phase === 'RESULT' && snap.outcome != null;
  useEffect(() => {
    if (mode.kind !== 'ai') return;
    if (!resultReady || !snap) {
      reportKey.current = null;
      setSaveNote(null);
      return;
    }
    if (reportKey.current) return;
    const key = newIdempotencyKey();
    reportKey.current = key;
    reportAiMatch(snap, settings.difficulty, key)
      .then((note) => setSaveNote(note || null))
      .catch(() => setSaveNote('경기 기록 저장 실패 (서버 오류) — 결과는 이 화면에만 표시돼요.'));
  }, [resultReady]);

  const forfeit = () => {
    setMenu(false);
    onlineRef.current?.forfeit();
  };

  return (
    <div className="game-root" ref={host}>
      {error && <div className="overlay-panel"><div className="card error-box"><p>{error}</p><button onClick={onExit}>로비로</button></div></div>}
      {snap && (
        <Hud
          snap={snap}
          character={character}
          opponent={opponent}
          difficulty={mode.kind === 'ai' ? settings.difficulty : null}
          miniCam={settings.miniCam && input.kind !== 'keyboard'}
          onResume={() => sessionRef.current?.togglePause?.()}
          onExit={onExit}
          onForfeit={mode.kind === 'online' ? forfeit : undefined}
        />
      )}
      {snap && settings.debugOverlay && <DebugOverlay snap={snap} tracker={tracker} stance={settings.stance} />}
      {menu && snap && snap.phase !== 'RESULT' && (
        <div className="overlay-panel" style={{ pointerEvents: 'auto' }}>
          <div className="card" style={{ width: 'min(380px, 92%)', textAlign: 'center' }}>
            <h2>경기 메뉴</h2>
            <p className="muted">온라인 경기는 멈추지 않아요.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="primary" onClick={() => setMenu(false)}>계속</button>
              <button onClick={forfeit} disabled={!['COUNTDOWN', 'FIGHTING', 'PAUSED'].includes(snap.phase)}>기권</button>
              <button onClick={onExit}>방 나가기</button>
            </div>
          </div>
        </div>
      )}
      {snap?.outcome && (snap.phase === 'RESULT' || (snap.online && AFTER_RESULT.includes(snap.phase))) && (
        <ResultView snap={snap} saveNote={saveNote} onRematch={() => sessionRef.current?.rematch()} onExit={onExit} />
      )}
    </div>
  );
}

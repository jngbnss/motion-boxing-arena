import type { CharacterManifest } from '@mba/shared';
import { BoxerPreview } from '../BoxerPreview.tsx';

export function MainScreen({ character, onStart, onCharacters, onCreate }: {
  character: CharacterManifest;
  onStart: () => void;
  onCharacters: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="screen" style={{ justifyContent: 'center' }}>
      <div className="title-xl">MOTION <span>BOXING</span><br />ARENA</div>
      <p className="muted" style={{ textAlign: 'center', margin: 0 }}>내가 만든 캐릭터가 내 움직임대로 싸운다. 웹캠 앞에서 실제로 주먹을 뻗고, 고개를 젖혀 피하세요.</p>
      <div className="card" style={{ width: 'min(420px, 100%)', padding: 8 }}>
        <BoxerPreview character={character} height={300} />
        <div className="row" style={{ justifyContent: 'center', paddingBottom: 8 }}>
          <b>{character.name}</b> <span className={`badge ${character.tier}`}>{character.tier}</span>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="primary" onClick={onStart}>게임 시작</button>
        <button onClick={onCharacters}>캐릭터 선택</button>
        <button onClick={onCreate}>캐릭터 만들기</button>
      </div>
      <p className="muted" style={{ fontSize: 13, textAlign: 'center', maxWidth: 520 }}>
        웹캠 영상은 브라우저 안에서만 처리되며 어디에도 전송·저장되지 않습니다. 플레이 전 주변 1.5m × 1.5m 공간을 비워 주세요.
      </p>
    </div>
  );
}

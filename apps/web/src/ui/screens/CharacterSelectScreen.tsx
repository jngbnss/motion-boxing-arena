import { useMemo, useState } from 'react';
import { BUILTIN_CHARACTERS, deleteCustomCharacter, loadCustomCharacters } from '../../characters.ts';
import { BoxerPreview } from '../BoxerPreview.tsx';

export function CharacterSelectScreen({ selectedId, version, onSelect, onCreate, onDone, onChanged }: {
  selectedId: string;
  version: number;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDone: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'builtin' | 'mine'>('builtin');
  const mine = useMemo(() => loadCustomCharacters(), [version]);
  const list = tab === 'builtin' ? BUILTIN_CHARACTERS : mine;
  const selected = [...BUILTIN_CHARACTERS, ...mine].find((c) => c.id === selectedId) ?? BUILTIN_CHARACTERS[0]!;

  return (
    <div className="screen">
      <h1>캐릭터 선택</h1>
      <div className="card" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div>
          <BoxerPreview character={selected} height={300} />
          <div className="row" style={{ justifyContent: 'center' }}>
            <b>{selected.name}</b> <span className={`badge ${selected.tier}`}>{selected.tier}</span>
          </div>
        </div>
        <div>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className={tab === 'builtin' ? 'selected' : ''} onClick={() => setTab('builtin')}>기본</button>
            <button className={tab === 'mine' ? 'selected' : ''} onClick={() => setTab('mine')}>내 캐릭터 ({mine.length})</button>
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {list.map((c) => (
              <button key={c.id} className={`char-card ${c.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(c.id)}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>{c.name}</b> <span className={`badge ${c.tier}`}>{c.tier}</span>
                </div>
                <div className="swatches">
                  {(c.skin?.palette ?? []).map((p, i) => <span key={i} className="swatch" style={{ background: p }} />)}
                </div>
                {!c.builtin && (
                  <span
                    className="muted"
                    style={{ fontSize: 12, textDecoration: 'underline' }}
                    onClick={(e) => { e.stopPropagation(); if (confirm(`'${c.name}'을(를) 삭제할까요?`)) { deleteCustomCharacter(c.id); onChanged(); } }}
                  >삭제</span>
                )}
              </button>
            ))}
            <button className="char-card" onClick={onCreate} style={{ alignItems: 'center', justifyContent: 'center', minHeight: 80 }}>
              ＋ 새로 만들기
            </button>
          </div>
          {tab === 'mine' && mine.length === 0 && <p className="muted">아직 만든 캐릭터가 없어요 → 새로 만들기</p>}
        </div>
      </div>
      <button className="primary" onClick={onDone}>이 캐릭터로 로비 가기</button>
    </div>
  );
}

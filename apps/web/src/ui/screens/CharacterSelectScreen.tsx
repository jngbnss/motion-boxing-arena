import { useEffect, useMemo, useState } from 'react';
import type { CharacterManifest, CharacterSummary } from '@mba/shared';
import {
  BUILTIN_CHARACTERS,
  deleteCustomCharacter,
  loadCustomCharacters,
  loadGenerationJobs,
  loadServerCharacters,
  pruneServerCharacters,
  removeGenerationJob,
  saveServerCharacter,
} from '../../characters.ts';
import { api, errorMessage } from '../../net/api.ts';
import { useServerConfig } from '../../net/useServerConfig.ts';
import type { Settings } from '../../settings.ts';
import { BoxerPreview } from '../BoxerPreview.tsx';

/** 서버 목록(GET /characters) 동기화: READY 매니페스트를 캐시에 받아 두고 생성 중/실패 항목은 요약으로 보여준다 */
function useServerCharacters(enabled: boolean, version: number): { pending: CharacterSummary[]; error: string | null; synced: number } {
  const [pending, setPending] = useState<CharacterSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(0);
  useEffect(() => {
    if (!enabled || !api) return;
    const client = api;
    let alive = true;
    const sync = async () => {
      try {
        const { items } = await client.listCharacters();
        const cached = new Set(loadServerCharacters().map((c) => c.id));
        for (const it of items) {
          if (it.status === 'READY' && !cached.has(it.id)) saveServerCharacter(await client.getCharacter(it.id));
        }
        pruneServerCharacters(items.filter((i) => i.status === 'READY').map((i) => i.id));
        if (!alive) return;
        setPending(items.filter((i) => i.status !== 'READY'));
        setError(null);
        setSynced((n) => n + 1);
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    };
    void sync();
    // 생성 중인 항목이 있으면 10초마다 갱신
    const t = setInterval(() => { if (alive) void sync(); }, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [enabled, version]);
  return { pending, error, synced };
}

export function CharacterSelectScreen({ selectedId, version, settings, invite, onSettings, onSelect, onCreate, onDone, onChanged }: {
  selectedId: string;
  version: number;
  settings: Settings;
  /** ?room=CODE 초대로 들어온 경우 방 코드 */
  invite: string | null;
  onSettings: (s: Settings) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDone: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'builtin' | 'mine'>(() => (selectedId.startsWith('builtin-') ? 'builtin' : 'mine'));
  const server = useServerConfig();
  const { pending, error, synced } = useServerCharacters(server.status === 'ready', version);
  const local = useMemo(() => loadCustomCharacters(), [version]);
  const generated = useMemo(() => loadServerCharacters(), [version, synced]);
  const mine: CharacterManifest[] = [...generated, ...local];
  const list = tab === 'builtin' ? BUILTIN_CHARACTERS : mine;
  const selected = [...BUILTIN_CHARACTERS, ...mine].find((c) => c.id === selectedId) ?? BUILTIN_CHARACTERS[0]!;

  // C13: 3D 캐릭터 완성 시, 먼저 만든 T0가 선택돼 있으면 자동 교체
  useEffect(() => {
    for (const job of loadGenerationJobs()) {
      if (!generated.some((c) => c.id === job.characterId)) continue;
      removeGenerationJob(job.jobId);
      if (settings.autoSwapCharacter && selectedId === job.t0Id) onSelect(job.characterId);
    }
  }, [generated]);

  return (
    <div className="screen">
      <h1>캐릭터 선택</h1>
      {invite && (
        <div className="warn-box" style={{ width: 'min(920px, 100%)' }}>
          친구가 초대한 방 <b>{invite}</b>에 참가합니다. 캐릭터와 입력 방식을 고른 뒤 아래 버튼을 누르세요.
          <div className="row" style={{ marginTop: 8 }}>
            <button className={settings.inputMode === 'webcam' ? 'selected' : ''} onClick={() => onSettings({ ...settings, inputMode: 'webcam' })}>📷 웹캠</button>
            <button className={settings.inputMode === 'keyboard' ? 'selected' : ''} onClick={() => onSettings({ ...settings, inputMode: 'keyboard' })}>⌨ 키보드(개발·시연)</button>
          </div>
        </div>
      )}
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
                {c.thumbnailUrl ? (
                  <img src={c.thumbnailUrl} alt="" style={{ width: '100%', maxHeight: 90, objectFit: 'contain' }} />
                ) : (
                  <div className="swatches">
                    {(c.skin?.palette ?? []).map((p, i) => <span key={i} className="swatch" style={{ background: p }} />)}
                  </div>
                )}
                {!c.builtin && c.ownerId === 'local' && (
                  <span
                    className="muted"
                    style={{ fontSize: 12, textDecoration: 'underline' }}
                    onClick={(e) => { e.stopPropagation(); if (confirm(`'${c.name}'을(를) 삭제할까요?`)) { deleteCustomCharacter(c.id); onChanged(); } }}
                  >삭제</span>
                )}
              </button>
            ))}
            {tab === 'mine' && pending.map((p) => (
              <div key={p.id} className="char-card" style={{ opacity: 0.7 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}><b>{p.name}</b> <span className="badge">{p.status === 'FAILED' ? '실패' : '생성 중'}</span></div>
                <span className="muted" style={{ fontSize: 12 }}>{p.status === 'FAILED' ? '3D 변환 실패 — T0 스킨으로 플레이할 수 있어요' : 'AI 3D 변환 진행 중…'}</span>
              </div>
            ))}
            <button className="char-card" onClick={onCreate} style={{ alignItems: 'center', justifyContent: 'center', minHeight: 80 }}>
              ＋ 새로 만들기
            </button>
          </div>
          {tab === 'mine' && mine.length === 0 && pending.length === 0 && <p className="muted">아직 만든 캐릭터가 없어요 → 새로 만들기</p>}
          {tab === 'mine' && error && <p className="muted" style={{ fontSize: 12 }}>서버 캐릭터 목록을 불러오지 못했어요: {error}</p>}
        </div>
      </div>
      <button className="primary" onClick={onDone}>{invite ? `이 캐릭터로 방 ${invite} 참가` : '이 캐릭터로 로비 가기'}</button>
    </div>
  );
}

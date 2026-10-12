// 캐릭터 생성: 업로드 또는 A-pose 실루엣 템플릿 위에 그리기 → 팔레트 추출 → T0 스킨을 즉시 만든다 (C13: 항상 먼저 만든다).
// 서버가 설정돼 있고 권리 확인을 했으면 같은 이미지를 업로드해 AI 3D 변환(T1/T2) 작업을 요청하고 진행 상황을 폴링한다.
import { useEffect, useRef, useState } from 'react';
import { SKELETON_ID, UPLOAD_LIMITS, type CharacterManifest } from '@mba/shared';
import { saveCustomCharacter, saveGenerationJob } from '../../characters.ts';
import { api, ApiError, errorMessage, newIdempotencyKey } from '../../net/api.ts';
import { featureBlockedReason, useServerConfig } from '../../net/useServerConfig.ts';
import type { Settings } from '../../settings.ts';
import { extractPalette, toBoxerPalette } from '../../skin/palette.ts';
import { BoxerPreview } from '../BoxerPreview.tsx';
import { GenerationPanel } from '../GenerationPanel.tsx';

/** 생성 요청 오류 → 사용자 문구 (모두 T0로 계속 플레이 가능) */
function generateErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return '오늘 AI 생성 횟수(하루 3회)를 모두 썼어요. 만든 T0 스킨으로 플레이하세요.';
    if (e.code === 'QUEUE_FULL') return '생성 대기열이 가득 찼어요. 잠시 후 다시 시도하거나 T0 스킨으로 플레이하세요.';
    if (e.code === 'IMAGE_INVALID') return `서버가 이미지를 거절했어요: ${e.message}`;
    if (e.code === 'RIGHTS_NOT_ATTESTED') return '이미지 권리 확인이 필요해요.';
  }
  return `AI 3D 변환을 요청하지 못했어요: ${errorMessage(e)}`;
}

const W = 512;
const H = 768;
const COLORS = ['#111111', '#ffffff', '#e8231a', '#ff8a00', '#ffd400', '#3ddc84', '#1e88e5', '#3949ab', '#8e24aa', '#ec407a', '#8d6e63', '#9e9e9e'];

function drawSilhouette(g: CanvasRenderingContext2D) {
  g.clearRect(0, 0, W, H);
  g.save();
  g.fillStyle = 'rgba(80,120,255,0.12)';
  g.strokeStyle = 'rgba(80,120,255,0.45)';
  g.lineWidth = 3;
  g.setLineDash([10, 8]);
  const cx = W / 2;
  g.beginPath();
  g.arc(cx, 120, 62, 0, Math.PI * 2); // 머리
  g.moveTo(cx - 90, 210); g.lineTo(cx + 90, 210); g.lineTo(cx + 75, 450); g.lineTo(cx - 75, 450); g.closePath(); // 몸통
  for (const s of [-1, 1]) {
    // 팔 45° (A-pose)
    g.moveTo(cx + s * 88, 215); g.lineTo(cx + s * 215, 380); g.lineTo(cx + s * 185, 405); g.lineTo(cx + s * 80, 280); g.closePath();
    // 다리
    g.moveTo(cx + s * 15, 450); g.lineTo(cx + s * 75, 450); g.lineTo(cx + s * 95, 730); g.lineTo(cx + s * 40, 730); g.closePath();
  }
  g.fill();
  g.stroke();
  g.restore();
}

function floodFill(ctx: CanvasRenderingContext2D, x: number, y: number, hex: string) {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const n = parseInt(hex.slice(1), 16);
  const fr = (n >> 16) & 255, fg = (n >> 8) & 255, fb = n & 255;
  const i0 = (y * W + x) * 4;
  const [tr, tg, tb, ta] = [d[i0]!, d[i0 + 1]!, d[i0 + 2]!, d[i0 + 3]!];
  if (tr === fr && tg === fg && tb === fb && ta === 255) return;
  const match = (i: number) => Math.abs(d[i]! - tr) + Math.abs(d[i + 1]! - tg) + Math.abs(d[i + 2]! - tb) + Math.abs(d[i + 3]! - ta) < 60;
  const stack = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop()!;
    let xx = px!;
    const yy = py!;
    while (xx >= 0 && match((yy * W + xx) * 4)) xx--;
    xx++;
    let up = false, down = false;
    while (xx < W && match((yy * W + xx) * 4)) {
      const i = (yy * W + xx) * 4;
      d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;
      if (yy > 0) { const m = match(((yy - 1) * W + xx) * 4); if (m && !up) { stack.push([xx, yy - 1]); up = true; } else if (!m) up = false; }
      if (yy < H - 1) { const m = match(((yy + 1) * W + xx) * 4); if (m && !down) { stack.push([xx, yy + 1]); down = true; } else if (!m) down = false; }
      xx++;
    }
  }
  ctx.putImageData(img, 0, 0);
}

async function imageFromFile(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/** 이미지 소스 → 팔레트 + 가슴 데칼(256px JPEG) */
function analyze(source: CanvasImageSource, w: number, h: number): { palette: string[]; decal: string } {
  const c = document.createElement('canvas');
  c.width = 64; c.height = Math.max(1, Math.round((64 * h) / w));
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(source, 0, 0, c.width, c.height);
  const palette = toBoxerPalette(extractPalette(g.getImageData(0, 0, c.width, c.height).data, { k: 4 }));
  const d = document.createElement('canvas');
  const s = 256 / Math.max(w, h);
  d.width = Math.round(w * s); d.height = Math.round(h * s);
  const dg = d.getContext('2d')!;
  dg.drawImage(source, 0, 0, d.width, d.height);
  return { palette, decal: d.toDataURL('image/png') };
}

export function CharacterCreateScreen({ settings, onCreated, onDone, onCancel }: {
  settings: Settings;
  /** 캐릭터 저장·선택 (화면 이동 없음) */
  onCreated: (id: string) => void;
  /** 캐릭터 선택 화면으로 */
  onDone: () => void;
  onCancel: () => void;
}) {
  const server = useServerConfig();
  const genBlocked = featureBlockedReason(server, 'generation');
  const [wantGen, setWantGen] = useState(true);
  const [gen, setGen] = useState<{ phase: 'idle' | 'uploading' | 'running' | 'error' | 'done'; jobId?: string; estimatedSeconds?: number; error?: string; ready?: CharacterManifest }>({ phase: 'idle' });
  const sourceBlob = useRef<{ blob: Blob; filename: string } | null>(null);
  const [tab, setTab] = useState<'upload' | 'draw'>('draw');
  const [name, setName] = useState('나의 복서');
  const [rights, setRights] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CharacterManifest | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [color, setColor] = useState('#e8231a');
  const [tool, setTool] = useState<'pen' | 'fill' | 'eraser'>('pen');
  const [width, setWidth] = useState(10);
  const guideRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<HTMLCanvasElement>(null);
  const history = useRef<ImageData[]>([]);
  const drawing = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const g = guideRef.current?.getContext('2d');
    if (g) drawSilhouette(g);
  }, [tab]);

  const ctx = () => drawRef.current?.getContext('2d', { willReadFrequently: true }) ?? null;
  const pos = (e: React.PointerEvent) => {
    const r = drawRef.current!.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * W), y: Math.round(((e.clientY - r.top) / r.height) * H) };
  };
  const snapshot = () => {
    const g = ctx();
    if (!g) return;
    history.current.push(g.getImageData(0, 0, W, H));
    if (history.current.length > 20) history.current.shift();
  };
  const onDown = (e: React.PointerEvent) => {
    const g = ctx();
    if (!g) return;
    snapshot();
    const p = pos(e);
    if (tool === 'fill') { floodFill(g, Math.min(W - 1, Math.max(0, p.x)), Math.min(H - 1, Math.max(0, p.y)), color); return; }
    drawing.current = p;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const g = ctx();
    if (!g || !drawing.current) return;
    const p = pos(e);
    g.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    g.strokeStyle = color;
    g.lineWidth = tool === 'eraser' ? width * 2 : width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(drawing.current.x, drawing.current.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    drawing.current = p;
  };
  const onUp = () => { drawing.current = null; };
  const undo = () => {
    const g = ctx();
    const last = history.current.pop();
    if (g && last) g.putImageData(last, 0, 0);
  };

  const build = async () => {
    setError(null);
    if (!rights) { setError('이미지에 대한 권리 확인에 체크해 주세요.'); return; }
    try {
      let result: { palette: string[]; decal: string };
      if (tab === 'upload') {
        if (!file) { setError('이미지를 선택해 주세요.'); return; }
        if (!(UPLOAD_LIMITS.mimeTypes as readonly string[]).includes(file.type)) { setError('PNG, JPG, WebP만 업로드할 수 있어요.'); return; }
        if (file.size > UPLOAD_LIMITS.maxBytes) { setError('파일이 10MB를 넘어요.'); return; }
        const img = await imageFromFile(file);
        if (Math.min(img.naturalWidth, img.naturalHeight) < UPLOAD_LIMITS.minShortSidePx) {
          setError(`짧은 변이 ${UPLOAD_LIMITS.minShortSidePx}px 이상이어야 해요 (현재 ${Math.min(img.naturalWidth, img.naturalHeight)}px).`);
          return;
        }
        result = analyze(img, img.naturalWidth, img.naturalHeight);
        sourceBlob.current = { blob: file, filename: file.name };
      } else {
        const c = drawRef.current;
        if (!c) return;
        result = analyze(c, W, H);
        // 실루엣 밖은 이미 투명(그린 캔버스만 PNG로). 512×768이라 서버 최소 해상도(짧은 변 512)를 만족한다
        const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));
        sourceBlob.current = blob ? { blob, filename: 'drawing.png' } : null;
      }
      const id = `t0-${Date.now().toString(36)}`;
      const manifest: CharacterManifest = {
        id,
        name: name.trim().slice(0, 32) || '나의 복서',
        ownerId: 'local',
        skeleton: SKELETON_ID,
        tier: 'T0',
        glbUrl: null,
        thumbnailUrl: null,
        skin: { palette: result.palette, decals: { chest: result.decal } },
        scale: 1,
        provenance: { model: 'palette-kmeans', modelVersion: '1', seed: null, rigger: 'none', createdAt: new Date().toISOString() },
        license: { userAttestedRights: true, visibility: 'private' },
        builtin: false,
      };
      setPreview(manifest);
    } catch (e) {
      setError(`이미지를 처리하지 못했어요: ${String((e as Error)?.message ?? e)}`);
    }
  };

  const startGeneration = async (t0: CharacterManifest) => {
    const src = sourceBlob.current;
    if (!api || !src) return;
    setGen({ phase: 'uploading' });
    try {
      const up = await api.upload(src.blob, src.filename, rights);
      const res = await api.generate({ uploadId: up.uploadId, name: t0.name.slice(0, 20) }, newIdempotencyKey());
      saveGenerationJob({ jobId: res.jobId, characterId: res.characterId, t0Id: t0.id, name: t0.name, createdAt: new Date().toISOString() });
      setGen({ phase: 'running', jobId: res.jobId, estimatedSeconds: res.estimatedSeconds });
    } catch (e) {
      setGen({ phase: 'error', error: generateErrorMessage(e) });
    }
  };

  const save = () => {
    if (!preview) return;
    if (!saveCustomCharacter(preview)) {
      setError('브라우저 저장소에 저장하지 못했어요(비공개 창이거나 용량 초과). 이번 세션에서만 사용할 수 있어요.');
    }
    onCreated(preview.id);
    if (wantGen && !genBlocked && rights && sourceBlob.current) void startGeneration(preview);
    else onDone();
  };

  const onGenReady = (m: CharacterManifest) => {
    setGen((g) => ({ ...g, phase: 'done', ready: m }));
    if (settings.autoSwapCharacter) onCreated(m.id);
  };

  return (
    <div className="screen">
      <h1>캐릭터 만들기</h1>
      <div className="warn-box" style={{ width: 'min(920px, 100%)' }}>
        먼저 <b>T0 스킨</b>을 바로 만들어요(그림의 색과 이미지를 기본 복서에 입힘, 2초 이내).{' '}
        {genBlocked
          ? <>AI 3D 변환(T1/T2): {genBlocked}</>
          : <>저장하면 같은 이미지로 <b>AI 3D 변환(T1/T2)</b>도 요청하고, 완성되면 다음 경기부터 3D 캐릭터로 바뀌어요.{server.config && !server.config.workerOnline && ' (지금은 생성 워커가 꺼져 있어 대기열에서 기다립니다.)'}</>}
      </div>
      <div className="card" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <div>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className={tab === 'draw' ? 'selected' : ''} onClick={() => setTab('draw')}>그리기</button>
            <button className={tab === 'upload' ? 'selected' : ''} onClick={() => setTab('upload')}>이미지 업로드</button>
          </div>
          {tab === 'draw' ? (
            <>
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>점선 실루엣(정면, 팔 45°) 안에 그리면 나중에 3D 변환 성공률이 높아져요.</p>
              <div className="draw-wrap">
                <canvas ref={guideRef} width={W} height={H} />
                <canvas ref={drawRef} width={W} height={H} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} />
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                {(['pen', 'fill', 'eraser'] as const).map((t) => (
                  <button key={t} className={tool === t ? 'selected' : ''} onClick={() => setTool(t)}>{t === 'pen' ? '펜' : t === 'fill' ? '채우기' : '지우개'}</button>
                ))}
                <select value={width} onChange={(e) => setWidth(Number(e.target.value))} aria-label="굵기">
                  <option value={4}>얇게</option><option value={10}>보통</option><option value={22}>굵게</option>
                </select>
                <button onClick={undo}>실행 취소</button>
              </div>
              <div className="swatches" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                {COLORS.map((c) => (
                  <button key={c} aria-label={c} className="swatch" style={{ background: c, padding: 0, outline: c === color ? '2px solid #fff' : 'none' }} onClick={() => setColor(c)} />
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>정면 전신, 단순한 배경이 좋아요. PNG/JPG/WebP, 10MB 이하, 짧은 변 512px 이상.</p>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label>이름 <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} /></label>
          <label style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />
            <span style={{ fontSize: 14 }}>이 이미지를 사용할 권리가 저에게 있습니다(직접 그렸거나 사용 허락을 받음). 캐릭터는 비공개로 저장되며 경기 상대에게만 보입니다.</span>
          </label>
          <label style={{ alignItems: 'flex-start', opacity: genBlocked ? 0.5 : 1 }}>
            <input type="checkbox" checked={wantGen && !genBlocked} disabled={!!genBlocked || gen.phase !== 'idle'} onChange={(e) => setWantGen(e.target.checked)} data-testid="want-gen" />
            <span style={{ fontSize: 14 }}>저장할 때 AI 3D 변환(T1/T2)도 요청 (이미지를 생성 서버에 업로드, 하루 3회)</span>
          </label>
          <button className="primary" onClick={build} disabled={gen.phase !== 'idle'}>스킨 캐릭터 만들기</button>
          {error && <div className="error-box">{error}</div>}
          {preview && gen.phase === 'idle' && (
            <>
              <BoxerPreview character={preview} height={260} />
              <div className="swatches">{preview.skin?.palette.map((p, i) => <span key={i} className="swatch" style={{ background: p }} />)}</div>
              <div className="row"><span className="badge T0">T0</span> <button className="primary" onClick={save}>{wantGen && !genBlocked ? '저장하고 3D 변환 요청' : '저장하고 선택'}</button></div>
            </>
          )}
          {gen.phase !== 'idle' && (
            <div className="row"><span className="badge T0">T0</span> <span>스킨 캐릭터 저장·선택 완료 — 지금 바로 플레이할 수 있어요.</span></div>
          )}
          {gen.phase === 'uploading' && <span className="muted">이미지 업로드·작업 요청 중…</span>}
          {gen.phase === 'error' && <div className="error-box">{gen.error}<p style={{ margin: '6px 0 0' }}>T0 스킨 캐릭터는 저장돼 있어요.</p></div>}
          {(gen.phase === 'running' || gen.phase === 'done') && gen.jobId && (
            <GenerationPanel jobId={gen.jobId} estimatedSeconds={gen.estimatedSeconds ?? 0} onReady={onGenReady} />
          )}
          {gen.ready && (
            <>
              <BoxerPreview character={gen.ready} height={260} />
              <div className="row"><span className={`badge ${gen.ready.tier}`}>{gen.ready.tier}</span> <b>{gen.ready.name}</b> {settings.autoSwapCharacter ? '— 선택됨' : <button onClick={() => onCreated(gen.ready!.id)}>이 캐릭터 선택</button>}</div>
            </>
          )}
          {gen.phase === 'idle' ? (
            <button className="ghost" onClick={onCancel}>취소</button>
          ) : (
            <button onClick={onDone}>캐릭터 선택으로</button>
          )}
        </div>
      </div>
    </div>
  );
}

import type { Settings } from '../settings.ts';

export function SettingsPanel({ settings, onChange, onClose, onRecalibrate }: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  onRecalibrate: () => void;
}) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  return (
    <div className="card settings-panel" role="dialog" aria-label="설정">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>설정 · 디버깅</h3>
        <button className="ghost" onClick={onClose} aria-label="닫기">✕</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        <label>스탠스
          <select value={settings.stance} onChange={(e) => set('stance', e.target.value as Settings['stance'])}>
            <option value="orthodox">오소독스 (왼손 잽)</option>
            <option value="southpaw">사우스포 (오른손 잽)</option>
          </select>
        </label>
        <label>포즈 모델
          <select value={settings.poseModel} onChange={(e) => set('poseModel', e.target.value as Settings['poseModel'])}>
            <option value="lite">lite (빠름)</option>
            <option value="full">full (정확)</option>
          </select>
        </label>
        <label>카메라 흔들림 {Math.round(settings.cameraShake * 100)}%
          <input type="range" min={0} max={1} step={0.05} value={settings.cameraShake} onChange={(e) => set('cameraShake', Number(e.target.value))} />
        </label>
        <label><input type="checkbox" checked={settings.debugOverlay} onChange={(e) => set('debugOverlay', e.target.checked)} /> 랜드마크 디버그 오버레이</label>
        <label><input type="checkbox" checked={settings.miniCam} onChange={(e) => set('miniCam', e.target.checked)} /> 미니 스켈레톤 패널</label>
        <label><input type="checkbox" checked={settings.autoSwapCharacter} onChange={(e) => set('autoSwapCharacter', e.target.checked)} /> 3D 캐릭터 완성 시 다음 경기에 자동 교체</label>
        <button onClick={onRecalibrate}>캘리브레이션 다시 하기</button>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>스탠스·모델 변경은 다음 경기부터 적용됩니다. 스탠스를 바꾸면 캘리브레이션을 다시 합니다.</p>
      </div>
    </div>
  );
}

import type { CameraError } from '../input/PoseTracker.ts';

const HELP: Record<CameraError['code'], string> = {
  denied: '주소창 왼쪽의 카메라(자물쇠) 아이콘을 눌러 카메라를 "허용"으로 바꾼 뒤 다시 시도해 주세요.',
  notfound: '카메라가 연결되어 있는지 확인해 주세요. 노트북이라면 카메라 차단 스위치를 확인하세요.',
  busy: '화상회의 앱 등 카메라를 쓰는 다른 프로그램을 종료한 뒤 다시 시도해 주세요.',
  insecure: 'HTTPS 주소(또는 localhost)로 접속해야 웹캠을 사용할 수 있어요.',
  unsupported: '최신 Chrome 또는 Edge에서 접속해 주세요.',
  model: '네트워크 연결을 확인한 뒤 다시 시도해 주세요. 모델 파일은 처음 한 번만 내려받습니다.',
  unknown: '페이지를 새로고침한 뒤 다시 시도해 주세요.',
};

export function CameraErrorView({ error, onRetry, onKeyboard }: { error: CameraError; onRetry: () => void; onKeyboard: () => void }) {
  return (
    <div className="card error-box" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <b>{error.message}</b>
      <span>{HELP[error.code]}</span>
      <div className="row">
        {error.code !== 'unsupported' && error.code !== 'insecure' && <button onClick={onRetry}>다시 시도</button>}
        <button onClick={onKeyboard}>키보드 모드로 플레이 (AI 대전)</button>
      </div>
    </div>
  );
}

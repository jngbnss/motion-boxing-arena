// 랜드마크 스켈레톤 그리기 (미러 표시는 CSS scaleX(-1)로 처리). 신뢰도 색: ≥0.7 초록, 0.5~0.7 노랑, <0.5 빨강
import { LM, type Landmark, type MotionDebug } from '@mba/motion';

const EDGES: Array<[number, number]> = [
  [LM.leftShoulder, LM.rightShoulder], [LM.leftShoulder, LM.leftElbow], [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow], [LM.rightElbow, LM.rightWrist], [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip], [LM.leftHip, LM.rightHip], [LM.leftWrist, LM.leftIndex], [LM.leftWrist, LM.leftPinky],
  [LM.rightWrist, LM.rightIndex], [LM.rightWrist, LM.rightPinky], [LM.leftEar, LM.nose], [LM.rightEar, LM.nose],
];
const USED = [LM.nose, LM.leftEar, LM.rightEar, LM.leftShoulder, LM.rightShoulder, LM.leftElbow, LM.rightElbow, LM.leftWrist, LM.rightWrist, LM.leftPinky, LM.rightPinky, LM.leftIndex, LM.rightIndex, LM.leftHip, LM.rightHip];

export const visColor = (v: number) => (v >= 0.7 ? '#3ddc84' : v >= 0.5 ? '#ffc93c' : '#ff4d6d');

export function drawLandmarks(ctx: CanvasRenderingContext2D, lm: Landmark[] | null, debug?: MotionDebug | null, opts: { background?: boolean } = {}) {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  if (opts.background) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, h);
  }
  if (!lm) {
    ctx.fillStyle = '#ff4d6d';
    ctx.font = `${Math.round(h / 12)}px system-ui`;
    ctx.save();
    ctx.scale(-1, 1);
    ctx.fillText('사람 미검출', -w * 0.75, h / 2);
    ctx.restore();
    return;
  }
  ctx.lineWidth = Math.max(2, w / 160);
  for (const [a, b] of EDGES) {
    const p = lm[a], q = lm[b];
    if (!p || !q) continue;
    ctx.strokeStyle = visColor(Math.min(p.visibility, q.visibility));
    ctx.beginPath();
    ctx.moveTo(p.x * w, p.y * h);
    ctx.lineTo(q.x * w, q.y * h);
    ctx.stroke();
  }
  for (const i of USED) {
    const p = lm[i];
    if (!p) continue;
    ctx.fillStyle = visColor(p.visibility);
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, Math.max(3, w / 110), 0, Math.PI * 2);
    ctx.fill();
  }
  // 머리 중립 위치(점선 원)와 현재 오프셋 벡터 — 어깨 너비 단위
  const ls = lm[LM.leftShoulder], rs = lm[LM.rightShoulder], nose = lm[LM.nose];
  if (debug && ls && rs && nose) {
    const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
    const ox = debug.headOffset.x, oy = debug.headOffset.y;
    // 미러 해제 좌표에서 사용자 오른쪽 = 이미지 -x
    const nx = nose.x * w + ox * sw * w * 0.4;
    const ny = nose.y * h + oy * sw * h * 0.4;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(nx, ny, sw * w * 0.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(nx, ny);
    ctx.lineTo(nose.x * w, nose.y * h);
    ctx.stroke();
  }
}

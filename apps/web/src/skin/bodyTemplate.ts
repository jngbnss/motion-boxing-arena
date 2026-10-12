// T0 전신 스킨 템플릿: 캐릭터 생성 화면의 A-pose 실루엣(512×768, 정면, 팔 45°)과 같은 좌표계. DOM 의존 없음.
// 정면에서 본 그림이라 이미지 오른쪽 = 캐릭터 왼쪽(+X). 부위별 정규화 좌표 → 템플릿 픽셀로 바꿔
// 절차적 복서의 각 부위(머리·몸통·팔·글러브·다리·신발)에 그림을 입힌다(레스트 자세 정면 평면 투영).

export const TEMPLATE_W = 512;
export const TEMPLATE_H = 768;
const CX = TEMPLATE_W / 2;

export const HEAD = { cx: CX, cy: 120, r: 62 } as const;
export const TORSO = { top: 210, bottom: 450, topHalf: 90, bottomHalf: 75 } as const;
/** 캐릭터 왼쪽 팔 (x는 CX 기준 오프셋). 위 가장자리 어깨→손끝, 아래 가장자리 겨드랑이→손목 아래 */
const ARM = { upperStart: [88, 215], upperEnd: [215, 380], lowerEnd: [185, 405], lowerStart: [80, 280] } as const;
/** 캐릭터 왼쪽 다리 (x는 CX 기준 오프셋) */
const LEG = { innerTop: [15, 450], outerTop: [75, 450], outerBottom: [95, 730], innerBottom: [40, 730] } as const;
/** 업로드 이미지의 전경을 맞출 전신 영역 (팔 끝 ~ 발끝) */
export const FIGURE_BOX = { x: CX - 215, y: HEAD.cy - HEAD.r, w: 430, h: 730 - (HEAD.cy - HEAD.r) } as const;

/** 1 = 캐릭터 왼쪽(+X) = 이미지 오른쪽, -1 = 캐릭터 오른쪽 */
export type TemplateSide = 1 | -1;
export type TemplatePx = [number, number];

/** 실루엣 가장자리(점선·바깥 투명)를 덜 집도록 부위 안쪽으로 줄인다 */
const INSET = 0.86;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 머리 원: nx 오른쪽(+X)·ny 위 방향, 단위 원 기준 */
export function headPoint(nx: number, ny: number): TemplatePx {
  const len = Math.hypot(nx, ny);
  const k = (len > 1 ? 1 / len : 1) * INSET;
  return [HEAD.cx + nx * k * HEAD.r, HEAD.cy - ny * k * HEAD.r];
}

/** 몸통 사다리꼴(트렁크 포함): t 0 = 어깨선, 1 = 가랑이. nx -1..1 (+1 = 캐릭터 왼쪽) */
export function torsoPoint(t: number, nx: number): TemplatePx {
  const tt = clamp(t, 0, 1);
  const half = lerp(TORSO.topHalf, TORSO.bottomHalf, tt);
  return [CX + clamp(nx, -1, 1) * INSET * half, lerp(TORSO.top, TORSO.bottom, 0.02 + 0.96 * tt)];
}

function quad(side: TemplateSide, a0: readonly [number, number], a1: readonly [number, number], b0: readonly [number, number], b1: readonly [number, number], t: number, n: number): TemplatePx {
  // a0→a1: n = -1 쪽 가장자리, b0→b1: n = +1 쪽 가장자리 (t 방향 따라)
  const tt = 0.02 + 0.96 * clamp(t, 0, 1);
  const w = (clamp(n, -1, 1) * INSET + 1) / 2;
  const ax = lerp(a0[0], a1[0], tt), ay = lerp(a0[1], a1[1], tt);
  const bx = lerp(b0[0], b1[0], tt), by = lerp(b0[1], b1[1], tt);
  return [CX + side * lerp(ax, bx, w), lerp(ay, by, w)];
}

/** 팔: t 0 = 어깨, 1 = 글러브 끝. n +1 = 위(머리 쪽) 가장자리 */
export function armPoint(side: TemplateSide, t: number, n: number): TemplatePx {
  return quad(side, ARM.lowerStart, ARM.lowerEnd, ARM.upperStart, ARM.upperEnd, t, n);
}

/** 다리: t 0 = 가랑이, 1 = 발바닥. n +1 = 바깥 가장자리 */
export function legPoint(side: TemplateSide, t: number, n: number): TemplatePx {
  return quad(side, LEG.innerTop, LEG.innerBottom, LEG.outerTop, LEG.outerBottom, t, n);
}

/** 템플릿 실루엣 경로 (그리기 화면 가이드) */
export function traceTemplate(g: CanvasPath): void {
  g.moveTo(HEAD.cx + HEAD.r, HEAD.cy);
  g.arc(HEAD.cx, HEAD.cy, HEAD.r, 0, Math.PI * 2);
  g.moveTo(CX - TORSO.topHalf, TORSO.top); g.lineTo(CX + TORSO.topHalf, TORSO.top);
  g.lineTo(CX + TORSO.bottomHalf, TORSO.bottom); g.lineTo(CX - TORSO.bottomHalf, TORSO.bottom); g.closePath();
  for (const s of [-1, 1]) {
    const pts = (p: ReadonlyArray<readonly [number, number]>) => {
      g.moveTo(CX + s * p[0]![0], p[0]![1]);
      for (const q of p.slice(1)) g.lineTo(CX + s * q[0], q[1]);
      g.closePath();
    };
    pts([ARM.upperStart, ARM.upperEnd, ARM.lowerEnd, ARM.lowerStart]);
    pts([LEG.innerTop, LEG.outerTop, LEG.outerBottom, LEG.innerBottom]);
  }
}

/**
 * 템플릿 비율 RGBA 이미지에서 머리 안쪽(외곽선 제외)에 얼굴처럼 여러 색이 그려졌는가.
 * 그렸으면 기본 눈을 숨긴다(그린 얼굴 위에 눈이 겹치지 않게).
 */
export function hasDrawnFace(data: Uint8ClampedArray, w: number, h: number): boolean {
  const sx = w / TEMPLATE_W, sy = h / TEMPLATE_H;
  const r = HEAD.r * 0.6;
  let total = 0, opaque = 0, sum = 0, sum2 = 0;
  for (let y = Math.floor((HEAD.cy - r) * sy); y <= Math.ceil((HEAD.cy + r) * sy); y++) {
    for (let x = Math.floor((HEAD.cx - r) * sx); x <= Math.ceil((HEAD.cx + r) * sx); x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (Math.hypot(x / sx - HEAD.cx, y / sy - HEAD.cy) > r) continue;
      total++;
      const i = (y * w + x) * 4;
      if (data[i + 3]! < 128) continue;
      opaque++;
      const l = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      sum += l;
      sum2 += l * l;
    }
  }
  if (total === 0 || opaque < total * 0.3) return false;
  const mean = sum / opaque;
  return Math.sqrt(Math.max(0, sum2 / opaque - mean * mean)) > 18;
}

// ── 업로드 이미지 전경 분리 ─────────────────────────────────────────────

/**
 * 전경 마스크(1 = 전경). 테두리가 투명하면 알파로, 아니면 테두리의 대표 배경색과 가까운 픽셀을
 * 테두리에서부터 채워(flood) 배경으로 본다 — 인물 안쪽의 배경과 같은 색은 남는다.
 */
export function foregroundMask(data: Uint8ClampedArray, w: number, h: number, tolerance = 48): Uint8Array {
  const mask = new Uint8Array(w * h);
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);

  const transparentBorder = border.filter((p) => data[p * 4 + 3]! < 128).length;
  if (transparentBorder >= border.length * 0.25) {
    for (let p = 0; p < w * h; p++) mask[p] = data[p * 4 + 3]! >= 128 ? 1 : 0;
    return mask;
  }

  // 테두리 색을 4비트로 양자화한 최빈 구간의 평균 = 배경색
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const p of border) {
    const i = p * 4;
    const key = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += data[i]!; e.g += data[i + 1]!; e.b += data[i + 2]!;
    buckets.set(key, e);
  }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const e of buckets.values()) if (e.n > best.n) best = e;
  const br = best.r / best.n, bg = best.g / best.n, bb = best.b / best.n;
  const tol2 = tolerance * tolerance;
  const isBg = (p: number) => {
    const i = p * 4;
    if (data[i + 3]! < 128) return true;
    return (data[i]! - br) ** 2 + (data[i + 1]! - bg) ** 2 + (data[i + 2]! - bb) ** 2 < tol2;
  };

  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  for (const p of border) if (!seen[p] && isBg(p)) { seen[p] = 1; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++]!;
    const x = p % w;
    const visit = (q: number) => { if (!seen[q] && isBg(q)) { seen[q] = 1; queue[tail++] = q; } };
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < w * (h - 1)) visit(p + w);
  }
  for (let p = 0; p < w * h; p++) mask[p] = seen[p] || data[p * 4 + 3]! < 128 ? 0 : 1;
  return mask;
}

export interface Rect { x: number; y: number; w: number; h: number }

/** 전경 경계 상자. 전경이 너무 적으면(0.5% 미만) 분리 실패로 보고 null */
export function maskBounds(mask: Uint8Array, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (n < w * h * 0.005) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 전경 상자를 비율 유지로 템플릿 전신 영역(FIGURE_BOX)에 맞춘다: 가로 가운데, 위쪽(머리) 정렬 */
export function fitToTemplate(size: { w: number; h: number }): Rect {
  const s = Math.min(FIGURE_BOX.w / size.w, FIGURE_BOX.h / size.h);
  const w = size.w * s, h = size.h * s;
  return { x: CX - w / 2, y: FIGURE_BOX.y, w, h };
}

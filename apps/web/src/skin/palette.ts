// T0 스킨: 이미지 픽셀에서 대표 색 k개를 뽑는다 (결정적 k-means). DOM 의존 없음.

export type Rgb = [number, number, number];

export interface PaletteOptions {
  k?: number;
  /** 이 값보다 밝은(배경 흰색) 픽셀 제외 */
  whiteCutoff?: number;
  /** 이 값보다 어두운(선화 검정) 픽셀 제외. 남는 픽셀이 너무 적으면 포함 */
  blackCutoff?: number;
  iterations?: number;
}

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function collect(pixels: Uint8ClampedArray, white: number, black: number | null): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!, a = pixels[i + 3]!;
    if (a < 128) continue;
    if (r > white && g > white && b > white) continue;
    if (black != null && luminance(r, g, b) < black) continue;
    out.push([r, g, b]);
  }
  return out;
}

const dist2 = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** RGBA 픽셀 배열 → 빈도 내림차순 대표 색 (#rrggbb) */
export function extractPalette(pixels: Uint8ClampedArray, opts: PaletteOptions = {}): string[] {
  const k = opts.k ?? 4;
  const white = opts.whiteCutoff ?? 235;
  const black = opts.blackCutoff ?? 28;
  const iterations = opts.iterations ?? 12;

  let pts = collect(pixels, white, black);
  if (pts.length < 16) pts = collect(pixels, white, null);
  if (pts.length === 0) return [];

  // 결정적 초기화: 가장 흔한 위치 대신 farthest-point (첫 점 = 평균에 가장 가까운 점)
  const mean: Rgb = [0, 0, 0];
  for (const p of pts) { mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
  mean[0] /= pts.length; mean[1] /= pts.length; mean[2] /= pts.length;
  let first = pts[0]!;
  for (const p of pts) if (dist2(p, mean) < dist2(first, mean)) first = p;
  const centers: Rgb[] = [[...first] as Rgb];
  while (centers.length < k) {
    let best: Rgb | null = null;
    let bestD = -1;
    for (const p of pts) {
      let d = Infinity;
      for (const c of centers) d = Math.min(d, dist2(p, c));
      if (d > bestD) { bestD = d; best = p; }
    }
    if (!best || bestD <= 0) break;
    centers.push([...best] as Rgb);
  }

  const counts = new Array<number>(centers.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      let bi = 0;
      let bd = Infinity;
      centers.forEach((c, i) => { const d = dist2(p, c); if (d < bd) { bd = d; bi = i; } });
      const s = sums[bi]!;
      s[0]! += p[0]; s[1]! += p[1]; s[2]! += p[2]; s[3]! += 1;
    }
    sums.forEach((s, i) => {
      counts[i] = s[3]!;
      if (s[3]! > 0) centers[i] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
    });
  }

  return centers
    .map((c, i) => ({ c, n: counts[i]! }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => toHex(x.c));
}

export function toHex([r, g, b]: Rgb): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** 게임 팔레트 4색으로 맞춘다: [상의, 트렁크, 강조, 글러브]. 부족하면 변형색으로 채운다 */
export function toBoxerPalette(colors: string[]): string[] {
  const base = colors.length > 0 ? colors : ['#d63a2f'];
  const out = [...base];
  while (out.length < 4) out.push(shade(base[out.length % base.length]!, out.length % 2 ? -0.35 : 0.35));
  return out.slice(0, 4);
}

export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255] as Rgb;
  const t = amount < 0 ? 0 : 255;
  const a = Math.abs(amount);
  return toHex([ch[0] + (t - ch[0]) * a, ch[1] + (t - ch[1]) * a, ch[2] + (t - ch[2]) * a]);
}

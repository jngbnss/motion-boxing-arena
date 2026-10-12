import { describe, expect, it } from 'vitest';
import { extractPalette, toBoxerPalette, shade } from './palette.ts';

function image(colors: Array<[number, number, number, number, number]>): Uint8ClampedArray {
  // [r,g,b,a,count]
  const total = colors.reduce((s, c) => s + c[4], 0);
  const out = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const [r, g, b, a, n] of colors) for (let j = 0; j < n; j++) { out.set([r, g, b, a], i); i += 4; }
  return out;
}

describe('extractPalette', () => {
  it('흰 배경·투명·검은 선을 무시하고 빈도순으로 색을 뽑는다', () => {
    const px = image([
      [255, 255, 255, 255, 500], // 배경
      [0, 0, 0, 0, 200], // 투명
      [5, 5, 5, 255, 80], // 선화
      [220, 30, 30, 255, 300], // 빨강 (최다)
      [30, 60, 220, 255, 150], // 파랑
    ]);
    const pal = extractPalette(px, { k: 2 });
    expect(pal).toHaveLength(2);
    expect(pal[0]).toBe('#dc1e1e');
    expect(pal[1]).toBe('#1e3cdc');
  });

  it('유효 픽셀이 없으면 빈 배열', () => {
    expect(extractPalette(image([[255, 255, 255, 255, 50]]))).toEqual([]);
  });

  it('검은 픽셀뿐이면 검정을 포함한다', () => {
    expect(extractPalette(image([[10, 10, 10, 255, 40]]), { k: 1 })).toEqual(['#0a0a0a']);
  });

  it('결정적이다', () => {
    const px = image([[200, 100, 50, 255, 64], [20, 200, 90, 255, 64], [90, 20, 200, 255, 32]]);
    expect(extractPalette(px)).toEqual(extractPalette(px));
  });
});

describe('toBoxerPalette', () => {
  it('항상 4색', () => {
    expect(toBoxerPalette([])).toHaveLength(4);
    expect(toBoxerPalette(['#112233'])).toHaveLength(4);
    expect(toBoxerPalette(['#1', '#2', '#3', '#4', '#5'].map(() => '#abcdef'))).toHaveLength(4);
  });
  it('shade는 범위 안 hex', () => {
    expect(shade('#808080', 1)).toBe('#ffffff');
    expect(shade('#808080', -1)).toBe('#000000');
  });
});

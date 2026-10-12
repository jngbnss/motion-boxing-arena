// 업로드 이미지 검증: 매직 바이트로 실제 타입을 판별하고 헤더에서 해상도를 읽는다 (외부 의존성 없음).

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageInfo {
  contentType: ImageType;
  ext: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

function png(buf: Buffer): ImageInfo | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { contentType: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpeg(buf: Buffer): ImageInfo | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    // 채움 바이트
    if (marker === 0xff) {
      i++;
      continue;
    }
    // 길이 없는 마커 (RSTn, TEM)
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOFn (DHT C4, JPG C8, DAC CC 제외)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { contentType: 'image/jpeg', ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    // SOS 이후에는 엔트로피 코딩 데이터: SOF를 못 찾은 것
    if (marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

function webp(buf: Buffer): ImageInfo | null {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return { contentType: 'image/webp', ext: 'webp', width, height };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { contentType: 'image/webp', ext: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { contentType: 'image/webp', ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** PNG/JPEG/WebP가 아니거나 헤더가 깨졌으면 null */
export function sniffImage(buf: Buffer): ImageInfo | null {
  const info = png(buf) ?? jpeg(buf) ?? webp(buf);
  if (!info || info.width <= 0 || info.height <= 0) return null;
  return info;
}

/** glTF 2.0 바이너리(GLB) 구조 검사: 헤더 매직·버전·길이, 첫 청크가 JSON이고 asset.version이 2.x */
export function isValidGlb(buf: Buffer): boolean {
  if (buf.length < 20) return false;
  if (buf.readUInt32LE(0) !== 0x46546c67 /* 'glTF' */ || buf.readUInt32LE(4) !== 2) return false;
  if (buf.readUInt32LE(8) !== buf.length) return false;
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a /* 'JSON' */ || 20 + jsonLen > buf.length) return false;
  try {
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)) as { asset?: { version?: unknown } };
    return typeof json.asset?.version === 'string' && json.asset.version.startsWith('2.');
  } catch {
    return false;
  }
}

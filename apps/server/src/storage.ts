// 로컬 파일 오브젝트 스토리지: `${DATA_DIR}/files/<key>`, 공개 URL `${PUBLIC_BASE_URL}/files/<key>` (레이아웃: docs/09 §6)
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

/** 키 형식: 슬래시로 구분한 세그먼트, 각 세그먼트는 [A-Za-z0-9_.-]+ 이고 `.`/`..`가 아니다 */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function isValidKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  return key.split('/').every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
}

export class SizeLimitError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`payload exceeds ${limit} bytes`);
    this.limit = limit;
  }
}

export class FileStorage {
  readonly root: string;
  private readonly publicBaseUrl: string;

  constructor(root: string, publicBaseUrl: string) {
    this.root = resolve(root);
    this.publicBaseUrl = publicBaseUrl;
  }

  /** 키 → 절대 경로. 루트 밖을 가리키면 예외 */
  pathOf(key: string): string {
    if (!isValidKey(key)) throw new Error(`invalid storage key: ${key}`);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error(`storage key escapes root: ${key}`);
    return p;
  }

  urlOf(key: string): string {
    return `${this.publicBaseUrl}/files/${key}`;
  }

  async put(key: string, data: Uint8Array | string): Promise<void> {
    const p = this.pathOf(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p);
  }

  /** 스트림을 기록한다. maxBytes 초과 시 SizeLimitError, 부분 파일은 지운다. 기록 바이트 수 반환 */
  async putStream(key: string, source: Readable, maxBytes: number): Promise<number> {
    const p = this.pathOf(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    let total = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > maxBytes) cb(new SizeLimitError(maxBytes));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(source, limiter, createWriteStream(tmp));
      await rename(tmp, p);
      return total;
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }

  openRead(key: string): Readable {
    return createReadStream(this.pathOf(key));
  }

  /** 파일 크기. 없으면 null */
  async size(key: string): Promise<number | null> {
    try {
      const s = await stat(this.pathOf(key));
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    const to = this.pathOf(toKey);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(this.pathOf(fromKey), to);
  }
}

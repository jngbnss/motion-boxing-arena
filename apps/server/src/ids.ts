// 접두어 + ULID (48비트 ms 타임스탬프 + 80비트 난수, Crockford base32 26자). 시간순 정렬된다.
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type IdPrefix = 'usr' | 'upl' | 'chr' | 'job' | 'mat' | 'ast';

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  // 80비트 = 16자 × 5비트
  let rand = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD[(acc >> bits) & 31]!;
    }
    acc &= (1 << bits) - 1;
  }
  return time + rand;
}

export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

/** 룸 코드: 대문자+숫자 6자, 혼동 문자 0 O 1 I 제외 (docs/07 §4.1) */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function roomCode(): string {
  const bytes = randomBytes(6);
  let code = '';
  for (const b of bytes) code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]!;
  return code;
}

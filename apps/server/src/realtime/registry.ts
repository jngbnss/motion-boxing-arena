// 룸 코드 → roomId 조회표 (단일 프로세스). GET /rooms/:code와 매니페스트 열람 권한(같은 룸 상대)에 쓴다.
import { roomCode } from '../ids.ts';

interface Entry {
  roomId: string;
  userIds: string[];
}

export class RoomRegistry {
  private readonly byCode = new Map<string, Entry>();

  /** 사용 중이지 않은 코드를 발급해 roomId에 연결한다 */
  allocate(roomId: string): string {
    for (;;) {
      const code = roomCode();
      if (this.byCode.has(code)) continue;
      this.byCode.set(code, { roomId, userIds: [] });
      return code;
    }
  }

  setPlayers(code: string, userIds: string[]): void {
    const e = this.byCode.get(code);
    if (e) e.userIds = [...userIds];
  }

  release(code: string): void {
    this.byCode.delete(code);
  }

  lookup(code: string): { roomId: string; playerCount: number } | null {
    const e = this.byCode.get(code.toUpperCase());
    return e ? { roomId: e.roomId, playerCount: e.userIds.length } : null;
  }

  /** 두 사용자가 지금 같은 룸에 있는가 (상대 캐릭터 매니페스트 열람 허용, docs/08 §2.6) */
  sharesRoom(a: string, b: string): boolean {
    for (const e of this.byCode.values()) {
      if (e.userIds.includes(a) && e.userIds.includes(b)) return true;
    }
    return false;
  }
}

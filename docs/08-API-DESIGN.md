# 08. API 및 이벤트 설계

> 상태: 설계 (미구현). 기준: `docs/designs/motion-boxing-arena.md`의 C2, C5, C7, C9.
> 스키마 원본은 `packages/shared`의 zod 정의다. 이 문서의 TypeScript 표기는 그 스키마를 설명용으로 옮긴 것이다.

---

## 1. 공통 규약

| 항목 | 규약 |
|---|---|
| Base URL | `https://<api-host>/api/v1` |
| 인증 | `Authorization: Bearer <guestToken>` (POST /sessions/guest로 발급, HMAC 서명, 30일 만료) |
| 콘텐츠 | `application/json` (업로드 제외) |
| 시간 | ISO 8601 UTC 문자열, 실시간 이벤트는 epoch ms |
| ID | ULID 문자열 (`chr_...`, `job_...`, `mat_...` 접두어) |
| 중복 방지 | 상태 변경 POST는 `Idempotency-Key` 헤더 지원(24시간 보관) |
| 오류 포맷 | `{ "error": { "code": "STRING_CODE", "message": "사람이 읽는 설명", "retryable": boolean, "details"?: object } }` |

### 공통 오류 코드
| HTTP | code | retryable | 의미 |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | false | 스키마 위반 |
| 401 | `UNAUTHORIZED` | false | 토큰 없음·만료 |
| 403 | `FORBIDDEN` | false | 소유자 아님 |
| 404 | `NOT_FOUND` | false | |
| 409 | `CONFLICT` | false | 상태 충돌(예: 생성 중 캐릭터 선택) |
| 413 | `PAYLOAD_TOO_LARGE` | false | 10MB 초과 |
| 429 | `RATE_LIMITED` | true | `Retry-After` 헤더 포함 |
| 503 | `QUEUE_FULL` | true | 전역 생성 큐 상한 |
| 500 | `INTERNAL` | true | |

---

## 2. HTTP API — MVP

### 2.1 `POST /sessions/guest` — 게스트 세션 발급
- 요청: `{ nickname: string(2..16, 한글/영문/숫자/_) }`
- 응답 201: `{ userId: "usr_...", token: "...", expiresAt }`
- 검증: 닉네임 금칙어 필터(간단 목록). 중복 닉네임 허용(표시용).
- 권한: 없음. IP당 분당 10회 제한.
- 중복: 같은 브라우저는 localStorage 토큰을 재사용하므로 재발급하지 않는다.

### 2.2 `POST /uploads` — 이미지 업로드 (presigned URL 방식)
1단계, 업로드 URL 요청:
- 요청: `{ filename, contentType: "image/png"|"image/jpeg"|"image/webp", sizeBytes: number(≤10_485_760), sha256: hex64, rightsAttested: true }`
- 응답 201: `{ uploadId: "upl_...", putUrl, expiresIn: 300 }` / 이미 같은 sha256이 있으면 200 `{ uploadId, alreadyExists: true }`
- 검증: `rightsAttested`가 `true`가 아니면 400 `RIGHTS_NOT_ATTESTED`. 크기·타입 사전 검증.

2단계, 클라이언트가 `putUrl`로 S3 호환 스토리지(MinIO/R2)에 직접 PUT.

3단계, `POST /uploads/:id/complete`:
- 서버가 객체를 HEAD·다운로드해 **실제** 타입(매직 바이트), 해상도 ≥ 512px(짧은 변), sha256 일치를 검증한다.
- 응답 200: `{ uploadId, width, height, status: "VERIFIED" }` / 실패 400 `IMAGE_INVALID { reason: "TOO_SMALL"|"BAD_TYPE"|"HASH_MISMATCH" }`
- 성능: presigned 방식이라 API 서버가 대용량 바이트를 중계하지 않는다.
- 대안: 개발 편의를 위해 `multipart/form-data` 직접 업로드 엔드포인트를 dev 전용으로 둔다.

### 2.3 `POST /characters/generate` — 3D 생성 작업 요청
- 헤더: `Idempotency-Key: <uuid>` (필수)
- 요청: `{ uploadId, name: string(1..20), options?: { preferTier?: "T2"|"T1"|"T0", seed?: number } }`
- 응답 202: `{ jobId: "job_...", characterId: "chr_...", status: "QUEUED", queuePosition: number, estimatedSeconds: number }`
- 검증: 업로드가 VERIFIED이고 본인 소유여야 함.
- 중복 처리:
  - 같은 Idempotency-Key → 최초 응답 그대로 반환.
  - 같은 사용자 + 같은 이미지 sha256 + 같은 옵션으로 진행 중/완료된 작업이 있으면 그 작업을 반환(200, `deduplicated: true`).
- 제한: 게스트당 **하루 3회**(429), 전역 큐 대기 20개 초과 시 503 `QUEUE_FULL`. 이 경우 클라이언트는 즉시 **T0 스킨 모드**를 제안한다.
- 권한: 본인 업로드만.

### 2.4 `GET /jobs/:id` — 작업 상태 조회
- 응답 200:
```json
{
  "jobId": "job_01J...",
  "characterId": "chr_01J...",
  "status": "RIGGING",
  "stage": { "name": "RIGGING", "attempt": 1, "startedAt": "..." },
  "progress": 0.62,
  "queuePosition": 0,
  "tier": null,
  "error": null,
  "updatedAt": "..."
}
```
- 실패 시 `status: "FAILED"`, `error: { stage: "GENERATING", code: "MESH_EMPTY", retryable: true, message }`.
- MVP는 **2초 폴링**(대기 중 5초). SSE(`GET /jobs/:id/events`)는 확장이다. 폴링을 고른 이유는 프록시·재접속 처리가 단순하고 작업당 요청 수가 적기 때문이다(3분 기준 약 90회).
- 성능: 인덱스 조회 1회, `ETag`/`If-None-Match`로 304 응답.
- retryable 실패는 워커가 **1회 자동 재시도**한다. 그 뒤에는 사용자가 `POST /jobs/:id/retry`로 실패 단계부터 재시작한다. 하루 3회 생성 제한에는 포함하지 않는다(단, 수동 재시도는 작업당 2회).
- 타임아웃: 단계별 상한과 전체 10분(결정 기록 C13). QUEUED 대기 시간은 전체 10분에 포함하지 않고, 응답에 `queuePosition`을 준다.
- 외부 처리 동의(`externalProcessingConsent`)를 거부하면 로컬 GPU 워커가 있을 때만 큐에 넣고, 없으면 422 `EXTERNAL_CONSENT_REQUIRED`를 반환한다. 클라이언트는 이미 만든 T0 스킨을 유지한다.

### 2.5 `GET /characters` — 캐릭터 목록
- 쿼리: `scope=mine|builtin` (기본 둘 다), `cursor`, `limit ≤ 50`
- 응답: `{ items: CharacterSummary[], nextCursor }`
- `CharacterSummary = { id, name, tier, thumbnailUrl, status: "GENERATING"|"READY"|"FAILED", builtin: boolean }`

### 2.6 `GET /characters/:id` — 캐릭터 상세 (매니페스트)
- 응답: C5 `CharacterManifest` (09-DATA-MODEL 예시 참조). `glbUrl`은 CDN 공개 URL 또는 서명 URL(만료 1시간).
- 권한: `visibility=private`이면 소유자만. 단 **경기 상대는 열람 가능**: 서버가 룸 참가 시 상대 캐릭터에 대한 단기 서명 URL을 발급한다.
- 캐시: 매니페스트는 불변 버전(`manifestVersion`)이라 `Cache-Control: max-age=3600`.

### 2.7 `POST /me/selected-character`
- 요청: `{ characterId }`
- 응답 200: `{ characterId }`
- 검증: READY 상태이고 본인 소유이거나 builtin이어야 함. 생성 중이면 409 `CHARACTER_NOT_READY`.
- 멱등: 같은 값 재요청은 그대로 200.

### 2.8 `GET /matches/:id` — 경기 결과
- 응답: `{ matchId, mode: "ai"|"online", result: "KO"|"TIME_UP"|"FORFEIT"|"ABANDONED", winnerUserId?, durationMs, players: [{ userId, nickname, characterId, hpEnd, stats: { punches, hits, blocked, dodgesAttempted, dodgesSucceeded, accuracy, dodgeRate } }], createdAt }`
- 권한: 참가자만.

### 2.9 `GET /me/matches` — 내 경기 기록
- 쿼리: `cursor`, `limit ≤ 20`. 응답: `{ items: MatchSummary[], nextCursor }`.

### 2.10 `POST /matches` — AI 대전 결과 저장 (싱글)
- AI 대전은 클라이언트 로컬 판정이라 결과를 클라이언트가 보고한다. 요청: `{ difficulty, result, durationMs, stats }`, `Idempotency-Key` 필수.
- 신뢰 수준이 낮으므로 `mode: "ai"` 기록은 랭킹(확장)에 쓰지 않는다.

### 2.11 `GET /rooms/:code` — 룸 코드 → roomId
- 응답: `{ roomId, playerCount }` / 없으면 404 `ROOM_NOT_FOUND`, 가득 차면 409 `ROOM_FULL`.

### 2.12 `GET /health`, `GET /config`
- `/config`: 클라이언트 런타임 설정(모델 URL, 기능 플래그 `features.generation`, `features.online`). 시연 중 기능을 서버에서 끌 수 있다.

---

## 3. HTTP API — 확장 (MVP 범위 밖)

| API | 목적 |
|---|---|
| `GET /jobs/:id/events` (SSE) | 폴링 대체 |
| `GET /gallery`, `PATCH /characters/:id {visibility}` | 공개 갤러리 |
| `POST /reports` | 부적절 캐릭터·저작권 신고 |
| `DELETE /me` | 내 데이터 전체 삭제(업로드, 캐릭터, 녹화, 경기 익명화) |
| `GET /rankings` | 온라인 랭킹 (부정행위 대책 선행 필요) |
| `POST /motion-recordings` | 학습 데이터 기여(opt-in, 랜드마크만) — 팀 내부 수집 도구에서는 MVP 중 사용 |
| `POST /auth/*` | 정식 회원가입/로그인 |

---

## 4. 실시간 이벤트 (Colyseus `duel` 룸)

### 4.1 공통
- 연결 옵션(join options): `{ token, characterId, nickname }`. `onAuth`에서 토큰 검증, 캐릭터 READY 확인.
- 모든 클라→서버 메시지는 zod 검증. 실패 시 무시 + `error` 메시지(`{ code, message }`) 회신, 초당 20회 이상 실패하면 연결 종료.
- 상태(Schema)는 자동 패치. 아래 "이벤트"는 일회성 `broadcast/send` 메시지다.

### 4.2 클라이언트 → 서버

| 이벤트 | 스키마 | 검증 | 실패 처리 | 중복 | 성능 |
|---|---|---|---|---|---|
| `time:ping` | `{ clientTime: number }` | 숫자 | 무시 | N/A | 입장 시 5회, 이후 10초마다 |
| `calib:done` | `{ quality: number(0..1), profileHash: string(≤64) }` | phase ∈ CALIBRATING/READY | `error PHASE_INVALID` | 마지막 값 덮어쓰기 | 1회 |
| `room:ready` | `{ ready: boolean }` | calibrated == true | `error NOT_CALIBRATED` | 토글, 멱등 | 1회 |
| `input:pose` | `{ headX: number(-1..1), headY: number(-1..1), guard: number(0..1), t: number }` | phase == FIGHTING, 범위, 시각 ±1s | 조용히 무시(카운트) | `t` 역행 샘플 폐기 | 20Hz, 약 20B |
| `input:strike` | `{ kind:'strike', type:'jab'|'straight', hand:'lead'|'rear', t, confidence(0..1), seq: int }` | phase, 쿨다운, 경직, 초당 4회, seq 단조, 시각 ±1s, pose 생존 | 거부 시 `strike:rejected { seq, reason }` (클라이언트 예측 애니메이션 취소용) | seq ≤ lastSeq 폐기 | 이벤트당 약 40B |
| `player:character` | `{ characterId: string }` | phase ∈ RESULT/CALIBRATING(READY 이전), READY 상태 캐릭터, 본인 소유 또는 builtin | `error CHARACTER_NOT_READY` / `PHASE_INVALID` | 마지막 값 덮어쓰기 | `match:rematch` 전에 1회 |
| `match:rematch` | `{}` | phase == RESULT | 무시 | 멱등 | 1회 |
| `match:forfeit` | `{}` | phase ∈ FIGHTING/PAUSED | 무시 | 멱등 | 1회 |

- MVP의 `type`은 `jab`, `straight`만 허용한다. `hook`, `uppercut`은 스키마에 정의만 하고 서버가 `TYPE_DISABLED`로 거부한다(확장 시 플래그로 활성화).

### 4.3 서버 → 클라이언트

| 이벤트 | 스키마 | 비고 |
|---|---|---|
| `time:pong` | `{ clientTime, serverTime }` | 오프셋 계산 |
| `match:countdown` | `{ startAt: number, reason: "start"|"resume" }` | |
| `match:paused` | `{ reason: "DISCONNECT"|"TRACKING_LOST"|"NETWORK", player: sessionId, resumeDeadline: number, pauseBudgetLeftMs: number }` | 추적 손실 누적 예산 30초(결정 기록 C12) |
| `match:resumed` | `{ countdownStartAt: number }` | 3초 카운트다운 후 FIGHTING |
| `match:start` | `{ startedAt, durationMs: 90000 }` | |
| `combat:strike_start` | `{ attacker: sessionId, type, hand, seq, activeAt }` | 상대 클립 재생 트리거 |
| `strike:rejected` | `{ seq, reason: "COOLDOWN"|"STUNNED"|"RATE"|"PHASE"|"STALE" }` | 공격자에게만 |
| `combat:hit` | `{ attacker, target, zone: "head"|"body", damage, hpAfter, stunUntil, seq }` | |
| `combat:blocked` | `{ attacker, target, chip, hpAfter, seq }` | |
| `combat:dodged` | `{ attacker, target, direction: "slip_left"|"slip_right"|"duck", seq }` | 회피 성공 연출 |
| `match:paused` | `{ reason: "DISCONNECT"|"NETWORK", resumeDeadline }` | |
| `match:end` | `{ result, winner?: sessionId, stats: Record<sessionId, MatchStats>, matchId }` | |
| `error` | `{ code, message }` | |

### 4.4 상태 스키마 (Colyseus Schema)
```ts
class PlayerState extends Schema {
  @type('string') userId; @type('string') nickname; @type('string') characterId;
  @type('boolean') connected; @type('boolean') ready; @type('boolean') calibrated;
  @type('uint8') hp;                     // 0..100
  @type('string') action;                // 'idle' | 'jab_lead' | 'straight_rear' | 'guard' | 'hit_head' | ...
  @type('number') actionStartedAt; @type('number') stunUntil;
  @type('float32') headX; @type('float32') headY; @type('float32') guard;   // 보간용 최신값
}
class DuelState extends Schema {
  @type('string') phase;                 // C8
  @type('number') phaseEndsAt;
  @type({ map: PlayerState }) players;
  @type('string') code;
}
```

### 4.5 요구사항 예시 이벤트 이름과의 대응

| 요구사항 예시 | 이 설계 | 변경 이유 |
|---|---|---|
| `room:create` / `room:join` | Colyseus `create` / `joinById` + REST `GET /rooms/:code` | 프레임워크 내장 기능 사용 |
| `player:ready` | `room:ready` + `calib:done` | 준비와 캘리브레이션 분리 |
| `match:start` | `match:countdown` + `match:start` | 동기화된 시작 시각 전달 |
| `player:action` | `input:strike` | "입력 요청"임을 이름에 드러냄 |
| `player:state` | `input:pose` + Schema 패치 | 송신(입력)과 동기화(상태) 분리 |
| `combat:hit` / `combat:dodge` | `combat:hit` / `combat:dodged` / `combat:blocked` | 결과 3종 명시 |
| `match:end` | `match:end` | 동일 |

---

## 5. 속도 제한 요약

| 대상 | 제한 |
|---|---|
| 게스트 발급 | IP당 10회/분 |
| 업로드 URL | 사용자당 20회/시간 |
| 생성 요청 | 사용자당 3회/일, 전역 대기열 20 |
| 작업 재시도 | 작업당 2회 |
| 상태 폴링 | 사용자당 60회/분 (초과 시 429, 클라이언트는 백오프) |
| 실시간 strike | 초당 4회(게임 규칙), 위반은 무시 |
| 실시간 검증 실패 | 초당 20회 초과 시 연결 종료 |

구현: 단일 서버 프로세스이므로 MVP는 인메모리 토큰 버킷을 쓰고, 일일 생성 횟수만 Postgres(`ai_jobs` 카운트)로 확인한다. 다중 인스턴스가 필요해지면 Redis로 옮긴다(확장).

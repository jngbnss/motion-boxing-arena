# 03. 기술 스택 (Tech Stack)

> 기준 문서: [designs/motion-boxing-arena.md](designs/motion-boxing-arena.md)
> 버전·라이선스 확인일: **2026-10-12**. "확인 필요"나 "추정"이 붙은 항목은 공식 원문을 아직 확인하지 않은 내용이다. 개발 시작 전에 확인해야 한다.
> 이 문서는 선정 결과를 다룬다. 아직 구현된 것은 없다.

---

## 1. 최종 선정 스택 요약

| 계층 | 선택 | 대안(탈락 이유) |
|---|---|---|
| 빌드 | Vite 8 + TypeScript | Webpack(설정 비용), Next.js(SSR 불필요) |
| UI 셸 | React 19 (화면·HUD·폼) | Vue/Svelte(팀 경험 기준 React 우위, 추정) |
| 3D 렌더 | Three.js r186 (명령형 게임 코어) | react-three-fiber(게임 루프가 React 렌더에 묶임), Babylon.js(팀 학습 비용) |
| 물리/판정 | 자체 해석적 충돌(`packages/combat`) + Rapier 0.21(연출 전용, 선택) | Rapier 기반 판정(비결정성·서버 WASM 부담), cannon-es(유지보수 저조, 추정) |
| 모션 인식 | @mediapipe/tasks-vision 1.1.0, Pose Landmarker lite/full | TF.js MoveNet(손 랜드마크 부족), OpenPose(서버 필요) |
| 실시간 | Colyseus 0.18 + @colyseus/sdk 0.18 | Socket.IO 4.8(룸·상태 동기화 직접 구현), raw ws(전부 직접 구현) |
| REST | Fastify (Node.js + TS, Colyseus와 같은 프로세스) | Spring Boot(언어 분리, 타입 공유 불가) |
| DB | PostgreSQL + Drizzle ORM | MySQL(SKIP LOCKED 큐 활용은 Postgres가 표준적), MongoDB(관계 데이터) |
| 큐 | Postgres 테이블 + `FOR UPDATE SKIP LOCKED` | Redis+BullMQ/Celery(인프라 추가) |
| 오브젝트 스토리지 | dev MinIO / prod Cloudflare R2 (S3 호환) | AWS S3(송신료), 로컬 디스크(배포 불가) |
| AI 워커 | Python 3.11, PyTorch, rembg/BiRefNet, 이미지→3D(PoC로 선정), trimesh/pymeshlab | Node에서 ONNX 실행(모델 지원 부족) |
| 3D 도구 | Blender 5.x 헤드리스 별도 프로세스(bpy 스크립트) | Blender를 앱에 임베드(GPL 전파 위험) |
| 에셋 포맷 | glTF 2.0 / GLB (+ meshopt 또는 Draco, 선택적 KTX2) | FBX(브라우저 직접 로드 불리), OBJ(스켈레톤 없음) |
| 배포 | 프론트: GitHub Pages 또는 Cloudflare Pages / 서버: 상시 VM 1대 / GPU: 팀 GPU 또는 RunPod 시간제 | Render 무료(15분 유휴 시 슬립 → 시연 부적합) |

---

## 2. 버전 표 (2026-10-12 확인)

| 패키지 | 버전 | 라이선스 | 출처 | 상태 |
|---|---|---|---|---|
| three | 0.186.1 | MIT | https://www.npmjs.com/package/three | 확인 |
| @mediapipe/tasks-vision | 1.1.0 | Apache-2.0 | https://www.npmjs.com/package/@mediapipe/tasks-vision | 확인 |
| @dimforge/rapier3d-compat | 0.21.0 | Apache-2.0 | https://www.npmjs.com/package/@dimforge/rapier3d-compat | 확인 |
| colyseus (서버) | 0.18.9 | MIT | https://www.npmjs.com/package/colyseus | 확인 |
| @colyseus/sdk (클라이언트) | 0.18.5 | MIT | https://www.npmjs.com/package/@colyseus/sdk | 확인. 구 `colyseus.js`는 0.16.22에서 중단됨. **신규 코드는 `@colyseus/sdk` 사용** |
| socket.io (대안) | 4.8.4 | MIT | https://www.npmjs.com/package/socket.io | 확인 |
| vite | 8.3.4 | MIT | https://www.npmjs.com/package/vite | 확인 |
| react | 19.3.0 | MIT | https://www.npmjs.com/package/react | 확인 |
| bpy (Blender as module) | 5.2.2 (Python 3.13 전용) | GPL-3.0 | https://pypi.org/project/bpy/ | 확인. Blender 본체 최신 번호는 확인 필요 |
| fastify | 확인 필요 | MIT (확인 필요) | https://www.npmjs.com/package/fastify | 확인 필요 |
| drizzle-orm | 확인 필요 | Apache-2.0 (확인 필요) | https://www.npmjs.com/package/drizzle-orm | 확인 필요 |
| @pixiv/three-vrm (확장용) | 확인 필요 | MIT | https://github.com/pixiv/three-vrm | 라이선스 확인, 버전 확인 필요 |

> W1 Day1에 `package.json`에서 위 버전을 **정확히 고정**한다(`^` 금지, lockfile 커밋). Colyseus는 0.16→0.18 사이에 클라이언트 패키지명이 바뀌었으므로 블로그·예제 코드를 그대로 쓰지 않는다.

---

## 3. 후보별 9개 질문 분석

질문 번호: ① 왜 쓰는가 ② 대안 ③ 학습·개발 난이도 ④ GPU 필요 여부 ⑤ 브라우저 직접 실행 ⑥ 서버 필수 여부 ⑦ 라이선스 적합성 ⑧ 예상 병목 ⑨ 유지보수·확장성

### 3.1 프론트엔드 기반

| | Vite | TypeScript | React | Three.js |
|---|---|---|---|---|
| ① | 빠른 HMR, WASM·워커·정적 에셋 처리가 기본 지원 | 클라·서버·combat·motion 패키지가 **같은 타입**을 공유 | 로비·생성·설정 등 폼이 많은 화면 | WebGL 3D 표준, glTF 로더·스킨드 메쉬·애니메이션 믹서 내장 |
| ② | Webpack, Parcel | JS + JSDoc | Vue, Svelte, 바닐라 DOM | Babylon.js, PlayCanvas |
| ③ | 낮음 | 낮음~중간 | 낮음(경험자 기준) | 중간(스키닝·애니메이션 블렌딩은 중상) |
| ④ | 없음 | 없음 | 없음 | 클라이언트 GPU(WebGL2) 필요. 내장 GPU로 충분하게 설계 |
| ⑤ | 빌드 도구 | 컴파일 | 예 | 예 |
| ⑥ | 아니오 | 아니오 | 아니오 | 아니오 |
| ⑦ | MIT | Apache-2.0 | MIT | MIT |
| ⑧ | 없음 | 없음 | React 리렌더가 게임 루프에 섞이면 프레임 드롭 → **게임 루프는 React 밖에서 `requestAnimationFrame`로 실행**, HUD는 구독 기반으로 저빈도 갱신 | 드로우콜, 스킨드 메쉬 2개 + 경기장. 텍스처 메모리 |
| ⑨ | 높음 | 높음 | 높음 | 높음. 단 r 버전 간 API 변화가 있어 버전 고정 |

**결정:** React는 UI 셸 전용으로 쓴다. 게임 화면은 `<canvas>` 하나를 React가 마운트하고 `GameEngine` 클래스(명령형)가 소유한다. react-three-fiber는 쓰지 않는다. 이유는 두 가지다. 매 프레임 상태(포즈·전투)를 React 상태로 흘리면 GC와 리렌더 비용이 생긴다. 그리고 팀원 일부가 Three.js를 처음 다루는데 학습 대상을 하나로 줄이는 편이 낫다.

### 3.2 물리: Rapier

| ① | KO 래그돌, 링 로프 반동, 타격 시 소품 흔들림 같은 **연출** |
|---|---|
| ② | cannon-es, ammo.js, 자체 구현 |
| ③ | 중간(WASM 초기화, 좌표계 동기화) |
| ④ | 없음(CPU) |
| ⑤ | 예(`rapier3d-compat`는 WASM을 base64로 내장) |
| ⑥ | 아니오. 서버 판정에는 쓰지 않는다 |
| ⑦ | Apache-2.0 |
| ⑧ | 래그돌 바디 수가 늘면 CPU 부하. 2인 대전이면 문제 없음(추정) |
| ⑨ | 높음 |

**결정:** 타격 판정은 Rapier가 아니라 `packages/combat`의 해석적 구-캡슐 교차로 한다(상세: [06-COMBAT-SYSTEM.md](06-COMBAT-SYSTEM.md)). 근거는 셋이다. 결정적이라 서버와 클라가 같은 결과를 낸다. Node 서버에 WASM이 필요 없다. 단위 테스트가 쉽다. Rapier는 MVP 4 이후 연출용 선택 기능이다.

### 3.3 모션 인식: MediaPipe

| | Pose Landmarker | Hand Landmarker | Face Landmarker |
|---|---|---|---|
| ① | 33개 신체 랜드마크(어깨·팔꿈치·손목·손 끝점 일부·코·귀). 펀치·가드·회피에 충분 | 손가락 21점. 주먹 쥠 판별 | 478점 얼굴 메쉬, 머리 회전 정밀 추정 |
| ② | TF.js MoveNet/BlazePose, ml5.js | — | — |
| ③ | 낮음(API 단순). 동작 분류는 중상 | 낮음 | 낮음 |
| ④ | 클라이언트 GPU 권장(GPU delegate, WebGL 기반 — 지원 여부 **확인 필요**). CPU 폴백 가능 | 동일 | 동일 |
| ⑤ | 예(WASM + WebGL) | 예 | 예 |
| ⑥ | 아니오. **영상은 브라우저 밖으로 나가지 않는다** | 아니오 | 아니오 |
| ⑦ | 라이브러리 Apache-2.0. 모델은 Google 모델 카드 조건이 별도로 있을 수 있음(**확인 필요**) | 동일 | 동일 |
| ⑧ | 모델 크기·추론 시간. lite 우선 | 모델 추가 시 프레임당 추론 시간 증가 | 동일 |
| ⑨ | 높음(Google 유지) | 높음 | 높음 |

**모델 파일 크기 (float16, 2026-10-12 Google 버킷에서 실측):**

| 모델 | 크기 | MVP 사용 |
|---|---|---|
| pose_landmarker_lite | 5.78 MB | **기본값** |
| pose_landmarker_full | 9.40 MB | 설정에서 선택(고사양) |
| pose_landmarker_heavy | 30.66 MB | 사용 안 함 |
| hand_landmarker | 7.82 MB | MVP 제외(확장: 주먹 쥠 확인) |
| face_landmarker | 3.76 MB | MVP 제외(확장: 머리 회전) |

출처: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_{lite,full,heavy}/float16/latest/*.task`, https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker

**결정:** MVP에는 Pose lite 하나만 쓴다. 정면으로 뻗는 펀치는 2D에서 팔이 짧아 보이므로 깊이 단서가 필요하다. 이 단서는 Hand Landmarker를 추가하지 않고 Pose 모델의 손 점(15~22번: 손목·새끼·검지·엄지)이 만드는 **겉보기 손 크기 변화**로 근사한다. 상세: [05-MOTION-RECOGNITION.md](05-MOTION-RECOGNITION.md).

### 3.4 AI 2D→3D 모델

| | 오픈 모델 자체 호스팅 (TRELLIS.2 / TRELLIS / SPAR3D / TripoSR) | 상용 API (Meshy) |
|---|---|---|
| ① | 파이프라인 전체를 통제하고 측정할 수 있다. 개선 전후를 AI 엔지니어링 성과로 보여줄 수 있다 | GPU 없이 바로 쓸 수 있다. 리깅·애니메이션 API 포함 |
| ② | Hunyuan3D 2.x(**지역 제한으로 사용 불가**) | Tripo API(리깅·애니메이션 존재, 가격 확인 필요) |
| ③ | 중상(CUDA 의존성 빌드가 가장 큰 장벽) | 낮음 |
| ④ | **필수.** TRELLIS.2 24GB 이상, TRELLIS v1 약 16GB(추정), TripoSR 약 6GB(추정), SPAR3D 명시 없음 | 없음 |
| ⑤ | 아니오 | 아니오 |
| ⑥ | 예(GPU 서버) | 예(API 키 보호를 위해 서버 경유) |
| ⑦ | 모델별 상이. [14-OPEN-SOURCE-LICENSES.md](14-OPEN-SOURCE-LICENSES.md) 참조 | 상용 약관(확인 필요) |
| ⑧ | GPU 메모리, 생성 시간, 콜드 스타트(모델 로딩) | 크레딧 비용, 외부 대기열 |
| ⑨ | 모델 교체가 잦은 분야라 `ImageTo3DBackend` 인터페이스로 추상화 | 벤더 종속 |

**결정:** 모델은 W1~W2 PoC 벤치마크로 고른다(상세: [04-AI-3D-PIPELINE.md](04-AI-3D-PIPELINE.md)). 워커는 `ImageTo3DBackend` 인터페이스 뒤에 백엔드를 꽂는 구조로 만들어 Meshy를 대체 백엔드로 유지한다.

### 3.5 3D 모델 처리: Blender, glTF

| | Blender (헤드리스) | glTF/GLB |
|---|---|---|
| ① | 메쉬 정리, 복셀 리메쉬, 자동 가중치, 리타겟, GLB 내보내기를 스크립트로 자동화 | 웹 3D 표준 전송 포맷, 스켈레톤·애니메이션·PBR 포함 |
| ② | trimesh/pymeshlab(정리는 가능, 리깅 불가), Maya(유료) | FBX, VRM(휴머노이드 확장) |
| ③ | 중상(bpy API) | 낮음 |
| ④ | 없음(CPU로 충분, 추정) | 없음 |
| ⑤ | 아니오 | 예(GLTFLoader) |
| ⑥ | 예(AI 워커 머신) | 아니오 |
| ⑦ | GPL-3.0. **별도 프로세스로 실행**하고 bpy 스크립트를 외부에 배포하지 않으면 앱 코드에 GPL이 전파되지 않는다는 해석이 일반적이다(법률 자문 아님, 확인 필요). 산출물은 사용자 소유("What you create with Blender is your sole property") | Khronos 공개 표준 |
| ⑧ | 프로세스 기동 2~5초(추정) → 워커 상주 프로세스로 재사용 | 텍스처 크기 → 1024px 상한, KTX2 선택 |
| ⑨ | 높음 | 높음 |

### 3.6 실시간 통신: Colyseus vs Socket.IO vs raw ws

| 기준 | Colyseus 0.18 | Socket.IO 4.8 | raw `ws` |
|---|---|---|---|
| 룸 생성·참가·코드 | 내장(matchmaker) | 직접 구현(rooms는 브로드캐스트 그룹 수준) | 직접 구현 |
| 상태 동기화 | Schema 델타 패치 내장 | 직접 구현 | 직접 구현 |
| 재접속 | `allowReconnection` 내장 | 연결 복구 일부 지원 | 직접 구현 |
| 서버 틱 루프 | `setSimulationInterval` 내장 | 직접 구현 | 직접 구현 |
| 타입 공유 | TS 서버·클라 | TS 가능 | TS 가능 |
| 난이도 | 중간(Schema 개념 학습) | 낮음 | 중간~높음 |
| 라이선스 | MIT | MIT | MIT |
| 병목 | 단일 프로세스 2인 룸 → 문제 없음 | 동일 | 동일 |

**결정:** Colyseus를 쓴다. 2인 대전에 필요한 룸·준비 상태·재접속·틱 루프가 이미 있어서 팀 시간을 판정 로직에 쓸 수 있다.

### 3.7 백엔드 언어: Node.js + TS vs Spring Boot

| 기준 | Node.js + TS | Spring Boot |
|---|---|---|
| 클라이언트와 타입·로직 공유 | **가능.** `packages/shared`(zod 스키마), `packages/combat`(판정)을 그대로 import | 불가. 판정 로직을 Java로 이중 구현해야 하고 불일치 위험이 생긴다 |
| 실시간 게임 서버 | Colyseus 사용 가능 | WebSocket(STOMP 등) 위에 룸·틱·동기화 직접 구현 |
| 팀 경험 | 프론트 인원에게 익숙 | SSAFY 커리큘럼상 백엔드 인원은 Spring에 익숙할 가능성이 높음(추정) |
| 학습 난이도 | 백엔드 인원에게 중간 | 낮음(경험자 기준) |

**결정:** 실시간 서버와 REST 모두 Node.js + TS 단일 프로세스(Colyseus + Fastify)로 간다. 핵심 이유는 싱글플레이(브라우저)와 멀티플레이(서버)가 **같은 `packages/combat` 코드로 판정**해야 판정 불일치 위험(13-RISKS R7)이 구조적으로 줄어든다는 점이다. Spring 경험자는 REST·DB·인증 영역을 맡아 Fastify/Drizzle로 옮기면 개념 전이가 크다. 확장 단계에서 랭킹·계정 같은 별도 서비스가 생기면 그 서비스를 Spring으로 분리하는 선택지는 열어둔다.

### 3.8 저장소: PostgreSQL, Redis, 오브젝트 스토리지

| | PostgreSQL | Redis | 오브젝트 스토리지 (MinIO / R2) |
|---|---|---|---|
| ① | 사용자·캐릭터·작업·경기 기록. 작업 큐 겸용(`SKIP LOCKED`) | 다중 서버 룸 프레즌스, 캐시 | 업로드 이미지, 단계별 중간 산출물, GLB, 썸네일 |
| ② | MySQL, SQLite | — | 로컬 디스크, S3 |
| ③ | 낮음 | 낮음 | 낮음(S3 SDK) |
| ④~⑤ | 없음 / 아니오 | 없음 / 아니오 | 없음 / 브라우저는 서명 URL로 직접 다운로드·업로드 |
| ⑥ | 예 | MVP에는 **불필요**(단일 Colyseus 프로세스) | 예 |
| ⑦ | PostgreSQL License | BSD/RSAL 등 버전별 변경 이력 있음(확인 필요) | MinIO AGPL-3.0(**개발 환경 전용**, 수정·배포하지 않음) / R2 상용 서비스 |
| ⑧ | 없음(소규모) | — | GLB 다운로드 시간 → CDN 캐시, 메쉬 압축 |
| ⑨ | 높음 | — | S3 호환 API라 교체 쉬움 |

Cloudflare R2 무료 등급(10GB-월 저장, Class A 100만/Class B 1000만 요청, 송신료 무료)은 **확인 필요**: https://developers.cloudflare.com/r2/pricing/

### 3.9 호스팅

| 옵션 | 용도 | 장점 | 제약 | 확인 상태 |
|---|---|---|---|---|
| GitHub Pages | 프론트 정적 | 무료, HTTPS, Actions 연동 | 정적 파일만. WebSocket 서버 불가. 커스텀 헤더 설정 불가(COOP/COEP 필요 시 문제, 추정) | 확인 필요 |
| Cloudflare Pages | 프론트 정적 | 무료, 대역폭 무제한, `_headers`로 헤더 지정 가능 | 무료 플랜 월 500 빌드 | 확인 필요 |
| 학교/팀 제공 VM | 게임 서버 + DB + REST | 상시 실행, 비용 없음 | 제공 여부 확인 필요 | 확인 필요 |
| Render 무료 | 서버 | WebSocket 지원 | **15분 유휴 시 슬립, 콜드 스타트 약 1분** → 시연에 부적합 | 확인 필요 |
| Fly.io | 서버 | 글로벌 리전 | 2024-10 이후 신규 조직 무료 할당 종료, 종량제 | 확인 필요 |
| Railway | 서버 | 배포 간편 | 1회 $5 체험 후 Hobby 약 $5/월 | 확인 필요 |
| RunPod | GPU 워커 | 시간제 과금 | 아래 가격은 확인 시점 기준 | 2026-10-12 확인 |

**권장 배포 구성:**
- 프론트: Cloudflare Pages(헤더 지정 가능). GitHub Pages도 동작한다.
- 게임 서버 + REST + Postgres: VM 1대에서 `docker compose`로 실행. 학교 VM이 없으면 Railway Hobby 또는 저가 VPS.
- AI 워커: 팀 GPU PC 또는 RunPod에서 시연 기간에만 실행. 시연 갤러리 캐릭터는 **미리 생성**해 둔다.

---

## 4. 웹캠 보안 컨텍스트 (HTTPS)

- `navigator.mediaDevices.getUserMedia`는 **보안 컨텍스트(HTTPS 또는 `localhost`)** 에서만 동작한다. 아니면 `navigator.mediaDevices`가 `undefined`다. https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- 로컬 개발: `localhost`는 허용된다. **같은 LAN의 다른 기기(시연용 두 번째 노트북)에서 `http://192.168.x.x`로 접속하면 카메라가 막힌다.** 대응은 두 가지다.
  - Vite `server.https` + `mkcert` 로컬 인증서
  - 또는 배포된 HTTPS 프론트에서 로컬 서버(`wss://`)로 접속
- 프론트를 HTTPS로 서비스하면 게임 서버도 `wss://`여야 한다(혼합 콘텐츠 차단). VM에 Caddy 리버스 프록시로 자동 TLS를 붙인다.

## 5. 초기 로딩 전략

| 리소스 | 크기(추정 포함) | 전략 |
|---|---|---|
| JS 번들(React + Three + 게임) | 약 1MB gzip 이하 목표(추정) | 경로별 코드 분할. 게임 화면 진입 시 Three.js 청크 로드 |
| MediaPipe WASM + pose lite | WASM 수 MB(확인 필요) + 5.78MB | **캐릭터 선택 화면에서 백그라운드 프리로드**. 웹캠 설정 화면에 도달할 때 준비 완료 |
| 경기장 GLB | 2MB 이하 목표 | meshopt 압축, 텍스처 1024 |
| 캐릭터 GLB | 1개당 3MB 이하 목표(15k tris, 1024 텍스처) | 선택 즉시 프리로드, CDN 캐시 |
| 애니메이션 클립 라이브러리 | 1MB 이하 목표 | 공통 스켈레톤이라 1회 로드 후 모든 캐릭터에 공유 |

- 모든 정적 에셋에 해시 파일명과 장기 캐시를 적용한다.
- MediaPipe 모델 파일은 Google CDN이 아니라 **자체 호스팅**한다(버전 고정, 시연장 네트워크 장애 대비). 오프라인 시연용으로 Service Worker 프리캐시를 둔다(MVP 4).

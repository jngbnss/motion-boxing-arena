# 00. 프로젝트 개요

> 상태: **MVP -1 ~ 3 구현**(2026-10-12). 실행 방법과 현황은 루트 README를 따른다.
> 모든 결정의 근거는 [`designs/motion-boxing-arena.md`](designs/motion-boxing-arena.md)(결정 기록)에 있다.

## 한 줄 요약

**"내가 만든 캐릭터가 내 움직임대로 싸우는 AI 모션 복싱 게임."**
웹캠으로 사용자의 실제 펀치·가드·회피를 인식하고, 사용자가 2D 이미지로 만든 3D 캐릭터로 AI 또는 다른 사용자와 1인칭 복싱을 하는 웹 게임.

## 무엇을 만드는가

| 구성 | 설명 | MVP 범위 |
|---|---|---|
| 1인칭 3D 복싱 | 브라우저 Three.js 경기장, 상대 캐릭터, 자기 글러브, HUD | 필수 |
| 웹캠 모션 인식 | MediaPipe Pose(브라우저 로컬) → 잽/스트레이트/가드/좌우 회피 이벤트 | 필수 |
| AI 상대 복서 | FSM 기반 게임 AI, Easy/Normal/Hard | 필수 |
| 온라인 1:1 대전 | Colyseus 룸, 서버 권한 판정 | 시연 범위 조정 가능 |
| 2D→3D 캐릭터 생성 | 이미지 → 3D 메쉬 → 공통 스켈레톤 바인딩 → GLB | 시연 범위 조정 가능 (T0 스킨 모드는 필수) |
| 홀로그램 출력 | 렌더 출력 인터페이스만 예약 | 범위 밖 |

## 핵심 시연 경로 (반드시 확보)

1. 캐릭터 선택
2. 웹캠으로 주먹 및 머리 인식
3. 1인칭 복싱
4. 상대 공격 회피
5. 타격 및 승패 판정

## 설계 원칙 8가지 (결정 기록의 Premises)

1. 핵심 시연 경로가 생명선. 2D→3D·온라인은 실패해도 시연이 성립해야 한다.
2. 모션 인식은 **행동 이벤트 생성기**다. 몸을 그대로 복제하지 않는다.
3. 타격 판정은 실제 팔 길이·거리와 무관한 **게임 규칙**이다. 히트 볼륨은 캐릭터 외형과 무관한 정규값.
4. 모든 캐릭터는 공통 스켈레톤 `mba-humanoid-v1` 하나로 움직인다.
5. Hunyuan3D 계열은 라이선스 지역 제한(대한민국 제외)으로 사용하지 않는다.
6. MVP는 추가 학습 없이. 학습은 데이터로 개선이 입증될 때만.
7. 웹캠 영상은 전송·저장하지 않는다.
8. LLM은 쓰지 않는다.

## AI가 실제로 쓰이는 곳 (과장 금지)

| 기능 | 학습된 모델 | 우리가 하는 일 |
|---|---|---|
| 신체 랜드마크 추정 | MediaPipe Pose Landmarker (사전학습) | 모델 선택(lite/full), 필터링, 정규화, 지연 측정 |
| 동작 분류 | MVP는 없음(규칙 기반). v3에서 소형 분류기 선택적 | 특징 설계, 데이터 수집, P/R/F1 평가, 개선 전후 비교 |
| 배경 제거 | rembg/BiRefNet (사전학습) | 전처리 파이프라인 |
| 이미지→3D | TRELLIS(.2)/SPAR3D/TripoSR 중 PoC로 선정 | 모델 비교, 전처리·후처리, 속도·품질 측정 |
| 자동 리깅 | Make-It-Animatable 등 (사전학습, 선택) | 공통 스켈레톤 매핑, 검증기, 강등 로직 |
| 게임 AI 상대 | 없음 (FSM 알고리즘) | 난이도 설계 |
| 타격 판정 | 없음 (기하 계산) | 규칙 설계 |

## 문서 지도

| 문서 | 내용 |
|---|---|
| [01-USER-FLOW](01-USER-FLOW.md) | 10단계 사용자 플로우, 단계별 서버/AI/오류 처리 |
| [02-SYSTEM-ARCHITECTURE](02-SYSTEM-ARCHITECTURE.md) | 전체 아키텍처, 컴포넌트 책임, Mermaid 다이어그램 |
| [03-TECH-STACK](03-TECH-STACK.md) | 기술 후보 9문항 분석, 버전·라이선스 |
| [04-AI-3D-PIPELINE](04-AI-3D-PIPELINE.md) | 2D→3D→리깅→게임 적용 파이프라인, A/B 방식 비교 |
| [05-MOTION-RECOGNITION](05-MOTION-RECOGNITION.md) | MediaPipe 동작 인식, 캘리브레이션, 분류 알고리즘 |
| [06-COMBAT-SYSTEM](06-COMBAT-SYSTEM.md) | 1인칭 게임, 타격 판정, AI 상대 |
| [07-MULTIPLAYER](07-MULTIPLAYER.md) | 실시간 1:1, 서버 권한, 지연 보정 |
| [08-API-DESIGN](08-API-DESIGN.md) | HTTP API, 실시간 이벤트 스키마 |
| [09-DATA-MODEL](09-DATA-MODEL.md) | ERD, 캐릭터 매니페스트, 작업 큐 |
| [10-UI-UX](10-UI-UX.md) | 화면 10종, 디버그 오버레이, 예외 UI |
| [11-MVP-ROADMAP](11-MVP-ROADMAP.md) | MVP 단계, 8주 로드맵, 역할 |
| [12-PERFORMANCE-TESTING](12-PERFORMANCE-TESTING.md) | 지표, 실험 설계, 테스트 자동화 |
| [13-RISKS](13-RISKS.md) | 위험 분석 |
| [14-OPEN-SOURCE-LICENSES](14-OPEN-SOURCE-LICENSES.md) | 라이선스 검토 |
| [15-DEVELOPMENT-TASKS](15-DEVELOPMENT-TASKS.md) | 작업 분해, 설계 검토 체크리스트, 시작 전 해결 과제 |

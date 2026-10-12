# 14. 오픈소스 및 라이선스

> 확인일 2026-10-12. 법률 자문이 아니다. "확인 필요"는 원문을 아직 읽지 않은 항목이고, 사용 전에 담당자가 원문 링크를 확인하고 이 표를 갱신한다.
> 프로젝트 성격: 비상업 교육 프로젝트(팀 소재지 대한민국). 공개 시연과 포트폴리오 공개 가능성이 있다.

## 1. 구성 요소별 라이선스

사용 형태: **C** = 클라이언트 번들(브라우저로 배포), **S** = 서버 의존성, **P** = 별도 프로세스 도구, **W** = 모델 가중치, **A** = 에셋, **API** = 외부 서비스

| 구성 요소 | 버전 | 라이선스 | 사용 형태 | 의무 | 위험도 |
|---|---|---|---|---|---|
| three | 0.186.1 | MIT | C | 저작권 고지 포함 | 낮음 |
| @mediapipe/tasks-vision | 1.1.0 | Apache-2.0 | C | 고지 + NOTICE 유지 | 낮음 |
| MediaPipe 모델(.task: pose lite/full, hand, face) | latest(float16) | 모델 카드 조건(**확인 필요**) | C+W(자체 호스팅) | 모델 카드 확인 후 고지 | 낮음~중간 |
| @dimforge/rapier3d-compat | 0.21.0 | Apache-2.0 | C | 고지 | 낮음 |
| colyseus | 0.18.9 | MIT | S | 고지 | 낮음 |
| @colyseus/sdk | 0.18.5 | MIT | C | 고지 | 낮음 |
| socket.io (대안, 미사용 예정) | 4.8.4 | MIT | — | — | — |
| vite | 8.3.4 | MIT | 빌드 도구 | 없음(번들에 포함 안 됨) | 낮음 |
| react / react-dom | 19.3.0 | MIT | C | 고지 | 낮음 |
| fastify | 확인 필요 | MIT(확인 필요) | S | 고지 | 낮음 |
| drizzle-orm | 확인 필요 | Apache-2.0(확인 필요) | S | 고지 | 낮음 |
| zod | 확인 필요 | MIT(확인 필요) | C+S | 고지 | 낮음 |
| PostgreSQL | 16+ (확인 필요) | PostgreSQL License | S(컨테이너) | 없음 | 낮음 |
| MinIO | 확인 필요 | **AGPL-3.0** | 개발 환경 컨테이너 전용 | 수정·네트워크 배포 시 소스 공개 의무 → **수정하지 않고 dev에서만 사용**, 운영은 Cloudflare R2 | 중간(운영 사용 시) |
| rembg | 확인 필요 | MIT(확인 필요) | S(AI 워커) | 고지. 내부 U²-Net 가중치 라이선스 별도 확인 | 낮음 |
| BiRefNet | 확인 필요 | MIT(확인 필요) | W | 고지 | 낮음 |
| TRELLIS (v1) | 확인 필요 | MIT(확인 필요) | W+S | 고지 | 낮음 |
| TRELLIS.2 | 확인 필요 | MIT(모델·코드) | W+S | 고지. **의존성 nvdiffrast/nvdiffrec은 NVlabs 별도 라이선스**(NVIDIA Source Code License 계열은 일반적으로 비상업 조건, **확인 필요**). FlexGEMM·CuMesh·O-Voxel 라이선스 미기재 | **중간**: 비상업 교육용이면 허용될 가능성이 높으나(추정) 상업화 시 재검토 |
| SPAR3D / SF3D | 확인 필요 | Stability AI Community License | W+S | 연매출 US$1M 미만 무료, 초과 시 엔터프라이즈 라이선스. 고지 | 낮음(현재) |
| TripoSR | 확인 필요 | MIT(추정, 확인 필요) | W+S | 고지 | 낮음 |
| **Hunyuan3D 2.x** | 2.1 | Tencent Hunyuan 3D Community License | **사용 금지** | Territory가 "the worldwide territory, excluding the territory of the European Union, United Kingdom and South Korea"(1.l항). Territory 밖 사용은 무라이선스(5(c)항). 호스팅된 Space 호출도 포함 | **사용 불가** |
| UniRig | 확인 필요 | MIT | W+S(실험군) | 고지 | 낮음 |
| Make-It-Animatable | 확인 필요 | MIT | W+S | 고지. 학습 데이터(Mixamo) 관련 추가 조건이 있는지 **확인 필요** | 낮음~중간 |
| Puppeteer (Seed3D) | 확인 필요 | Apache-2.0 | W+S(실험군) | 고지 + NOTICE | 낮음 |
| Blender / bpy | bpy 5.2.2 | GPL-3.0 | **P(별도 프로세스)** | bpy 스크립트를 배포하면 GPL. 앱 코드와 분리·별도 프로세스 실행이면 앱에 전파되지 않는다는 해석이 일반적(**확인 필요, 법률 자문 아님**). 산출물(GLB)은 사용자 소유 | 중간 → `tools/blender/`를 GPL-3.0으로 명시해 리스크 제거 |
| Rigify | Blender 동봉 | GPL(추정, 확인 필요) | P | 위와 동일 | 낮음 |
| Quaternius Universal Animation Library | — | **CC0** | A | 의무 없음(고지 권장) | 낮음 |
| Kenney 에셋(경기장 소품 등, 선택) | — | CC0(일반적, 확인 필요) | A | 없음 | 낮음 |
| Mixamo 캐릭터·애니메이션 | — | Adobe 약관 | A(내부 제작용) | 게임 내 사용은 로열티 프리. **원본 캐릭터·애니메이션 파일 단독 재배포 금지, ML 학습 사용 금지**(2022 커뮤니티 FAQ 기준, **재확인 필요**). 공식 API 없음(확인 필요) | **중간**: 브라우저가 GLB를 내려받는 구조라 "재배포"로 해석될 여지가 있음 → 기본 클립은 Quaternius(CC0)로 구성하고 Mixamo는 대체 가능한 위치에만 사용 |
| @pixiv/three-vrm (확장) | 확인 필요 | MIT | C | 고지 | 낮음 |
| Kalidokit | — | MIT | 참고용(수식만) | 고지. **공식 deprecated**, 의존성으로 추가하지 않음 | 낮음 |
| Ready Player Me | — | — | **사용 금지** | 2026-01 말 서비스 종료(제3자 출처, 공식 확인 필요) | 해당 없음 |
| Meshy API | — | 상용 약관(**확인 필요**) | API(대체 백엔드) | 생성물 소유권·사용 범위 약관 확인. API 키는 서버에만 | 중간 |
| Tripo API | — | 상용 약관(확인 필요) | 미사용(후보) | — | — |

## 2. 정책

### 2.1 사용자 업로드 이미지와 생성 모델
- 업로드 이미지의 권리는 사용자에게 있다. 사용자는 업로드 시 사용 권리를 보유했음을 확인한다(`userAttestedRights`).
- 생성 모델(GLB)의 권리: 입력 이미지의 권리와 생성 모델 라이선스 조건을 함께 따른다. 매니페스트 `provenance`에 사용 모델과 버전을 기록해 추적할 수 있게 한다.
- 서비스(팀)는 생성물을 게임 내 표시·대전 상대 전송 목적으로만 사용한다. 학습 데이터로 쓰지 않는다.
- 기본 비공개. 삭제 요청 시 원본·중간 산출물·GLB를 모두 삭제한다.
- 타인의 저작물·유명 캐릭터 업로드는 금지한다(약관). 신고를 받으면 비공개 처리 후 검토한다.

### 2.2 고지 파일
- 루트에 `THIRD_PARTY_NOTICES.md`를 두고 클라이언트 번들 의존성, 모델 가중치, 에셋의 라이선스 전문 또는 링크를 기록한다.
- 게임 내 "설정 > 오픈소스 라이선스" 화면에서 같은 내용을 노출한다.
- 모델 카드: 사용하는 각 모델(MediaPipe, 배경 제거, 이미지→3D, 리거)의 모델 카드 링크와 버전을 `docs/model-cards.md`에 기록한다(MVP 3).

### 2.3 CI 라이선스 검사
- `license-checker`(또는 동등 도구) 허용 목록: MIT, Apache-2.0, BSD-2/3-Clause, ISC, CC0-1.0, 0BSD. 이외 라이선스가 들어오면 PR 실패.
- Python 워커는 `pip-licenses`로 같은 검사를 한다. GPL 패키지는 `tools/blender/` 외부에서 import하면 실패.
- 새 모델·에셋을 추가하는 PR은 이 문서 표 갱신이 필수다(PR 템플릿 체크박스).

### 2.4 프로젝트 자체 라이선스
- 앱 코드: MIT 권장(팀 합의 필요).
- `tools/blender/`: GPL-3.0(bpy 스크립트). 별도 디렉터리에 LICENSE 파일을 둔다.

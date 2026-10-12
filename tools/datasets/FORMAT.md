# 모션 녹화 데이터 형식 (JSONL)

동작 분류기 평가용 데이터다(docs/12-PERFORMANCE-TESTING.md). **웹캠 영상은 저장하지 않고 랜드마크만 저장한다.**
녹화 파일은 `tools/datasets/recordings/*.jsonl`에 두고 git에는 올리지 않는다(.gitignore). 공유가 필요하면 참가자 동의를 받은 뒤 팀 드라이브에 둔다.

## 한 줄 = 한 프레임

```json
{"t": 12345.6, "lm": [[x, y, z, visibility], ...33], "wlm": [[x, y, z], ...33], "label": "jab", "hand": "lead", "meta": null}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `t` | number | 프레임 캡처 시각(ms, `performance.now` 또는 `requestVideoFrameCallback`의 `mediaTime×1000`). 단조 증가 |
| `lm` | `[x,y,z,vis][33]` 또는 `null` | MediaPipe Pose 정규 이미지 좌표(0..1). **비미러 원본 프레임 기준**. 미검출이면 `null` |
| `wlm` | `[x,y,z][33]` 또는 `null` | 월드 랜드마크(m). 선택 |
| `label` | `none` `jab` `straight` `guard` `slip_left` `slip_right` `duck` | 이 프레임의 정답. 펀치는 뻗기 시작부터 복귀 완료까지 모든 프레임에 붙인다 |
| `hand` | `lead` \| `rear` | 펀치 라벨일 때 손 |
| `meta` | object \| null | 첫 줄에 세션 정보: `{ "session": "...", "stance": "orthodox", "camera": "...", "lighting": "bright", "distanceM": 2.0 }` |

- 좌우: 랜드마크 라벨은 피사체 기준(11 = 사용자 왼쪽 어깨). `slip_left`는 **사용자** 왼쪽이다.
- 좌표는 소수 5자리로 반올림한다(`toRecordingLine`). 30fps 기준 1분 약 1.1MB.

## 라벨링 방법

1. **가이드 녹화(권장)**: 디버그 화면이 "잽!"처럼 지시하고, 지시 후 1초 창 안에서 감지된 동작 구간에 자동으로 라벨을 붙인다. 이후 사람이 검토한다.
2. **키 라벨**: 녹화 중 숫자키를 누르고 있는 동안 해당 라벨을 붙인다. 1 잽, 2 스트레이트, 3 가드, 4 좌회피, 5 우회피, 6 숙이기, 0 없음.

## 세션 구성 (참가자당)

| 구간 | 내용 |
|---|---|
| 정지 2분 | 가드 자세와 손 내림을 번갈아 (오인식률 측정) |
| 동작별 20회 | 잽, 스트레이트, 좌·우 회피, 가드 |
| 섞어 치기 2분 | 콤비네이션 자유 |
| 조건 변화 | 조명(밝음/어두움/역광), 거리(1.5/2.5m), 옷(반팔/긴팔) |

## 평가

`packages/motion`의 `parseRecording` → `recordingToFrames` → `MotionClassifier.process`를 거쳐 클래스별 P/R/F1을 계산한다.
- 펀치: 이벤트 단위. 라벨 구간 ±100ms 안의 같은 종류 이벤트 1개가 TP.
- 가드·회피: 프레임 단위. 라벨 경계 ±200ms와 펀치 구간은 제외.
- 구현 참고: `packages/motion/test/eval.ts`.

# Telegram 음성 받아쓰기: MLX 설치 및 검증

Apple Silicon macOS에서는 mlx-whisper 0.4.3과 `mlx-community/whisper-large-v3-turbo`를 사용한다. 엔진 시작·실행·결과 읽기가 실패하면 기존 openai-whisper CPU CLI로 한 번 재시도한다. 정상적인 실패는 발신자 DM으로 알리고 큐를 계속한다. 프로세스 정리가 확인되지 않으면 fallback을 실행하지 않고 기존 음성 큐 중단 규칙을 적용한다.

## 설치·오프라인 실행

```sh
bash scripts/stt/install.sh
```

필수: Apple Silicon macOS, uv, `/opt/homebrew/bin/ffmpeg`, Yuna 음성. Python 3.12 전용 venv와 모델을 `~/.local/share/b3os-stt`에 설치한다. 설치 경로를 바꿀 때는 설치 단계와 서비스 환경에 동일한 `B3OS_STT_HOME` 절대경로를 지정한다. dev/stage 검증은 별도 경로를 지정하고 prod는 기본 경로를 사용한다. 설치 스크립트는 서비스 설정 변경이나 재시작을 하지 않는다.

Python 의존성 36개 버전을 `scripts/stt/requirements.txt`에 고정했다. 모델 revision은 `a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb`이며 설치 단계에서 config와 가중치를 미리 다운로드한다. 이어 Yuna 음성의 실제 디코딩을 `HF_HUB_OFFLINE=1`로 검증한다. 런타임 adapter도 import 전에 해당 환경값을 강제하며, 로컬 config/가중치가 없으면 실패한다. 운영 경로는 worktree나 세션 임시 폴더를 참조하지 않는다.

fallback은 기존 `/opt/homebrew/bin/whisper`와 `~/.cache/whisper/large-v3-turbo.pt`를 사용한다(ko, CPU 4 threads). 설치 스크립트는 fallback을 새로 설치하지 않는다. CPU 모델이 없으면 다운로드 없이 실패 DM으로 끝난다. 가속 엔진 장애 때 처리 지연을 감수하고 음성 전달 기회를 한 번 더 제공하기 위해 fallback을 선택했다.

다운로드 30초·ffmpeg 무음 검사 30초·MLX 30초·CPU fallback 120초를 각각 적용한다. 이번 1.76~17.02초 실제 음성의 MLX 최대값은 prompt 사용 5.84초, 미사용 6.72초였다. 30초는 이 최대값의 약 4.5배 여유를 주면서 기존 엔진의 120초 대기를 줄인다. CPU는 별도 120초를 유지하므로 MLX timeout 뒤 전체 작업이 30초 이내 끝나는 것은 아니다. 더 긴 녹음과 부하별 상한은 측정하지 않았다.

process group 생성·SIGKILL·close/그룹 소멸 확인·정리 기한 5초·큐 중단과 토큰 비노출 경계는 유지한다. 디지털 무음에 가까운 입력(max_volume ≤ -80dB)은 엔진 시작 전에 실패 처리한다. 임시 음성·결과는 작업 뒤 삭제한다.

## Yuna 합성 음성 및 prompt 비교

재현: `bun scripts/check-telegram-voice.ts`, `--negative`, `--no-prompt`를 필요에 따라 조합한다. 3명 시험 명부의 prompt는 `빌, 스티브, 덱스, 모두, 여러분.`이다. positive는 실제 발화 약 1.5초에 무음을 덧붙인 10초 Ogg/Opus, 반대 문장은 원래 발화 길이, 무음은 3초다. Telegram 요청은 로컬 응답으로 대체하고 실제 엔진과 라우터를 실행한다. 측정은 매번 새 Python 프로세스이며 모델은 OS 파일 캐시를 사용할 수 있다.

| 입력 | prompt 있음: 결과 / 시간 | prompt 없음: 결과 / 시간 | 확인 |
|---|---|---|---|
| 빌, 이거 확인해줘 | 빌, 이거 확인해줘. / 2.18초 | 이거 확인해 줘 / 2.12초 | prompt 있을 때 명시 bill 호출 보존 |
| 모두, 회의하자 | 모두 회의하자. / 1.31초 | 모두 회의하자 / 1.48초 | 모두 전원 호출 |
| 빌딩 앞에서 보자 | 빌딩 앞에서 보자. / 1.37초 | 빌딩 앞에서 보자 / 1.31초 | 새 호출 없음 |
| 모두의 마블 하자 | 모두의 마블 하자. / 1.45초 | 모두의 마블 하자 / 1.54초 | 새 호출 없음 |
| 올해 계획 얘기하자 | 올해 계획 얘기하자. / 1.39초 | 올해 계획 얘기하자 / 1.41초 | 새 호출 없음 |
| 무음 | 엔진 전 차단 / 0.022초 | 엔진 전 차단 / 0.024초 | 실패 DM, handle 미진입 |

prompt가 이름을 보존하는 효과를 관측했다. prompt 없는 bill 샘플은 이름이 빠졌고 명시 호출 대신 default 경로로 갔다(시험 명부에서는 우연히 bill이 선택됨). 반대 사례의 ‘새 호출 없음’은 새 명시 호칭을 만들지 않는다는 뜻이다. 기존 owner/답장 전달 규칙은 유지한다.

## 실제 녹음 6개

복사한 원본 파일은 실측 후 삭제하며 저장소에는 포함하지 않는다. 번호만 기록한다. 재현 도구 `bun scripts/stt/benchmark.ts <local-audio...> [--no-prompt]`는 로컬 파일을 사용하고 MLX 단독 성공(= CPU fallback 0회)을 assertion으로 확인한다. 표는 위 시험 명부 prompt 사용, ffmpeg 검사와 결과 읽기 포함 시간이다. 인식 결과는 정답 전사가 아니다.

| 번호 | MLX 시간 | 받아쓴 결과 |
|---|---:|---|
| 01 | 5.84초 | 우와... |
| 02 | 2.69초 | 전체 영상은 책갈피와 A창의 중심이 아니고 기존 스티브 기능에다가 지금 댓글창이 없어지고 책갈피와 A창이 바뀌었잖아. 그걸 넣으라는 얘기야. |
| 03 | 2.66초 | 아, 그 빌, 내가 아까 시킨 음성으로 액 명령, 실만 지정하는 것도 됐나? |
| 04 | 2.20초 | 그리고 콕스의 요구사항에다가 이 음성 채팅을 지금 텔레그램은 음성을 저장하고 또 응답을 하나 둘인데 이걸 더 빠른 방법으로 음성 컴을 하는 것을 기본 사항으로 넣어줘. 일단 초기에 킵해나. |
| 05 | 1.45초 | 어, 그... 비스레이오에스 재시작하고, 비스레이오에스 텔레그램도 음성 좀 적용해줘. |
| 06 | 1.51초 | 지금 단톡방에서 해볼게. |

같은 녹음의 CPU fallback 비교(같은 prompt, 새 프로세스; ffmpeg 사전 검사 제외):

| 번호 | 길이 | CPU 시간 | CPU 결과 |
|---|---:|---:|---|
| 01 | 2.46초 | 89.63초 | 오. |
| 02 | 14.02초 | 16.79초 | 전체 영상은 책갈피와 A창의 중심이 아니고 기존 스티브 기능에다가 지금 댓글창이 없어지고 책갈피와 A창이 바뀌었잖아. 그걸 넣으라는 얘기야, 그렇지? |
| 06 | 1.76초 | 14.06초 | 지금 단톡방에서 해볼게. |

짧은 01번(2.46초)의 원래 발화는 ‘어’인데 prompt 사용 시 ‘우와...’, 미사용 시 ‘어’(6.72초)로 인식했다. 이름 hint는 모든 음성의 정확도를 높이지 않는다. 02번도 prompt 유무에 따라 문장·고유명사 인식이 달랐다. 이 소수 표본으로 일반 음성 정확도나 오거부율을 보장하지 않는다.

## 자동 검증과 한계

| 기능 / 소스 | 검증 | 결과 / mutation |
|---|---|---|
| 엔진 선택·fallback·결과 정리 (`telegramVoice.ts`) | `telegramVoice.test.ts` | MLX 우선·실패/빈/누락 결과 fallback·양쪽 실패·정리 미확인 시 fallback 금지 |
| 프로세스·큐·토큰·라우터 | `telegramVoice.test.ts`, `telegramCapture.voice.test.ts`, `teamRouter.test.ts` | baseline 79 pass, 변경 뒤 88 pass. 실제 Python→ffmpeg 종료 시험 포함 |
| 오프라인 adapter·prompt·빈 결과 | `python3 -m unittest discover -s scripts/stt -p 'test_*.py' -v` | 3 pass. MLX stub으로 네트워크 차단 환경값과 인자·출력 계약 검증 |
| 설치 및 실제 MLX | `bash scripts/stt/install.sh`, Yuna/실제 음성 probe | 오프라인 모델 디코딩 성공, 실측 시 CPU fallback 없음 |
| 회귀 검사의 검출력 | 정리 미확인 fallback 허용 / stale output 삭제 제거 / timeout 120초로 원복 | 각각 1 / 1 / 8 fail, 복원 후 관련 검사 통과 |

실제 프로세스 종료 회귀 시험은 최초 반복 검증 중 1회 실패(85 pass/1 fail)했다. macOS에서는 그룹 SIGKILL 뒤 부모 close 직후 signal 0이 일시적으로 EPERM을 반환할 수 있었다. close 뒤 EPERM은 기존 5초 기한 안에서 signal 0으로만 재확인하며, ESRCH 뒤에만 fallback/다음 큐를 진행한다. 지속 EPERM·기한 만료·SIGKILL 실패는 큐 중단을 유지한다. 일시 EPERM→ESRCH와 지속 EPERM 회귀 시험을 추가했고, fix 원복 mutation이 이를 검출한다. 실제 Python→ffmpeg 500ms timeout도 실행했다. 원본 실패 로그와 과부하 환경 재실행 기록도 보존했다.

MLX 실패 진단은 원문 오류·argv·prompt·경로를 포함하지 않는 고정 문구다. 프로세스 실패/시간 초과와 결과 누락/빈 결과를 구분해 CPU 전환 직전에 한 줄 남긴다.

TypeScript typecheck와 shell syntax 검사 통과. 실제 Telegram 그룹 수신·DM 발송·팀원 runtime 주입, 라이브 프로세스의 MLX 실행, 긴 음성, 부하별 지연, 일반 잡음·작은 목소리 오거부율은 검증하지 않았다. 전체 suite·서비스 재시작·머지·배포를 실행하지 않았다.

되돌리기: PR commit을 revert하면 기존 CPU CLI를 사용한다. fallback용 기존 CPU 모델은 보존한다. 전용 venv와 MLX 모델은 서비스와 분리되어 있으며 즉시 삭제할 필요가 없다.

업스트림: [MLX Whisper 구현과 API](https://github.com/ml-explore/mlx-examples/tree/main/whisper).

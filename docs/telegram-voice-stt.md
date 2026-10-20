# Telegram 그룹 음성 받아쓰기 검증

승인 allowlist에 있는 사람의 그룹 voice/audio 중 text/caption이 없는 메시지만 로컬 Whisper로 받아쓴다. 받아쓴 글은 기존 `handle()`에 전달한다. 라우팅에는 원문을 쓰고 수신 본문에만 `🎤 음성(받아씀):` 표시를 붙인다. 전원 호출은 기존 확인창을 거친다.

다운로드는 30초, ffmpeg 무음 검사는 30초, Whisper는 120초 제한이다. 각 실행은 별도 process group으로 만들며 시간 초과 시 Python과 ffmpeg를 함께 종료한다. 부모 close와 process group 소멸을 확인한 뒤 큐를 진행한다. 다운로드·받아쓰기 실패와 빈 결과는 발신자의 Telegram DM으로 재전송 요청을 보낸다. 이 알림은 팀 메시지 DB와 라우터에 입력하지 않는다. 동시 음성은 순서대로 처리하며, 현재 capture poll loop도 처리가 끝날 때까지 기다린다. 따라서 처리 중에는 같은 폴러의 후속 메시지와 확인 버튼 처리도 지연될 수 있다.

토큰이 포함된 URL은 fetch 내부에서만 사용한다. 다운로드 예외는 고정 오류로 바꾸며 프로세스 argv에는 로컬 경로와 팀원 별칭만 넣는다. 임시 음성·txt는 성공·실패 뒤 삭제한다. Whisper executable은 `/opt/homebrew/bin/whisper`, 모델은 `~/.cache/whisper/large-v3-turbo.pt`, 언어는 ko, CPU 4 threads다. 모델이 없으면 다운로드하지 않고 실패한다. 별도 서버나 외부 STT API는 사용하지 않는다.

## 실제 음성 시험

재현: `bun scripts/check-telegram-voice.ts` (macOS Yuna·ffmpeg·로컬 Whisper 필요).

`say -v Yuna`로 만든 두 문장을 ffmpeg의 apad와 `-t 10 -c:a libopus`로 각각 10초 Ogg/Opus로 변환한다. 실제 발화는 약 1.5초이며 나머지는 무음이다. Telegram 다운로드는 로컬 파일 응답으로 대체하고, 실제 Whisper와 기존 라우터를 실행한다. 로컬 결과 파일은 시험 종료 시 삭제된다.

| 발화 | 받아쓴 결과 | 라우팅 대상 | 사유 | 전체 처리 시간 |
|---|---|---|---|---|
| 빌, 이거 확인해줘 | 빌, 이거 확인해줘. | bill | explicit_mention | 17.30초 |
| 모두, 회의하자 | 모두 회의하자. | bill, steve, dex (시험 명부) | broadcast_marker | 13.80초 |

같은 파일의 앞선 개별 CLI 실행은 각각 13.73초, 12.85초였다. 별칭 참고 문구가 없었던 첫 시험은 “빌”을 “필”로 인식했다. 현재 코드는 명부의 별칭과 전원 호칭을 Whisper initial_prompt에 제공한다. 일반 음성의 이름 인식 정확도는 이 합성 음성 2건으로 보장할 수 없다.

## 지연과 상주 프로세스 판단

15초를 넘는 실행이 있어 모델 재사용도 측정했다. 같은 Python 프로세스에서 모델을 한 번만 읽었을 때 로딩 1.94초, 음성별 추론 9.41초·9.96초, 프로세스 최대 RSS 약 4.78 GiB였다(macOS, CPU 4 threads). 이 값은 동일 시점의 부하를 통제한 비교 실험은 아니다.

이번 변경은 CLI를 유지한다. 모델 재사용으로 로딩·Python 시작 비용을 줄일 수 있지만 추론 자체에도 약 10초가 걸리며, 상주하면 수 GiB의 메모리와 프로세스 종료·복구 관리가 추가된다. 음성 빈도가 높거나 15초 이하 응답이 필수라면 모델 재사용 worker와 idle 종료를 추가하는 것이 대안이다. 현재 구현은 15초 이하를 보장하지 않는다.

## 검증 표

| 기능 / 소스 | 실행한 검사 | 기준 / 결과 | mutation / 한계 |
|---|---|---|---|
| 승인 사람 voice/audio, 큐, 실패 알림, 파일 정리, 토큰 보호 (`telegramVoice.ts`) | `telegramVoice.test.ts` | 성공/빈 결과/다운로드 실패/타임아웃/봇·비승인 무시/argv/삭제 통과 | 오류 보호를 토큰 문자열 throw로 바꾸면 2 fail |
| 기존 라우팅·수신 본문·owner·전원 확인창 (`telegramCapture.ts`) | `telegramCapture.voice.test.ts`, 기존 capture 검사 | 실제 capture loop + 메모리 DB + mock Telegram; 시스템 알림은 DM만, 팀 DB에 없음 | 음성 인입을 생략하면 1 fail; 실제 봇 발송과 팀원 runtime 주입 미검증 |
| all/올/여러분 선두 전원 호출 (`mention.ts`) | `leadingName.test.ts` 및 관련 router 검사 | 대소문자 무시, 올해/allow/alliance/여러분의 제외 | 새 별칭을 제거하면 1 fail |
| 실제 로컬 Whisper → 라우팅 | `scripts/check-telegram-voice.ts` | 위 두 받아쓰기·대상·사유 assertion 통과 | 합성 음성·시험 명부, 실제 그룹 인입 미검증 |

기존 main 범위: 6개 파일 167 pass / 0 fail. 변경 뒤 관련 범위: 8개 파일 176 pass / 0 fail. TypeScript `bun run typecheck` 통과. 전체 suite·라이브 서버 실행·배포·재시작은 하지 않았다.

되돌리기: 해당 PR commit을 revert한다. runtime 설정·DB schema 변경은 없다.


## 프로세스 종료 및 오호출 반대 사례

`runVoiceProcess`는 `detached: true`로 작업별 process group을 만들고 음수 PID에 SIGKILL을 보낸다. 실제 Python 부모가 실제 ffmpeg(anullsrc 실시간 디코딩)를 실행하는 회귀 시험에서 500ms timeout 후 두 PID가 모두 사라진 것을 다음 큐 작업 안에서 확인했다. 부모만 kill하는 mutation은 이 시험에서 실패했다.

`bun scripts/check-telegram-voice.ts --negative`로 아래 반대 사례를 재현한다. 문장 세 개는 Yuna 원래 발화 길이로 Ogg/Opus로 만들었고, 무음은 16kHz mono 3초 Ogg/Opus다. positive 시험과 같은 별칭 prompt를 사용한다.

| 입력 | 받아쓴 결과 / 처리 | 새 선두 이름·명시 @멘션·전원 호출 | 시간 |
|---|---|---|---|
| 빌딩 앞에서 보자 | 빌딩 앞에서 보자. | 없음 | 15.76초 |
| 모두의 마블 하자 | 모두의 마블 하자. | 없음 | 12.46초 |
| 올해 계획 얘기하자 | 올해 계획 얘기하자. | 없음 | 17.41초 |
| 무음 3초 | 무음 검사 실패 → 실패 DM, handle 미진입 | 없음 | 0.068초 |

무음 검사가 없을 때 3초 무음을 Whisper가 “감사합니다.”로 인식했다(13.97초). 그래서 Whisper 실행 전에 ffmpeg volumedetect로 최대 음량을 검사하고 -80 dB 이하의 디지털 무음에 가까운 입력을 실패 처리한다. 이 무음 검사를 생략하면 실제 Opus 무음→시스템 DM 회귀 시험이 실패한다. 일반 잡음이나 모든 작은 소리의 무발화 판별을 보장하는 검사는 아니다.

위 세 문장은 새 호출을 만들지 않는다는 검사다. 답장이나 기존 owner가 있으면 원래 규칙에 따라 해당 팀원에게 전달될 수 있다. 음성에만 별도의 owner 예외를 만들지는 않는다. 무음은 owner와 관계없이 handle에 들어가지 않는다.

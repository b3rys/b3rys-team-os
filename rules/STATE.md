# TEAM-OS Current State

> Status: template
> Role: 팀 현재 상태값(경로·팀원·인프라·메시지 버스). 운영 규칙은 `TEAM-OS.md`를 본다.
> 공개 원본 `rules/STATE.md` 는 채우지 않습니다(커밋하면 공개 저장소로 나갑니다). 팀 값은 `rules/STATE.local.md` 에 적습니다 — git 이 추적하지 않고, 없으면 설치·서버 시작 때 `rules/STATE.md` 를 복사해 만듭니다.

## 기본 경로
- 기본 프로젝트 폴더: `~/your-workspace/`
- team-collab: `~/your-workspace/team-collab/`
- registry: `./agents.json`

## 운영 인프라
- (대시보드 도메인 / 터널 / 호스트 등 당신 팀 인프라를 적으세요)

## 팀원
- 정본은 `agents.json`. `employee_id`는 팀 정체성 + 멀티멘션 리드 우선순위 키(재사용 안 함). `team_official_member:false`는 리드 후보 제외.

## 중요 프로젝트
- (TEAM-OS §10 역할 분리 기본이 걸리는 사용자용 제품 목록을 적으세요. 예: 앱 A · 서비스 B)

## 메시지 버스
- (팀 메시지 버스 채널·계정 설정을 적으세요)

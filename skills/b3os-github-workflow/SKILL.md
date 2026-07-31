---
name: b3os-github-workflow
description: 팀원이 코드 변경을 GitHub PR로 올려 승인·머지까지 가는 절차. 브랜치·worktree 격리, 커밋 신원(팀원 이름 + 팀 계정), PR 작성 계정, 검증 근거를 PR에 남기기, tier별 승인 요청, 머지 후 실측 확인. 팀원이 git-추적 파일을 고쳐 main에 반영해야 할 때 사용. 승인·안전 정책 자체는 TEAM-OS가 정본이고 여기는 절차만 다룬다.
---
# GitHub 워크플로 — 변경을 PR로 올려 머지까지

**PR·문서는 인과관계와 사실로 쓴다. 회고와 리뷰는 저장소 밖에서 한다. 간결하게, 짧은 문장으로.**

절차는 확인되는 형태로 둔다 — 설정한 값을 다시 읽고, 올린 것을 다시 본다.

| 언제 | 읽을 것 |
|---|---|
| PR·커밋·문서를 쓸 때 | `references/writing.md` |
| 계정·승인자 값이 필요할 때 | `references/settings.md` |
| 브랜치부터 머지까지 | `references/procedure.md` |
| 공개 저장소라서 달라지는 것 | `references/public-repo.md` |

b3os 인프라(소스·config·registry·릴리스)를 고치면 `b3os-infra-safety` 를 먼저 보고 이 절차를 얹는다.
승인·안전 정책 자체는 TEAM-OS가 정본이다. 여기는 절차만 다룬다.

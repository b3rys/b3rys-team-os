---
name: b3os-workloop
description: "Deprecated compatibility stub. Use b3os-task-loop for scheduled workloop wake handling plus task continuation/review-wait tracking."
owner: maintainer (infra)
---

# Deprecated: use `b3os-task-loop`

이 스킬은 호환용 stub입니다. 새 정본은 아래입니다.

```text
skills/b3os-task-loop/SKILL.md
```

기존 `b3os-workloop`의 원문은 보존되어 있습니다.

```text
skills/b3os-task-loop/references/legacy-b3os-workloop.md
```

새 작업에서는 `b3os-task-loop`를 사용하세요.

구분:

- 스케줄 wake(`[작업루프: ...]`, `[workloop: ...]`) 처리도 `b3os-task-loop`에서 다룹니다.
- 주간 팀 정책/학습 개선은 여전히 `b3os-team-learning-loop`가 담당합니다.
- durable scheduler 자체는 `b3os-scheduler`가 담당합니다.

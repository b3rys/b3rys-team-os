---
name: b3os-task-mgmt
description: "Deprecated compatibility stub. Use b3os-task-loop for Tasks 칸반, 주행모드, handoff, continuation guard, review-wait, scheduled workloop."
---

# Deprecated: use `b3os-task-loop`

이 스킬은 호환용 stub입니다. 새 정본은 아래입니다.

```text
skills/b3os-task-loop/SKILL.md
```

기존 `b3os-task-mgmt`의 원문은 보존되어 있습니다.

```text
skills/b3os-task-loop/references/legacy-b3os-task-mgmt.md
```

새 작업에서는 `b3os-task-loop`를 사용하세요.

핵심 변경:

- Tasks 칸반·주행모드·handoff·continuation guard는 `b3os-task-loop`로 이동
- 리뷰/응답/승인 대기 중 멈춤 방지 wait-loop 추가
- `thread_id`, `waiting_on`, `recheck_at`, `fallback`, `next_safe_action`, `stop_rule` 필수
- helper scripts: `task-wait.sh`, `task-check.sh`, `task-close.sh`

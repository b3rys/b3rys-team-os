#!/usr/bin/env python3
"""머지 전 승인자 판정 — release-preflight.sh --mode merge 가 부르는 부품.

★게이트는 하나다★: 진입점은 release-preflight.sh 뿐이고 이 파일은 그 안의 판정부다.
따로 떼어 둔 이유는 ★시험 때문★ 이다 — 네트워크·계정·라이브 상태 없이 판정만 돌릴 수 있어야 한다.

━━ 무엇을 판정하나 ━━
  ① PR 작성 계정  == settings.github_team_account
  ② 승인한 계정   == settings.github_approver_account  (그리고 ①과 달라야 한다)
  ③ 승인 본문의 ★마지막 비어있지 않은 줄★ 이 정확히 `Approved-by: <이름>` 이고,
     그 이름이 settings.merge_approvers_normal 에 있다

━━ ★왜 산문을 파싱하지 않나★ ━━
처음엔 승인 본문 첫 줄에서 이름을 뽑으려 했다. 팀원 3인 + 하네스 2인이 찾은 결함이 ★전부 같은 원인★ 이었다:
  인용문 `> Steve 승인합니다` · 부정문 `Bill 은 승인 안 했지만` · 할일 `- Bill 승인 필요` ·
  조사 `Bill이` · 역할어 `GD 승인 후` · 기술용어 `direct-to-gd`(→ gd 가 승인한 것으로) · 이스케이프 개행
★사람이 쓴 문장에서 기계가 쓸 값을 되찾으려 한 것 자체가 원인이다.★
승인자는 그 순간 자기가 누군지 안다 → ★그때 한 줄 박는다.★ 그러면 판정이 정확 일치가 되고 위 클래스가 사라진다.

━━ ★명부·계정을 여기 적지 않는다★ ━━
전부 settings 에서 온다. 하드코딩하면 갈리고, ★더 느슨한 쪽이 게이트가 된다★
(실제로 별도 도구에서 17명 목록을 만들어 3명 정본과 갈렸다).

━━ 실패 방향 ━━
★모르면 막는다.★ 설정 누락·응답 파손·판정 불가는 전부 FAIL 이다 — '확인 불가' 는 '통과' 가 아니다.
"""
import json
import re
import sys

#: 우리가 신뢰하는 유일한 서명 형식. ★줄 맨 앞에서 시작해 줄 전체가 이 모양이어야 한다.★
#  ★들여쓰기를 허용하지 않는다★ (steve 실측): 마크다운에서 들여쓴 줄과 코드펜스 안은
#  ★'예시' 를 뜻한다.★ 예시를 서명으로 세면 ★남의 이름을 예시로 보여주면서 승인★ 하는 것이
#  그 사람의 승인으로 기록된다. (그리고 이 기능을 설명하는 SKILL.md 자체가 그 예시를 담고 있다)
TRAILER = re.compile(r"^approved-by[ \t]*:[ \t]*([A-Za-z0-9._-]+)[ \t]*$", re.I | re.M)


def last_line(body: str) -> str:
    """★본문의 마지막 비어있지 않은 줄★ 만 서명 후보다.

    ★왜 '어디든' 이 아니라 '마지막 줄' 인가★ (steve·ames 리뷰, 2026-07-29)
      본문 어디든 허용하면 ★마크다운의 '예시' 가 서명이 된다★:
        `   Approved-by: steve`  (들여쓰기 = 예시)
        ```                       (코드펜스 안의 예시)
        Approved-by: steve
        ```
      ★실제로 이 기능을 설명하는 SKILL.md 자체가 그 예시를 담고 있다★ — 그걸 인용하며 승인하면
      ★남의 이름이 서명으로 기록된다.★ trailer 는 원래 끝에 붙는 관례이므로 마지막 줄로 좁힌다.

    ★이스케이프된 개행은 되돌리지 않는다★ (ames): GitHub API 응답은 json.loads 단계에서
      이미 진짜 개행으로 복원된다. 추가 치환은 ★계약을 문서보다 넓히기만 한다.★
      (`\r\n` 만 정규화한다 — 이건 실제 줄바꿈이다)
    """
    for line in reversed(body.replace("\r\n", "\n").split("\n")):
        if line.strip():
            return line
    return ""


def standing_approvals(reviews):
    """계정별 ★최종★ 리뷰만 남긴다.

    같은 계정이 승인 뒤 CHANGES_REQUESTED 를 내면 GitHub 은 나중 것을 따른다.
    시간순으로 접지 않으면 ★철회된 승인을 '승인함' 으로 읽는다.★
    코멘트(COMMENTED)는 상태를 바꾸지 않으므로 접지 않는다.
    """
    ordered = sorted(
        [r for r in reviews if isinstance(r, dict)],
        key=lambda r: r.get("submitted_at") or "",
    )
    final = {}
    for r in ordered:
        if (r.get("state") or "") == "COMMENTED":
            continue
        final[((r.get("user") or {}).get("login")) or "?"] = r
    return [(a, r) for a, r in final.items() if (r.get("state") or "") == "APPROVED"]


def check(settings, reviews, pr_author):
    """(ok: bool, message: str). ★모르면 ok=False.★"""
    if not isinstance(reviews, list):
        return False, "reviews payload is not a list — treat as unknown, not as 'no approval'"

    team = (settings.get("github_team_account") or "").strip()
    appr = (settings.get("github_approver_account") or "").strip()
    pool = [p.strip().lower() for p in re.split(r"[\s,]+", settings.get("merge_approvers_normal") or "") if p.strip()]
    author = (pr_author or "").strip()

    # ★설정이 비어 있으면 진행하지 않는다★ — 기본값으로 때우면 이 절차가 막으려는 그 일이 일어난다.
    missing = [k for k, v in (("github_team_account", team),
                              ("github_approver_account", appr),
                              ("merge_approvers_normal", pool)) if not v]
    if missing:
        return False, "settings missing: " + ", ".join(missing) + " — set them in the dashboard; do not hardcode"

    if team == appr:
        return False, f"author account and approver account are the same ({team}) — the review requirement cannot hold"
    if not author:
        # ★조회 실패·빈값을 통과시키지 않는다★ (ames BLOCKER) — 이 도구의 계약은 '모르면 막는다' 다.
        return False, "PR author unknown (lookup failed or empty) — cannot verify the author account"
    if author != team:
        return False, (f"PR author is {author}, expected the team account {team} — "
                       f"recreate the PR with the team account (a PR authored by the approver account cannot be approved)")

    approvals = standing_approvals(reviews)
    if not approvals:
        return False, "no standing approval (a later CHANGES_REQUESTED supersedes an earlier approval)"

    signed = []
    for acct, r in approvals:
        if acct != appr:
            return False, f"approval came from account {acct}, expected the approver account {appr}"
        # ★set 이 아니라 줄 수를 센다★ (ames): 같은 이름이 두 줄이어도 set 은 1개로 접혀
        #   ★'서명이 여럿' 검사를 조용히 통과했다.★
        body = (r.get("body") or "").replace("\r\n", "\n")
        # ★본문 어디든 서명 모양이 둘 이상이면 모호하다★ (ames): 마지막 줄만 보면
        #   앞의 것이 조용히 무시돼 ★누가 승인했는지가 갈린다.★ set 으로 접으면
        #   같은 이름 두 줄이 1개로 세어져 이 검사를 통과했다 — ★줄 수를 센다.★
        all_hits = TRAILER.findall(body)
        if len(all_hits) > 1:
            return False, "approval has more than one Approved-by line: " + ", ".join(sorted({h.lower() for h in all_hits}))
        names = [h.lower() for h in TRAILER.findall(last_line(body))]
        if not names:
            return False, ("approval has no 'Approved-by: <name>' line — the account is shared, "
                           "so the account alone does not say who reviewed")
        # (여기서 len(names) > 1 은 ★불가능★ 하다 — last_line 은 한 줄이다.
        #  중복은 위 all_hits 에서 이미 걸렀다. ★실패할 수 없는 검사는 두지 않는다.★)
        if names[0] not in pool:
            return False, f"Approved-by: {names[0]} is not in merge_approvers_normal ({', '.join(pool)})"
        signed.append(names[0])

    return True, f"approved by {', '.join(signed)} (account {appr}, author {author or '?'})"


def main() -> int:
    """stdin 으로 {settings, reviews, pr_author} 를 받는다. ★argv 가 아니다★ — 리뷰가 많으면 E2BIG 이 난다."""
    try:
        payload = json.load(sys.stdin)
        ok, msg = check(payload.get("settings") or {}, payload.get("reviews"), payload.get("pr_author"))
    except Exception as e:  # 판정 자체가 실패한 것 — 통과가 아니다
        print(f"FAIL\tapprover check could not run: {e}")
        return 0
    print(("OK\t" if ok else "FAIL\t") + msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())

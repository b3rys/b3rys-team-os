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

#: ★서명을 '시도한' 줄★ — 엄격 형식에 안 맞아도 잡는다. ★중복 검사는 이걸로 센다.★
#  이유(하네스 실측 2026-07-29): 엄격 정규식은 줄 끝이 `[ \t]*$` 라
#  ★`Approved-by: dex\` 처럼 백슬래시로 끝나면 매칭이 안 돼 '중복' 으로 세어지지 않았다.★
#  그래서 서명 두 줄을 넣고도 통과했다 — ★가드가 막으려던 "누가 승인했는지 갈리는" 상태 그대로.★
#  ★잡는 그물(중복)은 넓게, 인정하는 형식(서명)은 좁게.★
LOOSE_TRAILER = re.compile(r"^[ \t>*_`#\-]*approved-by[ \t]*:", re.I | re.M)


def strip_examples(body: str) -> str:
    """★닫힌 코드펜스·닫힌 HTML 주석 안은 '예시' 다★ — 서명 후보에서 뺀다.

    ★왜 필요한가★ (하네스 실측 2026-07-29): 중복 검사가 본문 전체를 세다 보니
    ★규약을 알려주는 SKILL.md 의 형식 예시를 인용하면 '서명이 두 줄' 로 막혔다.★
    ★규칙을 지키려고 문서를 인용한 사람이 막히는 형태다.★
    """
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    out, in_fence = [], False
    for line in body.split("\n"):
        if re.match(r"^[ \t]*(?:```|~~~)", line):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return "\n".join(out)


def ambiguous_markup(body: str):
    """★사람이 보는 화면과 이 도구가 읽는 원문이 갈릴 수 있으면 (True, 이유).★

    ★이 게이트의 결함은 전부 이 한 가지 부류였다★ (하네스 실측 2026-07-29):
      · 안 닫힌 코드펜스 → 화면엔 예시로 보이는데 원문에선 ★마지막 줄★ 이라 서명이 된다
      · 안 닫힌 `<!--`   → ★화면에서는 통째로 사라지는데★ 원문에는 남아 서명이 된다
    변종마다 막지 않고 ★'갈릴 수 있는 상태' 자체를 거부한다★ — 이 파일의 계약이 '모르면 막는다' 다.
    """
    if len(re.findall(r"^[ \t]*(?:```|~~~)", body, re.M)) % 2:
        return True, ("the approval body has an UNCLOSED code fence (``` or ~~~) — "
                      "what a reader sees and what this tool reads can differ, so the signature is not trusted; "
                      "close the fence and re-approve")
    if body.count("<!--") != body.count("-->"):
        return True, ("the approval body has an UNBALANCED HTML comment (<!-- without -->) — "
                      "a signature can be hidden from the rendered view; "
                      "close the comment and re-approve")
    return False, ""


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

    ★이스케이프된 개행도 되돌린다★ — 한 번 뺐다가 ★실측으로 되돌렸다★:
      ames 가 "GitHub API 응답은 json.loads 에서 이미 복원되므로 불필요" 라 했고 나도 받아들였다.
      ★우리 데이터에서는 거짓이었다★ — 하네스가 전수 조사: ★PR#103 승인 본문은 진짜 개행 0개,
      리터럴 `\n` 두 글자가 11개★ 다. 우리 팀 도구 중 그런 본문을 만드는 게 있다.
      정규화가 없으면 그런 본문은 ★전체가 한 줄★ 이라 ★서명 자체가 불가능★ 해진다.
      ★"규격상 그럴 리 없다" 가 아니라 실제 데이터를 세어야 한다.★
    """
    body = body.replace("\\r\\n", "\n").replace("\\n", "\n")
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


def why_no_approval(reviews, final_states) -> str:
    """★'승인 없음' 의 원인을 갈라서 말한다.★

    ★왜★ (하네스 실측 2026-07-29): 서로 다른 세 원인이 ★완전히 같은 문장★ 을 내고 있었고,
    그 문장은 ★"나중 CHANGES_REQUESTED 가 앞선 승인을 덮었다"★ 라고 ★원인을 단언★ 했다.
    라이브 브랜치 보호가 `dismiss_stale_reviews: true` 라 ★push 할 때마다 승인이 폐기된다★ —
    ★가장 흔한 실패에 대해 게이트가 틀린 원인을 말하고 있었다.★
    """
    if not reviews:
        return "no review on this PR at all — request a review and get an approval first"
    if any(s == "DISMISSED" for s in final_states):
        return ("the approval was DISMISSED — a push after the approval dismisses it "
                "(branch protection: dismiss_stale_reviews). Ask for a re-approval on the current commits")
    if any(s == "CHANGES_REQUESTED" for s in final_states):
        return "the approval was withdrawn — a later CHANGES_REQUESTED supersedes the earlier approval"
    return "no standing approval on this PR (reviews exist, but none of them is a current APPROVED)"


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
        return False, ("settings missing: " + ", ".join(missing) +
                       " — set with: curl -X PUT -H 'Content-Type: application/json' "
                       "-d '{\"github_team_account\":\"...\",\"github_approver_account\":\"...\",\"merge_approvers_normal\":\"bill,codex,steve\"}' "
                       "http://127.0.0.1:7878/team/api/settings   (do not hardcode)")

    # ★계정 비교는 대소문자를 가리지 않는다★ (하네스 실측 2026-07-29): GitHub 로그인은 대소문자 무관인데
    #   설정에 `GD452` 로 저장하면(PUT 검증이 대문자를 허용한다) ★그 순간부터 머지가 영구 차단★ 됐다.
    #   ★이름(Approved-by)만 소문자로 접고 계정은 안 접은 비일관★ 이 원인이었다.
    if team.lower() == appr.lower():
        return False, f"author account and approver account are the same ({team}) — the review requirement cannot hold"
    if not author:
        # ★조회 실패·빈값을 통과시키지 않는다★ (ames BLOCKER) — 이 도구의 계약은 '모르면 막는다' 다.
        return False, "PR author unknown (lookup failed or empty) — cannot verify the author account"
    if author.lower() != team.lower():
        return False, (f"PR author is {author}, expected the team account {team} — "
                       f"recreate the PR with the team account (a PR authored by the approver account cannot be approved)")

    approvals = standing_approvals(reviews)
    # ★승인 계정의 승인 하나를 찾는다★ — 남의 승인은 세지 않되 ★조용히 버리지도 않는다.★
    #   ★왜 바꿨나★ (하네스 실측 2026-07-29): 예전엔 '모든 승인이 승인 계정이어야' 통과였다.
    #   ★이 저장소는 public 이라 아무나 APPROVED 를 남길 수 있고★, 그러면 gd452 가 규격대로 서명해도
    #   ★하드 실패★ 했다. 게다가 메시지가 "승인 계정에서 승인이 안 왔다" 로 읽혀 ★원인을 정반대로 지목★ 했다.
    #   자격은 여전히 승인 계정에만 있다 — 남의 승인은 ★통과의 근거가 되지 못한다.★
    mine = [(a, r) for a, r in approvals if a.lower() == appr.lower()]
    others = sorted({a for a, _ in approvals if a.lower() != appr.lower()})
    if not mine:
        if others:
            return False, (f"no approval from the approver account {appr} — "
                           f"these accounts approved but do not count: {', '.join(others)}")
        states = [(r.get("state") or "") for r in
                  {((rr.get("user") or {}).get("login")) or "?": rr
                   for rr in sorted([x for x in reviews if isinstance(x, dict)],
                                    key=lambda x: x.get("submitted_at") or "")}.values()]
        return False, why_no_approval(reviews, states)

    signed = []
    for acct, r in mine:
        # ★set 이 아니라 줄 수를 센다★ (ames): 같은 이름이 두 줄이어도 set 은 1개로 접혀
        #   ★'서명이 여럿' 검사를 조용히 통과했다.★
        body = (r.get("body") or "").replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n")

        # ★화면과 원문이 갈릴 수 있으면 여기서 멈춘다★ — 서명을 읽기 전에 본다.
        bad, why = ambiguous_markup(body)
        if bad:
            return False, why

        # ★예시(닫힌 펜스·닫힌 주석)를 뺀 뒤에 센다★ — 규약 문서를 인용해도 막히지 않게.
        candidate = strip_examples(body)

        # ★서명 모양이 둘 이상이면 모호하다★ (ames): 마지막 줄만 보면 앞의 것이 조용히 무시돼
        #   ★누가 승인했는지가 갈린다.★ ★엄격 형식이 아니라 '시도한 줄' 을 센다★ — 엄격 정규식으로 세면
        #   백슬래시로 끝나는 줄이 안 세어져 ★두 줄을 넣고도 통과★ 했다(하네스 실측).
        attempts = LOOSE_TRAILER.findall(candidate)
        if len(attempts) > 1:
            shown = ", ".join(sorted({h.strip().lower() for h in TRAILER.findall(candidate)})) or "(unparsable)"
            return False, (f"the approval has more than one Approved-by line ({len(attempts)}): {shown} — "
                           "leave exactly one, on the final line")

        tail = last_line(candidate)
        names = [h.lower() for h in TRAILER.findall(tail)]
        if not names:
            if LOOSE_TRAILER.match(tail):
                # ★'모양은 맞는데 안 맞다' 를 구분해 말한다★ — 사용자 눈에는 정확히 그 줄이다.
                #   실측으로 확인된 것: @멘션 · ✦ 같은 기호 · NBSP · 전각공백 · **볼드** · 리스트 하이픈
                return False, (f"the last line looks like a signature but does not match exactly: {tail!r} — "
                               "it must be exactly 'Approved-by: <name>' with no @, bold, list marker, "
                               "trailing punctuation, emoji, or non-breaking/full-width space")
            return False, ("the LAST line of the approval is not 'Approved-by: <name>' — "
                           "put it on the final line (a signature elsewhere in the body is not read; "
                           "the account is shared, so the account alone does not say who reviewed)")
        # (여기서 len(names) > 1 은 ★불가능★ 하다 — last_line 은 한 줄이다.
        #  중복은 위 all_hits 에서 이미 걸렀다. ★실패할 수 없는 검사는 두지 않는다.★)
        if names[0] not in pool:
            return False, f"Approved-by: {names[0]} is not in merge_approvers_normal ({', '.join(pool)})"
        signed.append(names[0])

    # ★남의 승인이 있었으면 통과할 때도 말한다★ — 조용히 버리면 '없었던 것' 이 된다.
    extra = f" [ignored approvals from: {', '.join(others)}]" if others else ""
    return True, f"approved by {', '.join(signed)} (account {appr}, author {author}){extra}"


def main() -> int:
    """stdin 으로 {settings, reviews, pr_author} 를 받는다. ★argv 가 아니다★ — 리뷰가 많으면 E2BIG 이 난다."""
    try:
        payload = json.load(sys.stdin)
        ok, msg = check(payload.get("settings") or {}, payload.get("reviews"), payload.get("pr_author"))
    except Exception as e:  # 판정 자체가 실패한 것 — 통과가 아니다
        print(f"FAIL\tapprover check could not run: {e}")
        return 1
    print(("OK\t" if ok else "FAIL\t") + msg)
    # ★FAIL 이면 종료코드도 실패다★ (하네스 실측 2026-07-29): 예전엔 FAIL 도 0 이라
    #   ★`if approver-check.py; then merge; fi` 로 쓰면 조용히 통과★ 했다.
    #   지금 호출부(release-preflight.sh)는 stdout 접두사를 보므로 이 변경에 영향받지 않는다.
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

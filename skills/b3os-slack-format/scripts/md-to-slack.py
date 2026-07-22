#!/usr/bin/env python3
"""md-to-slack — 마크다운/평문을 Slack mrkdwn 으로 변환 (팀원이 슬랙 게시 전 읽기 좋게).

Slack mrkdwn 은 마크다운과 다르다 (핵심 차이):
  - 볼드 = *text* (별 1개. **text** 아님)
  - 이탤릭 = _text_  · 취소선 = ~text~
  - 헤더(#, ##) 없음 → *볼드 줄* 로
  - 불릿 = •  (- · * 를 • 로)
  - 링크 = <url|텍스트>  ([텍스트](url) 변환)
  - 코드 `x` / 코드블록 ```x``` 는 그대로

사용:
  bash/py 로  echo "..." | python3 md-to-slack.py
  python3 md-to-slack.py < input.md
  python3 md-to-slack.py input.md
출력: 변환된 Slack mrkdwn (stdout). 그대로 /api/slack/post 의 text 로 쓰면 된다.
"""
import sys, re

def convert(md: str) -> str:
    # 코드블록은 보호(변환 제외) — placeholder 로 빼뒀다 마지막에 복원
    blocks = []
    def stash(m):
        blocks.append(m.group(0))
        return f"\x00BLOCK{len(blocks)-1}\x00"
    md = re.sub(r"```[\s\S]*?```", stash, md)
    # 인라인 코드도 보호
    inlines = []
    def stash_i(m):
        inlines.append(m.group(0))
        return f"\x00INL{len(inlines)-1}\x00"
    md = re.sub(r"`[^`]+`", stash_i, md)

    out_lines = []
    for line in md.split("\n"):
        s = line
        # 헤더 (#, ##, ###) → *볼드*
        h = re.match(r"^\s{0,3}(#{1,6})\s+(.*)$", s)
        if h:
            s = f"*{h.group(2).strip()}*"
            out_lines.append(s)
            continue
        # 수평선 --- / *** → 구분선
        if re.match(r"^\s{0,3}([-*_])\1{2,}\s*$", s):
            out_lines.append("──────────")
            continue
        # 불릿 (-, *, +) → •  (들여쓰기 유지)
        b = re.match(r"^(\s*)[-*+]\s+(.*)$", s)
        if b:
            s = f"{b.group(1)}• {b.group(2)}"
        out_lines.append(s)
    md = "\n".join(out_lines)

    # 링크 [텍스트](url) → <url|텍스트>
    md = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"<\2|\1>", md)
    # 볼드 **x** / __x__ → *x*  (이미 *x* 인 단일별은 건드리지 않음)
    md = re.sub(r"\*\*([^*]+)\*\*", r"*\1*", md)
    md = re.sub(r"__([^_]+)__", r"*\1*", md)

    # 보호분 복원
    for i, c in enumerate(inlines):
        md = md.replace(f"\x00INL{i}\x00", c)
    for i, c in enumerate(blocks):
        md = md.replace(f"\x00BLOCK{i}\x00", c)
    return md

def main():
    if len(sys.argv) > 1 and sys.argv[1] not in ("-", ""):
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            md = f.read()
    else:
        md = sys.stdin.read()
    sys.stdout.write(convert(md))

if __name__ == "__main__":
    main()

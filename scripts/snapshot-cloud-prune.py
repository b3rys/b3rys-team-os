#!/usr/bin/env python3
"""snapshot-cloud-prune.py <폴더> <남길 개수> [제한초] — 기기 밖(iCloud) 폴더의 b3os 스냅샷을 최신 N개만 남긴다.

폴더 바로 아래의 ★일반 파일★ 중 이름이 정확히 b3os-snapshot-YYYYMMDD-HHMMSS.tar.gz 인 것만 대상이다.
같은 이름의 폴더·링크·하위 폴더 안 파일은 건드리지 않는다. 이름이 시각순이라 이름으로 정렬한다.
조회·삭제를 이 한 프로세스에서 하고, 제한 시간이 지나면 이 프로세스가 멈춘다 — 멈춘 뒤 다른 프로세스가 지우는 일이 없다.
"""
import os
import re
import signal
import sys

NAME = re.compile(r"\Ab3os-snapshot-\d{8}-\d{6}\.tar\.gz\Z")


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("사용: snapshot-cloud-prune.py <폴더> <남길 개수> [제한초]", file=sys.stderr)
        return 2
    folder, keep_s = argv[1], argv[2]
    limit = int(argv[3]) if len(argv) > 3 else 60
    if not keep_s.isdigit() or int(keep_s) < 1:
        print(f"남길 개수가 1 이상의 숫자가 아니다: {keep_s}", file=sys.stderr)
        return 2
    keep = int(keep_s)

    def timeout(_sig, _frm):
        raise TimeoutError(f"{limit}초 안에 끝나지 않았다")

    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(limit)
    if not os.path.isdir(folder):
        return 0
    with os.scandir(folder) as it:
        snaps = sorted(
            (e for e in it if NAME.match(e.name) and e.is_file(follow_symlinks=False)),
            key=lambda e: e.name,
            reverse=True,
        )
    for e in snaps[keep:]:
        os.unlink(e.path)
        print(f"  기기밖 삭제(로테이션): {e.name}")
    signal.alarm(0)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except TimeoutError as err:
        print(f"  기기밖 정리 중단: {err}", file=sys.stderr)
        sys.exit(124)

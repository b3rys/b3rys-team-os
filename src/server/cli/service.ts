#!/usr/bin/env bun
// b3os 서버 상시가동(LaunchAgent) 관리 CLI — ★선택 기능★.
//   등록하지 않아도 b3os 는 완전히 동작한다(`bun run start`). 이건 "원하는 사람만" 켜는 옵션이다.
//
//   사용:
//     bun run service status      # 현재 등록/로드 상태
//     bun run service install     # 재부팅해도 계속 돌게 등록(+ 즉시 기동)
//     bun run service restart     # 등록돼 있을 때만 재시작
//     bun run service uninstall   # 등록 해제(되돌리기)
//
//   ★src/ 아래에 두는 이유: 퍼블릭 릴리즈는 /scripts/ 를 제외한다. 스킬(Claude Code/Codex)이 실행할
//   커맨드를 scripts/ 에 두면 퍼블릭 클론에서 없는 파일을 호출하게 된다. src/ + package.json 진입점이라야 안전하다.
import { install, uninstall, restart, status } from "../lib/serverService";

const USAGE = `b3os 서버 상시가동 관리 (선택 기능 — 등록 안 해도 b3os 는 정상 동작합니다)

  bun run service status      현재 상태
  bun run service install     재부팅해도 계속 돌게 등록 (+ 즉시 기동)
  bun run service restart     재시작 (등록된 경우에만)
  bun run service uninstall   등록 해제
`;

function printStatus(): void {
  const s = status();
  if (!s.supported) {
    console.log("이 플랫폼에서는 launchd 상시가동을 지원하지 않습니다(macOS 전용).");
    console.log("서버는 `bun run start` 로 직접 띄워 사용하세요.");
    return;
  }
  console.log(`라벨   : ${s.label}`);
  console.log(`plist  : ${s.plist}`);
  console.log(`등록   : ${s.installed ? "✅ 등록됨" : "— 등록 안 됨(기본값)"}`);
  console.log(`실행   : ${s.loaded ? "✅ launchd 로 실행 중" : "— launchd 에 없음"}`);
  if (!s.installed) {
    console.log("");
    console.log("등록하지 않아도 됩니다. `bun run start` 로 쓰시면 됩니다.");
    console.log("재부팅해도 자동으로 뜨게 하려면: bun run service install");
  }
}

const cmd = (process.argv[2] ?? "status").trim();

switch (cmd) {
  case "status":
    printStatus();
    break;
  case "install": {
    const r = install();
    console.log(r.ok ? `✅ ${r.message}` : `❌ ${r.message}`);
    if (!r.ok) process.exit(1);
    break;
  }
  case "restart": {
    const r = restart();
    console.log(r.ok ? `✅ ${r.message}` : `❌ ${r.message}`);
    if (!r.ok) process.exit(1);
    break;
  }
  case "uninstall": {
    const r = uninstall();
    console.log(r.ok ? `✅ ${r.message}` : `❌ ${r.message}`);
    if (!r.ok) process.exit(1);
    break;
  }
  default:
    console.log(USAGE);
    process.exit(cmd === "-h" || cmd === "--help" ? 0 : 1);
}

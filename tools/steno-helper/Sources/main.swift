import Darwin
import Foundation

// Steno 도우미 — 문서 폴더 권한을 가진 프로그램은 이것 하나다. 한 번 돌 때 세 일을 차례로 한다.
//   1. 받은 파일 넣기: outbox → <라이브러리>/받은 파일 (Inbox.swift)
//   2. 팀 공유 올리기: steno-share-outbox → <라이브러리>/팀 공유 (ShareUpload.swift)
//   3. 팀 공유 복사: <라이브러리>/팀 공유 → 팀 폴더 steno-shared (Share.swift, 라이브러리는 읽기만)
// 하나가 실패해도 다른 하나는 돈다. 종료 코드는 하나라도 실패하면 1.

// Prepare and pin the message before installing the async-signal-safe handler.
private let watchdogBytes: [UInt8] = Array("steno-helper: 주기가 제한 시간을 넘겨 중단함 (iCloud 내려받기·권한 대기 의심)\n".utf8)
private let watchdogLength = watchdogBytes.count
private let watchdogPointer: UnsafeMutablePointer<UInt8> = {
    let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: watchdogLength)
    watchdogBytes.withUnsafeBufferPointer { pointer.initialize(from: $0.baseAddress!, count: watchdogLength) }
    return pointer
}()

private func startWatchdog(_ seconds: UInt32) {
    _ = watchdogPointer // Initialize globals before any signal can arrive.
    signal(SIGALRM) { _ in
        _ = write(STDERR_FILENO, watchdogPointer, watchdogLength)
        _exit(1)
    }
    alarm(seconds)
}

#if STENO_HELPER_TESTING
let args = CommandLine.arguments
if args.count == 3, args[1] == "--validate-name" { exit(validName(args[2]) ? 0 : 1) }
if args.count == 3, args[1] == "--cycle" {
    let env = ProcessInfo.processInfo.environment
    if let value = env["STENO_HELPER_TEST_ALARM"], let seconds = UInt32(value), seconds > 0 { startWatchdog(seconds) }
    exit(runCycle(home: args[2], env: env))
}
if args.count == 3, args[1] == "--resolve" {
    guard let library = resolveLibrary(home: args[2], env: ProcessInfo.processInfo.environment) else { exit(1) }
    print(library)
    exit(0)
}
guard args.count == 4 else { exit(64) }
switch args[1] {
case "--inbox": exit(runInbox(sourcePath: args[2], destinationPath: args[3]))
case "--upload": exit(runShareUpload(sourcePath: args[2], libraryPath: args[3]))
case "--share": exit(runShare(sourcePath: args[2], destinationPath: args[3]))
default: exit(64)
}
#else
// 한 주기가 멈추면 launchd 는 같은 작업을 다시 띄우지 않는다. 20초 넘게 걸리면 기록하고 끝내서 다음 주기가 돌게 한다.
startWatchdog(20)
exit(runCycle(home: NSHomeDirectory(), env: ProcessInfo.processInfo.environment))
#endif

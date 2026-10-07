import Foundation

// Steno 도우미 — 문서 폴더 권한을 가진 프로그램은 이것 하나다. 한 번 돌 때 세 일을 차례로 한다.
//   1. 받은 파일 넣기: outbox → <라이브러리>/받은 파일 (Inbox.swift)
//   2. 팀 공유 올리기: steno-share-outbox → <라이브러리>/팀 공유 (ShareUpload.swift)
//   3. 팀 공유 복사: <라이브러리>/팀 공유 → 팀 폴더 steno-shared (Share.swift, 라이브러리는 읽기만)
// 하나가 실패해도 다른 하나는 돈다. 종료 코드는 하나라도 실패하면 1.

#if STENO_HELPER_TESTING
let args = CommandLine.arguments
if args.count == 3, args[1] == "--watch-proposal-log" {
    let log = URL(fileURLWithPath: args[2])
    FileManager.default.createFile(atPath: log.path, contents: Data())
    let observer = DistributedNotificationCenter.default().addObserver(forName: .init("com.b3rys.steno.mcp.proposal"), object: nil, queue: nil) { note in
        if let id = note.object as? String, let handle = try? FileHandle(forWritingTo: log) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd(); try? handle.write(contentsOf: Data((id + "\n").utf8))
        }
    }
    try? Data("ready".utf8).write(to: URL(fileURLWithPath: log.path + ".ready"))
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        if let data = try? Data(contentsOf: log), !data.isEmpty { break }
    }
    DistributedNotificationCenter.default().removeObserver(observer)
    exit(0)
}
if args.count == 3, args[1] == "--merge-table" {
    struct Row: Decodable { let name: String; let base: String; let current: String; let proposed: String; let expected: String }
    do {
        struct Table: Decodable { let version: Int; let cellLimit: Int; let cases: [Row] }
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
        guard table.version == 1 && table.cellLimit == 4_000_000 else { exit(1) }
        let rows = table.cases
        for row in rows {
            let actual = try mergeLines(base: row.base, current: row.current, proposed: row.proposed)
            guard actual.utf8.elementsEqual(row.expected.utf8) else { fputs("FAIL: merge \(row.name)\n", stderr); exit(1) }
        }
        print("PASS: \(rows.count) shared Swift merge rows"); exit(0)
    } catch { fputs("FAIL: merge table \(error)\n", stderr); exit(1) }
}
if args.count == 3, args[1] == "--validate-name" { exit(validName(args[2]) ? 0 : 1) }
guard args.count == 4 else { exit(64) }
switch args[1] {
case "--inbox": exit(runInbox(sourcePath: args[2], destinationPath: args[3]))
case "--upload": exit(runShareUpload(sourcePath: args[2], libraryPath: args[3]))
case "--share": exit(runShare(sourcePath: args[2], destinationPath: args[3]))
default: exit(64)
}
#else
let home = NSHomeDirectory()
let support = home + "/Library/Application Support/b3os"
// 받은 파일 경로는 예전처럼 소스에 고정한다(실행 인자·환경으로 바꿀 수 없다).
let inbox = runInbox(sourcePath: support + "/steno-outbox", destinationPath: home + "/Documents/Steno/받은 파일")
// 팀 공유는 Steno 앱과 같은 규칙으로 라이브러리를 정한다: STENO_LIBRARY → ~/Documents/Steno.
let env = ProcessInfo.processInfo.environment["STENO_LIBRARY"] ?? ""
let library = env.hasPrefix("/") ? env : home + "/Documents/Steno"
let upload = runShareUpload(sourcePath: support + "/steno-share-outbox", libraryPath: library)
let share = runShare(sourcePath: library + "/팀 공유", destinationPath: support + "/steno-shared")
exit(inbox == 0 && upload == 0 && share == 0 ? 0 : 1)
#endif

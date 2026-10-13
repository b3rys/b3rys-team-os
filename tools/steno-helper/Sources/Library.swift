import Darwin
import Foundation

private func libraryLog(_ message: String) {
    FileHandle.standardError.write(Data("steno-helper 라이브러리: \(message)\n".utf8))
}

private func libraryLocationRecord(home: String) -> String? {
    let parent = canonicalDirectory(home + "/Library/Application Support/Steno")
    guard parent >= 0 else {
        libraryAccessFailure("앱 기록", "부모 폴더를 안전하게 열 수 없음", errno)
        return nil
    }
    defer { close(parent) }
    let fd = openat(parent, "library-location.json", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else {
        libraryAccessFailure("앱 기록", "링크 또는 읽기 실패", errno)
        return nil
    }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else {
        libraryAccessFailure("앱 기록", "파일 정보 읽기 실패", errno)
        return nil
    }
    guard (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == getuid(), info.st_nlink == 1, info.st_size <= 65536 else {
        libraryLog("앱 기록 거절: 일반 파일·소유자·링크 수·64KB 상한 조건")
        return nil
    }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 65537)
    while true {
        let count = read(fd, &buffer, buffer.count)
        if count == 0 { break }
        guard count > 0, data.count + count <= 65536 else {
            libraryAccessFailure("앱 기록", "읽기 실패 또는 64KB 초과", count < 0 ? errno : EFBIG)
            return nil
        }
        data.append(buffer, count: count)
    }
    guard let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let path = record["path"] as? String else {
        libraryLog("앱 기록 거절: JSON 파싱 실패 또는 path 문자열 없음")
        return nil
    }
    // bookmark는 앱 전용 보안 범위 정보이므로 사용하지 않는다.
    return path
}

private func libraryAccessFailure(_ label: String, _ reason: String, _ error: Int32) {
    if error == EPERM || error == EACCES {
        libraryLog("\(label) 거절: 권한 없음 — 시스템 설정 › 개인정보 › 파일 및 폴더에서 steno-helper 허용 필요")
    } else {
        libraryLog("\(label) 거절: \(reason)")
    }
}

// 매 주기 다시 읽는다. 외부 후보를 정규화해 링크나 상대 경로를 숨기지 않는다.
func resolveLibrary(home: String, env: [String: String]) -> String? {
    let candidates: [(String, String?)] = [
        ("앱 기록", libraryLocationRecord(home: home)),
        ("STENO_LIBRARY", env["STENO_LIBRARY"]),
        ("iCloud 기본값", home + "/Library/Mobile Documents/iCloud~com~b3rys~steno/Documents"),
        ("문서 기본값", home + "/Documents/Steno"),
    ]
    for (label, candidate) in candidates {
        guard let path = candidate else { continue }
        guard path.hasPrefix("/"), path.utf8.count <= 1024,
              !path.contains("\0"), !path.unicodeScalars.contains(where: { CharacterSet.newlines.contains($0) }) else {
            libraryLog("\(label) 거절: 절대 경로·줄바꿈·NUL·1024바이트 상한 조건")
            continue
        }
        let directory = canonicalDirectory(path)
        guard directory >= 0 else {
            libraryAccessFailure(label, "실제 디렉터리 아님 또는 경로 구성요소가 링크/비정규 경로", errno)
            continue
        }
        close(directory)
        return path
    }
    return nil
}

func runCycle(home: String, env: [String: String]) -> Int32 {
    guard let library = resolveLibrary(home: home, env: env) else { return 1 }
    let support = home + "/Library/Application Support/b3os"
    // 실행 인자로 경로를 바꿀 수 없다. 앱 기록 → 명시한 환경 대체값 → iCloud → 문서 기본값으로 결정한다.
    let inbox = runInbox(sourcePath: support + "/steno-outbox", destinationPath: library + "/받은 파일")
    let upload = runShareUpload(sourcePath: support + "/steno-share-outbox", libraryPath: library)
    let share = runShare(sourcePath: library + "/팀 공유", destinationPath: support + "/steno-shared")
    return inbox == 0 && upload == 0 && share == 0 ? 0 : 1
}

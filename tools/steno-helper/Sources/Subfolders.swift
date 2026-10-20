import Darwin
import Foundation

// 팀 공유·받은 파일 아래 하위 폴더(GD 10-20 "스티브랑 작업할 때 폴더 구분이 필요해").
// 앱의 다른 폴더와 같은 깊이 — 라이브러리 3단계(steno-config folders.maxLibraryDepth=3) = 팀 공유/폴더/폴더 —, 숨김·비밀 이름은 건너뛴다. 모든 단계를 O_NOFOLLOW 로 열어 링크를 따라가지 않는다.

let maxFolderDepth = 2
let sensitiveWords = ["secret", "credential", "token", "password"]

func sensitiveName(_ name: String) -> Bool {
    let lower = name.lowercased()
    return sensitiveWords.contains(where: { lower.contains($0) })
}

func validFolderName(_ name: String) -> Bool {
    !name.isEmpty && name != "." && name != ".." && !name.hasPrefix(".") && !name.contains("/") &&
        !name.contains("\0") && name.utf8.count <= 255 && !sensitiveName(name)
}

// "A/B" → ["A", "B"]. 빈 문자열은 맨 위([]). 단계 수나 이름이 맞지 않으면 nil.
func folderComponents(_ path: String) -> [String]? {
    if path.isEmpty { return [] }
    let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count <= maxFolderDepth, parts.allSatisfy(validFolderName) else { return nil }
    return parts
}

// base 아래 components 를 차례로 연다. create 면 없는 단계를 만든다. 실패하면 -1(base 는 닫지 않는다).
func openSubdirectory(_ base: Int32, _ components: [String], create: Bool, mode: mode_t = 0o755) -> Int32 {
    var current = dup(base)
    guard current >= 0 else { return -1 }
    for name in components {
        if create && mkdirat(current, name, mode) != 0 && errno != EEXIST { close(current); return -1 }
        let next = openat(current, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        close(current)
        guard next >= 0 else { return -1 }
        current = next
    }
    return current
}

func isDirectoryEntry(_ dir: Int32, _ name: String) -> Bool {
    var info = stat()
    return fstatat(dir, name, &info, AT_SYMLINK_NOFOLLOW) == 0 && (info.st_mode & S_IFMT) == S_IFDIR
}

// outbox 의 하위 폴더를 따라가며 파일마다 handle(폴더 fd, 이름, 폴더 단계)을 부른다.
// 다 비운 하위 폴더는 지운다(비어 있지 않으면 rmdir 이 실패해 남는다). 폴더가 아닌 것과 숨김 폴더는 handle 에 그대로 넘긴다.
func walkOutbox(_ dir: Int32, _ prefix: [String], _ names: [String],
                handle: (Int32, String, [String]) -> Bool, list: (Int32) -> [String]?) -> Bool {
    var ok = true
    for name in names where name != "." && name != ".." {
        if !name.hasPrefix("."), isDirectoryEntry(dir, name) {
            guard validFolderName(name), prefix.count < maxFolderDepth else {
                FileHandle.standardError.write(Data("steno-helper: 폴더 이름·단계 거절: \((prefix + [name]).joined(separator: "/"))\n".utf8))
                ok = false; continue
            }
            let child = openat(dir, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard child >= 0, let childNames = list(child) else { if child >= 0 { close(child) }; ok = false; continue }
            if !walkOutbox(child, prefix + [name], childNames, handle: handle, list: list) { ok = false }
            close(child)
            _ = unlinkat(dir, name, AT_REMOVEDIR)
            continue
        }
        if !handle(dir, name, prefix) { ok = false }
    }
    return ok
}

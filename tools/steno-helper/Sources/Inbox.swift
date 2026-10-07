// 받은 파일 넣기: steno-send.sh 가 권한 없는 outbox 에 둔 파일을 Steno "받은 파일" 로 옮긴다.
import Darwin
import Foundation

enum HelperSystemFolder: CaseIterable {
    case received, team
    static let table: [Self: (name: String, marker: String)] = [
        .received: ("받은 파일", "received"), .team: ("팀 공유", "team")
    ]
    static let markerFile = ".steno-folder"
    static func matches(_ kind: Self, directory: Int32, path: String) -> Bool {
        let spec = table[kind]!
        guard URL(fileURLWithPath: path).lastPathComponent == spec.name else { return false }
        let fd = openat(directory, markerFile, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_size == spec.marker.utf8.count else { return false }
        var bytes = [UInt8](repeating: 0, count: spec.marker.utf8.count)
        return read(fd, &bytes, bytes.count) == bytes.count && bytes == Array(spec.marker.utf8)
    }
}

private let maxBytes: off_t = 20 * 1_048_576
private let allowedExtensions: Set<String> = [
    "md", "markdown", "txt", "text", "log", "csv", "tsv", "json", "yml", "yaml", "toml",
    "ini", "conf", "cfg", "properties", "env", "py", "rb", "go", "rs", "swift", "sh", "bash",
    "zsh", "sql", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "html", "htm", "css",
    "xml", "svg", "java", "kt", "kts", "scala", "cs", "c", "h", "cpp", "cc", "cxx", "hpp",
    "hh", "m", "png", "jpg", "jpeg", "gif", "webp", "heic", "zip",
]

private func fail(_ message: String) {
    FileHandle.standardError.write(Data(("steno-helper 받은 파일: \(message)\n").utf8))
}

func validName(_ name: String) -> Bool {
    guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\0") else { return false }
    return allowedExtensions.contains((name as NSString).pathExtension.lowercased())
}

private func collisionName(_ name: String, _ number: Int) -> String {
    guard number > 1 else { return name }
    let ns = name as NSString
    let ext = ns.pathExtension
    let stem = ns.deletingPathExtension
    return ext.isEmpty ? "\(stem) \(number)" : "\(stem) \(number).\(ext)"
}

private func sameObject(_ a: stat, _ b: stat) -> Bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino }

private func copyFile(sourceDir: Int32, destinationDir: Int32, name: String) -> Bool {
    let source = openat(sourceDir, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard source >= 0 else { fail("원본 열기 거절: \(name)"); return false }
    defer { close(source) }
    var sourceStat = stat()
    guard fstat(source, &sourceStat) == 0, (sourceStat.st_mode & S_IFMT) == S_IFREG,
          sourceStat.st_nlink == 1, sourceStat.st_size > 0, sourceStat.st_size <= maxBytes else {
        fail("원본 조건 거절: \(name)"); return false
    }

    var output: Int32 = -1
    var outputName = ""
    for n in 1...10_000 {
        let candidate = collisionName(name, n)
        output = openat(destinationDir, candidate, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        if output >= 0 { outputName = candidate; break }
        if errno != EEXIST { fail("대상 생성 실패: \(candidate)"); return false }
        var existing = stat()
        if fstatat(destinationDir, candidate, &existing, AT_SYMLINK_NOFOLLOW) == 0,
           (existing.st_mode & S_IFMT) == S_IFLNK { fail("대상 심볼릭 링크 거절: \(candidate)"); return false }
    }
    guard output >= 0 else { fail("파일 이름 충돌 한도 초과: \(name)"); return false }
    var keepOutput = false
    defer {
        var outputStat = stat(); _ = fstat(output, &outputStat); close(output)
        if !keepOutput {
            var pathStat = stat()
            if fstatat(destinationDir, outputName, &pathStat, AT_SYMLINK_NOFOLLOW) == 0, sameObject(outputStat, pathStat) {
                _ = unlinkat(destinationDir, outputName, 0)
            }
        }
    }

    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    var total: off_t = 0
    while true {
        let count = read(source, &buffer, buffer.count)
        if count == 0 { break }
        guard count > 0 else { fail("원본 읽기 실패: \(name)"); return false }
        total += off_t(count)
        guard total <= maxBytes else { fail("복사 중 크기 초과: \(name)"); return false }
        var offset = 0
        while offset < count {
            let written = buffer.withUnsafeBytes { write(output, $0.baseAddress!.advanced(by: offset), count - offset) }
            guard written > 0 else { fail("대상 쓰기 실패: \(outputName)"); return false }
            offset += written
        }
    }
    guard fsync(output) == 0 else { fail("대상 동기화 실패: \(outputName)"); return false }
    var currentStat = stat()
    guard fstatat(sourceDir, name, &currentStat, AT_SYMLINK_NOFOLLOW) == 0, sameObject(sourceStat, currentStat),
          unlinkat(sourceDir, name, 0) == 0 else { fail("복사 후 원본이 바뀌어 결과를 취소함: \(name)"); return false }
    keepOutput = true
    return true
}

func runInbox(sourcePath: String, destinationPath: String) -> Int32 {
    // Create only the final folder under an already-existing canonical parent.
    if !FileManager.default.fileExists(atPath: destinationPath) {
        let target = URL(fileURLWithPath: destinationPath)
        let parent = target.deletingLastPathComponent().path
        guard let resolvedParent = realpath(parent, nil) else { fail("받은 파일 상위 폴더 없음"); return 1 }
        let canonicalParent = String(cString: resolvedParent)
        free(resolvedParent)
        guard canonicalParent == parent else { fail("받은 파일 상위 경로가 링크임"); return 1 }
        let parentFD = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parentFD >= 0 else { return 1 }
        defer { close(parentFD) }
        guard mkdirat(parentFD, target.lastPathComponent, 0o700) == 0 else { fail("받은 파일 생성 실패"); return 1 }
        let folderFD = openat(parentFD, target.lastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard folderFD >= 0 else { return 1 }
        defer { close(folderFD) }
        let markerFD = openat(folderFD, HelperSystemFolder.markerFile, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard markerFD >= 0 else { fail("받은 파일 표시 생성 실패"); return 1 }
        defer { close(markerFD) }
        let marker = Array(HelperSystemFolder.table[.received]!.marker.utf8)
        guard marker.withUnsafeBytes({ write(markerFD, $0.baseAddress, $0.count) }) == marker.count,
              fsync(markerFD) == 0 else { fail("받은 파일 표시 쓰기 실패"); return 1 }
    }
    guard let resolvedDestination = realpath(destinationPath, nil) else { fail("받은 파일 폴더를 확인할 수 없음"); return 1 }
    defer { free(resolvedDestination) }
    guard String(cString: resolvedDestination) == destinationPath else { fail("받은 파일 폴더가 심볼릭 링크이거나 경로가 바뀜"); return 1 }
    let sourceDir = open(sourcePath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard sourceDir >= 0 else { fail("outbox 열기 실패"); return 1 }
    defer { close(sourceDir) }
    let destinationDir = open(destinationPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard destinationDir >= 0 else { fail("받은 파일 폴더 열기 실패"); return 1 }
    defer { close(destinationDir) }
    guard HelperSystemFolder.matches(.received, directory: destinationDir, path: destinationPath) else {
        fail("Steno 받은 파일 표시가 없어 이번 주기는 건너뜀"); return 0
    }
    guard let directory = fdopendir(dup(sourceDir)) else { fail("outbox 읽기 실패"); return 1 }
    defer { closedir(directory) }
    var rejected = false
    while let entry = readdir(directory) {
        let name = withUnsafePointer(to: &entry.pointee.d_name) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
        }
        if name == "." || name == ".." { continue }
        guard validName(name) else { fail("파일 이름/확장자 거절: \(name)"); rejected = true; continue }
        if !copyFile(sourceDir: sourceDir, destinationDir: destinationDir, name: name) { rejected = true }
    }
    return rejected ? 1 : 0
}

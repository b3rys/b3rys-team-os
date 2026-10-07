import Darwin
import Foundation

private func uploadLog(_ message: String) {
    FileHandle.standardError.write(Data("steno-helper 팀 공유 올리기: \(message)\n".utf8))
}

// Every path component must be canonical; O_NOFOLLOW alone only checks the final one.
func canonicalDirectory(_ path: String) -> Int32 {
    guard let resolved = realpath(path, nil) else { return -1 }
    defer { free(resolved) }
    guard String(cString: resolved) == path else { errno = ELOOP; return -1 }
    return open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
}

func regularSingleLink(_ dir: Int32, _ name: String) -> stat? {
    var info = stat()
    guard fstatat(dir, name, &info, AT_SYMLINK_NOFOLLOW) == 0,
          (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1 else { return nil }
    return info
}

func removeUnchanged(_ dir: Int32, _ name: String, _ info: stat, _ data: Data) -> Bool {
    guard let current = regularSingleLink(dir, name), current.st_ino == info.st_ino,
          current.st_dev == info.st_dev, uploadReadRegular(dir, name) == data else { return false }
    return unlinkat(dir, name, 0) == 0
}

// Publish a fully written 0600 file without replacing any existing name.
func publishNew(_ dir: Int32, _ name: String, _ data: Data) -> String? {
    let temp = ".upload-\(UUID().uuidString)"
    guard uploadWriteAtomically(dir, temp, data) else { return nil }
    defer { _ = unlinkat(dir, temp, 0) }
    let ns = name as NSString
    for number in 1...10_000 {
        let candidate = number == 1 ? name : "\(ns.deletingPathExtension) \(number).\(ns.pathExtension)"
        if linkat(dir, temp, dir, candidate, 0) == 0 { return candidate }
        guard errno == EEXIST else { return nil }
        var info = stat()
        if fstatat(dir, candidate, &info, AT_SYMLINK_NOFOLLOW) != 0 || (info.st_mode & S_IFMT) != S_IFREG { return nil }
    }
    return nil
}

func runShareUpload(sourcePath: String, libraryPath: String) -> Int32 {
    let source = canonicalDirectory(sourcePath)
    guard source >= 0 else { return errno == ENOENT ? 0 : 1 }
    defer { close(source) }
    guard flock(source, LOCK_EX | LOCK_NB) == 0 else { return 1 }
    defer { _ = flock(source, LOCK_UN) }
    let library = canonicalDirectory(libraryPath)
    guard library >= 0 else { uploadLog("라이브러리 경로 거절"); return 1 }
    defer { close(library) }
    let destinationPath = libraryPath + "/팀 공유"
    let destination = openat(library, "팀 공유", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard destination >= 0 else { uploadLog("팀 공유 폴더 열기 실패"); return 1 }
    defer { close(destination) }
    guard hasTeamMarker(directory: destination, path: destinationPath) else {
        uploadLog("Steno 팀 공유 표시가 없어 건너뜀"); return 0
    }
    guard let names = uploadListNames(source) else { return 1 }
    var failed = false
    for name in names where name != "." && name != ".." {
        if name.hasPrefix(".return-") && name.hasSuffix(".json") {
            if !consumeReturn(source: source, requestName: name, destination: destination) { failed = true }
            continue
        }
        // A producer publishes data first, metadata last. Never upload a partial request.
        if name.hasPrefix(".return-") && (name.hasSuffix(".data") || name.hasSuffix(".base") || name.hasSuffix(".tmp") || name.hasSuffix(".pending")) || name.hasPrefix(".steno-send.") { continue }
        guard !name.hasPrefix("."), validName(name),
              let info = regularSingleLink(source, name), let data = uploadReadRegular(source, name), !data.isEmpty else {
            uploadLog("이름·링크·폴더·크기 조건 거절: \(name)"); failed = true; continue
        }
        guard let output = publishNew(destination, name, data) else { failed = true; continue }
        guard removeUnchanged(source, name, info, data) else {
            uploadLog("업로드 뒤 보낼 칸이 바뀌어 유지: \(name)"); failed = true; continue
        }
        uploadLog("새 파일 올림: \(output)")
    }
    return failed ? 1 : 0
}

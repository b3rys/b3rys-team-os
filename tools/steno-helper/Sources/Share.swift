import CryptoKit
import Darwin
import Foundation

// Steno "팀 공유" 폴더 아래 노트(하위 폴더 두 단계)를 팀 폴더로 한 방향 복사한다. 폴더 구조는 그대로 둔다.
// 원본 폴더에는 아무것도 쓰거나 지우지 않는다. 팀 폴더의 사본을 팀원이 고친 경우 덮지 않는다.

private let maxBytes = 20 * 1_048_576
private let manifestName = ".manifest.json"
private let allowedExtensions: Set<String> = [
    "md", "markdown", "txt", "text", "log", "csv", "tsv", "json", "yml", "yaml", "toml",
    "py", "rb", "go", "rs", "swift", "sh", "sql", "js", "ts", "tsx", "html", "htm", "css",
    "xml", "svg", "png", "jpg", "jpeg", "gif", "webp", "heic",
]

private func log(_ message: String) {
    FileHandle.standardError.write(Data(("steno-helper 팀 공유: \(message)\n").utf8))
}

func shareable(_ name: String) -> Bool {
    guard !name.isEmpty, !name.hasPrefix("."), !name.contains("/"), !name.contains("\0") else { return false }
    guard !sensitiveName(name) else { return false }
    return allowedExtensions.contains((name as NSString).pathExtension.lowercased())
}

private func readRegular(_ dir: Int32, _ name: String) -> Data? {
    guard locallyReadableRegular(dir, name) else { return nil }
    let fd = openat(dir, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= maxBytes else { return nil }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let n = read(fd, &buffer, buffer.count)
        if n == 0 { break }
        guard n > 0 else { return nil }
        watchdogProgress()
        data.append(buffer, count: n)
        guard data.count <= maxBytes else { return nil }
    }
    watchdogProgress()
    return data
}

func hasTeamMarker(directory: Int32, path: String) -> Bool {
    guard URL(fileURLWithPath: path).lastPathComponent == "팀 공유" else { return false }
    if let data = readRegular(directory, ".steno-folder"), let marker = String(data: data, encoding: .utf8) {
        return marker.trimmingCharacters(in: .whitespacesAndNewlines) == "team"
    }
    var info = stat()
    if fstatat(directory, ".steno-folder", &info, AT_SYMLINK_NOFOLLOW) == 0,
       (info.st_mode & S_IFMT) == S_IFREG, (info.st_flags & UInt32(SF_DATALESS)) != 0 {
        return true
    }
    return [".steno-folder.icloud", "..steno-folder.icloud"].contains { name in
        var info = stat()
        return fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0 && (info.st_mode & S_IFMT) == S_IFREG
    }
}

private func requestSourceDownload(_ url: URL) {
    do {
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
        log("iCloud 내려받기 요청: \(url.lastPathComponent)")
    } catch { log("iCloud 내려받기 요청 실패: \(url.lastPathComponent) (\(error.localizedDescription))") }
}

private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

// 임시 이름으로 쓴 뒤 rename 한다. 대상 이름이 링크여도 링크 자체만 바뀐다.
private func writeAtomically(_ dir: Int32, _ name: String, _ data: Data, exclusive: Bool = false) -> Bool {
    return withStenoPart(dir, data) { temp in
        exclusive ? renameatx_np(dir, temp, dir, name, UInt32(RENAME_EXCL)) == 0 : renameat(dir, temp, dir, name) == 0
    }
}

// 목록을 끝까지 읽지 못하면 nil. 부분 목록으로 "빠진 노트"를 판단하면 사본을 잘못 지운다.
private func listNames(_ dir: Int32) -> [String]? {
    guard let stream = fdopendir(dup(dir)) else { return nil }
    defer { closedir(stream) }
    var names: [String] = []
    while true {
        errno = 0
        guard let entry = readdir(stream) else { return errno == 0 ? names : nil }
        let name = withUnsafePointer(to: &entry.pointee.d_name) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
        }
        if !isStenoPart(name) { names.append(name) }
    }
}

private enum CopyState { case absent, unreadable, hash(String) }

// 사본이 없을 때만 absent. 있는데 못 읽으면(크기·권한) 덮거나 지우지 않도록 unreadable.
private func copyState(_ dir: Int32, _ name: String) -> CopyState {
    var st = stat()
    if fstatat(dir, name, &st, AT_SYMLINK_NOFOLLOW) != 0 { return errno == ENOENT ? .absent : .unreadable }
    if (st.st_mode & S_IFMT) == S_IFLNK { return .absent }  // 링크는 rename 으로 교체된다
    guard let data = readRegular(dir, name) else { return .unreadable }
    return .hash(sha256(data))
}

// manifest: 이름 → 사본을 마지막으로 만들 때의 원본 해시(base)와 지금 원본 해시(source).
private typealias Manifest = [String: [String: String]]

func runShare(sourcePath: String, destinationPath: String) -> Int32 {
    let sourceDir = open(sourcePath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard sourceDir >= 0 else {
        if errno == ENOENT { return 0 }  // 팀 공유 폴더가 아직 없으면 할 일이 없다.
        log("팀 공유 폴더 열기 실패(errno \(errno), 문서 폴더 권한 확인)"); return 1
    }
    defer { close(sourceDir) }
    guard hasTeamMarker(directory: sourceDir, path: sourcePath) else {
        log("Steno 팀 공유 표시가 없어 이번 주기는 건너뜀"); return 0
    }
    let destDir = open(destinationPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard destDir >= 0 else { log("팀 폴더 열기 실패(링크이거나 없음)"); return 1 }
    defer { close(destDir) }
    guard cleanupStenoParts(destDir) else { return 1 }

    let basesDir = childDirectory(destDir, ".bases")
    guard basesDir >= 0 else { log("기준 본문 폴더를 열지 못함"); return 1 }
    defer { close(basesDir) }
    guard cleanupStenoParts(basesDir) else { return 1 }

    var accepted: [String: String] = [:]
    var receiptInfo = stat()
    if fstatat(destDir, ".returns.json", &receiptInfo, AT_SYMLINK_NOFOLLOW) == 0 {
        guard let raw = readRegular(destDir, ".returns.json"),
              let parsed = try? JSONSerialization.jsonObject(with: raw) as? [String: String] else { return 1 }
        accepted = parsed
    } else if errno != ENOENT { return 1 }
    var manifest: Manifest = [:]
    if let raw = readRegular(destDir, manifestName),
       let parsed = try? JSONSerialization.jsonObject(with: raw) as? Manifest { manifest = parsed }

    guard let listed = listNames(sourceDir) else { log("팀 공유 목록 읽기 실패, 이번 주기는 건너뜀"); return 1 }
    var seen = Set<String>()
    var failed = false
    // 하위 폴더 목록을 하나라도 끝까지 못 읽으면 그 주기는 아무것도 지우지 않는다.
    var listedAll = true
    func syncFolder(_ sourceDir: Int32, _ destDir: Int32, _ prefix: [String], _ listed: [String]) {
    for name in listed where !name.hasPrefix(".") && isDirectoryEntry(sourceDir, name) {
        guard validFolderName(name), prefix.count < maxFolderDepth else { continue }
        let childSource = openat(sourceDir, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard childSource >= 0 else { listedAll = false; log("하위 폴더 열기 실패: \((prefix + [name]).joined(separator: "/"))"); continue }
        defer { close(childSource) }
        let childDest = childDirectory(destDir, name)
        guard childDest >= 0 else { failed = true; log("팀 폴더 하위 폴더 만들기 실패: \((prefix + [name]).joined(separator: "/"))"); continue }
        defer { close(childDest) }
        guard let childNames = listNames(childSource) else { listedAll = false; continue }
        syncFolder(childSource, childDest, prefix + [name], childNames)
    }
    for diskName in listed where shareable(diskName) {
        let name = diskName
        let relative = (prefix + [diskName]).joined(separator: "/")
        // manifest 키는 NFC 로 맞추고, 디스크 이름(폴더 포함 상대 경로)은 "file" 칸에 그대로 둔다(다른 맥에서 NFD 로 올 수 있다).
        let key = relative.precomposedStringWithCanonicalMapping
        // 목록에 있으면 "있는 노트"다. 못 읽어도 사본을 지우지 않는다.
        seen.insert(key)
        let lastReturn = manifest[key]?["lastReturn"]
        if accepted[key] != nil && accepted[key] == lastReturn { accepted[key] = nil }
        let acceptedHash = accepted[key]
        let base = acceptedHash ?? manifest[key]?["base"] ?? ""
        guard let source = readRegular(sourceDir, name) else {
            // iCloud 미다운로드 등: 지금 원본을 모르므로 되돌려 넣기가 원본 자리에 쓰지 못하게 표시한다.
            if manifest[key]?["downloadRequested"] != "1" {
                var info = stat()
                if fstatat(sourceDir, name, &info, AT_SYMLINK_NOFOLLOW) == 0, (info.st_mode & S_IFMT) == S_IFREG {
                    requestSourceDownload(URL(fileURLWithPath: sourcePath).appendingPathComponent(relative))
                }
            }
            manifest[key] = ["base": base, "source": "unreadable", "file": relative, "downloadRequested": "1"]
            if let lastReturn { manifest[key]?["lastReturn"] = lastReturn }
            log("이번엔 못 읽어 건너뜀(링크·폴더·크기·iCloud 미다운로드): \(relative)")
            continue
        }
        let sourceHash = sha256(source)
        let downloadRequested = manifest[key]?["downloadRequested"]
        var consumeAccepted = false
        switch copyState(destDir, name) {
        case .unreadable:
            manifest[key] = ["base": base, "source": sourceHash, "file": relative]
            log("사본을 읽지 못해 건드리지 않음: \(relative)")
        case .absent:
            var existing = stat()
            let replacingLink = fstatat(destDir, name, &existing, AT_SYMLINK_NOFOLLOW) == 0 && (existing.st_mode & S_IFMT) == S_IFLNK
            if !writeAtomically(destDir, name, source, exclusive: !replacingLink) { log("사본 쓰기 실패: \(relative)"); failed = true; continue }
            manifest[key] = ["base": sourceHash, "source": sourceHash, "file": relative]
            consumeAccepted = true
        case .hash(let copyHash) where copyHash == base || copyHash == sourceHash:
            // 팀원이 안 고쳤거나 이미 원본과 같다 → 원본으로 맞춘다.
            if copyHash != sourceHash, !writeAtomically(destDir, name, source) { log("사본 쓰기 실패: \(relative)"); failed = true; continue }
            manifest[key] = ["base": sourceHash, "source": sourceHash, "file": relative]
            consumeAccepted = true
        case .hash:
            consumeAccepted = true
            // 팀원이 고친 사본이 아직 되돌아가지 않았다 → 덮지 않고 지금 원본 해시만 적는다.
            manifest[key] = ["base": base, "source": sourceHash, "file": relative]
            if base != sourceHash { log("원본과 사본이 둘 다 바뀜, 사본 유지: \(relative)") }
        }
        if manifest[key]?["base"] == sourceHash {
            guard uploadWriteAtomically(basesDir, sourceHash + ".data", source) else {
                log("합치기 기준 본문 보관 실패: \(relative)"); failed = true; continue
            }
        }
        if consumeAccepted, let acceptedHash {
            manifest[key]?["lastReturn"] = acceptedHash
            accepted[key] = nil
        } else if let lastReturn { manifest[key]?["lastReturn"] = lastReturn }
        if let downloadRequested { manifest[key]?["downloadRequested"] = downloadRequested }
        watchdogProgress()
    }
    }
    syncFolder(sourceDir, destDir, [], listed)
    for key in manifest.keys where listedAll && !seen.contains(key) {
        let file = manifest[key]?["file"] ?? key
        let parts = file.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard let leaf = parts.last, let folders = folderComponents(parts.dropLast().joined(separator: "/")) else {
            log("manifest 경로 거절, 남김: \(file)"); continue
        }
        let parent = openSubdirectory(destDir, folders, create: false)
        guard parent >= 0 else {
            if errno == ENOENT { manifest[key] = nil } else { log("사본 폴더 열기 실패, 남김: \(file)") }
            continue
        }
        defer { close(parent) }
        switch copyState(parent, leaf) {
        case .absent:
            manifest[key] = nil
        case .hash(let copyHash) where copyHash == manifest[key]?["base"]:
            _ = unlinkat(parent, leaf, 0)
            manifest[key] = nil
            // 비게 된 사본 하위 폴더는 정리한다(비어 있지 않으면 rmdir 이 실패해 남는다).
            for depth in stride(from: folders.count, to: 0, by: -1) {
                let above = openSubdirectory(destDir, Array(folders.prefix(depth - 1)), create: false)
                guard above >= 0 else { break }
                let removed = unlinkat(above, folders[depth - 1], AT_REMOVEDIR) == 0
                close(above)
                if !removed { break }
            }
        default:
            log("팀 공유에서 빠졌지만 고친(또는 못 읽은) 사본이라 남김: \(file)")
        }
    }
    guard let encoded = try? JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys]),
          writeAtomically(destDir, manifestName, encoded) else { log("manifest 쓰기 실패"); return 1 }
    guard let receipts = try? JSONSerialization.data(withJSONObject: accepted, options: [.sortedKeys]),
          uploadWriteAtomically(destDir, ".returns.json", receipts) else { return 1 }
    let referenced = Set(manifest.values.compactMap { $0["base"] }.map { $0 + ".data" })
    if let snapshots = uploadListNames(basesDir) {
        for name in snapshots where name.count == 69 && name.hasSuffix(".data") && !referenced.contains(name) {
            if regularSingleLink(basesDir, name) != nil { _ = unlinkat(basesDir, name, 0) }
        }
    }
    return failed ? 1 : 0
}

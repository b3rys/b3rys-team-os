import Darwin
import Foundation

private struct SentReceipt: Codable {
    let file: String
    let sha256: String
}

private func replaceLog(_ message: String) {
    FileHandle.standardError.write(Data("steno-helper 교체: \(message)\n".utf8))
}

// Each destination directory keeps its own receipts and recoverable old contents.
// Hidden state is excluded from the team-share mirror.
private func receiptDirectory(_ target: Int32) -> Int32 {
    let state = childDirectory(target, ".steno")
    guard state >= 0 else { return -1 }
    defer { close(state) }
    return childDirectory(state, "helper-sent")
}

private func receiptName(_ name: String) -> String {
    uploadSHA256(Data(name.precomposedStringWithCanonicalMapping.utf8)) + ".json"
}

func recordSent(_ target: Int32, _ name: String, _ data: Data?) -> Bool {
    guard let data else { return false }
    return recordSentHash(target, name, uploadSHA256(data))
}

func recordSentHash(_ target: Int32, _ name: String, _ hash: String) -> Bool {
    let receipts = receiptDirectory(target)
    guard receipts >= 0 else { return false }
    defer { close(receipts) }
    let receipt = SentReceipt(file: name, sha256: hash)
    guard let encoded = try? JSONEncoder().encode(receipt) else { return false }
    return uploadWriteAtomically(receipts, receiptName(name), encoded)
}

// A complete request is the .json file. Unpublished payloads stay in the outbox.
func consumeReplacementEntry(source: Int32, name: String, destination: Int32) -> Bool {
    if name.hasSuffix(".data") || name.hasSuffix(".pending") { return true }
    guard name.hasSuffix(".json") else { return false }
    let id = String(name.dropFirst(".steno-replace-".count).dropLast(".json".count))
    guard UUID(uuidString: id) != nil,
          let requestInfo = regularSingleLink(source, name), let raw = uploadReadRegular(source, name),
          let request = try? JSONDecoder().decode(SentReceipt.self, from: raw) else { return false }
    let parts = request.file.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard let leaf = parts.last, validName(leaf),
          let folders = folderComponents(parts.dropLast().joined(separator: "/")) else {
        replaceLog("경로·이름 거절: \(request.file)"); return false
    }
    let payload = ".steno-replace-" + id + ".data"
    guard let payloadInfo = regularSingleLink(source, payload), let data = uploadReadRegular(source, payload),
          !data.isEmpty, uploadSHA256(data) == request.sha256 else {
        replaceLog("본문·해시 거절: \(request.file)"); return false
    }
    let target = openSubdirectory(destination, folders, create: true)
    guard target >= 0 else { replaceLog("대상 폴더 거절: \(request.file)"); return false }
    defer { close(target) }
    var current = stat()
    if fstatat(target, leaf, &current, AT_SYMLINK_NOFOLLOW) != 0 {
        guard errno == ENOENT else { return false }
        // Exact name only: a file appearing concurrently must never get overwritten.
        guard withStenoPart(target, data, publish: { temp in
            renameatx_np(target, temp, target, leaf, UInt32(RENAME_EXCL)) == 0
        }), recordSent(target, leaf, data) else { return false }
    } else {
        let receipts = receiptDirectory(target)
        guard receipts >= 0 else { return false }
        defer { close(receipts) }
        guard regularSingleLink(receipts, receiptName(leaf)) != nil,
              let saved = uploadReadRegular(receipts, receiptName(leaf)),
              let receipt = try? JSONDecoder().decode(SentReceipt.self, from: saved),
              receipt.file == leaf else {
            replaceLog("보낸 기록이 없는 파일이라 거절: \(request.file)"); return false
        }
        guard let oldInfo = regularSingleLink(target, leaf), let old = uploadReadRegular(target, leaf),
              uploadSHA256(old) == receipt.sha256 else {
            replaceLog("사용자 편집 또는 읽을 수 없는 대상이라 거절: \(request.file)"); return false
        }
        let state = childDirectory(target, ".steno")
        guard state >= 0 else { return false }
        defer { close(state) }
        let history = childDirectory(state, "helper-replaced")
        guard history >= 0 else { return false }
        defer { close(history) }
        let version = childDirectory(history, UUID().uuidString)
        guard version >= 0 else { return false }
        defer { close(version) }
        // fsync the previous contents before publishing the replacement.
        guard withStenoPart(version, old, publish: { temp in
            renameatx_np(version, temp, version, leaf, UInt32(RENAME_EXCL)) == 0
        }) else { replaceLog("이전 내용 보관 실패: \(request.file)"); return false }
        #if STENO_HELPER_TESTING
        if let changed = ProcessInfo.processInfo.environment["STENO_REPLACE_TEST_EDIT"] {
            _ = uploadWriteAtomically(target, leaf, Data(changed.utf8))
        }
        #endif
        guard uploadWriteAtomically(target, leaf, data, beforeRename: {
            guard let now = regularSingleLink(target, leaf), now.st_dev == oldInfo.st_dev,
                  now.st_ino == oldInfo.st_ino, uploadReadRegular(target, leaf) == old else { return false }
            return true
        }) else { replaceLog("교체 직전 대상 변경 또는 쓰기 실패: \(request.file)"); return false }
        guard recordSent(target, leaf, data) else {
            replaceLog("교체 후 기록 저장 실패, 다음 교체는 거절됨: \(request.file)"); return false
        }
    }
    guard removeUnchanged(source, name, requestInfo, raw),
          removeUnchanged(source, payload, payloadInfo, data) else { return false }
    replaceLog("반영: \(request.file)")
    return true
}

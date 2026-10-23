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

#if STENO_HELPER_TESTING
// Delay-only probes let another process save at the operation boundaries.
private func replacementPause(_ stage: String) {
    let env = ProcessInfo.processInfo.environment
    guard let stages = env["STENO_REPLACE_TEST_PAUSE"], stages.split(separator: ",").contains(Substring(stage)),
          let marker = env["STENO_REPLACE_TEST_MARKER"] else { return }
    guard FileManager.default.createFile(atPath: marker + "-" + stage, contents: Data()) else { return }
    raise(SIGSTOP)
}
#endif

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
        let versionID = UUID().uuidString
        let version = childDirectory(history, versionID)
        guard version >= 0 else { return false }
        defer { close(version) }
        // Stage the replacement in permanent history, not a cleanup-owned part.
        // RENAME_SWAP moves the actual old inode here, including writes through
        // descriptors the editor opened before the swap. Never unlink this file.
        guard withStenoPart(version, data, publish: { temp in
            renameatx_np(version, temp, version, leaf, UInt32(RENAME_EXCL)) == 0
        }) else { replaceLog("교체 본문 준비 실패: \(request.file)"); return false }
        #if STENO_HELPER_TESTING
        if let changed = ProcessInfo.processInfo.environment["STENO_REPLACE_TEST_EDIT"] {
            _ = uploadWriteAtomically(target, leaf, Data(changed.utf8))
        }
        #endif
        guard let now = regularSingleLink(target, leaf), now.st_dev == oldInfo.st_dev,
              now.st_ino == oldInfo.st_ino, uploadReadRegular(target, leaf) == old else {
            replaceLog("교체 직전 대상 변경: \(request.file)"); return false
        }
        #if STENO_HELPER_TESTING
        replacementPause("before-swap")
        #endif
        guard renameatx_np(version, leaf, target, leaf, UInt32(RENAME_SWAP)) == 0 else {
            replaceLog("파일 맞바꾸기 실패, 대상 유지: \(request.file)"); return false
        }
        #if STENO_HELPER_TESTING
        replacementPause("after-swap")
        #endif
        // Validate the file that was actually displaced, not a pre-swap snapshot.
        guard let displaced = regularSingleLink(version, leaf), displaced.st_dev == oldInfo.st_dev,
              displaced.st_ino == oldInfo.st_ino, let retained = uploadReadRegular(version, leaf),
              uploadSHA256(retained) == receipt.sha256 else {
            #if STENO_HELPER_TESTING
            replacementPause("before-rollback")
            #endif
            // A second swap preserves both files even if another save happened
            // at the destination in the meantime. Failed rollback also keeps both.
            let restored = renameatx_np(version, leaf, target, leaf, UInt32(RENAME_SWAP)) == 0
            replaceLog("맞바꾸기 중 사용자 편집 감지, 교체 거절, 복원=\(restored), 보관=.steno/helper-replaced/\(versionID)/\(leaf): \(request.file)")
            return false
        }
        guard recordSent(target, leaf, data) else {
            replaceLog("교체 후 기록 저장 실패, 다음 교체는 거절됨: \(request.file)"); return false
        }
    }
    guard removeUnchanged(source, name, requestInfo, raw),
          removeUnchanged(source, payload, payloadInfo, data) else { return false }
    replaceLog("반영: \(request.file)")
    return true
}

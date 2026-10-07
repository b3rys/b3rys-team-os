import AppKit
import Darwin
import Foundation

private struct ShareReturnRequest: Decodable {
    let file: String
    let member: String
    let base: String?
    let sha256: String
}

private struct HeldNotes: Decodable {
    let pid: Int32
    let processStart: Double
    let updatedAt: Date
    let current: String?
    let held: [String]
}

private struct EditMark: Codable {
    let editor: String
    let at: Date
    let backup: String
    let fileNumber: UInt64?
}

private func processStart(_ pid: Int32) -> Double? {
    guard pid > 0 else { return nil }
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_pid == pid else { return nil }
    let start = info.kp_proc.p_un.__p_starttime
    return Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
}

private func appMayBeRunning() -> Bool {
    #if STENO_HELPER_TESTING
    return ProcessInfo.processInfo.environment["STENO_TEST_APP_RUNNING"] == "1"
    #else
    return !NSRunningApplication.runningApplications(withBundleIdentifier: "com.b3rys.steno").isEmpty
    #endif
}

private func decoder() -> JSONDecoder {
    let value = JSONDecoder(); value.dateDecodingStrategy = .iso8601; return value
}

// Malformed/unreadable records always mean unknown. Missing records are safe only
// when no Steno process is present; a live held note can contain unsaved input.
private func mayReplace(state: Int32, absolutePath: String) -> Bool {
    var info = stat()
    guard fstatat(state, "open-notes.json", &info, AT_SYMLINK_NOFOLLOW) == 0 else {
        return errno == ENOENT && !appMayBeRunning()
    }
    guard let raw = uploadReadRegular(state, "open-notes.json"),
          let notes = try? decoder().decode(HeldNotes.self, from: raw) else { return false }
    guard let start = processStart(notes.pid), abs(start - notes.processStart) < 1 else { return !appMayBeRunning() }
    return !notes.held.contains { URL(fileURLWithPath: $0).standardizedFileURL.path == absolutePath }
}

private func childDirectory(_ parent: Int32, _ name: String) -> Int32 {
    if mkdirat(parent, name, 0o700) != 0 && errno != EEXIST { return -1 }
    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
}

private func memberValid(_ member: String) -> Bool {
    !member.isEmpty && member.count <= 24 && !member.hasPrefix(".") &&
    !member.contains(where: { $0 == "/" || $0 == "\\" || $0 == ":" || $0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) })
}

private enum ReplaceResult { case replaced, copy, failed }

private func replaceOriginal(_ request: ShareReturnRequest, data: Data, destination: Int32,
                             library: Int32, libraryPath: String) -> ReplaceResult {
    guard let base = request.base, base.count == 64,
          let originalInfo = regularSingleLink(destination, request.file),
          let original = uploadReadRegular(destination, request.file), uploadSHA256(original) == base else { return .copy }
    let state = childDirectory(library, ".steno")
    guard state >= 0 else { return .copy }
    defer { close(state) }
    let absolute = libraryPath + "/팀 공유/" + request.file
    guard mayReplace(state: state, absolutePath: absolute) else { return .copy }
    var marks: [String: EditMark] = [:]
    var markInfo = stat()
    if fstatat(state, "ai-edits.json", &markInfo, AT_SYMLINK_NOFOLLOW) == 0 {
        guard let raw = uploadReadRegular(state, "ai-edits.json"),
              let parsed = try? decoder().decode([String: EditMark].self, from: raw) else { return .copy }
        marks = parsed
    } else if errno != ENOENT { return .copy }
    let trash = childDirectory(state, "trash")
    guard trash >= 0 else { return .failed }
    defer { close(trash) }
    let now = Date()
    let entryName = "\(Int64(now.timeIntervalSince1970))-\(UUID().uuidString)"
    guard mkdirat(trash, entryName, 0o700) == 0 else { return .failed }
    let entry = openat(trash, entryName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard entry >= 0 else { return .failed }
    defer { close(entry) }
    let date = ISO8601DateFormatter().string(from: now)
    let meta: [String: Any] = ["originalPath": absolute, "deletedAt": date,
                               "memos": [], "memoSeen": [:], "memoAnchor": [:], "editedBy": request.member]
    guard let metaData = try? JSONSerialization.data(withJSONObject: meta, options: [.sortedKeys]),
          uploadWriteAtomically(entry, request.file, original),
          uploadWriteAtomically(entry, request.file + ".steno-meta.json", metaData) else { return .failed }
    // Recheck immediately before replacing; the backup and verifier use exact bytes.
    guard let current = regularSingleLink(destination, request.file), current.st_ino == originalInfo.st_ino,
          uploadReadRegular(destination, request.file) == original, mayReplace(state: state, absolutePath: absolute) else { return .copy }
    var stillSafe = true
    guard uploadWriteAtomically(destination, request.file, data, beforeRename: {
        stillSafe = regularSingleLink(destination, request.file)?.st_ino == originalInfo.st_ino &&
            uploadReadRegular(destination, request.file) == original && mayReplace(state: state, absolutePath: absolute)
        return stillSafe
    }), let edited = regularSingleLink(destination, request.file) else { return stillSafe ? .failed : .copy }
    marks["팀 공유/" + request.file] = EditMark(editor: request.member, at: now,
        backup: libraryPath + "/.steno/trash/" + entryName + "/" + request.file, fileNumber: UInt64(edited.st_ino))
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
    guard let encoded = try? encoder.encode(marks), uploadWriteAtomically(state, "ai-edits.json", encoded) else {
        // Leave the request queued so the failure is visible; the old version remains archived.
        return .failed
    }
    return .replaced
}

func consumeReturn(source: Int32, requestName: String, destination: Int32, library: Int32, libraryPath: String) -> Bool {
    let id = String(requestName.dropFirst(".return-".count).dropLast(".json".count))
    guard UUID(uuidString: id) != nil, let requestInfo = regularSingleLink(source, requestName),
          let raw = uploadReadRegular(source, requestName),
          let request = try? JSONDecoder().decode(ShareReturnRequest.self, from: raw),
          !request.file.hasPrefix("."), validName(request.file), memberValid(request.member) else { return false }
    let payload = ".return-" + id + ".data"
    guard let payloadInfo = regularSingleLink(source, payload), let data = uploadReadRegular(source, payload),
          !data.isEmpty, uploadSHA256(data) == request.sha256, String(data: data, encoding: .utf8) != nil else { return false }
    switch replaceOriginal(request, data: data, destination: destination, library: library, libraryPath: libraryPath) {
    case .failed: return false
    case .copy:
        let ns = request.file as NSString
        let name = "\(ns.deletingPathExtension) (\(request.member) 수정).\(ns.pathExtension)"
        guard publishNew(destination, name, data) != nil else { return false }
    case .replaced: break
    }
    guard removeUnchanged(source, requestName, requestInfo, raw) else { return false }
    return removeUnchanged(source, payload, payloadInfo, data)
}

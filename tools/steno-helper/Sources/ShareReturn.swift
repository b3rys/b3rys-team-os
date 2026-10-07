import AppKit
import Darwin
import Foundation

private struct ShareReturnRequest: Decodable {
    let file: String
    let member: String
    let base: String?
    let basePayload: Bool?
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
private struct EditJournal: Codable {
    let file: String
    let originalSHA: String
    let originalNumber: UInt64
    let updatedSHA: String
    let mark: EditMark
}
private func encoded<T: Encodable>(_ value: T) -> Data? {
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
    return try? encoder.encode(value)
}
private func readMarks(_ state: Int32) -> [String: EditMark]? {
    var info = stat()
    if fstatat(state, "ai-edits.json", &info, AT_SYMLINK_NOFOLLOW) != 0 { return errno == ENOENT ? [:] : nil }
    guard let raw = uploadReadRegular(state, "ai-edits.json") else { return nil }
    return try? decoder().decode([String: EditMark].self, from: raw)
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
private enum NoteState { case closed, held, unknown }
private func noteState(state: Int32, absolutePath: String) -> NoteState {
    var info = stat()
    guard fstatat(state, "open-notes.json", &info, AT_SYMLINK_NOFOLLOW) == 0 else {
        return errno == ENOENT && !appMayBeRunning() ? .closed : .unknown
    }
    guard let raw = uploadReadRegular(state, "open-notes.json"),
          let notes = try? decoder().decode(HeldNotes.self, from: raw) else { return .unknown }
    guard let start = processStart(notes.pid), abs(start - notes.processStart) < 1 else { return appMayBeRunning() ? .unknown : .closed }
    return notes.held.contains { URL(fileURLWithPath: $0).standardizedFileURL.path == absolutePath } ? .held : .closed
}
func childDirectory(_ parent: Int32, _ name: String) -> Int32 {
    if mkdirat(parent, name, 0o700) != 0 && errno != EEXIST { return -1 }
    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
}
private func memberValid(_ member: String) -> Bool {
    !member.isEmpty && member.count <= 24 && !member.hasPrefix(".") &&
    !member.contains(where: { $0 == "/" || $0 == "\\" || $0 == ":" || $0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) })
}
private enum ReturnResult { case applied, copy, failed }

// MCPProposal wire format. Only the app modifies a held note; a refusal never
// falls through into a direct file write. Unknown state/timeout alone make copies.
private func propose(state: Int32, absolute: String, base: String, proposed: String, editor: String) -> ReturnResult {
    let folder = childDirectory(state, "mcp-proposals")
    guard folder >= 0 else { return .failed }
    defer { close(folder) }
    let id = UUID().uuidString
    let requestName = id + ".json", replyName = id + ".reply.json"
    defer { _ = unlinkat(folder, requestName, 0); _ = unlinkat(folder, replyName, 0) }
    let request: [String: Any] = ["id": id, "path": absolute, "base": base, "proposed": proposed,
                                 "editor": editor, "createdAt": ISO8601DateFormatter().string(from: Date())]
    guard let raw = try? JSONSerialization.data(withJSONObject: request, options: [.sortedKeys]),
          uploadWriteAtomically(folder, requestName, raw) else { return .failed }
    DistributedNotificationCenter.default().postNotificationName(
        .init("com.b3rys.steno.mcp.proposal"), object: id, userInfo: nil, deliverImmediately: true)
    var timeout: Double = 15
    #if STENO_HELPER_TESTING
    if let raw = ProcessInfo.processInfo.environment["STENO_TEST_PROPOSAL_TIMEOUT"],
       let seconds = Double(raw), seconds >= 0.05 && seconds <= 2 { timeout = seconds }
    #endif
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if let raw = uploadReadRegular(folder, replyName),
           let reply = try? JSONSerialization.jsonObject(with: raw) as? [String: String], let status = reply["status"] {
            switch status {
            case "applied": return .applied
            case "stale", "notOpen", "refused", "saveFailed": return .failed
            default: return .failed
            }
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    return .copy
}

private func applyReturn(_ request: ShareReturnRequest, id: String, data: Data, baseline: Data?, destination: Int32,
                         library: Int32, libraryPath: String) -> ReturnResult {
    let state = childDirectory(library, ".steno")
    guard state >= 0 else { return .failed }
    defer { close(state) }
    let absolute = libraryPath + "/팀 공유/" + request.file
    // Recovery precedes no-op and editor routing: a previous body commit must not
    // disappear merely because the next attempt sees those already-written bytes.
    let journalFolder = openat(state, "helper-return-journal", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    if journalFolder >= 0 {
        defer { close(journalFolder) }
        if let raw = uploadReadRegular(journalFolder, id + ".json") {
            guard let journal = try? decoder().decode(EditJournal.self, from: raw), journal.file == request.file,
                  let info = regularSingleLink(destination, request.file), let current = uploadReadRegular(destination, request.file) else { return .failed }
            if UInt64(info.st_ino) == journal.mark.fileNumber && uploadSHA256(current) == journal.updatedSHA {
                guard var marks = readMarks(state) else { return .failed }
                marks["팀 공유/" + request.file] = journal.mark
                guard let raw = encoded(marks), uploadWriteAtomically(state, "ai-edits.json", raw) else { return .failed }
                return .applied
            }
            // A prepared but uncommitted body may be rebuilt. A body changed after
            // our commit is never rewritten by a retry of that same request.
            guard UInt64(info.st_ino) == journal.originalNumber && uploadSHA256(current) == journal.originalSHA else { return .failed }
            _ = unlinkat(journalFolder, id + ".json", 0)
            _ = unlinkat(destination, ".helper-body-" + id, 0)
            _ = unlinkat(state, ".helper-marks-" + id, 0)
        }
    }
    let status = noteState(state: state, absolutePath: absolute)
    if status == .unknown { return .copy }
    let original = uploadReadRegular(destination, request.file)
    let baseline = baseline ?? original.flatMap { uploadSHA256($0) == request.base ? $0 : nil }
    guard let baseline, let baseText = String(data: baseline, encoding: .utf8),
          let proposedText = String(data: data, encoding: .utf8) else { return .failed }
    if status == .held {
        return propose(state: state, absolute: absolute, base: baseText, proposed: proposedText, editor: request.member)
    }
    guard let original, let originalInfo = regularSingleLink(destination, request.file),
          let currentText = String(data: original, encoding: .utf8),
          let merged = try? mergeLines(base: baseText, current: currentText, proposed: proposedText) else { return .failed }
    let updated = Data(merged.utf8)
    guard updated.count <= 20 * 1_048_576 else { return .failed }
    if updated == original { return .applied }
    guard var marks = readMarks(state) else { return .failed }
    let journal = childDirectory(state, "helper-return-journal")
    guard journal >= 0 else { return .failed }
    defer { close(journal) }
    let trash = childDirectory(state, "trash")
    guard trash >= 0 else { return .failed }
    defer { close(trash) }
    let now = Date(), entryName = "\(Int64(Date().timeIntervalSince1970))-\(UUID().uuidString)"
    guard mkdirat(trash, entryName, 0o700) == 0 else { return .failed }
    let entry = openat(trash, entryName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard entry >= 0 else { return .failed }
    defer { close(entry) }
    var keepBackup = false
    defer {
        if !keepBackup {
            _ = unlinkat(entry, request.file, 0)
            _ = unlinkat(entry, request.file + ".steno-meta.json", 0)
            _ = unlinkat(trash, entryName, AT_REMOVEDIR)
        }
    }
    let meta: [String: Any] = ["originalPath": absolute, "deletedAt": ISO8601DateFormatter().string(from: now),
                               "memos": [], "memoSeen": [:], "memoAnchor": [:], "editedBy": request.member]
    guard let metaData = try? JSONSerialization.data(withJSONObject: meta, options: [.sortedKeys]),
          uploadWriteAtomically(entry, request.file, original),
          uploadWriteAtomically(entry, request.file + ".steno-meta.json", metaData) else { return .failed }
    let bodyName = ".helper-body-" + id, marksName = ".helper-marks-" + id
    guard uploadWriteAtomically(destination, bodyName, updated), let staged = regularSingleLink(destination, bodyName) else { return .failed }
    var retainStages = false
    defer {
        if !retainStages { _ = unlinkat(destination, bodyName, 0); _ = unlinkat(state, marksName, 0) }
    }
    let mark = EditMark(editor: request.member, at: now,
        backup: libraryPath + "/.steno/trash/" + entryName + "/" + request.file, fileNumber: UInt64(staged.st_ino))
    marks["팀 공유/" + request.file] = mark
    let record = EditJournal(file: request.file, originalSHA: uploadSHA256(original), originalNumber: UInt64(originalInfo.st_ino),
                             updatedSHA: uploadSHA256(updated), mark: mark)
    guard let marksData = encoded(marks), let journalData = encoded(record),
          uploadWriteAtomically(state, marksName, marksData),
          uploadWriteAtomically(journal, id + ".json", journalData) else { return .failed }
    guard regularSingleLink(destination, request.file)?.st_ino == originalInfo.st_ino,
          uploadReadRegular(destination, request.file) == original, noteState(state: state, absolutePath: absolute) == .closed else {
        _ = unlinkat(journal, id + ".json", 0); return .failed
    }
    guard renameat(destination, bodyName, destination, request.file) == 0 else {
        _ = unlinkat(journal, id + ".json", 0); return .failed
    }
    retainStages = true
    keepBackup = true
    #if STENO_HELPER_TESTING
    if ProcessInfo.processInfo.environment["STENO_TEST_FAIL_MARK_COMMIT"] == "1" { return .failed }
    #endif
    guard renameat(state, marksName, state, "ai-edits.json") == 0 else { return .failed }
    return .applied
}

func consumeReturn(source: Int32, sourcePath: String, requestName: String, destination: Int32, library: Int32, libraryPath: String) -> Bool {
    let id = String(requestName.dropFirst(".return-".count).dropLast(".json".count))
    guard UUID(uuidString: id) != nil, let requestInfo = regularSingleLink(source, requestName),
          let raw = uploadReadRegular(source, requestName),
          let request = try? JSONDecoder().decode(ShareReturnRequest.self, from: raw),
          !request.file.hasPrefix("."), validName(request.file), memberValid(request.member) else { return false }
    let payload = ".return-" + id + ".data"
    guard let payloadInfo = regularSingleLink(source, payload), let data = uploadReadRegular(source, payload),
          uploadSHA256(data) == request.sha256, String(data: data, encoding: .utf8) != nil else { return false }
    let baseName = ".return-" + id + ".base"
    var baseline: Data?, baseInfo: stat?
    if request.basePayload == true {
        guard let info = regularSingleLink(source, baseName), let value = uploadReadRegular(source, baseName),
              uploadSHA256(value) == request.base else { return false }
        baseline = value; baseInfo = info
    }
    switch applyReturn(request, id: id, data: data, baseline: baseline, destination: destination, library: library, libraryPath: libraryPath) {
    case .failed: return false
    case .copy:
        let ns = request.file as NSString
        let name = "\(ns.deletingPathExtension) (\(request.member) 수정).\(ns.pathExtension)"
        guard publishNew(destination, name, data) != nil else { return false }
    case .applied:
        guard acknowledgeReturn(sourcePath: sourcePath, file: request.file, data: data) else { return false }
    }
    guard removeUnchanged(source, requestName, requestInfo, raw), removeUnchanged(source, payload, payloadInfo, data) else { return false }
    if let baseInfo, let baseline, !removeUnchanged(source, baseName, baseInfo, baseline) { return false }
    let state = openat(library, ".steno", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    if state >= 0 {
        defer { close(state) }
        let journal = openat(state, "helper-return-journal", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if journal >= 0 { _ = unlinkat(journal, id + ".json", 0); close(journal) }
        _ = unlinkat(state, ".helper-marks-" + id, 0)
    }
    return true
}

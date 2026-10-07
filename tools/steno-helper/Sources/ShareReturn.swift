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
    return !NSRunningApplication.runningApplications(withBundleIdentifier: "com.b3rys.steno").isEmpty
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
private enum ReturnResult { case applied, copy, notOpen }

// One request, one reply. Only the app changes a held note; failure makes a copy.
private func propose(state: Int32, absolute: String, base: String, proposed: String, editor: String) -> ReturnResult {
    let folder = childDirectory(state, "mcp-proposals")
    guard folder >= 0 else { return .copy }
    defer { close(folder) }
    let id = UUID().uuidString, requestName = id + ".json", replyName = id + ".reply.json"
    defer { _ = unlinkat(folder, requestName, 0); _ = unlinkat(folder, replyName, 0) }
    let request: [String: Any] = ["id": id, "path": absolute, "base": base, "proposed": proposed,
        "editor": editor, "createdAt": ISO8601DateFormatter().string(from: Date())]
    guard let raw = try? JSONSerialization.data(withJSONObject: request, options: [.sortedKeys]),
          uploadWriteAtomically(folder, requestName, raw) else { return .copy }
    DistributedNotificationCenter.default().postNotificationName(
        .init("com.b3rys.steno.mcp.proposal"), object: id, userInfo: nil, deliverImmediately: true)
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline {
        if let raw = uploadReadRegular(folder, replyName),
           let reply = try? JSONSerialization.jsonObject(with: raw) as? [String: String], let status = reply["status"] {
            return status == "applied" ? .applied : status == "notOpen" ? .notOpen : .copy
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    return .copy
}

private func applyReturn(_ request: ShareReturnRequest, data: Data, baseline: Data?, destination: Int32,
                         library: Int32, libraryPath: String) -> ReturnResult {
    let state = childDirectory(library, ".steno")
    guard state >= 0 else { return .copy }
    defer { close(state) }
    let absolute = libraryPath + "/팀 공유/" + request.file
    let status = noteState(state: state, absolutePath: absolute)
    guard status != .unknown, let original = uploadReadRegular(destination, request.file),
          let originalInfo = regularSingleLink(destination, request.file) else { return .copy }
    let baseline = baseline ?? (uploadSHA256(original) == request.base ? original : nil)
    guard let baseline, let baseText = String(data: baseline, encoding: .utf8),
          let proposedText = String(data: data, encoding: .utf8) else { return .copy }
    var appSaysClosed = false
    let openRecord = uploadReadRegular(state, "open-notes.json")
    if status == .held {
        switch propose(state: state, absolute: absolute, base: baseText, proposed: proposedText, editor: request.member) {
        case .applied: return .applied
        case .copy: return .copy
        case .notOpen: appSaysClosed = true
        }
    }
    guard let currentText = String(data: original, encoding: .utf8),
          let merged = try? mergeLines(base: baseText, current: currentText, proposed: proposedText) else { return .copy }
    let text = currentText.contains("\r\n") ? merged.replacingOccurrences(of: "\n", with: "\r\n") : merged
    let updated = Data(text.utf8)
    guard updated.count <= 20 * 1_048_576 else { return .copy }
    if updated == original { return .applied }
    guard var marks = readMarks(state) else { return .copy }
    let trash = childDirectory(state, "trash")
    guard trash >= 0 else { return .copy }
    defer { close(trash) }
    let now = Date(), entryName = "\(Int64(Date().timeIntervalSince1970))-\(UUID().uuidString)"
    guard mkdirat(trash, entryName, 0o700) == 0 else { return .copy }
    let entry = openat(trash, entryName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard entry >= 0 else { return .copy }
    defer { close(entry) }
    var keepBackup = false
    defer {
        if !keepBackup {
            _ = unlinkat(entry, request.file, 0); _ = unlinkat(entry, request.file + ".steno-meta.json", 0)
            _ = unlinkat(trash, entryName, AT_REMOVEDIR)
        }
    }
    let meta: [String: Any] = ["originalPath": absolute, "deletedAt": ISO8601DateFormatter().string(from: now),
        "memos": [], "memoSeen": [:], "memoAnchor": [:], "editedBy": request.member]
    guard let metaData = try? JSONSerialization.data(withJSONObject: meta, options: [.sortedKeys]),
          uploadWriteAtomically(entry, request.file, original),
          uploadWriteAtomically(entry, request.file + ".steno-meta.json", metaData) else { return .copy }
    guard uploadWriteAtomically(destination, request.file, updated, beforeRename: {
        let latestState = noteState(state: state, absolutePath: absolute)
        return regularSingleLink(destination, request.file)?.st_ino == originalInfo.st_ino &&
        uploadReadRegular(destination, request.file) == original &&
        (latestState == .closed || (latestState == .held && appSaysClosed && openRecord != nil &&
         uploadReadRegular(state, "open-notes.json") == openRecord))
    }) else { return .copy }
    keepBackup = true
    marks["팀 공유/" + request.file] = EditMark(editor: request.member, at: now,
        backup: libraryPath + "/.steno/trash/" + entryName + "/" + request.file,
        fileNumber: regularSingleLink(destination, request.file).map { UInt64($0.st_ino) })
    guard let raw = encoded(marks), uploadWriteAtomically(state, "ai-edits.json", raw) else { return .copy }
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
    switch applyReturn(request, data: data, baseline: baseline, destination: destination, library: library, libraryPath: libraryPath) {
    case .copy, .notOpen:
        let ns = request.file as NSString
        let name = "\(ns.deletingPathExtension) (\(request.member) 수정).\(ns.pathExtension)"
        guard publishNew(destination, name, data) != nil else { return false }
    case .applied:
        _ = acknowledgeReturn(sourcePath: sourcePath, file: request.file, data: data)
    }
    guard removeUnchanged(source, requestName, requestInfo, raw), removeUnchanged(source, payload, payloadInfo, data) else { return false }
    if let baseInfo, let baseline, !removeUnchanged(source, baseName, baseInfo, baseline) { return false }
    return true
}

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
    let host: String?
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
private func localHost() -> String? {
    var name = [CChar](repeating: 0, count: 256)
    guard gethostname(&name, name.count) == 0 else { return nil }
    return String(cString: name)
}
private enum NoteState: String { case closed, held, heldRemote, unknown }
private func returnLog(_ message: String) {
    FileHandle.standardError.write(Data("steno-helper 팀 공유 반환: \(message)\n".utf8))
}
private func noteState(state: Int32, absolutePath: String) -> NoteState {
    var info = stat()
    guard fstatat(state, "open-notes.json", &info, AT_SYMLINK_NOFOLLOW) == 0 else {
        return errno == ENOENT && !appMayBeRunning() ? .closed : .unknown
    }
    guard let raw = uploadReadRegular(state, "open-notes.json"),
          let notes = try? decoder().decode(HeldNotes.self, from: raw) else { returnLog("open-notes.json 읽기/해석 실패 또는 dataless → 모름"); return .unknown }
    guard let host = notes.host else { returnLog("열린 기록 host 없음 → 모름"); return .unknown }
    if host != localHost() {
        let relative = "/팀 공유/" + (absolutePath as NSString).lastPathComponent
        return notes.held.contains { $0.precomposedStringWithCanonicalMapping.hasSuffix(relative.precomposedStringWithCanonicalMapping) } ? .heldRemote : .unknown
    }
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
private enum ReturnResult { case applied, copy, notOpen, pending }

// Persist one UUID across helper cycles; a local notification is only a fast path.
private func propose(source: Int32, pendingName: String, id: String, state: Int32,
                     absolute: String, base: String, proposed: String, editor: String) -> (ReturnResult, Data?) {
    let folder = childDirectory(state, "mcp-proposals")
    guard folder >= 0 else { return (.pending, nil) }
    defer { close(folder) }
    let requestName = id + ".json", replyName = id + ".reply.json"
    let raw: Data
    if let saved = uploadReadRegular(source, pendingName) { raw = saved }
    else {
        let record = uploadReadRegular(state, "open-notes.json")
        var request: [String: Any] = ["id": id, "path": absolute,
            "base": base, "proposed": proposed, "editor": editor,
            "createdAt": ISO8601DateFormatter().string(from: Date())]
        if let record { request["openRecord"] = record.base64EncodedString() }
        guard let value = try? JSONSerialization.data(withJSONObject: request, options: [.sortedKeys]),
              uploadWriteAtomically(source, pendingName, value) else { return (.pending, nil) }
        raw = value
    }
    guard var request = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
          let created = request["createdAt"] as? String,
          let date = ISO8601DateFormatter().date(from: created) else { return (.pending, nil) }
    let record = (request["openRecord"] as? String).flatMap { Data(base64Encoded: $0) }
    // Check replies before expiration, including replies delivered between cycles.
    if let replyData = uploadReadRegular(folder, replyName),
       let reply = try? JSONSerialization.jsonObject(with: replyData) as? [String: Any], let status = reply["status"] as? String {
        returnLog("제안 \(id) 응답=\(status)")
        return (status == "applied" ? .applied : status == "notOpen" ? .notOpen : .copy, record)
    }
    guard Date().timeIntervalSince(date) < 300 else {
        returnLog("제안 \(id) 300초 무응답 → 사본")
        return (.copy, record)
    }
    var info = stat()
    if fstatat(folder, requestName, &info, AT_SYMLINK_NOFOLLOW) != 0 {
        request.removeValue(forKey: "openRecord")
        guard errno == ENOENT, let wire = try? JSONSerialization.data(withJSONObject: request, options: [.sortedKeys]),
              uploadWriteAtomically(folder, requestName, wire) else { return (.pending, record) }
    }
    DistributedNotificationCenter.default().postNotificationName(
        .init("com.b3rys.steno.mcp.proposal"), object: id, userInfo: nil, deliverImmediately: true)
    returnLog("제안 \(id) 응답 대기 → 다음 30초 주기 재확인")
    return (.pending, record)
}

private func applyReturn(_ request: ShareReturnRequest, data: Data, baseline: Data?, destination: Int32,
                         library: Int32, libraryPath: String, source: Int32, id: String) -> ReturnResult {
    let state = childDirectory(library, ".steno")
    guard state >= 0 else { return .copy }
    defer { close(state) }
    let absolute = libraryPath + "/팀 공유/" + request.file
    let status = noteState(state: state, absolutePath: absolute)
    returnLog("\(request.file) 상태=\(status.rawValue)")
    guard let original = uploadReadRegular(destination, request.file),
          let originalInfo = regularSingleLink(destination, request.file) else { return .copy }
    let baseline = baseline ?? (uploadSHA256(original) == request.base ? original : nil)
    guard let baseline, let baseText = String(data: baseline, encoding: .utf8),
          let proposedText = String(data: data, encoding: .utf8) else { return .copy }
    var appSaysClosed = false
    var openRecord = uploadReadRegular(state, "open-notes.json")
    let pendingName = ".return-" + id + ".pending"
    var pendingInfo = stat()
    if status != .closed || fstatat(source, pendingName, &pendingInfo, AT_SYMLINK_NOFOLLOW) == 0 {
        let (result, capturedRecord) = propose(source: source, pendingName: pendingName, id: id,
            state: state, absolute: absolute, base: baseText, proposed: proposedText, editor: request.member)
        openRecord = capturedRecord
        switch result {
        case .applied: return .applied
        case .copy: return .copy
        case .pending: return .pending
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
        (latestState == .closed || (appSaysClosed &&
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
    switch applyReturn(request, data: data, baseline: baseline, destination: destination, library: library, libraryPath: libraryPath, source: source, id: id) {
    case .pending: return true
    case .copy, .notOpen:
        let ns = request.file as NSString
        let name = "\(ns.deletingPathExtension) (\(request.member) 수정).\(ns.pathExtension)"
        guard let output = publishNew(destination, name, data) else { return false }
        returnLog("\(request.file) 사본=\(output)")
    case .applied:
        _ = acknowledgeReturn(sourcePath: sourcePath, file: request.file, data: data)
    }
    let folder = childDirectory(library, ".steno")
    if folder >= 0 {
        let proposals = openat(folder, "mcp-proposals", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if proposals >= 0 { _ = unlinkat(proposals, id + ".json", 0); _ = unlinkat(proposals, id + ".reply.json", 0); close(proposals) }
        close(folder)
    }
    _ = unlinkat(source, ".return-" + id + ".pending", 0)
    guard removeUnchanged(source, requestName, requestInfo, raw), removeUnchanged(source, payload, payloadInfo, data) else { return false }
    if let baseInfo, let baseline, !removeUnchanged(source, baseName, baseInfo, baseline) { return false }
    return true
}

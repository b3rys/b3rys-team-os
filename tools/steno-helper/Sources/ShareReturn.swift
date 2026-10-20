import Darwin
import Foundation

private struct ShareReturnRequest: Decodable {
    let file: String
    let member: String
    // Older queued requests may still carry a baseline payload.
    let base: String?
    let basePayload: Bool?
    let sha256: String
}

func childDirectory(_ parent: Int32, _ name: String) -> Int32 {
    if mkdirat(parent, name, 0o700) != 0 && errno != EEXIST { return -1 }
    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
}
private func memberValid(_ member: String) -> Bool {
    !member.isEmpty && member.count <= 24 && !member.hasPrefix(".") &&
    !member.contains(where: { $0 == "/" || $0 == "\\" || $0 == ":" || $0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) })
}

// A return always publishes a new copy. Never read the original or app state.
func consumeReturn(source: Int32, requestName: String, destination: Int32) -> Bool {
    let id = String(requestName.dropFirst(".return-".count).dropLast(".json".count))
    guard UUID(uuidString: id) != nil, let requestInfo = regularSingleLink(source, requestName),
          let raw = uploadReadRegular(source, requestName),
          let request = try? JSONDecoder().decode(ShareReturnRequest.self, from: raw),
          memberValid(request.member) else { return false }
    // 팀 공유 하위 폴더의 노트면 file 이 "폴더/이름" 이다. 수정 사본은 원본과 같은 폴더에 만든다.
    let parts = request.file.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard let leaf = parts.last, !leaf.hasPrefix("."), validName(leaf),
          let folders = folderComponents(parts.dropLast().joined(separator: "/")) else { return false }
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
    let ns = leaf as NSString
    let name = "\(ns.deletingPathExtension) (\(request.member) 수정).\(ns.pathExtension)"
    let target = openSubdirectory(destination, folders, create: true)
    guard target >= 0 else { return false }
    defer { close(target) }
    guard let output = publishNew(target, name, data) else { return false }
    FileHandle.standardError.write(Data("steno-helper 팀 공유 반환: \(request.file) 사본=\(output)\n".utf8))
    guard removeUnchanged(source, requestName, requestInfo, raw), removeUnchanged(source, payload, payloadInfo, data) else { return false }
    if let baseInfo, let baseline, !removeUnchanged(source, baseName, baseInfo, baseline) { return false }
    watchdogProgress()
    return true
}

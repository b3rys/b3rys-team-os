import Darwin
import Foundation

// 팀원이 자기 폴더(팀 공유/<팀원>/…)에 올린 파일을 같은 자리에서 고쳐 다시 보내거나 치운다.
// 팀 공유 바로 아래 파일과 다른 이름의 폴더는 건드리지 않는다.
// ★도우미가 직접 올린 파일만★ 바꾼다: 올릴 때 팀 공유/.b3os-sent.json 에 적어 두고 그 목록에 있는 것만 받는다.
//   그 파일은 문서 폴더 안이라 팀원 쪽(같은 사용자라도 문서 폴더 권한 없음)이 고칠 수 없다. 요청 안의 이름·경로는 믿지 않는다. 바꾸거나 치우기 전의 본문은
// 팀 폴더 steno-shared/.replaced/ 에 남겨 되살릴 수 있게 한다(라이브러리 밖이라 Steno 목록에는 안 보인다).
private struct ShareReplaceRequest: Decodable {
    let file: String     // "<팀원>/이름" 또는 "<팀원>/폴더/이름"
    let member: String   // 첫 폴더 이름과 같아야 한다
    let sha256: String?  // 바꾸기: 새 본문 해시. 치우기면 없다
    let remove: Bool?
}

private func replaceLog(_ message: String) {
    FileHandle.standardError.write(Data("steno-helper 팀 공유 바꾸기: \(message)\n".utf8))
}

let sentLedgerName = ".b3os-sent.json"

/// 도우미가 올린 파일 목록(팀 공유 기준 상대 경로 → 마지막으로 올린 본문 해시). 못 읽으면 빈 목록.
func readSentLedger(_ destination: Int32) -> [String: String] {
    guard let raw = uploadReadRegular(destination, sentLedgerName),
          let map = try? JSONDecoder().decode([String: String].self, from: raw) else { return [:] }
    return map
}

func updateSentLedger(_ destination: Int32, _ change: (inout [String: String]) -> Void) -> Bool {
    var map = readSentLedger(destination)
    change(&map)
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(map) else { return false }
    return uploadWriteAtomically(destination, sentLedgerName, data)
}

func ledgerKey(_ path: String) -> String { path.precomposedStringWithCanonicalMapping }

/// 바꾸기 전 본문을 남긴다. 이미 같은 이름이 있으면 내용까지 맞는지 보고, 다르면 새로 쓴다. 실패하면 바꾸지 않는다.
private func keepPrevious(_ backupPath: String, _ data: Data) -> Bool {
    let shared = canonicalDirectory(backupPath)
    guard shared >= 0 else { return false }
    defer { close(shared) }
    let dir = childDirectory(shared, ".replaced")
    guard dir >= 0 else { return false }
    defer { close(dir) }
    let name = uploadSHA256(data) + ".data"
    if regularSingleLink(dir, name) != nil, let kept = uploadReadRegular(dir, name), kept == data { return true }
    return uploadWriteAtomically(dir, name, data) && uploadReadRegular(dir, name) == data
}

func consumeReplace(source: Int32, requestName: String, destination: Int32, backupPath: String) -> Bool {
    let id = String(requestName.dropFirst(".replace-".count).dropLast(".json".count))
    guard UUID(uuidString: id) != nil, let requestInfo = regularSingleLink(source, requestName),
          let raw = uploadReadRegular(source, requestName),
          let request = try? JSONDecoder().decode(ShareReplaceRequest.self, from: raw) else { return false }
    let payload = ".replace-" + id + ".data"
    // 다시 해도 안 될 요청(규칙 밖·대상 없음)은 로그만 남기고 치운다. 남겨 두면 주기마다 실패한다.
    func drop(_ why: String) -> Bool {
        replaceLog("\(why): \(request.file)")
        if let info = regularSingleLink(source, payload), let data = uploadReadRegular(source, payload) {
            _ = removeUnchanged(source, payload, info, data)
        }
        return removeUnchanged(source, requestName, requestInfo, raw)
    }
    let parts = request.file.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count >= 2, let leaf = parts.last, !leaf.hasPrefix("."), validName(leaf),
          let folders = folderComponents(parts.dropLast().joined(separator: "/")),
          folders.first == request.member else {
        return drop("팀원 자기 폴더 안의 파일만 바꿀 수 있어 거절")
    }
    let key = ledgerKey(request.file)
    guard readSentLedger(destination)[key] != nil else { return drop("도우미가 올린 파일이 아니라 거절") }
    let remove = request.remove == true
    var newData: Data?, payloadInfo: stat?
    if !remove {
        guard let info = regularSingleLink(source, payload), let data = uploadReadRegular(source, payload),
              !data.isEmpty, uploadSHA256(data) == request.sha256 else { return false }
        newData = data; payloadInfo = info
    }
    let target = openSubdirectory(destination, folders, create: false)
    guard target >= 0 else {
        // 없음·링크는 다시 해도 안 된다. 권한·입출력 오류는 일시적일 수 있어 요청을 남긴다.
        if [ENOENT, ENOTDIR, ELOOP].contains(errno) { return drop("폴더 없음(또는 링크)") }
        replaceLog("폴더를 지금 열 수 없어 다음에 다시(errno \(errno)): \(request.file)"); return false
    }
    defer { close(target) }
    var targetInfo = stat()
    if fstatat(target, leaf, &targetInfo, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT { return drop("바꿀 파일 없음") }
    // 링크·내려받기 전(iCloud) 파일은 지금 못 읽을 뿐이라 요청을 남기고 다음 주기에 다시 본다.
    guard regularSingleLink(target, leaf) != nil, let current = uploadReadRegular(target, leaf) else {
        replaceLog("지금 읽을 수 없어 다음에 다시: \(request.file)"); return false
    }
    guard keepPrevious(backupPath, current) else { replaceLog("이전 본문 보관 실패라 그대로 둠: \(request.file)"); return false }
    if let newData {
        // 새 본문을 임시 이름에 다 쓴 뒤 rename 으로 한 번에 바꾼다. 쓰다 죽어도 원본은 온전하다.
        guard uploadWriteAtomically(target, leaf, newData) else { return false }
        _ = updateSentLedger(destination) { $0[key] = uploadSHA256(newData) }
        replaceLog("고친 판으로 바꿈: \(request.file) (이전 본문 .replaced/\(uploadSHA256(current)).data)")
    } else {
        guard unlinkat(target, leaf, 0) == 0 else { return false }
        _ = updateSentLedger(destination) { $0.removeValue(forKey: key) }
        replaceLog("치움: \(request.file) (본문 .replaced/\(uploadSHA256(current)).data)")
    }
    guard removeUnchanged(source, requestName, requestInfo, raw) else { return false }
    if let payloadInfo, let newData, !removeUnchanged(source, payload, payloadInfo, newData) { return false }
    watchdogProgress()
    return true
}
